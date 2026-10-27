/**
 * Service worker KUMA Extended.
 *
 * Отвечает за:
 *  - нормализацию пользовательских настроек;
 *  - сборку runtime-конфига для content-скриптов;
 *  - динамическую регистрацию content-скриптов модулей
 *    только для разрешённых FQDN и только для включённых модулей.
 */

import {
  SETTINGS_KEY,
  RUNTIME_KEY,
  MODULE_SCRIPT_PREFIX,
  loadRegistry,
  getSettings,
  buildMatchPattern,
  targetMatchesUrl
} from '../core/settings.js';

let queue = Promise.resolve();
let rebuildTimer = null;

function registrationStampOf(settings) {
  return JSON.stringify({
    enabled: settings.enabled,
    targets: settings.targets.map((t) => [t.id, t.host, t.scheme, t.path, t.enabled]),
    modules: Object.keys(settings.modules).sort().map((id) => [id, settings.modules[id].enabled])
  });
}

function enqueue(task) {
  queue = queue.then(task).catch((error) => {
    console.error('[KUMA Extended] sync failed:', error);
  });
  return queue;
}

function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    enqueue(rebuild);
  }, 150);
}

async function rebuild() {
  const registry = await loadRegistry();
  const settings = await getSettings(registry);

  const previousRuntime = (await chrome.storage.local.get(RUNTIME_KEY))[RUNTIME_KEY];
  const registrationStamp = registrationStampOf(settings);
  const settingsChanged = !previousRuntime || previousRuntime.registrationStamp !== registrationStamp;

  const runtime = {
    updatedAt: Date.now(),
    registrationStamp,
    enabled: settings.enabled,
    targets: settings.targets
      .filter((target) => target.enabled)
      .map(({ id, host, scheme, path }) => ({ id, host, scheme, path, enabled: true })),
    modules: {}
  };

  for (const mod of registry.modules) {
    const state = settings.modules[mod.id];
    runtime.modules[mod.id] = {
      id: mod.id,
      enabled: Boolean(state && state.enabled),
      settings: state ? state.settings : { ...(mod.settings || {}) }
    };
  }

  await chrome.storage.local.set({ [RUNTIME_KEY]: runtime });
  const registrationsChanged = await syncRegistrations(registry, settings);

  if (settingsChanged || registrationsChanged) {
    await injectIntoOpenTabs(registry, settings);
  }
}

function buildDesiredScripts(registry, settings) {
  if (!settings.enabled) return [];

  const enabledTargets = settings.targets.filter((target) => target.enabled);
  if (!enabledTargets.length) return [];

  const desired = [];

  for (const mod of registry.modules) {
    const state = settings.modules[mod.id];
    if (!state || !state.enabled) continue;
    if (!mod.files || !mod.files.js.length) continue;

    for (const target of enabledTargets) {
      const pattern = buildMatchPattern(target, mod);
      if (!pattern) continue;

      desired.push({
        id: `${MODULE_SCRIPT_PREFIX}${mod.id}--${target.id}`,
        matches: [pattern],
        js: [...mod.files.js],
        css: [...mod.files.css],
        runAt: mod.runAt || 'document_start',
        allFrames: Boolean(mod.allFrames),
        persistAcrossSessions: true
      });
    }
  }

  return desired;
}

function sameScript(a, b) {
  const pick = (script) => JSON.stringify({
    matches: script.matches,
    js: script.js,
    css: script.css || [],
    runAt: script.runAt,
    allFrames: Boolean(script.allFrames)
  });
  return pick(a) === pick(b);
}

/**
 * Динамическая регистрация действует только на будущие загрузки страниц.
 * Чтобы настройки применялись сразу, после изменения настроек аккуратно
 * до-инжектируем включённые модули в уже открытые подходящие вкладки.
 * Повторный запуск безопасен: каждый модуль защищён собственным guard'ом.
 */
async function injectIntoOpenTabs(registry, settings) {
  if (!settings.enabled) return;

  const targets = settings.targets.filter((target) => target.enabled);
  if (!targets.length) return;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    return;
  }

  for (const tab of tabs) {
    if (!tab || !tab.id || !tab.url) continue;
    if (!/^https?:\/\//i.test(tab.url)) continue;

    const target = targets.find((item) => targetMatchesUrl(item, tab.url));
    if (!target) continue;

    for (const mod of registry.modules) {
      const state = settings.modules[mod.id];
      if (!state || !state.enabled) continue;
      if (!mod.files || !mod.files.js.length) continue;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [...mod.files.js]
        });

        if (mod.files.css && mod.files.css.length) {
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: [...mod.files.css]
          });
        }
      } catch (error) {
        // Закрытая вкладка, chrome:// и т.п. — просто пропускаем.
      }
    }
  }
}

async function syncRegistrations(registry, settings) {
  const desired = buildDesiredScripts(registry, settings);
  const desiredById = new Map(desired.map((script) => [script.id, script]));

  // "kuma-ext:" — идентификаторы первой версии; их нужно вычистить,
  // чтобы после обновления не осталось двух наборов content-скриптов.
  const isOwnScriptId = (id) =>
    id.startsWith(MODULE_SCRIPT_PREFIX) || id.startsWith('kuma-ext:');

  const existing = (await chrome.scripting.getRegisteredContentScripts())
    .filter((script) => isOwnScriptId(script.id));

  const toRemove = existing.filter((script) => {
    const next = desiredById.get(script.id);
    return !next || !sameScript(script, next);
  });

  if (toRemove.length) {
    await chrome.scripting.unregisterContentScripts({ ids: toRemove.map((script) => script.id) });
  }

  const keptIds = new Set(existing.map((script) => script.id));
  const toAdd = desired.filter((script) => !keptIds.has(script.id) || toRemove.some((removed) => removed.id === script.id));

  if (!toAdd.length) {
    return toRemove.length > 0;
  }

  try {
    await chrome.scripting.registerContentScripts(toAdd);
  } catch (error) {
    console.warn('[KUMA Extended] пакетная регистрация не удалась, пробуем по одному:', error);
    for (const script of toAdd) {
      try {
        await chrome.scripting.registerContentScripts([script]);
      } catch (inner) {
        console.error(`[KUMA Extended] не удалось зарегистрировать ${script.id}`, inner);
      }
    }
  }

  return true;
}

chrome.runtime.onInstalled.addListener(() => scheduleRebuild());
chrome.runtime.onStartup.addListener(() => scheduleRebuild());

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[SETTINGS_KEY]) scheduleRebuild();
});

// На случай пробуждения service worker'а без событий установки/старта.
scheduleRebuild();
