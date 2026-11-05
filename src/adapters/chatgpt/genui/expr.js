/**
 * ChatGPT generative UI -- the expressions of the program and its tags:
 *
 *   {days}  value={uses.includes(item)}  y={n.y+27}  {money(total/6)}
 *   fill={i===2?"#DDEBFA":"#E9EDF1"}  d={`M160 ${n.y+46} v22`}
 *   const visible = events.map((e,i)=>({...e,i})).filter(e=>filter==="All"||e.type===filter)
 *
 * A small interpreter over the parsed expression (no eval): literals (bare
 * object keys, shorthand, spread), names, member access, ! && || ?? ?:,
 * comparisons, arithmetic, template strings, single-expression arrow
 * functions, and a fixed set of pure helpers -- array map/filter/find/
 * findIndex/some/every/flatMap/reduce/slice/sort/includes/indexOf/join/
 * concat, string case/trim/includes/startsWith/endsWith/slice/replace/
 * split/padStart, number toFixed/toLocaleString (en-US), Math.*, Number,
 * String, parseFloat, parseInt, Array.from.
 *
 * Anything else -- statement bodies (`=> {…}`), assignments, Math.random,
 * other globals and methods -- makes the expression unknown (MISSING), and
 * so does any unknown part it needs. && || ?: are lazy, so an unknown part
 * in a branch not taken doesn't matter. Work is bounded (steps, call depth,
 * array and string size), so a runaway expression is unknown too.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { isObject, hasOwn, braceEnd } = g.parse;

  // The value of an expression that can't be worked out.
  const MISSING = Symbol('missing');
  // Thrown inside, caught by evaluate(): "unknown".
  const fail = () => {
    throw MISSING;
  };
  const LIMITS = { steps: 100000, depth: 64, items: 10000, chars: 1000000 };

  // -- Syntax -----------------------------------------------------------------

  const PUNCT = ['===', '!==', '...', '?.', '??', '&&', '||', '==', '!=', '<=', '>=', '=>', '**'];
  const WORDS = { true: true, false: false, null: null, undefined };

  /** Tokens of an expression: {t: num|str|tpl|id|op, v}. Throws on junk. */
  const tokenize = (src) => {
    const out = [];
    let i = 0;
    const readString = (q) => {
      let s = '';
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === '\\') {
          const e = src[++i];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += src[i];
      }
      if (src[i] !== q) throw new Error('unterminated string');
      i++;
      return s;
    };
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      const num = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 32));
      if (num) {
        out.push({ t: 'num', v: Number(num[0]) });
        i += num[0].length;
      } else if (c === '"' || c === "'") {
        out.push({ t: 'str', v: readString(c) });
      } else if (c === '`') {
        // `a ${x} b` → parts: strings and the source of each ${…}
        const parts = [];
        let s = '';
        for (i++; i < src.length && src[i] !== '`'; i++) {
          if (src[i] === '\\') s += src[++i];
          else if (src[i] === '$' && src[i + 1] === '{') {
            const end = braceEnd(src, i + 1);
            if (end < 0) throw new Error('unterminated template');
            parts.push(s, { src: src.slice(i + 2, end - 1) });
            s = '';
            i = end - 1;
          } else s += src[i];
        }
        if (src[i] !== '`') throw new Error('unterminated template');
        i++;
        parts.push(s);
        out.push({ t: 'tpl', v: parts });
      } else if (/[A-Za-z_$]/.test(c)) {
        const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))[0];
        out.push({ t: 'id', v: id });
        i += id.length;
      } else {
        const op = PUNCT.find((p) => src.startsWith(p, i)) || c;
        if (!/^[-+*/%<>!?:.,()[\]{}]$/.test(op) && !PUNCT.includes(op)) throw new Error(`unexpected ${op}`);
        out.push({ t: 'op', v: op });
        i += op.length;
      }
    }
    return out;
  };

  // Binary operators by precedence, loosest first (** binds tighter, below).
  const LEVELS = [['??'], ['||'], ['&&'], ['===', '!==', '==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];

  /** Expression source → syntax tree (throws on anything it doesn't know). */
  const parseExpr = (src) => {
    const toks = tokenize(src);
    let p = 0;
    const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;
    const peek = (v) => isOp(toks[p], v);
    const expect = (v) => {
      if (!peek(v)) throw new Error(`expected ${v}`);
      p++;
    };
    // `x =>` or `(a, b) =>` ahead: the parameter names, else null.
    const arrowParams = () => {
      if (toks[p] && toks[p].t === 'id' && isOp(toks[p + 1], '=>')) return [[toks[p].v], p + 2];
      if (!peek('(')) return null;
      const names = [];
      let k = p + 1;
      while (!isOp(toks[k], ')')) {
        if (!toks[k] || toks[k].t !== 'id') return null;
        names.push(toks[k++].v);
        if (isOp(toks[k], ',')) k++;
        else if (!isOp(toks[k], ')')) return null;
      }
      return isOp(toks[k + 1], '=>') ? [names, k + 2] : null;
    };
    const expression = () => {
      const arrow = arrowParams();
      if (!arrow) return ternary();
      p = arrow[1];
      if (peek('{')) throw new Error('statement bodies are not evaluated');
      return { k: 'fn', params: arrow[0], body: expression() };
    };
    const ternary = () => {
      const c = binary(0);
      if (!peek('?')) return c;
      p++;
      const a = expression();
      expect(':');
      return { k: 'cond', c, a, b: expression() };
    };
    const binary = (level) => {
      if (level === LEVELS.length) return power();
      let left = binary(level + 1);
      while (toks[p] && toks[p].t === 'op' && LEVELS[level].includes(toks[p].v)) {
        const op = toks[p++].v;
        left = { k: 'bin', op, a: left, b: binary(level + 1) };
      }
      return left;
    };
    const power = () => {
      const base = unary();
      if (!peek('**')) return base;
      p++;
      return { k: 'bin', op: '**', a: base, b: power() };
    };
    const unary = () => {
      if (peek('!') || peek('-') || peek('+')) {
        const op = toks[p++].v;
        return { k: 'un', op, a: unary() };
      }
      return postfix(primary());
    };
    // Comma-separated items up to `close`, `...x` allowed.
    const items = (close) => {
      const list = [];
      while (!peek(close)) {
        if (peek('...')) {
          p++;
          list.push({ k: 'spread', a: expression() });
        } else list.push(expression());
        if (!peek(close)) expect(',');
      }
      p++;
      return list;
    };
    const postfix = (node) => {
      for (;;) {
        if (peek('.') || peek('?.')) {
          p++;
          const t = toks[p++];
          if (!t || t.t !== 'id') throw new Error('expected a name');
          node = { k: 'mem', o: node, key: { k: 'lit', v: t.v } };
        } else if (peek('[')) {
          p++;
          const key = expression();
          expect(']');
          node = { k: 'mem', o: node, key };
        } else if (peek('(')) {
          p++;
          node = { k: 'call', callee: node, args: items(')') };
        } else return node;
      }
    };
    const primary = () => {
      const t = toks[p++];
      if (!t) throw new Error('unexpected end');
      if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'tpl') return { k: 'tpl', parts: t.v.map((x) => (typeof x === 'string' ? x : parseExpr(x.src))) };
      if (t.t === 'id') return hasOwn(WORDS, t.v) ? { k: 'lit', v: WORDS[t.v] } : { k: 'id', name: t.v };
      if (t.v === '(') {
        const e = expression();
        expect(')');
        return e;
      }
      if (t.v === '[') return { k: 'arr', items: items(']') };
      if (t.v === '{') {
        const props = [];
        while (!peek('}')) {
          if (peek('...')) {
            p++;
            props.push({ spread: expression() });
          } else if (peek('[')) {
            p++;
            const key = expression();
            expect(']');
            expect(':');
            props.push({ key, value: expression() });
          } else {
            const key = toks[p++];
            if (!key || !['id', 'str', 'num'].includes(key.t)) throw new Error('bad key');
            const name = { k: 'lit', v: String(key.v) };
            if (key.t === 'id' && (peek(',') || peek('}'))) props.push({ key: name, value: { k: 'id', name: key.v } });
            else {
              expect(':');
              props.push({ key: name, value: expression() });
            }
          }
          if (!peek('}')) expect(',');
        }
        p++;
        return { k: 'obj', props };
      }
      throw new Error(`unexpected ${t.v}`);
    };
    const tree = expression();
    if (p !== toks.length) throw new Error('trailing tokens');
    return tree;
  };

  // -- Values -----------------------------------------------------------------

  const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol');
  const isData = (v) => Array.isArray(v) || isObject(v);

  // Work done by the current evaluate() (closures made earlier use it too).
  let budget = { steps: 0, depth: 0 };
  const call = (f, ...args) => (typeof f === 'function' ? f(...args) : fail());
  const num = (v) => (typeof v === 'number' ? v : fail());
  const strArg = (v) => (typeof v === 'string' ? v : fail());
  const many = (n) => (n > LIMITS.items ? fail() : n);
  const long = (n) => (n > LIMITS.chars ? fail() : n);
  // A list or string an operator or helper made: within the caps. (Checked
  // after: + and template strings don't copy, and doubling a string in a
  // loop takes only a few steps.)
  const capped = (v) => (typeof v === 'string' ? (long(v.length), v) : Array.isArray(v) ? (many(v.length), v) : v);

  // The helpers by the type of value they're called on. Callbacks get
  // (item, index, array) like JS's; results are new values (sort copies).
  const ARRAY = {
    map: (a, f) => a.map((x, i) => call(f, x, i, a)),
    filter: (a, f) => a.filter((x, i) => call(f, x, i, a)),
    find: (a, f) => a.find((x, i) => call(f, x, i, a)),
    findIndex: (a, f) => a.findIndex((x, i) => call(f, x, i, a)),
    some: (a, f) => a.some((x, i) => call(f, x, i, a)),
    every: (a, f) => a.every((x, i) => call(f, x, i, a)),
    // flatMap and concat grow the list: checked as it grows, not after.
    flatMap: (a, f) => a.reduce((out, x, i) => {
      const r = call(f, x, i, a);
      many(out.length + (Array.isArray(r) ? r.length : 1));
      return Array.isArray(r) ? out.concat(r) : (out.push(r), out);
    }, []),
    reduce: (a, f, ...init) => (init.length ? a.reduce((acc, x, i) => call(f, acc, x, i, a), init[0]) : a.length ? a.reduce((acc, x, i) => call(f, acc, x, i, a)) : fail()),
    slice: (a, s, e) => a.slice(s, e),
    includes: (a, x) => a.includes(x),
    indexOf: (a, x) => a.indexOf(x),
    // Its length is checked before it is built: join copies.
    join: (a, sep) => {
      if (!a.every(isPrimitive)) fail();
      const s = sep === undefined ? ',' : String(sep);
      long(a.reduce((n, x) => n + (x == null ? 0 : String(x).length), s.length * Math.max(0, a.length - 1)));
      return a.join(s);
    },
    concat: (a, ...more) => (many(more.reduce((n, m) => n + (Array.isArray(m) ? m.length : 1), a.length)), a.concat(...more)),
    sort: (a, f) => (f === undefined ? (a.every(isPrimitive) ? [...a].sort() : fail()) : [...a].sort((x, y) => num(call(f, x, y)))),
    reverse: (a) => [...a].reverse(),
  };
  const STRING = {
    toUpperCase: (s) => s.toUpperCase(),
    toLowerCase: (s) => s.toLowerCase(),
    trim: (s) => s.trim(),
    includes: (s, x) => s.includes(strArg(x)),
    startsWith: (s, x) => s.startsWith(strArg(x)),
    endsWith: (s, x) => s.endsWith(strArg(x)),
    indexOf: (s, x) => s.indexOf(strArg(x)),
    slice: (s, a, b) => s.slice(a, b),
    // String patterns only; the replacement is taken literally.
    replace: (s, a, b) => s.replace(strArg(a), () => strArg(b)),
    replaceAll: (s, a, b) => ARRAY.join(s.split(strArg(a)), strArg(b)),
    split: (s, sep) => s.split(strArg(sep)),
    padStart: (s, n, fill) => s.padStart(long(num(n)), fill === undefined ? ' ' : strArg(fill)),
    toString: (s) => s,
  };
  const NUMBER = {
    toFixed: (n, d) => n.toFixed(d === undefined ? 0 : Math.min(20, Math.max(0, num(d)))),
    // Always en-US: the export doesn't depend on the machine's locale.
    toLocaleString: (n, locale, opts) =>
      (locale === undefined || locale === 'en-US') && (opts === undefined || (isObject(opts) && Object.values(opts).every(isPrimitive)))
        ? n.toLocaleString('en-US', opts)
        : fail(),
    toString: (n) => String(n),
  };
  const methodsOf = (v) => (Array.isArray(v) ? ARRAY : typeof v === 'string' ? STRING : typeof v === 'number' ? NUMBER : null);

  // One-argument functions take just that (portions.map(Math.floor)).
  const MATH1 = ['round', 'floor', 'ceil', 'abs', 'sqrt', 'sign', 'trunc', 'sin', 'cos', 'tan'];
  const GLOBALS = {
    Math: Object.freeze({
      PI: Math.PI,
      E: Math.E,
      ...Object.fromEntries(MATH1.map((name) => [name, (x) => Math[name](num(x))])),
      pow: (x, y) => Math.pow(num(x), num(y)),
      min: (...a) => Math.min(...a.map(num)),
      max: (...a) => Math.max(...a.map(num)),
    }),
    Number: (v) => (isPrimitive(v) ? Number(v) : fail()),
    String: (v) => (isPrimitive(v) ? String(v) : fail()),
    parseFloat: (v) => (isPrimitive(v) ? parseFloat(v) : fail()),
    parseInt: (v, r) => (isPrimitive(v) ? parseInt(v, r) : fail()),
    Array: Object.freeze({
      isArray: (v) => Array.isArray(v),
      from: (src, f) => {
        const list = Array.isArray(src) ? src : isObject(src) ? Array(many(num(src.length))).fill(undefined) : fail();
        return f === undefined ? [...list] : list.map((x, i) => call(f, x, i));
      },
    }),
  };

  // A property of data: own keys of plain objects and arrays, .length.
  const member = (o, key) => {
    if (o == null) return undefined;
    if (typeof key !== 'string' && typeof key !== 'number') fail();
    if ((typeof o === 'string' || Array.isArray(o)) && key === 'length') return o.length;
    if (typeof o === 'string' || isData(o)) return hasOwn(o, key) ? o[key] : undefined;
    return typeof o === 'number' || typeof o === 'boolean' ? undefined : fail();
  };

  const binaryOp = (op, a, b) => {
    if (op === '===') return a === b;
    if (op === '!==') return a !== b;
    if (!isPrimitive(a) || !isPrimitive(b)) fail();
    switch (op) {
      case '==': return a == b; // eslint-disable-line eqeqeq
      case '!=': return a != b; // eslint-disable-line eqeqeq
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      case '+': return capped(a + b);
      default: {
        // JS turns numeric strings into numbers here ("180" * 1).
        const [x, y] = [a, b].map((v) => (v === undefined ? fail() : Number(v)));
        return op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : op === '%' ? x % y : x ** y;
      }
    }
  };

  const lookup = (scope, name) => {
    if (hasOwn(scope, name)) return scope[name] === MISSING ? fail() : scope[name];
    return hasOwn(GLOBALS, name) ? GLOBALS[name] : fail();
  };

  const evalNode = (n, scope) => {
    if (++budget.steps > LIMITS.steps) fail();
    switch (n.k) {
      case 'lit': return n.v;
      case 'id': return lookup(scope, n.name);
      case 'mem': return member(evalNode(n.o, scope), evalNode(n.key, scope));
      case 'call': {
        const args = [];
        for (const a of n.args) {
          if (a.k !== 'spread') args.push(evalNode(a, scope));
          else {
            const v = evalNode(a.a, scope);
            args.push(...(Array.isArray(v) ? v : fail()));
          }
        }
        if (n.callee.k !== 'mem') return call(evalNode(n.callee, scope), ...args);
        const o = evalNode(n.callee.o, scope);
        const name = evalNode(n.callee.key, scope);
        const methods = methodsOf(o);
        if (methods) return hasOwn(methods, name) ? capped(methods[name](o, ...args)) : fail();
        return call(member(o, name), ...args);
      }
      case 'fn':
        // A closure over the scope it was made in; its body is evaluated
        // when called, within the budget of whoever calls it.
        return (...args) => {
          if (++budget.depth > LIMITS.depth) fail();
          try {
            const local = { ...scope };
            n.params.forEach((name, i) => {
              local[name] = args[i];
            });
            return evalNode(n.body, local);
          } finally {
            budget.depth--;
          }
        };
      case 'un': {
        const a = evalNode(n.a, scope);
        if (n.op === '!') return !a;
        return n.op === '-' ? binaryOp('-', 0, a) : binaryOp('-', a, 0);
      }
      case 'bin': {
        const a = evalNode(n.a, scope);
        if (n.op === '&&') return a ? evalNode(n.b, scope) : a;
        if (n.op === '||') return a ? a : evalNode(n.b, scope);
        if (n.op === '??') return a != null ? a : evalNode(n.b, scope);
        return binaryOp(n.op, a, evalNode(n.b, scope));
      }
      case 'cond': return evalNode(evalNode(n.c, scope) ? n.a : n.b, scope);
      case 'tpl': {
        let s = '';
        for (const part of n.parts) {
          const v = typeof part === 'string' ? part : evalNode(part, scope);
          if (!isPrimitive(v)) fail();
          s += v == null ? '' : String(v);
        }
        return capped(s);
      }
      case 'arr': {
        const out = [];
        for (const x of n.items) {
          if (x.k !== 'spread') out.push(evalNode(x, scope));
          else {
            const v = evalNode(x.a, scope);
            out.push(...(Array.isArray(v) ? v : fail()));
          }
        }
        many(out.length);
        return out;
      }
      case 'obj': {
        const o = {};
        for (const prop of n.props) {
          if (prop.spread) {
            const v = evalNode(prop.spread, scope);
            if (isObject(v)) Object.assign(o, v);
            else if (v != null) fail();
          } else {
            const key = evalNode(prop.key, scope);
            if (!isPrimitive(key) || key === '__proto__') fail();
            o[String(key)] = evalNode(prop.value, scope);
          }
        }
        return o;
      }
      default: return fail();
    }
  };

  // The same expressions come back in every {#each} pass: parse them once.
  const parsed = new Map();
  /** Value of an expression in scope, or MISSING. */
  const evaluate = (expr, scope) => {
    const src = String(expr).trim();
    let tree = parsed.get(src);
    if (tree === undefined) {
      try {
        tree = parseExpr(src);
      } catch (_) {
        tree = null;
      }
      if (parsed.size > 2000) parsed.clear();
      parsed.set(src, tree);
    }
    if (!tree) return MISSING;
    const outer = budget;
    budget = { steps: 0, depth: 0 };
    try {
      return evalNode(tree, scope);
    } catch (_) {
      // MISSING thrown, or a runaway (RangeError, …): unknown either way.
      return MISSING;
    } finally {
      budget = outer;
    }
  };

  /** A JS literal (array/object/string/number/bool/null, bare keys); throws otherwise. */
  const parseLiteral = (src) => {
    const v = evaluate(src, {});
    if (v === MISSING || typeof v === 'function') throw new Error('not a literal');
    return v;
  };

  g.expr = { MISSING, evaluate, parseLiteral };
})();
