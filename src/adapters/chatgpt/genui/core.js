/**
 * ChatGPT generative UI -- the component registry, the resolved data the
 * components show, and helpers shared by the component families.
 *
 * Every tag the exporter knows is registered here once, by name, with how
 * it renders (components/*.js register them; render.js walks the text):
 *
 *   block    a layout container: its content becomes its own paragraph
 *            ({list: true}: each direct child is a cell → one list item)
 *   wrap     inline formatting of its content (caption → _…_)
 *   draft    its content becomes a ```text block (a draft to copy)
 *   drop     the tag goes (content between its tags stays)
 *   leaf     rendered from its attributes and resolved data:
 *            render(attrs, ctx) → markdown, or null when it can't be
 *            rendered (the tag is then left as is and the message falls
 *            back to the server's static version, see render.js)
 *   collect  rendered from its attributes and its rendered content:
 *            render(attrs, inner, ctx) → markdown (controls: a radio's label)
 *
 * `marker` names the component in the legacy `genui{…}` marker of the
 * server's static version (map_widget_v2 → MapWidgetV2).
 *
 * What the tags resolved to sits in model_dil_v2.appData.opGenui
 * .componentResults, keyed by an opaque id. The compiled program
 * (model_dil_v2.code) passes each tag its id as a constant
 * (__resolutionId: __dilConstants["8"]), and constants are numbered in
 * source order -- so the results of one component, sorted by where their
 * id sits in model_dil_v2.constants, line up with its tags in the text.
 * Cite items carry {ref_id, refs[], url, title, source_label}, AsyncImage
 * the found images. Places (local businesses) the answer names are bound in
 * opGenui.modelDataBindings ({name, address, …} by ref) or, when that is
 * empty, known only from their photo's AsyncImage result (name and address
 * in its click action).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { isObject } = g.parse;

  // -- Registry ---------------------------------------------------------------

  const specs = new Map();
  const markers = new Map();
  /** Register one spec under one or more tag names. */
  const register = (names, spec) => {
    for (const name of [].concat(names)) specs.set(name, spec);
    if (spec.marker) markers.set(spec.marker, spec);
  };
  const registry = { register, get: (name) => specs.get(name), byMarker: (key) => markers.get(key) };

  // -- Shared helpers ---------------------------------------------------------

  // A data binding the model refers to: turn620995business0(.name).
  const BINDING_RE = /^turn\d+[a-z_]+\d+\b/;

  // Scraped page titles can be junk ("Product\nFolder\nTools &\n…" -- the
  // nav bar of a PDF landing page): those lose to any clean title of the
  // same source, and to the site label.
  const isMessy = (t) => typeof t !== 'string' || !t.trim() || /\n/.test(t.trim());
  const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();
  const linkText = (s) => oneLine(s).replace(/[[\]]/g, '');
  /** A string attribute or data field, trimmed ('' for anything else). */
  const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

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

  /** A picture linking to the page it is from: [![title](src)](page). */
  const picture = (img, alt) => {
    const pic = `![${linkText(img.title || alt || 'image')}](${img.src})`;
    return img.page ? `[${pic}](${img.page})` : pic;
  };

  const refKey = (r) =>
    isObject(r) && r.turn_index != null && r.ref_type && r.ref_index != null
      ? `turn${r.turn_index}${r.ref_type}${r.ref_index}`
      : '';

  /** An image of a search result: the picture, the page it is on, its title. */
  const imageOf = (x) => {
    if (!isObject(x) || !(x.original_content_url || x.content_url)) return null;
    // url is the page the image was found on; the picture itself is
    // original_content_url (its site) or content_url (OpenAI's copy).
    const src = x.original_content_url || x.content_url;
    // A place's photo links to the place's site, or to the photo itself.
    const page = typeof x.url === 'string' && x.url !== src && x.url !== x.content_url ? x.url : '';
    const ref = refKey(Array.isArray(x.refs) ? x.refs[0] : null);
    return { src, page, title: x.title || '', ref, query: str(x.image_search_query) };
  };

  /**
   * What the components resolved to: citation sources by ref id (from the
   * Cite results and metadata.search_result_groups), the AsyncImage images
   * in order, places by ref, and every result by component name in source
   * order (for the components that read their own result).
   */
  const resolvedData = (meta) => {
    const sources = new Map();
    const images = [];
    // Places by ref: {name, address, url?} (+ whatever else the binding has).
    const places = new Map();
    const results = new Map();
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
    const byId = gen && isObject(gen.componentResults) ? gen.componentResults : {};
    const bindings = gen && isObject(gen.modelDataBindings) ? gen.modelDataBindings : {};
    for (const [key, b] of Object.entries(bindings)) addPlace(key, b);
    // Results in source order (see the header); ids not among the constants
    // keep their order after the rest.
    const consts = dil && isObject(dil.constants) ? Object.values(dil.constants) : [];
    const at = (id) => {
      const n = consts.indexOf(id);
      return n < 0 ? Infinity : n;
    };
    const resolved = Object.entries(byId)
      .filter(([, r]) => isObject(r) && r.status === 'resolved' && isObject(r.state))
      .map(([id, r], n) => ({ r, n, at: at(id) }))
      .sort((a, b) => a.at - b.at || a.n - b.n)
      .map((x) => x.r);
    for (const r of resolved) {
      const name = typeof r.componentName === 'string' ? r.componentName : '';
      if (!results.has(name)) results.set(name, []);
      results.get(name).push({ state: r.state, used: false });
      if (name === 'Cite' && Array.isArray(r.state.items)) {
        for (const it of r.state.items) {
          if (!isObject(it)) continue;
          add(it.ref_id, it.url, it.title, it.source_label);
          for (const ref of Array.isArray(it.refs) ? it.refs : []) add(refKey(ref), it.url, it.title, it.source_label);
        }
      } else if (name === 'AsyncImage' && Array.isArray(r.state.images)) {
        const img = r.state.images.map(imageOf).find(Boolean);
        if (img) {
          images.push(img);
          const action = isObject(r.state.default_on_click_action) ? r.state.default_on_click_action.payload : null;
          if (img.ref && isObject(action) && action.category === 'local_business') {
            const extra = isObject(action.extraParams) ? action.extraParams : {};
            addPlace(img.ref, { name: action.query || img.title, address: extra.address, url: img.page });
          }
        }
      }
    }
    for (const grp of Array.isArray(meta && meta.search_result_groups) ? meta.search_result_groups : []) {
      for (const e of isObject(grp) && Array.isArray(grp.entries) ? grp.entries : []) {
        if (isObject(e)) add(refKey(e.ref_id), e.url, e.title, e.attribution);
      }
    }
    return { sources, images, places, results };
  };

  /**
   * The next unused result of a component (optionally the first that
   * `match`es its state), marked used; null when there is none.
   */
  const takeResult = (data, name, match) => {
    const list = data.results.get(name) || [];
    const hit = list.find((x) => !x.used && (!match || match(x.state)));
    if (!hit) return null;
    hit.used = true;
    return hit.state;
  };

  /**
   * A tile or card (a grid cell, a pressable) → one list item, its lines
   * joined by " — " (R — Reset). A card with a picture (photo, name,
   * caption) keeps each line, picture first, as lines of the item -- the way
   * the card shows. One that already is a list item (a checkbox) stays one.
   */
  const listItem = (text) => {
    const isPicture = (l) => /^\[?!\[[^\]]*\]\([^)]*\)(?:\]\([^)]*\))?$/.test(l);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    const item = lines.some(isPicture)
      ? [...lines.filter(isPicture), ...lines.filter((l) => !isPicture(l))].join('\n  ')
      : lines.join(' — ');
    return /^- /.test(item) ? item : `- ${item}`;
  };

  /** A Google Maps search for a place: what clicking it on the map shows. */
  // Parentheses are escaped too: a bare `)` would end the markdown link.
  const mapLink = (p) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address].filter(Boolean).join(', ')).replace(/[()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

  g.registry = registry;
  g.data = { resolvedData, takeResult, imageOf };
  g.util = { BINDING_RE, isObject, oneLine, linkText, str, siteName, inlineSources, picture, listItem, mapLink };
})();
