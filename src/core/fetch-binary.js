/**
 * Same-origin binary fetch with credentials. Used by adapters to download
 * uploaded files & images for inclusion in the export.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  /**
   * @param {string} url
   * @returns {Promise<{bytes: Uint8Array, mime: string}>}
   */
  const fetchAsBytes = async (url) => {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: '*/*' },
    });
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    const mime = res.headers.get('content-type') || '';
    return { bytes: new Uint8Array(buf), mime: mime.split(';')[0].trim() };
  };

  ns.fetchBinary = { fetchAsBytes };
})();
