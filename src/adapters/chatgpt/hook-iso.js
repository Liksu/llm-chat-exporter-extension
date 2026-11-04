/**
 * Isolated-world half of the chatgpt token hook. Loaded at document_start
 * (same time as hook-main.js's main-world counterpart) so the CustomEvent
 * listener is in place before the SPA fires its first authenticated request.
 *
 * Caches captured tokens on self.__exporterChatGPT.token; api.js reads from
 * the same isolated-world namespace at export time.
 */
(function () {
  document.addEventListener('exporter:chatgpt-token', (ev) => {
    const tok = ev && ev.detail;
    if (typeof tok === 'string' && tok) {
      const store = (self.__exporterChatGPT = self.__exporterChatGPT || {});
      store.token = tok;
    }
  });

  // Entity side panels opened in this tab ({url, request, stream} strings,
  // see chatgpt/sidebar.js). Kept in memory only, like the page keeps them;
  // a reload forgets them. Capped so a long session can't grow without bound.
  const MAX_SIDEBARS = 200;
  document.addEventListener('exporter:chatgpt-sidebar', (ev) => {
    let cap;
    try {
      cap = JSON.parse(ev && ev.detail);
    } catch (_) {
      return;
    }
    if (!cap || typeof cap.request !== 'string' || typeof cap.stream !== 'string') return;
    const store = (self.__exporterChatGPT = self.__exporterChatGPT || {});
    const list = (store.sidebars = store.sidebars || []);
    list.push({
      url: typeof cap.url === 'string' ? cap.url : '',
      request: cap.request,
      stream: cap.stream,
      capturedAt: new Date().toISOString(),
    });
    if (list.length > MAX_SIDEBARS) list.splice(0, list.length - MAX_SIDEBARS);
  });
})();
