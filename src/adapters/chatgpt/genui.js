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
 *              <AsyncImage ref="turnNbusinessM"/>  photo of a place
 *              <MapWidgetV2 points={[{"ref":"turnNbusinessM"},…]}/>  map
 *              <WritingBlock variant="chat_message">…</WritingBlock>  draft
 *                                                   to copy (a card)
 *              {turnNbusinessM.address}            a place's field
 *
 * What the tags resolved to sits in model_dil_v2.appData.opGenui
 * .componentResults (keyed by an opaque id, not by position): Cite items
 * carry {ref_id, refs[], url, title, source_label}, AsyncImage carries the
 * found images. Places (local businesses) the answer names are bound in
 * opGenui.modelDataBindings ({name, address, …} by ref) or, when that is
 * empty, known only from their photo's AsyncImage result (name and address
 * in its click action). The layout vocabulary mirrors OpenAI's ChatKit
 * widgets; the data components are undocumented.
 *
 * render() turns all of it into plain markdown: layout tags go away (their
 * content stays, de-indented so it isn't read as a code block), arrow
 * icons stay as ↓ → (the edges of the little flow diagrams the model
 * draws), a grid → a list (one item per tile), Link → [title](url),
 * Entity → its text, Cite → inline source links like the chips
 * ([Reddit](url)), AsyncImage → the image it showed, a map → a list of its
 * places with map links, WritingBlock → a ```text block (a draft to copy
 * and send as is, like the card's copy button), CodeCite and other icons
 * → nothing. {#each}/{#if} template blocks and {place.field} values are
 * expanded first; a place the chat never resolved renders as nothing (as
 * on the page). Unknown tags are left as they are, and code (fenced or
 * inline) is never touched.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Layout containers: their content becomes its own paragraph.
  const BLOCKS = new Set([
    'box', 'row', 'col', 'grid', 'grid-item', 'card', 'text', 'markdown',
    'list', 'list-item', 'list-view', 'list-view-item', 'label', 'form',
  ]);
  // Dropped with nothing in their place.
  const DROP = new Set(['CodeCite', 'spacer', 'Spacer']);
  // Rendered from their attributes / resolved data.
  const DATA = new Set([
    'Link', 'Cite', 'Entity', 'AsyncImage', 'MapWidgetV2', 'MapWidget', 'image', 'Image',
    'divider', 'Divider', 'icon', 'Icon',
  ]);
  // Containers whose content becomes a text block (drafts to copy).
  const DRAFTS = new Set(['WritingBlock']);
  // Inline wrappers: content kept, formatted.
  const WRAPS = { caption: (s) => `_${s}_`, badge: (s) => `_(${s})_`, title: (s) => `**${s}**` };

  const isKnown = (name) => BLOCKS.has(name) || DROP.has(name) || DATA.has(name) || DRAFTS.has(name) || name in WRAPS;

  // A data binding the model refers to: turn620995business0(.name).
  const BINDING_RE = /^turn\d+[a-z_]+\d+\b/;

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
    // Places by ref: {name, address, url?} (+ whatever else the binding has).
    const places = new Map();
    const addPlace = (key, fields) => {
      if (!key || !isObject(fields)) return;
      const p = places.get(key) || {};
      for (const [k, v] of Object.entries(fields)) if (p[k] == null && v != null && v !== '') p[k] = v;
      places.set(key, p);
    };
    const add = (key, url, title, label) => {
      if (!key || typeof url !== 'string' || !url) return;
      // rank: clean title 3 > site label 2 > flattened junk 1 > url 0
      const [t, rank] = !isMessy(title) ? [title, 3] : !isMessy(label) ? [label, 2] : title ? [oneLine(title), 1] : [url, 0];
      const s = sources.get(key);
      if (!s) sources.set(key, { url, title: t, rank, label: !isMessy(label) ? oneLine(label) : '' });
      else if (s.url === url) {
        if (rank > s.rank) Object.assign(s, { title: t, rank });
        if (!s.label && !isMessy(label)) s.label = oneLine(label);
      }
    };
    const dil = isObject(meta) && isObject(meta.model_dil_v2) ? meta.model_dil_v2 : null;
    const gen = dil && isObject(dil.appData) && isObject(dil.appData.opGenui) ? dil.appData.opGenui : null;
    const results = gen && isObject(gen.componentResults) ? gen.componentResults : {};
    const bindings = gen && isObject(gen.modelDataBindings) ? gen.modelDataBindings : {};
    for (const [key, b] of Object.entries(bindings)) addPlace(key, b);
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
          const src = img.original_content_url || img.content_url;
          // A place's photo links to the place's site, or to the photo itself.
          const page = typeof img.url === 'string' && img.url !== src && img.url !== img.content_url ? img.url : '';
          const ref = refKey(Array.isArray(img.refs) ? img.refs[0] : null);
          images.push({ src, page, title: img.title || '', ref });
          const action = isObject(r.state.default_on_click_action) ? r.state.default_on_click_action.payload : null;
          if (ref && isObject(action) && action.category === 'local_business') {
            const extra = isObject(action.extraParams) ? action.extraParams : {};
            addPlace(ref, { name: action.query || img.title, address: extra.address, url: page });
          }
        }
      }
    }
    for (const g of Array.isArray(meta && meta.search_result_groups) ? meta.search_result_groups : []) {
      for (const e of isObject(g) && Array.isArray(g.entries) ? g.entries : []) {
        if (isObject(e)) add(refKey(e.ref_id), e.url, e.title, e.attribution);
      }
    }
    return { sources, images, places };
  };

  /** A Google Maps search for a place: what clicking it on the map shows. */
  const mapLink = (p) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address].filter(Boolean).join(', '))}`;

  const linkText = (s) => oneLine(s).replace(/[[\]]/g, '');

  /** Site name for an inline source link: the chip label, else the host. */
  const siteName = (src) => {
    if (src.label) return src.label;
    try {
      return new URL(src.url).hostname.replace(/^www\./, '');
    } catch (_) {
      return src.title;
    }
  };

  /**
   * Inline source links, like the chips in the chat: `([Reddit](url "page
   * title"), [ti.com](url))`. The page title rides along as the link title
   * (shown on hover) so the text stays short.
   */
  const inlineSources = (list) => {
    const seen = new Set();
    const links = [];
    for (const src of list) {
      if (!src || seen.has(src.url)) continue;
      seen.add(src.url);
      const hover = src.rank >= 2 && src.title !== siteName(src) ? ` "${oneLine(src.title).replace(/"/g, "'")}"` : '';
      links.push(`[${linkText(siteName(src))}](${src.url}${hover})`);
    }
    return links.length ? `(${links.join(', ')})` : '';
  };

  /** Grid cells → a list, one item per cell, its lines joined by " — ". */
  const gridList = (cells) => {
    const items = cells
      .map((c) => c.split('\n').map((l) => l.trim()).filter(Boolean).join(' — '))
      .filter(Boolean);
    return items.length ? `\n\n${items.map((x) => `- ${x}`).join('\n')}\n\n` : '';
  };

  // Icons that carry meaning in a diagram (the flow arrows between boxes);
  // every other icon is decoration.
  const ARROWS = { 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→', 'arrow-left': '←' };

  // -- Templates ------------------------------------------------------------
  // Besides tags the model writes Svelte-style blocks to repeat markup:
  //   {#each [{a:"R",b:"Reset"},…] as p} <title>{p.a}</title> {/each}
  //   {#if x} … {:else} … {/if}
  // They are expanded before the tags are rendered. Only literal data and
  // names bound by an enclosing #each are evaluated; anything else is left
  // as written (the audit flags leftovers).

  /** Parse a JS literal (array/object/string/number/bool/null, bare keys). */
  const parseLiteral = (src) => {
    let i = 0;
    const ws = () => {
      while (i < src.length && /\s/.test(src[i])) i++;
    };
    const fail = () => {
      throw new Error('not a literal');
    };
    const value = () => {
      ws();
      const c = src[i];
      if (c === '[') {
        i++;
        const arr = [];
        ws();
        if (src[i] === ']') return i++, arr;
        for (;;) {
          arr.push(value());
          ws();
          if (src[i] === ',') {
            i++;
            ws();
            if (src[i] === ']') return i++, arr;
          } else if (src[i] === ']') return i++, arr;
          else fail();
        }
      }
      if (c === '{') {
        i++;
        const obj = {};
        ws();
        if (src[i] === '}') return i++, obj;
        for (;;) {
          ws();
          let key;
          if (src[i] === '"' || src[i] === "'") key = value();
          else {
            const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
            if (!m) fail();
            key = m[0];
            i += key.length;
          }
          ws();
          if (src[i++] !== ':') fail();
          obj[key] = value();
          ws();
          if (src[i] === ',') {
            i++;
            ws();
            if (src[i] === '}') return i++, obj;
          } else if (src[i] === '}') return i++, obj;
          else fail();
        }
      }
      if (c === '"' || c === "'") {
        let out = '';
        for (i++; i < src.length && src[i] !== c; i++) {
          if (src[i] === '\\') {
            const e = src[++i];
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          } else out += src[i];
        }
        if (src[i] !== c) fail();
        i++;
        return out;
      }
      const m = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(src.slice(i));
      if (!m) fail();
      i += m[0].length;
      return JSON.parse(m[0]);
    };
    const v = value();
    ws();
    if (i !== src.length) fail();
    return v;
  };

  const MISSING = Symbol('missing');

  /** Evaluate a literal or a dotted path (p.a, p.items[0]) in scope. */
  const evaluate = (expr, scope) => {
    const e = expr.trim();
    const path = /^([A-Za-z_$][\w$]*)((?:\.[\w$]+|\[\d+\])*)$/.exec(e);
    if (path) {
      if (!Object.prototype.hasOwnProperty.call(scope, path[1])) return MISSING;
      let v = scope[path[1]];
      for (const step of path[2].match(/\.[\w$]+|\[\d+\]/g) || []) {
        if (v == null) return undefined;
        v = v[step[0] === '.' ? step.slice(1) : Number(step.slice(1, -1))];
      }
      return v;
    }
    try {
      return parseLiteral(e);
    } catch (_) {
      return MISSING;
    }
  };

  /** Index just past the `}` closing the brace at `open` (strings respected). */
  const braceEnd = (text, open) => {
    let depth = 0;
    let str = null;
    for (let k = open; k < text.length; k++) {
      const c = text[k];
      if (str) {
        if (c === '\\') k++;
        else if (c === str) str = null;
      } else if (c === '"' || c === "'") str = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return k + 1;
    }
    return -1;
  };

  /**
   * Find the block that `{#kind …}` at `at` opens: its header expression,
   * the top-level `{:…}` branch markers and the matching `{/kind}`.
   */
  const scanBlock = (text, at, kind) => {
    const headEnd = braceEnd(text, at);
    if (headEnd < 0) return null;
    const head = text.slice(at + 2 + kind.length, headEnd - 1);
    const branches = [];
    let depth = 0;
    let k = headEnd;
    let bodyAt = headEnd;
    while (k < text.length) {
      const j = text.indexOf('{', k);
      if (j < 0) return null;
      const tag = /^\{([#:/])(\w+)/.exec(text.slice(j, j + 16));
      const end = braceEnd(text, j);
      if (end < 0) return null;
      if (tag && tag[1] === '#') depth++;
      else if (tag && tag[1] === '/' && depth > 0) depth--;
      else if (tag && tag[1] === '/' && tag[2] === kind) {
        branches.push({ cond: null, body: text.slice(bodyAt, j) });
        return { head, branches, end };
      } else if (tag && tag[1] === ':' && depth === 0) {
        branches.push({ cond: null, body: text.slice(bodyAt, j) });
        branches[branches.length - 1].next = text.slice(j + 2, end - 1).trim();
        bodyAt = end;
      }
      k = end;
    }
    return null;
  };

  const expandTemplates = (text, scope) => {
    if (!/\{[#\w$]/.test(text)) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf('{', i);
      if (j < 0) break;
      out += text.slice(i, j);
      const block = /^\{#(each|if)\s/.exec(text.slice(j, j + 8));
      if (block) {
        const b = scanBlock(text, j, block[1]);
        if (!b) {
          out += text.slice(j);
          return out;
        }
        if (block[1] === 'each') {
          const h = /^\s*([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*$/.exec(b.head);
          const list = h ? evaluate(h[1], scope) : MISSING;
          if (!Array.isArray(list)) {
            out += text.slice(j, b.end);
          } else {
            list.forEach((item, n) => {
              const inner = { ...scope, [h[2]]: item };
              if (h[3]) inner[h[3]] = n;
              out += expandTemplates(b.branches[0].body, inner);
            });
          }
        } else {
          // {#if a}…{:else if b}…{:else}…{/if}
          let cond = b.head;
          let chosen = null;
          let unknown = false;
          for (const br of b.branches) {
            const v = cond === null ? true : evaluate(cond, scope);
            if (v === MISSING) {
              unknown = true;
              break;
            }
            if (v) {
              chosen = br;
              break;
            }
            cond = br.next === undefined ? false : br.next === 'else' ? null : br.next.replace(/^else\s+if\s+/, '');
            if (cond === false) break;
          }
          if (unknown) out += text.slice(j, b.end);
          else if (chosen) out += expandTemplates(chosen.body, scope);
        }
        i = b.end;
        continue;
      }
      // {name.path} bound by an enclosing #each.
      const end = braceEnd(text, j);
      const expr = end > 0 ? text.slice(j + 1, end - 1) : '';
      let v = /^[A-Za-z_$][\w$.[\]]*$/.test(expr) ? evaluate(expr, scope) : MISSING;
      // A place the chat never resolved shows nothing on the page either.
      if (v === MISSING && BINDING_RE.test(expr)) v = undefined;
      if (v === MISSING || end < 0) {
        out += '{';
        i = j + 1;
        continue;
      }
      const s = v == null ? '' : String(v);
      // As an attribute value (title={p.b}) it must stay one quoted token.
      const inTag = out.lastIndexOf('<') > out.lastIndexOf('>');
      out += inTag && out.endsWith('=') ? JSON.stringify(s) : s;
      i = end;
    }
    return out + text.slice(i);
  };

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
    const drafts = [];
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
      if (DRAFTS.has(name)) {
        if (tag.selfClosing) continue;
        if (!tag.closing) {
          drafts.push(out.length);
        } else if (drafts.length) {
          const at = drafts.pop();
          const inner = out.slice(at).trim();
          // Longer than any backtick run inside, so the draft can't close it.
          const run = Math.max(0, ...(inner.match(/`+/g) || []).map((r) => r.length));
          const fence = '`'.repeat(Math.max(3, run + 1));
          out = out.slice(0, at) + (inner ? `\n\n${fence}text\n${inner}\n${fence}\n\n` : '');
        }
      } else if (BLOCKS.has(name)) {
        if (tag.selfClosing) continue;
        // A grid's direct children are its cells; each becomes one list
        // item with its lines joined (R — Reset), so a row of tiles stays
        // a compact list instead of a column of one-word paragraphs.
        const grid = state.grids[state.grids.length - 1];
        if (tag.closing) {
          if (grid && state.depth === grid.depth + 1 && grid.cellAt != null) {
            grid.cells.push(out.slice(grid.cellAt));
            out = out.slice(0, grid.cellAt);
            grid.cellAt = null;
          } else if (grid && name === 'grid' && state.depth === grid.depth) {
            state.grids.pop();
            out = out.slice(0, grid.at) + gridList(grid.cells) + out.slice(grid.at);
          }
          state.depth = Math.max(0, state.depth - 1);
          out += '\n\n';
        } else {
          state.depth += 1;
          out += '\n\n';
          if (name === 'grid') state.grids.push({ depth: state.depth, cells: [], at: out.length, cellAt: null });
          else if (grid && state.depth === grid.depth + 1) grid.cellAt = out.length;
        }
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
        const place = typeof attrs.ref === 'string' ? state.data.places.get(attrs.ref) : null;
        const value = [attrs.value, attrs.name].find((v) => typeof v === 'string' && v && !BINDING_RE.test(v));
        const label = (place && place.name) || value || '';
        out += label && place && typeof place.url === 'string' && place.url ? `[${linkText(label)}](${place.url})` : label;
      } else if (name === 'Cite') {
        const refs = [];
        if (typeof attrs.ref === 'string') refs.push(attrs.ref);
        if (Array.isArray(attrs.refs)) refs.push(...attrs.refs.filter((r) => typeof r === 'string'));
        out += inlineSources(refs.map((r) => state.data.sources.get(r)));
      } else if (name === 'AsyncImage') {
        // A place's photo is found by its ref; other images go in order.
        const ref = typeof attrs.ref === 'string' ? attrs.ref : '';
        const free = state.data.images.filter((x) => !state.usedImages.has(x));
        const img = ref ? free.find((x) => x.ref === ref) : free.find((x) => !x.ref) || free[0];
        if (img) {
          state.usedImages.add(img);
          const pic = `![${linkText(img.title || attrs.query || 'image')}](${img.src})`;
          out += `\n\n${img.page ? `[${pic}](${img.page})` : pic}\n\n`;
        }
      } else if (name === 'MapWidgetV2' || name === 'MapWidget') {
        const points = Array.isArray(attrs.points) ? attrs.points : [];
        const items = points
          .map((pt) => (isObject(pt) ? (typeof pt.ref === 'string' && state.data.places.get(pt.ref)) || pt : null))
          .filter((p) => p && typeof p.name === 'string' && p.name)
          .map((p) => `- 📍 [${linkText(p.name)}](${mapLink(p)})${p.address ? ` — ${oneLine(p.address)}` : ''}`);
        if (items.length) out += `\n\n🗺️ **Map**\n\n${items.join('\n')}\n\n`;
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
    const data = resolvedData(meta);
    const state = { depth: 0, grids: [], usedImages: new Set(), data };
    // {turnNbusinessM.address} reads the place's fields.
    const scope = Object.fromEntries(data.places);
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
      // Inline code is masked first, so neither templates nor tags in it
      // are touched.
      const masked = expandTemplates(c.text.replace(/(`+)[\s\S]*?\1/g, (s) => {
        spans.push(s);
        return `\u0000${spans.length - 1}\u0000`;
      }), scope);
      // Tidy the blank lines and stray hard breaks the removed tags left.
      const trailing = /\n*$/.exec(masked)[0];
      out += renderChunk(masked, state)
        // **<Entity/>** of a place the chat never resolved.
        .replace(/^[ \t]*\*\*[ \t]*\*\*[ \t]*$/gm, '')
        .replace(/[ \t]+\n(?=[ \t]*\n)/g, '\n')
        .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
        .replace(/[ \t]+$/, '')
        .replace(/\n*$/, trailing)
        .replace(/\u0000(\d+)\u0000/g, (_, n) => spans[Number(n)]);
    }
    return out.trim();
  };

  /** True when the message was written for the generative UI renderer. */
  const isGenUi = (meta) => isObject(meta) && isObject(meta.model_dil_v2);

  ns.chatgptGenui = { render, isGenUi, parseTag };
})();
