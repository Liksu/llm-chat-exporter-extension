#!/usr/bin/env node
/**
 * Auditor: sanity-check exported conversations without a golden.
 *
 * Golden tests (tests/) replay recorded API responses, so they never see
 * a provider silently changing its API shape. This tool looks at real
 * exports instead and flags symptoms that are wrong regardless of what the
 * conversation contained: duplicated images, broken links, assets that are
 * not what their extension claims, leaked provider markup, unknown blocks.
 *
 * Usage:
 *   node tools/audit-export.js <path>... [--json] [--quiet]
 *
 * <path> can be:
 *   - a .zip export
 *   - a .md export (single-file mode, images as data URLs)
 *   - an unzipped export directory (contains metadata.json)
 *   - any directory: searched recursively for the three kinds above
 *
 * Options:
 *   --json    machine-readable report on stdout
 *   --quiet   print only exports that have findings
 *
 * Exit code: 1 if any finding has severity "error", else 0.
 *
 * Some checks only see what the export rendered: unknown blocks surface as
 * `Tool call: unknown:<type>` only when the export included reasoning, so
 * audit an export made with "Include reasoning" on for full coverage.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fflate = require('../src/vendor/fflate.min.js');

// -- loading ------------------------------------------------------------------

/**
 * Normalized in-memory view of one export:
 *   { source, mode: 'zip'|'md', mdName, md, files: Map<relPath, Buffer> }
 * `files` holds everything except the .md (assets/, files/, artifacts/,
 * metadata.json). Empty for md mode.
 */
const loadZip = (zipPath) => {
  const raw = fflate.unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const files = new Map();
  let mdName = null;
  let md = null;
  for (const [name, bytes] of Object.entries(raw)) {
    if (name.endsWith('/')) continue;
    const buf = Buffer.from(bytes);
    if (!name.includes('/') && name.toLowerCase().endsWith('.md') && md === null) {
      mdName = name;
      md = buf.toString('utf8');
    } else {
      files.set(name, buf);
    }
  }
  return { source: zipPath, mode: 'zip', mdName, md, files };
};

const loadDir = (dir) => {
  const files = new Map();
  let mdName = null;
  let md = null;
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(a, r);
      else if (!rel && ent.name.toLowerCase().endsWith('.md') && md === null) {
        mdName = ent.name;
        md = fs.readFileSync(a, 'utf8');
      } else files.set(r, fs.readFileSync(a));
    }
  };
  walk(dir, '');
  return { source: dir, mode: 'zip', mdName, md, files };
};

const loadMd = (mdPath) => ({
  source: mdPath,
  mode: 'md',
  mdName: path.basename(mdPath),
  md: fs.readFileSync(mdPath, 'utf8'),
  files: new Map(),
});

/**
 * When scanning a directory we meet unrelated .md/.zip files; keep only
 * what this extension produced. Explicitly named files skip this check.
 */
const looksLikeExport = (kind, p) => {
  try {
    if (kind === 'md') {
      const head = fs.readFileSync(p, 'utf8').slice(0, 2000).split('\n').slice(0, 10);
      return head[0].startsWith('# ') && head.some((l) => /^_Source: .+_\s*$/.test(l));
    }
    const raw = fflate.unzipSync(new Uint8Array(fs.readFileSync(p)), {
      filter: (f) => f.name === 'metadata.json',
    });
    if (!raw['metadata.json']) return false;
    return !!JSON.parse(Buffer.from(raw['metadata.json']).toString('utf8')).sourceLLM;
  } catch (_) {
    return false;
  }
};

/** Expand CLI paths into a list of export locations. */
const discover = (p, out, explicit = true) => {
  const st = fs.statSync(p);
  if (st.isFile()) {
    const kind = /\.zip$/i.test(p) ? 'zip' : /\.md$/i.test(p) ? 'md' : null;
    if (kind && (explicit || looksLikeExport(kind, p))) out.push({ kind, path: p });
    return;
  }
  if (fs.existsSync(path.join(p, 'metadata.json'))) {
    out.push({ kind: 'dir', path: p });
    return;
  }
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    discover(path.join(p, ent.name), out, false);
  }
};

// -- markdown parsing ---------------------------------------------------------

/**
 * Blank out fenced code blocks and inline code spans so links/markers
 * quoted inside code (artifact sources, tool results) are not audited.
 * Line count is preserved so findings can point at line numbers.
 */
const stripCode = (md) => {
  const lines = md.split('\n');
  let fence = null; // { ch, len }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len &&
          lines[i].trim() === m[1]) {
        fence = null;
      }
      lines[i] = '';
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length };
      lines[i] = '';
      continue;
    }
    lines[i] = lines[i].replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length));
  }
  return lines.join('\n');
};

const TURN_RE = /^## (Human|Assistant)( \(🎙️\))?\s*$/;
// Per-turn timestamp line (`includeDates`): italic, has digits, no brackets.
const DATE_LINE_RE = /^_[^_[\]]*\d[^_[\]]*_$/;
const TAIL_RE = /^## (Artifacts|Attachments)\s*$/;

/** Map line index → turn number (1-based), 0 outside turns. */
const turnIndexByLine = (lines) => {
  const out = new Array(lines.length).fill(0);
  let turn = 0;
  let inTail = false;
  for (let i = 0; i < lines.length; i++) {
    if (TAIL_RE.test(lines[i])) inTail = true;
    else if (TURN_RE.test(lines[i]) && !inTail) turn++;
    out[i] = inTail ? 0 : turn;
  }
  return out;
};

/** All `[label](target)` / `![alt](target)` links, with line numbers. */
const findLinks = (codeless) => {
  const links = [];
  const lines = codeless.split('\n');
  const re = /(!?)\[((?:\\.|[^\]\\])*)\]\(([^)\n]+)\)/g;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i]))) {
      links.push({ isImage: m[1] === '!', label: m[2], target: m[3].trim(), line: i + 1 });
    }
  }
  return links;
};

// -- content sniffing ---------------------------------------------------------

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/** Best-effort type from magic bytes; null when unrecognized. */
const sniff = (buf) => {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b.slice(0, 6).toString('ascii').startsWith('GIF8')) return 'gif';
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' &&
      b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 4 && b.slice(0, 4).toString('ascii') === '%PDF') return 'pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  const head = b.slice(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('{') || head.startsWith('[')) return 'json-ish';
  return null;
};

const IMAGE_TYPES = new Set(['png', 'jpg', 'gif', 'webp', 'bmp', 'svg']);
const EXT_ALIASES = { jpeg: 'jpg', jpe: 'jpg' };

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  if (!m) return null;
  const e = m[1].toLowerCase();
  return EXT_ALIASES[e] || e;
};

// -- checks -------------------------------------------------------------------

/** Snippet around a private-use run with the invisible chars spelled out. */
const showPua = (line, index, len) => {
  const from = Math.max(0, index - 10);
  const to = Math.min(line.length, index + len + 40);
  const s = line.slice(from, to).replace(/[-]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return JSON.stringify(s);
};

/**
 * Text markers that mean something leaked through unrendered. Each entry:
 * [code, severity, regex, message]. Run against the code-stripped markdown.
 */
const TEXT_MARKERS = [
  ['unknown-block', 'error', /\*\*Tool call: `unknown:([^`]*)`\*\*/g,
    (m) => `unknown content block type "${m[1]}" (normalizer does not handle it)`],
  ['image-not-loaded', 'error', /_\[image not loaded: ([^\]]*)\]_/g,
    (m) => `image failed to download: ${m[1]}`],
  ['image-placeholder', 'warn', /_\[image: ([^\]]*)\]_/g,
    (m) => `image exported as placeholder (no bytes): ${m[1]} — expected only with "Inline images" off in md mode`],
  ['content-placeholder', 'warn', /_\[(?!image(?: not loaded)?: )([^\]\n]+)\]_/g,
    (m) => `content exported only as a placeholder (unsupported kind?): [${m[1]}]`],
  ['file-unavailable', 'warn', /📎 ~~(.+?)~~ _\(no longer available\)_/g,
    (m) => `attachment could not be downloaded: ${m[1]}`],
  ['unsupported-placeholder', 'error', /This block is not supported on your current device yet/g,
    () => 'claude.ai "not supported on your device" placeholder leaked into the text'],
  ['private-use-chars', 'error', /[-]+/g,
    (m) => `private-use characters leaked (provider citation/entity markup?): ${showPua(m.input, m.index, m[0].length)}`],
  // Component markup a provider's UI renders (ChatGPT generative UI:
  // <Link url=…/>, <Cite ref=…/>, <box gap={2}>): a capitalized tag with
  // attributes or self-closing, or any tag with a {…} attribute. Plain HTML
  // in prose doesn't look like either.
  ['component-markup', 'error',
    /<\/?[A-Z][A-Za-z]+(?:\s+[\w-]+=(?:"[^"]*"|\{[^}]*\}+))+\s*\/?>|<[A-Z][A-Za-z]+\s*\/>|<[a-z][\w-]*\s[^<>\n]*=\{[^<>\n]*>/g,
    (m) => `UI component markup leaked into the text: ${m[0].slice(0, 80)}`],
  ['object-object', 'error', /\[object Object\]/g,
    () => '"[object Object]" in output — something stringified an object'],
  ['mojibake', 'warn', /(?:Ã[\u0080-¿]|Ð[\u0080-¿]|Ñ[\u0080-¿]|â€)/g,
    (m) => `possible double-encoded UTF-8: ${JSON.stringify(m[0])}`],
];

const audit = (exp) => {
  const findings = [];
  const add = (severity, code, message, extra) =>
    findings.push({ severity, code, message, ...(extra || {}) });

  if (exp.md === null) {
    add('error', 'no-markdown', 'export contains no top-level .md file');
    return findings;
  }

  const md = exp.md;
  const codeless = stripCode(md);
  const lines = codeless.split('\n');
  const turnOf = turnIndexByLine(lines);
  const turnCount = lines.filter((l) => TURN_RE.test(l)).length;
  if (turnCount === 0) add('error', 'no-turns', 'markdown has no "## Human" / "## Assistant" sections');

  // Leaked markers. One finding per marker kind: a single cause (say,
  // unstripped citation markup) tends to repeat hundreds of times.
  for (const [code, severity, re, msg] of TEXT_MARKERS) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i]))) hits.push({ m, line: i + 1 });
    }
    if (!hits.length) continue;
    const first = hits[0];
    const more = hits.length > 1
      ? ` (+${hits.length - 1} more; lines ${[...new Set(hits.map((h) => h.line))].slice(0, 8).join(', ')}${hits.length > 8 ? ', …' : ''})`
      : '';
    add(severity, code, `${msg(first.m)}${more}`, { line: first.line, count: hits.length });
  }

  // Empty turns: a role heading followed only by blank lines before `---`.
  for (let i = 0; i < lines.length; i++) {
    if (!TURN_RE.test(lines[i])) continue;
    let j = i + 1;
    let content = false;
    for (; j < lines.length && lines[j].trim() !== '---' && !TURN_RE.test(lines[j]); j++) {
      const t = lines[j].trim();
      if (t && !DATE_LINE_RE.test(t)) content = true;
    }
    // Lines blanked by stripCode were code — count the original instead.
    if (!content) {
      const orig = md.split('\n').slice(i + 1, j).join('').trim();
      if (!orig || DATE_LINE_RE.test(orig)) add('warn', 'empty-turn', `"${lines[i].trim()}" has no content`, { line: i + 1 });
    }
  }

  // Links.
  const links = findLinks(codeless);
  const anchors = new Set();
  for (const m of md.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(m[1]);

  const referenced = new Set();
  const imageHashes = []; // { hash, turn, line, name }

  for (const link of links) {
    const t = link.target;
    if (t.startsWith('data:')) {
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(t);
      if (!m) {
        add('error', 'bad-data-url', 'malformed data URL', { line: link.line });
        continue;
      }
      const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
      if (bytes.length === 0) add('error', 'empty-image', `inline image "${link.label}" has no bytes`, { line: link.line });
      const type = sniff(bytes);
      if (link.isImage && type && !IMAGE_TYPES.has(type)) {
        add('error', 'not-an-image', `inline image "${link.label}" is actually ${type}`, { line: link.line });
      }
      if (link.isImage) imageHashes.push({ hash: sha1(bytes), turn: turnOf[link.line - 1], line: link.line, name: link.label });
      continue;
    }
    if (t.startsWith('#')) {
      if (!anchors.has(t.slice(1))) {
        add('error', 'broken-anchor', `link "${link.label}" points to missing anchor ${t}`, { line: link.line });
      }
      continue;
    }
    if (t.startsWith('sandbox:')) {
      // The provider refused the file (marked "no longer available") --
      // reported as file-unavailable; nothing the exporter could do.
      const base = t.split('/').pop();
      const refused = md.includes(`📎 ~~${base}~~ _(no longer available)_`);
      add(exp.mode === 'zip' && !refused ? 'error' : 'warn', 'sandbox-link',
        `unresolved sandbox link "${link.label}" → ${t}${refused ? ' (file unavailable)' : ''}`, { line: link.line });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // external URL

    if (exp.mode === 'md') {
      add('error', 'relative-link-in-md', `single-file export links to a local path: ${t}`, { line: link.line });
      continue;
    }
    let rel = t.replace(/^\.\//, '');
    let buf = exp.files.get(rel);
    if (!buf) {
      try {
        rel = decodeURIComponent(rel);
        buf = exp.files.get(rel);
      } catch (_) { /* keep raw */ }
    }
    if (!buf) {
      add('error', 'broken-link', `link "${link.label}" → ${t} (file not in export)`, { line: link.line });
      continue;
    }
    referenced.add(rel);
    if (link.isImage) imageHashes.push({ hash: sha1(buf), turn: turnOf[link.line - 1], line: link.line, name: rel });
  }

  // Duplicate images. Same picture twice within one turn is almost always
  // an exporter bug (two sources for one upload); across turns it may be a
  // legitimate re-upload.
  const byHash = new Map();
  const reportedHashes = new Set();
  for (const img of imageHashes) {
    if (!byHash.has(img.hash)) byHash.set(img.hash, []);
    byHash.get(img.hash).push(img);
  }
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    reportedHashes.add(hash);
    const turns = new Set(group.map((g) => g.turn));
    const sameTurn = turns.size < group.length;
    const where = group.map((g) => `${g.name} (line ${g.line})`).join(', ');
    add(sameTurn ? 'error' : 'warn', sameTurn ? 'duplicate-image' : 'repeated-image',
      `${sameTurn ? 'same image rendered more than once in one message (exporter bug, unless the user attached it twice)' : 'same image appears in several messages'}: ${where}`,
      { line: group[1].line });
  }

  // Files on disk (zip mode).
  const contentHashes = new Map();
  for (const [rel, buf] of exp.files) {
    if (rel === 'metadata.json') continue;
    const dir = rel.split('/')[0];
    const base = rel.slice(dir.length + 1);
    if (!['assets', 'files', 'artifacts'].includes(dir)) {
      add('warn', 'unexpected-file', `unexpected file in export: ${rel}`);
      continue;
    }
    if (!referenced.has(rel)) {
      add('warn', 'unreferenced-file', `${rel} is not linked from the markdown`);
    }
    if (buf.length === 0) add(dir === 'artifacts' ? 'warn' : 'error', 'empty-file', `${rel} is empty`);
    const ext = extOf(base);
    if (!ext) add('warn', 'no-extension', `${rel} has no file extension`);
    if (dir === 'artifacts' || buf.length === 0) continue;

    const h = sha1(buf);
    if (!contentHashes.has(h)) contentHashes.set(h, []);
    contentHashes.get(h).push(rel);

    const type = sniff(buf);
    if (type === 'html' && ext !== 'html' && ext !== 'htm') {
      add('error', 'html-instead-of-file', `${rel} contains an HTML page (viewer/error page saved instead of the file?)`);
    } else if (dir === 'assets' && type && !IMAGE_TYPES.has(type)) {
      add('error', 'not-an-image', `${rel} is ${type}, not an image`);
    } else if (ext && type && IMAGE_TYPES.has(type) && IMAGE_TYPES.has(ext) && ext !== type) {
      add('warn', 'ext-mismatch', `${rel} has .${ext} extension but contains ${type}`);
    }
  }
  for (const [hash, group] of contentHashes) {
    if (group.length < 2 || reportedHashes.has(hash)) continue;
    add('warn', 'duplicate-file', `identical content stored more than once: ${group.join(', ')}`);
  }

  // metadata.json consistency (zip mode).
  if (exp.mode === 'zip') {
    const metaBuf = exp.files.get('metadata.json');
    if (!metaBuf) {
      add('warn', 'no-metadata', 'metadata.json missing');
    } else {
      let meta = null;
      try {
        meta = JSON.parse(metaBuf.toString('utf8'));
      } catch (e) {
        add('error', 'bad-metadata', `metadata.json is not valid JSON: ${e.message}`);
      }
      if (meta && meta.counts) {
        const count = (d) => [...exp.files.keys()].filter((k) => k.startsWith(`${d}/`)).length;
        for (const [key, dir] of [['assets', 'assets'], ['files', 'files'], ['artifacts', 'artifacts']]) {
          if (typeof meta.counts[key] === 'number' && meta.counts[key] !== count(dir)) {
            add('warn', 'metadata-count', `metadata.counts.${key}=${meta.counts[key]} but ${dir}/ has ${count(dir)} file(s)`);
          }
        }
        if (typeof meta.counts.turns === 'number' && turnCount > meta.counts.turns) {
          add('error', 'metadata-count', `markdown has ${turnCount} turns, metadata.counts.turns=${meta.counts.turns}`);
        }
      }
    }
  }

  return findings;
};

// -- CLI ----------------------------------------------------------------------

const SEV_ORDER = { error: 0, warn: 1, info: 2 };

const main = () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const inputs = args.filter((a) => !a.startsWith('--'));
  if (inputs.length === 0) {
    console.error('Usage: node tools/audit-export.js <export.zip|export.md|dir>... [--json] [--quiet]');
    process.exit(2);
  }

  const targets = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) {
      console.error(`Not found: ${p}`);
      process.exit(2);
    }
    discover(p, targets);
  }

  const reports = [];
  for (const t of targets) {
    let findings;
    let exp = null;
    try {
      exp = t.kind === 'zip' ? loadZip(t.path) : t.kind === 'dir' ? loadDir(t.path) : loadMd(t.path);
      findings = audit(exp);
    } catch (e) {
      findings = [{ severity: 'error', code: 'load-failed', message: e.message }];
    }
    findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.line || 0) - (b.line || 0));
    reports.push({ path: t.path, mode: exp ? exp.mode : null, markdown: exp ? exp.mdName : null, findings });
  }

  const totals = { exports: reports.length, error: 0, warn: 0 };
  for (const r of reports) for (const f of r.findings) totals[f.severity] = (totals[f.severity] || 0) + 1;

  if (json) {
    process.stdout.write(JSON.stringify({ totals, reports }, null, 2) + '\n');
  } else {
    for (const r of reports) {
      if (quiet && r.findings.length === 0) continue;
      console.log(`\n${r.path}${r.markdown ? `  [${r.mode}: ${r.markdown}]` : ''}`);
      if (r.findings.length === 0) console.log('  ok');
      for (const f of r.findings) {
        const loc = f.line ? `:${f.line}` : '';
        console.log(`  ${f.severity.toUpperCase().padEnd(5)} ${f.code}${loc}  ${f.message}`);
      }
    }
    console.log(`\n${totals.exports} export(s): ${totals.error} error(s), ${totals.warn} warning(s)`);
  }
  process.exit(totals.error > 0 ? 1 : 0);
};

if (require.main === module) main();

module.exports = { audit, loadZip, loadDir, loadMd, stripCode, findLinks };
