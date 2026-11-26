/**
 * Модуль "UI Improve — компактная таблица событий".
 *
 * Делает страницу «События» (threat-hunting) плотнее:
 *   - таблица результатов: строки и шапка ниже, шрифт мельче,
 *     вертикальные разделители столбцов;
 *   - верхняя часть страницы (заголовок, окно запроса, тайтл-бар)
 *     сжимается;
 *   - панель «Информация о событии» — компактная таблица ключ-значение,
 *     длинные значения переносятся, а не обрезаются;
 *   - подокно «Группы» (при группировке) — та же плотность, что и у
 *     основной таблицы.
 *
 * Железное правило модуля: он НЕ пишет в геометрию основной виртуальной
 * таблицы KUMA — ни в colgroup, ни в обёртку виртуального скролла, ни в
 * position/top строк, ни в высоты, которые считает сам KUMA. Поэтому здесь
 * только CSS. KUMA остаётся единственным, кто раскладывает колонки и строки.
 */
(function () {
  'use strict';

  if (window.__kumaUiImproveLoaded) return;
  window.__kumaUiImproveLoaded = true;

  const MODULE_ID = 'ui-improve';
  const STYLE_ID = '__kuma_ui_improve_style__';
  const TABLE_ID = 'threat-hunting-table';

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
    pageTitleSize: 18,
    queryFontSize: 11,
    compactDrawer: true,
    drawerWidth: 600
  };

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;
  let observer = null;
  let lastStyleKey = '';

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
      pageTitleSize: clampInt(src.pageTitleSize, LIMITS.pageTitleSize, DEFAULT_SETTINGS.pageTitleSize),
      queryFontSize: clampInt(src.queryFontSize, LIMITS.queryFontSize, DEFAULT_SETTINGS.queryFontSize),
      compactDrawer: src.compactDrawer !== false,
      drawerWidth: clampInt(src.drawerWidth, LIMITS.drawerWidth, DEFAULT_SETTINGS.drawerWidth)
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
    start();
  }

  function start() {
    if (active) return;
    active = true;

    applyStyle();
    observer = new MutationObserver(onDomChange);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stop() {
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    removeStyle();
  }

  /**
   * Стиль навешивается один раз (и при смене настроек). Свой маленький
   * MutationObserver только следит, не перерисовала ли KUMA таблицу
   * целиком: если стиля нет в документе — возвращаем. Никаких кругов
   * «стиль → перерисовка → стиль».
   */
  function onDomChange() {
    if (!active) return;
    if (!document.getElementById(STYLE_ID)) applyStyle();
  }

  /* ==================== Стили ==================== */

  function applyStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }

    const s = settings;
    const key = JSON.stringify(s);
    if (key === lastStyleKey && style.textContent) return;
    lastStyleKey = key;

    style.textContent = tableCss() + topBlocksCss() + (s.compactDrawer ? drawerCss() : '') + groupsCss();
  }

  function tableCss() {
    const s = settings;
    const root = '#' + TABLE_ID;

    const fontSize = s.fontSize + 'px';
    // Строка должна вместить отступы и текст — иначе KUMA раздует высоту.
    const lineHeight = Math.max(s.fontSize + 4, s.rowHeight - s.cellPaddingY * 2) + 'px';
    const padding = `${s.cellPaddingY}px ${s.cellPaddingX}px`;
    const headerLineHeight = Math.max(s.fontSize + 3, s.headerHeight - 6) + 'px';

    // Вертикальные разделители: box-shadow не участвует в раскладке таблицы,
    // поэтому не сдвигает ширины виртуального скролла, но идёт по всей высоте.
    const divider = 'rgba(31, 41, 55, 0.14)';
    const dividerLeft = `-1px 0 0 0 ${divider}`;
    const dividerRight = `1px 0 0 0 ${divider}`;
    const cells = `${root} .ant-table-container > :is(.ant-table-header, .ant-table-body) table :is(thead tr > th, tbody .ant-table-row > td)`;

    return `
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

      /* Заглушки виртуализации — без разделителей. */
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
        height: ${s.headerHeight}px !important;
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

      /* Служебные элементы виртуализации не занимают места. */
      ${root} .ant-table-row-indent { display: none !important; }
      ${root} .ant-table-tbody > tr.ant-table-measure-row > td { padding: 0 !important; }
    `;
  }

  /**
   * Компактная верхняя часть страницы событий: заголовок, тайтл-бар,
   * окно запроса, строка «Результаты запроса» и панель над таблицей.
   * Классы KUMA динамические, опираемся на id корня страницы и
   * устойчивые префиксы styled-components.
   */
  function topBlocksCss() {
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
        box-sizing: border-box !important;
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

      /* Чипы тенантов в тайтл-баре. У KUMA обёртки чипов выше строки */
      /* селекта — прижимаем их к высоте селекта, иначе всё съезжает. */
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
    const extraRow = `${content} [kuma-section="extra"]`;
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

      /* Колонка значения: длинный текст переносится на новые строки, */
      /* а не уходит за край. overflow-wrap спасает от длинных строк */
      /* без пробелов (пути, команды, GUID). */
      ${rows} > :nth-child(2) {
        display: block !important;
        align-self: center !important;
        overflow: visible !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
        /* Оставляем место кнопке копирования у правого края. */
        padding-right: 26px !important;
      }
      ${rows} > :nth-child(2) > * {
        max-width: 100% !important;
        overflow: visible !important;
        text-overflow: clip !important;
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
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

      /* Секция Extra: не пара «подпись — значение», а длинный список */
      /* полей. KUMA ставит её отдельным блоком после таблицы полей, */
      /* поэтому стилизуем не как строку сетки, а как список на всю */
      /* ширину панели. */
      ${extraRow} {
        display: block !important;
        margin-top: 6px !important;
        padding: 0 !important;
        border-top: 1px solid ${softLine} !important;
      }
      ${extraRow} > :first-child {
        display: inline-flex !important;
        align-items: center !important;
        width: auto !important;
        height: 18px !important;
        margin: 4px 8px 0 !important;
        padding: 0 6px !important;
        border-right: 0 !important;
        border-radius: 4px !important;
        background: #eef1f5 !important;
        color: #4b5563 !important;
        font-size: 11px !important;
        line-height: 18px !important;
        white-space: nowrap !important;
      }
      ${extraRow} > [kuma-section="extra-values"] {
        display: block !important;
        width: auto !important;
        padding: 2px 8px 4px !important;
        font-size: 12px !important;
        line-height: 16px !important;
      }
      ${extraRow} [kuma-section="extra-event-field"] {
        padding: 1px 0 !important;
        border-bottom: 1px dotted ${softLine} !important;
      }
      ${extraRow} [kuma-section="extra-event-field"]:last-child {
        border-bottom: 0 !important;
      }
      ${extraRow} [kuma-section="extra-event-field"]:nth-child(even) {
        background: #fbfcfd !important;
      }
      ${extraRow} [kuma-section="extra-event-field"] pre {
        margin: 0 !important;
        font-size: 11px !important;
        line-height: 15px !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
      }
      ${extraRow} [kuma-section="extra-event-field"] pre > :first-child {
        color: #6b7280 !important;
      }

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

  /**
   * Подокно «Группы», которое появляется при группировке событий.
   * KUMA рисует его обычным antd-табличным стилем, но с крупными
   * ячейками (14px / 39px) и высокой шапкой. Приводим «Группы» и
   * «События группы» к плотности основной таблицы, а переключатель
   * «Карточки / Таблица» и кнопки делаем компактнее.
   *
   * Геометрию панели не трогаем: её ширину задаёт сам KUMA и
   * пользователь, перетаскивая ручку.
   */
  function groupsCss() {
    const s = settings;
    const groups = '#threat-hunting-root [class*="groupsLayout_"]';
    const panel = `${groups} [class*="groupsPanel_"]`;
    const panes = `${groups} :is([class*="groupsPanel_"], [class*="events_"])`;

    const fontSize = s.fontSize + 'px';
    const lineHeight = Math.max(s.fontSize + 4, s.rowHeight - s.cellPaddingY * 2) + 'px';
    const padding = `${s.cellPaddingY}px ${s.cellPaddingX}px`;
    const itemHeight = Math.max(20, s.rowHeight - 2);
    const itemFont = Math.max(9, s.fontSize - 1);

    return `
      /* Заголовок «Группы (N)» — компактно, режимы просмотра рядом. */
      ${panel} [class*="groupsHeader_"] {
        margin: 0 8px 6px 0 !important;
        align-items: center !important;
      }
      ${panel} [class*="groupsHeader_"] h5 {
        height: 18px !important;
        margin: 0 !important;
        font-size: 14px !important;
        line-height: 18px !important;
      }

      /* Переключатель «Карточки / Таблица»: значок и подпись в строку, */
      /* иначе KUMA ставит их друг под другом и шапка раздувается. */
      ${panel} [class*="SegmentedButtonItem"] {
        height: ${itemHeight}px !important;
        padding: 0 4px !important;
      }
      ${panel} [class*="SegmentedButtonItem"] label {
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        height: ${itemHeight}px !important;
        line-height: ${itemHeight}px !important;
      }
      ${panel} [class*="SegmentedButtonItem"] [class*="item-input"] {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        margin: 0 !important;
        opacity: 0 !important;
      }
      ${panel} [class*="SegmentedButtonItem"] [class*="item-additional"] {
        display: flex !important;
        align-items: center !important;
        height: ${Math.max(12, s.fontSize + 2)}px !important;
      }
      ${panel} [class*="SegmentedButtonItem"] svg {
        width: ${s.fontSize}px !important;
        height: ${s.fontSize}px !important;
      }
      ${panel} [class*="SegmentedButtonItem"] [class*="item-text"] {
        height: auto !important;
        font-size: ${itemFont}px !important;
        line-height: ${itemHeight - 8}px !important;
      }

      /* Панель инструментов (TSV, поиск) над таблицей групп. */
      ${groups} [class*="toolbar-wrapper"] {
        height: ${s.rowHeight + 2}px !important;
        margin-top: 2px !important;
      }
      ${groups} [class*="toolbar-wrapper"] .ant-btn {
        height: ${s.rowHeight}px !important;
        min-height: ${s.rowHeight}px !important;
        padding: 0 8px !important;
        font-size: ${fontSize} !important;
      }
      ${groups} [class*="toolbar-wrapper"] .ant-btn svg {
        width: ${Math.max(11, s.fontSize + 1)}px !important;
        height: ${Math.max(11, s.fontSize + 1)}px !important;
      }
      ${groups} [class*="toolbar-wrapper"] :is(.ant-input-affix-wrapper, .ant-input) {
        height: ${s.rowHeight}px !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        font-size: ${fontSize} !important;
      }

      /* Сами таблицы: «Группы» и «События группы». */
      ${panes} .ant-table-cell {
        padding: ${padding} !important;
        font-size: ${fontSize} !important;
        line-height: ${lineHeight} !important;
      }
      ${panes} .ant-table-thead > tr > th {
        height: ${s.headerHeight}px !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        line-height: ${Math.max(s.fontSize + 3, s.headerHeight - 6)}px !important;
      }
      ${panes} .ant-table-tbody > tr.ant-table-row > td {
        height: ${s.rowHeight}px !important;
        box-sizing: border-box !important;
      }
      ${panes} .ant-table-tbody > tr.ant-table-row > td .ant-table-row-indent {
        display: none !important;
      }
    `;
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    lastStyleKey = '';
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
