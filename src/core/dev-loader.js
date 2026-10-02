/**
 * Load developer tooling from src/dev/ -- only into unpacked installs.
 *
 * An install from the Chrome Web Store carries `update_url` in its
 * manifest; an extension loaded unpacked from a repo checkout does not.
 * Only the latter gets the dev scripts. The release zip doesn't contain
 * src/dev/ at all (release.ps1), so for store users this file is a no-op
 * either way; missing files are ignored.
 *
 * Content scripts can only import() files listed in web_accessible_resources
 * (manifest.json: src/dev/*, chat hosts only).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const DEV_SCRIPTS = ['src/dev/dev-common.js', 'src/dev/debug-capture.js', 'src/dev/page-trigger.js'];

  const isUnpacked = () => {
    try {
      return !('update_url' in chrome.runtime.getManifest());
    } catch (_) {
      return false;
    }
  };

  ns.devLoader = { isUnpacked };

  // Already present (tests load them directly) or not a dev install.
  if (ns.dev || !isUnpacked()) return;

  (async () => {
    for (const file of DEV_SCRIPTS) {
      try {
        await import(chrome.runtime.getURL(file));
      } catch (_) {
        /* not shipped in this build */
      }
    }
  })();
})();
