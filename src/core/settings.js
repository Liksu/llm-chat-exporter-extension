/**
 * Read/write user settings via chrome.storage.sync.
 * Used by popup and options pages (NOT by content scripts).
 *
 * Schema:
 *   {
 *     global: {
 *       mode: 'md'|'zip',
 *       includeReasoning: boolean,
 *       inlineImages: boolean,
 *       inlineTextFiles: boolean,
 *       attachmentsAsMarkdown: boolean,
 *     },
 *     perAdapter: { claude: {}, chatgpt: {} }
 *   }
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const DEFAULTS = {
    global: {
      mode: 'md',
      includeReasoning: false,
      // ON by default: images are the biggest user-visible delta over a
      // text-only export, so the expected behavior is "include them". Users
      // who want a tiny .md (or who don't want to wait on CDN fetches) can
      // flip this off explicitly.
      inlineImages: true,
      inlineTextFiles: false,
      attachmentsAsMarkdown: false,
    },
    perAdapter: { claude: {}, chatgpt: {} },
  };

  const load = async () => {
    try {
      const got = await chrome.storage.sync.get('settings');
      const s = got.settings || {};
      return {
        global: { ...DEFAULTS.global, ...(s.global || {}) },
        perAdapter: { ...DEFAULTS.perAdapter, ...(s.perAdapter || {}) },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  };

  const save = async (settings) => {
    await chrome.storage.sync.set({ settings });
  };

  ns.settings = { load, save, DEFAULTS };
})();
