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
})();
