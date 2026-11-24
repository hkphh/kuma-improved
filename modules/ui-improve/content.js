/**
 * Модуль "UI Improve — компактная таблица событий".
 *
 * Делает таблицу результатов на странице «События» (threat-hunting) плотнее:
 *   - строки и шапка ниже, шрифт мельче, отступы ячеек меньше;
 *   - вертикальные разделители столбцов;
 *   - столбцы уже: ширины из colgroup подгоняются под содержимое и
 *     перераспределяются так, чтобы занять всю ширину таблицы.
 *
 * Заодно панель «Информация о событии» (список ключ-значение) превращается
 * в компактную таблицу с разделителями.
 *
 * Стили и ширины навешиваются только на таблицу внутри #threat-hunting-table
 * и на боковую панель события, остальной интерфейс KUMA не затрагивается.
 *
 * Почему не только CSS:
 *   - высоту строк задаёт правило `.feMZTU.feMZTU.feMZTU ... td.ant-table-cell`
 *     с высокой специфичностью, поэтому высота задаётся явно с !important;
 *   - ширины столбцов приходят из colgroup с inline-стилями (видимые столбцы
 *     + заглушки виртуализации), их CSS не перебивает;
 *   - виртуальный скролл кэширует ширину содержимого — после сужения столбцов
 *     он пересчитывается вручную.
 */
(function () {
  'use strict';

  if (window.__kumaUiImproveLoaded) return;
  window.__kumaUiImproveLoaded = true;

  const MODULE_ID = 'ui-improve';
  const STYLE_ID = '__kuma_ui_improve_style__';
  const COLUMN_WIDTHS_KEY = '__kuma_ui_improve_widths__';
  const TABLE_ID = 'threat-hunting-table';

  /** Сколько «настоящих» столбцов у KUMA: остальные col — заглушки скролла. */

  const LIMITS = {
    rowHeight: [16, 60],
    headerHeight: [16, 60],
    fontSize: [8, 20],
    cellPaddingX: [0, 24],
    cellPaddingY: [0, 16],
    pageTitleSize: [14, 28],
    queryFontSize: [9, 16],
    drawerWidth: [360, 1200]
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    rowHeight: 24,
    headerHeight: 24,
    fontSize: 12,
    cellPaddingX: 6,
    cellPaddingY: 2,
    fitHeight: true,
    pageTitleSize: 18,
    queryFontSize: 11,
    compactDrawer: true,
    drawerWidth: 600,
    resetWidths: false
  };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let observer = null;
  let syncTimer = null;
  let lastLayoutKey = '';
  /** Сколько раз подряд мы сами просили KUMA пересчитать таблицу. */
  let selfApplyDepth = 0;
  let applyTimer = null;

  function debugWarn(message, error) {
    try {
      chrome.storage.local.set({
        [`${MODULE_ID}.debug`]: {
          at: new Date().toISOString(),
          href: location.href,
          message,
          stack: error ? String(error && error.stack || error) : ''
        }
      });
    } catch (e) { /* нет доступа к storage — не критично для работы модуля */ }
  }

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

  function clampInt(value, range, fallback) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num)) return fallback;
    return Math.min(range[1], Math.max(range[0], num));
  }

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: src.enabled !== false,
      rowHeight: clampInt(src.rowHeight, LIMITS.rowHeight, DEFAULT_SETTINGS.rowHeight),
      headerHeight: clampInt(src.headerHeight, LIMITS.headerHeight, DEFAULT_SETTINGS.headerHeight),
      fontSize: clampInt(src.fontSize, LIMITS.fontSize, DEFAULT_SETTINGS.fontSize),
      cellPaddingX: clampInt(src.cellPaddingX, LIMITS.cellPaddingX, DEFAULT_SETTINGS.cellPaddingX),
      cellPaddingY: clampInt(src.cellPaddingY, LIMITS.cellPaddingY, DEFAULT_SETTINGS.cellPaddingY),
      fitHeight: src.fitHeight !== false,
      pageTitleSize: clampInt(src.pageTitleSize, LIMITS.pageTitleSize, DEFAULT_SETTINGS.pageTitleSize),
      queryFontSize: clampInt(src.queryFontSize, LIMITS.queryFontSize, DEFAULT_SETTINGS.queryFontSize),
      compactDrawer: src.compactDrawer !== false,
      drawerWidth: clampInt(src.drawerWidth, LIMITS.drawerWidth, DEFAULT_SETTINGS.drawerWidth),
      resetWidths: src.resetWidths === true
    };
  }

  function applyRuntime(runtime) {
    let next = { ...DEFAULT_SETTINGS };

    if (runtime) {
      const mod = runtime.modules && runtime.modules[MODULE_ID];
      const allowed = runtime.enabled !== false && mod && mod.enabled && targetAllowed(runtime);
      if (!allowed) {
        stop();
        return;
      }
      next = normalizeSettings(mod.settings);
    }

    if (!next.enabled) {
      stop();
      return;
    }

    settings = next;

    // Закреплённые ширины живут до перезагрузки страницы.
    if (!manualWidths) manualWidths = loadColumnWidths();

    // Разовая настройка «сбросить ширины» из панели расширения.
    if (settings.resetWidths) {
      resetWidths();
      clearResetFlag();
    }

    start();
    clearReapplyTimer();
    lastLayoutKey = '';
    scheduleSync();
  }

  function start() {
    if (active) return;
    active = true;

    applyStyle();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', scheduleHeightSync);
    document.addEventListener('click', onPointerUp, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('dblclick', onDoubleClick, true);

    scheduleSync();
  }

  function stop() {
    active = false;
    if (manualWidths) restoreWidths();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener('resize', scheduleHeightSync);
    document.removeEventListener('click', onPointerUp, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('dblclick', onDoubleClick, true);
    clearTimer();
    clearReapplyTimer();
    if (heightTimer) {
      clearTimeout(heightTimer);
      heightTimer = null;
    }
    const body = document.querySelector('#' + TABLE_ID + ' .ant-table-body');
    if (body && body.hasAttribute(BODY_MAX_ATTR)) {
      body.style.removeProperty('max-height');
      body.removeAttribute(BODY_MAX_ATTR);
    }
    lastLayoutKey = '';
    removeStyle();
  }

  function clearTimer() {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (applyTimer) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
  }

  function scheduleSync() {
    if (!active || syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      try {
        sync();
      } catch (error) {
        debugWarn('sync failed', error);
      }
    }, 60);
  }

  /**
   * Повторная подгонка ширин после того, как KUMA перерисует таблицу.
   * KUMA кладёт стили colgroup на следующем кадре, поэтому одноразового
   * применения мало — повторяем несколько раз с нарастающей задержкой.
   */
  let reapplyTimer = null;
  let reapplyAttempts = 0;
  const REAPPLY_LIMIT = 6;

  function scheduleReapply() {
    if (!active) return;
    if (reapplyTimer) clearTimeout(reapplyTimer);
    if (reapplyAttempts >= REAPPLY_LIMIT) return;
    reapplyAttempts++;
    reapplyTimer = setTimeout(function () {
      reapplyTimer = null;
      try {
        if (restoreWidths()) {
          // Ширины восстановили — дальше KUMA сама, повтор не нужен.
          reapplyAttempts = REAPPLY_LIMIT;
          return;
        }
        sync(true);
        scheduleReapply();
      } catch (error) {
        debugWarn('reapply failed', error);
      }
    }, 80 * reapplyAttempts);
  }

  function clearReapplyTimer() {
    if (reapplyTimer) clearTimeout(reapplyTimer);
    reapplyTimer = null;
    reapplyAttempts = 0;
  }

  /* ==================== Стили ==================== */

  let lastStyleKey = '';

  function applyStyle() {    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }

    const s = settings;
    const key = JSON.stringify(s);
    if (key === lastStyleKey) return;
    lastStyleKey = key;

    const fontSize = s.fontSize + 'px';
    // Строка должна вместить отступы и текст — иначе KUMA раздует высоту.
    const lineHeight = Math.max(s.fontSize + 4, s.rowHeight - s.cellPaddingY * 2) + 'px';
    const padding = `${s.cellPaddingY}px ${s.cellPaddingX}px`;
    const headerHeight = s.headerHeight + 'px';
    const headerLineHeight = Math.max(s.fontSize + 3, s.headerHeight - 6) + 'px';

    // Вертикальные разделители: box-shadow не участвует в раскладке таблицы,
    // поэтому не сдвигает ширины виртуального скролла, но идёт по всей высоте.
    const divider = 'var(--kuma-compact-divider, rgba(31, 41, 55, 0.14))';
    const dividerLeft = `-1px 0 0 0 ${divider}`;
    const dividerRight = `1px 0 0 0 ${divider}`;

    const root = '#' + TABLE_ID;
    const cells = `${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table :is(thead tr > th, tbody .ant-table-row > td)`;

    style.textContent = `
      /* Ячейки: шапка и строки. Только внутри таблицы событий. */
      ${cells} {
        font-size: ${fontSize} !important;
        line-height: ${lineHeight} !important;
        padding: ${padding} !important;
        vertical-align: middle !important;
        box-shadow: ${dividerLeft} !important;
      }

      /* Последнему столбцу — разделитель справа, после него идут заглушки. */
      ${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table :is(thead tr > th, tbody .ant-table-row > td):has(+ th:empty),
      ${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table :is(thead tr > th, tbody .ant-table-row > td):last-of-type {
        box-shadow: ${dividerLeft}, ${dividerRight} !important;
      }

      /* Заглушки виртуализации годятся и для таблицы шапки, и для таблицы строк. */
      ${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table :is(thead tr > th, tbody .ant-table-row > td):empty {
        box-shadow: none !important;
      }

      /* Высоту строки у KUMA задаёт td с высокой специфичностью — снимаем её. */
      ${root} .ant-table-container > .ant-table-body table tbody tr.ant-table-row > td,
      ${root} .ant-table-container > .ant-table-body table tbody tr.ant-table-row > td.ant-table-cell {
        height: ${Math.max(s.rowHeight, s.fontSize + 4 + s.cellPaddingY * 2)}px !important;
        box-sizing: border-box !important;
      }

      /* Высоту шапки KUMA тоже задаёт явно — приводим к headerHeight. */
      ${root} .ant-table-container > .ant-table-header table thead tr > th,
      ${root} .ant-table-container > .ant-table-header table thead tr > th.ant-table-cell {
        height: ${headerHeight} !important;
        box-sizing: border-box !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
      }

      /* Заголовки столбцов и иконки сортировки — компактнее. */
      ${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table thead tr > th :is(.label_vWyhI, [class*="title_"]) {
        line-height: ${headerLineHeight} !important;
      }
      ${root} .ant-table-container > .ant-table-header table thead tr > th svg {
        width: ${Math.max(10, s.fontSize - 1)}px !important;
        height: ${Math.max(10, s.fontSize - 1)}px !important;
      }

      /* Заглушки виртуализации (indent-уровень, measure-строка) не занимают места. */
      ${root} .ant-table-row-indent { display: none !important; }
      ${root} .ant-table-tbody > tr.ant-table-measure-row > td { padding: 0 !important; }

      ${s.fitHeight ? topBlocksCss() : ''}
      ${s.compactDrawer ? drawerCss() : ''}
    `;
  }

  /**
   * Компактная верхняя часть страницы событий: заголовок, окно запроса,
   * строка «Результаты запроса» и панель над таблицей. Классы KUMA
   * динамические, поэтому опираемся на устойчивые части: id корня страницы
   * и префиксы styled-components.
   */
  function topBlocksCss() {
    const root = '#' + TABLE_ID;
    const title = settings.pageTitleSize;
    const queryFont = settings.queryFontSize;
    // Контролы тайтл-бара: кнопки, селекты и чипы уменьшаются вместе с
    // заголовком — на маленьком экране шапка занимает меньше места.
    const ctl = Math.max(22, title + 4);
    const ctlFont = Math.max(10, title - 6);
    const ctlIcon = Math.max(12, ctlFont + 1);

    return `
      /* Заголовок страницы «События» и тайтл-бар на одной линии. */
      #threat-hunting-root > div > div:first-child { align-items: center !important; }
      /* min-width: 0 — иначе flex-зазор резервирует место под полный текст */
      /* заголовка и он обрезается многоточием, хотя места хватает. */
      #threat-hunting-root > div > div:first-child > h3 {
        font-size: ${title}px !important;
        line-height: ${title + 4}px !important;
        height: ${title + 4}px !important;
        width: auto !important;
        flex: 0 0 auto !important;
        min-width: 0 !important;
      }

      /* Окно запроса. Карточку не трогаем: у неё своя рамка, ручка */
      /* изменения размера и высота, заданная KUMA. Компактность даём */
      /* только шрифтом и отступами, чтобы не ломать редактор. */
      #threat-hunting-root [class*="containerInPage_"] { margin-top: 6px !important; }
      #threat-hunting-root [class*="containerInPage_"] .codebox_mCgOU {
        min-height: 40px !important;
      }
      #threat-hunting-root [class*="containerInPage_"] .codebox_mCgOU .cm-content {
        font-size: ${queryFont}px !important;
        line-height: ${queryFont + 4}px !important;
        padding-top: 2px !important;
        padding-bottom: 2px !important;
      }
      #threat-hunting-root [class*="containerInPage_"] .cm-gutters {
        font-size: ${queryFont - 1}px !important;
        line-height: ${queryFont + 4}px !important;
      }
      /* Подсказка «Нажмите Ctrl + Enter…» занимает строку над кнопками. */
      #threat-hunting-root [class*="containerInPage_"] [class*="helpText"] { display: none !important; }
      /* Кнопки — исходного размера, только плотнее интервал. */
      #threat-hunting-root [class*="containerInPage_"] [class*="toolbar_EAa5l"] {
        margin-top: 2px !important;
      }
      #threat-hunting-root [class*="containerInPage_"] [class*="laXyXw"] { gap: 4px !important; }

      /* «Результаты запроса» и панель экспорта над таблицей. */
      #threat-hunting-root .workspace_RWJe6 { margin-top: 6px !important; }
      #threat-hunting-root .workspace_RWJe6 h5 {
        font-size: 14px !important;
        line-height: 18px !important;
        height: 18px !important;
      }
      #threat-hunting-root .workspace_RWJe6 [class*="toolbar-wrapper"] {
        height: 32px !important;
        margin-top: 4px !important;
      }
      #threat-hunting-root .workspace_RWJe6 [class*="toolbar-wrapper"] .ant-btn {
        height: 28px !important;
        font-size: 13px !important;
      }
      #threat-hunting-root .workspace_RWJe6 [class*="toolbar-wrapper"] svg {
        width: 14px !important;
        height: 14px !important;
      }

      /* Мультивыбор тенантов: чипы компактнее, чтобы помещалось больше. */
      #threat-hunting-root .ant-select-multiple .ant-select-selector {
        height: 28px !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
      }

      /* Кнопки и селекты в тайтл-баре страницы: автообновление, период,
       * тенанты. Только здесь — не трогаем другие разделы KUMA. */
      #threat-hunting-root [class*="titleActions_"] {
        gap: 4px !important;
        align-items: center !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-btn {
        height: ${ctl}px !important;
        min-height: ${ctl}px !important;
        padding: 0 8px !important;
        font-size: ${ctlFont}px !important;
        line-height: ${ctl - 2}px !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-btn svg {
        width: ${ctlIcon}px !important;
        height: ${ctlIcon}px !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select {
        height: ${ctl}px !important;
        min-height: ${ctl}px !important;
        font-size: ${ctlFont}px !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select .ant-select-selector {
        height: ${ctl}px !important;
        padding: 0 ${ctl}px 0 8px !important;
        font-size: ${ctlFont}px !important;
      }
      /* Стрелка — по центру селекта (у KUMA она привязана к его низу). */
      #threat-hunting-root [class*="titleActions_"] .ant-select .ant-select-arrow {
        top: 50% !important;
        /* Шеврон KUMA 12px внутри svg 16px: пустая полоса снизу 2px */
        /* опускает визуальный центр — поднимаем на 2px. */
        margin-top: -2px !important;
        transform: translateY(-50%) !important;
        height: ${ctlIcon}px !important;
        line-height: ${ctlIcon}px !important;
      }
      /* Селектор не должен вылезать за рамку селекта. */
      #threat-hunting-root [class*="titleActions_"] .ant-select .ant-select-selector {
        box-sizing: border-box !important;
      }
      /* Мультивыбор тенантов. Обёртки чипов у KUMA выше строки селекта, */
      /* из-за этого строка раздувается и всё съезжает вниз. Саму обёртку */
      /* схлопываем, а селектор ставим точно по центру шапки. */
      #threat-hunting-root [class*="titleActions_"] .ant-select-multiple {
        height: ${Math.round(ctl / 2)}px !important;
        min-height: ${Math.round(ctl / 2)}px !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-multiple .ant-select-selector {
        position: absolute !important;
        top: 50% !important;
        left: 0 !important;
        right: 0 !important;
        margin: 0 !important;
        transform: translateY(-50%) !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-item,
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-placeholder {
        line-height: ${ctl - 2}px !important;
        font-size: ${ctlFont}px !important;
      }
      /* Одиночный селект («Не обновлять»): текст по центру, как у кнопок. */
      #threat-hunting-root [class*="titleActions_"] .ant-select:not(.ant-select-multiple) .ant-select-selection-item {
        padding: 0 !important;
        font-size: ${ctlFont}px !important;
        line-height: ${ctl - 2}px !important;
      }

      /* Чипы тенантов в тайтл-баре. У KUMA обёртки чипов выше строки
       * (~24px) — прижимаем их к высоте селекта, иначе всё съезжает. */
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-overflow {
        align-items: flex-start !important;
        height: ${ctl - 2}px !important;
        padding: 0 !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-overflow-item {
        height: ${ctl - 2}px !important;
        min-height: 0 !important;
        max-height: ${ctl - 2}px !important;
        align-items: center !important;
        align-self: center !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-overflow-item > * {
        height: ${ctl - 2}px !important;
        line-height: ${ctl - 2}px !important;
      }
      /* Сам чип: текст по высоте строки, отступ — внутренний padding. */
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-item {
        display: inline-flex !important;
        align-items: center !important;
        height: ${ctl - 2}px !important;
        line-height: ${ctl - 2}px !important;
        font-size: ${ctlFont}px !important;
        padding: 0 6px !important;
        margin: 0 !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-overflow-item-rest .ant-select-selection-item {
        padding: 0 !important;
      }
      #threat-hunting-root [class*="titleActions_"] .ant-select-selection-item-remove {
        font-size: 9px !important;
        line-height: 1 !important;
      }
    `;
  }

  /**
   * Боковая панель «Информация о событии». KUMA рисует поля как список
   * «подпись — значение» с кнопками копирования, без сетки. Превращаем
   * каждую пару в строку таблицы: фиксированная колонка подписи,
   * вертикальные и горизонтальные разделители, компактные отступы.
   *
   * Привязываемся к панели с кнопкой «Копировать» (data-testid="copy-url"),
   * чтобы не задевать другие выдвижные панели KUMA.
   */
  function drawerCss() {
    const root = '.ant-drawer:has([data-testid="copy-url"])';
    const content = `${root} .antd-sidebar-content`;
    const wrapper = `${content} [class*="wrapper_yNJJ4"]`;
    const rows = `${wrapper} > [class*="wrapper_"]`;
    const line = 'rgba(31, 41, 55, 0.16)';
    const softLine = 'rgba(31, 41, 55, 0.09)';
    const width = settings.drawerWidth;

    return `
      /* Ширина панели: KUMA растягивает её на всё место справа от меню. */
      ${root} {
        width: ${width}px !important;
        max-width: calc(100vw - 220px) !important;
        left: auto !important;
      }
      ${root} .ant-drawer-content-wrapper {
        width: 100% !important;
        max-width: 100% !important;
      }

      /* Шапка панели: строка «Копировать» и её кнопки чуть ниже. */
      ${content} .mb-16 { margin-bottom: 8px !important; }
      ${content} [class*="toolbar-wrapper"] {
        height: 26px !important;
        padding: 0 !important;
      }
      ${content} [class*="toolbar-wrapper"] .ant-btn {
        height: 24px !important;
        min-height: 24px !important;
        padding: 0 8px !important;
        font-size: 12px !important;
        line-height: 22px !important;
      }
      ${content} [class*="toolbar-wrapper"] .ant-btn svg {
        width: 13px !important;
        height: 13px !important;
      }

      /* Сам список: рамка и нулевой зазор между строками. */
      ${wrapper} {
        gap: 0 !important;
        border: 1px solid ${line} !important;
        border-radius: 6px !important;
        overflow: hidden !important;
      }

      ${rows} {
        position: relative !important;
        display: grid !important;
        grid-template-columns: 168px minmax(0, 1fr) !important;
        align-items: stretch !important;
        gap: 0 !important;
        min-height: 22px !important;
        margin: 0 !important;
        padding: 0 !important;
        border-bottom: 1px solid ${softLine} !important;
        font-size: 12px !important;
        line-height: 16px !important;
      }
      ${rows}:last-child { border-bottom: 0 !important; }

      /* KUMA задаёт ячейкам фиксированную ширину — в сетке она лишняя. */
      ${rows} > * {
        width: auto !important;
        flex: none !important;
        min-width: 0 !important;
        height: auto !important;
        padding: 2px 8px !important;
        font-size: 12px !important;
        line-height: 16px !important;
      }

      /* Колонка подписи — как шапка таблицы, с вертикальной границей. */
      ${rows} > :first-child {
        display: flex !important;
        align-items: center !important;
        background: #f5f6f8 !important;
        color: #4b5563 !important;
        border-right: 1px solid ${line} !important;
        overflow: hidden !important;
        white-space: nowrap !important;
        text-overflow: ellipsis !important;
      }

      /* Колонка значения: одна строка с многоточием. */
      ${rows} > :nth-child(2) {
        display: flex !important;
        align-items: center !important;
        overflow: hidden !important;
        white-space: nowrap !important;
      }
      ${rows} > :nth-child(2) > * {
        max-width: 100% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      ${rows} > :nth-child(2) a {
        display: inline-flex !important;
        align-items: center !important;
        gap: 2px !important;
        max-width: 100% !important;
        color: inherit !important;
      }
      ${rows} > :nth-child(2) a svg { width: 12px !important; height: 12px !important; }

      /* Кнопки строки (копировать и т.п.) — поверх правого края, */
      /* не отнимая ширину у значения. */
      ${rows} > :nth-child(3) {
        position: absolute !important;
        top: 50% !important;
        right: 4px !important;
        transform: translateY(-50%) !important;
        display: flex !important;
        align-items: center !important;
        gap: 2px !important;
        padding: 0 2px !important;
        background: transparent !important;
        border-radius: 4px !important;
      }
      ${rows}:hover > :nth-child(3) { background: #f1f5fb !important; }
      ${rows} > :nth-child(3) .ant-btn {
        width: 16px !important;
        height: 16px !important;
        min-width: 16px !important;
        padding: 0 !important;
      }
      ${rows} > :nth-child(3) svg { width: 12px !important; height: 12px !important; }

      /* Лёгкая «зебра» и подсветка строки, чтобы читать было проще. */
      ${rows}:nth-child(even) > :nth-child(2) { background: #fbfcfd !important; }
      ${rows}:hover > * { background: #f1f5fb !important; }

      /* Блок «Исходное событие»: компактный заголовок и сырое событие. */
      ${content} [class*="mt-32"] {
        margin-top: 14px !important;
        margin-bottom: 6px !important;
        align-items: center !important;
      }
      ${content} [class*="mt-32"] h4 {
        font-size: 15px !important;
        line-height: 20px !important;
        height: 20px !important;
      }
      ${content} [class*="mt-32"] .ant-btn {
        width: 26px !important;
        height: 26px !important;
        min-width: 26px !important;
        padding: 0 !important;
      }
      ${content} [class*="mt-32"] .ant-btn svg {
        width: 14px !important;
        height: 14px !important;
      }

      /* Само сырое событие — плотный моноширинный блок с прокруткой. */
      ${content} .pb-24:has(pre) { padding-bottom: 0 !important; }
      ${content} .pb-24:has(pre) [class*="wrapper_"] {
        padding: 6px 8px !important;
        border-radius: 6px !important;
        max-height: 260px !important;
        overflow: auto !important;
      }
      ${content} .pb-24:has(pre) pre {
        margin: 0 !important;
        font-size: 12px !important;
        line-height: 16px !important;
      }
    `;
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    lastStyleKey = '';
    const table = document.getElementById(TABLE_ID);
    if (table) {
      table.querySelectorAll('colgroup col[data-kuma-w]').forEach(function (col) {
        col.removeAttribute('data-kuma-w');
      });
      const wrapper = table.closest('table');
      if (wrapper) wrapper.style.removeProperty('min-width');
    }
  }

  /* ==================== Ширины столбцов ==================== */

  const textWidthCache = new Map();

  function textWidth(text, fontSize) {
    const key = fontSize + '|' + text;
    if (textWidthCache.has(key)) return textWidthCache.get(key);
    let width = text.length * fontSize * 0.62;
    try {
      if (!textWidth.canvas) {
        textWidth.canvas = document.createElement('canvas').getContext('2d');
        textWidth.font = getComputedStyle(document.body).fontFamily || 'Arial, sans-serif';
      }
      textWidth.canvas.font = `${fontSize}px ${textWidth.font}`;
      width = textWidth.canvas.measureText(text).width;
    } catch (e) { /* fallback-оценка выше */ }
    if (textWidthCache.size > 4000) textWidthCache.clear();
    textWidthCache.set(key, width);
    return width;
  }

  /**
   * Закреплённые ширины столбцов: имя колонки KUMA (data-testid) -> ширина в px.
   * Заполняется перетаскиванием и двойным кликом по границе. Живёт, пока
   * пользователь сам не сбросит ширины (или не перезагрузит страницу).
   */
  let manualWidths = null;

  function normalizeManualWidths(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value.keys)) return null;
    const out = {};
    Object.keys(value.widths || {}).forEach(function (key) {
      const width = Math.round(Number(value.widths[key]));
      if (Number.isFinite(width) && width >= 32) out[key] = width;
    });
    return Object.keys(out).length ? { keys: value.keys, widths: out } : null;
  }

  function loadColumnWidths() {
    try {
      const raw = window.sessionStorage.getItem(COLUMN_WIDTHS_KEY);
      if (!raw) return null;
      return normalizeManualWidths(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function saveColumnWidths(pinned) {
    try {
      window.sessionStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify({
        keys: pinned.keys,
        widths: pinned.widths,
        at: Date.now()
      }));
    } catch (e) { /* sessionStorage может быть недоступен */ }
  }

  /** Запоминает ширину столбца (нужно и для перетаскивания, и для двойного клика). */
  function pinWidth(name, width, order) {
    if (!name) return;
    const base = manualWidths || { keys: [], widths: {} };
    const widths = Object.assign({}, base.widths);
    widths[name] = Math.round(width);
    manualWidths = { keys: order || base.keys, widths: widths };
    saveColumnWidths(manualWidths);
  }

  function resetWidths() {
    manualWidths = null;
    lastLayoutKey = '';
    try { window.sessionStorage.removeItem(COLUMN_WIDTHS_KEY); } catch (e) { /* ок */ }

    // Возвращаем ширины, которые KUMA нарисовала бы сама.
    const table = document.getElementById(TABLE_ID);
    const wrapper = table && table.querySelector('.ant-table-body > div');
    if (wrapper) {
      wrapper.style.removeProperty('width');
      wrapper.style.removeProperty('min-width');
    }
    if (active) {
      window.dispatchEvent(new Event('resize'));
      scheduleSync();
    }
  }

  /** Сброс ширин — Shift + двойной клик по границе (обрабатывается в onDoubleClick). */

  /** Гасит разовую настройку «сбросить ширины» в настройках расширения. */
  function clearResetFlag() {
    try {
      chrome.storage.local.get('settings').then(function (data) {
        const settings = data && data.settings;
        const mod = settings && settings.modules && settings.modules[MODULE_ID];
        if (!mod || !mod.settings || mod.settings.resetWidths !== true) return;
        mod.settings.resetWidths = false;
        return chrome.storage.local.set({ settings: settings });
      }).catch(function () { /* настройки ещё не созданы */ });
    } catch (e) { /* ок */ }
  }

  /**
   * Ключи столбцов KUMA в порядке отображения. Ширины KUMA хранит по этим
   * ключам, поэтому и мы привязываемся к ним — так ширины не слетают при
   * добавлении событий и смене выборки. Без data-testid используем название.
   */
  function columnKeys(headerTable) {
    if (!headerTable) return [];
    return Array.from(headerTable.querySelectorAll('thead tr > th')).map(function (th) {
      const key = th.getAttribute('data-testid');
      if (key) return key;
      const title = th.querySelector('[data-testid="title"]');
      return title ? title.textContent.trim() : '';
    });
  }

  /** Ширины, которые сейчас применяет KUMA (в порядке столбцов). */
  function domWidths(table) {
    const headerTable = table.querySelector('.ant-table-header table');
    if (!headerTable) return [];
    return Array.from(headerTable.querySelectorAll('colgroup col')).map(function (col) {
      return parseFloat(col.style.width) || 0;
    });
  }

  function headerThs(headerTable) {
    return Array.from(headerTable.querySelectorAll('thead tr > th'));
  }

  function thIndexOf(target, headerTable) {
    const th = target.closest && target.closest('th');
    return headerThs(headerTable).indexOf(th);
  }

  /**
   * Граница, за которую тянется столбец, — правее самого th:
   * resizableHandler стоит в конце «полосы» столбца. Двойной клик по ней
   * меняет ширину именно этого столбца.
   */
  function indexAtX(clientX, headerTable) {
    const ths = headerThs(headerTable);
    let best = -1;
    let bestDistance = Infinity;
    ths.forEach(function (th, index) {
      const rect = th.getBoundingClientRect();
      if (!rect.width) return;
      // Граница столбца: правый край th + ширина обёртки resizable (+2px).
      const edge = rect.right + 2;
      const distance = Math.abs(edge - clientX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return bestDistance <= 14 ? best : -1;
  }

  /**
   * Двойной клик по границе столбца — ширина по тексту:
   * самый длинный текст в столбце (или заголовок, если он длиннее)
   * плюс отступы ячеек и иконка сортировки.
   */
  function onDoubleClick(event) {
    const target = event.target;
    if (!active || !(target instanceof Element)) return;
    if (!target.closest('[class*="resizable"]')) return;

    const table = document.getElementById(TABLE_ID);
    if (!table || !table.contains(target)) return;

    if (event.shiftKey) {
      resetWidths();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const headers = table.querySelector('.ant-table-header table');
    const bodyTable = table.querySelector('.ant-table-body table');
    if (!headers) return;

    let index = indexAtX(event.clientX, headers);
    if (index < 0) index = thIndexOf(event.target, headers);
    const keys = columnKeys(headers);
    if (index < 0 || !keys[index]) return;

    const width = autoWidthFor(index, headers, bodyTable);
    if (!width) return;

    pinWidth(keys[index], width, keys);
    lastLayoutKey = '';
    applyManualWidths(table);
    scheduleReapply();
  }

  /**
   * Ширина ровно по тексту: заголовок целиком + стрелка сортировки,
   * содержимое — самое длинное значение в загруженных строках (виртуальный
   * скролл держит их немного, но они показательные).
   */
  function autoWidthFor(index, headerTable, bodyTable) {
    const th = headerThs(headerTable)[index];
    if (!th) return 0;

    const title = th.querySelector('[data-testid="title"]');
    const titleText = title ? title.textContent.trim() : '';
    const headerW = textWidth(titleText, settings.fontSize);

    // Стрелка заголовка + badge + служебные отступы в шапке.
    const headerChrome = 12 + 14 + 2;
    const cellChrome = settings.cellPaddingX * 2 + 2;

    const headerNeeded = headerW ? headerW + headerChrome : 0;
    let contentNeeded = 0;

    const rows = bodyTable ? bodyTable.querySelectorAll('tbody tr.ant-table-row') : [];
    Array.from(rows).forEach(function (row) {
      const cell = row.children[index];
      if (!cell) return;
      const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      contentNeeded = Math.max(contentNeeded, textWidth(text, settings.fontSize));
    });

    const width = Math.max(headerNeeded, contentNeeded + cellChrome, 40);
    return Math.min(Math.round(width), 2000);
  }

  /**
   * Если пользователь тянет границу столбца, запоминаем его ширину — вторую
   * и последующие переписывания KUMA таблицей не изменят.
   */
  function onPointerUp(event) {
    if (!active) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[class*="resizable"]')) return;

    const table = document.getElementById(TABLE_ID);
    if (!table || !table.contains(target)) return;

    // Запоминаем все столбцы: KUMA при перетаскивании пересчитывает соседние.
    setTimeout(function () {
      try {
        const headerTable = table.querySelector('.ant-table-header table');
        if (!headerTable) return;
        const keys = columnKeys(headerTable);
        const widths = domWidths(table);
        const next = Object.assign({}, manualWidths ? manualWidths.widths : {});
        let started = false;
        keys.forEach(function (key, index) {
          if (key && widths[index] > 0) {
            next[key] = Math.round(widths[index]);
            started = true;
          }
        });
        if (!started) return;
        manualWidths = { keys: keys, widths: next };
        saveColumnWidths(manualWidths);
        lastLayoutKey = '';
        applyManualWidths(table);
        scheduleReapply();
      } catch (error) {
        debugWarn('pointerup apply failed', error);
      }
    }, 120);
  }

  /**
   * Применяет закреплённые ширины к таблице.
   * Ширина виртуальной обёртки = сумма всех столбцов, иначе горизонтальный
   * скролл посчитается заново и вернёт исходные 240px на столбец.
   */
  function applyManualWidths(table) {
    if (!manualWidths) return false;

    const headerTable = table.querySelector('.ant-table-header table');
    if (!headerTable) return false;
    const keys = columnKeys(headerTable);

    // Состав столбцов другой (новая выборка с другими полями) — старые
    // ширины привязывать бессмысленно, отдаём управление подгонке.
    if (manualWidths.keys.length && manualWidths.keys.join('|') !== keys.join('|')) {
      resetWidths();
      return false;
    }

    let changed = false;

    // Ширина по ключам: одна и та же для header и body, сколько бы
    // colgroup ни рисовал виртуальный скролл.
    const resolved = keys.map(function (key) {
      return key && manualWidths.widths[key] ? manualWidths.widths[key] : 0;
    });

    Array.from(table.querySelectorAll('colgroup')).forEach(function (group) {
      Array.from(group.querySelectorAll('col')).forEach(function (col, index) {
        const width = resolved[index];
        if (!width) return;
        if ((parseFloat(col.style.width) || 0) !== width) changed = true;
        col.style.width = width + 'px';
        col.setAttribute('data-kuma-w', '1');
      });
    });

    // Обёртка уходит из-под контроля при перерисовке — держим её в согласии.
    const wrapper = table.querySelector('.ant-table-body > div');
    const total = domWidths(table).reduce(function (sum, w) { return sum + w; }, 0);
    if (wrapper && total > 0) {
      const declared = parseFloat(wrapper.style.width) || 0;
      if (declared !== total) changed = true;
    }

    if (changed) expandWrapper(table);
    return changed;
  }

  /**
   * Проверяет, разъехались ли шапка и строки после перерисовки KUMA,
   * и выравнивает их. Возвращает true, если что-то поправили.
   */
  function reconcileColgroups(table) {
    const headerTable = table.querySelector('.ant-table-header table');
    const bodyTable = table.querySelector('.ant-table-body table');
    if (!headerTable || !bodyTable) return false;

    const headerWidths = domWidths(table);
    const bodyCols = Array.from(bodyTable.querySelectorAll('colgroup col'));
    let drifted = false;
    bodyCols.forEach(function (col, index) {
      const expected = headerWidths[index] || 0;
      if (expected && (parseFloat(col.style.width) || 0) !== expected) drifted = true;
    });

    if (!drifted) return false;
    syncBodyColgroup(table);
    return true;
  }

  /** Растягивает обёртку виртуального скролла до суммы ширин столбцов. */
  function expandWrapper(table) {
    const widths = domWidths(table);
    const total = widths.reduce(function (sum, w) { return sum + w; }, 0);
    if (!total) return;
    const wrapper = table.querySelector('.ant-table-body > div');
    const body = table.querySelector('.ant-table-body');
    if (!wrapper) return;
    wrapper.style.width = total + 'px';
    wrapper.style.minWidth = '100%';
    if (body) {
      const viewport = body.clientWidth;
      if (viewport && total <= viewport && body.scrollLeft > 0) body.scrollLeft = 0;
    }
  }

  /**
   * Зеркало для таблицы строк: ant-table рисует tbody отдельной таблицей.
   * Если KUMA пересчитала ширины только по шапке, строки разъедутся —
   * подгоняем body под header по позициям столбцов.
   */
  function syncBodyColgroup(table) {
    const headerTable = table.querySelector('.ant-table-header table');
    const bodyTable = table.querySelector('.ant-table-body table');
    if (!headerTable || !bodyTable) return;

    const widths = domWidths(table);
    Array.from(bodyTable.querySelectorAll('colgroup')).forEach(function (group) {
      Array.from(group.querySelectorAll('col')).forEach(function (col, index) {
        const width = widths[index];
        if (!width) return;
        if ((parseFloat(col.style.width) || 0) !== width) col.style.width = width + 'px';
      });
    });
  }

  /**
   * Восстанавливает закреплённые ширины, если KUMA их перезаписала
   * (догрузка событий, смена выборки, перерисовка шапки).
   * Возвращает true, если восстанавливать было что.
   */
  function restoreWidths() {
    if (!manualWidths) return false;
    const table = document.getElementById(TABLE_ID);
    if (!table) return false;
    if (!applyManualWidths(table)) return false;
    // KUMA начнёт перерисовку по resize — пусть модуль проследит.
    window.dispatchEvent(new Event('resize'));
    scheduleReapply();
    return true;
  }

  /* ==================== Подгонка ширины ==================== */

  /**
   * Жадно распределяет доступную ширину между столбцами:
   * сначала отдаёт каждому «минимум» (короткий заголовок), потом добирает по
   * фактическому содержимому. Колонка, где текст самый длинный, забирает остаток.
   */
  function fitWidths(available, columns) {
    const result = {};

    let budget = Math.max(available - 4, 120);

    // 1) Минимум, чтобы влез короткий заголовок (половина текста + стрелка).
    const minimums = {};
    columns.forEach(function (c) {
      minimums[c.name] = Math.max(c.headerMin, 40);
    });

    const minTotal = columns.reduce(function (sum, c) { return sum + minimums[c.name]; }, 0);
    if (minTotal > budget) {
      const scale = budget / minTotal;
      columns.forEach(function (c) { result[c.name] = Math.max(32, Math.floor(minimums[c.name] * scale)); });
      return result;
    }

    columns.forEach(function (c) { result[c.name] = minimums[c.name]; });
    budget -= minTotal;

    // 2) Добор по содержимому, пока есть место. Сначала самые «голодные».
    const extra = columns.map(function (c) {
      return Math.max(0, c.content - minimums[c.name]);
    });
    const totalExtra = extra.reduce(function (a, b) { return a + b; }, 0);

    if (totalExtra <= budget) {
      columns.forEach(function (c, i) { result[c.name] += extra[i]; });
      budget -= totalExtra;
      // Остаток — столбцу с самым длинным содержимым.
      const widest = columns.reduce(function (a, b, i) {
        return extra[i] > extra[a] ? i : a;
      }, 0);
      result[columns[widest].name] += budget;
    } else {
      const ratio = budget / totalExtra;
      columns.forEach(function (c, i) {
        result[c.name] += Math.floor(extra[i] * ratio);
      });
    }

    Object.keys(result).forEach(function (name) {
      result[name] = Math.max(32, Math.round(result[name]));
    });
    return result;
  }

  /**
   * Собирает статистику по столбцам из первого десятка строк (виртуальный
   * скролл не держит все строки в DOM).
   */
  function collectColumns(headerTable, bodyTable) {
    const keys = columnKeys(headerTable);
    const ths = headerThs(headerTable);

    // Длина заголовка решает, влезет ли он; содержимое — сколько добавить.
    const headerWidths = ths.map(function (th) {
      const title = th.querySelector('[data-testid="title"]');
      return title ? textWidth(title.textContent.trim(), settings.fontSize) : 0;
    });
    const headerCap = headerWidths.reduce(function (a, b) { return Math.max(a, b); }, 0);

    const rows = bodyTable
      ? Array.from(bodyTable.querySelectorAll('tbody tr.ant-table-row')).slice(0, 30)
      : [];

    // Ширины всех ячеек считаем по строкам один раз — без innerText на каждую.
    const rowWidths = rows.map(function (row) {
      return Array.from(row.children).map(function (cell) {
        const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        return text ? textWidth(text, settings.fontSize) : 0;
      });
    });

    const contentWidths = names.map(function (name, index) {
      return rowWidths.reduce(function (max, widths) { return Math.max(max, widths[index] || 0); }, 0);
    });
    const contentCap = contentWidths.reduce(function (a, b) { return Math.max(a, b); }, 0);

    return keys.map(function (key, index) {
      const chrome = settings.cellPaddingX * 2 + 4;
      const content = Math.min(contentWidths[index], settings.fontSize * 40);
      const header = Math.min(headerWidths[index], settings.fontSize * 16);
      return {
        index: index,
        name: key || ('#' + (index + 1)),
        headerMin: header + chrome + 12,
        // Ширины, выходящие за 90% самого длинного столбца, — это «хвосты»
        // текста; они не должны растягивать столбец.
        content: Math.min(content, Math.max(contentCap * 0.9, headerCap * 0.6, settings.fontSize * 12)) + chrome + 12
      };
    });
  }

  function resizeTable(table, widths) {
    Array.from(table.querySelectorAll('colgroup')).forEach(function (group) {
      Array.from(group.querySelectorAll('col')).forEach(function (col, index) {
        if (widths[index]) {
          col.style.width = widths[index] + 'px';
          col.setAttribute('data-kuma-w', '1');
        }
      });
    });

    // Обёртка виртуального скролла получает итоговую ширину — иначе клампится.
    const body = table.querySelector('.ant-table-body');
    const total = domWidths(table).reduce(function (sum, w) { return sum + w; }, 0);
    const wrapper = table.querySelector('.ant-table-body > div');
    if (wrapper && total > 0) {
      wrapper.style.width = total + 'px';
      wrapper.style.minWidth = '100%';
      // KUMA держит шоркат на ширину содержимого; после сужения столбцов
      // он остаётся 1715px — сбрасываем кэш, чтобы таблица прокручивалась
      // в пределах колонок, а не в пустоту.
      const viewport = body ? body.clientWidth : 0;
      if (viewport && total < viewport) {
        wrapper.dispatchEvent(new Event('scroll'));
        if (body.scrollLeft > 0) body.scrollLeft = 0;
      }
    }
  }

  /* ==================== Подгонка по высоте окна ==================== */

  /**
   * Окно в KUMA отдаёт таблице фиксированные 338px под строки. Мы
   * пересчитываем лимит так, чтобы таблица занимала остаток окна
   * (примерно 2/3 высоты), а верхняя часть — сжатую шапку с запросом.
   * Ширину и стили это не затрагивает.
   */
  const BODY_MAX_ATTR = 'data-kuma-ui-h';

  let heightTimer = null;

  function scheduleHeightSync() {
    if (!active) return;
    if (heightTimer) clearTimeout(heightTimer);
    heightTimer = setTimeout(function () {
      heightTimer = null;
      try {
        syncHeight();
        sync();
      } catch (error) {
        debugWarn('height sync failed', error);
      }
    }, 120);
  }

  /** Куда в вуали таблицы домещается: body + шапка + отступы; остальное — запас. */
  function syncHeight() {
    const table = document.getElementById(TABLE_ID);
    if (!table) return;

    if (!settings.fitHeight) {
      const bodyEl = table.querySelector('.ant-table-body');
      if (bodyEl && bodyEl.hasAttribute(BODY_MAX_ATTR)) {
        bodyEl.style.removeProperty('max-height');
        bodyEl.removeAttribute(BODY_MAX_ATTR);
        window.dispatchEvent(new Event('resize'));
      }
      return;
    }

    const body = table.querySelector('.ant-table-body');
    const header = table.querySelector('.ant-table-header');
    if (!body || !header) return;

    const tableTop = table.getBoundingClientRect().top;
    const headerH = header.getBoundingClientRect().height || 0;
    // Запас снизу — чтобы была видна горизонтальная прокрутка.
    const bottomGap = 18;
    const available = window.innerHeight - tableTop - headerH - bottomGap;

    if (available < 120) return;

    const next = Math.round(available) + 'px';
    if (body.style.maxHeight === next) return;
    body.style.setProperty('max-height', next, 'important');
    body.setAttribute(BODY_MAX_ATTR, next);

    // Виртуальный скролл KUMA прокручивает строки по высоте контейнера —
    // сообщаем ему о новом размере.
    window.dispatchEvent(new Event('resize'));
  }

  /* ==================== Синхронизация ==================== */

  function sync(force) {
    if (!active) return;

    const root = document.querySelector('.table_vAJH\\+');
    const table = document.getElementById(TABLE_ID);
    if (!root || !table) {
      removeStyle();
      lastLayoutKey = '';
      return;
    }

    applyStyle();
    syncHeight();

    // KUMA могла пересчитать colgroup сама — сверяем шапку и строки.
    reconcileColgroups(table);

    // Закреплённые ширины: KUMA перезаписывает их при догрузке событий,
    // смене выборки и перерисовке шапки.
    if (applyManualWidths(table)) {
      scheduleReapply();
      lastLayoutKey = '';
      return;
    }

    const headerTable = table.querySelector('.ant-table-header table');
    const bodyTable = table.querySelector('.ant-table-body table');
    if (!headerTable) return;

    const body = table.querySelector('.ant-table-body');
    const available = body ? Math.max(body.clientWidth, body.getBoundingClientRect().width) : root.clientWidth;
    if (available < 120) return;

    const columns = collectColumns(headerTable, bodyTable);
    if (!columns.length) return;

    const layoutKey = available + '|' + settings.fontSize + '|' + settings.cellPaddingX + '|' +
      columns.map(function (c) { return Math.round(c.content); }).join(',');
    if (!force && layoutKey === lastLayoutKey) return;

    lastLayoutKey = layoutKey;

    const fitted = fitWidths(available, columns);
    const widths = columns.map(function (c) { return fitted[c.name]; });

    resizeTable(table, widths);

    // KUMA кладёт ширины на следующем кадре и перерисовывает таблицу —
    // просим пересчёт ещё несколько раз, чтобы наши ширины победили.
    scheduleReapply();

    // KUMA кэширует ширины и перерисовывает таблицу по DOM-событиям;
    // один пересчёт после смены ширин, без циклов.
    if (selfApplyDepth < 2) {
      selfApplyDepth++;
      window.dispatchEvent(new Event('resize'));
      if (applyTimer) clearTimeout(applyTimer);
      applyTimer = setTimeout(function () {
        applyTimer = null;
        selfApplyDepth = 0;
        scheduleSync();
      }, 400);
    }
  }

  /* ==================== Старт ==================== */

  try {
    chrome.storage.local.get('runtime').then(function (data) {
      applyRuntime(data && data.runtime);
    }).catch(function (error) {
      debugWarn('runtime read failed', error);
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
})();
