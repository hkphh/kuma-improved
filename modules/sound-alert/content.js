/**
 * Модуль "Звуковое оповещение".
 *
 * KUMA сообщает о новых алертах через Server-Sent Events:
 *   GET /api/private/notifications/feed   (text/event-stream)
 *   event: notification
 *   data: {"kind":"alert","payload":{"name":"..."}}
 *
 * Поток держит только одна вкладка (лидер, выбранный через BroadcastChannel),
 * а остальные вкладки его не получают. Поэтому модуль открывает СВОЁ
 * соединение EventSource в MAIN-мире страницы (inject.js) с теми же куками
 * и слушает только события kind === "alert". При выключении модуля
 * соединение закрывается.
 *
 * На каждое такое событие проигрывается сигнал alert.mp3 из папки модуля.
 * Никакого UI на странице нет: звук включается и выключается только через
 * меню расширения (модуль "Звуковое оповещение"). AudioContext создаётся
 * только по жесту пользователя — иначе Chrome блокирует автозапуск звука.
 */
(function () {
  'use strict';

  if (window.__kumaSoundAlertLoaded) return;
  window.__kumaSoundAlertLoaded = true;

  const MODULE_ID = 'sound-alert';
  const CHANNEL_EVENT = '__kuma_sound_alert_sse__';
  const CHANNEL_CONFIG = '__kuma_sound_alert_config__';
  const DEFAULT_SETTINGS = {
    feedPath: '/api/private/notifications/feed',
    volume: 70
  };
  const REPEAT_WINDOW_MS = 1500;
  const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

  let settings = { ...DEFAULT_SETTINGS };
  let active = false;

  let lastEventAt = 0;
  let seenAlerts = new Map(); // id (или имя) → когда впервые увидели

  let audioCtx = null;
  let audioOut = null;
  let alertBuffer = null;
  let alertBufferPromise = null;
  let alertBytes = null;
  let alertBytesPromise = null;
  let alertBytesError = null;
  let activeSource = null;
  let pageActivated = false;

  let storageListener = null;

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
      if (!active) start();
      return;
    }

    const mod = runtime.modules && runtime.modules[MODULE_ID];
    const allowed = runtime.enabled !== false && mod && mod.enabled && targetAllowed(runtime);

    if (!allowed) {
      stop();
      return;
    }

    settings = Object.assign({}, DEFAULT_SETTINGS, mod.settings || {});

    if (!active) start();
    else pushConfig();
  }

  function start() {
    active = true;
    listenPageActivity();
    listenStorage();
    listenFeedEvents();
    pushConfig();
    injectHook();
  }

  function stop() {
    active = false;
    stopBeep();
    removeStorageListener();
    seenAlerts.clear();
    // Перехватчик остаётся в странице, но закрывает соединение по флагу.
    pushConfig();
  }

  function hasDom() {
    return typeof document !== 'undefined' && Boolean(document.documentElement);
  }

  /** В service worker DOM нет — модуль работает только во вкладках KUMA. */
  if (!hasDom()) return;

  /* ==================== Инжект перехватчика ==================== */

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
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('modules/sound-alert/inject.js');
      script.onload = function () { this.remove(); };
      script.onerror = function () {
        this.remove();
        if (hookAttempts++ < 20) setTimeout(injectHook, 250);
      };
      parent.appendChild(script);
      hookInjected = true;
    } catch (e) {
      console.warn('[KUMA Sound] inject failed', e);
      if (hookAttempts++ < 20) setTimeout(injectHook, 250);
    }
  }

  function feedUrl() {
    let path = String(settings.feedPath || DEFAULT_SETTINGS.feedPath).trim();
    if (!path) path = DEFAULT_SETTINGS.feedPath;
    if (!path.startsWith('/')) path = '/' + path;
    try {
      return new URL(path, location.origin).href;
    } catch (e) {
      return path;
    }
  }

  function pushConfig() {
    try {
      const payload = {
        enabled: Boolean(active),
        feedUrl: feedUrl()
      };
      window.dispatchEvent(new CustomEvent(CHANNEL_CONFIG, {
        detail: JSON.stringify(payload)
      }));
    } catch (e) {}
  }

  /* ==================== События из MAIN-мира ==================== */

  function listenFeedEvents() {
    window.addEventListener(CHANNEL_EVENT, function (event) {
      let payload;
      try { payload = JSON.parse(event.detail); } catch (e) { return; }
      if (!payload || typeof payload !== 'object') return;

      // Служебные сообщения потока (подключение/обрыв) модулю не нужны.
      if (!payload.kind) return;
      if (!active || payload.kind !== 'alert') return;

      const id = String((payload.payload && payload.payload.id) || '');
      const name = (payload.payload && payload.payload.name) || '';
      const now = Date.now();

      // Один и тот же алерт не должен звучать дважды — например, после
      // переподключения потока или при дублях в моментальном снимке.
      // Алерты с известным id помним сутки; без id сверяемся по имени.
      const key = id || name;
      if (key && seenAlerts.has(key)) return;
      if (key) {
        seenAlerts.set(key, now);
        pruneSeen(now);
      } else if (now - lastEventAt < REPEAT_WINDOW_MS) {
        return;
      }
      lastEventAt = now;

      playAlertSound();
    });
  }

  function pruneSeen(now) {
    if (seenAlerts.size < 500) return;
    for (const entry of seenAlerts) {
      if (now - entry[1] > SEEN_TTL_MS) seenAlerts.delete(entry[0]);
    }
  }

  /* ==================== Звук ==================== */

  function alertSoundUrl() {
    try {
      return chrome.runtime.getURL('modules/sound-alert/alert.mp3');
    } catch (e) {
      return null;
    }
  }

  /** Байты mp3 можно скачать и без жеста — жест нужен только для звука. */
  function loadAlertBytes() {
    if (alertBytes) return Promise.resolve(alertBytes);
    if (alertBytesError) return Promise.reject(alertBytesError);
    if (alertBytesPromise) return alertBytesPromise;

    const url = alertSoundUrl();
    if (!url) return Promise.reject(new Error('mp3 недоступен'));

    alertBytesPromise = fetch(url, { cache: 'force-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.arrayBuffer();
      })
      .then(function (bytes) {
        alertBytes = bytes;
        alertBytesPromise = null;
        return bytes;
      })
      .catch(function (error) {
        alertBytesPromise = null;
        alertBytesError = error;
        console.warn('[KUMA Sound] не удалось загрузить alert.mp3:', error);
        throw error;
      });

    return alertBytesPromise;
  }

  function loadAlertBuffer(ctx) {
    if (alertBuffer) return Promise.resolve(alertBuffer);
    if (alertBufferPromise) return alertBufferPromise;
    if (!ctx) return Promise.reject(new Error('AudioContext недоступен'));

    alertBufferPromise = loadAlertBytes()
      .then(function (bytes) {
        return new Promise(function (resolve, reject) {
          let settled = false;
          const done = function (buffer) {
            if (settled) return;
            settled = true;
            resolve(buffer);
          };
          const fail = function (error) {
            if (settled) return;
            settled = true;
            reject(error || new Error('decodeAudioData failed'));
          };
          const promise = ctx.decodeAudioData(bytes, done, fail);
          if (promise && typeof promise.then === 'function') promise.then(done, fail);
        });
      })
      .then(function (buffer) {
        alertBuffer = buffer;
        alertBufferPromise = null;
        return buffer;
      })
      .catch(function (error) {
        alertBufferPromise = null;
        console.warn('[KUMA Sound] не удалось декодировать alert.mp3:', error);
        throw error;
      });

    return alertBufferPromise;
  }

  /**
   * AudioContext создаётся только здесь и только по жесту пользователя.
   * Создание при загрузке страницы Chrome блокирует с сообщением
   * "The AudioContext was not allowed to start".
   */
  function unlockFromGesture() {
    if (!active) return;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;

    if (!audioCtx || audioCtx.state === 'closed' || !audioOut) {
      try {
        audioCtx = new Ctor();
        audioOut = audioCtx.createGain();
        audioOut.connect(audioCtx.destination);
        alertBuffer = null;
        alertBufferPromise = null;
      } catch (e) {
        audioCtx = null;
        audioOut = null;
        return;
      }
    }

    if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});

    pageActivated = true;
    loadAlertBuffer(audioCtx).catch(function () {});
  }

  function listenPageActivity() {
    // passive: true — слушатели не влияют на скорость прокрутки страницы.
    window.addEventListener('pointerdown', unlockFromGesture, { passive: true, capture: true });
    window.addEventListener('keydown', unlockFromGesture, { passive: true, capture: true });
    window.addEventListener('click', unlockFromGesture, { passive: true, capture: true });
    // Байты файла грузим сразу: сеть не требует жеста.
    loadAlertBytes().catch(function () {});
  }

  function playAlertSound() {
    // Без жеста пользователя контекста нет — молчим и ждём клика.
    if (!active || !audioCtx) return;

    const out = audioOut;
    const ctx = audioCtx;

    restoreOutput();

    const go = ctx.state === 'running'
      ? Promise.resolve(true)
      : Promise.resolve(ctx.resume()).then(function () { return ctx.state === 'running'; });

    go.then(function (ok) {
      if (!ok) return null;
      return loadAlertBuffer(ctx);
    }).then(function (buffer) {
      if (!buffer) return;

      // Повторный сигнал перекрывает предыдущий, а не играет поверх.
      stopActiveSource();
      restoreOutput();

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      source.onended = function () {
        if (activeSource === source) activeSource = null;
        try { source.disconnect(); } catch (e) {}
      };

      activeSource = source;
      source.start(0);
    }).catch(function () {});
  }

  function restoreOutput() {
    if (!audioCtx || !audioOut) return;
    try {
      audioOut.gain.cancelScheduledValues(audioCtx.currentTime);
      audioOut.gain.setValueAtTime(volumeGain(), audioCtx.currentTime);
    } catch (e) {}
  }

  function volumeGain() {
    const volume = Number(settings.volume);
    const normalized = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_SETTINGS.volume));
    return normalized / 100;
  }

  function stopActiveSource() {
    const source = activeSource;
    activeSource = null;
    if (!source) return;
    try { source.onended = null; } catch (e) {}
    try { source.stop(); } catch (e) {}
    try { source.disconnect(); } catch (e) {}
  }

  /**
   * Гасит текущий сигнал. Звук выключается только через меню расширения,
   * поэтому здесь нет никаких кнопок на странице.
   */
  function stopBeep() {
    stopActiveSource();
    if (!audioCtx || !audioOut) return;
    try {
      audioOut.gain.cancelScheduledValues(audioCtx.currentTime);
      audioOut.gain.setValueAtTime(0, audioCtx.currentTime);
    } catch (e) {}
  }

  /* ==================== Подписка на настройки ==================== */

  function listenStorage() {
    if (storageListener) return;
    storageListener = function (changes, areaName) {
      if (areaName !== 'local' || !changes.runtime) return;
      applyRuntime(changes.runtime.newValue);
    };
    try {
      chrome.storage.onChanged.addListener(storageListener);
    } catch (e) {}
  }

  function removeStorageListener() {
    if (!storageListener) return;
    try {
      chrome.storage.onChanged.removeListener(storageListener);
    } catch (e) {}
    storageListener = null;
  }

  /* ==================== Старт ==================== */

  try {
    chrome.storage.local.get('runtime').then(function (data) {
      applyRuntime(data && data.runtime);
    }).catch(function () {
      applyRuntime(null);
    });
  } catch (e) {
    applyRuntime(null);
  }

  window.addEventListener('pagehide', function () {
    stopBeep();
  });
})();
