/**
 * Entity side panels (ChatGPT, Jan 2026 on): names in an answer marked up as
 * `<Entity value="Bowser v. Noem" disambig="…"/>` (or the older
 * `entity[…]` marker) open a panel with key facts and
 * sources when clicked.
 *
 * The panel is NOT part of the conversation: the click runs a hidden
 * "sidebar conversation" (POST /backend-api/sidebar/conversation, body
 * {category:"generic_entity", conversation_id, message_id, locale,
 * generic_entity_params:{name, category, …}}) that streams a fresh answer
 * (a hidden "Tell me about <name>…" prompt, a web search, the reply). It is
 * generated anew on every first click, in the interface language, and can't
 * be fetched back afterwards. So the export has only the panels opened in
 * this tab: hook-main.js copies each panel stream, hook-iso.js keeps it in
 * self.__exporterChatGPT.sidebars, and this module turns the stream into the
 * reply message for normalize.js.
 *
 * The stream is the delta-encoded SSE of /f/conversation ("v1"): an event
 * with `c` starts object #c, `{p, o, v}` applies an op (add / append /
 * replace / truncate / remove / patch = a list of ops) at JSON pointer `p`
 * of the current object, and an event without `p`/`o` repeats the last ones.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  const pointer = (p) =>
    p === '' ? [] : p.replace(/^\//, '').split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  /** Apply one delta op to `root`; returns the (possibly new) root. */
  const applyOp = (root, p, o, v) => {
    const keys = pointer(p);
    if (!keys.length) return o === 'add' || o === 'replace' ? v : root;
    let t = root;
    for (let i = 0; i < keys.length - 1; i++) {
      if (t === null || typeof t !== 'object') return root;
      t = t[keys[i]];
    }
    if (t === null || typeof t !== 'object') return root;
    const k = keys[keys.length - 1];
    const old = t[k];
    if (o === 'append') {
      if (Array.isArray(old)) t[k] = old.concat(v);
      else if (isObject(old) && isObject(v)) Object.assign(old, v);
      else if (typeof old === 'string') t[k] = old + (typeof v === 'string' ? v : '');
      else t[k] = v;
    } else if (o === 'add' || o === 'replace') {
      t[k] = v;
    } else if (o === 'truncate') {
      if (Array.isArray(old) || typeof old === 'string') t[k] = old.slice(0, v);
    } else if (o === 'remove') {
      if (Array.isArray(t)) t.splice(Number(k), 1);
      else delete t[k];
    }
    return root;
  };

  /** Decode a delta-encoded SSE body into the objects it built, in order. */
  const decodeStream = (text) => {
    const roots = [];
    if (typeof text !== 'string') return roots;
    let cur = -1;
    let lastP = '';
    let lastO = 'add';
    for (const block of text.split(/\r?\n\r?\n/)) {
      let event = '';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (event !== 'delta' || !data.length) continue;
      let ev;
      try {
        ev = JSON.parse(data.join('\n'));
      } catch (_) {
        continue;
      }
      if (!isObject(ev)) continue;
      if (typeof ev.c === 'number' && !(typeof ev.p === 'string' && ev.p !== '')) {
        roots[ev.c] = ev.v;
        cur = ev.c;
        lastP = '';
        lastO = 'add';
        continue;
      }
      const p = typeof ev.p === 'string' ? ev.p : lastP;
      const o = typeof ev.o === 'string' ? ev.o : lastO;
      lastP = p;
      lastO = o;
      if (o === 'patch') {
        if (cur < 0 || !Array.isArray(ev.v)) continue;
        for (const op of ev.v) {
          if (isObject(op) && typeof op.p === 'string') roots[cur] = applyOp(roots[cur], op.p, op.o, op.v);
        }
        continue;
      }
      if (p === '' && o === 'add') {
        roots.push(ev.v);
        cur = roots.length - 1;
        continue;
      }
      if (cur >= 0) roots[cur] = applyOp(roots[cur], p, o, ev.v);
    }
    return roots.filter((r) => r !== undefined);
  };

  const replyText = (m) =>
    isObject(m.content) && Array.isArray(m.content.parts)
      ? m.content.parts.filter((x) => typeof x === 'string').join('').trim()
      : '';

  /** A capture's request body as an object, or null. */
  const requestOf = (capture) => {
    if (!isObject(capture)) return null;
    try {
      const req = typeof capture.request === 'string' ? JSON.parse(capture.request) : capture.request;
      return isObject(req) ? req : null;
    } catch (_) {
      return null;
    }
  };

  /** What hook-iso.js has kept in this tab: [{url, request, stream, capturedAt}]. */
  const stored = () => {
    const store = self.__exporterChatGPT;
    return store && Array.isArray(store.sidebars) ? store.sidebars : [];
  };

  /**
   * The captures that belong to one conversation, as they are -- decodable
   * or not (debug capture keeps them all): the request names the
   * conversation, or one of its messages (a shared copy has another
   * conversation id).
   *
   * @param {Array<{request: string, stream: string}>} captures
   * @param {string} convId
   * @param {Set<string>} [messageIds] ids of the conversation's messages
   */
  const capturesFor = (captures, convId, messageIds) =>
    (Array.isArray(captures) ? captures : []).filter((c) => {
      const req = requestOf(c);
      if (!req) return false;
      if (req.conversation_id === convId) return true;
      return typeof req.message_id === 'string' && !!messageIds && messageIds.has(req.message_id);
    });

  /**
   * One captured panel → { messageId, name, message, finished } or null (not
   * an entity panel, or no reply text in it). `finished` is false when the
   * reply was cut off while it streamed (the panel closed before it was
   * written out); normalize.js prefers a finished copy of the same panel.
   *
   * @param {{request: string, stream: string}} capture
   */
  const parseCapture = (capture) => {
    const req = requestOf(capture);
    if (!req) return null;
    const params = isObject(req.generic_entity_params)
      ? req.generic_entity_params
      : isObject(req.reference_entity_params)
      ? req.reference_entity_params
      : null;
    const name = params && [params.name, params.query, params.title].find((v) => typeof v === 'string' && v.trim());
    if (!name) return null;
    // The reply: the last assistant message on the final channel with text.
    const messages = decodeStream(capture.stream)
      .filter((r) => isObject(r) && r.type === 'message' && isObject(r.data))
      .map((r) => r.data);
    const reply = messages
      .filter(
        (m) =>
          m.author && m.author.role === 'assistant' &&
          (m.channel === 'final' || (m.channel == null && m.recipient === 'all')) &&
          replyText(m)
      )
      .pop();
    if (!reply) return null;
    return {
      messageId: typeof req.message_id === 'string' ? req.message_id : null,
      name: name.trim(),
      message: reply,
      finished:
        reply.status === 'finished_successfully' || (isObject(reply.metadata) && reply.metadata.is_complete === true),
    };
  };

  /**
   * The panels in `captures` (capturesFor: one conversation's), in the order
   * they were opened. Every copy is kept: which message a panel goes under,
   * and which copy wins when a name was opened twice there, is normalize.js's
   * call (panelsByMessage).
   *
   * @param {Array<{request: string, stream: string}>} captures
   */
  const panelsFor = (captures) => (Array.isArray(captures) ? captures : []).map(parseCapture).filter(Boolean);

  ns.chatgptSidebar = { decodeStream, parseCapture, stored, capturesFor, panelsFor };
})();
