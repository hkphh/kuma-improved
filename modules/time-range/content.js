/**
 * Модуль "Расширение периода событий".
 *
 * Добавляет в выпадающий календарь периода на странице событий KUMA
 * компактные кнопки ±5 / 15 / 30 / 60 минут:
 *   - «Дата от» сдвигается назад на выбранный интервал;
 *   - «Дата до» сдвигается вперёд на выбранный интервал.
 *
 * Модуль работает только с абсолютными датами формата
 *   DD.MM.YYYY HH:mm:ss.SSS
 * Относительные значения (now, now/d, now-2d и т.п.) не изменяются:
 * соответствующее поле остаётся как есть.
 */
(function () {
  'use strict';

  if (window.__kumaTimeRangeLoaded) return;
  window.__kumaTimeRangeLoaded = true;

  const MODULE_ID = 'time-range';
  const BAR_ATTR = 'data-kuma-time-range';
  const STYLE_ID = '__kuma_time_range_style__';
  const DEFAULT_INTERVALS = [5, 15, 30, 60];
  const DEFAULT_SETTINGS = {
    intervals: '5, 15, 30, 60'
  };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let observer = null;
  let syncTimer = null;

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

  function applyRuntime(runtime) {
    if (!runtime) {
      // Content-скрипт зарегистрирован => модуль уже разрешён для этого хоста.
      start();
      return;
    }

    const mod = runtime.modules && runtime.modules[MODULE_ID];
    const allowed = runtime.enabled !== false && mod && mod.enabled && targetAllowed(runtime);

    if (!allowed) {
      stop();
      return;
    }

    const previousIntervals = settings.intervals;
    settings = Object.assign({}, DEFAULT_SETTINGS, mod.settings || {});

    if (settings.intervals !== previousIntervals) {
      removeBars();
    }

    start();
    scheduleSync();
  }

  function start() {
    if (active) return;
    active = true;
    ensureStyle();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleSync();
  }

  function stop() {
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    removeBars();
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

  /* ==================== Поиск полей периода ==================== */

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function visibleInputs(field) {
    return Array.from(document.querySelectorAll('input[kuma-field="' + field + '"]'))
      .filter(isVisible);
  }

  /**
   * Поля «Дата от» и «Дата до» находятся в общем контейнере формы.
   * Поднимаемся от rangeFrom до первого предка, внутри которого есть rangeTo.
   * Это даёт blok ввода (в текущей вёрстке — div.inputs_*), не завязываясь
   * на динамические styled-components классы.
   */
  function findInputsBlock(fromInput) {
    let node = fromInput;
    while (node && node !== document.body) {
      const toInput = node.querySelector('input[kuma-field="rangeTo"]');
      if (toInput && isVisible(toInput)) {
        return { block: node, fromInput: fromInput, toInput: toInput };
      }
      node = node.parentElement;
    }
    return null;
  }

  function hasBar(block) {
    return Array.from(block.children).some(function (child) {
      return child.hasAttribute(BAR_ATTR);
    });
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      sync();
    }, 100);
  }

  function sync() {
    if (!active) return;

    for (const fromInput of visibleInputs('rangeFrom')) {
      const found = findInputsBlock(fromInput);
      if (!found) continue;
      if (hasBar(found.block)) continue;
      found.block.appendChild(createBar());
    }
  }

  function removeBars() {
    document.querySelectorAll('[' + BAR_ATTR + ']').forEach(function (bar) {
      bar.remove();
    });
  }

  /* ==================== Разметка и стили ==================== */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      [${BAR_ATTR}] {
        box-sizing: border-box;
        margin: 10px 0 12px;
        font: 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: var(--text--primary, #1f2328);
      }
      [${BAR_ATTR}] .ktr-title {
        margin-bottom: 4px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .3px;
        text-transform: uppercase;
        color: var(--text--secondary, #6b7280);
      }
      [${BAR_ATTR}] .ktr-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      [${BAR_ATTR}] .ktr-btn {
        padding: 5px 7px;
        border: 1px solid var(--input_datetime_picker--border--hover, #cfd6e4);
        border-radius: 6px;
        background: var(--calendar_dropdown_button--bg--base--enabled, #fff);
        color: var(--text--primary, #1f2328);
        cursor: pointer;
        font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        white-space: nowrap;
      }
      [${BAR_ATTR}] .ktr-btn:hover {
        background: var(--calendar_dropdown_button--bg--base--hover, #eef2f7);
      }
      [${BAR_ATTR}] .ktr-btn:active {
        transform: translateY(1px);
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function parseIntervals(raw) {
    const source = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\s;]+/);
    const out = [];

    for (const item of source) {
      const minutes = parseInt(item, 10);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) continue;
      if (!out.includes(minutes)) out.push(minutes);
    }

    return out.length ? out : DEFAULT_INTERVALS;
  }

  function intervalLabel(minutes) {
    if (minutes % 60 === 0) return '±' + (minutes / 60) + ' ч';
    return '±' + minutes + ' мин';
  }

  function createBar() {
    const bar = document.createElement('div');
    bar.setAttribute(BAR_ATTR, '');

    const title = document.createElement('div');
    title.className = 'ktr-title';
    title.textContent = 'Расширить период';

    const row = document.createElement('div');
    row.className = 'ktr-row';

    for (const minutes of parseIntervals(settings.intervals)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ktr-btn';
      button.textContent = intervalLabel(minutes);
      button.title = '«Дата от» −' + minutes + ' мин, «Дата до» +' + minutes + ' мин';
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        expandPeriod(bar, minutes);
      });
      row.appendChild(button);
    }

    bar.appendChild(title);
    bar.appendChild(row);
    return bar;
  }

  /* ==================== Даты ==================== */

  const ABSOLUTE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

  /**
   * Возвращает Date для абсолютной даты KUMA или null для относительной.
   * Относительные значения (now, now/d, now-2d, ...) намеренно не парсятся.
   *
   * Дата KUMA — «наивная» локальная метка без зоны. Считаем её в UTC,
   * чтобы арифметика ±N минут не зависела от перехода на летнее время
   * и всегда сдвигала именно отображаемые часы/минуты.
   */
  function parseAbsolute(value) {
    const match = String(value == null ? '' : value).trim().match(ABSOLUTE_RE);
    if (!match) return null;

    const year = Number(match[3]);
    const month = Number(match[2]) - 1;
    const day = Number(match[1]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = Number(match[6] || 0);
    const millis = Number((match[7] || '0').padEnd(3, '0'));

    const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds, millis));
    if (Number.isNaN(date.getTime())) return null;

    // Защита от нормализации Date.UTC(2026, 1, 31) -> 3 марта.
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hours ||
      date.getUTCMinutes() !== minutes ||
      date.getUTCSeconds() !== seconds
    ) {
      return null;
    }

    return date;
  }

  function pad(value, length) {
    return String(value).padStart(length || 2, '0');
  }

  function formatAbsolute(timestamp) {
    const date = new Date(timestamp);
    return (
      pad(date.getUTCDate()) + '.' +
      pad(date.getUTCMonth() + 1) + '.' +
      date.getUTCFullYear() + ' ' +
      pad(date.getUTCHours()) + ':' +
      pad(date.getUTCMinutes()) + ':' +
      pad(date.getUTCSeconds()) + '.' +
      pad(date.getUTCMilliseconds(), 3)
    );
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.setAttribute('value', value);
    input.setAttribute('title', value);
    if (input.hasAttribute('kuma-data')) input.setAttribute('kuma-data', value);

    // React/Angular слушают input; change добавляем для форм, которые
    // коммитят значение только по change.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function expandPeriod(bar, minutes) {
    const block = bar.parentElement;
    if (!block) return;

    const fromInput = block.querySelector('input[kuma-field="rangeFrom"]');
    const toInput = block.querySelector('input[kuma-field="rangeTo"]');
    if (!fromInput || !toInput) return;

    const fromDate = parseAbsolute(fromInput.value);
    const toDate = parseAbsolute(toInput.value);

    if (fromDate) {
      setInputValue(fromInput, formatAbsolute(fromDate.getTime() - minutes * 60000));
    }

    if (toDate) {
      setInputValue(toInput, formatAbsolute(toDate.getTime() + minutes * 60000));
    }
  }
})();
