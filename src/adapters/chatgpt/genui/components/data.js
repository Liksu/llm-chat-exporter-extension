/**
 * ChatGPT generative UI -- data components: links, sources, places,
 * pictures, maps, charts.
 *
 *   <Link url="…" title="…"/>            → [title](url)
 *   <Cite ref="turnNsearchM"/>           → inline source links like the
 *   <Cite refs={["…","…"]}/>               chips: ([Reddit](url))
 *   <FileCite ref="turn0file0" line_range_start={44} line_range_end={61}/>
 *                                        → (notes.md, lines 44–61)
 *   <CodeCite tool="container" …/>       → nothing (points at a code run)
 *   <Entity category="product" value="TPS63802"/> → its text (a place:
 *                                          linked to its site)
 *   <AsyncImage query="…"/>              → the picture the search found
 *   <AsyncImage ref="turnNbusinessM"/>   → a place's photo
 *   <AsyncImageGroup query={[…]}/>       → its pictures, in a row
 *   <MapWidgetV2 points={[{"ref":…},…]}/> → a list of its places with map
 *                                          links
 *   <Chart content={{chartType, xKey, series, data, meta}}/> → a table of
 *                                          its data (what the bars stood for)
 *   <Rating data={turnNbusinessM.rating}/> → ★ 4.3 (1,740 reviews · Tripadvisor)
 *   <favicon url="…"/>                   → nothing (a site's icon)
 *   {turnNbusinessM.address}             a place's field (template.js)
 *
 * A place the chat never resolved renders as nothing (as on the page).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { register } = g.registry;
  const { imageOf } = g.data;
  const { BINDING_RE, isObject, oneLine, linkText, str, inlineSources, picture, mapLink } = g.util;

  register('Link', {
    kind: 'leaf',
    render: (a) => {
      const url = typeof a.url === 'string' ? a.url : '';
      const title = typeof a.title === 'string' && a.title ? a.title : url;
      return url ? `[${linkText(title)}](${url})` : title;
    },
  });

  register('Cite', {
    kind: 'leaf',
    render: (a, ctx) => {
      const refs = [];
      if (typeof a.ref === 'string') refs.push(a.ref);
      if (Array.isArray(a.refs)) refs.push(...a.refs.filter((r) => typeof r === 'string'));
      return inlineSources(refs.map((r) => ctx.data.sources.get(r)));
    },
  });

  register('CodeCite', { kind: 'drop' });
  register('favicon', { kind: 'leaf', render: () => '' });

  // The file and where in it: the result names the file (and a PDF's
  // page), the tag the lines.
  register('FileCite', {
    kind: 'leaf',
    render: (a, ctx) => {
      const ref = str(a.ref);
      const from = str(a.line_range_start);
      const pointer = (s) => (isObject(s.file_action_payload) && isObject(s.file_action_payload.input_pointer) ? s.file_action_payload.input_pointer : {});
      const res =
        ctx.take('FileCite', (s) => s.refid === ref && str(pointer(s).line_range_start) === from) ||
        ctx.take('FileCite', (s) => s.refid === ref);
      const action = res && isObject(res.file_action_payload) ? res.file_action_payload : {};
      const page = str(action.page_range_start);
      const pageEnd = str(action.page_range_end);
      const to = str(a.line_range_end);
      const parts = [
        res ? oneLine(str(res.file_name) || str(action.file_name)) : '',
        page ? `p. ${page}${pageEnd && pageEnd !== page ? `–${pageEnd}` : ''}` : '',
        from ? `${to && to !== from ? 'lines' : 'line'} ${from}${to && to !== from ? `–${to}` : ''}` : '',
      ].filter(Boolean);
      return parts.length ? `(${parts.join(', ')})` : '';
    },
  });

  register('Entity', {
    kind: 'leaf',
    render: (a, ctx) => {
      const place = typeof a.ref === 'string' ? ctx.data.places.get(a.ref) : null;
      const value = [a.value, a.name].find((v) => typeof v === 'string' && v && !BINDING_RE.test(v));
      const label = (place && place.name) || value || '';
      return label && place && typeof place.url === 'string' && place.url ? `[${linkText(label)}](${place.url})` : label;
    },
  });

  register('AsyncImage', {
    kind: 'leaf',
    render: (a, ctx) => {
      // A place's photo is found by its ref; other images go in order.
      const ref = typeof a.ref === 'string' ? a.ref : '';
      const free = ctx.data.images.filter((x) => !ctx.usedImages.has(x));
      const img = ref ? free.find((x) => x.ref === ref) : free.find((x) => !x.ref) || free[0];
      if (!img) return '';
      ctx.usedImages.add(img);
      return `\n\n${picture(img, a.query)}\n\n`;
    },
  });

  register('AsyncImageGroup', {
    kind: 'leaf',
    render: (a, ctx) => {
      const res = ctx.take('AsyncImageGroup');
      const pics = (res && Array.isArray(res.images) ? res.images : []).map(imageOf).filter(Boolean);
      return pics.length ? `\n\n${pics.map((x) => picture(x, x.query)).join(' ')}\n\n` : '';
    },
  });

  register(['MapWidgetV2', 'MapWidget'], {
    kind: 'leaf',
    marker: 'map_widget_v2',
    render: (a, ctx) => {
      const points = Array.isArray(a.points) ? a.points : [];
      const items = points
        .map((pt) => (isObject(pt) ? (typeof pt.ref === 'string' && ctx.data.places.get(pt.ref)) || pt : null))
        .filter((p) => p && typeof p.name === 'string' && p.name)
        .map((p) => `- 📍 [${linkText(p.name)}](${mapLink(p)})${p.address ? ` — ${oneLine(p.address)}` : ''}`);
      return items.length ? `\n\n🗺️ **Map**\n\n${items.join('\n')}\n\n` : '';
    },
  });

  /**
   * A chart → its data as a table: one row per x value, one column per
   * series, values with the series' prefix/suffix ($, %). The chart's footer
   * (source, notes) follows in italics.
   */
  const chartTable = (c) => {
    if (!isObject(c) || !Array.isArray(c.data)) return '';
    const data = c.data.filter(isObject);
    // A pie names its slices by nameKey.
    const xKey = typeof c.xKey === 'string' ? c.xKey : typeof c.nameKey === 'string' ? c.nameKey : '';
    let series = (Array.isArray(c.series) ? c.series : []).filter((x) => isObject(x) && typeof x.dataKey === 'string');
    if (!series.length) series = [...new Set(data.flatMap(Object.keys))].filter((k) => k !== xKey).map((k) => ({ dataKey: k }));
    if (!data.length || !series.length) return '';
    const cell = (v) => (v == null ? '' : oneLine(String(v)).replace(/\|/g, '\\|'));
    const value = (x, v) => (v == null || v === '' ? '' : `${x.valuePrefix || ''}${v}${x.valueSuffix || ''}`);
    const head = [xKey, ...series.map((x) => x.label || x.dataKey)].map(cell);
    const rows = data.map((d) => [cell(d[xKey]), ...series.map((x) => cell(value(x, d[x.dataKey])))]);
    const meta = isObject(c.meta) ? c.meta : {};
    const kind = typeof c.chartType === 'string' && c.chartType ? ` (${c.chartType})` : '';
    const title = typeof meta.title === 'string' && meta.title ? `: ${oneLine(meta.title)}` : '';
    const footer = typeof meta.footer === 'string' && meta.footer.trim() ? `\n\n_${oneLine(meta.footer)}_` : '';
    return (
      `\n\n📊 _Chart${kind}${title}_\n\n| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n` +
      `${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}${footer}\n\n`
    );
  };
  register('Chart', { kind: 'leaf', marker: 'charts_widget_v2', render: (a) => chartTable(a.content) });

  // The rating the result resolved (labels as the page shows them).
  register('Rating', {
    kind: 'leaf',
    render: (a, ctx) => {
      const r = ctx.take('Rating');
      const stars = r ? str(r.rating_label) : '';
      if (!stars) return '';
      const count = str(r.review_count_label).replace(/^\((.*)\)$/, '$1');
      const by = isObject(r.attribution) ? r.attribution : {};
      const site = str(by.provider_label);
      const source = site && str(by.provider_url) ? `[${linkText(site)}](${str(by.provider_url)})` : site;
      const extra = [count && `${count} reviews`, source].filter(Boolean).join(' · ');
      return `★ ${stars}${extra ? ` (${extra})` : ''}`;
    },
  });
})();
