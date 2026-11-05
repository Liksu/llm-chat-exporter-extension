/**
 * ChatGPT "generative UI" answers (seen from gpt-6 on, Oct 2026).
 *
 * The model writes its reply as markdown mixed with JSX-like components
 * and a little program; the SPA compiles it (metadata.model_dil_v2:
 * {code, constants, fallbackMarkdown, appData.opGenui}) and renders cards,
 * chips, controls and side panels. The raw text in content.parts keeps it
 * all. The modules under genui/ turn it into plain markdown:
 *
 *   parse.js     tags
 *   expr.js      the expressions in them (a small, bounded interpreter)
 *   core.js      the component registry, the resolved data, shared helpers
 *   template.js  the program: state, {#each}/{#if}, {values}
 *   svg.js       <svg> drawings, kept as valid SVG
 *   components/  layout, data, controls, widgets -- one renderer per tag
 *   render.js    this: the walk over the text, and the safety net
 *
 * render() expands the program first, then renders the tags: a known tag
 * by its registered renderer, an unknown one is left as is. Code (fenced or
 * inline) is never touched. A tag opened in the middle of a line and
 * closed on it (a table cell written as `| <text>…</text> |`) stays inline,
 * and so does anything a component renders inside a table row, so the row
 * isn't split.
 *
 * Safety net: when component markup or template syntax is still left after
 * that (a widget this doesn't know yet, a program it can't work out), the
 * message is exported from model_dil_v2.fallbackMarkdown instead -- the
 * server's own static version, written in the legacy marker format
 * (U+E200 type U+E202 args U+E201). Its markers that need the genui data
 * (cite, filecite, image_group, genui{…}) are resolved here; entity, url
 * and the rest are left to normalize.js's marker handling.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { isObject, parseTag } = g.parse;
  const { resolvedData, takeResult, imageOf } = g.data;
  const { inlineSources, picture, listItem } = g.util;
  const { expandTemplates } = g.template;
  const { svgMarkup } = g.svg;
  const registry = g.registry;

  /** Grid cells → a list, one item per cell (listItem). */
  const gridList = (cells) => {
    const items = cells.map(listItem).filter(Boolean);
    return items.length ? `\n\n${items.join('\n')}\n\n` : '';
  };

  // Inline code spans -- but not the template strings of an expression
  // (d={`M160 ${n.y} v22`}, {`${x}%`}), which are matched first and kept.
  const CODE_SPAN_RE = /=?\{(?:[^{}`\n]|\{[^{}\n]*\}|`(?:\\.|[^`\\\n])*`)*`(?:\\.|[^`\\\n])*`(?:[^{}`\n]|\{[^{}\n]*\}|`(?:\\.|[^`\\\n])*`)*\}|(`+)[\s\S]*?\1/g;

  /** Render state of one message: data, used results, open containers. */
  const newState = (data) => {
    const state = { depth: 0, grids: [], blocks: [], collects: [], usedImages: new Set(), data };
    state.take = (name, match) => takeResult(data, name, match);
    state.parent = (name) => {
      for (let k = state.collects.length - 1; k >= 0; k--) if (state.collects[k].name === name) return state.collects[k].attrs;
      return null;
    };
    return state;
  };

  /**
   * Render the components of one text (outside code) into markdown.
   * `state` carries the container depth across fenced-code chunks, the
   * resolved data and what of it is used.
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
    const line = () => out.slice(out.lastIndexOf('\n') + 1);
    // In a table row, what a component renders stays on the row.
    const place = (s, ownLine) => {
      if (/^[ \t]*\|/.test(line())) {
        if (s.includes('\n')) s = s.replace(/\s*\n\s*/g, ' ').trim();
        s = s.replace(/(^|[^\\])\|/g, '$1\\|');
        if (s && out.endsWith('|')) s = ` ${s}`;
      } else if (ownLine && s) {
        out = out.replace(/[ \t]+$/, '');
        // Items repeated by {#each} (checkboxes, cards): one tight list.
        if (/^- /.test(s) && /\n- [^\n]*\n[ \t]*\n$/.test(out)) out = out.replace(/\n[ \t]*\n$/, '\n');
        else if (line().trim()) s = `\n${s}`;
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
      const spec = tag && registry.get(tag.name);
      if (!spec) {
        out += '<';
        i = lt + 1;
        continue;
      }
      i = tag.end;
      const { name } = tag;
      // Values nobody worked out (handlers, unknown state) aren't data.
      const attrs = { ...tag.attrs };
      for (const k of tag.exprs) delete attrs[k];
      if (spec.kind === 'draft') {
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
      } else if (spec.kind === 'block') {
        if (tag.selfClosing) continue;
        // Opened after other text on the line and closed on that line (a
        // table cell, a phrase): it stays inline.
        if (!tag.closing) {
          const eol = text.indexOf('\n', i);
          const close = text.indexOf(`</${name}>`, i);
          const inline = line().trim() !== '' && close >= 0 && (eol < 0 || close < eol);
          state.blocks.push(inline);
          if (inline) {
            if (!/\s$/.test(out)) out += ' ';
            continue;
          }
        } else if (state.blocks.pop()) continue;
        // A grid's direct children are its cells; each becomes one list
        // item with its lines joined (R — Reset), so a row of tiles stays
        // a compact list instead of a column of one-word paragraphs.
        const grid = state.grids[state.grids.length - 1];
        if (tag.closing) {
          if (grid && state.depth === grid.depth + 1 && grid.cellAt != null) {
            grid.cells.push(out.slice(grid.cellAt));
            out = out.slice(0, grid.cellAt);
            grid.cellAt = null;
          } else if (grid && spec.list && state.depth === grid.depth) {
            state.grids.pop();
            out = out.slice(0, grid.at) + gridList(grid.cells) + out.slice(grid.at);
          }
          state.depth = Math.max(0, state.depth - 1);
          out += '\n\n';
        } else {
          state.depth += 1;
          out += '\n\n';
          if (spec.list) state.grids.push({ depth: state.depth, cells: [], at: out.length, cellAt: null });
          else if (grid && state.depth === grid.depth + 1) grid.cellAt = out.length;
        }
      } else if (spec.kind === 'wrap') {
        if (tag.selfClosing) continue;
        if (!tag.closing) {
          wraps.push({ spec, at: out.length });
        } else {
          const open = wraps.pop();
          if (open) {
            const inner = out.slice(open.at).trim();
            out = out.slice(0, open.at) + (inner && !inner.includes('\n') ? open.spec.wrap(inner) : inner);
          }
        }
      } else if (spec.kind === 'leaf') {
        if (tag.closing) continue;
        const r = spec.render(attrs, state);
        // Can't be rendered: left as written, for the safety net.
        if (r == null) out += text.slice(lt, tag.end);
        else place(r, false);
      } else if (spec.kind === 'collect') {
        if (!tag.closing) {
          const entry = { name, spec, attrs, at: out.length };
          if (tag.selfClosing) {
            place(spec.render(attrs, '', state) || '', spec.line);
          } else state.collects.push(entry);
        } else {
          let k = state.collects.length - 1;
          while (k >= 0 && state.collects[k].name !== name) k--;
          if (k < 0) continue;
          const entry = state.collects[k];
          state.collects.length = k;
          const inner = out.slice(entry.at);
          out = out.slice(0, entry.at);
          place(entry.spec.render(entry.attrs, inner, state) || '', entry.spec.line);
        }
      }
      // spec.kind === 'drop': nothing
    }
    return out;
  };

  // Component tags (<Rating …/>, <date-picker>, <x attr={…}>) and template
  // syntax ({#if}, {@body}, DIL.) a render left behind, outside code.
  const LEFTOVER_RE =
    /<\/?[A-Z][A-Za-z0-9]*(?=[\s/>])|<[a-z]\w*-[\w-]*(?=[\s/>])|<[a-z][\w-]*\s[^<>\n]*=\{|\{[#:/](?:each|if|else|await|key)\b|\{@\w+|\bDIL\.\w+|\[object Object\]/;
  /** True when markdown still carries UI markup outside its code. */
  const unrendered = (md) =>
    LEFTOVER_RE.test(md.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '').replace(/(`+)[\s\S]*?\1/g, ''));

  /**
   * The server's static version of a message, its genui markers resolved:
   * cite → source links, filecite → the file, image_group → the pictures,
   * genui{"map_widget_v2": {…}} → that component's renderer.
   */
  const fallback = (meta) => {
    const dil = isObject(meta) && isObject(meta.model_dil_v2) ? meta.model_dil_v2 : {};
    if (typeof dil.fallbackMarkdown !== 'string' || !dil.fallbackMarkdown.trim()) return null;
    const state = newState(resolvedData(meta));
    const { data } = state;
    const pool = [...data.images, ...(data.results.get('AsyncImageGroup') || []).flatMap((r) => (Array.isArray(r.state.images) ? r.state.images : []).map(imageOf))]
      .filter(Boolean);
    const used = new Set();
    const pick = (match) => {
      const img = pool.find((x) => !used.has(x) && match(x));
      if (img) used.add(img);
      return img;
    };
    const json = (s) => {
      try {
        return JSON.parse(s);
      } catch (_) {
        return null;
      }
    };
    return dil.fallbackMarkdown
      .replace(/([^]*)/g, (marker, body) => {
        const [type, ...args] = body.split('');
        if (type === 'cite') return inlineSources(args.map((r) => data.sources.get(r)));
        if (type === 'filecite') {
          const lines = /^L(\d+)(?:-L(\d+))?$/.exec(args[1] || '') || [];
          return registry.get('FileCite').render({ ref: args[0], line_range_start: lines[1], line_range_end: lines[2] }, state);
        }
        const v = json(args[0]);
        if (type === 'image_group' && isObject(v)) {
          const refs = Array.isArray(v.entity_refs) ? v.entity_refs : [];
          const queries = Array.isArray(v.query) ? v.query : [];
          const pics = [...refs.map((r) => pick((x) => x.ref === r)), ...queries.map((q) => pick((x) => x.query === q))].filter(Boolean);
          return pics.length ? `\n\n${pics.map((x) => picture(x, x.query)).join(' ')}\n\n` : '';
        }
        if (type === 'genui' && isObject(v)) {
          return Object.entries(v)
            .map(([key, attrs]) => {
              const spec = registry.byMarker(key);
              return spec && isObject(attrs) ? spec.render(attrs, state) || '' : '';
            })
            .join('');
        }
        return marker; // entity, url, …: normalize.js
      })
      // Its buttons, shown as bracketed labels with no link ("[Previous] /
      // [Next]"): dropped, as in our own rendering.
      .replace(/^[ \t]*\[[^\]\n]*\](?![(:])(?:[ \t]*[/|·]?[ \t]*\[[^\]\n]*\](?![(:]))*[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  /**
   * @param {string} text  content.parts text of an assistant message
   * @param {object} meta  its metadata (model_dil_v2, search_result_groups)
   * @returns {string} markdown (from the static version, with its markers
   *   for normalize.js, when the components can't all be rendered)
   */
  const render = (text, meta) => {
    if (typeof text !== 'string' || !/<|\{[#@]/.test(text)) return text;
    const data = resolvedData(meta);
    const state = newState(data);
    // {turnNbusinessM.address} reads the place's fields; the program adds
    // its names as it is read.
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
      const mask = (s) => {
        spans.push(s);
        return `\u0000${spans.length - 1}\u0000`;
      };
      // Inline code is masked first, so neither templates nor tags in it
      // are touched; SVG drawings after the templates are expanded (their
      // shapes repeat with {#each}), so their tags aren't rendered (an
      // SVG's <text> is not the layout tag).
      const masked = expandTemplates(c.text.replace(CODE_SPAN_RE, (s, run) => (run ? mask(s) : s)), scope)
        .replace(/<svg\b[\s\S]*?<\/svg>/g, (s) => `\n\n${mask(svgMarkup(s))}\n\n`);
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
    out = out.trim();
    return unrendered(out) ? fallback(meta) || out : out;
  };

  /** True when the message was written for the generative UI renderer. */
  const isGenUi = (meta) => isObject(meta) && isObject(meta.model_dil_v2);

  Object.assign(g, { render, isGenUi, unrendered });
})();
