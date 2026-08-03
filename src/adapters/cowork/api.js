/**
 * Thin wrapper over claude.ai's Cowork ("code session") API.
 *
 * Cowork is a completely separate product surface from the regular chat:
 *
 *                  regular chat                      cowork
 *   URL            /chat/<uuid>                      /cowork/cse_01MXW…
 *   API            /api/organizations/…              /v1/code/sessions/…
 *   data model     message tree (parent/children)    flat append-only event log
 *   id             UUID                              `cse_` + base32 (NOT a UUID)
 *
 * The non-UUID session id matters: the regular conversation endpoints reject
 * it outright (`path.conversation_uuid: Input should be a valid UUID`), so
 * none of the claudeApi helpers can be reused here — including the sandbox
 * `wiggle/*` file endpoints.
 *
 * Auth is the same same-origin session cookie the page already uses; we add
 * the client headers claude.ai's own UI sends, since some of them gate the
 * route.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { log } = ns.utils;
  const BASE = 'https://claude.ai/v1/code';

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  /**
   * Cowork session ids are NOT uuids — they look like `cse_01MXWnbx6ZPKDWi2PLrQyEy9`
   * (a `cse_` prefix plus base32-ish characters). Keep the pattern permissive
   * so a future id-length change doesn't silently break detection.
   */
  const parseSessionIdFromUrl = (href) => {
    const m = String(href).match(/claude\.ai\/cowork\/(cse_[A-Za-z0-9]+)/);
    return m ? m[1] : null;
  };

  /** True when the given URL is a cowork session page. */
  const isCoworkUrl = (href) => parseSessionIdFromUrl(href) !== null;

  /**
   * Headers claude.ai's UI sends on /v1/code/* calls. `x-organization-uuid`
   * is the only one that varies per user; the rest are constants that
   * identify the web client. We send them because the route is not part of
   * the documented API and may check them.
   */
  const buildHeaders = (orgId) => {
    const h = {
      accept: '*/*',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-version': '2023-06-01',
    };
    if (orgId) h['x-organization-uuid'] = orgId;
    return h;
  };

  const getJson = async (path, orgId) => {
    const res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: buildHeaders(orgId),
    });
    if (!res.ok) {
      throw new ApiError(`GET ${path} → ${res.status} ${res.statusText}`, res.status);
    }
    return res.json();
  };

  /**
   * Session metadata: title, model, timestamps.
   *
   * Response is wrapped in `response_shape`; we unwrap so callers see a flat
   * object. Shape (trimmed):
   *   { id, title, created_at, updated_at, last_event_at,
   *     config: { model, effort_level, … }, status, … }
   */
  const fetchSession = async (sessionId, orgId) => {
    const body = await getJson(`/sessions/${encodeURIComponent(sessionId)}`, orgId);
    const shape = body && body.response_shape ? body.response_shape : body;
    if (!shape || typeof shape !== 'object') {
      throw new ApiError(`Unexpected session payload for ${sessionId}`, 0);
    }
    return shape;
  };

  /**
   * Fetch the full event log, walking the cursor backwards.
   *
   * The endpoint returns the NEWEST `limit` events first, plus a
   * `resume_cursor` pointing at the next (older) page:
   *
   *   ?limit=500              → seq 6749..7248, resume_cursor 6749
   *   ?limit=500&cursor=6749  → seq 6249..6748, resume_cursor 6249
   *   …
   *   ?limit=500&cursor=249   → seq 1..248,     resume_cursor 1
   *
   * We keep paging until a short page comes back, the cursor stops moving,
   * or we hit the safety cap. Events are de-duplicated by `event_id` and
   * returned in ascending `sequence_num` order — i.e. chronological.
   *
   * A busy session is big: the reference capture had 7248 events across 15
   * requests (~14 MB of JSON). That's the price of a complete transcript;
   * there is no server-side filter to ask for "just the conversation".
   *
   * @param {string} sessionId
   * @param {string} [orgId]
   * @param {(loaded:number)=>void} [onProgress]
   */
  const fetchAllEvents = async (sessionId, orgId, onProgress) => {
    const LIMIT = 500;
    const MAX_PAGES = 400; // 200k events — far beyond any real session
    const byId = new Map();
    let cursor = null;
    let pages = 0;

    while (pages < MAX_PAGES) {
      const qs = `?limit=${LIMIT}${cursor != null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await getJson(`/sessions/${encodeURIComponent(sessionId)}/events${qs}`, orgId);
      const data = Array.isArray(body && body.data) ? body.data : [];
      for (const e of data) {
        if (e && e.event_id) byId.set(e.event_id, e);
      }
      pages++;
      if (typeof onProgress === 'function') onProgress(byId.size);

      const next = body && body.resume_cursor;
      // Stop when the page was short (we reached the beginning), the server
      // gave us no cursor, or the cursor failed to advance (defensive: a
      // repeating cursor would otherwise loop forever).
      if (data.length < LIMIT || next == null || String(next) === String(cursor)) break;
      if (Number(next) <= 1) {
        // `1` is the first sequence number; one more page would be empty.
        cursor = next;
        const tailQs = `?limit=${LIMIT}&cursor=${encodeURIComponent(next)}`;
        const tail = await getJson(
          `/sessions/${encodeURIComponent(sessionId)}/events${tailQs}`,
          orgId
        );
        for (const e of Array.isArray(tail && tail.data) ? tail.data : []) {
          if (e && e.event_id) byId.set(e.event_id, e);
        }
        break;
      }
      cursor = next;
    }

    const events = [...byId.values()].sort(
      (a, b) => Number(a.sequence_num) - Number(b.sequence_num)
    );
    log.debug('cowork fetchAllEvents', sessionId, events.length, 'events in', pages, 'pages');
    return events;
  };

  ns.coworkApi = {
    parseSessionIdFromUrl,
    isCoworkUrl,
    fetchSession,
    fetchAllEvents,
    ApiError,
  };
})();
