(function () {
  'use strict';

  /* ---------- Конфигурация от content-скрипта ---------- */

  const DEFAULT_API_PATTERN = '\\/api\\/private\\/events(\\/|\\?|$)';

  let target = new RegExp(DEFAULT_API_PATTERN, 'i');
  let sameOriginOnly = true;
  let enabled = true;

  /* ---------- Храним последний подходящий запрос ---------- */
  let lastRequest = null;

  function patternToRegex(pattern) {
    if (!pattern) return new RegExp(DEFAULT_API_PATTERN, 'i');
    try {
      return new RegExp(String(pattern), 'i');
    } catch (error) {
      // Если пользователь ввёл не regex, а простую строку — ищем её как подстроку.
      const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        return new RegExp(escaped, 'i');
      } catch (e) {
        return new RegExp(DEFAULT_API_PATTERN, 'i');
      }
    }
  }

  window.addEventListener('__siem_traffic_config__', function (ev) {
    let cfg;
    try { cfg = JSON.parse(ev.detail); } catch (e) { return; }

    if (cfg && typeof cfg.apiPathPattern === 'string') {
      target = patternToRegex(cfg.apiPathPattern);
    }
    if (cfg && typeof cfg.sameOriginOnly === 'boolean') {
      sameOriginOnly = cfg.sameOriginOnly;
    }
    if (cfg && typeof cfg.enabled === 'boolean') {
      enabled = cfg.enabled;
      if (!enabled) lastRequest = null;
    }
  });

  function absoluteUrl(url) {
    try { return new URL(String(url), location.href).href; } catch (e) { return String(url); }
  }

  function isSameOrigin(url) {
    try {
      return new URL(String(url), location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function isTarget(url) {
    if (!enabled) return false;
    if (!url) return false;
    const value = String(url);
    if (!target.test(value)) return false;
    if (sameOriginOnly && !isSameOrigin(value)) return false;
    return true;
  }

  /* ---------- Заголовки, которые браузер запрещает устанавливать вручную ---------- */

  const FORBIDDEN_HEADERS = new Set([
    'accept-charset', 'accept-encoding',
    'access-control-request-headers', 'access-control-request-method',
    'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt',
    'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'via'
  ]);

  function isForbiddenHeader(name) {
    if (!name) return true;
    const n = String(name).toLowerCase();
    if (FORBIDDEN_HEADERS.has(n)) return true;
    if (n.indexOf('proxy-') === 0) return true;
    if (n.indexOf('sec-') === 0) return true;
    return false;
  }

  function sanitizeHeaders(h) {
    const out = {};
    if (!h) return out;
    for (const k in h) {
      if (!isForbiddenHeader(k)) out[k] = h[k];
    }
    return out;
  }

  function emit(url, data) {
    try {
      window.dispatchEvent(new CustomEvent('__siem_events__', {
        detail: JSON.stringify({ url: String(url), data: data })
      }));
    } catch (e) {
      console.warn('[SIEM Tree] emit failed', e);
    }
  }

  /* ---------- Храним последний подходящий запрос ---------- */
  function remember(url, method, headers, body) {
    lastRequest = {
      url: absoluteUrl(url),
      method: (method || 'GET').toUpperCase(),
      headers: sanitizeHeaders(headers),
      body: (body === undefined ? null : body)
    };
  }

  /* ---------- Повтор запроса по требованию content-script ---------- */
  window.addEventListener('__siem_tree_refetch__', function () {
    function done() {
      window.dispatchEvent(new CustomEvent('__siem_events__', {
        detail: JSON.stringify({
          url: lastRequest ? lastRequest.url : '',
          data: [],
          __refetchDone: true
        })
      }));
    }

    if (!enabled || !lastRequest) { done(); return; }

    const opts = {
      method: lastRequest.method,
      headers: sanitizeHeaders(lastRequest.headers),
      credentials: 'include' // куки уйдут автоматически, как в оригинале
    };
    if (lastRequest.body != null &&
        lastRequest.method !== 'GET' &&
        lastRequest.method !== 'HEAD') {
      opts.body = lastRequest.body;
    }

    fetch(lastRequest.url, opts)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        emit(lastRequest.url, data);
        done();
      })
      .catch(function (e) {
        console.warn('[SIEM Tree] refetch failed', e);
        done();
      });
  });

  /* -------------------- XMLHttpRequest -------------------- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__siemUrl = url;
      this.__siemMethod = method;
      this.__siemHeaders = {};
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      // Браузер откажет в установке forbidden-заголовков (Cookie, Host, Origin и т.п.),
      // поэтому мы их молча игнорируем — иначе исключение летит в консоль.
      if (isForbiddenHeader(name)) return;

      try { this.__siemHeaders[name] = value; } catch (e) {}
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      const self = this;
      try {
        if (isTarget(self.__siemUrl)) {
          remember(self.__siemUrl, self.__siemMethod, self.__siemHeaders, body);
        }
      } catch (e) {}

      this.addEventListener('load', function () {
        try {
          const url = self.__siemUrl || self.responseURL || '';
          if (!isTarget(url)) return;
          let data = null;
          const rt = self.responseType;
          if (rt === '' || rt === 'text') {
            const txt = self.responseText;
            if (txt) data = JSON.parse(txt);
          } else if (rt === 'json') {
            data = self.response;
          }
          if (data) emit(absoluteUrl(url), data);
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  /* -------------------- fetch -------------------- */
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isTarget(url)) {
          const method = (init && init.method) || (input && input.method) || 'GET';
          const raw = {};
          const h = (init && init.headers) || (input && input.headers);
          if (h) {
            if (typeof h.forEach === 'function') {
              h.forEach(function (v, k) { raw[k] = v; });
            } else if (Array.isArray(h)) {
              h.forEach(function (p) { raw[p[0]] = p[1]; });
            } else {
              for (const k in h) raw[k] = h[k];
            }
          }
          const body = init && init.body;
          remember(url, method, raw, body);
        }
      } catch (e) {}

      return origFetch.apply(this, arguments).then(function (resp) {
        try {
          const url = resp.url ||
            (typeof input === 'string' ? input : (input && input.url)) || '';
          if (isTarget(url)) {
            resp.clone().json().then(function (data) {
              emit(absoluteUrl(url), data);
            }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  }

  /* ---------- Сообщаем content-скрипту, что хуки установлены ---------- */
  try {
    window.dispatchEvent(new Event('__siem_traffic_ready__'));
  } catch (e) {}
})();
