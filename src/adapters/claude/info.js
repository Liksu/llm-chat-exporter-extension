/**
 * Adapter manifest for Claude. Loaded by the popup (NOT by content scripts)
 * to know whether the active tab is supported and to render adapter-specific
 * UI later (none for now).
 */
self.__adapterClaude = {
  id: 'claude',
  displayName: 'Claude',
  hostPatterns: [/(^|\.)claude\.ai$/i],
  matches(hostname) {
    return this.hostPatterns.some((re) => re.test(hostname));
  },
};
