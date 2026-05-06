/**
 * Download trigger from within content script (same approach as the reference
 * implementation: append <a download> to body, click, revoke).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  ns.download = { triggerDownload };
})();
