/**
 * ChatGPT generative UI -- <svg> drawings the model writes inline.
 *
 * They are kept as SVG, with their attributes made valid SVG: JSX names
 * (fillOpacity, strokeWidth, textAnchor) become kebab-case, {literal}
 * values are quoted, style={{…}} objects become CSS. Templates in them
 * ({#each [...] as n} <rect y={n.y}/> {/each}) are expanded before this
 * (template.js); a value still written as an expression there (a formula
 * the evaluator doesn't know) is dropped -- the shape loses that attribute
 * rather than the file carrying JSX.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { isObject, braceEnd } = g.parse;
  const { parseLiteral } = g.expr;

  // SVG attributes that really are camelCase; any other camelCase name is
  // JSX (fillOpacity, strokeWidth, textAnchor) and becomes kebab-case.
  const SVG_CAMEL = new Set([
    'viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits',
    'patternContentUnits', 'patternTransform', 'markerWidth', 'markerHeight', 'markerUnits',
    'refX', 'refY', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'textLength',
    'lengthAdjust', 'startOffset', 'stdDeviation', 'baseFrequency', 'numOctaves', 'pathLength',
    'spreadMethod', 'primitiveUnits', 'filterUnits', 'tableValues', 'xChannelSelector',
    'yChannelSelector', 'surfaceScale', 'kernelMatrix', 'keyTimes', 'keySplines', 'keyPoints',
    'calcMode', 'attributeName', 'attributeType', 'repeatCount', 'repeatDur',
  ]);

  const svgAttrName = (name) =>
    name === 'className' ? 'class'
      : name === 'xlinkHref' ? 'xlink:href'
        : SVG_CAMEL.has(name) ? name
          : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  /** style={{fontSize: 12, fill: "red"}} → style="font-size:12;fill:red" ('' if not a literal). */
  const cssFromObject = (src) => {
    let obj;
    try {
      obj = parseLiteral(src);
    } catch (_) {
      return '';
    }
    if (!isObject(obj)) return '';
    return Object.entries(obj)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${String(v).replace(/["<>]/g, '')}`)
      .join(';');
  };

  /** A tag without its `name={expression}` attributes (braces may nest). */
  const dropExpressions = (tag) => {
    let out = '';
    let i = 0;
    for (const m of tag.matchAll(/\s[\w:-]+\s*=\s*\{/g)) {
      if (m.index < i) continue;
      const end = braceEnd(tag, m.index + m[0].length - 1);
      if (end < 0) break;
      out += tag.slice(i, m.index);
      i = end;
    }
    return out + tag.slice(i);
  };

  /**
   * An <svg> the model drew, as markdown can show it: an HTML block (no
   * blank lines inside, no indentation) with valid SVG attribute names and
   * {literal} values quoted. It is model-written markup going into files
   * other apps render, so anything that runs code goes: <script>,
   * <foreignObject> (HTML inside), on* handlers and javascript: links.
   */
  const svgMarkup = (svg) =>
    svg
      .replace(/<script\b[\s\S]*?<\/script\s*>|<script\b[^>]*\/>/gi, '')
      .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>|<foreignObject\b[^>]*\/>/gi, '')
      .replace(/<[A-Za-z](?:[^<>{]|\{(?:[^{}]|\{[^{}]*\})*\})*>/g, (tag) =>
        dropExpressions(
          tag
            .replace(/\sstyle=\{\{([\s\S]*?)\}\}/g, (_, body) => {
              const css = cssFromObject(`{${body}}`);
              return css ? ` style="${css}"` : '';
            })
            .replace(/\son[A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+)/g, '')
            .replace(/(\s(?:xlink:)?href\s*=\s*)(["'])\s*javascript:[^"']*\2/gi, '$1$2#$2')
            .replace(/(\s)([a-z]+[A-Z][A-Za-z]*)(?=\s*=)/g, (_, sp, name) => sp + svgAttrName(name))
            .replace(/=\{\s*(?:(-?\d+(?:\.\d+)?)|"([^"]*)"|'([^']*)')\s*\}/g, (_, n, d, q) => `="${n ?? d ?? q}"`)
        ))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');

  g.svg = { svgMarkup };
})();
