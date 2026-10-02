#!/usr/bin/env node
/**
 * Schema drift: spot API shape changes before they turn into broken exports.
 *
 * Providers change their private chat APIs without notice (claude.ai once
 * started listing every uploaded image a second time as an `image` content
 * block -- exports silently got duplicates). This tool records the *shape*
 * of the JSON responses the extension consumes -- key paths, value types,
 * and the values of discriminator fields like `type` -- in a baseline, and
 * reports anything new: new fields, new block types, new tools, new
 * endpoints. Something new is either a format change to adapt to or a
 * feature the exporter doesn't support yet.
 *
 * Usage:
 *   node tools/schema-drift.js <input>... [--baseline <file>] [--update] [--json] [--verbose]
 *
 * <input> can be:
 *   - a .har file (the extension's ".debug.har" or a DevTools export)
 *   - a test scenario directory (scenario.json + responses/)
 *   - any directory: searched recursively for the two kinds above
 *
 * Options:
 *   --baseline <file>  default: tests/schema-baseline.json (gitignored --
 *                      it may hold tool names from your own connectors)
 *   --update           merge what was seen into the baseline (accept it)
 *   --json             machine-readable report
 *   --verbose          list every path of a brand-new endpoint
 *
 * Exit code: 1 when anything new was found (and not --update), else 0.
 *
 * What is recorded: object keys (ids and free-form keys collapsed to
 * `{id}` / `{key}`), JSON types per path, and short identifier-like values
 * of discriminator keys (type, kind, content_type, role, ...; tool names).
 * Never message text. Non-JSON responses (images, Gemini's batchexecute
 * framing) are skipped.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE = process.env.SCHEMA_BASELINE || path.join(REPO_ROOT, 'tests', 'schema-baseline.json');

// -- shape extraction ---------------------------------------------------------

/** Keys whose (short, identifier-like) values are worth tracking. */
const DISCRIMINATORS = new Set([
  'type', 'kind', 'file_kind', 'content_type', 'media_type', 'mime_type',
  'role', 'sender', 'recipient', 'channel', 'status', 'stop_reason',
  'message_type', 'finish_reason', 'display_type', 'source', 'model',
]);
const TOKEN_RE = /^[A-Za-z0-9_.:/+@-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAIN_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const MAX_DEPTH = 40;
/** Keys known to hold id-keyed maps even when the ids don't look like ids. */
const MAP_KEYS = new Set(['mapping']);

const isIdLike = (s) =>
  UUID_RE.test(s) ||
  /^\d+$/.test(s) ||
  /^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s) ||
  /^(file|msg|toolu|srvtoolu|call|att|conv|chatcmpl|wrb|c|r|rc)[-_][A-Za-z0-9_-]{6,}$/i.test(s) ||
  (s.length >= 16 && /^[A-Za-z0-9_-]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s));

/** Values are kept unless they are plainly ids (a model name like
 *  "gpt-5-6-thinking" would trip the looser key heuristic). */
const isIdValue = (s) => UUID_RE.test(s) || /^d+$/.test(s) || (/^[0-9a-f]{12,}$/i.test(s) && /d/.test(s));

/** Tool-ish objects: their `name` is a tool name, not user content. */
const isToolNode = (obj) =>
  (typeof obj.type === 'string' && /tool/i.test(obj.type)) ||
  (obj.role === 'tool');

/**
 * Walk a JSON value and collect { paths: Map<path, Set<type>>,
 * values: Map<path, Set<value>> }.
 */
const extractShape = (root) => {
  const paths = new Map();
  const values = new Map();
  const note = (map, p, v) => {
    if (!map.has(p)) map.set(p, new Set());
    map.get(p).add(v);
  };
  const walk = (v, p, depth, parentKey) => {
    if (depth > MAX_DEPTH) return;
    if (v === null) return note(paths, p, 'null');
    if (Array.isArray(v)) {
      note(paths, p, 'array');
      for (const item of v) walk(item, `${p}[]`, depth + 1, parentKey);
      return;
    }
    if (typeof v !== 'object') return note(paths, p, typeof v);
    note(paths, p, 'object');
    const keys = Object.keys(v);
    // Objects keyed by ids (ChatGPT's `mapping`) are maps: one shape for
    // all entries, including the odd non-id key like "client-created-root".
    const idKeys = keys.filter(isIdLike).length;
    const isMap = MAP_KEYS.has(parentKey) || (keys.length > 0 && idKeys * 2 >= keys.length);
    const toolNode = isToolNode(v);
    for (const k of keys) {
      const seg = isMap || isIdLike(k) ? '{id}' : PLAIN_KEY_RE.test(k) ? k : '{key}';
      const child = p ? `${p}.${seg}` : seg;
      const val = v[k];
      if (typeof val === 'string' && TOKEN_RE.test(val) && !isIdValue(val) &&
          (DISCRIMINATORS.has(k) || (k === 'name' && toolNode))) {
        note(values, child, val);
      }
      walk(val, child, depth + 1, k);
    }
  };
  walk(root, '', 0, null);
  return { paths, values };
};

/** Endpoint key: method + host + path with id-like segments collapsed. */
const endpointKey = (method, url) => {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  const segs = u.pathname.split('/').map((s) => (s && isIdLike(s) ? '{id}' : s));
  return `${(method || 'GET').toUpperCase()} ${u.host}${segs.join('/')}`;
};

const parseJson = (text) => {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(/^﻿/, '').replace(/^\)\]\}'\s*/, '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    return JSON.parse(t);
  } catch (_) {
    return undefined;
  }
};

// -- input loading ------------------------------------------------------------

/** Yields { endpoint, json, source } for every JSON response in an input. */
const responsesFromHar = (file) => {
  const out = [];
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of (har.log && har.log.entries) || []) {
    const c = e.response && e.response.content;
    if (!c || c.text == null || e.response.status < 200 || e.response.status >= 300) continue;
    const text = c.encoding === 'base64' ? Buffer.from(c.text, 'base64').toString('utf8') : c.text;
    const json = parseJson(text);
    if (json === undefined) continue;
    const endpoint = endpointKey(e.request.method, e.request.url);
    if (endpoint) out.push({ endpoint, json, source: file });
  }
  return out;
};

const responsesFromScenario = (dir) => {
  const out = [];
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  for (const m of scenario.mocks || []) {
    if (m.status && (m.status < 200 || m.status >= 300)) continue;
    if (!m.path) continue; // pathRegex routes have no concrete URL
    const file = path.join(dir, 'responses', m.file);
    if (!fs.existsSync(file)) continue;
    const json = parseJson(fs.readFileSync(file, 'utf8'));
    if (json === undefined) continue;
    const endpoint = endpointKey(m.method, `${m.host || scenario.host}${m.path}`);
    if (endpoint) out.push({ endpoint, json, source: file });
  }
  return out;
};

const discover = (p, out) => {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (/\.har$/i.test(p)) out.push({ kind: 'har', path: p });
    return;
  }
  if (fs.existsSync(path.join(p, 'scenario.json'))) {
    out.push({ kind: 'scenario', path: p });
    return;
  }
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    discover(path.join(p, ent.name), out);
  }
};

// -- baseline -----------------------------------------------------------------

/** Observed shapes merged per endpoint: Map<endpoint, {paths, values}>. */
const collect = (responses) => {
  const byEndpoint = new Map();
  for (const r of responses) {
    const shape = extractShape(r.json);
    if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, { paths: new Map(), values: new Map(), sources: new Set() });
    const acc = byEndpoint.get(r.endpoint);
    acc.sources.add(r.source);
    for (const [k, set] of shape.paths) {
      if (!acc.paths.has(k)) acc.paths.set(k, new Set());
      for (const t of set) acc.paths.get(k).add(t);
    }
    for (const [k, set] of shape.values) {
      if (!acc.values.has(k)) acc.values.set(k, new Set());
      for (const t of set) acc.values.get(k).add(t);
    }
  }
  return byEndpoint;
};

const loadBaseline = (file) => {
  if (!fs.existsSync(file)) return { version: 1, endpoints: {} };
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: 1, endpoints: b.endpoints || {} };
};

/** What `observed` has that `baseline` lacks. */
const diff = (baseline, observed) => {
  const report = [];
  for (const [endpoint, obs] of observed) {
    const base = baseline.endpoints[endpoint];
    if (!base) {
      report.push({
        endpoint,
        newEndpoint: true,
        newPaths: [...obs.paths.keys()].sort().map((p) => ({ path: p, types: [...obs.paths.get(p)].sort() })),
        newTypes: [],
        newValues: [...obs.values.keys()].sort().map((p) => ({ path: p, values: [...obs.values.get(p)].sort() })),
        sources: [...obs.sources],
      });
      continue;
    }
    const newPaths = [];
    const newTypes = [];
    const newValues = [];
    for (const [p, types] of obs.paths) {
      const known = base.paths[p];
      if (!known) newPaths.push({ path: p, types: [...types].sort() });
      else {
        const extra = [...types].filter((t) => !known.includes(t));
        if (extra.length) newTypes.push({ path: p, types: extra.sort(), known });
      }
    }
    for (const [p, vals] of obs.values) {
      const known = (base.values && base.values[p]) || [];
      const extra = [...vals].filter((v) => !known.includes(v));
      if (extra.length) newValues.push({ path: p, values: extra.sort(), known });
    }
    if (newPaths.length || newTypes.length || newValues.length) {
      newPaths.sort((a, b) => a.path.localeCompare(b.path));
      report.push({ endpoint, newEndpoint: false, newPaths, newTypes, newValues, sources: [...obs.sources] });
    }
  }
  return report.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
};

const merge = (baseline, observed) => {
  const out = { version: 1, endpoints: { ...baseline.endpoints } };
  for (const [endpoint, obs] of observed) {
    const base = out.endpoints[endpoint] || { paths: {}, values: {} };
    const paths = { ...base.paths };
    const values = { ...(base.values || {}) };
    for (const [p, types] of obs.paths) paths[p] = [...new Set([...(paths[p] || []), ...types])].sort();
    for (const [p, vals] of obs.values) values[p] = [...new Set([...(values[p] || []), ...vals])].sort();
    const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    out.endpoints[endpoint] = { paths: sortObj(paths), values: sortObj(values) };
  }
  out.endpoints = Object.fromEntries(Object.keys(out.endpoints).sort().map((k) => [k, out.endpoints[k]]));
  return out;
};

// -- CLI ----------------------------------------------------------------------

const main = () => {
  const argv = process.argv.slice(2);
  const opts = { inputs: [], baseline: DEFAULT_BASELINE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--update') opts.update = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a.startsWith('--')) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else opts.inputs.push(a);
  }
  if (!opts.inputs.length) {
    console.error('Usage: node tools/schema-drift.js <file.har|scenario-dir|dir>... [--baseline <file>] [--update] [--json] [--verbose]');
    process.exit(2);
  }

  const targets = [];
  for (const p of opts.inputs) {
    if (!fs.existsSync(p)) {
      console.error(`Not found: ${p}`);
      process.exit(2);
    }
    discover(p, targets);
  }
  const responses = [];
  for (const t of targets) {
    try {
      responses.push(...(t.kind === 'har' ? responsesFromHar(t.path) : responsesFromScenario(t.path)));
    } catch (e) {
      console.error(`Skipping ${t.path}: ${e.message}`);
    }
  }

  const baseline = loadBaseline(opts.baseline);
  const observed = collect(responses);
  const report = diff(baseline, observed);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ inputs: targets.length, responses: responses.length, drift: report }, null, 2) + '\n');
  } else {
    console.log(`${targets.length} input(s), ${responses.length} JSON response(s), ${observed.size} endpoint(s); baseline: ${path.relative(process.cwd(), opts.baseline) || opts.baseline}${fs.existsSync(opts.baseline) ? '' : ' (none yet)'}`);
    for (const r of report) {
      console.log(`\n${r.newEndpoint ? 'NEW ENDPOINT' : 'CHANGED'}  ${r.endpoint}`);
      console.log(`  seen in: ${r.sources.slice(0, 3).join(', ')}${r.sources.length > 3 ? `, +${r.sources.length - 3}` : ''}`);
      if (r.newEndpoint && !opts.verbose) {
        console.log(`  ${r.newPaths.length} path(s), ${r.newValues.length} tracked value field(s) — --verbose to list`);
        continue;
      }
      for (const x of r.newValues) {
        console.log(`  + value  ${x.path} = ${x.values.join(', ')}${x.known && x.known.length ? `   (known: ${x.known.join(', ')})` : ''}`);
      }
      for (const x of r.newPaths) console.log(`  + field  ${x.path || '(root)'} : ${x.types.join('|')}`);
      for (const x of r.newTypes) console.log(`  ~ type   ${x.path} : now also ${x.types.join('|')} (was ${x.known.join('|')})`);
    }
    if (!report.length) console.log('\nNo drift: everything matches the baseline.');
  }

  if (opts.update) {
    fs.mkdirSync(path.dirname(opts.baseline), { recursive: true });
    fs.writeFileSync(opts.baseline, JSON.stringify(merge(baseline, observed), null, 1) + '\n');
    if (!opts.json) console.log(`\nBaseline updated: ${opts.baseline}`);
    process.exit(0);
  }
  process.exit(report.length ? 1 : 0);
};

if (require.main === module) main();

module.exports = { extractShape, endpointKey, collect, diff, merge, loadBaseline, responsesFromHar, responsesFromScenario, DEFAULT_BASELINE };
