/**
 * Main-world hook installed at document_start (manifest world: "MAIN").
 *
 * Wraps window.fetch + XMLHttpRequest.prototype.setRequestHeader so that every
 * Authorization: Bearer ... header the chatgpt.com SPA sends gets reflected
 * into the isolated content-script via a CustomEvent on document. Running in
 * MAIN world (rather than a script-tag injection from the isolated world) is
 * what lets this work even under strict CSP — chatgpt.com sets nonces on
 * inline scripts, which would otherwise block injection.
 */
(function () {
  if (window.__exporterChatgptHookInstalled) return;
  window.__exporterChatgptHookInstalled = true;

  const send = (token) => {
    try {
      document.dispatchEvent(new CustomEvent('exporter:chatgpt-token', { detail: token }));
    } catch (e) {
      /* noop */
    }
  };

  const extractAuth = (headers) => {
    if (!headers) return null;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get('Authorization') || headers.get('authorization');
      }
      if (Array.isArray(headers)) {
        for (const h of headers) {
          if (Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' &&
              h[0].toLowerCase() === 'authorization') {
            return h[1];
          }
        }
        return null;
      }
      if (typeof headers === 'object') {
        return headers.Authorization || headers.authorization || null;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let auth = null;
        if (init && init.headers) auth = extractAuth(init.headers);
        if (!auth && input && typeof input === 'object' && input.headers) {
          auth = extractAuth(input.headers);
        }
        if (typeof auth === 'string' && auth.indexOf('Bearer ') === 0) {
          send(auth.slice(7));
        }
      } catch (e) {
        /* ignore */
      }
      return origFetch.apply(this, arguments);
    };
  }

  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, val) {
    try {
      if (typeof name === 'string' && name.toLowerCase() === 'authorization' &&
          typeof val === 'string' && val.indexOf('Bearer ') === 0) {
        send(val.slice(7));
      }
    } catch (e) {
      /* ignore */
    }
    return origSet.apply(this, arguments);
  };
})();
