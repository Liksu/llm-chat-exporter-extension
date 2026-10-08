/**
 * ChatGPT "generative UI" answers (seen from gpt-6 on, Oct 2026).
 *
 * The model writes its reply as markdown mixed with JSX-like components;
 * the SPA compiles it (metadata.model_dil_v2) and renders cards, chips and
 * side panels. The raw text in content.parts keeps the tags:
 *
 *   layout     <box gap={2}> <row> <grid columns={2}> <grid-item> <text>
 *              <caption> <badge> <icon name="…"/> <divider/>
 *   data       <Link url="…" title="…"/>          inline link
 *              <Cite ref="turnNsearchM"/>          source chip
 *              <Cite refs={["…","…"]}/>
 *              <CodeCite tool="container" …/>      points at a code run
 *              <Entity category="product" value="TPS63802" disambig="…"/>
 *              <AsyncImage query="…" aspectRatio="5:3"/>  web image search
 *
 * What the tags resolved to sits in model_dil_v2.appData.opGenui
 * .componentResults (keyed by an opaque id, not by position): Cite items
 * carry {ref_id, refs[], url, title, source_label}, AsyncImage carries the
 * found images. The layout vocabulary mirrors OpenAI's ChatKit widgets;
 * the data components are undocumented.
 *
 * render() turns all of it into plain markdown: layout tags go away (their
 * content stays, de-indented so it isn't read as a code block), arrow
 * icons stay as ↓ → (the edges of the little flow diagrams the model
 * draws), Link → [title](url), Entity → its text, Cite → [[n]](url) plus a
 * Sources list, AsyncImage → the image it showed, CodeCite and other
 * icons → nothing. Unknown tags
 * are left as they are, and code (fenced or inline) is never touched.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Layout containers: their content becomes its own paragraph.
  const BLOCKS = new Set([
    'box', 'row', 'col', 'grid', 'grid-item', 'card', 'text', 'title', 'markdown',
    'list', 'list-item', 'list-view', 'list-view-item', 'label', 'form',
  ]);
  // Dropped with nothing in their place.
  const DROP = new Set(['CodeCite', 'spacer', 'Spacer']);
  // Rendered from their attributes / resolved data.
  const DATA = new Set(['Link', 'Cite', 'Entity', 'AsyncImage', 'image', 'Image', 'divider', 'Divider', 'icon', 'Icon']);
  // Inline wrappers: content kept, formatted.
  const WRAPS = { caption: (s) => `_${s}_`, badge: (s) => `_(${s})_` };

  const isKnown = (name) => BLOCKS.has(name) || DROP.has(name) || DATA.has(name) || name in WRAPS;

  const decodeEntities = (s) =>
    s.replace(/&(quot|amp|lt|gt|#39|apos);/g, (_, e) =>
      ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", apos: "'" })[e]);

  /**
   * Parse one tag starting at text[i] === '<'. Returns
   * { name, closing, selfClosing, attrs, end } or null when it isn't a tag.
   * Attribute values: "…", '…', {json-or-number} (braces may nest), or bare.
   */
  const parseTag = (text, i) => {
    const m = /^<(\/?)([A-Za-z][\w-]*)/.exec(text.slice(i, i + 64));
    if (!m) return null;
    const closing = m[1] === '/';
    const name = m[2];
    let j = i + m[0].length;
    const attrs = {};
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '>') return { name, closing, selfClosing: false, attrs, end: j + 1 };
      if (text[j] === '/' && text[j + 1] === '>') return { name, closing, selfClosing: true, attrs, end: j + 2 };
      const a = /^[\w-]+/.exec(text.slice(j, j + 64));
      if (!a || closing) return null;
      j += a[0].length;
      while (text[j] === ' ') j++;
      if (text[j] !== '=') {
        attrs[a[0]] = true;
        continue;
      }
      j++;
      while (text[j] === ' ') j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, j + 1);
        if (close < 0) return null;
        attrs[a[0]] = decodeEntities(text.slice(j + 1, close));
        j = close + 1;
      } else if (q === '{') {
        let depth = 0;
        let k = j;
        let inStr = null;
        for (; k < text.length; k++) {
          const c = text[k];
          if (inStr) {
            if (c === '\\') k++;
            else if (c === inStr) inStr = null;
          } else if (c === '"' || c === "'") inStr = c;
          else if (c === '{') depth++;
          else if (c === '}' && --depth === 0) break;
        }
        if (k >= text.length) return null;
        const raw = text.slice(j + 1, k).trim();
        let val = raw;
        try {
          val = JSON.parse(raw);
        } catch (_) {
          /* keep the raw expression */
        }
        attrs[a[0]] = val;
        j = k + 1;
      } else {
        const bare = /^[^\s/>]+/.exec(text.slice(j));
        if (!bare) return null;
        attrs[a[0]] = bare[0];
        j += bare[0].length;
      }
    }
  };

  const refKey = (r) =>
    isObject(r) && r.turn_index != null && r.ref_type && r.ref_index != null
      ? `turn${r.turn_index}${r.ref_type}${r.ref_index}`
      : '';

  /**
   * What the components resolved to: citation sources by ref id (from the
   * Cite results and metadata.search_result_groups) and the AsyncImage
   * images in order.
   */
  // Scraped page titles can be junk ("Product\nFolder\nTools &\n…" -- the
  // nav bar of a PDF landing page): those lose to any clean title of the
  // same source, and to the site label.
  const isMessy = (t) => typeof t !== 'string' || !t.trim() || /\n/.test(t.trim());
  const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();

  const resolvedData = (meta) => {
    const sources = new Map();
    const images = [];
    const add = (key, url, title, label) => {
      if (!key || typeof url !== 'string' || !url) return;
      // rank: clean title 3 > site label 2 > flattened junk 1 > url 0
      const [t, rank] = !isMessy(title) ? [title, 3] : !isMessy(label) ? [label, 2] : title ? [oneLine(title), 1] : [url, 0];
      const s = sources.get(key);
      if (!s || s.url !== url) {
        if (!s) sources.set(key, { url, title: t, rank });
      } else if (rank > s.rank) Object.assign(s, { title: t, rank });
    };
    const dil = isObject(meta) && isObject(meta.model_dil_v2) ? meta.model_dil_v2 : null;
    const gen = dil && isObject(dil.appData) && isObject(dil.appData.opGenui) ? dil.appData.opGenui : null;
    const results = gen && isObject(gen.componentResults) ? gen.componentResults : {};
    for (const r of Object.values(results)) {
      if (!isObject(r) || r.status !== 'resolved' || !isObject(r.state)) continue;
      if (r.componentName === 'Cite' && Array.isArray(r.state.items)) {
        for (const it of r.state.items) {
          if (!isObject(it)) continue;
          add(it.ref_id, it.url, it.title, it.source_label);
          for (const ref of Array.isArray(it.refs) ? it.refs : []) add(refKey(ref), it.url, it.title, it.source_label);
        }
      } else if (r.componentName === 'AsyncImage' && Array.isArray(r.state.images)) {
        // url is the page the image was found on; the picture itself is
        // original_content_url (its site) or content_url (OpenAI's copy).
        const img = r.state.images.find((x) => isObject(x) && (x.original_content_url || x.content_url));
        if (img) {
          images.push({
            src: img.original_content_url || img.content_url,
            page: typeof img.url === 'string' ? img.url : '',
            title: img.title || '',
          });
        }
      }
    }
    for (const g of Array.isArray(meta && meta.search_result_groups) ? meta.search_result_groups : []) {
      for (const e of isObject(g) && Array.isArray(g.entries) ? g.entries : []) {
        if (isObject(e)) add(refKey(e.ref_id), e.url, e.title, e.attribution);
      }
    }
    return { sources, images };
  };

  const linkText = (s) => oneLine(s).replace(/[[\]]/g, '');

  // Icons that carry meaning in a diagram (the flow arrows between boxes);
  // every other icon is decoration.
  const ARROWS = { 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→', 'arrow-left': '←' };

  /**
   * Render the components of one text (outside code) into markdown.
   * `state` carries the container depth across fenced-code chunks, cited
   * sources (numbered per message) and the queue of AsyncImage results.
   */
  const renderChunk = (text, state) => {
    let out = '';
    let i = 0;
    const emitText = (s) => {
      if (state.depth > 0) {
        // Content inside containers is indented by the JSX nesting; strip it
        // so markdown doesn't read it as a code block.
        s = s.replace(/\n[ \t]+/g, '\n');
        if (out === '' || out.endsWith('\n')) s = s.replace(/^[ \t]+/, '');
      }
      out += s;
    };
    const wraps = [];
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) {
        emitText(text.slice(i));
        break;
      }
      emitText(text.slice(i, lt));
      const tag = parseTag(text, lt);
      if (!tag || !isKnown(tag.name)) {
        out += '<';
        i = lt + 1;
        continue;
      }
      i = tag.end;
      const { name, attrs } = tag;
      if (BLOCKS.has(name)) {
        if (tag.selfClosing) continue;
        state.depth = Math.max(0, state.depth + (tag.closing ? -1 : 1));
        out += '\n\n';
      } else if (name === 'icon' || name === 'Icon') {
        if (ARROWS[attrs.name]) out += ARROWS[attrs.name];
      } else if (name in WRAPS) {
        if (tag.selfClosing) continue;
        if (!tag.closing) {
          wraps.push({ name, at: out.length });
        } else {
          const open = wraps.pop();
          if (open) {
            const inner = out.slice(open.at).trim();
            out = out.slice(0, open.at) + (inner && !inner.includes('\n') ? WRAPS[open.name](inner) : inner);
          }
        }
      } else if (DROP.has(name)) {
        /* nothing */
      } else if (name === 'Link') {
        const url = typeof attrs.url === 'string' ? attrs.url : '';
        const title = typeof attrs.title === 'string' && attrs.title ? attrs.title : url;
        out += url ? `[${linkText(title)}](${url})` : title;
      } else if (name === 'Entity') {
        out += String(attrs.value || attrs.name || '');
      } else if (name === 'Cite') {
        const refs = [];
        if (typeof attrs.ref === 'string') refs.push(attrs.ref);
        if (Array.isArray(attrs.refs)) refs.push(...attrs.refs.filter((r) => typeof r === 'string'));
        const marks = [];
        for (const r of refs) {
          const src = state.data.sources.get(r);
          if (!src) continue;
          if (!state.cited.has(src.url)) state.cited.set(src.url, { n: state.cited.size + 1, title: src.title });
          const n = state.cited.get(src.url).n;
          const mark = `[[${n}]](${src.url})`;
          if (!marks.includes(mark)) marks.push(mark);
        }
        out += marks.join('');
      } else if (name === 'AsyncImage') {
        const img = state.data.images[state.imageIndex++];
        if (img) {
          const pic = `![${linkText(img.title || attrs.query || 'image')}](${img.src})`;
          out += `\n\n${img.page ? `[${pic}](${img.page})` : pic}\n\n`;
        }
      } else if (name === 'image' || name === 'Image') {
        const src = typeof attrs.src === 'string' ? attrs.src : '';
        if (src) out += `![${linkText(attrs.alt || '')}](${src})`;
      } else if (name === 'divider' || name === 'Divider') {
        out += '\n\n---\n\n';
      }
    }
    return out;
  };

  /**
   * @param {string} text  content.parts text of an assistant message
   * @param {object} meta  its metadata (model_dil_v2, search_result_groups)
   * @returns {string} markdown
   */
  const render = (text, meta) => {
    if (typeof text !== 'string' || !text.includes('<')) return text;
    const state = { depth: 0, cited: new Map(), imageIndex: 0, data: resolvedData(meta) };
    // Split off fenced code; protect inline code spans inside the rest.
    const lines = text.split('\n');
    const chunks = [];
    let buf = [];
    let fence = null;
    for (const line of lines) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        buf.push(line);
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
          chunks.push({ code: true, text: buf.join('\n') });
          buf = [];
          fence = null;
        }
      } else if (f) {
        if (buf.length) chunks.push({ code: false, text: buf.join('\n') });
        buf = [line];
        fence = f[1];
      } else {
        buf.push(line);
      }
    }
    if (buf.length) chunks.push({ code: !!fence, text: buf.join('\n') });

    let out = '';
    for (const c of chunks) {
      if (out) out += '\n';
      if (c.code) {
        out += c.text;
        continue;
      }
      const spans = [];
      const masked = c.text.replace(/(`+)[\s\S]*?\1/g, (s) => {
        spans.push(s);
        return `\u0000${spans.length - 1}\u0000`;
      });
      // Tidy the blank lines and stray hard breaks the removed tags left.
      const trailing = /\n*$/.exec(masked)[0];
      out += renderChunk(masked, state)
        .replace(/[ \t]+\n(?=[ \t]*\n)/g, '\n')
        .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
        .replace(/[ \t]+$/, '')
        .replace(/\n*$/, trailing)
        .replace(/\u0000(\d+)\u0000/g, (_, n) => spans[Number(n)]);
    }
    out = out.trim();
    if (state.cited.size) {
      const rows = [...state.cited].map(([url, s]) => `${s.n}. [${linkText(s.title)}](${url})`);
      out += `\n\n**Sources**\n\n${rows.join('\n')}`;
    }
    return out;
  };

  /** True when the message was written for the generative UI renderer. */
  const isGenUi = (meta) => isObject(meta) && isObject(meta.model_dil_v2);

  ns.chatgptGenui = { render, isGenUi, parseTag };
})();
