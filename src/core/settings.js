/**
 * Read/write user settings via chrome.storage.sync.
 * Used by popup and options pages (NOT by content scripts).
 *
 * Schema:
 *   {
 *     global: { mode: 'md'|'zip', includeReasoning: boolean },
 *     perAdapter: { claude: {}, chatgpt: {} }
 *   }
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const DEFAULTS = {
    global: {
      mode: 'md',
      includeReasoning: false,
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
