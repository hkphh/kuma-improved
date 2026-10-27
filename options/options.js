import {
  SETTINGS_KEY,
  normalizeSettings,
  normalizeTarget,
  targetKey,
  loadRegistry,
  getSettings
} from '../core/settings.js';

const els = {
  globalEnabled: document.getElementById('globalEnabled'),
  targetCount: document.getElementById('targetCount'),
  targetsList: document.getElementById('targetsList'),
  addTarget: document.getElementById('addTarget'),
  targetHost: document.getElementById('targetHost'),
  targetScheme: document.getElementById('targetScheme'),
  targetPath: document.getElementById('targetPath'),
  moduleCount: document.getElementById('moduleCount'),
  modulesList: document.getElementById('modulesList'),
  saveStatus: document.getElementById('saveStatus'),
  version: document.getElementById('version'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  resetBtn: document.getElementById('resetBtn'),
  toast: document.getElementById('toast')
};

let registry = { modules: [] };
let state = normalizeSettings({}, registry);
let saveTimer = null;
let toastTimer = null;

init();

async function init() {
  els.version.textContent = 'v' + chrome.runtime.getManifest().version;

  try {
    registry = await loadRegistry();
    state = await getSettings(registry);
  } catch (error) {
    toast('Не удалось загрузить модули: ' + error.message, true);
  }

  bindStaticEvents();
  render();
}

/* ==================== Статические обработчики ==================== */

function bindStaticEvents() {
  els.globalEnabled.addEventListener('change', function () {
    state.enabled = els.globalEnabled.checked;
    persist(true);
  });

  els.addTarget.addEventListener('submit', function (event) {
    event.preventDefault();
    addTarget();
  });

  els.exportBtn.addEventListener('click', exportSettings);
  els.importBtn.addEventListener('click', function () { els.importFile.click(); });
  els.importFile.addEventListener('change', importSettings);
  els.resetBtn.addEventListener('click', resetSettings);

  // Страховка: не теряем отложенное сохранение при закрытии вкладки.
  window.addEventListener('beforeunload', function () {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(state, registry) });
    } catch (e) {}
  });
}

/* ==================== Отрисовка ==================== */

function render() {
  els.globalEnabled.checked = state.enabled;
  renderTargets();
  renderModules();
}

function makeSwitch(checked, onChange) {
  const label = document.createElement('label');
  label.className = 'switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', function () { onChange(input.checked); });

  const track = document.createElement('span');
  track.className = 'track';

  label.appendChild(input);
  label.appendChild(track);
  return label;
}

function emptyBox(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function schemeLabel(scheme) {
  if (scheme === 'http') return 'только http';
  if (scheme === 'https') return 'только https';
  return 'http + https';
}

function renderTargets() {
  els.targetsList.textContent = '';
  els.targetCount.textContent = String(state.targets.length);

  if (!state.targets.length) {
    els.targetsList.appendChild(emptyBox('Пока не добавлено ни одного домена. Расширение не будет работать нигде.'));
    return;
  }

  for (const target of state.targets) {
    const row = document.createElement('div');
    row.className = 'target';

    row.appendChild(makeSwitch(target.enabled, function (checked) {
      target.enabled = checked;
      renderTargets();
      persist(true);
    }));

    const meta = document.createElement('div');
    meta.className = 'meta';

    const host = document.createElement('div');
    host.className = 'host';
    host.textContent = target.host;
    host.title = target.host;
    meta.appendChild(host);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.appendChild(document.createTextNode(schemeLabel(target.scheme)));
    if (target.path) {
      sub.appendChild(document.createTextNode(' · путь '));
      const code = document.createElement('code');
      code.textContent = target.path;
      sub.appendChild(code);
    }
    meta.appendChild(sub);
    row.appendChild(meta);

    const stateBadge = document.createElement('span');
    stateBadge.className = 'state' + (target.enabled ? '' : ' off');
    stateBadge.textContent = target.enabled ? 'активен' : 'выключен';
    row.appendChild(stateBadge);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon';
    remove.title = 'Удалить домен';
    remove.textContent = '✕';
    remove.addEventListener('click', function () {
      state.targets = state.targets.filter(function (t) { return t.id !== target.id; });
      renderTargets();
      persist(true);
      toast('Домен удалён: ' + target.host);
    });
    row.appendChild(remove);

    els.targetsList.appendChild(row);
  }
}

function renderModules() {
  els.modulesList.textContent = '';
  els.moduleCount.textContent = String(registry.modules.length);

  if (!registry.modules.length) {
    els.modulesList.appendChild(emptyBox('Модули не найдены. Проверьте modules/registry.json.'));
    return;
  }

  for (const mod of registry.modules) {
    if (!state.modules[mod.id]) {
      state.modules[mod.id] = { enabled: mod.defaultEnabled !== false, settings: { ...(mod.settings || {}) } };
    }
    const moduleState = state.modules[mod.id];

    const card = document.createElement('div');
    card.className = 'module' + (moduleState.enabled ? '' : ' off');

    const head = document.createElement('div');
    head.className = 'module-head';

    head.appendChild(makeSwitch(moduleState.enabled, function (checked) {
      moduleState.enabled = checked;
      card.classList.toggle('off', !checked);
      persist(true);
    }));

    const title = document.createElement('div');
    title.className = 'module-title';

    const name = document.createElement('div');
    name.className = 'name';
    const nameText = document.createElement('span');
    nameText.textContent = mod.name || mod.id;
    name.appendChild(nameText);

    const idBadge = document.createElement('span');
    idBadge.className = 'id';
    idBadge.textContent = mod.id;
    name.appendChild(idBadge);

    if (mod.version) {
      const version = document.createElement('span');
      version.className = 'badge';
      version.textContent = 'v' + mod.version;
      name.appendChild(version);
    }

    title.appendChild(name);

    if (mod.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = mod.description;
      title.appendChild(desc);
    }

    head.appendChild(title);
    card.appendChild(head);

    const schema = Array.isArray(mod.settingsSchema) && mod.settingsSchema.length
      ? mod.settingsSchema
      : inferSchema(mod.settings);

    if (!schema.length) {
      const noSettings = document.createElement('div');
      noSettings.className = 'no-settings';
      noSettings.textContent = 'У модуля нет настраиваемых параметров.';
      card.appendChild(noSettings);
    } else {
      const box = document.createElement('div');
      box.className = 'module-settings';
      for (const item of schema) {
        box.appendChild(renderSetting(mod, moduleState, item));
      }
      card.appendChild(box);
    }

    els.modulesList.appendChild(card);
  }
}

function inferSchema(settings) {
  if (!settings || typeof settings !== 'object') return [];
  return Object.keys(settings).map(function (key) {
    const value = settings[key];
    let type = 'text';
    if (typeof value === 'boolean') type = 'boolean';
    else if (typeof value === 'number') type = 'number';
    return { key: key, type: type, label: key };
  });
}

function renderSetting(mod, moduleState, item) {
  const row = document.createElement('div');
  row.className = 'setting';

  const info = document.createElement('div');
  info.className = 'info';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = item.label || item.key;
  info.appendChild(label);

  if (item.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = item.hint;
    info.appendChild(hint);
  }

  row.appendChild(info);

  const control = document.createElement('div');
  control.className = 'control';

  const value = moduleState.settings[item.key];

  if (item.type === 'boolean') {
    control.appendChild(makeSwitch(Boolean(value), function (checked) {
      moduleState.settings[item.key] = checked;
      persist(true);
    }));
  } else if (item.type === 'select' && Array.isArray(item.options)) {
    const select = document.createElement('select');
    for (const option of item.options) {
      const opt = document.createElement('option');
      const optValue = typeof option === 'object' ? option.value : option;
      const optLabel = typeof option === 'object' ? (option.label || option.value) : option;
      opt.value = String(optValue);
      opt.textContent = String(optLabel);
      select.appendChild(opt);
    }
    select.value = value == null ? '' : String(value);
    select.addEventListener('change', function () {
      moduleState.settings[item.key] = select.value;
      persist(true);
    });
    control.appendChild(select);
  } else {
    const input = document.createElement('input');
    input.type = item.type === 'number' ? 'number' : 'text';
    input.value = value == null ? '' : String(value);
    if (item.placeholder) input.placeholder = item.placeholder;
    input.addEventListener('input', function () {
      if (item.type === 'number') {
        const num = parseInt(input.value, 10);
        moduleState.settings[item.key] = Number.isNaN(num) ? 0 : num;
      } else {
        moduleState.settings[item.key] = input.value;
      }
      persist();
    });
    control.appendChild(input);
  }

  row.appendChild(control);
  return row;
}

/* ==================== Действия ==================== */

function addTarget() {
  const raw = els.targetHost.value.trim();
  if (!raw) return;

  let path = els.targetPath.value.trim();
  if (!path && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.pathname && url.pathname !== '/') path = url.pathname;
    } catch (e) {}
  }

  const target = normalizeTarget({
    host: raw,
    scheme: els.targetScheme.value,
    path: path
  });

  if (!target) {
    toast('Некорректный домен. Укажите FQDN, например kuma.example.com', true);
    return;
  }

  const key = targetKey(target);
  if (state.targets.some(function (t) { return targetKey(t) === key; })) {
    toast('Такой домен уже добавлен', true);
    return;
  }

  state.targets.push(target);
  els.targetHost.value = '';
  els.targetPath.value = '';

  renderTargets();
  persist(true);
  toast('Домен добавлен: ' + target.host);
}

function persist(immediate) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  setSaveStatus('Сохранение…');

  if (immediate) {
    writeSettings();
    return;
  }

  saveTimer = setTimeout(function () {
    saveTimer = null;
    writeSettings();
  }, 250);
}

async function writeSettings() {
  try {
    const normalized = normalizeSettings(state, registry);
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    setSaveStatus('Сохранено');
  } catch (error) {
    setSaveStatus('Ошибка');
    toast('Не удалось сохранить настройки: ' + error.message, true);
  }
}

function setSaveStatus(text) {
  els.saveStatus.textContent = text;
}

function exportSettings() {
  const data = JSON.stringify(normalizeSettings(state, registry), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'kuma-extended-settings.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  toast('Настройки экспортированы');
}

function importSettings(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function () {
    try {
      const parsed = JSON.parse(String(reader.result));
      state = normalizeSettings(parsed, registry);
      await chrome.storage.local.set({ [SETTINGS_KEY]: state });
      render();
      setSaveStatus('Сохранено');
      toast('Настройки импортированы');
    } catch (error) {
      toast('Не удалось импортировать: ' + error.message, true);
    }
  };
  reader.readAsText(file);
}

async function resetSettings() {
  if (!confirm('Сбросить все настройки расширения?')) return;
  state = normalizeSettings({}, registry);
  await chrome.storage.local.set({ [SETTINGS_KEY]: state });
  render();
  setSaveStatus('Сохранено');
  toast('Настройки сброшены');
}

/* ==================== Уведомления ==================== */

function toast(message, isError) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.classList.remove('show');
  }, 2600);
}
