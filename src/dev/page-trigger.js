/**
 * Page-triggered exports (dev tooling, see dev-common.js). With the
 * "Allow exports triggered from the page" dev option on, a script on the
 * chat page -- Claude in Chrome, Playwright -- can export without the
 * popup:
 *
 *   window.dispatchEvent(new CustomEvent('llm-exporter:export',
 *     { detail: JSON.stringify({ mode: 'zip', debugCapture: true }) }));
 *
 * The result comes back as an `llm-exporter:export-result` event (detail:
 * JSON string) and in `document.documentElement.dataset.llmExporterResult`.
 * detail is a JSON string because objects don't cross from the page's JS
 * world into the content script's.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const PAGE_EVENT = 'llm-exporter:export';
  const PAGE_RESULT_EVENT = 'llm-exporter:export-result';

  if (typeof self.addEventListener !== 'function') return;

  const reply = (result) => {
    const json = JSON.stringify(result);
    try {
      document.documentElement.dataset.llmExporterResult = json;
    } catch (_) { /* no documentElement */ }
    self.dispatchEvent(new CustomEvent(PAGE_RESULT_EVENT, { detail: json }));
  };

  self.addEventListener(PAGE_EVENT, async (event) => {
    const settings = ns.dev && ns.dev.readSettings ? await ns.dev.readSettings() : {};
    if (!settings.pageTrigger) {
      reply({ ok: false, error: 'Page-triggered exports are disabled (LLM Chat Exporter options → Developer).' });
      return;
    }
    let msg;
    try {
      msg = typeof event.detail === 'string' && event.detail ? JSON.parse(event.detail) : {};
    } catch (_) {
      reply({ ok: false, error: 'event detail must be a JSON string' });
      return;
    }
    reply(await ns.exportEntry.run(msg));
  });
})();
