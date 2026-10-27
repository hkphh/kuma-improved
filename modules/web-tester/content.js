/**
 * Модуль "Тестер функций KUMA".
 *
 * Работает только на странице правила корреляции:
 *   https://<host>/resources#/resources/correlationRule/<uuid>
 *
 * Кнопка встраивается в панель переменных рядом с другими кнопками.
 * Styled-components классы вида .sc-hOGkXu.fLOSkX динамические, поэтому
 * контейнер ищется по стабильным признакам:
 *   - панель с id, содержащим "panel-variables";
 *   - внутри неё элемент .toolbar-wrapper.
 */
(function () {
  'use strict';

  if (window.__kumaWebTesterLoaded) return;
  window.__kumaWebTesterLoaded = true;

  const MODULE_ID = 'web-tester';
  const HOST_ID = '__kuma_web_tester_host__';
  const STATE_KEY = 'module.web-tester.state';

  const DEFAULT_SETTINGS = {
    routePattern: '#/resources/correlationRule/[0-9a-fA-F-]{16,}',
    buttonText: 'Function Tester',
    persistState: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let buttonEl = null;
  let observer = null;
  let syncTimer = null;
  let saveTimer = null;
  let panelHost = null;
  let panelShadow = null;

  /* ==================== Конфиг и жизненный цикл ==================== */

  function targetAllowed(runtime) {
    const targets = (runtime && runtime.targets) || [];
    const host = String(location.hostname || '').toLowerCase();

    return targets.some(function (t) {
      if (!t || t.enabled === false) return false;
      if (String(t.host || '').toLowerCase() !== host) return false;
      if (t.scheme && t.scheme !== '*' && location.protocol !== t.scheme + ':') return false;
      if (t.path && t.path !== '/' && !location.pathname.startsWith(t.path)) return false;
      return true;
    });
  }

  function routeMatches() {
    let re;
    try {
      re = new RegExp(settings.routePattern || DEFAULT_SETTINGS.routePattern, 'i');
    } catch (e) {
      re = new RegExp(DEFAULT_SETTINGS.routePattern, 'i');
    }
    const haystack = location.pathname + location.search + location.hash;
    if (re.test(haystack)) return true;
    return re.test(location.href);
  }

  function applyRuntime(runtime) {
    if (!runtime) {
      // Content-скрипт зарегистрирован => модуль уже разрешён для этого хоста.
      active = true;
      observe();
      scheduleSync();
      return;
    }

    const mod = runtime.modules && runtime.modules[MODULE_ID];
    const allowed = runtime.enabled !== false && mod && mod.enabled && targetAllowed(runtime);

    if (!allowed) {
      teardown();
      return;
    }

    settings = Object.assign({}, DEFAULT_SETTINGS, mod.settings || {});

    if (!active) {
      active = true;
      observe();
    }

    if (buttonEl) {
      buttonEl.textContent = settings.buttonText || DEFAULT_SETTINGS.buttonText;
    }

    scheduleSync();
  }

  function observe() {
    if (observer) return;
    window.addEventListener('hashchange', scheduleSync);
    window.addEventListener('popstate', scheduleSync);
    document.addEventListener('keydown', onKeyDown, true);

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function teardown() {
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener('hashchange', scheduleSync);
    window.removeEventListener('popstate', scheduleSync);
    document.removeEventListener('keydown', onKeyDown, true);
    removeButton();
    closePanel();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && panelHost) {
      closePanel();
    }
  }

  try {
    chrome.storage.local.get('runtime').then(function (data) {
      applyRuntime(data && data.runtime);
    }).catch(function () {
      applyRuntime(null);
    });

    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local' && changes.runtime) {
        applyRuntime(changes.runtime.newValue);
      }
    });
  } catch (e) {
    applyRuntime(null);
  }

  /* ==================== Поиск панели и кнопка ==================== */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) return true;
    // Контейнер может быть display: contents — тогда ориентируемся на детей.
    return Array.from(el.children).some(function (child) {
      const childRect = child.getBoundingClientRect();
      return childRect.width >= 1 && childRect.height >= 1;
    });
  }

  function findToolbar() {
    // 1. Панель переменных: id вида "rc-tabs-1-panel-variables" (номер вкладки может меняться).
    const panels = document.querySelectorAll('[id$="-panel-variables"], [id*="panel-variables"]');
    if (panels.length) {
      for (const panel of panels) {
        const toolbar = panel.querySelector('.toolbar-wrapper');
        if (toolbar && isVisible(toolbar)) return pickButtonRow(toolbar);

        // Фолбэк: стабильные data-testid кнопок панели переменных.
        const anchor = panel.querySelector(
          '[data-testid="add-variable"], [data-testid="delete-variable"], [data-testid="edit-variable"]'
        );
        if (anchor) {
          const row = anchor.closest('.toolbar-wrapper') || anchor.parentElement;
          if (row && isVisible(row)) return pickButtonRow(row);
        }
      }
      // Панель есть, но сейчас не отрисована/не активна — ждём следующую мутацию DOM.
      return null;
    }

    // 2. Фолбэк: любой видимый .toolbar-wrapper, если id панели изменился.
    const toolbars = Array.from(document.querySelectorAll('.toolbar-wrapper')).filter(isVisible);
    if (!toolbars.length) return null;
    const toolbar = toolbars.find(function (tb) {
      return Boolean(tb.closest('[role="tabpanel"], [id*="panel"]'));
    }) || toolbars[0];
    return pickButtonRow(toolbar);
  }

  /**
   * Внутри .toolbar-wrapper кнопки KUMA лежат не напрямую, а в дочернем
   * flex-контейнере (например, div > span > button). Если вставить кнопку
   * в сам wrapper, она может наложиться на существующие кнопки.
   * Возвращаем ближайший к кнопкам контейнер — прямой потомок wrapper'а.
   */
  function pickButtonRow(toolbar) {
    const buttons = Array.from(toolbar.querySelectorAll('button, [role="button"]'))
      .filter(function (btn) {
        return !btn.hasAttribute('data-kuma-web-tester') && isVisible(btn);
      });
    if (!buttons.length) return toolbar;

    const parent = buttons[0].parentElement;
    if (!parent || parent === toolbar) return toolbar;

    let node = parent;
    while (node.parentElement && node.parentElement !== toolbar) {
      node = node.parentElement;
    }
    return node.parentElement === toolbar ? node : toolbar;
  }

  function createButton(toolbar) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-kuma-web-tester', 'button');
    button.title = 'KUMA Function Tester';

    // Копируем классы у соседней кнопки, чтобы визуально вписаться в панель.
    const candidates = Array.from(toolbar.querySelectorAll('button, [role="button"]')).filter(function (btn) {
      return !btn.hasAttribute('data-kuma-web-tester') && isVisible(btn);
    });
    const sample = candidates.find(function (btn) {
      return String(btn.textContent || '').trim().length > 0;
    }) || candidates[0];

    if (sample && sample.className) {
      button.className = sample.className;
    } else {
      button.style.cssText =
        'padding:6px 12px;border-radius:6px;border:1px solid #8892a0;' +
        'background:#fff;color:#1a1a1a;cursor:pointer;font:inherit;';
    }

    button.style.marginLeft = '8px';
    button.style.whiteSpace = 'nowrap';
    // Классы KUMA могут задавать неожиданное позиционирование — фиксируем
    // поведение в строке кнопок, чтобы ничего не перекрывать.
    button.style.flex = '0 0 auto';
    button.style.alignSelf = 'center';
    button.style.position = 'relative';
    button.textContent = settings.buttonText || DEFAULT_SETTINGS.buttonText;

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (panelHost) {
        closePanel();
      } else {
        openPanel().catch(function (error) {
          console.warn('[KUMA Web Tester] не удалось открыть окно:', error);
        });
      }
    });

    return button;
  }

  function removeButton() {
    if (buttonEl) {
      buttonEl.remove();
      buttonEl = null;
    }
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      sync();
    }, 120);
  }

  function sync() {
    if (!active) return;

    if (!routeMatches()) {
      removeButton();
      closePanel();
      return;
    }

    const toolbar = findToolbar();
    if (!toolbar) {
      removeButton();
      return;
    }

    if (buttonEl && buttonEl.isConnected && buttonEl.parentElement === toolbar) return;

    removeButton();
    buttonEl = createButton(toolbar);
    toolbar.appendChild(buttonEl);
  }

  /* ==================== Окно тестера ==================== */

  const PANEL_CSS = `
    * { box-sizing: border-box; }
    .wt-window {
      position: absolute;
      width: 560px;
      min-width: 380px;
      max-width: calc(100vw - 24px);
      height: auto;
      min-height: 260px;
      max-height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      background: #ffffff;
      color: #1f2328;
      border: 1px solid #c9d1d9;
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, .28);
      font: 13px/1.45 Consolas, "SFMono-Regular", Menlo, monospace;
      overflow: hidden;
      resize: both;
    }
    .wt-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: linear-gradient(180deg, #f6f8fa, #eef2f6);
      border-bottom: 1px solid #d8dee4;
      cursor: move;
      user-select: none;
      flex: 0 0 auto;
    }
    .wt-title {
      font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #24292f;
      flex: 1;
    }
    .wt-icon {
      width: 26px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: #57606a;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .wt-icon:hover { background: #dde3ea; color: #111; }
    .wt-body {
      padding: 10px 12px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow: auto;
      flex: 1 1 auto;
    }
    .wt-label {
      font: 600 11px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #57606a;
      text-transform: uppercase;
      letter-spacing: .4px;
    }
    .wt-expr {
      width: 100%;
      resize: vertical;
      min-height: 58px;
      padding: 6px 8px;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background: #fff;
      color: #1f2328;
      font: 12.5px/1.5 Consolas, "SFMono-Regular", Menlo, monospace;
    }
    .wt-expr:focus { outline: 2px solid #0969da33; border-color: #0969da; }
    .wt-vars-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
      font: 600 11px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #57606a;
      text-transform: uppercase;
      letter-spacing: .4px;
    }
    .wt-vars {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 34vh;
      overflow: auto;
    }
    .wt-var {
      display: grid;
      grid-template-columns: 1fr 1fr 28px;
      gap: 4px;
      align-items: center;
    }
    .wt-var input {
      width: 100%;
      padding: 5px 7px;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background: #fff;
      color: #1f2328;
      font: 12px/1.4 Consolas, "SFMono-Regular", Menlo, monospace;
    }
    .wt-var input:focus { outline: 2px solid #0969da33; border-color: #0969da; }
    .wt-mini {
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background: #f6f8fa;
      color: #24292f;
      cursor: pointer;
      font: 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 5px 8px;
    }
    .wt-mini:hover { background: #eaeef2; }
    .wt-var-del {
      height: 27px;
      padding: 0;
      color: #b42318;
      background: #fff1f0;
      border-color: #ffd0cc;
      font-size: 15px;
    }
    .wt-var-del:hover { background: #ffe0dd; }
    .wt-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 6px;
    }
    .wt-primary {
      padding: 7px 18px;
      border: 1px solid #1a7f37;
      border-radius: 6px;
      background: #1f883d;
      color: #fff;
      cursor: pointer;
      font: 600 12.5px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .wt-primary:hover { background: #1a7f37; }
    .wt-hint {
      color: #8c959f;
      font: 11px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .wt-result {
      margin-top: 4px;
      padding: 8px 10px;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background: #f6f8fa;
      color: #1f2328;
      min-height: 34px;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12.5px/1.5 Consolas, "SFMono-Regular", Menlo, monospace;
    }
    .wt-result.error {
      border-color: #ff8182;
      background: #fff1f0;
      color: #b42318;
    }
    .wt-result.empty { color: #8c959f; }
  `;

  function panelTemplate() {
    return `
      <style>${PANEL_CSS}</style>
      <div class="wt-window" role="dialog" aria-label="KUMA Function Tester">
        <div class="wt-header">
          <span class="wt-title">KUMA Function Tester</span>
          <button type="button" class="wt-icon wt-close" title="Закрыть">✕</button>
        </div>
        <div class="wt-body">
          <label class="wt-label">Выражение</label>
          <textarea class="wt-expr" rows="3" spellcheck="false" placeholder="len(DeviceCustomString1)"></textarea>

          <div class="wt-vars-head">
            <span>Значения переменных</span>
            <button type="button" class="wt-mini wt-add">+ переменная</button>
          </div>
          <div class="wt-vars"></div>

          <div class="wt-actions">
            <button type="button" class="wt-primary wt-eval">Вычислить</button>
            <span class="wt-hint">Ctrl+Enter</span>
          </div>

          <div class="wt-result empty">Результат появится здесь</div>
        </div>
      </div>
    `;
  }

  function makeVarRow(name, value) {
    const row = document.createElement('div');
    row.className = 'wt-var';

    const nameInput = document.createElement('input');
    nameInput.className = 'wt-var-name';
    nameInput.placeholder = 'Имя';
    nameInput.value = name || '';
    nameInput.spellcheck = false;

    const valueInput = document.createElement('input');
    valueInput.className = 'wt-var-value';
    valueInput.placeholder = 'Значение';
    valueInput.value = value == null ? '' : String(value);
    valueInput.spellcheck = false;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'wt-mini wt-var-del';
    delBtn.textContent = '×';
    delBtn.title = 'Удалить переменную';

    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(delBtn);
    return row;
  }

  function collectVars(shadow) {
    const vars = {};
    shadow.querySelectorAll('.wt-var').forEach(function (row) {
      const name = row.querySelector('.wt-var-name').value.trim();
      if (!name) return;
      vars[name] = row.querySelector('.wt-var-value').value;
    });
    return vars;
  }

  function showResult(shadow, text, isError) {
    const box = shadow.querySelector('.wt-result');
    box.classList.remove('empty');
    box.classList.toggle('error', Boolean(isError));
    box.textContent = text;
  }

  function writeState(shadow) {
    const vars = [];
    shadow.querySelectorAll('.wt-var').forEach(function (row) {
      const name = row.querySelector('.wt-var-name').value.trim();
      const value = row.querySelector('.wt-var-value').value;
      if (name) vars.push({ name: name, value: value });
    });
    const expression = shadow.querySelector('.wt-expr').value;
    const resultEl = shadow.querySelector('.wt-result');
    const hasResult = resultEl && !resultEl.classList.contains('empty');
    try {
      chrome.storage.local.set({
        [STATE_KEY]: {
          expression: expression,
          vars: vars,
          result: hasResult ? resultEl.textContent : '',
          resultError: Boolean(resultEl && resultEl.classList.contains('error'))
        }
      });
    } catch (e) {}
  }

  function saveState(shadow, immediate) {
    if (!settings.persistState) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    if (immediate) {
      writeState(shadow);
      return;
    }

    saveTimer = setTimeout(function () {
      saveTimer = null;
      writeState(shadow);
    }, 350);
  }

  async function loadState() {
    if (!settings.persistState) return null;
    try {
      const data = await chrome.storage.local.get(STATE_KEY);
      return data[STATE_KEY] || null;
    } catch (e) {
      return null;
    }
  }

  function evaluateExpression(shadow) {
    const core = globalThis.__KUMA_WEB_TESTER__;
    if (!core) {
      showResult(shadow, 'Ошибка: ядро тестера не загружено', true);
      return;
    }

    const expression = shadow.querySelector('.wt-expr').value.trim();
    if (!expression) {
      showResult(shadow, 'Введите выражение', true);
      return;
    }

    try {
      const vars = collectVars(shadow);
      const parser = new core.Parser(expression, vars);
      const ast = parser.parse();
      const result = core.evaluate(ast, vars);
      const text = Array.isArray(result) ? JSON.stringify(result) : String(result);
      showResult(shadow, text, false);
    } catch (error) {
      showResult(shadow, 'Ошибка: ' + error.message, true);
    }

    saveState(shadow);
  }

  function positionPanel(windowEl) {
    const width = windowEl.offsetWidth || 560;
    const height = windowEl.offsetHeight || 320;
    let left = window.innerWidth - width - 40;
    let top = 88;

    if (buttonEl && buttonEl.isConnected) {
      const rect = buttonEl.getBoundingClientRect();
      top = Math.min(window.innerHeight - height - 16, rect.bottom + 10);
      left = Math.min(window.innerWidth - width - 16, rect.left);
    }

    left = Math.max(12, left);
    top = Math.max(12, top);
    windowEl.style.left = left + 'px';
    windowEl.style.top = top + 'px';
  }

  async function openPanel() {
    if (panelHost) return;

    panelHost = document.createElement('div');
    panelHost.id = HOST_ID;
    panelHost.style.cssText =
      'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';

    panelShadow = panelHost.attachShadow({ mode: 'open' });
    panelShadow.innerHTML = panelTemplate();
    document.documentElement.appendChild(panelHost);

    const windowEl = panelShadow.querySelector('.wt-window');
    const header = panelShadow.querySelector('.wt-header');
    const expr = panelShadow.querySelector('.wt-expr');
    const varsBox = panelShadow.querySelector('.wt-vars');
    const resultBox = panelShadow.querySelector('.wt-result');

    positionPanel(windowEl);

    /* --- состояние --- */
    const state = await loadState();
    if (!panelHost) return;

    if (state && typeof state.expression === 'string') {
      expr.value = state.expression;
    } else {
      expr.value = 'len(DeviceCustomString1)';
    }

    const vars = state && Array.isArray(state.vars) && state.vars.length
      ? state.vars
      : [{ name: 'DeviceCustomString1', value: 'Hello World' }];

    for (const item of vars) {
      varsBox.appendChild(makeVarRow(item.name, item.value));
    }

    if (state && state.result) {
      resultBox.classList.remove('empty');
      resultBox.classList.toggle('error', Boolean(state.resultError));
      resultBox.textContent = state.result;
    }

    positionPanel(windowEl);

    /* --- события --- */
    panelShadow.querySelector('.wt-close').addEventListener('click', closePanel);

    panelShadow.querySelector('.wt-add').addEventListener('click', function () {
      const row = makeVarRow('', '');
      varsBox.appendChild(row);
      row.querySelector('.wt-var-name').focus();
      saveState(panelShadow);
    });

    panelShadow.querySelector('.wt-eval').addEventListener('click', function () {
      evaluateExpression(panelShadow);
    });

    varsBox.addEventListener('click', function (event) {
      const del = event.target.closest('.wt-var-del');
      if (!del) return;
      const row = del.closest('.wt-var');
      if (row) row.remove();
      saveState(panelShadow);
    });

    varsBox.addEventListener('input', function () { saveState(panelShadow); });
    expr.addEventListener('input', function () { saveState(panelShadow); });

    panelShadow.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        evaluateExpression(panelShadow);
      }
    });

    /* --- перетаскивание --- */
    let drag = null;
    header.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = windowEl.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', function (event) {
      if (!drag) return;
      const left = Math.max(4, Math.min(window.innerWidth - 120, event.clientX - drag.dx));
      const top = Math.max(4, Math.min(window.innerHeight - 60, event.clientY - drag.dy));
      windowEl.style.left = left + 'px';
      windowEl.style.top = top + 'px';
    });
    header.addEventListener('pointerup', function (event) {
      drag = null;
      try { header.releasePointerCapture(event.pointerId); } catch (e) {}
    });
    header.addEventListener('pointercancel', function () { drag = null; });

    expr.focus();
    expr.setSelectionRange(expr.value.length, expr.value.length);
  }

  function closePanel() {
    if (panelShadow) saveState(panelShadow, true);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (panelHost) {
      panelHost.remove();
      panelHost = null;
      panelShadow = null;
    }
  }
})();
