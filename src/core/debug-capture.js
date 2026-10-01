/**
 * Debug capture: record every fetch an export makes and save it as a HAR
 * file next to the export.
 *
 * Purpose: when an export comes out wrong, the raw API responses are what
 * explains it -- and providers change those without notice. The HAR feeds
 * straight into the test tooling:
 *   node tools/record-from-har.js <file>.debug.har tests/scenarios/local/<name>
 *   node tools/schema-drift.js <file>.debug.har
 *
 * Privacy: request headers and bodies are NOT recorded (they carry auth
 * tokens -- ChatGPT bearer, Gemini `at`). Response bodies are recorded in
 * full: the file holds the conversation itself, so it stays on the user's
 * machine like the export does.
 *
 * Besides standard HAR fields, `log._exporter` describes the export
 * (adapter, page URL, options, result) so the recorder can build a
 * scenario without guessing.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { uint8ToBase64, todayStamp, log } = ns.utils;

  const isTextMime = (mime) =>
    /^text\/|[/+](json|javascript|xml)\b|^application\/x-www-form-urlencoded/i.test(mime || '');

  const manifestVersion = () => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return '';
    }
  };

  const blankEntry = (method, url, started) => ({
    startedDateTime: started.toISOString(),
    time: 0,
    request: { method, url, httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
    response: {
      status: 0, statusText: '', httpVersion: '', headers: [], cookies: [],
      content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  });

  /** The recording in progress, if any (see noteProxied). */
  let active = null;

  /**
   * Record a request made on the content script's behalf elsewhere -- the
   * service worker's asset proxy (Gemini) -- which the fetch wrapper can't
   * see. No-op unless a capture is running.
   *
   * @param {{url:string, ok:boolean, mime?:string, base64?:string, error?:string}} r
   */
  const noteProxied = (r) => {
    if (!active) return;
    const entry = blankEntry('GET', r.url, new Date());
    entry._proxiedBy = 'service-worker';
    if (r.ok) {
      entry.response.status = 200;
      entry.response.statusText = 'OK';
      if (r.mime) entry.response.headers.push({ name: 'content-type', value: r.mime });
      entry.response.content.mimeType = r.mime || '';
      entry.response.content.text = r.base64 || '';
      entry.response.content.encoding = 'base64';
      entry.response.content.size = Math.floor(((r.base64 || '').length * 3) / 4);
    } else {
      // Keep the failure replayable: a 502 with the error as body.
      entry.response.status = 502;
      entry.response.statusText = 'Proxy error';
      entry.response.headers.push({ name: 'content-type', value: 'text/plain' });
      entry.response.content.mimeType = 'text/plain';
      entry.response.content.text = r.error || 'error';
      entry._error = r.error || 'error';
    }
    active.entries.push(entry);
  };

  /**
   * Replace self.fetch with a recording wrapper. Returns { entries, stop }.
   * The wrapper hands the caller the original Response and reads a clone,
   * so adapters see no difference.
   */
  const startRecording = () => {
    const entries = [];
    const original = self.fetch;
    const wrapped = async (input, init) => {
      const started = new Date();
      const rawUrl = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      let url = rawUrl;
      try {
        url = new URL(rawUrl, location.href).href;
      } catch (_) { /* keep raw */ }
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const entry = blankEntry(method, url, started);
      entries.push(entry);
      let res;
      try {
        res = await original.call(self, input, init);
      } catch (err) {
        entry._error = err instanceof Error ? err.message : String(err);
        throw err;
      }
      try {
        const ct = (res.headers && res.headers.get('content-type')) || '';
        const bytes = new Uint8Array(await res.clone().arrayBuffer());
        entry.response.status = res.status;
        entry.response.statusText = res.statusText || '';
        if (ct) entry.response.headers.push({ name: 'content-type', value: ct });
        entry.response.content.size = bytes.length;
        entry.response.content.mimeType = ct;
        if (isTextMime(ct)) {
          entry.response.content.text = new TextDecoder().decode(bytes);
        } else if (bytes.length) {
          entry.response.content.text = uint8ToBase64(bytes);
          entry.response.content.encoding = 'base64';
        }
      } catch (err) {
        entry._error = `could not record response: ${err instanceof Error ? err.message : String(err)}`;
      }
      entry.time = Date.now() - started.getTime();
      return res;
    };
    self.fetch = wrapped;
    return {
      entries,
      stop: () => {
        if (self.fetch === wrapped) self.fetch = original;
      },
    };
  };

  /**
   * Run `fn` (an export) and, when `enabled`, download a HAR of its fetches
   * afterwards -- also when the export failed, since that is when it is
   * needed most. Returns whatever `fn` returns / rethrows what it throws.
   *
   * @param {{ enabled: boolean, adapter: string, options: object }} meta
   * @param {() => Promise<{ok:boolean, filename?:string, error?:string}>} fn
   */
  const run = async (meta, fn) => {
    if (!meta.enabled) return fn();
    const rec = startRecording();
    active = rec;
    let result;
    let thrown = null;
    try {
      result = await fn();
    } catch (err) {
      thrown = err;
    } finally {
      rec.stop();
      active = null;
    }
    try {
      const outcome = thrown
        ? { ok: false, error: thrown instanceof Error ? thrown.message : String(thrown) }
        : result;
      const base = outcome && outcome.filename
        ? outcome.filename.replace(/\.(md|zip)$/i, '')
        : `export-failed-${todayStamp()}`;
      const har = {
        log: {
          version: '1.2',
          creator: { name: 'LLM Chat Exporter', version: manifestVersion() },
          pages: [{
            id: 'page_1',
            startedDateTime: rec.entries.length ? rec.entries[0].startedDateTime : new Date().toISOString(),
            title: document.title || '',
            pageTimings: {},
          }],
          entries: rec.entries.map((e) => ({ pageref: 'page_1', ...e })),
          _exporter: {
            adapter: meta.adapter,
            location: location.href,
            documentTitle: document.title || '',
            exportedAt: new Date().toISOString(),
            options: meta.options,
            result: outcome || null,
          },
        },
      };
      const blob = new Blob([JSON.stringify(har, null, 1)], { type: 'application/json' });
      ns.download.triggerDownload(blob, `${base}.debug.har`);
    } catch (err) {
      log.warn('debug capture: could not save HAR', err);
    }
    if (thrown) throw thrown;
    return result;
  };

  ns.debugCapture = { run, noteProxied };
})();
