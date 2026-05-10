/**
 * Isolated-world half of the gemini token hook. Loaded at document_start
 * (same time as hook-main.js's main-world counterpart) so the CustomEvent
 * listener is in place before the SPA fires its first batchexecute request.
 *
 * Caches captured tokens on self.__exporterGemini.at; api.js reads from
 * the same isolated-world namespace at export time.
 *
 * Note: Gemini rotates the `at` value periodically (each batchexecute call
 * carries a fresh one). We always overwrite so the cached value is the most
 * recent one we've seen.
 */
(function () {
  document.addEventListener('exporter:gemini-at', (ev) => {
    const tok = ev && ev.detail;
    if (typeof tok === 'string' && tok) {
      const store = (self.__exporterGemini = self.__exporterGemini || {});
      store.at = tok;
    }
  });
})();
