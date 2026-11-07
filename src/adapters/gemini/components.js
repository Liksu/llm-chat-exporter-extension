/**
 * Gemini's UI components in reply text (seen 2026-11). Gemini writes some
 * reply elements as JSX-like tags on lines of their own, between ordinary
 * markdown, and the page draws them as boxes, suggestion chips and charts:
 *
 *   <Callout title="Wiring Tip" type="warning">      → a quote:
 *   Set the programmer to **3.3V** first.               > ⚠️ **Wiring Tip**
 *   </Callout>                                          >
 *                                                       > Set the programmer…
 *
 *   <ElicitationsGroup message="Need more help?">    → the follow-ups it
 *     <Elicitation label="Identify the IC" query="…"/>  suggests (labels as
 *   </ElicitationsGroup>                                the chips show them):
 *                                                       💬 _Need more help?_
 *                                                       - Identify the IC
 *
 *   <TemplateWidget header_title="Revenue" templateName="bar_chart">
 *   ```json                                          → 📊 _Chart (bar_chart):
 *   {"unit": "$", "data": [{"label": "North",           Revenue_ and a table
 *     "value": 48480}]}                                 of its data
 *   ```
 *   </TemplateWidget>
 *
 * Tags inside code blocks are text (a reply can show JSX code). A tag we
 * don't know, or a block that never closes, stays as it is, so the export
 * audit reports it as new markup instead of it being lost.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});

  const OPEN_TAG_RE = /^\s*<([A-Z][A-Za-z]*)((?:\s+[A-Za-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>\s*$/;
  const ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const ENTITIES = { quot: '"', apos: "'", '#39': "'", amp: '&', lt: '<', gt: '>' };

  const decode = (s) => s.replace(/&(quot|apos|#39|amp|lt|gt);/g, (m, e) => ENTITIES[e]);

  /** `<Name …>` / `<Name …/>` alone on a line → {name, attrs, selfClosing}, else null. */
  const openTag = (line) => {
    const m = OPEN_TAG_RE.exec(line);
    if (!m) return null;
    const attrs = {};
    for (const a of m[2].matchAll(ATTR_RE)) attrs[a[1]] = decode(a[2] ?? a[3]);
    return { name: m[1], attrs, selfClosing: m[3] === '/' };
  };

  const closeTag = (line, name) => new RegExp(`^\\s*</${name}>\\s*$`).test(line);

  /** Fence marker (``` / ~~~ run) opening a code block on this line, else null. */
  const fenceOpen = (line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    return m ? m[1] : null;
  };
  const fenceCloses = (line, marker) =>
    new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(line);

  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

  /** Markdown text as a quote: `> ` on every line, a bare `>` on blank ones. */
  const quoteLines = (text) =>
    text
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');

  /** Blank lines off both ends of a block's body. */
  const trimBlank = (lines) => {
    let a = 0;
    let b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
  };

  const CALLOUT_ICONS = {
    warning: '⚠️',
    caution: '⚠️',
    danger: '⛔',
    error: '⛔',
    tip: '💡',
    note: '📝',
    success: '✅',
    info: 'ℹ️',
  };

  const callout = (attrs, body) => {
    const icon = CALLOUT_ICONS[String(attrs.type || '').toLowerCase()] || 'ℹ️';
    const title = attrs.title ? ` **${oneLine(attrs.title)}**` : '';
    const text = trimBlank(body).join('\n');
    return quoteLines(text ? `${icon}${title}\n\n${text}` : `${icon}${title}`);
  };

  const elicitations = (attrs, items) => {
    const labels = items.map((t) => oneLine(t.attrs.label || t.attrs.query || '')).filter(Boolean);
    const lines = [];
    if (attrs.message) lines.push(`💬 _${oneLine(attrs.message)}_`, '');
    lines.push(...labels.map((l) => `- ${l}`));
    return lines.join('\n').trim();
  };

  /**
   * A chart → its data as a table, like the ChatGPT adapter's charts: one
   * row per data point, a column per field, values with the unit ($ before,
   * others after). Without parsable data the JSON stays under the caption.
   */
  const chart = (attrs, body) => {
    const raw = trimBlank(body).join('\n');
    const json = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(raw);
    let spec = null;
    try {
      spec = JSON.parse(json ? json[2] : raw);
    } catch (_) {
      /* keep the body as it is */
    }
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const title = attrs.header_title || (isObject(spec) && (spec.title || (isObject(spec.labels) && spec.labels.title))) || '';
    const kind = attrs.templateName ? ` (${attrs.templateName})` : '';
    const caption = `📊 _Chart${kind}${title ? `: ${oneLine(title)}` : ''}_`;
    const data = isObject(spec) && Array.isArray(spec.data) ? spec.data.filter(isObject) : [];
    if (!data.length) return raw ? `${caption}\n\n${raw}` : caption;

    const keys = [...new Set(data.flatMap(Object.keys))].filter((k) => data.some((d) => !isObject(d[k])));
    if (keys.includes('label')) keys.unshift(...keys.splice(keys.indexOf('label'), 1));
    const unit = typeof spec.unit === 'string' ? spec.unit : '';
    const withUnit = (v) => {
      if (typeof v !== 'number' || !unit) return v;
      if (/^\p{Sc}$/u.test(unit)) return `${unit}${v}`;
      return unit === '%' ? `${v}%` : `${v} ${unit}`;
    };
    const cell = (v) => (v == null ? '' : oneLine(String(v)).replace(/\|/g, '\\|'));
    const rows = data.map((d) => keys.map((k) => cell(k === 'label' ? d[k] : withUnit(d[k]))));
    return [
      caption,
      '',
      `| ${keys.map(cell).join(' | ')} |`,
      `|${keys.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  };

  /**
   * Blocks: how each component's body ends and what it becomes.
   *   end(line) → true on the line that closes the block (consumed)
   *   take(line) → false on a line that can't be inside it: the block ends
   *               before that line (Gemini sometimes doesn't close a group)
   */
  const BLOCKS = {
    Callout: { render: callout },
    TemplateWidget: { render: chart },
    ElicitationsGroup: {
      // Seen: a group "closed" by a second bare `<ElicitationsGroup>`.
      end: (line) => closeTag(line, 'ElicitationsGroup') || /^\s*<ElicitationsGroup>\s*$/.test(line),
      take: (line) => !line.trim() || (openTag(line) || {}).name === 'Elicitation',
      render: (attrs, body) => elicitations(attrs, body.map(openTag).filter((t) => t && t.name === 'Elicitation')),
      unclosedOk: true,
    },
  };

  /**
   * The body lines of the block opened at lines[start], and where the text
   * resumes; null when the block never closes (and may not stay open).
   */
  const readBlock = (lines, start, name, spec) => {
    const end = spec.end || ((line) => closeTag(line, name));
    const body = [];
    let fence = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (fence) {
        if (fenceCloses(line, fence)) fence = null;
        body.push(line);
        continue;
      }
      if (end(line)) return { body, next: i + 1 };
      if (spec.take && !spec.take(line)) return spec.unclosedOk ? { body, next: i } : null;
      fence = fenceOpen(line);
      body.push(line);
    }
    return spec.unclosedOk ? { body, next: lines.length } : null;
  };

  /** Reply markdown with the components above turned into markdown. */
  const render = (text) => {
    const src = String(text || '');
    if (!/^\s*<[A-Z]/m.test(src)) return src;
    const lines = src.split('\n');
    const out = [];
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence) {
        if (fenceCloses(line, fence)) fence = null;
        out.push(line);
        continue;
      }
      const tag = openTag(line);
      const spec = tag && !tag.selfClosing && BLOCKS[tag.name];
      const block = spec && readBlock(lines, i, tag.name, spec);
      if (!block) {
        fence = fenceOpen(line);
        out.push(line);
        continue;
      }
      // Its own paragraph: a blank line before and after.
      if (out.length && out[out.length - 1].trim()) out.push('');
      out.push(spec.render(tag.attrs, block.body));
      if (block.next < lines.length && lines[block.next].trim()) out.push('');
      i = block.next - 1;
    }
    return out.join('\n');
  };

  ns.geminiComponents = { render };
})();
