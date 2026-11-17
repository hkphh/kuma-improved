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

  const DEFAULT_SETTINGS = {
    routePattern: '#/resources/correlationRule/[0-9a-fA-F-]{16,}',
    buttonText: 'Function sandbox'
  };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let buttonEl = null;
  let observer = null;
  let syncTimer = null;
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

    // Исправление последствий прошлых версий: удаляем осиротевшие кнопки.
    document.querySelectorAll('[data-kuma-web-tester="button"]').forEach(function (stale) {
      if (stale !== buttonEl) stale.remove();
    });

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

    // Кнопка при открытии панели переносится в свой узел — тогда не
    // считаем её пропавшей.
    if (buttonEl && buttonEl.isConnected) return;

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
    .wt-vars-buttons { display: flex; gap: 6px; }
    .wt-var-del {
      height: 27px;
      padding: 0;
      color: #b42318;
      background: #fff1f0;
      border-color: #ffd0cc;
      font-size: 15px;
    }
    .wt-var-del:hover { background: #ffe0dd; }
    .wt-opt {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
      color: #57606a;
      font: 11.5px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
      user-select: none;
    }
    .wt-opt input { margin: 0; }
    .wt-details {
      margin-top: 4px;
      color: #57606a;
      font: 11.5px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .wt-details summary { cursor: pointer; color: #0969da; }
    .wt-details ul { margin: 4px 0 0; padding-left: 18px; }
    .wt-details code {
      font: 11.5px/1.4 Consolas, "SFMono-Regular", Menlo, monospace;
      color: #1f2328;
    }
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
          <textarea class="wt-expr" rows="3" spellcheck="false" placeholder="substring(SourceUserName, last_index_of('@', SourceUserName) + 1)"></textarea>
          <label class="wt-opt" title="Переменные в рабочей области KUMA могут содержать выражения (например, substring(...)). Если снять галочку, значение переменной всегда считается строкой.">
            <input type="checkbox" class="wt-var-expr" checked>
            Считать значения переменных выражениями
          </label>

          <div class="wt-vars-head">
            <span>Значения переменных</span>
            <span class="wt-vars-buttons">
              <button type="button" class="wt-mini wt-import" title="Скопировать переменные из панели правила KUMA в песочницу">Перенести переменные</button>
              <button type="button" class="wt-mini wt-add">+ переменная</button>
            </span>
          </div>
          <div class="wt-vars"></div>

          <div class="wt-actions">
            <button type="button" class="wt-primary wt-eval">Вычислить</button>
            <span class="wt-hint">Ctrl+Enter</span>
          </div>

          <div class="wt-result empty">Результат появится здесь</div>
          <details class="wt-details">
            <summary>Как вычислены переменные</summary>
            <ul></ul>
          </details>
        </div>
      </div>
    `;
  }

  /* ==================== Перенос переменных из KUMA ==================== */

  /**
   * Читает переменные текущего правила из панели KUMA.
   * Структура панели может отличаться между версиями KUMA, поэтому
   * пробуем несколько устойчивых признаков, а в конце — эвристику по
   * тексту строки «Имя  Значение».
   */
  function readKumaVariables() {
    const panels = Array.from(document.querySelectorAll('[id$="-panel-variables"], [id*="panel-variables"]'));

    // Активную панель выбираем по видимости, но строки читаем без фильтра:
    // KUMA может держать неактивную вкладку в DOM, а строки в таблице
    // виртуального скролла могут быть отрисованы вне видимой области.
    const ordered = panels.filter(isVisible).concat(panels.filter(function (p) { return !isVisible(p); }));

    for (const panel of ordered) {
      const rows = panel.querySelectorAll(
        '[data-testid="variable-row"], [data-testid^="variable-row"], .ant-table-tbody > tr, tbody > tr'
      );
      const found = collectFromRows(rows);
      if (found.length) return found;

      const inputs = panel.querySelectorAll('input');
      if (inputs.length) {
        const fromInputs = collectFromInputs(inputs);
        if (fromInputs.length) return fromInputs;
      }

      const fromText = collectFromText(panel);
      if (fromText.length) return fromText;
    }

    return [];
  }

  function collectFromRows(rows) {
    const result = [];
    rows.forEach(function (row) {
      // Строки-измерители antd и строки без содержимого пропускаем.
      if (row.classList.contains('ant-table-measure-row')) return;

      const pair = pickPair(rowTexts(row));
      if (pair) result.push(pair);
    });
    return result;
  }

  /** Текст строки, разбитый по дочерним элементам (span/div/input). */
  function rowTexts(row) {
    const named = Array.from(row.querySelectorAll('td[data-testid]'))
      .filter(function (cell) { return isFieldCell(cell.getAttribute('data-testid')); });
    if (named.length) return named.map(cellText);

    // Таблица без data-testid (другие версии KUMA): обычные ячейки, кроме
    // служебной колонки с чекбоксом.
    const cells = Array.from(row.querySelectorAll('td, [role="cell"]'))
      .filter(function (cell) { return !cell.querySelector('.ant-checkbox-wrapper') || cell.querySelector('[kuma-data]'); });
    if (cells.length) {
      const texts = cells.map(cellText).filter(function (t) { return t !== ''; });
      if (texts.length) return texts;
    }

    const parts = [];
    row.querySelectorAll('input').forEach(function (input) {
      const value = String(input.value || '').trim();
      if (value) parts.push(value);
    });
    if (parts.length) return parts;

    const leaves = Array.from(row.querySelectorAll('span, div, label'))
      .filter(function (el) { return !el.querySelector('span, div, label'); })
      .map(function (el) { return String(el.textContent || '').trim(); })
      .filter(Boolean);
    if (leaves.length) return leaves;

    return [cellText(row)];
  }

  /** Ячейка поля данные, а не служебная (выбор, сортировка и т.п.). */
  function isFieldCell(testid) {
    return testid !== 'selection' && testid !== 'selection-column';
  }

  /**
   * Текст ячейки. Значения в KUMA набраны в CodeMirror: в отрисованном DOM
   * пробелы заменены на `<span class="cm-specialChar">•</span>`, поэтому
   * textContent врёт. Настоящий текст лежит в атрибуте kuma-data
   * (на .cm-theme-light и на input), его и берём.
   */
  function cellText(cell) {
    const editor = cell.querySelector('[kuma-data]');
    if (editor) {
      const raw = editor.getAttribute('kuma-data');
      if (raw != null && raw !== '') return normalizeKumaText(raw);
    }

    const input = cell.querySelector('input, textarea');
    if (input && typeof input.value === 'string' && input.value !== '') {
      return normalizeKumaText(input.value);
    }

    const cm = cell.querySelector('.cm-content');
    const raw = String((cm || cell).textContent || '');
    return normalizeKumaText(raw.replace(/•/g, ' '));
  }

  function collectFromInputs(inputs) {
    const values = Array.from(inputs)
      .map(function (input) { return String(input.value || '').trim(); })
      .filter(Boolean);

    const result = [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      const pair = pickPair([values[i], values[i + 1]]);
      if (pair) result.push(pair);
    }
    return result;
  }

  function collectFromText(panel) {
    const result = [];
    const raw = String(panel.innerHTML || '')
      .replace(/<(br|\/div|\/label|\/p|\/li)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    const text = decodeEntities(raw);
    const lines = String(panel.innerText || text).split('\n');
    for (const line of lines) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.+)$/);
      if (m) result.push({ name: m[1], value: m[2].trim() });
    }
    return result;
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /** Из ячеек строки выбирает пару «имя — значение». */
  function pickPair(texts) {
    const clean = texts.map(normalizeKumaText).filter(function (t) { return t !== ''; });
    if (clean.length < 2) return null;

    const nameIdx = clean.findIndex(function (t) {
      return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(t);
    });
    if (nameIdx === -1) return null;

    const name = clean[nameIdx];
    const value = clean.slice(nameIdx + 1).join(' ').trim();
    return { name: name, value: value };
  }

  /**
   * KUMA отдаёт в тексте неразрывные и «широкие» пробелы (U+00A0, U+2009,
   * U+202F и т.п.), которые при копировании превращаются в «•» или
   * невидимые символы. Приводим их к обычному пробелу.
   */
  function normalizeKumaText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function importVariables(shadow) {
    const box = shadow.querySelector('.wt-vars');
    const found = readKumaVariables();
    if (!found.length) {
      showResult(shadow, 'В панели KUMA переменные не найдены', true);
      return;
    }

    const existing = new Map();
    shadow.querySelectorAll('.wt-var').forEach(function (row) {
      const name = row.querySelector('.wt-var-name').value.trim();
      if (name) existing.set(name, row);
    });

    let added = 0;
    let updated = 0;
    found.forEach(function (item) {
      const row = existing.get(item.name);
      if (row) {
        row.querySelector('.wt-var-value').value = item.value;
        updated++;
      } else {
        box.appendChild(makeVarRow(item.name, item.value));
        added++;
      }
    });

    showResult(shadow, 'Перенесено: ' + found.length + ' (новых ' + added + ', обновлено ' + updated + ')', false);
    saveState(shadow);
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

  /**
   * Парсит значение переменной. `knownVars` — имена, заданные в окне
   * песочницы: по ним парсер отличает переменную от безымянной строки.
   */
  function parseSafely(core, expression, selfName, knownVars) {
    const table = {};
    Object.keys(knownVars || {}).forEach(function (name) { table[name] = true; });
    const parser = new core.Parser(expression, table);
    if (selfName) parser.variables.self = selfName;
    return parser.parse();
  }

  /**
   * Значение переменной в рабочей области KUMA — это тоже выражение.
   * Перед «Вычислить» каждое значение парсится само по себе (со ссылками
   * на другие переменные). Если значение не является выражением, оно
   * остаётся строкой. Циклы между переменными обрабатываются безопасно.
   *
   * @returns {{ vars: Object, notes: Array, lookup: Function }}
   */
  function resolveVars(core, rawVars, asExpressions) {
    const lookups = {};   // имя -> функция значения (лениво, с защитой от циклов)
    const notes = {};

    function define(name, compute) {
      lookups[name] = function (stack) {
        return compute(stack || []);
      };
    }

    Object.keys(rawVars).forEach(function (name) {
      const raw = String(rawVars[name] == null ? '' : rawVars[name]);
      const text = raw.trim();

      if (!asExpressions) {
        define(name, function () { return raw; });
        return;
      }

      let node = null;
      try {
        node = text ? parseSafely(core, text, name, rawVars) : null;
      } catch (e) {
        node = null;
      }

      // Значение — имя стандартного поля KUMA или другой переменной:
      // подставляем их значение, а не строку с именем.
      if (node && node.type === 'var') {
        define(name, function (stack) {
          try {
            const value = core.evaluate(node, makeVars(stack.concat(name)));
            notes[name] = { kind: 'expression', value: value };
            return value;
          } catch (e) {
            notes[name] = { kind: 'string', value: raw };
            return raw;
          }
        });
        return;
      }

      // Не выражение? Значение остаётся как есть.
      if (!node || node.type === 'string') {
        define(name, function () { return node ? node.value : raw; });
        notes[name] = {
          kind: 'string',
          value: node ? node.value : raw
        };
        return;
      }

      define(name, function (stack) {
        if (stack.indexOf(name) !== -1) {
          notes[name] = { kind: 'cycle', value: raw };
          return raw;
        }
        try {
          const deps = makeVars(stack.concat(name));
          const value = core.evaluate(node, deps);
          notes[name] = { kind: 'expression', value: value };
          return value;
        } catch (e) {
          notes[name] = { kind: 'string', value: raw, reason: e.message };
          return raw;
        }
      });
    });

    /**
     * Объект переменных для core.evaluate. Каждое обращение к неизвестному
     * ключу резолвит одноимённую переменную из рабочей области.
     */
    function makeVars(stack) {
      return new Proxy({}, {
        has: function (target, key) {
          return typeof key === 'string' && (key === 'self' || lookups[key] || key in target);
        },
        // Парсер проверяет own-свойства (hasOwnProperty), чтобы отличить
        // переменную от строки, — прокси должен отвечать и на это.
        getOwnPropertyDescriptor: function (target, key) {
          if (typeof key === 'string' && (key === 'self' || lookups[key])) {
            return { value: undefined, writable: false, enumerable: true, configurable: true };
          }
          if (key in target) return Object.getOwnPropertyDescriptor(target, key);
          return undefined;
        },
        get: function (target, key) {
          if (key === 'self') return undefined;
          if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
          if (lookups[key]) return lookups[key](stack);
          const dep = rawVars[key];
          return dep === undefined ? undefined : String(dep);
        }
      });
    }

    return { vars: makeVars([]), notes: notes };
  }

  function formatValue(value) {
    if (Array.isArray(value)) return '[' + value.join(', ') + ']';
    return String(value);
  }

  function showNotes(shadow, notes) {
    const parent = shadow.querySelector('.wt-details ul');
    if (!parent) return;
    parent.textContent = '';

    Object.keys(notes).forEach(function (name) {
      const li = document.createElement('li');
      li.textContent = name + ' = ' + formatValue(notes[name].value);
      parent.appendChild(li);
    });
  }

  function showResult(shadow, text, isError) {
    const box = shadow.querySelector('.wt-result');
    box.classList.remove('empty');
    box.classList.toggle('error', Boolean(isError));
    box.textContent = text;
  }

  /**
   * Состояние живёт только в рамках сессии страницы: при первом открытии
   * окна оно пустое, а повторное открытие на той же странице показывает
   * то, что было введено. В chrome.storage ничего не пишем.
   */
  let sessionState = null;
  let sessionDirty = false;

  function snapshot(shadow) {
    const vars = [];
    shadow.querySelectorAll('.wt-var').forEach(function (row) {
      const name = row.querySelector('.wt-var-name').value.trim();
      const value = row.querySelector('.wt-var-value').value;
      if (name) vars.push({ name: name, value: value });
    });
    const varExprBox = shadow.querySelector('.wt-var-expr');
    const resultEl = shadow.querySelector('.wt-result');
    const hasResult = resultEl && !resultEl.classList.contains('empty');
    return {
      expression: shadow.querySelector('.wt-expr').value,
      vars: vars,
      varsAreExpressions: Boolean(varExprBox && varExprBox.checked),
      result: hasResult ? resultEl.textContent : '',
      resultError: Boolean(resultEl && resultEl.classList.contains('error'))
    };
  }

  /** Запоминает состояние, если пользователь что-то вводил. */
  function saveState(shadow) {
    sessionState = snapshot(shadow);
  }

  function markDirty(shadow) {
    sessionDirty = true;
    saveState(shadow);
  }

  function loadState() {
    // Неполный ввод (пустое окно) не должен возвращаться при переоткрытии.
    return sessionDirty ? sessionState : null;
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

    const rawVars = collectVars(shadow);
    const varExprBox = shadow.querySelector('.wt-var-expr');

    try {
      const resolved = resolveVars(core, rawVars, Boolean(varExprBox && varExprBox.checked));

      const parser = new core.Parser(expression, resolved.vars);
      const ast = parser.parse();
      const result = core.evaluate(ast, resolved.vars);
      const text = Array.isArray(result) ? JSON.stringify(result) : String(result);
      // Значения переменных вычисляются лениво — заметки собираем после
      // вычисления выражения.
      showNotes(shadow, resolved.notes);
      showResult(shadow, text, false);
    } catch (error) {
      showNotes(shadow, {});
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
    const state = loadState();

    expr.value = state && typeof state.expression === 'string' ? state.expression : '';

    const varExprBox = panelShadow.querySelector('.wt-var-expr');
    varExprBox.checked = state ? state.varsAreExpressions !== false : true;

    const vars = state && Array.isArray(state.vars) ? state.vars : [];
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
      markDirty(panelShadow);
    });

    panelShadow.querySelector('.wt-import').addEventListener('click', function () {
      importVariables(panelShadow);
      sessionDirty = true;
    });

    panelShadow.querySelector('.wt-eval').addEventListener('click', function () {
      evaluateExpression(panelShadow);
    });

    varsBox.addEventListener('click', function (event) {
      const del = event.target.closest('.wt-var-del');
      if (!del) return;
      const row = del.closest('.wt-var');
      if (row) row.remove();
      markDirty(panelShadow);
    });

    varsBox.addEventListener('input', function () { markDirty(panelShadow); });
    expr.addEventListener('input', function () { markDirty(panelShadow); });
    varExprBox.addEventListener('change', function () { markDirty(panelShadow); });

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
    if (panelShadow && sessionDirty) saveState(panelShadow);
    if (panelHost) {
      panelHost.remove();
      panelHost = null;
      panelShadow = null;
    }
  }
})();
