/**
 * Thin wrapper over chatgpt.com's private backend API.
 *
 * Auth: chatgpt.com no longer exposes /api/auth/session (the legacy NextAuth
 * endpoint). All /backend-api/* calls require an Authorization: Bearer header
 * whose token must be stolen from the SPA at runtime.
 *
 * Mechanism: a tiny page-world hook installed at document_start (see hook.js)
 * wraps window.fetch + XHR setRequestHeader and posts every observed Bearer
 * token to the content-script via CustomEvent on document. We cache the latest
 * one in self.__exporterChatGPT.token; getAccessToken() returns that, waiting
 * briefly if the hook hasn't fired yet.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;
  const BASE = 'https://chatgpt.com/backend-api';

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  /**
   * URL shapes seen on chatgpt.com:
   *   /c/{uuid}                 — normal chat
   *   /g/g-{slug}/c/{uuid}      — custom GPT chat
   *   /share/{token}            — shared chat (NOT supported here; different API)
   *
   * We extract the trailing UUID from the first two; share links are out of scope
   * because their backend endpoint is different and they often lack auth context.
   */
  const parseConvIdFromUrl = (href) => {
    const url = String(href);
    const m = url.match(/chatgpt\.com\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  };

  /**
   * Pull the Bearer token captured by the page-world hook. The hook stashes
   * tokens into self.__exporterChatGPT.token as soon as the SPA makes any
   * authenticated XHR; on a freshly loaded page that's well within a couple
   * hundred ms. We wait up to ~3s before giving up.
   */
  const getAccessToken = async () => {
    const store = (self.__exporterChatGPT = self.__exporterChatGPT || {});
    if (typeof store.token === 'string' && store.token) return store.token;

    // 1. Try the legacy /api/auth/session endpoint as a cheap shortcut.
    //    User confirmed it 404s on current chatgpt.com, but harmless to attempt.
    try {
      const r = await fetch('https://chatgpt.com/api/auth/session', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j.accessToken === 'string' && j.accessToken) {
          store.token = j.accessToken;
          return j.accessToken;
        }
      }
    } catch {
      /* ignore */
    }

    // 2. Wait for the hook to capture a token from the SPA's own traffic.
    const captured = await waitForHookToken(3000);
    if (captured) return captured;

    throw new ApiError(
      'Could not capture ChatGPT access token. Reload the conversation page and try again.',
      0
    );
  };

  const waitForHookToken = (timeoutMs) =>
    new Promise((resolve) => {
      const store = (self.__exporterChatGPT = self.__exporterChatGPT || {});
      if (store.token) return resolve(store.token);
      const onToken = (ev) => {
        const tok = ev && ev.detail;
        if (typeof tok === 'string' && tok) {
          document.removeEventListener('exporter:chatgpt-token', onToken);
          clearTimeout(timer);
          resolve(tok);
        }
      };
      document.addEventListener('exporter:chatgpt-token', onToken);
      const timer = setTimeout(() => {
        document.removeEventListener('exporter:chatgpt-token', onToken);
        resolve(store.token || null);
      }, timeoutMs);
    });

  const authedFetch = (path, token, init) =>
    fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...(init || {}),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...((init && init.headers) || {}),
      },
    });

  const authedJson = async (path, token) => {
    const res = await authedFetch(path, token);
    if (!res.ok) {
      throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status);
    }
    return res.json();
  };

  const fetchConversation = (convId, token) =>
    authedJson(`/conversation/${convId}`, token);

  // Signed URL fetch modes. Order matters — the cascade stops at the first
  // 2xx, so we want the most-likely-to-succeed mode FIRST to avoid
  // noisy 403s in DevTools (Chrome logs every failed network request).
  //
  // For chatgpt.com signed URLs (current /backend-api/estuary/content?…sig=…),
  // session cookies are what authorises the request — `credentials:'include'`
  // succeeds, `omit` always 403s. We used to try cookie-less modes first as
  // a defensive measure for hypothetical external CDN signed URLs, but
  // empirically every signed URL OpenAI hands out today is on chatgpt.com,
  // so cookies-included is the right starting point.
  //
  // The `auth:true` modes add `Authorization: Bearer <token>` for cases
  // where OpenAI tightens the auth requirement on signed endpoints. We
  // never send Bearer to non-chatgpt.com hosts (would leak the token to a
  // CDN that can't use it).
  //
  // The cookie-less modes are kept as last-resort fallbacks in case some
  // future CDN signed URL truly needs them.
  const SIGNED_MODES = [
    { credentials: 'include', referrerPolicy: 'origin', auth: false },
    { credentials: 'include', referrerPolicy: 'origin', auth: true },
    { credentials: 'omit', referrerPolicy: 'no-referrer', auth: false },
    { credentials: 'omit', referrerPolicy: 'origin', auth: false },
    { credentials: 'omit', referrerPolicy: 'no-referrer', auth: true },
  ];

  const isChatgptHost = (url) => {
    try {
      return new URL(url).hostname.endsWith('chatgpt.com');
    } catch {
      return false;
    }
  };

  /**
   * Fetch a signed download URL into bytes. Used by both regular file
   * downloads and sandbox/interpreter downloads — anything where a
   * meta endpoint hands us back a single-use signed URL.
   *
   * Pushes diagnostic strings into `attemptLog` for each tried mode,
   * so the caller can surface a useful error message if every variant
   * fails.
   *
   * @param {string} url    the signed download URL returned by the meta endpoint
   * @param {string} token  Bearer token (only sent to chatgpt.com hosts)
   * @param {string} [mime] expected MIME from the meta response
   * @param {string[]} attemptLog
   * @returns {Promise<{bytes: Uint8Array, mime: string} | null>}
   */
  const trySigned = async (url, token, mime, attemptLog) => {
    const sameHost = isChatgptHost(url);
    for (const mode of SIGNED_MODES) {
      if (mode.auth && !sameHost) continue; // never leak bearer to a CDN
      try {
        const headers = { accept: '*/*' };
        if (mode.auth) headers.authorization = `Bearer ${token}`;
        const r = await fetch(url, {
          credentials: mode.credentials,
          referrerPolicy: mode.referrerPolicy,
          headers,
        });
        if (!r.ok) {
          attemptLog.push(
            `signed[${mode.credentials}/${mode.referrerPolicy}${mode.auth ? '/auth' : ''}] → ${r.status}`
          );
          continue;
        }
        const ct = (r.headers.get('content-type') || mime || '').split(';')[0].trim();
        const buf = await r.arrayBuffer();
        return { bytes: new Uint8Array(buf), mime: ct || 'application/octet-stream' };
      } catch (err) {
        attemptLog.push(
          `signed[${mode.credentials}/${mode.referrerPolicy}${mode.auth ? '/auth' : ''}] → ${err && err.message ? err.message : 'fetch-error'}`
        );
      }
    }
    return null;
  };

  /**
   * Two-step download for sediment://file_... references:
   *   1. resolve a signed download URL via one of several candidate endpoints
   *      (the SPA's exact path varies for old vs new files; see CANDIDATES)
   *   2. GET that signed URL (no auth header — signed in the URL itself)
   *
   * Returns bytes + mime/name. Throws ApiError with a human-readable message
   * including the last endpoint we tried and its response body, so the caller
   * can surface the reason in the export instead of a silent placeholder.
   *
   * @param {string} fileId   id with or without the `sediment://` prefix
   * @param {string} convId
   * @param {string} token
   */
  const fetchFile = async (fileId, convId, token) => {
    const id = String(fileId || '').replace(/^sediment:\/\//, '');
    const cid = encodeURIComponent(convId);
    const eid = encodeURIComponent(id);

    // Try each (meta, signedFetch) pair end-to-end. A meta endpoint that
    // returns a download_url whose signed GET 403s is treated as a failure
    // for that pair — we move on to the next meta variant. The 403-then-OK
    // pattern was observed empirically: same file, same id, but `inline=true`
    // sometimes hands out a different (working) signed URL when `inline=false`
    // does not. We also try a couple of credential modes in case some signed
    // URLs require origin cookies.
    // Path order matters — first match wins. As of 2026-05, chatgpt.com
    // uses two distinct endpoints depending on whether the UI inlines the
    // file (PDFs, previewable content) or treats it as a plain download
    // (TXT, MD, DOCX, etc). Both return JSON of shape
    //   { download_url, mime_type, file_name }
    // pointing at a signed estuary URL.
    //
    // The PDF-style path uses a fresh parameter name —
    // `check_context_scopes_for_conversation_id` — that replaced the
    // older `conversation_id` query arg on this endpoint. We try it
    // first because PDFs are the file type that breaks without it; for
    // non-PDF files the bare `/files/download/<id>` also works.
    //
    // The remaining entries are legacy variants kept as fallbacks for
    // accounts / chats that might still hand out signed URLs under
    // older conventions. `/files/<id>/simple` is intentionally NOT here:
    // it only returns metadata, not a download_url, so it can never
    // satisfy this cascade.
    const META_PATHS = [
      `/files/download/${eid}?inline=true&check_context_scopes_for_conversation_id=${cid}`,
      `/files/download/${eid}`,
      `/files/download/${eid}?inline=true`,
      `/files/download/${eid}?inline=false`,
      `/files/download/${eid}?conversation_id=${cid}&inline=true`,
      `/files/download/${eid}?conversation_id=${cid}&inline=false`,
      `/files/${eid}/download?conversation_id=${cid}`,
      `/files/${eid}/download`,
      `/files/${eid}`,
    ];

    const attemptLog = [];

    for (const path of META_PATHS) {
      let body;
      try {
        const res = await authedFetch(path, token);
        if (!res.ok) {
          attemptLog.push(`${path} → ${res.status}`);
          continue;
        }
        body = await res.json();
      } catch (err) {
        attemptLog.push(`${path} → ${err && err.message ? err.message : 'fetch-error'}`);
        continue;
      }
      if (!body || typeof body.download_url !== 'string' || !body.download_url) {
        attemptLog.push(`${path} → ${body && body.status ? body.status : 'no-download_url'}`);
        continue;
      }
      const got = await trySigned(body.download_url, token, body.mime_type, attemptLog);
      if (got) {
        log.debug('chatgpt fetchFile', id, path, got.mime, got.bytes.byteLength, 'bytes');
        return {
          bytes: got.bytes,
          mime: got.mime || body.mime_type || 'application/octet-stream',
          fileName: body.file_name || '',
        };
      }
      // Signed URL failed for every credential mode — try next meta variant.
    }

    throw new ApiError(
      `chatgpt fetchFile(${id}) failed: ${attemptLog.join('; ')}`,
      0
    );
  };

  /**
   * Download a file the model generated inside its sandbox / code-interpreter
   * environment. These are referenced from assistant text as
   * `[label](sandbox:/mnt/data/<name>)` and DO NOT have a `sediment://file_…`
   * pointer in the conversation tree — the only way to retrieve them is via
   * the interpreter download endpoint, which returns a signed estuary URL
   * just like /files/download/<id> does for uploaded files.
   *
   * Endpoint shape (observed 2026-05):
   *   GET /conversation/<convId>/interpreter/download
   *       ?message_id=<msgId>
   *       &sandbox_path=<encoded sandbox path>
   *
   * Response: { status: "success", download_url: "https://chatgpt.com/backend-api/estuary/content?…" }
   *
   * @param {string} convId
   * @param {string} messageId   id of the assistant message that referenced the sandbox file
   * @param {string} sandboxPath e.g. "/mnt/data/foo.md"
   * @param {string} token
   */
  const fetchSandboxFile = async (convId, messageId, sandboxPath, token) => {
    const path =
      `/conversation/${encodeURIComponent(convId)}/interpreter/download` +
      `?message_id=${encodeURIComponent(messageId)}` +
      `&sandbox_path=${encodeURIComponent(sandboxPath)}`;

    const attemptLog = [];

    let body;
    try {
      const res = await authedFetch(path, token);
      if (!res.ok) {
        throw new ApiError(
          `chatgpt fetchSandboxFile(${sandboxPath}) meta → ${res.status} ${res.statusText}`,
          res.status
        );
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        `chatgpt fetchSandboxFile(${sandboxPath}) meta → ${err && err.message ? err.message : 'fetch-error'}`,
        0
      );
    }

    if (!body || typeof body.download_url !== 'string' || !body.download_url) {
      throw new ApiError(
        `chatgpt fetchSandboxFile(${sandboxPath}) → no download_url (status=${body && body.status ? body.status : 'unknown'})`,
        0
      );
    }

    const got = await trySigned(body.download_url, token, body.mime_type, attemptLog);
    if (!got) {
      throw new ApiError(
        `chatgpt fetchSandboxFile(${sandboxPath}) signed-get failed: ${attemptLog.join('; ')}`,
        0
      );
    }

    log.debug(
      'chatgpt fetchSandboxFile',
      sandboxPath,
      got.mime,
      got.bytes.byteLength,
      'bytes'
    );
    return {
      bytes: got.bytes,
      mime: got.mime || body.mime_type || 'application/octet-stream',
      fileName: body.file_name || '',
    };
  };

  ns.chatgptApi = {
    parseConvIdFromUrl,
    getAccessToken,
    fetchConversation,
    fetchFile,
    fetchSandboxFile,
    ApiError,
  };
})();
