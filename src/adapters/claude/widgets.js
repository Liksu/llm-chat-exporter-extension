/**
 * claude.ai built-in widgets and Claude Docs documents.
 *
 * Widgets. Since Oct 2026 claude.ai draws cards in the reply from
 * `mcp__widgets__*` tool calls: a chart, a quiz, a recipe, a product
 * comparison, a map of places, a weather forecast. The tool input (and for
 * some, the tool result) is all the card shows; render() turns it into
 * markdown so the reply keeps it without "Include reasoning":
 *
 *   chart_display_v0           → a table of the series
 *   quiz_display_v0            → numbered questions, options, the answer
 *                                folded in <details>
 *   recipe_display_v0          → ingredients and steps (+ its web photos)
 *   comparison_card_display_v0 → a table, one column per product
 *   places_map_display_v0      → the places with notes, rating, photo and
 *                                a map link (from the result's details)
 *   weather_fetch              → current weather and a forecast table
 *
 * places_search only feeds the map; it stays a tool call.
 *
 * Docs. A Claude Docs document lives in the Claude Docs service; the chat
 * only has the calls that wrote it: `batch` creates it from a markdown
 * skeleton with `<?claude block k?>` placeholders (pending sections, a date,
 * a mention), `update` replaces or inserts blocks by id. The results name
 * the ids of the blocks each call made (in their `xml`), so replaying the
 * calls gives the document's last text. Comments and edits made by people
 * on the page are not in the chat.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
  const cell = (s) => oneLine(s).replace(/\|/g, '\\|');
  const linkText = (s) => oneLine(s).replace(/[[\]]/g, '');
  const table = (head, rows) =>
    [`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
  const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : str(n));

  // -- Widgets ---------------------------------------------------------------

  const chart = (input) => {
    const series = Array.isArray(input.series) ? input.series.filter(isObject) : [];
    const x = isObject(input.x_axis) && Array.isArray(input.x_axis.data) ? input.x_axis.data : [];
    if (!series.length || !x.length) return null;
    const head = [str(input.x_axis.title), ...series.map((s, i) => str(s.name) || `Series ${i + 1}`)];
    const rows = x.map((label, i) => [str(label), ...series.map((s) => (Array.isArray(s.values) ? num(s.values[i]) : ''))]);
    const out = [`**📊 ${str(input.title) || 'Chart'}**`, '', table(head, rows)];
    if (isObject(input.y_axis) && str(input.y_axis.title) && series.length > 1) out.push('', `_${str(input.y_axis.title)}_`);
    return out.join('\n');
  };

  const quiz = (input) => {
    const questions = Array.isArray(input.questions) ? input.questions.filter(isObject) : [];
    if (!questions.length) return null;
    const out = [`**📝 ${str(input.title) || 'Quiz'}**`];
    if (str(input.description)) out.push('', str(input.description));
    questions.forEach((q, i) => {
      out.push('', `**${i + 1}. ${oneLine(str(q.prompt) || str(q.question))}**`);
      const options = Array.isArray(q.options) ? q.options.filter(isObject) : [];
      if (options.length) out.push('', ...options.map((o) => `- ${str(o.id) ? `${str(o.id)}) ` : ''}${oneLine(str(o.text))}`));
      if (str(q.hint)) out.push('', `_Hint: ${oneLine(str(q.hint))}_`);
      const right = options.find((o) => str(o.id) && str(o.id) === str(q.correct_option_id));
      const answer = right ? `**${str(right.id)}) ${oneLine(str(right.text))}**` : str(q.answer) ? `**${oneLine(str(q.answer))}**` : '';
      if (answer || str(q.explanation)) {
        out.push('', '<details><summary>Answer</summary>', '', [answer, str(q.explanation)].filter(Boolean).join(' — '), '', '</details>');
      }
    });
    return out.join('\n');
  };

  const gallery = (images) =>
    images
      .filter((im) => isObject(im) && str(im.url))
      .slice(0, 3)
      .map((im) => {
        const pic = `![${linkText(str(im.title) || str(im.source) || 'photo')}](${str(im.url)})`;
        return str(im.page_url) ? `[${pic}](${str(im.page_url)})` : pic;
      })
      .join(' ');

  const recipe = (input, result, images) => {
    const ingredients = Array.isArray(input.ingredients) ? input.ingredients.filter(isObject) : [];
    const steps = Array.isArray(input.steps) ? input.steps.filter(isObject) : [];
    if (!ingredients.length && !steps.length) return null;
    const names = new Map(ingredients.map((g) => [str(g.id), str(g.name)]));
    const out = [`**🍳 ${str(input.title) || 'Recipe'}**`];
    if (str(input.description)) out.push('', str(input.description));
    if (input.base_servings != null) out.push('', `_Servings: ${num(input.base_servings)}_`);
    const pics = gallery(images);
    if (pics) out.push('', pics);
    if (ingredients.length) {
      out.push('', '**Ingredients**', '');
      for (const g of ingredients) out.push(`- ${[num(g.amount), str(g.unit), str(g.name)].filter(Boolean).join(' ')}`);
    }
    if (steps.length) {
      out.push('', '**Steps**', '');
      steps.forEach((s, i) => {
        const text = oneLine(str(s.content)).replace(/\{([^{}]+)\}/g, (m, id) => names.get(id) || m);
        const timer = typeof s.timer_seconds === 'number' && s.timer_seconds > 0
          ? ` _(⏱ ${s.timer_seconds % 60 ? `${s.timer_seconds} s` : `${s.timer_seconds / 60} min`})_`
          : '';
        out.push(`${i + 1}. ${str(s.title) ? `**${oneLine(str(s.title))}.** ` : ''}${text}${timer}`);
      });
    }
    if (str(input.notes)) out.push('', `**Notes:** ${str(input.notes)}`);
    return out.join('\n');
  };

  const comparison = (input) => {
    const products = Array.isArray(input.products) ? input.products.filter(isObject) : [];
    if (!products.length) return null;
    const labels = [];
    for (const p of products) {
      for (const a of Array.isArray(p.attributes) ? p.attributes : []) {
        if (isObject(a) && str(a.label) && !labels.includes(str(a.label))) labels.push(str(a.label));
      }
    }
    const head = ['', ...products.map((p) => (str(p.url) ? `[${linkText(str(p.name))}](${str(p.url)})` : str(p.name)))];
    const value = (p, label) => {
      const a = (Array.isArray(p.attributes) ? p.attributes : []).find((x) => isObject(x) && str(x.label) === label);
      return a ? str(a.value) : '';
    };
    const rows = [];
    if (products.some((p) => str(p.price))) rows.push(['Price', ...products.map((p) => str(p.price))]);
    for (const label of labels) rows.push([label, ...products.map((p) => value(p, label))]);
    // head cells keep their link brackets; only the pipes are escaped.
    const headRow = `| ${head.map((h) => oneLine(h).replace(/\|/g, '\\|')).join(' | ')} |`;
    const body = table(head, rows).split('\n').slice(1).join('\n');
    return [`**${str(input.title) || 'Comparison'}**`, '', `${headRow}\n${body}`].join('\n');
  };

  const placesMap = (input, result) => {
    const locations = Array.isArray(input.locations) ? input.locations.filter(isObject) : [];
    if (!locations.length) return null;
    const enriched = isObject(result) && isObject(result.enriched_places) ? result.enriched_places : {};
    const out = [`**🗺️ ${str(input.title) || 'Map'}**`, ''];
    locations.forEach((l, i) => {
      const e = isObject(enriched[str(l.place_id)]) ? enriched[str(l.place_id)] : {};
      const coords = l.latitude != null && l.longitude != null ? `${l.latitude},${l.longitude}` : '';
      const query = encodeURIComponent(coords || [str(l.name), str(l.address)].filter(Boolean).join(', '));
      const maps = str(e.maps_url) ||
        `https://www.google.com/maps/search/?api=1&query=${query}${str(l.place_id) ? `&query_place_id=${encodeURIComponent(str(l.place_id))}` : ''}`;
      const parts = [`**[${linkText(str(l.name) || 'place')}](${maps})**`];
      if (typeof e.rating === 'number') parts.push(`★ ${e.rating}${typeof e.rating_count === 'number' ? ` (${e.rating_count.toLocaleString('en-US')})` : ''}`);
      if (str(l.notes)) parts.push(oneLine(str(l.notes)));
      if (str(e.website)) parts.push(`[website](${str(e.website)})`);
      out.push(`${i + 1}. ${parts.join(' — ')}`);
      const photo = Array.isArray(e.photos) ? e.photos.find((p) => isObject(p) && str(p.url)) : null;
      if (photo) out.push(`   ![${linkText(str(l.name) || 'photo')}](${str(photo.url)})`);
    });
    return out.join('\n');
  };

  const weather = (input, result) => {
    if (!isObject(result)) return null;
    const place = str(input.location_name) || [str(result.location), str(result.country)].filter(Boolean).join(', ');
    const deg = (t) => (typeof t === 'number' ? `${Math.round(t)} °C` : '');
    const cur = isObject(result.current) ? result.current : {};
    const now = [deg(cur.temperature), str(cur.condition_text)].filter(Boolean).join(', ');
    const days = Array.isArray(result.daily) ? result.daily.filter(isObject) : [];
    if (!now && !days.length) return null;
    const out = [`**🌤️ Weather${place ? ` — ${place}` : ''}**${now ? `: ${now}` : ''}`];
    if (days.length) {
      out.push('', table(['Day', 'High', 'Low', 'Precipitation'], days.map((d) => [
        [str(d.day_of_week).slice(0, 3), str(d.date)].filter(Boolean).join(' '),
        deg(d.high),
        deg(d.low),
        typeof d.precipitation_chance === 'number' ? `${d.precipitation_chance}%${str(d.precipitation_type) ? ` ${str(d.precipitation_type)}` : ''}` : '',
      ])));
    }
    return out.join('\n');
  };

  const WIDGETS = {
    chart_display_v0: chart,
    quiz_display_v0: quiz,
    recipe_display_v0: recipe,
    comparison_card_display_v0: comparison,
    places_map_display_v0: placesMap,
    weather_fetch: weather,
  };

  /** `mcp__widgets__weather_fetch` / `weather_fetch` → `weather_fetch`. */
  const widgetName = (name) => {
    const short = typeof name === 'string' ? name.replace(/^mcp__widgets__/, '') : '';
    return Object.prototype.hasOwnProperty.call(WIDGETS, short) ? short : null;
  };

  /**
   * @param {string} name     tool name
   * @param {object} input    tool input
   * @param {Array|string} content  tool result content
   * @returns {string|null}   markdown, or null when the shape is unknown
   */
  const render = (name, input, content) => {
    const fn = WIDGETS[widgetName(name)];
    if (!fn || !isObject(input)) return null;
    const items = Array.isArray(content) ? content : [content];
    let result = null;
    const images = [];
    for (const c of items) {
      const text = typeof c === 'string' ? c : isObject(c) && typeof c.text === 'string' ? c.text : '';
      if (text && result === null) {
        try {
          result = JSON.parse(text);
        } catch (_) {
          /* not JSON */
        }
      }
      if (isObject(c) && c.type === 'image_gallery' && Array.isArray(c.images)) images.push(...c.images);
    }
    try {
      return fn(input, result, images);
    } catch (_) {
      return null;
    }
  };

  // -- Claude Docs -------------------------------------------------------------

  const parseJsonHead = (text) => {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text.split('\n')[0]);
    } catch (_) {
      return null;
    }
  };
  const parseMaybe = (v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch (_) {
      return null;
    }
  };

  /**
   * Top-level block ids per `<doc …>` element of a result's xml, as
   * [{op, ids}] (op is the index of the op it answers, or null).
   */
  const docIds = (xml, session) => {
    const docs = [];
    if (typeof xml !== 'string') return docs;
    const re = /<doc\b([^>]*)>([\s\S]*?)<\/doc>/g;
    let m;
    while ((m = re.exec(xml))) {
      const op = /\bop='(\d+)'/.exec(m[1]);
      const ids = [];
      let depth = 0;
      const tags = /<(\/?)([a-z][\w-]*)\b([^>]*?)(\/?)>/g;
      let t;
      while ((t = tags.exec(m[2]))) {
        if (t[1]) {
          depth--;
          continue;
        }
        if (depth === 0) {
          const id = /\bid='([^']+)'/.exec(t[3]);
          if (id) {
            const full = id[1].startsWith('.') ? `${session}${id[1]}` : id[1];
            if (!session && full.includes('.')) session = full.slice(0, full.indexOf('.'));
            ids.push(full);
          }
        }
        if (!t[4]) depth++;
      }
      docs.push({ op: op ? Number(op[1]) : null, ids });
    }
    return docs;
  };

  /** Split markdown into top-level blocks (blank-line separated, fences kept whole). */
  const splitBlocks = (md) => {
    const out = [];
    let buf = [];
    let fence = null;
    for (const line of String(md).split('\n')) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        buf.push(line);
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      } else if (f) {
        buf.push(line);
        fence = f[1];
      } else if (!line.trim()) {
        if (buf.length) out.push(buf.join('\n'));
        buf = [];
      } else {
        buf.push(line);
      }
    }
    if (buf.length) out.push(buf.join('\n'));
    return out;
  };

  /** Fill the `<?claude block k?>` placeholders: dates show, the rest is empty. */
  const fillPlaceholders = (md, blocks) =>
    String(md)
      .replace(/<\?claude block ([\w-]+)\?>/g, (_, k) => {
        const b = isObject(blocks) ? blocks[k] : null;
        if (isObject(b) && b.type === 'date') return str(b.value);
        return '';
      })
      .replace(/^[ \t]*[·•|-]?[ \t]*$/gm, '')
      .replace(/[ \t]*·[ \t]*$/gm, '')
      .replace(/^[ \t]*·[ \t]*/gm, '');

  /**
   * New blocks for a markdown fragment: [{ids, md}], one per top-level block
   * when the counts line up with the ids the call made, else one block
   * holding them all.
   */
  const makeBlocks = (md, ids) => {
    const parts = splitBlocks(md);
    if (parts.length === ids.length) return parts.map((p, i) => ({ ids: [ids[i]], md: p }));
    return [{ ids: ids.slice(), md: parts.join('\n\n') }];
  };

  const createDocs = () => {
    /** containerId → { blocks: [{ids, md}], art } */
    const docs = new Map();

    const contentOf = (doc) => doc.blocks.map((b) => b.md).filter((s) => s.trim()).join('\n\n') + '\n';

    const titleOf = (doc, fallback) => {
      const h = /^#\s+(.+)$/m.exec(contentOf(doc));
      return (h && h[1].trim()) || fallback || 'Claude document';
    };

    const indexOf = (doc, id) => doc.blocks.findIndex((b) => b.ids.includes(id));

    /**
     * A markdown fragment (with its placeholder map) as new blocks. A
     * placeholder-only paragraph (a pending section) is a block too, so
     * blocks are counted before the placeholders are filled.
     */
    const fragment = (raw, blocksMap, ids) => {
      const rawParts = splitBlocks(raw);
      if (rawParts.length === ids.length) {
        return rawParts.map((p, i) => ({ ids: [ids[i]], md: fillPlaceholders(p, blocksMap).trim() }));
      }
      return makeBlocks(fillPlaceholders(raw, blocksMap), ids);
    };

    const applyOp = (doc, op, ids) => {
      if (!isObject(op)) return;
      const src = isObject(op.with) ? op.with : isObject(op.source) ? op.source : {};
      const from = isObject(src.from) ? src.from : {};
      const raw = typeof from.content === 'string' ? from.content : typeof src.content === 'string' ? src.content : null;
      const target = isObject(op.target) ? op.target : {};
      const targets = Array.isArray(target.ids) ? target.ids : [];
      const kind = String(op.op || '');
      const at = targets.map((t) => indexOf(doc, t)).filter((n) => n >= 0);
      if (kind === 'delete' || kind === 'remove') {
        doc.blocks = doc.blocks.filter((_, n) => !at.includes(n));
        return;
      }
      if (raw === null) return;
      const made = fragment(raw, src.blocks, ids);
      if (kind === 'replace' && at.length) {
        const first = Math.min(...at);
        doc.blocks = doc.blocks.filter((_, n) => !at.includes(n) || n === first);
        doc.blocks.splice(first, 1, ...made);
      } else if (kind === 'insert' && at.length && target.kind !== 'root') {
        const pos = op.side === 'before' ? Math.min(...at) : Math.max(...at) + 1;
        doc.blocks.splice(pos, 0, ...made);
      } else if (kind === 'insert' && (target.kind === 'root' || !targets.length) && op.side === 'start') {
        doc.blocks.unshift(...made);
      } else {
        doc.blocks.push(...made);
      }
    };

    const ensure = (id) => {
      if (!docs.has(id)) docs.set(id, { blocks: [], art: null });
      return docs.get(id);
    };

    const refresh = (doc, url, name) => {
      if (!doc.art) return;
      doc.art.content = contentOf(doc);
      doc.art.title = titleOf(doc, name || doc.art.title);
      doc.art.fileName = `${ns.utils.sanitizeFilename(doc.art.title)}.md`;
      if (url && !doc.art.url) doc.art.url = url;
    };

    /**
     * Apply one Docs tool call (name, input) with its result text. Returns
     * the doc's artifact when this call created its content (the reference
     * goes there), else null.
     */
    const apply = (name, input, resultText, makeArtifact) => {
      const short = String(name).split('__').pop();
      if (!isObject(input)) return null;
      const res = parseJsonHead(resultText);
      if (!isObject(res)) return null;
      const container = isObject(input.container) ? input.container : {};
      if (short === 'batch') {
        const created = isObject(res.created) ? str(res.created.minted) : '';
        const id = str(container.id) || created;
        if (!id) return null;
        const doc = ensure(id);
        const acks = (Array.isArray(res.acks) ? res.acks : []).filter((a) => isObject(a) && typeof a.xml === 'string');
        let ackAt = 0;
        const nextIds = () => {
          const a = acks[ackAt++];
          return a ? docIds(a.xml, str(a.session)).flatMap((d) => d.ids) : [];
        };
        const create = isObject(container.create) ? container.create : null;
        if (create && isObject(create.doc) && typeof create.doc.markdown === 'string') {
          doc.blocks = fragment(create.doc.markdown, create.doc.blocks, nextIds());
        }
        for (const item of Array.isArray(input.batch) ? input.batch : []) {
          const payload = isObject(item) ? parseMaybe(item.payload) : null;
          for (const op of isObject(payload) && Array.isArray(payload.ops) ? payload.ops : []) applyOp(doc, op, nextIds());
        }
        const url = isObject(res.frame) ? str(res.frame.url) || str(res.frame.artifactUrl) : '';
        const made = !doc.art && doc.blocks.length ? (doc.art = makeArtifact(`docs:${id}`)) : null;
        refresh(doc, url, create ? str(create.name) : '');
        return made;
      }
      if (short === 'update') {
        const id = str(container.id);
        if (!id || !docs.has(id)) return null;
        const doc = docs.get(id);
        const payload = parseMaybe(input.payload);
        const ops = isObject(payload) && Array.isArray(payload.ops) ? payload.ops : [];
        const answers = docIds(res.xml, str(res.session));
        ops.forEach((op, n) => {
          const a = answers.find((d) => d.op === n) || (ops.length === 1 ? answers[0] : null);
          applyOp(doc, op, a ? a.ids : []);
        });
        refresh(doc);
        return null;
      }
      return null;
    };

    return { apply };
  };

  /** True for the Claude Docs connector's tools. */
  const isDocsTool = (name) => /^mcp__Claude_Docs__(batch|update)$/.test(String(name));

  ns.claudeWidgets = { render, widgetName, createDocs, isDocsTool };
})();
