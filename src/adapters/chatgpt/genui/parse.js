/**
 * ChatGPT generative UI -- parsing: component tags.
 *
 * Tags are JSX-like: <Link url="…" title="…"/>, <box gap={2}>, values in
 * "…", '…', {json-or-expression} (braces may nest) or bare.
 *
 * The expressions inside {…} are expr.js's.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const decodeEntities = (s) =>
    s.replace(/&(quot|amp|lt|gt|#39|apos);/g, (_, e) =>
      ({ quot: '"', amp: '&', lt: '<', gt: '>', '#39': "'", apos: "'" })[e]);
  /** The inverse, for a value written back as a quoted attribute. */
  const encodeEntities = (s) =>
    s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

  /** Index just past the `}` closing the brace at `open` (strings respected). */
  const braceEnd = (text, open) => {
    let depth = 0;
    let str = null;
    for (let k = open; k < text.length; k++) {
      const c = text[k];
      if (str) {
        if (c === '\\') k++;
        else if (c === str) str = null;
      } else if (c === '"' || c === "'" || c === '`') str = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return k + 1;
    }
    return -1;
  };

  /**
   * Parse one tag starting at text[i] === '<'. Returns
   * { name, closing, selfClosing, attrs, exprs, end } or null when it isn't a
   * tag. A {…} value is its JSON when it is JSON, else the raw expression
   * text (its name listed in `exprs`: a value nobody worked out).
   */
  const parseTag = (text, i) => {
    const m = /^<(\/?)([A-Za-z][\w-]*)/.exec(text.slice(i, i + 64));
    if (!m) return null;
    const closing = m[1] === '/';
    const name = m[2];
    let j = i + m[0].length;
    const attrs = {};
    const exprs = [];
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '>') return { name, closing, selfClosing: false, attrs, exprs, end: j + 1 };
      if (text[j] === '/' && text[j + 1] === '>') return { name, closing, selfClosing: true, attrs, exprs, end: j + 2 };
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
        const k = braceEnd(text, j);
        if (k < 0) return null;
        const raw = text.slice(j + 1, k - 1).trim();
        let val = raw;
        try {
          val = JSON.parse(raw);
        } catch (_) {
          exprs.push(a[0]); // keep the raw expression
        }
        attrs[a[0]] = val;
        j = k;
      } else {
        const bare = /^[^\s/>]+/.exec(text.slice(j));
        if (!bare) return null;
        attrs[a[0]] = bare[0];
        j += bare[0].length;
      }
    }
  };

  g.parse = { isObject, hasOwn, decodeEntities, encodeEntities, braceEnd, parseTag };
})();
