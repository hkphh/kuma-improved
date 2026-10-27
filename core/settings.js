/**
 * Общие настройки и утилиты KUMA Extended.
 *
 * Модуль используется service worker'ом, страницей настроек и popup'ом.
 * Content-скрипты модулей не импортируют его (они живут в изолированном мире
 * и читают готовый runtime-конфиг из chrome.storage.local).
 */

export const SETTINGS_KEY = 'settings';
export const RUNTIME_KEY = 'runtime';
export const MODULE_SCRIPT_PREFIX = 'kuma-ext--';
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  enabled: true,
  targets: [],
  modules: {}
};

export function uid(prefix = 't') {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36).slice(-4);
  return `${prefix}_${rand}${time}`;
}

/**
 * Приводит ввод пользователя к FQDN/hostname.
 * Понимает "https://kuma.local:8443/resources" -> "kuma.local".
 * Возвращает '' для некорректного значения.
 */
export function normalizeHost(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/@]*@/, '');                // userinfo
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, '');                   // port
  s = s.replace(/\.$/, '');                     // trailing dot FQDN

  if (!s) return '';
  if (s === 'localhost') return s;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return s;

  const label = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
  if (s.length > 253) return '';
  if (!new RegExp(`^(?:${label}\\.)*${label}$`).test(s)) return '';
  return s;
}

function normalizeScheme(value) {
  const s = String(value || '*').toLowerCase();
  return s === 'http' || s === 'https' ? s : '*';
}

function normalizePath(value) {
  let p = String(value == null ? '' : value).trim();
  if (!p) return '';
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function hashString(value) {
  let hash = 2166136261;
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableTargetId(scheme, host, path) {
  return 't_' + hashString(`${scheme}://${host}${path}`);
}

/**
 * Принимает строку (домен или полный URL) либо объект target.
 * Возвращает нормализованный объект или null.
 */
export function normalizeTarget(input) {
  if (input == null) return null;

  if (typeof input === 'string') {
    const host = normalizeHost(input);
    if (!host) return null;
    return { id: stableTargetId('*', host, ''), host, scheme: '*', path: '', enabled: true };
  }

  if (typeof input !== 'object') return null;

  const host = normalizeHost(input.host || input.domain || input.url);
  if (!host) return null;

  const scheme = normalizeScheme(input.scheme);
  const path = normalizePath(input.path);
  const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.id)
    ? input.id
    : stableTargetId(scheme, host, path);

  return {
    id,
    host,
    scheme,
    path,
    enabled: input.enabled !== false
  };
}

export function targetKey(target) {
  return `${target.scheme || '*'}://${target.host}${target.path || ''}`;
}

/**
 * Загружает реестр модулей и их манифесты.
 * Добавление модуля = папка modules/<id> + строка в modules/registry.json.
 */
export async function loadRegistry() {
  const registryUrl = chrome.runtime.getURL('modules/registry.json');
  const response = await fetch(registryUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Не удалось прочитать registry.json (${response.status})`);

  const registry = await response.json();
  const ids = Array.isArray(registry.modules) ? registry.modules : [];

  const modules = [];
  for (const id of ids) {
    try {
      const moduleUrl = chrome.runtime.getURL(`modules/${id}/module.json`);
      const res = await fetch(moduleUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mod = await res.json();
      if (!mod.id) mod.id = id;
      mod.files = mod.files || { js: [], css: [] };
      mod.files.js = Array.isArray(mod.files.js) ? mod.files.js : [];
      mod.files.css = Array.isArray(mod.files.css) ? mod.files.css : [];
      mod.settings = mod.settings && typeof mod.settings === 'object' ? mod.settings : {};
      modules.push(mod);
    } catch (error) {
      console.warn(`[KUMA Extended] модуль "${id}" не загружен:`, error);
    }
  }

  return { modules };
}

export function defaultModuleState(mod) {
  return {
    enabled: mod.defaultEnabled !== false,
    settings: { ...(mod.settings || {}) }
  };
}

/**
 * Нормализует пользовательские настройки под текущий реестр модулей.
 * Неизвестные модули отбрасываются, недостающие — заполняются значениями по умолчанию.
 */
export function normalizeSettings(input, registry) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {
    version: SETTINGS_VERSION,
    enabled: src.enabled !== false,
    targets: [],
    modules: {}
  };

  const rawTargets = Array.isArray(src.targets) ? src.targets : [];
  const seen = new Set();
  const usedIds = new Set();
  for (const raw of rawTargets) {
    const target = normalizeTarget(raw);
    if (!target) continue;
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);

    // Регистрация content-скриптов использует id в качестве ключа — он должен быть уникальным.
    let id = target.id;
    while (usedIds.has(id)) id = uid('t');
    target.id = id;
    usedIds.add(id);

    out.targets.push(target);
  }

  const modules = registry && Array.isArray(registry.modules) ? registry.modules : [];
  for (const mod of modules) {
    const saved = src.modules && src.modules[mod.id];
    const defaults = defaultModuleState(mod);
    out.modules[mod.id] = {
      enabled: saved && typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
      settings: {
        ...defaults.settings,
        ...(saved && saved.settings && typeof saved.settings === 'object' ? saved.settings : {})
      }
    };
  }

  return out;
}

export async function getSettings(registry) {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY], registry);
}

export async function saveSettings(settings, registry) {
  const normalized = normalizeSettings(settings, registry);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

/**
 * Собирает match pattern для динамической регистрации content-скрипта.
 */
export function buildMatchPattern(target, mod) {
  if (!target || !target.host) return null;

  const scheme = target.scheme === 'http' || target.scheme === 'https' ? target.scheme : '*';

  let path = target.path || '';
  if (!path && mod && mod.matchPath) path = String(mod.matchPath);
  if (!path) path = '/';
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\*+$/, '') + '*';

  return `${scheme}://${target.host}${path}`;
}

export function targetMatchesUrl(target, urlString) {
  if (!target || target.enabled === false) return false;
  try {
    const url = new URL(urlString);
    if (url.hostname.toLowerCase() !== target.host) return false;
    if (target.scheme !== '*' && url.protocol !== `${target.scheme}:`) return false;
    if (target.path && target.path !== '/' && !url.pathname.startsWith(target.path)) return false;
    return true;
  } catch {
    return false;
  }
}

export function findTarget(targets, urlString) {
  return (targets || []).find((target) => targetMatchesUrl(target, urlString)) || null;
}
