/**
 * Export entry point shared by all adapters' content.js.
 *
 *   ns.exportEntry.register(adapterId, handleExport)
 *
 * wires `handleExport(options)` to the popup's chrome.runtime message
 * `{kind:'export', ...}` and normalizes the message into options.
 *
 * Developer tooling (src/dev/, loaded only into unpacked installs -- see
 * dev-loader.js) hooks in through:
 *   - ns.dev.aroundExport(ctx, exec): wraps every export (debug capture);
 *   - ns.exportEntry.run(msg): starts an export the way the popup would
 *     (page-triggered exports).
 * Without src/dev nothing here changes behavior.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;

  /** The chat's address without query/hash (tracking params, UI state). */
  const pageLink = () => {
    try {
      return `${location.origin}${location.pathname}`;
    } catch (_) {
      return '';
    }
  };

  /** Normalize a message payload into handleExport options. */
  const toOptions = (msg) => ({
    mode: msg.mode === 'zip' ? 'zip' : 'md',
    includeReasoning: !!msg.includeReasoning,
    includeDates: !!msg.includeDates,
    // Off unless asked: the popup sends the setting (default on), and
    // callers that predate the option keep their output unchanged.
    link: msg.includeLink ? pageLink() : '',
    dateFormat: msg.dateFormat || 'locale',
    // Default to true so an older popup (or a programmatic caller that
    // forgets the field) still inlines images, matching the new default.
    inlineImages: msg.inlineImages !== false,
    inlineTextFiles: !!msg.inlineTextFiles,
    attachmentsAsMarkdown: !!msg.attachmentsAsMarkdown,
  });

  let registered = null; // { adapterId, handleExport }

  /** Run one export; never throws -- failures come back as {ok:false}. */
  const run = async (msg) => {
    if (!registered) return { ok: false, error: 'No exporter on this page.' };
    const { adapterId, handleExport } = registered;
    const options = toOptions(msg || {});
    const exec = () => handleExport(options);
    try {
      const around = ns.dev && ns.dev.aroundExport;
      return await (around ? around({ adapter: adapterId, options, msg: msg || {} }, exec) : exec());
    } catch (err) {
      log.error(`${adapterId} export failed`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const register = (adapterId, handleExport) => {
    registered = { adapterId, handleExport };
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.kind !== 'export') return false;
      run(msg).then(sendResponse);
      return true; // async response
    });
  };

  ns.exportEntry = { register, run, toOptions };
})();
