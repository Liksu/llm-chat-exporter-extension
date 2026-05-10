/**
 * Thin wrapper over Gemini's private web API.
 *
 * Endpoint: gemini.google.com/_/BardChatUi/data/batchexecute (RPC ID hNvQHb
 * for "load conversation"). Auth model is unusual:
 *   - Cookies (handled by credentials:'include').
 *   - An XSRF-style `at` token in the form-urlencoded body, captured at
 *     runtime by hook-main.js (Gemini rotates it periodically).
 *
 * Response is in Google's "wrb.fr" frame format:
 *   )]}'
 *   <length>\n<json>\n<length>\n<json>\n...
 * where each JSON chunk is a 2D array of frames; the frame we want has shape
 * `["wrb.fr", "hNvQHb", "<inner-json-string>", ...]`. The inner string parses
 * to the actual conversation tree (handed off to normalize.js).
 *
 * Multi-account: gemini.google.com/u/<N>/app/<id> mounts the batchexecute
 * endpoint under the same /u/<N>/ prefix; we preserve the prefix when
 * building the request URL.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  /**
   * Extract { userScope, convId } from a Gemini conversation URL.
   *   gemini.google.com/app/<16hex>            → { userScope: '',     convId }
   *   gemini.google.com/u/0/app/<16hex>        → { userScope: 'u/0',  convId }
   *   gemini.google.com/u/1/app/<16hex>?…      → { userScope: 'u/1',  convId }
   */
  const parseConvLocator = (href) => {
    const url = String(href || '');
    const m = url.match(/gemini\.google\.com(\/u\/\d+)?\/app\/([0-9a-f]{16,})/i);
    if (!m) return null;
    const userScope = m[1] ? m[1].replace(/^\//, '') : '';
    return { userScope, convId: m[2] };
  };

  /**
   * Wait until hook-main.js has captured an `at` token and stashed it on
   * self.__exporterGemini.at. The hook reads SNlM0e at install time and also
   * snags fresh values from any outgoing batchexecute call, so on a loaded
   * conversation tab we usually have one within milliseconds.
   */
  const getAtToken = async (timeoutMs = 3000) => {
    const store = (self.__exporterGemini = self.__exporterGemini || {});
    if (typeof store.at === 'string' && store.at) return store.at;
    return new Promise((resolve, reject) => {
      const onToken = () => {
        if (typeof store.at === 'string' && store.at) {
          document.removeEventListener('exporter:gemini-at', onToken);
          clearTimeout(timer);
          resolve(store.at);
        }
      };
      document.addEventListener('exporter:gemini-at', onToken);
      const timer = setTimeout(() => {
        document.removeEventListener('exporter:gemini-at', onToken);
        if (typeof store.at === 'string' && store.at) {
          resolve(store.at);
        } else {
          reject(
            new ApiError(
              'Could not capture Gemini auth token. Reload the conversation tab and try again.',
              0
            )
          );
        }
      }, timeoutMs);
    });
  };

  /** Build the batchexecute URL, preserving any /u/<N>/ multi-account prefix. */
  const buildUrl = (userScope) => {
    const prefix = userScope ? `/${userScope}` : '';
    const reqid = 100000 + Math.floor(Math.random() * 900000);
    const params = new URLSearchParams({
      rpcids: 'hNvQHb',
      _reqid: String(reqid),
      rt: 'c',
    });
    return `https://gemini.google.com${prefix}/_/BardChatUi/data/batchexecute?${params.toString()}`;
  };

  /**
   * Build the form-urlencoded request body. The inner f.req payload mirrors
   * exactly what the SPA sends:
   *   [[["hNvQHb","[\"c_<id>\",10,null,1,[1],[4],null,1]",null,"generic"]]]
   * The numeric tuple after the conversation id is a fixed parameter set we
   * observed across every captured call; treating it as a constant has
   * worked across all sample conversations.
   */
  const buildBody = (convId, atToken) => {
    const inner = JSON.stringify([`c_${convId}`, 10, null, 1, [1], [4], null, 1]);
    const fReq = JSON.stringify([[['hNvQHb', inner, null, 'generic']]]);
    const params = new URLSearchParams();
    params.set('f.req', fReq);
    params.set('at', atToken);
    return params.toString();
  };

  /**
   * Parse a batchexecute response. The wire format is:
   *
   *   )]}'\n[whitespace]
   *   <length>\n
   *   <chunk-json>
   *   <length>\n
   *   <chunk-json>
   *   …
   *
   * Each chunk is a JSON array of frames; the frame we want has shape
   * `["wrb.fr", "hNvQHb", "<inner-json-string>", …]`, and `<inner-json-string>`
   * parses to the actual conversation tree.
   *
   * We deliberately IGNORE the per-chunk `<length>` prefix. In practice the
   * value Google emits there doesn't match either the UTF-8 byte count or
   * the JS string length on responses heavy in non-ASCII text — chunk
   * boundaries based on it have caused mid-string truncation. Instead, we
   * find each chunk's end via balanced-bracket matching, which is encoding-
   * independent.
   *
   * Returns the parsed inner payload, or null. A `parseResponseLenient`
   * fallback is tried if the primary path can't find a wrb.fr/hNvQHb frame
   * (e.g. Google changes the envelope shape).
   */

  /**
   * Find the end (exclusive) of a single JSON value (object, array, string,
   * number, etc.) starting at `start` in `text`. Tracks depth across `[`/`]`
   * and `{`/`}` and skips inside `"…"` (with backslash-escapes), so it's
   * robust to nested structures and to string content that contains stray
   * brackets. Returns -1 if no balanced value is found.
   */
  const findEndOfJsonValue = (text, start) => {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let started = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inStr) {
        if (c === '\\') {
          escaped = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        started = true;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        started = true;
        continue;
      }
      if (c === ']' || c === '}') {
        depth--;
        if (started && depth === 0) return i + 1;
      }
    }
    return -1;
  };

  /**
   * Walk a wrb.fr/hNvQHb candidate string and decode its inner JSON. Logs
   * (without throwing) when the inner JSON is malformed so the caller can
   * try the next candidate. Returns the parsed value or null.
   */
  const decodeInner = (innerStr, where) => {
    if (typeof innerStr !== 'string' || !innerStr) return null;
    try {
      return JSON.parse(innerStr);
    } catch (e) {
      log.warn(
        `gemini: inner JSON.parse failed (${where}):`,
        e && e.message ? e.message : e,
        'preview:',
        innerStr.slice(0, 120)
      );
      return null;
    }
  };

  /**
   * Primary parser. For each chunk:
   *   - Skip the digit-only "length" line (we ignore the value).
   *   - Find the balanced JSON value with findEndOfJsonValue.
   *   - JSON.parse it; collect any wrb.fr/hNvQHb frame.
   *   - Try to decode each frame's inner JSON; first success wins.
   *
   * Robust to length mismatches; only fails if the JSON itself is malformed
   * or if the response is genuinely truncated.
   */
  const parseResponseBracketMatch = (text) => {
    let t = text;
    if (t.startsWith(")]}'")) t = t.slice(4);

    let pos = 0;
    const skipWs = () => {
      while (pos < t.length) {
        const c = t.charCodeAt(pos);
        if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09) pos++;
        else break;
      }
    };
    skipWs();

    let chunkIdx = 0;
    while (pos < t.length) {
      // Skip the optional length line: digits up to the next \n.
      const nlPos = t.indexOf('\n', pos);
      if (nlPos !== -1) {
        const lengthLine = t.slice(pos, nlPos).trim();
        if (/^\d+$/.test(lengthLine)) {
          pos = nlPos + 1;
        }
      }
      skipWs();
      if (pos >= t.length) break;

      const end = findEndOfJsonValue(t, pos);
      if (end === -1) {
        log.debug('gemini bracket-match: no balanced JSON at offset', pos);
        break;
      }
      const chunkText = t.slice(pos, end);
      pos = end;
      skipWs();
      chunkIdx++;

      let parsed;
      try {
        parsed = JSON.parse(chunkText);
      } catch (e) {
        log.warn(
          `gemini bracket-match: chunk #${chunkIdx} JSON.parse failed:`,
          e && e.message ? e.message : e,
          'preview:', chunkText.slice(0, 120)
        );
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const frame of parsed) {
        if (!Array.isArray(frame) || frame[0] !== 'wrb.fr' || frame[1] !== 'hNvQHb') continue;
        const inner = decodeInner(frame[2], `bracket-match#${chunkIdx}`);
        if (inner !== null) return inner;
      }
    }
    return null;
  };

  /**
   * Last-resort fallback. The primary path looks specifically for the
   * `["wrb.fr","hNvQHb",…]` envelope. If Google ever changes that wrapper,
   * this scans for the conversation tree directly: the first occurrence of
   * `["c_<hex>"…]` is a round identifier inside the tree, so we walk back
   * to the nearest unmatched `[` and forward to its matching `]`. Slow but
   * structurally orthogonal to the primary parser.
   */
  const parseResponseLenient = (text) => {
    // Anchor: first occurrence of `["c_<hex>"` indicates the start of a
    // round identifier inside the conversation tree. From there we walk
    // back to the nearest unmatched `[` and forward to its matching `]`.
    const anchorRe = /\["c_[0-9a-f]+"/i;
    const anchorMatch = anchorRe.exec(text);
    if (!anchorMatch) return null;
    const anchor = anchorMatch.index;

    // Walk backwards counting brackets (outside strings) to find the start
    // of the enclosing top-level array. We tolerate up to ~3 outer wraps.
    let pos = anchor;
    let need = 3; // allow up to 3 enclosing opens for [[[..]]]-style wrap
    let foundStart = -1;
    while (pos > 0 && need > 0) {
      pos--;
      const c = text[pos];
      if (c === '[') {
        if (foundStart === -1) foundStart = pos;
        need--;
      } else if (c === ']' || c === '"' || c === '\\') {
        // We don't try to perfectly skip strings backwards; just bail if
        // we hit obvious noise. The forward scan will validate.
        break;
      }
    }
    if (foundStart === -1) return null;

    // Forward scan: track depth across `[`/`]`, skipping inside `"..."`
    // (with `\\` escape). When depth returns to 0, that's the end of the
    // outer array.
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let k = foundStart; k < text.length; k++) {
      const c = text[k];
      if (inStr) {
        if (c === '\\') {
          k++;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) return null;

    const candidate = text.slice(foundStart, end + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      log.warn(
        'gemini lenient fallback: JSON.parse failed:',
        e && e.message ? e.message : e,
        'preview:', candidate.slice(0, 120)
      );
      return null;
    }
  };

  /**
   * Fetch the conversation tree for the given Gemini conversation. Throws
   * ApiError on transport or parse failure; on success returns the raw JSPB
   * structure (an array; normalize.js consumes it).
   *
   * @param {{convId:string, userScope:string, atToken:string}} args
   */
  const fetchConversation = async ({ convId, userScope, atToken }) => {
    const url = buildUrl(userScope);
    const body = buildBody(convId, atToken);
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'x-same-domain': '1',
      },
      body,
    });
    if (!res.ok) {
      throw new ApiError(`batchexecute → ${res.status} ${res.statusText}`, res.status);
    }
    const text = await res.text();
    log.debug('gemini fetchConversation got', text.length, 'chars');

    // Primary: bracket-matching chunk locator (length-prefix-agnostic).
    let parsed = parseResponseBracketMatch(text);

    // Fallback: structurally orthogonal anchor-search. Only useful if Google
    // changes the wrb.fr envelope (the conversation tree itself is shaped
    // the same way in all observed responses).
    if (parsed === null) {
      log.warn('gemini: bracket-match failed, trying lenient anchor fallback. preview:', text.slice(0, 200));
      parsed = parseResponseLenient(text);
    }

    if (parsed === null) {
      throw new ApiError(
        'Failed to parse Gemini batchexecute response. The conversation may be empty, the auth token may be stale, or the API format changed.',
        0
      );
    }
    log.debug('gemini fetchConversation ok', convId);
    return parsed;
  };

  /**
   * Decode a base64 string (without `data:` prefix) into a Uint8Array.
   * Used to unpack the binary payloads we get back from the service-worker
   * fetch proxy.
   */
  const base64ToBytes = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  /**
   * Fetch any asset URL Gemini hands us inside the response — both inline
   * images (lh3.googleusercontent.com) and uploaded-file downloads
   * (contribution-rt.usercontent.google.com).
   *
   * IMPORTANT: We MUST go through the service worker rather than fetching
   * directly from the content script. In MV3 a content-script `fetch`
   * uses the host page's CORS context, and Google's asset CDNs don't send
   * Access-Control-Allow-Origin for gemini.google.com — so the request
   * gets blocked. The service worker has no page-CORS constraint and only
   * needs the destination host listed in `host_permissions` (it is).
   *
   * Wire format: we send `{kind:'fetch-asset', url}` and receive
   * `{ok, base64, mime, size}` (or `{ok:false, error}`). Binary is
   * base64-encoded over the message boundary because chrome.runtime
   * messages are JSON-serialised.
   */
  const fetchAsset = async (url) => {
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ kind: 'fetch-asset', url });
    } catch (e) {
      throw new Error(`gemini asset (sw): ${e && e.message ? e.message : e}`);
    }
    if (!reply || reply.ok !== true) {
      const errMsg = reply && reply.error ? reply.error : 'no response from service worker';
      throw new Error(`gemini asset: ${errMsg}`);
    }
    return {
      bytes: base64ToBytes(reply.base64 || ''),
      mime: typeof reply.mime === 'string' ? reply.mime : '',
    };
  };

  ns.geminiApi = {
    parseConvLocator,
    getAtToken,
    fetchConversation,
    fetchAsset,
    ApiError,
  };
})();
