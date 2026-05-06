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
   * Use rendering_mode=messages. Empirically observed behavior of this private
   * endpoint when called from a content-script (cookies-only auth):
   *   - WITH rendering_mode=messages: `thinking` stays as a typed block, while
   *     tool_use/tool_result are collapsed into a text block whose content is
   *     a fenced "This block is not supported on your current device yet."
   *     placeholder. We strip those placeholders in normalize.js, so the
   *     export comes out clean.
   *   - WITHOUT the flag: thinking ALSO collapses, but into a text block whose
   *     content is the literal thinking text, which is indistinguishable from
   *     a regular assistant message and therefore impossible to filter when
   *     `Include reasoning` is off.
   * So `messages` is the lesser of two evils for our use case.
   */
  const fetchConversation = (orgId, convId) =>
    getJson(`/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages`);

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
