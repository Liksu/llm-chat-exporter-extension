/**
 * Developer tooling -- shared bits. Everything under src/dev/ is loaded
 * only into unpacked installs (src/core/dev-loader.js) and is left out of
 * the release zip (release.ps1). Product code must work without it.
 *
 * Dev settings live in chrome.storage.local under `devSettings` -- kept
 * apart from the user-facing settings (storage.sync) and not synced:
 *   { debugCapture: boolean, pageTrigger: boolean }
 * The toggles are on the options page (src/dev/options-dev.js).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const DEFAULTS = { debugCapture: false, pageTrigger: false };

  const readSettings = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get('devSettings', (got) => {
          resolve({ ...DEFAULTS, ...((got && got.devSettings) || {}) });
        });
      } catch (_) {
        resolve({ ...DEFAULTS });
      }
    });

  ns.dev = Object.assign(ns.dev || {}, { readSettings, DEFAULTS });
})();
