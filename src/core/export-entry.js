/**
 * Export entry points shared by all adapters' content.js.
 *
 *   ns.exportEntry.register(adapterId, handleExport)
 *
 * wires `handleExport(options)` to:
 *   1. chrome.runtime.onMessage `{kind:'export', ...}` -- the popup.
 *   2. A page event, only when the user enabled "Allow exports triggered
 *      from the page" in options. Lets browser automation (Claude in
 *      Chrome, Playwright) export without clicking the extension popup:
 *
 *        window.dispatchEvent(new CustomEvent('llm-exporter:export',
 *          { detail: JSON.stringify({ mode: 'zip', debugCapture: true }) }));
 *
 *      The result comes back as an `llm-exporter:export-result` event
 *      (detail: JSON string) and in
 *      `document.documentElement.dataset.llmExporterResult`.
 *      detail is a JSON string because objects do not cross from the page's
 *      JS world into the content script's.
 *
 * Both paths go through ns.debugCapture, which saves a HAR of the export's
 * requests when "Save debug data" is on (or the caller asks for it).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;

  const PAGE_EVENT = 'llm-exporter:export';
  const PAGE_RESULT_EVENT = 'llm-exporter:export-result';

  /** Normalize a message/event payload into handleExport options. */
  const toOptions = (msg) => ({
    mode: msg.mode === 'zip' ? 'zip' : 'md',
    includeReasoning: !!msg.includeReasoning,
    includeDates: !!msg.includeDates,
    dateFormat: msg.dateFormat || 'locale',
    // Default to true so an older popup (or a programmatic caller that
    // forgets the field) still inlines images, matching the new default.
    inlineImages: msg.inlineImages !== false,
    inlineTextFiles: !!msg.inlineTextFiles,
    attachmentsAsMarkdown: !!msg.attachmentsAsMarkdown,
  });

  /** Global settings straight from storage (settings.js is not loaded in
   *  content scripts). Empty object when unavailable. */
  const readGlobalSettings = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.sync.get('settings', (got) => {
          resolve((got && got.settings && got.settings.global) || {});
        });
      } catch (_) {
        resolve({});
      }
    });

  const register = (adapterId, handleExport) => {
    const run = async (msg) => {
      const options = toOptions(msg);
      const enabled = typeof msg.debugCapture === 'boolean'
        ? msg.debugCapture
        : !!(await readGlobalSettings()).debugCapture;
      try {
        return await ns.debugCapture.run({ enabled, adapter: adapterId, options },
          () => handleExport(options));
      } catch (err) {
        log.error(`${adapterId} export failed`, err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.kind !== 'export') return false;
      run(msg).then(sendResponse);
      return true; // async response
    });

    if (typeof self.addEventListener !== 'function') return;
    self.addEventListener(PAGE_EVENT, async (event) => {
      const reply = (result) => {
        const json = JSON.stringify(result);
        try {
          document.documentElement.dataset.llmExporterResult = json;
        } catch (_) { /* no documentElement */ }
        self.dispatchEvent(new CustomEvent(PAGE_RESULT_EVENT, { detail: json }));
      };
      const settings = await readGlobalSettings();
      if (!settings.pageTrigger) {
        reply({ ok: false, error: 'Page-triggered exports are disabled in LLM Chat Exporter options.' });
        return;
      }
      let msg = {};
      try {
        msg = typeof event.detail === 'string' && event.detail ? JSON.parse(event.detail) : {};
      } catch (_) {
        reply({ ok: false, error: 'event detail must be a JSON string' });
        return;
      }
      reply(await run(msg));
    });
  };

  ns.exportEntry = { register, toOptions };
})();
