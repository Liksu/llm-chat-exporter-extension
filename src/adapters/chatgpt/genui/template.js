/**
 * ChatGPT generative UI -- the program around the components.
 *
 * Besides tags the model writes a little Svelte-like program:
 *
 *   {@body const [days,setDays] = DIL.useState("14")}   state + its setter
 *   {@body const options = [{id:"hiking",label:"…"},…]} a value
 *   {#each options as option, i} … {/each}              repeat markup
 *   {#if days === "14"} … {:else if …} … {:else} … {/if}
 *   {option.label}  value={days}  checked={uses.includes(item)}
 *
 * The export shows the widget as it first appears: each state starts at
 * its useState value, a `const` is worked out when the evaluator can
 * (expr.js), blocks are expanded with that and {expr} values filled in --
 * before the tags are rendered. In a tag an attribute value becomes
 * literal ("14", {["hiking"]}, {true}) so the component sees data.
 *
 * What can't be worked out: a {value} of the program (a name it declared,
 * or a place binding {turnNbusinessM.address}) shows as nothing, as in the
 * server's own static version of the message; an {#if}/{#each} that
 * depends on it is left as written -- render.js then uses the static
 * version for the whole message. Braces that name nothing bound (LaTeX
 * \frac{2}{g}, a set {1, 2} in prose) are text.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { hasOwn, braceEnd, encodeEntities } = g.parse;
  const { MISSING, evaluate } = g.expr;
  const { BINDING_RE } = g.util;

  const NAME = '[A-Za-z_$][\\w$]*';
  const STATE_RE = new RegExp(`^@body\\s+(?:const|let|var)\\s+\\[\\s*(${NAME})\\s*,\\s*${NAME}\\s*\\]\\s*=\\s*DIL\\.useState\\(([\\s\\S]*)\\)\\s*;?\\s*$`);
  const CONST_RE = new RegExp(`^@body\\s+(?:const|let|var)\\s+(${NAME})\\s*=\\s*([\\s\\S]+?);?\\s*$`);
  const EACH_RE = new RegExp(`^\\s*([\\s\\S]+?)\\s+as\\s+(${NAME})(?:\\s*,\\s*(${NAME}))?(?:\\s*\\([^)]*\\))?\\s*$`);

  /** Does the expression name something bound (program, #each, a place)? */
  const isBound = (expr, scope) =>
    BINDING_RE.test(expr.trim()) ||
    (expr.replace(/(["'])(?:\\.|(?!\1)[\s\S])*\1/g, '').match(new RegExp(`(?<![.\\w$])${NAME}`, 'g')) || []).some((n) =>
      hasOwn(scope, n));

  /** A value as JSX shows it: booleans and null as nothing. */
  const shown = (v) =>
    typeof v === 'string' ? v
      : typeof v === 'number' ? String(v)
        : Array.isArray(v) ? v.map(shown).join('')
          : '';

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

  /**
   * The output being built, and whether it is inside a tag (`<rect y=`):
   * there a value is written as an attribute. Quoted attribute values and
   * expressions copied whole don't count.
   */
  const writer = () => ({ out: '', inTag: false, quote: null });
  const write = (w, s) => {
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (!w.inTag) {
        if (c === '<' && /[A-Za-z/]/.test(s[k + 1] || '')) w.inTag = true;
      } else if (w.quote) {
        if (c === w.quote) w.quote = null;
      } else if (c === '"' || c === "'") w.quote = c;
      else if (c === '>') w.inTag = false;
    }
    w.out += s;
  };

  const expand = (text, scope, w) => {
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf('{', i);
      if (j < 0) break;
      write(w, text.slice(i, j));
      const end = braceEnd(text, j);
      if (end < 0) {
        write(w, text.slice(j));
        return;
      }
      const inner = text.slice(j + 1, end - 1);
      // {@body …}: a declaration of the program (its line goes too).
      if (inner.startsWith('@body') && (STATE_RE.test(inner) || CONST_RE.test(inner))) {
        const [, name, init] = STATE_RE.exec(inner) || CONST_RE.exec(inner);
        scope[name] = init.trim() ? evaluate(init, scope) : undefined;
        i = end + (/^[ \t]*\n/.exec(text.slice(end)) || [''])[0].length;
        continue;
      }
      const block = /^\{#(each|if)\s/.exec(text.slice(j, j + 8));
      if (block) {
        const b = scanBlock(text, j, block[1]);
        if (!b) {
          write(w, text.slice(j));
          return;
        }
        if (block[1] === 'each') {
          const h = EACH_RE.exec(b.head);
          const list = h ? evaluate(h[1], scope) : MISSING;
          if (!Array.isArray(list)) write(w, text.slice(j, b.end));
          else {
            list.forEach((item, n) => {
              const local = { ...scope, [h[2]]: item };
              if (h[3]) local[h[3]] = n;
              expand(b.branches[0].body, local, w);
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
          if (unknown) write(w, text.slice(j, b.end));
          else if (chosen) expand(chosen.body, scope, w);
        }
        i = b.end;
        continue;
      }
      if (/^[@#:/]/.test(inner)) {
        // Template syntax this doesn't know: left as written.
        write(w, text.slice(j, end));
      } else if (w.inTag && !w.quote && w.out.endsWith('=')) {
        // An attribute value: as literal data, or left as written.
        let v = evaluate(inner, scope);
        // A place the chat never resolved shows nothing on the page either.
        if (v === MISSING && BINDING_RE.test(inner.trim())) v = undefined;
        w.out +=
          v === MISSING || typeof v === 'function' ? text.slice(j, end)
            : typeof v === 'string' || typeof v === 'number' ? `"${encodeEntities(String(v))}"`
              : v == null ? '""'
                : `{${JSON.stringify(v)}}`;
      } else if (isBound(inner, scope)) {
        const v = evaluate(inner, scope);
        write(w, v === MISSING ? '' : shown(v));
      } else {
        write(w, '{');
        i = j + 1;
        continue;
      }
      i = end;
    }
    write(w, text.slice(i));
  };

  /**
   * Expand the program, blocks and values of one text. `scope` holds the
   * names bound so far (places by ref, then the program's declarations,
   * which it gains); it is shared by the texts of one message.
   */
  const expandTemplates = (text, scope) => {
    if (!text.includes('{')) return text;
    const w = writer();
    expand(text, scope, w);
    return w.out;
  };

  g.template = { expandTemplates };
})();
