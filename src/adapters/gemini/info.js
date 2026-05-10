/**
 * Adapter manifest for Gemini. Loaded by the popup (NOT by content scripts)
 * to know whether the active tab is supported and to render adapter-specific
 * UI later (none for now).
 *
 * Multi-account: gemini.google.com/u/<N>/app/<id> works the same as the
 * default gemini.google.com/app/<id>; the host check is identical.
 */
self.__adapterGemini = {
  id: 'gemini',
  displayName: 'Gemini',
  hostPatterns: [/(^|\.)gemini\.google\.com$/i],
  matches(hostname) {
    return this.hostPatterns.some((re) => re.test(hostname));
  },
};
