/**
 * Thin wrapper over claude.ai's private web API. Uses session cookies
 * (credentials:'include'); same-origin to claude.ai when invoked from a
 * content script on https://claude.ai/*.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;
  const BASE = 'https://claude.ai/api';

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const getJson = async (path) => {
    const res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new ApiError(`GET ${path} failed: ${res.status} ${res.statusText}`, res.status);
    }
    return res.json();
  };

  const parseConvIdFromUrl = (href) => {
    const m = String(href).match(/claude\.ai\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  };

  const getOrgId = async () => {
    const orgs = await getJson('/organizations');
    const first = Array.isArray(orgs) ? orgs[0] : null;
    if (!first || !first.uuid) {
      throw new ApiError('No organizations returned for the current user');
    }
    return first.uuid;
  };

  /**
   * Fetch the conversation tree with three URL params that, combined, give us
   * fully structured content:
   *
   *   - `tree=True`               — return parent/child relationships so we
   *                                  can walk the active branch.
   *   - `rendering_mode=messages` — keep `thinking` as a typed block (with
   *                                  the flag absent it collapses into a
   *                                  plain text block indistinguishable from
   *                                  a regular assistant message, which makes
   *                                  the "include reasoning" toggle useless).
   *   - `render_all_tools=true`  — keep `tool_use` / `tool_result` as typed
   *                                  blocks. Without this flag they collapse
   *                                  into a fenced placeholder ("This block
   *                                  is not supported on your current device
   *                                  yet.") and we lose the entire payload —
   *                                  e.g. `create_file` outputs from Claude's
   *                                  sandbox tool are completely gone.
   *
   * Claude.ai's own UI uses exactly this combination.
   */
  const fetchConversation = (orgId, convId) =>
    getJson(`/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`);

  /**
   * Download a file from a conversation. The exact endpoint is not officially
   * documented; we try the most common patterns in order. On the first 200 we
   * return the bytes.
   *
   * `userScopeId` is the `c{uuid}` prefix observed in image `preview_url`
   * fields (e.g. `/api/c2660925-.../files/{uuid}/preview`). When supplied, we
   * try those endpoints first since they're known to work for at least image
   * files. Without it we fall back to organization-scoped endpoints.
   *
   * @param {string} orgId
   * @param {string} fileUuid
   * @param {string} [userScopeId]
   * @returns {Promise<{bytes: Uint8Array, mime: string}>}
   */
  const fetchFile = async (orgId, fileUuid, userScopeId) => {
    const candidates = [];
    if (userScopeId) {
      candidates.push(
        `${BASE}/${userScopeId}/files/${fileUuid}/preview`,
        `${BASE}/${userScopeId}/files/${fileUuid}/contents`,
        `${BASE}/${userScopeId}/files/${fileUuid}/download`,
        `${BASE}/${userScopeId}/files/${fileUuid}`,
      );
    }
    candidates.push(
      `${BASE}/organizations/${orgId}/files/${fileUuid}/preview`,
      `${BASE}/organizations/${orgId}/files/${fileUuid}/contents`,
      `${BASE}/organizations/${orgId}/files/${fileUuid}/download`,
      `${BASE}/organizations/${orgId}/files/${fileUuid}`,
    );
    let lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { accept: '*/*' },
        });
        if (!res.ok) {
          lastErr = new Error(`${res.status} ${res.statusText}`);
          continue;
        }
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
        // /preview sometimes returns an HTML viewer page instead of bytes.
        if (ct.startsWith('text/html')) {
          lastErr = new Error('preview returned HTML viewer');
          continue;
        }
        const buf = await res.arrayBuffer();
        log.debug('fetchFile success', url, ct, buf.byteLength, 'bytes');
        return { bytes: new Uint8Array(buf), mime: ct };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`fetchFile(${fileUuid}) failed: ${lastErr ? lastErr.message : 'unknown'}`);
  };

  /**
   * Direct file download via claude.ai's internal sandbox endpoint. The URL
   * shape was extracted by clicking on a file card in claude.ai UI:
   *
   *   /api/organizations/{orgId}/conversations/{convId}/wiggle/download-file
   *     ?path={url-encoded sandbox path}
   *
   * `path` is the server-side path Claude sees inside its sandbox, e.g.
   * `/mnt/user-data/uploads/architectural-profile.md` (already cleaned of
   * any markdown-link wrapper).
   *
   * @param {string} orgId
   * @param {string} convId
   * @param {string} path
   * @returns {Promise<{bytes: Uint8Array, mime: string}>}
   */
  const fetchFileByPath = async (orgId, convId, path) => {
    const url = `${BASE}/organizations/${orgId}/conversations/${convId}/wiggle/download-file?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: '*/*' },
    });
    if (!res.ok) {
      throw new Error(`fetchFileByPath ${path} → ${res.status} ${res.statusText}`);
    }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = await res.arrayBuffer();
    log.debug('fetchFileByPath success', path, ct, buf.byteLength, 'bytes');
    return { bytes: new Uint8Array(buf), mime: ct };
  };

  /**
   * Scan the raw conversation for any image's `preview_url` and extract the
   * `c{uuid}` user-scope segment. Returns null if not found.
   */
  const extractUserScopeId = (raw) => {
    const messages = raw && Array.isArray(raw.chat_messages) ? raw.chat_messages : [];
    for (const m of messages) {
      const files = Array.isArray(m && m.files) ? m.files : [];
      for (const f of files) {
        const url = f && typeof f.preview_url === 'string' ? f.preview_url : null;
        if (!url) continue;
        const match = url.match(/^\/api\/(c[a-z0-9-]+)\//i);
        if (match) return match[1];
      }
    }
    return null;
  };

  ns.claudeApi = {
    parseConvIdFromUrl,
    getOrgId,
    fetchConversation,
    fetchFile,
    fetchFileByPath,
    extractUserScopeId,
    ApiError,
  };
})();
