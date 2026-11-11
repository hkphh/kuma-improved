/**
 * Поток уведомлений KUMA (MAIN-мир страницы).
 *
 * Файл вставляется content-скриптом через <script src=chrome-extension://…>,
 * т.е. работает в контексте страницы и уходит в KUMA с её куками.
 *
 * KUMA сообщает о новых алертах через SSE:
 *   GET /api/private/notifications/feed   (text/event-stream)
 *   event: notification
 *   data: {"kind":"alert","payload":{"id":"...","name":"..."}, ...}
 *
 * Веб-интерфейс держит такой поток только в одной вкладке-лидере, поэтому
 * модуль открывает собственное соединение EventSource к тому же адресу.
 * Запросы страницы при этом не перехватываются и не изменяются.
 *
 * ── Одно соединение на браузер ────────────────────────────────────────────
 * Лидер выбирается через BroadcastChannel (как это делает сама KUMA):
 * каждая вкладка объявляет себя, и соединение открывает только вкладка
 * с наименьшим идентификатором. Остальные вкладки EventSource не открывают.
 * Закрыл лидер вкладку — остальные перевыбирают лидера и поднимают поток.
 *
 * Обмен с content-скриптом — через CustomEvent, detail всегда строка JSON.
 */
(function () {
  'use strict';

  if (window.__kumaSoundAlertHooked) return;
  window.__kumaSoundAlertHooked = true;

  const CHANNEL_EVENT = '__kuma_sound_alert_sse__';
  const CHANNEL_CONFIG = '__kuma_sound_alert_config__';
  const CHANNEL_NAME = '__kuma_sound_alert_leader__';
  const DEFAULT_FEED_PATH = '/api/private/notifications/feed';
  const ALERT_KIND = 'alert';
  // В поток уведомлений подключаемся только к своему origin: чужой адрес
  // в настройках не должен отправлять куки KUMA третьей стороне.
  const ALLOWED_FEED_ORIGIN = location.origin;
  const ELECTION_DELAY_MS = 200;
  const TAB_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  let enabled = true;
  let feedUrl = DEFAULT_FEED_PATH;
  let feedKey = '';

  let source = null;
  let retryTimer = null;
  let retryDelay = 2000;
  let closed = false;

  let channel = null;
  let isLeader = false;
  let electionTimer = null;
  let electionEnded = false;

  function post(payload) {
    try {
      window.dispatchEvent(new CustomEvent(CHANNEL_EVENT, {
        detail: JSON.stringify(payload)
      }));
    } catch (e) {}
  }

  /* ==================== Выборы вкладки-лидера ==================== */

  function setupChannel() {
    if (channel) return;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch (e) {
      // Нет BroadcastChannel — работаем как одиночная вкладка.
      channel = null;
      becomeLeader();
      return;
    }

    channel.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (!data.tabId || data.tabId === TAB_ID) return;
      if (data.feedKey && data.feedKey !== feedKey) return;

      if (data.type === 'hello') {
        // Кто-то ещё хочет поток. Лидером остаётся вкладка с меньшим id.
        if (electionTimer && data.tabId < TAB_ID) {
          clearTimeout(electionTimer);
          electionTimer = null;
          electionEnded = true;
          stepDown();
        } else if (isLeader) {
          channel.postMessage({ type: 'hey', tabId: TAB_ID, feedKey: feedKey });
        }
      } else if (data.type === 'hey') {
        // Поток уже ведёт другая вкладка — подключаться не нужно.
        if (electionTimer) {
          clearTimeout(electionTimer);
          electionTimer = null;
        }
        electionEnded = true;
        stepDown();
      } else if (data.type === 'bye') {
        // Лидер закрывается — перевыбираем.
        restartElection();
      }
    });

    window.addEventListener('pagehide', function () {
      try {
        if (isLeader) channel.postMessage({ type: 'bye', tabId: TAB_ID, feedKey: feedKey });
        channel.close();
      } catch (e) {}
      channel = null;
    });
  }

  /**
   * Небольшая задержка перед подключением: если открыта ещё одна вкладка
   * KUMA, за это время придёт её hello и мы уступим поток ей.
   */
  function startElection() {
    electionEnded = false;
    if (electionTimer) clearTimeout(electionTimer);

    try {
      if (channel) channel.postMessage({ type: 'hello', tabId: TAB_ID });
    } catch (e) {}

    electionTimer = setTimeout(function () {
      electionTimer = null;
      if (electionEnded) return;
      electionEnded = true;
      becomeLeader();
    }, ELECTION_DELAY_MS);
  }

  function restartElection() {
    disconnect();
    isLeader = false;
    startElection();
  }

  function becomeLeader() {
    if (isLeader) return;
    isLeader = true;
    try {
      if (channel) channel.postMessage({ type: 'hey', tabId: TAB_ID, feedKey: feedKey });
    } catch (e) {}
    connect();
  }

  function stepDown() {
    if (!isLeader) return;
    isLeader = false;
    disconnect();
  }

  /* ==================== Соединение SSE ==================== */

  function connect() {
    if (!enabled || !isLeader) return;
    disconnect();

    let es;
    try {
      es = new EventSource(feedUrl);
    } catch (e) {
      scheduleRetry();
      return;
    }

    source = es;

    es.addEventListener('connected', function () {
      retryDelay = 2000;
    });

    es.addEventListener('notification', function (event) {
      let message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      if (!message || typeof message !== 'object') return;
      if (message.kind !== ALERT_KIND) return;

      post({
        kind: message.kind,
        payload: message.payload || {},
        tenantIDs: message.tenantIDs || null,
        ownerID: message.ownerID || null,
        at: Date.now()
      });
    });

    es.onopen = function () {
      retryDelay = 2000;
    };

    es.onerror = function () {
      // EventSource сам переподключается, но при закрытом соединении
      // (readyState === CLOSED) браузер сдаётся — поднимаем вручную.
      if (es.readyState === 2) {
        disconnect();
        scheduleRetry();
      }
    };
  }

  function disconnect() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (!source) return;
    try { source.close(); } catch (e) {}
    source = null;
  }

  function scheduleRetry() {
    if (!enabled || closed || !isLeader || retryTimer) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, 60000);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!enabled || !isLeader) return;
      connect();
    }, delay);
  }

  /* ==================== Настройки ==================== */

  window.addEventListener(CHANNEL_CONFIG, function (event) {
    let cfg;
    try { cfg = JSON.parse(event.detail); } catch (e) { return; }
    if (!cfg || typeof cfg !== 'object') return;

    const nextEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : enabled;
    const candidate = typeof cfg.feedUrl === 'string' && cfg.feedUrl
      ? cfg.feedUrl
      : DEFAULT_FEED_PATH;

    // Только тот же origin, иначе поток ушёл бы с куками KUMA на чужой хост.
    let resolved;
    try {
      resolved = new URL(candidate, location.origin);
    } catch (e) {
      resolved = new URL(DEFAULT_FEED_PATH, location.origin);
    }
    if (resolved.origin !== ALLOWED_FEED_ORIGIN) {
      resolved = new URL(DEFAULT_FEED_PATH, location.origin);
    }
    const nextUrl = resolved.href;
    const urlChanged = nextUrl !== feedUrl;

    enabled = nextEnabled;
    feedUrl = nextUrl;

    if (!enabled) {
      disconnect();
      isLeader = false;
      feedKey = '';
      return;
    }

    // Смена адреса: соединение того же URL у соседних вкладок остаётся
    // валидным, поэтому выборы запускаем заново только на новом ключе.
    if (urlChanged) {
      feedKey = nextUrl;
      restartElection();
      return;
    }

    if (!channel) setupChannel();
    if (!isLeader && !electionTimer) startElection();
    else if (isLeader && !source) connect();
  });

  window.addEventListener('pagehide', function () {
    closed = true;
    disconnect();
  });

  window.addEventListener('pageshow', function () {
    if (document.visibilityState !== 'visible' || !enabled) return;
    closed = false;
    if (!isLeader && !electionTimer) startElection();
    else if (isLeader && !source) connect();
  });

  // Если content-скрипт не пришлёт конфиг, поток всё равно поднимется:
  // модуль включён по умолчанию на разрешённых доменах.
  feedKey = new URL(DEFAULT_FEED_PATH, location.origin).href;
  setupChannel();
  startElection();

  try {
    window.dispatchEvent(new Event('__kuma_sound_alert_ready__'));
  } catch (e) {}
})();
