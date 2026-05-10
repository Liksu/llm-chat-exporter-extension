/**
 * Main-world hook installed at document_start (manifest world: "MAIN").
 *
 * Gemini's batchexecute endpoint requires an XSRF-style `at` token that the
 * Bard SPA gets from `window.WIZ_global_data.SNlM0e` and rotates periodically.
 * Each outgoing call carries the latest token in the form-urlencoded body as
 * `at=<value>`. We hook window.fetch + XMLHttpRequest so we can lift it from
 * any outgoing /BardChatUi/data/batchexecute request and forward it to the
 * isolated content-script via a CustomEvent on document. Running in MAIN
 * world (rather than a script-tag injection from the isolated world) is
 * required because Google sets strict CSP nonces that block isolated-world
 * <script> injection.
 *
 * Fallback: also tries to read SNlM0e directly from window.WIZ_global_data
 * or from inline <script> blocks at install time, so we have a token even
 * before the SPA fires its first request.
 */
(function () {
  if (window.__exporterGeminiHookInstalled) return;
  window.__exporterGeminiHookInstalled = true;

  const send = (token) => {
    try {
      document.dispatchEvent(new CustomEvent('exporter:gemini-at', { detail: token }));
    } catch (e) {
      /* noop */
    }
  };

  const isBatchExecute = (urlLike) => {
    try {
      const s = String(urlLike || '');
      return s.indexOf('/_/BardChatUi/data/batchexecute') !== -1;
    } catch (e) {
      return false;
    }
  };

  /**
   * Pull `at=<value>` out of an arbitrary request body. Body can be a string,
   * URLSearchParams, or FormData; anything else (Blob, ArrayBuffer, …) is
   * skipped.
   */
  const extractAt = (body) => {
    if (!body) return null;
    try {
      if (typeof body === 'string') {
        const m = body.match(/(?:^|&)at=([^&]+)/);
        if (!m) return null;
        try {
          return decodeURIComponent(m[1]);
        } catch (e) {
          return m[1];
        }
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.get('at') || null;
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const v = body.get('at');
        return typeof v === 'string' ? v : null;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  };

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let url = '';
        if (typeof input === 'string') {
          url = input;
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
          url = input.url;
        }
        if (isBatchExecute(url)) {
          let body = null;
          if (init && init.body !== undefined && init.body !== null) {
            body = init.body;
          } else if (input && typeof input === 'object' && input.body !== undefined && input.body !== null) {
            body = input.body;
          }
          const tok = extractAt(body);
          if (tok) send(tok);
        }
      } catch (e) {
        /* ignore */
      }
      return origFetch.apply(this, arguments);
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__exporterGeminiUrl = url;
    } catch (e) {
      /* ignore */
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (isBatchExecute(this.__exporterGeminiUrl)) {
        const tok = extractAt(body);
        if (tok) send(tok);
      }
    } catch (e) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };

  // --- SNlM0e fallback (read once after DOM is interactive) ---------------
  const trySNlM0e = () => {
    try {
      if (window.WIZ_global_data && typeof window.WIZ_global_data.SNlM0e === 'string') {
        send(window.WIZ_global_data.SNlM0e);
        return;
      }
      const scripts = document.scripts;
      for (let i = 0; i < scripts.length; i++) {
        const s = scripts[i];
        if (!s.textContent) continue;
        const m = s.textContent.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
        if (m && m[1]) {
          send(m[1]);
          return;
        }
      }
    } catch (e) {
      /* ignore */
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trySNlM0e, { once: true });
  } else {
    trySNlM0e();
  }
})();
