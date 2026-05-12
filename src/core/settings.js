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
 *     // Per-adapter overrides. A key present in perAdapter[id] overrides
 *     // the global value for that adapter; a missing key inherits global.
 *     // Use resolveFor() to merge them before prefilling the popup.
 *     perAdapter: { claude: {}, chatgpt: {}, gemini: {} }
 *   }
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const DEFAULTS = {
    global: {
      mode: 'md',
      includeReasoning: false,
      includeDates: false,
      // How per-message timestamps are rendered when includeDates is on:
      //   'locale'     — toLocaleString in the exporting machine's locale
      //   'iso'        — YYYY-MM-DD HH:MM in local time (sortable, no TZ)
      //   'iso-offset' — YYYY-MM-DD HH:MM GMT±N (local + GMT offset)
      //   'iso-utc'    — YYYY-MM-DD HH:MM UTC (timezone-independent)
      // Global-only -- not in OVERRIDABLE_KEYS, since this is a presentation
      // choice users want consistent across all their exports.
      dateFormat: 'locale',
      // ON by default: images are the biggest user-visible delta over a
      // text-only export, so the expected behavior is "include them". Users
      // who want a tiny .md (or who don't want to wait on CDN fetches) can
      // flip this off explicitly.
      inlineImages: true,
      inlineTextFiles: false,
      attachmentsAsMarkdown: false,
    },
    perAdapter: { claude: {}, chatgpt: {}, gemini: {} },
  };

  /** Keys that count as per-adapter overrides. Used by options UI to know
   *  which controls to render and by resolveFor() to know what to merge. */
  const OVERRIDABLE_KEYS = [
    'mode',
    'includeReasoning',
    'includeDates',
    'inlineImages',
    'inlineTextFiles',
    'attachmentsAsMarkdown',
  ];

  const load = async () => {
    try {
      const got = await chrome.storage.sync.get('settings');
      const s = got.settings || {};
      return {
        global: { ...DEFAULTS.global, ...(s.global || {}) },
        perAdapter: {
          ...DEFAULTS.perAdapter,
          ...(s.perAdapter || {}),
        },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  };

  const save = async (settings) => {
    await chrome.storage.sync.set({ settings });
  };

  /**
   * Merge global defaults with the per-adapter override map. A key missing
   * from `perAdapter[adapterId]` inherits the global value; a key present
   * (even with value `false`) wins. Returns a fresh object — safe to mutate.
   */
  const resolveFor = (settings, adapterId) => {
    const override = (settings.perAdapter && settings.perAdapter[adapterId]) || {};
    const out = { ...settings.global };
    for (const k of OVERRIDABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(override, k)) {
        out[k] = override[k];
      }
    }
    return out;
  };

  /** Count of override keys actually set for an adapter (drives the
   *  "(N overrides)" badge on the options page). */
  const countOverrides = (override) => {
    if (!override) return 0;
    let n = 0;
    for (const k of OVERRIDABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(override, k)) n++;
    }
    return n;
  };

  ns.settings = { load, save, resolveFor, countOverrides, DEFAULTS, OVERRIDABLE_KEYS };
})();
