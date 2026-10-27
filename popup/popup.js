import {
  SETTINGS_KEY,
  loadRegistry,
  getSettings,
  normalizeSettings,
  normalizeTarget,
  targetMatchesUrl
} from '../core/settings.js';

const els = {
  version: document.getElementById('version'),
  globalEnabled: document.getElementById('globalEnabled'),
  host: document.getElementById('host'),
  siteState: document.getElementById('siteState'),
  addHost: document.getElementById('addHost'),
  moduleCount: document.getElementById('moduleCount'),
  modulesList: document.getElementById('modulesList'),
  openOptions: document.getElementById('openOptions'),
  footHint: document.getElementById('footHint'),
  toast: document.getElementById('toast')
};

let registry = { modules: [] };
let settings = normalizeSettings({}, registry);
let activeTab = null;
let currentUrl = '';
let currentHost = '';
let pageSupported = false;
let toastTimer = null;

init().catch(function (error) {
  toast('Не удалось загрузить настройки: ' + error.message, true);
});

async function init() {
  els.version.textContent = 'v' + chrome.runtime.getManifest().version;

  registry = await loadRegistry();
  settings = await getSettings(registry);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs && tabs[0] ? tabs[0] : null;
    currentUrl = (activeTab && activeTab.url) || '';
  } catch (e) {
    currentUrl = '';
  }

  if (currentUrl) {
    try {
      const url = new URL(currentUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        currentHost = url.hostname.toLowerCase();
        pageSupported = Boolean(currentHost);
      }
    } catch (e) {}
  }

  bindEvents();
  render();
}

function bindEvents() {
  els.globalEnabled.addEventListener('change', function () {
    settings.enabled = els.globalEnabled.checked;
    persist();
  });

  els.addHost.addEventListener('click', addCurrentHost);

  els.openOptions.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

function persist() {
  const normalized = normalizeSettings(settings, registry);
  chrome.storage.local.set({ [SETTINGS_KEY]: normalized }).then(function () {
    settings = normalized;
    render();
  }).catch(function (error) {
    toast('Ошибка сохранения: ' + error.message, true);
  });
}

function render() {
  els.globalEnabled.checked = settings.enabled;
  els.host.textContent = currentHost || 'Страница не поддерживается';

  const hostTargets = currentHost
    ? settings.targets.filter(function (t) { return t.host === currentHost; })
    : [];

  const activeTarget = hostTargets.find(function (t) {
    return t.enabled !== false && (!t.scheme || t.scheme === '*' || currentUrl.startsWith(t.scheme + ':'));
  }) || null;

  const pathMatch = activeTarget && currentUrl ? targetMatchesUrl(activeTarget, currentUrl) : false;
  const hostAdded = hostTargets.length > 0;

  els.siteState.className = 'state';
  els.addHost.disabled = true;

  if (!pageSupported) {
    els.siteState.textContent = 'недоступно';
    els.addHost.textContent = 'Добавить домен';
    els.footHint.textContent = 'Откройте сайт SIEM';
  } else if (!settings.enabled) {
    els.siteState.textContent = 'расширение выключено';
    els.siteState.classList.add('off');
    els.addHost.textContent = hostAdded ? 'Домен добавлен' : 'Добавить домен';
    els.addHost.disabled = hostAdded;
  } else if (!hostAdded) {
    els.siteState.textContent = 'домен не добавлен';
    els.siteState.classList.add('warn');
    els.addHost.textContent = 'Добавить домен';
    els.addHost.disabled = false;
    els.footHint.textContent = 'Домен нужно разрешить';
  } else if (!activeTarget) {
    els.siteState.textContent = 'домен выключен';
    els.siteState.classList.add('off');
    els.addHost.textContent = 'Домен добавлен';
    els.addHost.disabled = true;
    els.footHint.textContent = 'Включите домен в настройках';
  } else if (!pathMatch) {
    els.siteState.textContent = 'путь не совпадает';
    els.siteState.classList.add('warn');
    els.addHost.textContent = 'Домен добавлен';
    els.addHost.disabled = true;
    els.footHint.textContent = 'Ограничение по пути';
  } else {
    els.siteState.textContent = 'активен';
    els.siteState.classList.add('ok');
    els.addHost.textContent = 'Домен добавлен';
    els.addHost.disabled = true;
    els.footHint.textContent = 'Расширение работает';
  }

  renderModules();
}

function renderModules() {
  els.modulesList.textContent = '';
  els.moduleCount.textContent = String(registry.modules.length);

  if (!registry.modules.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Модули не найдены';
    els.modulesList.appendChild(empty);
    return;
  }

  for (const mod of registry.modules) {
    const moduleState = settings.modules[mod.id] || { enabled: false, settings: {} };

    const row = document.createElement('div');
    row.className = 'module' + (moduleState.enabled ? '' : ' off');

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = mod.name || mod.id;
    info.appendChild(name);

    if (mod.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = mod.description;
      info.appendChild(desc);
    }

    row.appendChild(info);

    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(moduleState.enabled);
    input.disabled = !settings.enabled;
    const track = document.createElement('span');
    track.className = 'track';
    input.addEventListener('change', function () {
      moduleState.enabled = input.checked;
      persist();
    });
    label.appendChild(input);
    label.appendChild(track);
    row.appendChild(label);

    els.modulesList.appendChild(row);
  }
}

function addCurrentHost() {
  if (!pageSupported || !currentHost) return;

  const scheme = currentUrl.startsWith('https:') ? 'https' : 'http';
  const target = normalizeTarget({ host: currentHost, scheme: scheme, path: '' });
  if (!target) {
    toast('Некорректный домен', true);
    return;
  }

  const exists = settings.targets.some(function (t) { return t.host === target.host; });
  if (exists) {
    toast('Домен уже добавлен');
    return;
  }

  settings.targets.push(target);
  persist();
  toast('Домен добавлен: ' + target.host);
}

function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.classList.remove('show');
  }, 2200);
}
