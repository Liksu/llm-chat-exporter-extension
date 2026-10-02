#!/usr/bin/env node
/**
 * Live tests: export real chats from claude.ai / chatgpt.com / Gemini and
 * check what came out. Browser work is done by Claude Desktop (Claude in
 * Chrome) following tests/live/TASK.md; this tool plans the run and
 * evaluates the result.
 *
 *   node tools/live.js prepare [--include-expensive] [--only <provider|id>,...]
 *                              [--recreate <id>,... | --recreate-all]
 *       Creates tests/live/runs/<date>/ with plan.json + plan.md: which
 *       known test chats to re-export, which features still need a chat
 *       created (prompt, uploads, export snippet).
 *
 *   node tools/live.js collect [<run-dir>] [--keep-downloads]
 *       Finds the run's exports + .debug.har files in the downloads folder
 *       (matched by the feature id the export was tagged with), moves them
 *       into <run>/downloads/, then per feature: audit, expectations from
 *       features.json, scenario recorded into tests/scenarios/local/live-<id>
 *       (with goldens), replay check. Plus API schema drift over all HARs.
 *       Writes <run>/report.md + report.json and remembers chat URLs in
 *       tests/live/fixtures.local.json for the next run.
 *
 *   node tools/live.js status
 *       Catalog coverage: which features have a test chat, last result.
 *
 * Local, gitignored files: tests/live/config.local.json ({downloadsDir,
 * projects: {provider: url}, useProjectFor: [provider]} -- see README),
 * tests/live/fixtures.local.json (your test chats' URLs), tests/live/runs/.
 */

'use strict';

// Run folders are named by the local date; everything else (goldens) is
// rendered in UTC like npm test does.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = process.env.TZ || 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
// Overridable so tests can run collect against temp dirs.
const LIVE_DIR = process.env.LIVE_DIR || path.join(REPO_ROOT, 'tests', 'live');
const CATALOG = path.join(REPO_ROOT, 'tests', 'live', 'features.json');
const CONFIG = path.join(LIVE_DIR, 'config.local.json');
const FIXTURES = path.join(LIVE_DIR, 'fixtures.local.json');
const RUNS_DIR = path.join(LIVE_DIR, 'runs');
const UPLOADS_DIR = path.join(REPO_ROOT, 'tests', 'live', 'fixtures');
const SCENARIOS_LOCAL = process.env.LIVE_SCENARIOS_DIR || path.join(REPO_ROOT, 'tests', 'scenarios', 'local');

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};

const loadConfig = () => {
  const cfg = readJson(CONFIG, null);
  if (cfg) return cfg;
  const created = { downloadsDir: path.join(os.homedir(), 'Downloads') };
  writeJson(CONFIG, created);
  console.log(`Created ${path.relative(REPO_ROOT, CONFIG)} -- downloadsDir: ${created.downloadsDir} (edit if Chrome saves elsewhere)`);
  return created;
};

const parseList = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

// -- prepare ------------------------------------------------------------------

const exportDetail = (catalog, feature) => ({
  ...catalog.defaults.export,
  ...(feature.export || {}),
  debugCapture: true,
  tag: feature.id,
});

/**
 * JS to run on the chat page (page world): start the export, then wait up
 * to 30 s for the result. Browser tools cut scripts off after ~45 s and a
 * big chat can take longer to export, so on 'PENDING' run POLL_SNIPPET
 * until it returns the result.
 */
const snippetFor = (detail) => `(async () => {
  const el = document.documentElement;
  delete el.dataset.llmExporterResult;
  window.dispatchEvent(new CustomEvent('llm-exporter:export', { detail: ${JSON.stringify(JSON.stringify(detail))} }));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (el.dataset.llmExporterResult) return el.dataset.llmExporterResult;
  }
  return 'PENDING: export still running -- run the poll snippet';
})()`;

const POLL_SNIPPET = `(async () => {
  const el = document.documentElement;
  for (let i = 0; i < 60; i++) {
    if (el.dataset.llmExporterResult) return el.dataset.llmExporterResult;
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'PENDING: still running -- poll again';
})()`;

/**
 * Where a new test chat starts: the provider's test project (keeps test
 * chats and their memory away from the user's own) or a plain new chat.
 * feature.context 'project' / 'outside-project' overrides the per-provider
 * default from config.useProjectFor. Returns { url, inProject }, or null
 * when the feature needs a project that isn't configured.
 */
const startFor = (cfg, catalog, feature) => {
  const project = cfg.projects && cfg.projects[feature.provider];
  const plain = { url: catalog.providers[feature.provider].newChatUrl, inProject: false };
  if (feature.context === 'outside-project') return plain;
  if (feature.context === 'project') return project ? { url: project, inProject: true } : null;
  return project && (cfg.useProjectFor || []).includes(feature.provider)
    ? { url: project, inProject: true }
    : plain;
};

const prepare = (args) => {
  const cfg = loadConfig();
  const catalog = readJson(CATALOG);
  const fixtures = readJson(FIXTURES, {});
  const only = parseList(args.only);
  const recreate = new Set(parseList(args.recreate));
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: SYSTEM_TZ }).format(new Date());
  let runDir = path.join(RUNS_DIR, date);
  for (let n = 2; fs.existsSync(runDir); n++) runDir = path.join(RUNS_DIR, `${date}-${n}`);

  const tasks = [];
  const skipped = [];
  for (const f of catalog.features) {
    if (only.length && !only.includes(f.provider) && !only.includes(f.id)) continue;
    const provider = catalog.providers[f.provider];
    const known = fixtures[f.id] && fixtures[f.id].url;
    const wantNew = args.recreateAll || recreate.has(f.id) || !known;
    if (f.automation === 'manual' && wantNew) {
      skipped.push({ id: f.id, reason: 'manual feature without a test chat -- create it by hand, export once with the page snippet' });
      continue;
    }
    if (f.cost === 'high' && wantNew && !args.includeExpensive) {
      skipped.push({ id: f.id, reason: 'expensive (cost: high) -- pass --include-expensive to create it' });
      continue;
    }
    const start = wantNew ? startFor(cfg, catalog, f) : null;
    if (wantNew && !start) {
      skipped.push({ id: f.id, reason: `needs a ${f.provider} test project -- add it to config.local.json "projects"` });
      continue;
    }
    const detail = exportDetail(catalog, f);
    tasks.push({
      featureId: f.id,
      provider: f.provider,
      title: f.title,
      action: wantNew ? 'create' : 'reexport',
      url: wantNew ? start.url : known,
      inProject: wantNew ? start.inProject : undefined,
      chatUrlPattern: f.chatUrlPattern || provider.chatUrlPattern,
      setup: wantNew ? f.setup || null : null,
      uploads: wantNew ? (f.uploads || []).map((u) => path.join(UPLOADS_DIR, u)) : [],
      prompt: wantNew ? f.prompt || null : null,
      followUps: wantNew ? f.followUps || [] : [],
      exportDetail: detail,
      exportSnippet: snippetFor(detail),
      // Settings matrix: one more export in md mode; together with the
      // main zip export its HAR covers every fetch any option combination
      // needs (tools/settings-matrix.js).
      extraExports: f.matrix
        ? [{ tag: `${f.id}#md`, snippet: snippetFor({ ...detail, mode: 'md', inlineImages: true, inlineTextFiles: true, tag: `${f.id}#md` }) }]
        : [],
    });
  }

  const plan = { createdAt: new Date().toISOString(), runDir, tasks, skipped };
  writeJson(path.join(runDir, 'plan.json'), plan);
  fs.writeFileSync(path.join(runDir, 'plan.md'), renderPlan(plan));
  const creates = tasks.filter((t) => t.action === 'create').length;
  console.log(`Run: ${path.relative(REPO_ROOT, runDir)}`);
  console.log(`  ${tasks.length} task(s): ${creates} new chat(s) to create, ${tasks.length - creates} to re-export; ${skipped.length} skipped`);
  console.log(`  Plan: ${path.relative(REPO_ROOT, path.join(runDir, 'plan.md'))}`);
  console.log(`  After the browser part: node tools/live.js collect`);
};

const renderPlan = (plan) => {
  const out = [];
  out.push(`# Live test run — ${plan.createdAt.slice(0, 10)}`, '');
  out.push(`Created ${plan.createdAt}. Follow tests/live/TASK.md; this file lists the tasks.`, '');
  out.push('Every task ends with the export snippet: run it **on the chat page** (javascript tool) and note the result.');
  out.push('If it returns `PENDING`, the export is still running: run this poll snippet until it returns the result (each call stays under the ~45 s script limit):', '');
  out.push('```js', POLL_SNIPPET, '```', '');
  plan.tasks.forEach((t, i) => {
    out.push(`## ${i + 1}. ${t.featureId} — ${t.action === 'create' ? 'CREATE a new chat' : 're-export'}`, '');
    out.push(`_${t.title}_`, '');
    if (t.action === 'reexport') {
      out.push(`1. Open ${t.url} and wait until the conversation has loaded.`);
      out.push('2. Run the export snippet below.', '');
    } else {
      let n = 1;
      out.push(t.inProject
        ? `${n++}. Open ${t.url} — the **test project**. Start the chat from the project's own composer (not the global "New chat"), so it lands in the project.`
        : `${n++}. Open ${t.url} (a new chat, **outside** any project).`);
      if (t.setup) out.push(`${n++}. Setup: ${t.setup}`);
      if (t.uploads.length) out.push(`${n++}. Attach: ${t.uploads.map((u) => `\`${u}\``).join(', ')}`);
      // A fence longer than any backtick run inside the prompt.
      const fence = '`'.repeat(Math.max(3, ...(t.prompt.match(/`+/g) || []).map((s) => s.length + 1)));
      out.push(`${n++}. Send this message${t.prompt.includes('\n') ? ' (line breaks: Shift+Enter)' : ''}:`, '',
        `   ${fence}text`, ...t.prompt.split('\n').map((l) => `   ${l}`), `   ${fence}`);
      for (const fu of t.followUps) out.push(`${n++}. Wait for the reply to finish, then: ${fu}`);
      out.push(`${n++}. Wait until the reply has fully finished (no stop button / spinner). The URL must have changed from the start URL to the new chat's, matching \`${t.chatUrlPattern}\`.`);
      out.push(`${n++}. Run the export snippet below.`, '');
    }
    out.push('```js', t.exportSnippet, '```', '');
    for (const x of t.extraExports || []) {
      out.push(`Then, on the same page, run this second export (\`${x.tag}\`, for the settings matrix):`, '');
      out.push('```js', x.snippet, '```', '');
    }
  });
  if (plan.skipped.length) {
    out.push('## Skipped', '');
    for (const s of plan.skipped) out.push(`- **${s.id}** — ${s.reason}`);
    out.push('');
  }
  return out.join('\n');
};

// -- collect ------------------------------------------------------------------

const latestRun = () => {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const dirs = fs.readdirSync(RUNS_DIR)
    .map((d) => path.join(RUNS_DIR, d))
    .filter((d) => fs.existsSync(path.join(d, 'plan.json')))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return dirs.pop() || null;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const moveFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (_) {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
};

/** Find this run's tagged HARs and their exports in the downloads folder. */
const findDownloads = (downloadsDir, since, featureIds) => {
  const files = fs.readdirSync(downloadsDir)
    .map((name) => ({ name, full: path.join(downloadsDir, name) }))
    .filter((f) => fs.statSync(f.full).isFile() && fs.statSync(f.full).mtimeMs >= since)
    .map((f) => ({ ...f, mtime: fs.statSync(f.full).mtimeMs }));
  const byFeature = new Map();
  for (const f of files) {
    if (!/\.debug( \(\d+\))?\.har$/i.test(f.name)) continue;
    let har;
    try {
      har = JSON.parse(fs.readFileSync(f.full, 'utf8'));
    } catch (_) {
      continue;
    }
    const meta = har.log && har.log._exporter;
    // "<id>" or an extra export of the same feature ("<id>#md", matrix).
    if (!meta || typeof meta.tag !== 'string' || !featureIds.has(meta.tag.split('#')[0])) continue;
    const prev = byFeature.get(meta.tag);
    if (prev && prev.har.mtime > f.mtime) continue;
    let exportFile = null;
    const fname = meta.result && meta.result.filename;
    if (fname) {
      const m = /^(.*)(\.[^.]+)$/.exec(fname);
      const re = new RegExp(`^${escapeRe(m ? m[1] : fname)}( \\(\\d+\\))?${escapeRe(m ? m[2] : '')}$`);
      const cands = files.filter((c) => re.test(c.name));
      cands.sort((a, b) => Math.abs(a.mtime - f.mtime) - Math.abs(b.mtime - f.mtime));
      exportFile = cands[0] || null;
    }
    byFeature.set(meta.tag, { har: f, meta, exportFile });
  }
  return byFeature;
};

const compareOp = (spec, actual) => {
  const m = /^(==|>=|<=|>|<)?\s*(\d+)$/.exec(String(spec));
  if (!m) return { ok: false, text: `bad spec ${spec}` };
  const [, op = '==', nStr] = m;
  const n = Number(nStr);
  const ok = op === '==' ? actual === n : op === '>=' ? actual >= n : op === '<=' ? actual <= n : op === '>' ? actual > n : actual < n;
  return { ok, text: `${op}${n}, got ${actual}` };
};

/** Evaluate a feature's `expect` against a loaded export. */
/**
 * What a reader sees: the .md without reasoning. Live exports include
 * reasoning, and its tool-call dumps repeat almost everything -- prompts,
 * file contents written by tools, search results -- so a text check run on
 * the raw .md passes even when the feature itself is missing.
 */
const visibleText = (md) => md
  .replace(/<details><summary>Thinking<\/summary>[\s\S]*?<\/details>\n?/g, '')
  .replace(/^\*\*(?:Tool call: `[^`\n]*`|Tool result|Tool error)\*\*\n\n(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');

/** Visible text of the assistant's turns only. */
const assistantText = (visible) => {
  const out = [];
  let inAssistant = false;
  for (const line of visible.split('\n')) {
    if (/^## Assistant/.test(line)) inAssistant = true;
    else if (/^## (Human|Artifacts|Attachments)/.test(line)) inAssistant = false;
    else if (inAssistant) out.push(line);
  }
  return out.join('\n');
};

/**
 * Evaluate a feature's `expect` against a loaded export.
 *   mdMatches / mdNotMatches  regex on the visible .md (both roles)
 *   assistantMatches          regex on the assistant's visible turns only
 *   outputMatches             regex on visible .md + artifacts/ + files/
 *   turns/images/files/artifacts counts, reasoning (a Thinking block)
 */
const checkExpectations = (feature, exp) => {
  const { stripCode, findLinks } = require('./audit-export');
  const raw = exp.md || '';
  const md = visibleText(raw);
  const links = findLinks(stripCode(md));
  const count = {
    turns: (md.match(/^## (Human|Assistant)( \(🎙️\))?\s*$/gm) || []).length,
    images: links.filter((l) => l.isImage && (/^data:image\//.test(l.target) || l.target.startsWith('assets/'))).length,
    files: exp.mode === 'zip'
      ? [...exp.files.keys()].filter((k) => k.startsWith('files/')).length
      : (md.match(/📎 \[/g) || []).length,
    artifacts: exp.mode === 'zip'
      ? [...exp.files.keys()].filter((k) => k.startsWith('artifacts/')).length
      : (md.match(/🧩 \[/g) || []).length,
  };
  const results = [];
  const e = feature.expect || {};
  for (const key of ['turns', 'images', 'files', 'artifacts']) {
    if (e[key] == null) continue;
    const r = compareOp(e[key], count[key]);
    results.push({ check: `${key} ${r.text}`, ok: r.ok });
  }
  if (e.reasoning) {
    results.push({ check: 'reasoning present', ok: /<details><summary>Thinking<\/summary>/.test(raw) });
  }
  for (const re of e.mdMatches || []) results.push({ check: `matches /${re}/`, ok: new RegExp(re, 'm').test(md) });
  const said = assistantText(md);
  for (const re of e.assistantMatches || []) results.push({ check: `assistant says /${re}/`, ok: new RegExp(re, 'm').test(said) });
  if (e.outputMatches) {
    // What the assistant produced: its visible turns plus artifacts/ and
    // files/ -- never the user's own messages.
    const all = [said, ...[...exp.files.entries()].filter(([k]) => /^(artifacts|files)\//.test(k)).map(([, b]) => b.toString('utf8'))].join('\n');
    for (const re of e.outputMatches) results.push({ check: `output matches /${re}/`, ok: new RegExp(re, 'm').test(all) });
  }
  for (const re of e.mdNotMatches || []) results.push({ check: `does not match /${re}/`, ok: !new RegExp(re, 'm').test(md) });
  return { counts: count, results };
};

/**
 * A chat of the same provider that has none of the special features: the
 * newest `<provider>.text-formatting` export in any run. Expectations that
 * also pass on it don't test the feature (see collect: weak checks).
 */
const findControlExport = (provider) => {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const { loadZip, loadMd } = require('./audit-export');
  const runs = fs.readdirSync(RUNS_DIR).map((d) => path.join(RUNS_DIR, d))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const run of runs) {
    const dir = path.join(run, 'downloads', `${provider}.text-formatting`);
    if (!fs.existsSync(dir)) continue;
    const file = fs.readdirSync(dir).find((n) => /\.(zip|md)$/i.test(n));
    if (file) return { path: path.join(dir, file), exp: /\.zip$/i.test(file) ? loadZip(path.join(dir, file)) : loadMd(path.join(dir, file)) };
  }
  return null;
};

/** HAR → tests/scenarios/local/live-<id>, goldens from the current code. */
const recordScenario = async (featureId, harPath, auditErrorCodes) => {
  const { executeExport, unzipBlob } = require('../tests/scaffolding/run-scenario');
  const dir = path.join(SCENARIOS_LOCAL, `live-${featureId}`);
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(__dirname, 'record-from-har.js'), harPath, dir, '--name', `live-${featureId}`], { stdio: 'pipe' });
  const scenarioPath = path.join(dir, 'scenario.json');
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  // Problems present at recording time are reported by collect; don't make
  // npm test fail on them too -- the golden diff still catches changes.
  if (auditErrorCodes.length) scenario.auditAllow = [...new Set(auditErrorCodes)];
  writeJson(scenarioPath, scenario);

  const exp = scenario.exports[0];
  // The extension logs every fetch; keep the report readable.
  const quiet = ['log', 'warn', 'debug', 'info'].map((k) => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  let r;
  try {
    r = await executeExport(dir, scenario, exp.message);
  } finally {
    for (const [k, fn] of quiet) console[k] = fn;
  }
  if (!r.response || !r.response.ok) {
    return { dir, error: `replay failed: ${r.response ? r.response.error : 'no response'}` };
  }
  const expected = path.join(dir, exp.expectedContent);
  let output;
  if (exp.message.mode === 'zip') {
    output = await unzipBlob(r.captured.blob, r.sandbox);
    for (const [name, bytes] of Object.entries(output)) {
      const target = path.join(expected, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bytes));
    }
  } else {
    output = await r.captured.blob.text();
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, output);
  }
  return { dir, output, mode: exp.message.mode };
};

/** Does replaying the HAR reproduce the downloaded export? */
const replayMatches = (recorded, exportPath) => {
  if (!recorded.output || !exportPath) return null;
  const { loadZip } = require('./audit-export');
  // metadata.exportedAt is "now" at export time -- never the same twice.
  const withoutExportedAt = (buf) => Buffer.from(String(buf).replace(/"exportedAt": "[^"]*"/, '"exportedAt": ""'));
  if (recorded.mode === 'zip') {
    const original = loadZip(exportPath);
    const replayed = recorded.output;
    const names = new Set([...original.files.keys(), ...(original.mdName ? [original.mdName] : [])]);
    const replayNames = Object.keys(replayed);
    if (names.size !== replayNames.length) return false;
    for (const n of replayNames) {
      let a = n === original.mdName ? Buffer.from(original.md, 'utf8') : original.files.get(n);
      let b = Buffer.from(replayed[n]);
      if (n === 'metadata.json' && a) {
        a = withoutExportedAt(a);
        b = withoutExportedAt(b);
      }
      if (!a || !a.equals(b)) return false;
    }
    return true;
  }
  return fs.readFileSync(exportPath, 'utf8') === recorded.output;
};

const collectRun = async (args) => {
  const runDir = args.positional[0] ? path.resolve(args.positional[0]) : latestRun();
  if (!runDir || !fs.existsSync(path.join(runDir, 'plan.json'))) {
    console.error('No run found. Start with: node tools/live.js prepare');
    process.exit(2);
  }
  const plan = readJson(path.join(runDir, 'plan.json'));
  const catalog = readJson(CATALOG);
  const featureById = new Map(catalog.features.map((f) => [f.id, f]));
  const fixtures = readJson(FIXTURES, {});
  const cfg = loadConfig();
  const { audit, loadZip, loadMd } = require('./audit-export');
  const drift = require('./schema-drift');

  const since = Date.parse(plan.createdAt) - 60_000;
  const taskIds = new Set(plan.tasks.map((t) => t.featureId));
  const found = fs.existsSync(cfg.downloadsDir) ? findDownloads(cfg.downloadsDir, since, taskIds) : new Map();

  // Already collected earlier (collect re-run)? Use the files in the run dir.
  const runDownloads = path.join(runDir, 'downloads');
  const results = [];
  const harPaths = [];
  const controls = new Map(); // provider → control export (see findControlExport)
  for (const task of plan.tasks) {
    const feature = featureById.get(task.featureId);
    const dest = path.join(runDownloads, task.featureId);
    const hits = [found.get(task.featureId), ...(task.extraExports || []).map((x) => found.get(x.tag))].filter(Boolean);
    if (hits.length) {
      fs.rmSync(dest, { recursive: true, force: true });
      const move = args.keepDownloads ? (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); } : moveFile;
      for (const hit of hits) {
        move(hit.har.full, path.join(dest, hit.har.name));
        if (hit.exportFile) move(hit.exportFile.full, path.join(dest, hit.exportFile.name));
      }
    }
    const local = fs.existsSync(dest) ? fs.readdirSync(dest) : [];
    // The main export is the one tagged with the bare feature id; extra
    // ones ("<id>#md") only feed the settings matrix.
    const hars = local.filter((n) => /\.har$/i.test(n)).map((n) => {
      const log = JSON.parse(fs.readFileSync(path.join(dest, n), 'utf8')).log;
      return { name: n, meta: log._exporter || {} };
    });
    const main = hars.find((h) => h.meta.tag === task.featureId) || hars[0];
    const r = { featureId: task.featureId, provider: task.provider, title: task.title, action: task.action, support: feature ? feature.support : 'unknown' };
    if (!main) {
      r.status = 'NOT_RUN';
      results.push(r);
      continue;
    }
    const harName = main.name;
    const harPath = path.join(dest, harName);
    harPaths.push(...hars.map((h) => path.join(dest, h.name)));
    const meta = main.meta;
    const mainFile = meta.result && meta.result.filename;
    const stem = mainFile ? mainFile.replace(/\.(zip|md)$/i, '') : null;
    const exportName = local.find((n) => stem && n.startsWith(stem) && n.endsWith(path.extname(mainFile))) ||
      local.find((n) => /\.(zip|md)$/i.test(n));
    r.url = meta.location;
    r.extensionResult = meta.result;
    if (!meta.result || !meta.result.ok || !exportName) {
      r.status = 'EXPORT_FAILED';
      r.error = (meta.result && meta.result.error) || 'export file not found in downloads';
      results.push(r);
      continue;
    }
    const exportPath = path.join(dest, exportName);
    r.export = path.relative(REPO_ROOT, exportPath);
    const exp = /\.zip$/i.test(exportName) ? loadZip(exportPath) : loadMd(exportPath);
    r.audit = audit(exp).map((f) => ({ severity: f.severity, code: f.code, message: f.message }));
    r.expect = checkExpectations(feature || {}, exp);
    // Control: a check that also passes on a chat without the feature
    // tests nothing specific. (Checks satisfied by the prompt itself are
    // caught statically: see the catalog test in tests/test.js.)
    if (feature && feature.expect && !task.featureId.endsWith('.text-formatting')) {
      const control = controls.has(task.provider) ? controls.get(task.provider) : findControlExport(task.provider);
      controls.set(task.provider, control);
      if (control) {
        const c = checkExpectations(feature, control.exp).results;
        const passing = c.filter((x) => x.ok && !/^turns /.test(x.check)).map((x) => x.check);
        r.control = { export: path.relative(REPO_ROOT, control.path), alsoPasses: passing, weak: c.length > 0 && c.every((x) => x.ok) };
      }
    }
    const auditErrors = r.audit.filter((f) => f.severity === 'error');
    let matrixOk = true;
    if (feature && feature.matrix) {
      const { runMatrix, summarize } = require('./settings-matrix');
      try {
        const m = await runMatrix({ hars: hars.map((h) => path.join(dest, h.name)) });
        r.matrix = summarize(m);
        matrixOk = r.matrix.failed === 0;
      } catch (e) {
        r.matrix = { error: e.message };
        matrixOk = false;
      }
    }
    const pass = auditErrors.length === 0 && r.expect.results.every((x) => x.ok) && matrixOk;
    const supported = r.support === 'supported';
    r.status = pass ? (supported ? 'OK' : 'NEWLY_WORKING') : (supported ? 'BROKEN' : 'GAP');
    try {
      const rec = await recordScenario(task.featureId, harPath, auditErrors.map((f) => f.code));
      r.scenario = path.relative(REPO_ROOT, rec.dir);
      if (rec.error) r.replay = rec.error;
      else r.replayIdentical = replayMatches(rec, exportPath);
    } catch (e) {
      r.replay = `recording failed: ${e.message}`;
    }
    // Remember the chat for re-export -- a real chat URL only, not the
    // project / new-chat page it was started from.
    if (meta.location && new RegExp(task.chatUrlPattern).test(meta.location) &&
        (task.action !== 'create' || meta.location !== task.url)) {
      fixtures[task.featureId] = { url: meta.location, lastRun: plan.createdAt.slice(0, 10), lastStatus: r.status };
    }
    results.push(r);
  }
  writeJson(FIXTURES, fixtures);

  // API schema drift across every response this run saw.
  let driftReport = [];
  let baselineExists = fs.existsSync(drift.DEFAULT_BASELINE);
  if (harPaths.length) {
    const responses = harPaths.flatMap((p) => drift.responsesFromHar(p));
    driftReport = drift.diff(drift.loadBaseline(drift.DEFAULT_BASELINE), drift.collect(responses));
  }

  const report = {
    run: path.relative(REPO_ROOT, runDir),
    collectedAt: new Date().toISOString(),
    extensionVersion: harPaths.length ? JSON.parse(fs.readFileSync(harPaths[0], 'utf8')).log.creator.version : null,
    results,
    skipped: plan.skipped,
    drift: driftReport,
    baselineExists,
  };
  writeJson(path.join(runDir, 'report.json'), report);
  const md = renderReport(report);
  fs.writeFileSync(path.join(runDir, 'report.md'), md);
  console.log(md);
  console.log(`\nReport: ${path.relative(REPO_ROOT, path.join(runDir, 'report.md'))}`);
  process.exit(results.some((r) => r.status === 'BROKEN' || r.status === 'EXPORT_FAILED') ? 1 : 0);
};

const STATUS_ORDER = ['BROKEN', 'EXPORT_FAILED', 'GAP', 'NEWLY_WORKING', 'NOT_RUN', 'OK'];
const STATUS_TITLE = {
  BROKEN: 'Broken — supported features that fail',
  EXPORT_FAILED: 'Export failed',
  GAP: 'Gaps — not supported yet',
  NEWLY_WORKING: 'Newly working — marked unsupported/unknown in features.json, but pass',
  NOT_RUN: 'Not run — no export found for these tasks',
  OK: 'OK',
};

const renderReport = (rep) => {
  const out = [];
  const count = (s) => rep.results.filter((r) => r.status === s).length;
  out.push(`# Live test report — ${rep.run.split(/[\\/]/).pop()}`, '');
  out.push(`Extension ${rep.extensionVersion || '?'} · collected ${rep.collectedAt}`, '');
  out.push(STATUS_ORDER.map((s) => `${s}: ${count(s)}`).join(' · '), '');
  for (const s of STATUS_ORDER) {
    const rows = rep.results.filter((r) => r.status === s);
    if (!rows.length) continue;
    out.push(`## ${STATUS_TITLE[s]}`, '');
    for (const r of rows) {
      out.push(`- **${r.featureId}** — ${r.title}${r.url ? ` · ${r.url}` : ''}`);
      if (r.control && r.control.weak) {
        out.push(`  - ⚠ weak check: every expectation also passes on a chat without this feature (\`${r.control.export}\`) — tighten \`expect\` in features.json`);
      } else if (r.control && r.control.alsoPasses.length) {
        out.push(`  - ⚠ also true without the feature: ${r.control.alsoPasses.join('; ')}`);
      }
      if (r.matrix) {
        if (r.matrix.error) out.push(`  - settings matrix failed to run: ${r.matrix.error}`);
        else {
          out.push(`  - settings matrix: ${r.matrix.total - r.matrix.failed}/${r.matrix.total} combinations OK (chat covers ${JSON.stringify(r.matrix.covers)})`);
          for (const f of r.matrix.findings) out.push(`    - ✗ ${f.problem} — ${f.count} combination(s), e.g. ${f.examples.slice(0, 2).join(' | ')}`);
        }
      }
      if (s === 'OK' || s === 'NOT_RUN') continue;
      if (r.error) out.push(`  - ${r.error}`);
      for (const x of (r.expect && r.expect.results) || []) if (!x.ok) out.push(`  - ✗ expected ${x.check}`);
      for (const f of r.audit || []) if (f.severity === 'error') out.push(`  - audit ${f.code}: ${f.message}`);
      const warns = (r.audit || []).filter((f) => f.severity === 'warn');
      if (warns.length) out.push(`  - ${warns.length} audit warning(s): ${[...new Set(warns.map((w) => w.code))].join(', ')}`);
      if (r.scenario) out.push(`  - scenario: \`${r.scenario}\`${r.replayIdentical === false ? ' (replay differs from the downloaded export)' : ''}`);
      if (r.replay) out.push(`  - ${r.replay}`);
      if (r.export) out.push(`  - export: \`${r.export}\``);
    }
    out.push('');
  }
  out.push('## API schema drift', '');
  if (!rep.baselineExists) {
    out.push('No baseline yet — everything is "new". Review, then accept with:', '', '```bash', `npm run drift -- "${rep.run}/downloads" --update`, '```', '');
  }
  if (!rep.drift.length) out.push('No drift.', '');
  for (const d of rep.drift) {
    out.push(`- ${d.newEndpoint ? 'NEW ENDPOINT' : 'CHANGED'} \`${d.endpoint}\``);
    if (d.newEndpoint) {
      out.push(`  - ${d.newPaths.length} field(s), ${d.newValues.length} tracked value field(s)`);
      continue;
    }
    for (const v of d.newValues) out.push(`  - new value \`${v.path}\` = ${v.values.join(', ')}`);
    for (const p of d.newPaths.slice(0, 30)) out.push(`  - new field \`${p.path}\` : ${p.types.join('|')}`);
    if (d.newPaths.length > 30) out.push(`  - … +${d.newPaths.length - 30} more fields`);
    for (const t of d.newTypes) out.push(`  - type change \`${t.path}\`: now also ${t.types.join('|')}`);
  }
  if (rep.skipped && rep.skipped.length) {
    out.push('', '## Skipped', '');
    for (const s of rep.skipped) out.push(`- **${s.id}** — ${s.reason}`);
  }
  return out.join('\n') + '\n';
};

// -- status -------------------------------------------------------------------

const status = () => {
  const catalog = readJson(CATALOG);
  const fixtures = readJson(FIXTURES, {});
  for (const f of catalog.features) {
    const fx = fixtures[f.id];
    const flags = [f.support, f.cost === 'high' ? 'expensive' : null, f.automation === 'manual' ? 'manual' : null].filter(Boolean).join(', ');
    console.log(`${f.id.padEnd(28)} ${(fx ? `${fx.lastStatus || '?'} @ ${fx.lastRun}` : 'no test chat').padEnd(26)} ${flags}`);
  }
};

// -- CLI ----------------------------------------------------------------------

const parseArgs = (argv) => {
  const a = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--include-expensive') a.includeExpensive = true;
    else if (x === '--recreate-all') a.recreateAll = true;
    else if (x === '--recreate') a.recreate = argv[++i];
    else if (x === '--only') a.only = argv[++i];
    else if (x === '--keep-downloads') a.keepDownloads = true;
    else if (x.startsWith('--')) throw new Error(`Unknown option: ${x}`);
    else a.positional.push(x);
  }
  return a;
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'prepare') return prepare(args);
  if (cmd === 'collect') return collectRun(args);
  if (cmd === 'status') return status();
  console.error('Usage: node tools/live.js prepare|collect|status  (see the header of tools/live.js)');
  process.exit(2);
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { checkExpectations, findDownloads, snippetFor, renderPlan, renderReport, compareOp, visibleText };
