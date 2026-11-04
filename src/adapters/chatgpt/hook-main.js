/**
 * Main-world hook installed at document_start (manifest world: "MAIN").
 *
 * Also copies entity side-panel streams (/backend-api/sidebar/conversation)
 * to the content script -- see tapSidebar below.
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

  // Entity side panels (see chatgpt/sidebar.js): the panel is a hidden
  // conversation streamed by POST /backend-api/sidebar/conversation and is
  // not stored with the chat, so the only copy the export can get is the
  // one the page received. Copy the request body (no token in it) and the
  // streamed reply as the page reads it (tapSidebar).
  const SIDEBAR_RE = /\/backend-api\/sidebar\/conversation(?:\?|$)/;
  const sendSidebar = (url, request, stream) => {
    try {
      document.dispatchEvent(
        new CustomEvent('exporter:chatgpt-sidebar', { detail: JSON.stringify({ url, request, stream }) })
      );
    } catch (e) {
      /* noop */
    }
  };
  /**
   * Before the request goes out: if it is a panel request, return its
   * absolute URL and start reading its body -- from `init.body`, or from a
   * clone of a Request object (the page passes `new Request(url, {body})`;
   * once sent, its body is used up and can't be cloned any more).
   * Returns { url, body: Promise<string> } or null.
   */
  const sidebarRequest = (input, init) => {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      url = new URL(url, location.href).href;
    } catch (e) {
      return null;
    }
    if (!SIDEBAR_RE.test(url)) return null;
    const body = init && init.body != null ? init.body : null;
    if (typeof body === 'string') return { url, body: Promise.resolve(body) };
    if (body != null) {
      // Blob / ArrayBuffer / typed array: readable without consuming it.
      return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
        ? null
        : { url, body: new Response(body).text() };
    }
    if (input && typeof input === 'object' && typeof input.clone === 'function' && !input.bodyUsed) {
      return { url, body: input.clone().text() };
    }
    return null;
  };
  /**
   * The page's response to a panel request, its body passed through a tap:
   * every chunk the page reads goes through here first, so the copy has
   * all the page got. A clone read alongside isn't enough -- the page
   * aborts the request as soon as it reads `[DONE]`, before the server
   * closes it, and the abort errors every copy of the body, dropping the
   * chunks a clone hadn't read yet. The copy is sent once the body ends,
   * errors (that abort) or is cancelled. The page gets the same status,
   * headers, url and bytes; anything unexpected and it gets its own
   * response untouched.
   */
  const tapSidebar = (req, res) => {
    try {
      if (!res || !res.ok || !res.body || typeof TransformStream !== 'function') return res;
      const decoder = new TextDecoder();
      let text = '';
      const tap = new TransformStream({
        transform(chunk, controller) {
          try {
            text += decoder.decode(chunk, { stream: true });
          } catch (e) {
            /* not bytes: the page still gets it */
          }
          controller.enqueue(chunk);
        },
      });
      const tapped = new Response(tap.readable, { status: res.status, statusText: res.statusText, headers: res.headers });
      for (const k of ['url', 'redirected', 'type']) Object.defineProperty(tapped, k, { value: res[k] });
      let sent = false;
      const finish = () => {
        if (sent) return;
        sent = true;
        text += decoder.decode();
        req.body.then(
          (request) => {
            if (typeof request === 'string' && text) sendSidebar(req.url, request, text);
          },
          () => {}
        );
      };
      // Last: once piping starts, the page can only read through the tap.
      res.body.pipeTo(tap.writable).then(finish, finish);
      return tapped;
    } catch (e) {
      return res;
    }
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
      let sidebarReq = null;
      try {
        sidebarReq = sidebarRequest(input, init);
        if (sidebarReq) sidebarReq.body.catch(() => {});
      } catch (e) {
        sidebarReq = null;
      }
      const pending = origFetch.apply(this, arguments);
      return sidebarReq ? pending.then((res) => tapSidebar(sidebarReq, res)) : pending;
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
