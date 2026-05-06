/**
 * Adapter manifest for ChatGPT. Loaded by the popup to detect chatgpt.com
 * tabs. Legacy chat.openai.com is no longer supported (browser auto-redirects
 * to chatgpt.com these days, and the backend API surface has diverged).
 */
self.__adapterChatGPT = {
  id: 'chatgpt',
  displayName: 'ChatGPT',
  hostPatterns: [/(^|\.)chatgpt\.com$/i],
  matches(hostname) {
    return this.hostPatterns.some((re) => re.test(hostname));
  },
};
