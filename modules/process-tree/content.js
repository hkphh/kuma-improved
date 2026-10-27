(function () {
  'use strict';

  if (window.__kumaProcessTreeLoaded) return;
  window.__kumaProcessTreeLoaded = true;

  /* ==================== 0. Конфиг модуля ==================== */
  const MODULE_ID = 'process-tree';
  const DEFAULT_SETTINGS = {
    apiPathPattern: '/api/private/events',
    sameOriginOnly: true
  };

  let active = true;
  let moduleSettings = { ...DEFAULT_SETTINGS };

  function pushConfig() {
    try {
      // enabled управляет хуком в MAIN-мире: при выключении модуля
      // перехват перестаёт читать тела ответов, хотя сам патч остаётся.
      const payload = Object.assign({}, moduleSettings, { enabled: active });
      window.dispatchEvent(new CustomEvent('__siem_traffic_config__', {
        detail: JSON.stringify(payload)
      }));
    } catch (e) {}
  }

  // inject.js сообщает, что хуки установлены — отдаём ему актуальный конфиг.
  window.addEventListener('__siem_traffic_ready__', pushConfig);

  /* ==================== 1. Инжект хука ==================== */
  let hookInjected = false;
  let hookAttempts = 0;

  function injectHook() {
    if (hookInjected) return;
    const parent = document.head || document.documentElement;
    if (!parent) {
      if (hookAttempts++ < 50) setTimeout(injectHook, 10);
      return;
    }
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('modules/process-tree/inject.js');
      s.onload = function () { this.remove(); };
      parent.appendChild(s);
      hookInjected = true;
    } catch (e) {
      console.warn('[SIEM Tree] inject failed', e);
      if (hookAttempts++ < 50) setTimeout(injectHook, 50);
    }
  }

  injectHook();

  /* ==================== 2. Состояние ==================== */
  const eventsById = new Map();      // события 4688 и 4689
  const expandedGroups = new Set();  // раскрытые группы
  let hideSvchost = false;           // фильтр svchost-листьев
  let loading = false;               // идёт получение событий после клика
  let btnEl = null;
  let badgeEl = null;
  let overlayEl = null;

  /* ---------- Применение настроек из runtime-конфига ---------- */
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
    if (!runtime) return;
    const mod = runtime.modules && runtime.modules[MODULE_ID];
    const allowed = runtime.enabled !== false && mod && mod.enabled && targetAllowed(runtime);

    active = Boolean(allowed);

    if (!active) {
      moduleSettings = { ...DEFAULT_SETTINGS };
      pushConfig();
      eventsById.clear();
      expandedGroups.clear();
      loading = false;
      if (btnEl) { btnEl.remove(); btnEl = null; badgeEl = null; }
      closeOverlay();
      return;
    }

    moduleSettings = Object.assign({}, DEFAULT_SETTINGS, mod.settings || {});
    pushConfig();
  }

  try {
    chrome.storage.local.get('runtime').then(function (data) {
      applyRuntime(data && data.runtime);
    }).catch(function () {});
  } catch (e) {}

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'local' && changes.runtime) {
        applyRuntime(changes.runtime.newValue);
      }
    });
  } catch (e) {}

  window.addEventListener('__siem_events__', function (ev) {
    if (!active) return;

    let payload;
    try { payload = JSON.parse(ev.detail); } catch (e) { return; }

    if (payload && payload.__refetchDone) {
      loading = false;
      if (overlayEl) rerender();
      return;
    }

    const items = extractItems(payload && payload.data);
    let added = 0;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;

      // Фильтр: только 4688 (создание) и 4689 (завершение)
      const classId = String(it.DeviceEventClassID || '');
      if (classId !== '4688' && classId !== '4689') continue;

      const id = it.ID || it.ExternalID ||
        [it.DeviceHostName, it.DeviceCustomString5, it.Timestamp, it.DeviceCustomString4].join('|');
      if (!eventsById.has(id)) {
        eventsById.set(id, it);
        added++;
      }
    }

    if (added) {
      loading = false;
      updateButton();
      if (overlayEl) rerender();
    }
  });

  function extractItems(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === 'object') {
      const keys = ['items', 'events', 'content', 'results', 'rows', 'data'];
      for (const k of keys) if (Array.isArray(data[k])) return data[k];
      return [data];
    }
    return [];
  }

  /* ==================== 3. Кнопка ==================== */
  function updateButton() {
    if (!active) return;
    if (!btnEl) {
      injectStyles();
      btnEl = document.createElement('button');
      btnEl.id = '__siem_tree_btn__';
      btnEl.innerHTML = 'Построить граф <span id="__siem_tree_badge__">0</span>';
      btnEl.addEventListener('click', onBuildClick);
      document.documentElement.appendChild(btnEl);
      badgeEl = btnEl.querySelector('#__siem_tree_badge__');
    }
    if (badgeEl) badgeEl.textContent = String(eventsById.size);
  }

  function onBuildClick() {
    // Каждый клик — очистка + повторный запрос
    eventsById.clear();
    expandedGroups.clear();
    if (badgeEl) badgeEl.textContent = '0';

    loading = true;
    window.dispatchEvent(new CustomEvent('__siem_tree_refetch__'));
    openOverlay();

    // Страховка, если refetch не отдал ответ
    setTimeout(function () {
      if (loading) {
        loading = false;
        if (overlayEl) rerender();
      }
    }, 4000);
  }

  /* ==================== 4. Утилиты ==================== */
  function basename(p) {
    if (!p) return '';
    const s = String(p).replace(/^\\\\\?\\/, '');
    const parts = s.split(/[\\\/]/);
    return parts[parts.length - 1] || s;
  }

  function parsePid(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const t = String(v).trim();
    if (!t) return null;
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const n = parseInt(t, 16);
    return isNaN(n) ? null : n;
  }

  function hex(pid) { return '0x' + Number(pid || 0).toString(16); }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('ru-RU', { hour12: false });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function keyOf(host, pid) { return (host || '') + '|' + pid; }

  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    return el;
  }

  // svchost-лист (без детей, не фантом)
  function isSvchostLeaf(n) {
    if (!n || n.phantom) return false;
    if (n.children && n.children.length > 0) return false;
    const name = String(n.name || '').toLowerCase();
    return name === 'svchost' || name === 'svchost.exe';
  }

  /* ==================== 5. Модель графа ==================== */
  const NODE_W = 260;
  const NODE_H = 54;
  const H_GAP = 90;
  const V_GAP = 14;
  const PAD = 40;
  const GROUP_THRESHOLD = 5;

  function buildNodes() {
    const nodes = [];
    for (const ev of eventsById.values()) {
      if (String(ev.DeviceEventClassID) !== '4688') continue;

      const pid = parsePid(ev.DeviceCustomString5);
      if (pid === null) continue;

      const ppidRaw = parsePid(ev.DeviceCustomString3);
      const fullPath = ev.DestinationProcessName || ev.FileName || '';

      nodes.push({
        id: ev.ID || (pid + '@' + nodes.length),
        pid: pid,
        ppid: (ppidRaw && ppidRaw > 0) ? ppidRaw : null,
        name: basename(fullPath) || 'unknown',
        fullPath: fullPath,
        cmd: ev.DeviceCustomString4 || '',
        timestamp: Number(ev.Timestamp || ev.DeviceReceiptTime || ev.StartTime || 0) || 0,
        host: ev.DeviceHostName || ev.DeviceAddress || '',
        user: ev.SourceUserName || ev.SourceAccountName || '',
        parentName: basename(ev.SourceProcessName || ''),
        event: ev,
        phantom: false,
        exited: false,
        children: [],
        parent: null
      });
    }
    return nodes;
  }

  function linkNodes(nodes) {
    const byKey = new Map();
    for (const n of nodes) {
      const k = keyOf(n.host, n.pid);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(n);
    }

    const phantomByKey = new Map();
    for (const n of nodes) {
      if (n.ppid === null) continue;
      const k = keyOf(n.host, n.ppid);
      const known = byKey.get(k);
      if (known && known.length) continue;
      if (!n.parentName) continue;

      let ph = phantomByKey.get(k);
      if (!ph) {
        ph = {
          id: 'phantom:' + k, pid: n.ppid, ppid: null,
          name: n.parentName, fullPath: n.parentName, cmd: '',
          timestamp: n.timestamp, host: n.host, user: '',
          parentName: '', event: null, phantom: true, exited: false,
          children: [], parent: null
        };
        phantomByKey.set(k, ph);
        nodes.push(ph);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(ph);
      }
      if (n.timestamp && (!ph.timestamp || n.timestamp < ph.timestamp)) ph.timestamp = n.timestamp;
    }

    nodes.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });

    for (const n of nodes) {
      if (n.ppid === null || n.ppid === n.pid) continue;
      const cands = byKey.get(keyOf(n.host, n.ppid));
      if (!cands || !cands.length) continue;

      let best = null;
      for (const c of cands) {
        if (c === n) continue;
        if (c.phantom) { best = c; break; }
        if (c.timestamp && c.timestamp <= n.timestamp) {
          if (!best || c.timestamp > best.timestamp) best = c;
        }
      }
      if (!best) {
        for (const c of cands) {
          if (c === n || c.phantom) continue;
          if (!best || c.timestamp < best.timestamp) best = c;
        }
      }
      if (best && !wouldCreateCycle(n, best)) {
        n.parent = best;
        best.children.push(n);
      }
    }
    return nodes;
  }

  function wouldCreateCycle(child, parent) {
    let p = parent; const seen = new Set();
    while (p) {
      if (p === child) return true;
      if (seen.has(p)) return true;
      seen.add(p);
      p = p.parent;
    }
    return false;
  }

  function markExited(nodes) {
    const byKey = new Map();
    for (const n of nodes) {
      const k = keyOf(n.host, n.pid);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(n);
    }
    for (const arr of byKey.values()) {
      arr.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
    }

    for (const ev of eventsById.values()) {
      if (String(ev.DeviceEventClassID) !== '4689') continue;

      let pid = parsePid(ev.DeviceCustomString3);
      if (pid === null) pid = parsePid(ev.DeviceCustomString5);
      if (pid === null) continue;

      const host = ev.DeviceHostName || ev.DeviceAddress || '';
      const cands = byKey.get(keyOf(host, pid));
      if (!cands) continue;

      const exitTs = Number(ev.Timestamp || ev.DeviceReceiptTime || 0) || 0;

      let best = null;
      for (const c of cands) {
        if (c.exited) continue;
        if (exitTs && c.timestamp && c.timestamp > exitTs) continue;
        best = c;
      }
      if (!best) for (const c of cands) if (!c.exited) { best = c; break; }
      if (best) best.exited = true;
    }
  }

  /* ==================== 6. Display-дерево (с группами и фильтром svchost) ==================== */
  function buildDisplayRoots(treeRoots) {
    function rec(real) {
      // Пропускаем svchost-листья, если включён фильтр
      if (hideSvchost && isSvchostLeaf(real)) return null;

      const d = { real: real, isGroup: false, isCollapse: false, children: [] };

      const visibleKids = real.children.filter(function (c) {
        return !(hideSvchost && isSvchostLeaf(c));
      });

      if (visibleKids.length > GROUP_THRESHOLD) {
        if (!expandedGroups.has(real.id)) {
          d.children.push({
            real: real, isGroup: true, groupId: real.id,
            count: visibleKids.length, children: []
          });
        } else {
          d.children.push({
            real: real, isCollapse: true, groupId: real.id,
            count: visibleKids.length, children: []
          });
          for (const c of visibleKids) {
            const child = rec(c);
            if (child) d.children.push(child);
          }
        }
      } else {
        for (const c of visibleKids) {
          const child = rec(c);
          if (child) d.children.push(child);
        }
      }
      return d;
    }

    const out = [];
    for (const r of treeRoots) {
      const n = rec(r);
      if (n) out.push(n);
    }
    return out;
  }

  function layoutDisplay(roots) {
    let cursor = 0;
    let maxDepth = 0;
    function visit(node, depth) {
      node._depth = depth;
      if (depth > maxDepth) maxDepth = depth;
      node._x = depth * (NODE_W + H_GAP);
      if (!node.children.length) {
        node._y = cursor * (NODE_H + V_GAP);
        cursor++;
      } else {
        for (const c of node.children) visit(c, depth + 1);
        node._y = (node.children[0]._y + node.children[node.children.length - 1]._y) / 2;
      }
    }
    for (const r of roots) { visit(r, 0); cursor += 1; }
    return { maxDepth: maxDepth, rows: cursor };
  }

  function flattenDisplay(roots) {
    const out = [];
    function rec(n) { out.push(n); for (const c of n.children) rec(c); }
    for (const r of roots) rec(r);
    return out;
  }

  /* ==================== 7. Overlay + View ==================== */
  let currentGRoot = null;
  const view = { scale: 1, tx: 20, ty: 20 };

  function applyTransform() {
    if (!currentGRoot) return;
    currentGRoot.setAttribute('transform',
      'translate(' + view.tx + ',' + view.ty + ') scale(' + view.scale + ')');
  }

  function openOverlay() {
    if (overlayEl) overlayEl.remove();

    view.scale = 1; view.tx = 20; view.ty = 20;

    overlayEl = document.createElement('div');
    overlayEl.id = '__siem_tree_overlay__';
    overlayEl.innerHTML =
      '<div class="hdr">' +
        '<h2>Дерево процессов</h2>' +
        '<span class="cnt">событий: <b id="__siem_tree_cnt__">0</b></span>' +
        '<div class="spacer"></div>' +
        '<button class="act" data-act="svchost">Спрятать svchost</button>' +
        '<button class="act" data-act="reset">Сбросить вид</button>' +
        '<button class="act" data-act="close">Закрыть ✕</button>' +
      '</div>' +
      '<div class="vp" id="__siem_tree_viewport__"></div>' +
      '<div class="orp" id="__siem_tree_orphans__"></div>' +
      '<div class="tt" id="__siem_tree_tooltip__"></div>';

    document.documentElement.appendChild(overlayEl);

    const svchostBtn = overlayEl.querySelector('[data-act="svchost"]');
    syncSvchostBtn(svchostBtn);

    svchostBtn.addEventListener('click', function () {
      hideSvchost = !hideSvchost;
      syncSvchostBtn(svchostBtn);
      rerender();
    });

    overlayEl.querySelector('[data-act="close"]').addEventListener('click', closeOverlay);
    overlayEl.querySelector('[data-act="reset"]').addEventListener('click', function () {
      view.scale = 1; view.tx = 20; view.ty = 20;
      applyTransform();
    });

    const viewport = overlayEl.querySelector('#__siem_tree_viewport__');

    viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = Math.min(3, Math.max(0.08, view.scale * factor));
      view.tx = mx - (mx - view.tx) * (ns / view.scale);
      view.ty = my - (my - view.ty) * (ns / view.scale);
      view.scale = ns;
      applyTransform();
    }, { passive: false });

    let dragging = false, lx = 0, ly = 0;
    viewport.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      lx = e.clientX; ly = e.clientY;
      viewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      view.tx += e.clientX - lx;
      view.ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      applyTransform();
    });
    window.addEventListener('mouseup', function () {
      dragging = false;
      if (viewport) viewport.classList.remove('dragging');
    });

    document.addEventListener('keydown', escHandler);
    rerender();
  }

  function syncSvchostBtn(btn) {
    if (!btn) return;
    btn.textContent = hideSvchost ? 'Показать svchost' : 'Спрятать svchost';
    btn.classList.toggle('active', hideSvchost);
  }

  function escHandler(e) { if (e.key === 'Escape') closeOverlay(); }

  function closeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    currentGRoot = null;
    document.removeEventListener('keydown', escHandler);
  }

  function rerender() {
    if (!overlayEl) return;
    const viewport = overlayEl.querySelector('#__siem_tree_viewport__');
    const orphanBox = overlayEl.querySelector('#__siem_tree_orphans__');
    const tooltip = overlayEl.querySelector('#__siem_tree_tooltip__');
    const cntEl = overlayEl.querySelector('#__siem_tree_cnt__');
    if (cntEl) cntEl.textContent = String(eventsById.size);
    renderGraph(viewport, orphanBox, tooltip);
  }

  /* ==================== 8. Рендер ==================== */
  function renderGraph(viewport, orphanBox, tooltip) {
    viewport.innerHTML = '';
    orphanBox.innerHTML = '';
    currentGRoot = null;

    if (loading && eventsById.size === 0) {
      viewport.innerHTML =
        '<div style="padding:32px;color:#8b949e;font-size:14px">' +
        'Загрузка событий…' +
        '</div>';
      renderOrphans(orphanBox, []);
      return;
    }

    const nodes = buildNodes();
    if (!nodes.length) {
      viewport.innerHTML =
        '<div style="padding:32px;color:#8b949e;font-size:14px">' +
        'Нет событий с EventClassID = 4688.<br>' +
        'Откройте вкладку Network на странице SIEM и обновите список событий.' +
        '</div>';
      renderOrphans(orphanBox, []);
      return;
    }

    linkNodes(nodes);
    markExited(nodes);

    const allRoots = nodes.filter(function (n) { return !n.parent; });
    const treeRoots = allRoots.filter(function (n) { return n.children.length > 0; });
    const orphanRoots = allRoots.filter(function (n) { return n.children.length === 0; });

    const displayRoots = buildDisplayRoots(treeRoots);
    layoutDisplay(displayRoots);
    const flat = flattenDisplay(displayRoots);

    const svg = svgEl('svg', { id: '__siem_graph_svg__' });
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    const gRoot = svgEl('g', { id: '__siem_graph_root__' });
    svg.appendChild(gRoot);
    viewport.appendChild(svg);
    currentGRoot = gRoot;

    function drawEdges(node) {
      for (const c of node.children) {
        const x1 = node._x + PAD + NODE_W;
        const y1 = node._y + PAD + NODE_H / 2;
        const x2 = c._x + PAD;
        const y2 = c._y + PAD + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const path = svgEl('path', {
          d: 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2,
          class: 'edge'
            + (c.isGroup || c.isCollapse ? ' group' : '')
            + (c.real && c.real.phantom ? ' phantom' : '')
        });
        gRoot.appendChild(path);
        drawEdges(c);
      }
    }
    for (const r of displayRoots) drawEdges(r);

    for (const dn of flat) drawNode(gRoot, dn, tooltip);

    applyTransform();

    // Отфильтровать одиночек svchost, если фильтр включён
    const visibleOrphans = hideSvchost
      ? orphanRoots.filter(function (n) { return !isSvchostLeaf(n); })
      : orphanRoots;

    renderOrphans(orphanBox, visibleOrphans);
  }

  function drawNode(gRoot, dn, tooltip) {
    const real = dn.real;
    const g = svgEl('g', {
      transform: 'translate(' + (dn._x + PAD) + ',' + (dn._y + PAD) + ')',
      class: 'node'
        + (dn.isGroup ? ' group' : '')
        + (dn.isCollapse ? ' collapse' : '')
        + (real && real.phantom ? ' phantom' : '')
        + (real && real.exited ? ' exited' : '')
    });

    g.appendChild(svgEl('rect', { x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 8, ry: 8 }));

    if (dn.isGroup) {
      g.appendChild(svgEl('text', { x: 12, y: 22, class: 'name' }, '▶  ' + dn.count + ' процессов'));
      g.appendChild(svgEl('text', { x: 12, y: 40, class: 'sub' }, 'Нажмите, чтобы развернуть'));
      g.style.cursor = 'pointer';
      g.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      g.addEventListener('click', function (e) {
        e.stopPropagation();
        expandedGroups.add(dn.groupId);
        rerender();
      });
    } else if (dn.isCollapse) {
      g.appendChild(svgEl('text', { x: 12, y: 22, class: 'name' }, '▼  Свернуть (' + dn.count + ')'));
      g.appendChild(svgEl('text', { x: 12, y: 40, class: 'sub' }, 'Нажмите, чтобы скрыть детей'));
      g.style.cursor = 'pointer';
      g.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      g.addEventListener('click', function (e) {
        e.stopPropagation();
        expandedGroups.delete(dn.groupId);
        rerender();
      });
    } else {
      g.appendChild(svgEl('text', { x: 12, y: 22, class: 'name' }, truncate(real.name, 32)));
      const sub = 'PID ' + hex(real.pid) +
  		' · PPID ' + (real.ppid ? hex(real.ppid) : '—') +
  		(real.phantom ? ' · родитель неизвестен' : '');
      g.appendChild(svgEl('text', { x: 12, y: 40, class: 'sub' }, sub));

      if (real.exited) {
        g.appendChild(svgEl('circle', { cx: NODE_W - 12, cy: 12, r: 6, class: 'exit-dot' }));
      }

      g.addEventListener('mouseenter', function (e) { showTooltip(tooltip, e, real); });
      g.addEventListener('mousemove', function (e) { moveTooltip(tooltip, e); });
      g.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
    }

    gRoot.appendChild(g);
  }

  /* ==================== 9. Тултип ==================== */
  function showTooltip(tooltip, e, n) {
    const ev = n.event || {};
    const rows = [];
    rows.push(['Имя', n.name]);
    if (n.fullPath) rows.push(['Путь', n.fullPath]);
    rows.push(['PID', hex(n.pid) + ' (' + n.pid + ')']);
    rows.push(['Parent PID', n.ppid ? hex(n.ppid) + ' (' + n.ppid + ')' : '—']);
    if (n.parentName) rows.push(['Родитель (образ)', n.parentName]);
    rows.push(['Timestamp', fmtTime(n.timestamp)]);
    if (n.exited) rows.push(['Статус', 'Завершён (4689)']);
    if (n.host) rows.push(['Host', n.host]);
    if (n.user) rows.push(['User', n.user]);
    if (n.cmd) rows.push(['Command Line', n.cmd]);
    if (ev.DeviceEventClassID) rows.push(['Event', ev.DeviceEventClassID + ' / ' + (ev.Name || '')]);
    if (ev.SourceProcessName) rows.push(['Source Process', ev.SourceProcessName]);
    if (ev.DeviceCustomString1) {
      rows.push([ev.DeviceCustomString1Label || 'DeviceCustomString1', ev.DeviceCustomString1]);
    }
    if (ev.EventOutcome) rows.push(['Outcome', ev.EventOutcome]);

    let html = '<div class="tt-title">' + escapeHtml(n.name) +
      (n.phantom ? ' <i>(родитель не найден в событиях)</i>' : '') +
      (n.exited ? ' <i>· завершён</i>' : '') + '</div>';
    html += '<table>';
    for (const r of rows) {
      html += '<tr><td>' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td></tr>';
    }
    html += '</table>';

    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    moveTooltip(tooltip, e);
  }

  function moveTooltip(tooltip, e) {
    const pad = 16;
    const w = tooltip.offsetWidth || 320;
    const h = tooltip.offsetHeight || 200;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  /* ==================== 10. Панель одиночек ==================== */
  function renderOrphans(box, orphans) {
    const title = document.createElement('div');
    title.className = 'orp-title';
    title.textContent = 'Одиночные процессы (нет родителя и нет детей): ' + orphans.length;
    box.appendChild(title);

    if (!orphans.length) {
      const empty = document.createElement('div');
      empty.className = 'orp-empty';
      empty.textContent = hideSvchost
        ? 'Список пуст (учтён фильтр svchost).'
        : 'Таких процессов нет.';
      box.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'orp-list';

    for (const r of orphans) {
      const chip = document.createElement('div');
      chip.className = 'orp-chip' + (r.exited ? ' exited' : '');
      chip.innerHTML =
        '<b>' + escapeHtml(r.name) + '</b>' +
        '<span>PID ' + escapeHtml(hex(r.pid)) + '</span>' +
        (r.host ? '<span>' + escapeHtml(truncate(r.host, 24)) + '</span>' : '') +
        '<span>' + escapeHtml(fmtTime(r.timestamp)) + '</span>' +
        (r.exited ? '<span class="exit-flag">завершён</span>' : '');
      list.appendChild(chip);
    }
    box.appendChild(list);
  }

  /* ==================== 11. Стили ==================== */
  function injectStyles() {
    if (document.getElementById('__siem_tree_styles__')) return;
    const st = document.createElement('style');
    st.id = '__siem_tree_styles__';
    st.textContent = `
      #__siem_tree_btn__{
        position:fixed;right:20px;bottom:20px;z-index:2147483646;
        padding:10px 16px;background:#1f6feb;color:#fff;border:none;border-radius:8px;
        font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
        cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);
      }
      #__siem_tree_btn__:hover{background:#388bfd}
      #__siem_tree_badge__{
        display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;
        background:rgba(255,255,255,.25);font-size:12px;font-weight:600;
      }

      #__siem_tree_overlay__{
        position:fixed;inset:0;z-index:2147483647;background:#0d1117;
        display:flex;flex-direction:column;color:#e6edf3;
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      }
      #__siem_tree_overlay__ .hdr{
        display:flex;align-items:center;gap:12px;padding:10px 16px;
        border-bottom:1px solid #21262d;background:#0d1117;flex:0 0 auto;
      }
      #__siem_tree_overlay__ .hdr h2{margin:0;font-size:15px;font-weight:600}
      #__siem_tree_overlay__ .hdr .cnt{color:#8b949e;font-size:12px}
      #__siem_tree_overlay__ .hdr .cnt b{color:#e6edf3}
      #__siem_tree_overlay__ .hdr .spacer{flex:1}
      #__siem_tree_overlay__ button.act{
        background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;
        padding:6px 12px;font-size:12px;cursor:pointer;
      }
      #__siem_tree_overlay__ button.act:hover{background:#30363d}
      #__siem_tree_overlay__ button.act.active{
        background:#1f6feb;border-color:#388bfd;color:#fff;
      }

      #__siem_tree_viewport__{
        flex:1 1 auto;position:relative;overflow:hidden;cursor:grab;background:#0d1117;
        background-image:radial-gradient(#1b2230 1px,transparent 1px);
        background-size:22px 22px;
      }
      #__siem_tree_viewport__.dragging{cursor:grabbing}

      #__siem_graph_svg__ path.edge{
        fill:none;stroke:#4b5563;stroke-width:1.6;
      }
      #__siem_graph_svg__ path.edge.phantom{
        stroke-dasharray:4 4;stroke:#6e7681;
      }
      #__siem_graph_svg__ path.edge.group{
        stroke:#d29922;stroke-dasharray:3 3;
      }

      /* ---- УЗЛЫ: чуть ярче фон + заметнее обводка ---- */
      #__siem_graph_svg__ g.node rect{
        fill:#1c2333;stroke:#4b5563;stroke-width:1.6;
      }
      #__siem_graph_svg__ g.node:hover rect{
        stroke:#79c0ff;stroke-width:2;
      }
      #__siem_graph_svg__ g.node.phantom rect{
        fill:#171b22;stroke:#6e7681;stroke-dasharray:5 3;
      }
      #__siem_graph_svg__ g.node.exited rect{
        stroke:#f85149;stroke-width:1.8;
      }
      #__siem_graph_svg__ g.node.exited:hover rect{
        stroke:#ff7b72;stroke-width:2;
      }
      #__siem_graph_svg__ g.node.group rect{
        fill:#262010;stroke:#d29922;stroke-width:1.8;
      }
      #__siem_graph_svg__ g.node.group:hover rect{
        stroke:#f0c674;stroke-width:2;
      }
      #__siem_graph_svg__ g.node.collapse rect{
        fill:#132232;stroke:#58a6ff;stroke-width:1.8;
      }
      #__siem_graph_svg__ g.node.collapse:hover rect{
        stroke:#79c0ff;stroke-width:2;
      }
      #__siem_graph_svg__ g.node text{
        fill:#e6edf3;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      }
      #__siem_graph_svg__ g.node text.name{font-size:12.5px;font-weight:600}
      #__siem_graph_svg__ g.node text.sub{
        fill:#8b949e;font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      }
      #__siem_graph_svg__ g.node.group text.name{fill:#f0c674}
      #__siem_graph_svg__ g.node.collapse text.name{fill:#79c0ff}
      #__siem_graph_svg__ g.node circle.exit-dot{
        fill:#f85149;stroke:#0d1117;stroke-width:2;
      }

      #__siem_tree_orphans__{
        flex:0 0 auto;max-height:190px;overflow:auto;
        border-top:1px solid #21262d;background:#0b0f14;padding:10px 16px;
      }
      #__siem_tree_orphans__ .orp-title{
        font-size:12px;font-weight:700;color:#f0883e;margin-bottom:8px;
        text-transform:uppercase;letter-spacing:.4px;
      }
      #__siem_tree_orphans__ .orp-empty{color:#8b949e;font-size:12px}
      #__siem_tree_orphans__ .orp-list{display:flex;flex-wrap:wrap;gap:8px}
      #__siem_tree_orphans__ .orp-chip{
        display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;
        background:#1c2333;border:1px solid #4b5563;font-size:11.5px;color:#c9d1d9;
      }
      #__siem_tree_orphans__ .orp-chip.exited{border-color:#7d3530}
      #__siem_tree_orphans__ .orp-chip b{color:#e6edf3;font-weight:600}
      #__siem_tree_orphans__ .orp-chip span{color:#8b949e}
      #__siem_tree_orphans__ .orp-chip .exit-flag{color:#f85149;font-weight:600}

      #__siem_tree_tooltip__{
        position:fixed;display:none;z-index:2147483647;pointer-events:none;
        max-width:460px;padding:10px 12px;border-radius:8px;
        background:rgba(22,27,34,.98);border:1px solid #30363d;
        box-shadow:0 8px 24px rgba(0,0,0,.5);
        font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e6edf3;
      }
      #__siem_tree_tooltip__ .tt-title{
        font-weight:700;font-size:13px;margin-bottom:6px;color:#58a6ff;
        word-break:break-all;
      }
      #__siem_tree_tooltip__ .tt-title i{color:#8b949e;font-weight:400;font-size:11px}
      #__siem_tree_tooltip__ table{border-collapse:collapse;width:100%}
      #__siem_tree_tooltip__ td{
        vertical-align:top;padding:2px 0;word-break:break-all;
      }
      #__siem_tree_tooltip__ td:first-child{
        color:#8b949e;padding-right:12px;white-space:nowrap;width:1%;
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }
})();