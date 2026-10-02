#!/usr/bin/env node
/**
 * Settings matrix: export one conversation with every combination of export
 * options and check that each output obeys its options.
 *
 *   node tools/settings-matrix.js <file.har>... [--json] [--keep <dir>]
 *   node tools/settings-matrix.js --scenario <scenario-dir> [--json]
 *
 * No browser needed: the conversation is replayed from recorded API
 * responses (debug-capture HARs, see src/dev/debug-capture.js, or a test
 * scenario). Pass every HAR you have for the chat -- a zip export and an md
 * export together cover all the fetches the option combinations need
 * (originals vs previews, binaries, text files). Their mocks are merged.
 *
 * Options combined (160 exports):
 *   mode md|zip × includeReasoning × includeDates off|locale|iso|iso-offset|iso-utc
 *   × inlineImages × inlineTextFiles × attachmentsAsMarkdown
 *
 * A baseline export (zip, everything on) tells which checks apply: a chat
 * without images can't test inlineImages, etc. Then for each combination:
 *   - the export succeeds, has the right extension, and audits clean
 *     (tools/audit-export.js errors)
 *   - images: md+inline → data URLs; md+!inline → placeholders; zip+inline →
 *     data URLs and no assets/; zip+!inline → assets/ files, no data URLs
 *   - reasoning blocks present exactly when includeReasoning
 *   - a date line in the right format under every turn exactly when dates on
 *   - "File:" text-file blocks exactly when inlineTextFiles
 *   - .md text attachments unfenced exactly when attachmentsAsMarkdown
 *   - zip: same artifacts/ set as the baseline
 *
 * Exit code 1 if any combination fails.
 */

'use strict';

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const { executeExport, unzipBlob } = require('../tests/scaffolding/run-scenario');
const { audit, stripCode, findLinks } = require('./audit-export');

// -- scenario from HARs -------------------------------------------------------

/** Record each HAR and merge them into one scenario directory. */
const scenarioFromHars = (hars, dir) => {
  let base = null;
  const mocks = [];
  const seen = new Set();
  fs.mkdirSync(path.join(dir, 'responses'), { recursive: true });
  hars.forEach((har, i) => {
    const one = path.join(dir, `_rec${i}`);
    execFileSync(process.execPath, [path.join(__dirname, 'record-from-har.js'), har, one], { stdio: 'pipe' });
    const sc = JSON.parse(fs.readFileSync(path.join(one, 'scenario.json'), 'utf8'));
    if (!base) base = sc;
    for (const m of sc.mocks) {
      const key = JSON.stringify([m.method, m.host || sc.host, m.path, m.pathRegex, m.queryMatch]);
      if (seen.has(key)) continue;
      seen.add(key);
      const file = `r${i}-${m.file}`;
      fs.copyFileSync(path.join(one, 'responses', m.file), path.join(dir, 'responses', file));
      mocks.push({ ...m, host: m.host || sc.host, file });
    }
    fs.rmSync(one, { recursive: true, force: true });
  });
  const scenario = { ...base, mocks, exports: [] };
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
  return scenario;
};

// -- running one export -------------------------------------------------------

const quietly = async (fn) => {
  const saved = ['log', 'warn', 'debug', 'info', 'error'].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = () => {};
  try {
    return await fn();
  } finally {
    for (const [k, f] of saved) console[k] = f;
  }
};

/** Export → { ok, error, filename, mode, md, files: Map(relPath → Buffer) } */
const runOne = async (dir, scenario, options) => {
  const message = { kind: 'export', ...options };
  const r = await quietly(() => executeExport(dir, scenario, message));
  if (!r.response || !r.response.ok) return { ok: false, error: r.response ? r.response.error : 'no response' };
  const out = { ok: true, filename: r.captured.filename, mode: options.mode, files: new Map(), md: '' };
  if (options.mode === 'zip') {
    const entries = await unzipBlob(r.captured.blob, r.sandbox);
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.includes('/') && name.endsWith('.md')) {
        out.md = Buffer.from(bytes).toString('utf8');
        out.mdName = name;
      } else out.files.set(name, Buffer.from(bytes));
    }
  } else {
    out.md = await r.captured.blob.text();
    out.mdName = out.filename;
  }
  return out;
};

// -- facts and checks ---------------------------------------------------------

const TURN_RE = /^## (Human|Assistant)( \(🎙️\))?\s*$/gm;
const DATE_RE = {
  'iso-utc': /^_\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC_$/,
  iso: /^_\d{4}-\d{2}-\d{2} \d{2}:\d{2}_$/,
  'iso-offset': /^_\d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d{1,2}(:\d{2})?_$/,
  locale: /^_[^_]*\d[^_]*_$/,
};

const facts = (exp) => {
  const links = findLinks(stripCode(exp.md));
  return {
    turns: (exp.md.match(TURN_RE) || []).length,
    dataImages: links.filter((l) => l.isImage && l.target.startsWith('data:image/')).length,
    assetImages: links.filter((l) => l.isImage && l.target.startsWith('assets/')).length,
    placeholders: (exp.md.match(/_\[image: [^\]]*\]_/g) || []).length,
    assetsFiles: [...exp.files.keys()].filter((k) => k.startsWith('assets/')).length,
    artifacts: [...exp.files.keys()].filter((k) => k.startsWith('artifacts/')).sort(),
    reasoning: (exp.md.match(/<summary>Thinking<\/summary>|^\*\*Tool (call|result)/gm) || []).length,
    textFiles: (exp.md.match(/^\*\*File: `[^`]+`\*\*$/gm) || []).length,
    mdAttachments: mdAttachmentFences(exp.md),
  };
};

/** For each "**File/Pasted: `x.md`**" header: is the body fenced? */
const mdAttachmentFences = (md) => {
  const out = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\*\*(File|Pasted): `[^`]+\.(md|markdown)`\*\*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    out.push(/^(`{3,}|~{3,})/.test(lines[j] || ''));
  }
  return out;
};

/** Date line right under each role heading (after an optional blank). */
const dateLines = (md) => {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^## (Human|Assistant)/.test(lines[i])) continue;
    // `_[image: …]_` placeholders are italic too -- not a date.
    out.push(lines[i + 1] === '' && /^_[^[].*_$/.test(lines[i + 2] || '') ? lines[i + 2] : null);
  }
  return out;
};

const check = (o, exp, base) => {
  const fails = [];
  const f = facts(exp);
  const fail = (msg) => fails.push(msg);

  if (!exp.filename.endsWith(o.mode === 'zip' ? '.zip' : '.md')) fail(`filename ${exp.filename}`);
  const errors = audit({ mode: o.mode, md: exp.md, mdName: exp.mdName, files: exp.files })
    .filter((x) => x.severity === 'error' && !(base.auditErrors || []).includes(x.code));
  for (const e of errors) fail(`audit ${e.code}: ${e.message.slice(0, 120)}`);

  // Images.
  if (base.images > 0) {
    if (o.mode === 'md') {
      if (o.inlineImages && f.dataImages !== base.images) fail(`md+inline: ${f.dataImages}/${base.images} images inline`);
      // Images that failed to download become placeholders too, hence >=.
      if (!o.inlineImages && (f.dataImages || f.placeholders < base.images)) fail(`md+!inline: ${f.dataImages} inline, ${f.placeholders}/${base.images} placeholders`);
    } else if (o.inlineImages) {
      if (f.dataImages !== base.images || f.assetsFiles) fail(`zip+inline: ${f.dataImages}/${base.images} inline, ${f.assetsFiles} in assets/`);
    } else if (f.assetImages !== base.images || f.dataImages || f.assetsFiles !== base.assetsFiles) {
      fail(`zip: ${f.assetImages}/${base.images} images in assets/, ${f.dataImages} inline`);
    }
  }

  // Reasoning.
  if (base.reasoning > 0) {
    if (o.includeReasoning && f.reasoning !== base.reasoning) fail(`reasoning: ${f.reasoning}/${base.reasoning} blocks`);
  }
  if (!o.includeReasoning && f.reasoning) fail(`reasoning off but ${f.reasoning} blocks present`);

  // Dates.
  const dl = dateLines(exp.md);
  if (o.includeDates) {
    const re = DATE_RE[o.dateFormat];
    const bad = dl.filter((d) => !d || !re.test(d));
    if (bad.length) fail(`dates ${o.dateFormat}: ${bad.length}/${dl.length} turns without a matching date (e.g. ${JSON.stringify(bad[0])})`);
  } else if (dl.some(Boolean)) {
    fail('dates off but date lines present');
  }

  // Text files.
  if (base.textFiles > 0) {
    if (o.inlineTextFiles && f.textFiles !== base.textFiles) fail(`inlineTextFiles: ${f.textFiles}/${base.textFiles} inlined`);
  }
  if (!o.inlineTextFiles && f.textFiles) fail(`inlineTextFiles off but ${f.textFiles} inlined`);

  // Markdown attachments.
  if (f.mdAttachments.length) {
    const fenced = f.mdAttachments.filter(Boolean).length;
    if (o.attachmentsAsMarkdown && fenced) fail(`attachmentsAsMarkdown: ${fenced} .md attachment(s) still fenced`);
    if (!o.attachmentsAsMarkdown && fenced !== f.mdAttachments.length) fail('md attachment(s) unfenced with attachmentsAsMarkdown off');
  }

  // Artifacts.
  if (o.mode === 'zip' && JSON.stringify(f.artifacts) !== JSON.stringify(base.artifacts)) {
    fail(`artifacts differ from baseline: ${f.artifacts.length} vs ${base.artifacts.length}`);
  }
  return fails;
};

const combos = () => {
  const out = [];
  for (const mode of ['md', 'zip'])
    for (const includeReasoning of [false, true])
      for (const dates of ['off', 'locale', 'iso', 'iso-offset', 'iso-utc'])
        for (const inlineImages of [false, true])
          for (const inlineTextFiles of [false, true])
            for (const attachmentsAsMarkdown of [false, true])
              out.push({
                mode, includeReasoning,
                includeDates: dates !== 'off', dateFormat: dates === 'off' ? 'iso-utc' : dates,
                inlineImages, inlineTextFiles, attachmentsAsMarkdown,
              });
  return out;
};

const label = (o) => [
  o.mode,
  o.includeReasoning ? 'reasoning' : null,
  o.includeDates ? `dates:${o.dateFormat}` : null,
  o.inlineImages ? 'inlineImages' : null,
  o.inlineTextFiles ? 'inlineTextFiles' : null,
  o.attachmentsAsMarkdown ? 'attachmentsAsMd' : null,
].filter(Boolean).join(' ');

/** Run the whole matrix. Returns { base, results: [{options, label, fails}] }. */
const runMatrix = async ({ hars, scenarioDir }) => {
  let dir = scenarioDir;
  let tmp = null;
  let scenario;
  if (hars && hars.length) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'));
    dir = tmp;
    scenario = scenarioFromHars(hars, dir);
  } else {
    scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  }
  try {
    const maxOpts = { mode: 'zip', includeReasoning: true, includeDates: true, dateFormat: 'iso-utc', inlineImages: false, inlineTextFiles: true, attachmentsAsMarkdown: false };
    const b = await runOne(dir, scenario, maxOpts);
    if (!b.ok) throw new Error(`baseline export failed: ${b.error}`);
    const bf = facts(b);
    const base = {
      images: bf.assetImages,
      assetsFiles: bf.assetsFiles,
      reasoning: bf.reasoning,
      textFiles: bf.textFiles,
      artifacts: bf.artifacts,
      // Problems the conversation itself has (e.g. an expired file) are
      // reported by the audit elsewhere; here only option-specific ones count.
      auditErrors: [...new Set(audit({ mode: 'zip', md: b.md, mdName: b.mdName, files: b.files })
        .filter((x) => x.severity === 'error').map((x) => x.code))],
    };
    const results = [];
    for (const o of combos()) {
      const exp = await runOne(dir, scenario, o);
      const fails = exp.ok ? check(o, exp, base) : [`export failed: ${exp.error}`];
      results.push({ options: o, label: label(o), fails });
    }
    return { base, results };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
};

/** Group failures by message so 160 rows read as a few findings. */
const summarize = ({ base, results }) => {
  const failed = results.filter((r) => r.fails.length);
  const byMsg = new Map();
  for (const r of failed) {
    for (const msg of r.fails) {
      const key = msg.replace(/\d+\/\d+|\d+/g, '#');
      if (!byMsg.has(key)) byMsg.set(key, { example: msg, combos: [] });
      byMsg.get(key).combos.push(r.label);
    }
  }
  return {
    total: results.length,
    failed: failed.length,
    covers: {
      images: base.images, reasoningBlocks: base.reasoning, inlinedTextFiles: base.textFiles,
      artifacts: base.artifacts.length,
    },
    findings: [...byMsg.values()].map((v) => ({ problem: v.example, count: v.combos.length, examples: v.combos.slice(0, 4) })),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const si = args.indexOf('--scenario');
  const scenarioDir = si >= 0 ? args[si + 1] : null;
  const hars = args.filter((a, i) => !a.startsWith('--') && !(si >= 0 && i === si + 1));
  if (!scenarioDir && !hars.length) {
    console.error('Usage: node tools/settings-matrix.js <file.har>... | --scenario <dir>  [--json]');
    process.exit(2);
  }
  const res = await runMatrix({ hars, scenarioDir });
  const sum = summarize(res);
  if (json) {
    process.stdout.write(JSON.stringify(sum, null, 2) + '\n');
  } else {
    console.log(`${sum.total} combinations, ${sum.failed} failed.  Chat covers: ${JSON.stringify(sum.covers)}`);
    for (const f of sum.findings) {
      console.log(`\n✗ ${f.problem}\n  in ${f.count} combination(s), e.g.: ${f.examples.join(' | ')}`);
    }
  }
  process.exit(sum.failed ? 1 : 0);
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runMatrix, summarize, combos };
