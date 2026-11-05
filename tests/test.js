/**
 * Single discovery+runner file for the scenario test corpus.
 *
 * Behavior:
 *   - Walk tests/scenarios/** recursively for any directory containing a
 *     scenario.json file.
 *   - For each scenario, emit a node:test test() per export-variant.
 *   - With UPDATE_GOLDEN=1, expected files are (re)written instead of compared.
 *
 * To run:    npm test
 * To refresh goldens (carefully):   UPDATE_GOLDEN=1 npm run test:update
 *
 * TZ: forced to UTC at the very top of this file so todayStamp() and
 * date-format='iso-utc' renderings are deterministic regardless of the
 * developer's machine. Node reads TZ lazily on first Date construction,
 * so setting it before anything else loads is enough.
 */

'use strict';

process.env.TZ = process.env.TZ || 'UTC';

const path = require('node:path');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { findScenarios, runExport, executeExport, unzipBlob } = require('./scaffolding/run-scenario');
const { audit, loadDir, loadMd } = require('../tools/audit-export');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const { GENUI_SCRIPTS } = require('./scaffolding/loader');

const scenarios = findScenarios(SCENARIOS_DIR);

/**
 * Goldens are whatever the exporter produced when they were recorded, so a
 * bug present at recording time (eg. a duplicated image) gets locked in as
 * "expected". Run the golden-free auditor over them to catch that.
 * `scenario.auditAllow` lists finding codes the scenario produces on purpose.
 */
const assertAuditClean = (expectedPath, allow = []) => {
  if (!fs.existsSync(expectedPath)) return;
  const exp = fs.statSync(expectedPath).isDirectory() ? loadDir(expectedPath) : loadMd(expectedPath);
  const errors = audit(exp).filter((f) => f.severity === 'error' && !allow.includes(f.code));
  if (errors.length) {
    throw new Error(
      `audit-export found problems in ${expectedPath}:\n` +
        errors.map((f) => `  ${f.code}${f.line ? `:${f.line}` : ''}  ${f.message}`).join('\n')
    );
  }
};

if (scenarios.length === 0) {
  // Still emit one test so `npm test` doesn't silently report "0 passing".
  test('no scenarios found — add one under tests/scenarios/', () => {
    throw new Error(
      `No scenario.json discovered under ${SCENARIOS_DIR}. ` +
        `Drop a scenario directory under tests/scenarios/examples/ or tests/scenarios/local/.`
    );
  });
} else {
  for (const { dir, configPath } of scenarios) {
    const scenario = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const scenarioLabel = scenario.name || path.relative(SCENARIOS_DIR, dir);
    const exports_ = Array.isArray(scenario.exports) ? scenario.exports : [];

    test(scenarioLabel, async (t) => {
      if (exports_.length === 0) {
        throw new Error(`Scenario "${scenarioLabel}" has no exports[] defined`);
      }
      for (const exp of exports_) {
        const expLabel = exp.name || JSON.stringify(exp.message);
        await t.test(expLabel, async () => {
          await runExport(dir, scenario, exp);
          assertAuditClean(path.join(dir, exp.expectedContent), scenario.auditAllow);
        });
      }
    });
  }
}

/**
 * "Save debug data" must produce a HAR that tools/record-from-har.js turns
 * into a scenario reproducing the very same export -- that is the whole
 * point of capturing it.
 */
test('debug capture: HAR replays into an identical export', async () => {
  const srcDir = path.join(SCENARIOS_DIR, 'examples', 'claude-uploaded-images');
  const scenario = JSON.parse(fs.readFileSync(path.join(srcDir, 'scenario.json'), 'utf8'));
  const zipExport = scenario.exports.find((e) => e.message.mode === 'zip');
  const message = { ...zipExport.message, debugCapture: true };

  const original = await executeExport(srcDir, scenario, message, { dev: true });
  assert.ok(original.response && original.response.ok, 'export failed');
  const downloads = original.captured.downloads;
  assert.equal(downloads.length, 2, 'expected the export plus a .debug.har');
  assert.equal(downloads[1].filename, original.captured.filename.replace(/.zip$/, '') + '.debug.har');

  const har = JSON.parse(await downloads[1].blob.text());
  assert.equal(har.log._exporter.adapter, 'claude');
  assert.ok(har.log.entries.length > 0);
  for (const e of har.log.entries) {
    assert.deepEqual(e.request.headers, [], 'request headers must not be recorded');
  }
  assert.ok(har.log.entries.some((e) => e.response.status === 404), 'failed requests are recorded too');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-debug-'));
  try {
    const harPath = path.join(tmp, 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(har));
    const outDir = path.join(tmp, 'scenario');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'record-from-har.js'), harPath, outDir], { stdio: 'pipe' });

    const recorded = JSON.parse(fs.readFileSync(path.join(outDir, 'scenario.json'), 'utf8'));
    assert.equal(recorded.location, scenario.location);
    assert.equal(recorded.exports.length, 1);
    const replay = await executeExport(outDir, recorded, recorded.exports[0].message);
    assert.ok(replay.response && replay.response.ok, 'replayed export failed');
    assert.equal(replay.captured.filename, original.captured.filename);

    const a = await unzipBlob(original.captured.blob, original.sandbox);
    const b = await unzipBlob(replay.captured.blob, replay.sandbox);
    assert.ok(Object.keys(a).some((n) => n.startsWith('assets/')), 'export has no images to compare');
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
    for (const name of Object.keys(a)) {
      assert.ok(Buffer.from(a[name]).equals(Buffer.from(b[name])), `${name} differs after replay`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('chatgpt entity panels: debug HAR keeps them and replays into the same export', async () => {
  const srcDir = path.join(SCENARIOS_DIR, 'examples', 'chatgpt-entity-panel');
  const scenario = JSON.parse(fs.readFileSync(path.join(srcDir, 'scenario.json'), 'utf8'));
  const mdExport = scenario.exports.find((e) => e.message.mode === 'md');
  const message = { ...mdExport.message, debugCapture: true };

  const original = await executeExport(srcDir, scenario, message, { dev: true });
  assert.ok(original.response && original.response.ok, 'export failed');
  const md = await original.captured.downloads[0].blob.text();
  assert.match(md, /ℹ️ Bowser v\. Noem/);
  const har = JSON.parse(await original.captured.downloads[1].blob.text());
  const pages = har.log.entries.filter((e) => e._pageCapture === 'chatgpt-sidebar');
  // This chat's four panel streams (the other chat's one stays out).
  assert.equal(pages.length, 4);
  assert.ok(pages.every((e) => /"message_id"/.test(e.request.postData.text)));
  assert.ok(pages.every((e) => /\/backend-api\/sidebar\/conversation$/.test(e.request.url)), 'the URL the page called');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-panels-'));
  try {
    const harPath = path.join(tmp, 'capture.har');
    fs.writeFileSync(harPath, JSON.stringify(har));
    const outDir = path.join(tmp, 'scenario');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'record-from-har.js'), harPath, outDir], { stdio: 'pipe' });
    const recorded = JSON.parse(fs.readFileSync(path.join(outDir, 'scenario.json'), 'utf8'));
    assert.equal(recorded.pageCaptures.length, 4);
    assert.ok(recorded.mocks.every((m) => !/sidebar/.test(m.path || '')), 'panels must not become mocks');
    const replay = await executeExport(outDir, recorded, recorded.exports[0].message);
    assert.ok(replay.response && replay.response.ok, 'replayed export failed');
    assert.equal(await replay.captured.blob.text(), md);

    // The settings matrix merges HARs of one tab: every HAR carries the
    // same panels, the merged scenario keeps one copy and replays them.
    const { runMatrix, summarize } = require('../tools/settings-matrix');
    const sum = summarize(await runMatrix({ hars: [harPath, harPath] }));
    assert.equal(sum.total, 160);
    assert.deepEqual(sum.findings, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Which copy of a panel is exported and where, and how its markdown is
 * built -- on the fixture's conversation and its Bowser v. Noem stream.
 */
test('chatgpt entity panels: finished copy wins, one per answer, code stays code', () => {
  const sandbox = {};
  sandbox.self = sandbox;
  const context = require('node:vm').createContext(sandbox);
  require('./scaffolding/loader').loadScripts(context, [
    'src/core/utils.js',
    ...GENUI_SCRIPTS,
    'src/adapters/chatgpt/sidebar.js',
    'src/adapters/chatgpt/normalize.js',
  ]);
  const { chatgptSidebar, chatgptNormalize } = sandbox.__exporter;
  const dir = path.join(SCENARIOS_DIR, 'examples', 'chatgpt-entity-panel', 'responses');
  const conv = JSON.parse(fs.readFileSync(path.join(dir, 'conversation.json'), 'utf8'));
  const full = fs.readFileSync(path.join(dir, 'page-005-bowser.txt'), 'utf8');
  const capture = (stream, messageId = 'msg-2') => ({
    request: JSON.stringify({ conversation_id: conv.conversation_id, message_id: messageId, generic_entity_params: { name: 'Bowser v. Noem' } }),
    stream,
  });
  // The text of a reply delta is a JSON string inside the stream.
  const edit = (from, to) => full.split(JSON.stringify(from)).join(JSON.stringify(to));
  const cut = full.slice(0, full.indexOf('in the District of Massachusetts'));
  const panelsOf = (captures, raw = conv) => {
    const { conversation } = chatgptNormalize.normalize(raw, { entityPanels: chatgptSidebar.panelsFor(captures) });
    return conversation.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.kind === 'text' && /side panel/.test(b.text))
      .map((b) => b.text);
  };

  // Reopened and closed while it streamed: the finished copy stays.
  assert.equal(chatgptSidebar.parseCapture(capture(cut)).finished, false);
  const cutOffNote = /\n>\n> _\[Cut off: the side panel was closed before it finished writing\.\]_$/;
  let out = panelsOf([capture(full), capture(cut)]);
  assert.equal(out.length, 1);
  assert.match(out[0], /Key ruling/);
  assert.doesNotMatch(out[0], /Cut off/);
  // Only a cut-off copy: still exported, as much as there is, and says so.
  out = panelsOf([capture(cut)]);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0], /Key ruling/);
  assert.match(out[0], cutOffNote);
  // Cut off inside a code block: the block is closed before the note.
  const openCode = edit('```text\n## not a heading\n```', '```text\nprint(1)');
  const inCode = openCode.slice(0, openCode.indexOf('{"o":"patch","v":[{"p":"/data/status"'));
  [out] = panelsOf([capture(inCode)]);
  assert.match(out, /^> ```text\n> print\(1\)\n> ```\n>\n> _\[Cut off/m);

  // An id that isn't in the chat lands on the answer naming the entity --
  // the same answer as the right id, so one panel, not two.
  assert.equal(panelsOf([capture(full, 'msg-unknown'), capture(full)]).length, 1);
  // An answer on a branch the export doesn't show: the shown one naming it.
  const branched = JSON.parse(JSON.stringify(conv));
  branched.mapping['msg-2b'] = { id: 'msg-2b', parent: 'msg-1', children: [], message: { ...conv.mapping['msg-2'].message, id: 'msg-2b' } };
  assert.equal(panelsOf([capture(full, 'msg-2b')], branched).length, 1);

  // ``` inside a ```` fence is code: its "heading" stays, the real one after
  // the fence moves under the answer's headings.
  [out] = panelsOf([capture(edit('```text\n## not a heading\n```', '````md\n```\n## inside\n````\n\n# Real H1'))]);
  assert.match(out, /^> ## inside$/m);
  assert.match(out, /^> #### Real H1$/m);
  // An italic heading becomes the title without escaped stars.
  [out] = panelsOf([capture(edit('## Bowser v. Noem (2026)\n\n', '## *Bowser v. Noem* (2026)\n\n'))]);
  assert.match(out, /^> \*\*ℹ️ Bowser v\. Noem \(2026\)\*\* _\(side panel\)_$/m);
});

/**
 * "+link" only adds a line under the title and `url` in metadata.json, so one
 * on/off check covers it -- it doesn't interact with the other options.
 */
test('chat link: in the header and metadata.json only when asked', async () => {
  const dir = path.join(SCENARIOS_DIR, 'examples', 'chatgpt-basic-text');
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const base = scenario.exports.find((e) => e.message.mode === 'zip').message;
  const exportWith = async (includeLink) => {
    const r = await executeExport(dir, scenario, { ...base, includeLink });
    assert.ok(r.response && r.response.ok, 'export failed');
    const files = await unzipBlob(r.captured.blob, r.sandbox);
    const text = (name) => Buffer.from(files[Object.keys(files).find((n) => n.endsWith(name) && !n.includes('/'))]).toString('utf8');
    return { md: text('.md'), meta: JSON.parse(text('metadata.json')) };
  };
  const on = await exportWith(true);
  assert.match(on.md, /^_Link: <https:\/\/chatgpt\.com\/c\/00000000-0000-0000-0000-000000000001>_ {2}$/m);
  assert.equal(on.meta.url, 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000001');
  const off = await exportWith(false);
  assert.doesNotMatch(off.md, /_Link:/);
  assert.equal(off.meta.url, undefined);
});

/**
 * The drift detector must flag the API change behind the duplicated-images
 * bug: claude.ai starting to list uploads as `image` blocks in content[].
 */
test('schema drift: flags new content block types', () => {
  const { collect, diff, merge } = require('../tools/schema-drift');
  const file = path.join(SCENARIOS_DIR, 'examples', 'claude-uploaded-images', 'responses', 'conversation.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = structuredClone(current);
  for (const m of before.chat_messages) m.content = m.content.filter((c) => c.type !== 'image');

  const endpoint = 'GET claude.ai/api/organizations/{id}/chat_conversations/{id}';
  const baseline = merge({ endpoints: {} }, collect([{ endpoint, json: before, source: 'before' }]));
  const report = diff(baseline, collect([{ endpoint, json: current, source: 'after' }]));

  assert.equal(report.length, 1);
  const r = report[0];
  assert.equal(r.newEndpoint, false);
  assert.deepEqual(r.newValues.map((v) => [v.path, v.values]), [['chat_messages[].content[].type', ['image']]]);
  assert.deepEqual(r.newPaths.map((p) => p.path), ['chat_messages[].content[].file_uuid']);

  assert.deepEqual(diff(baseline, collect([{ endpoint, json: before, source: 'again' }])), []);
});

/**
 * Browser automation exports via a page event (core/export-entry.js) --
 * only when the user enabled it in options.
 */
test('page-triggered export: gated by the pageTrigger option', async () => {
  const { createBrowserContext, loadScripts, installDownloadCapture, scriptsFor } =
    require('./scaffolding/loader');
  const { createMockFetch } = require('./scaffolding/fetch-mock');
  const dir = path.join(SCENARIOS_DIR, 'examples', 'claude-uploaded-images');
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));

  const exportViaPage = async (pageTrigger) => {
    const browser = createBrowserContext({
      location: scenario.location,
      fakeDate: scenario.fakeDate,
      mockFetch: createMockFetch(dir, scenario),
      devSettings: { pageTrigger },
    });
    const { sandbox } = browser;
    const target = new EventTarget();
    sandbox.addEventListener = target.addEventListener.bind(target);
    sandbox.dispatchEvent = target.dispatchEvent.bind(target);
    sandbox.CustomEvent = CustomEvent;
    sandbox.document.documentElement = { dataset: {} };
    loadScripts(browser.context, scriptsFor('claude', { dev: true }));
    installDownloadCapture(sandbox, browser.captured);

    const result = new Promise((resolve) =>
      target.addEventListener('llm-exporter:export-result', (e) => resolve(JSON.parse(e.detail)), { once: true }));
    target.dispatchEvent(new CustomEvent('llm-exporter:export', { detail: JSON.stringify({ mode: 'zip' }) }));
    return { result: await result, browser };
  };

  const off = await exportViaPage(false);
  assert.equal(off.result.ok, false);
  assert.match(off.result.error, /disabled/);
  assert.equal(off.browser.captured.downloads.length, 0);

  const on = await exportViaPage(true);
  assert.equal(on.result.ok, true, on.result.error);
  assert.equal(on.result.filename, 'Uploaded images-2026-10-01.zip');
  assert.equal(on.browser.captured.downloads.length, 1);
  assert.deepEqual(JSON.parse(on.browser.sandbox.document.documentElement.dataset.llmExporterResult), on.result);
});

/**
 * Gemini fetches assets through the service worker, out of the fetch
 * wrapper's sight; geminiApi.fetchAsset reports them via noteProxied.
 */
test('debug capture: records service-worker proxied asset fetches', async () => {
  const { createBrowserContext, loadScripts, installDownloadCapture, scriptsFor } =
    require('./scaffolding/loader');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const okUrl = 'https://lh3.googleusercontent.com/gg/ok-image';
  const browser = createBrowserContext({
    location: 'https://gemini.google.com/app/abc123',
    mockFetch: async (url) => (url === okUrl
      ? new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
      : new Response('nope', { status: 404, statusText: 'Not Found' })),
  });
  loadScripts(browser.context, scriptsFor('gemini', { dev: true }));
  installDownloadCapture(browser.sandbox, browser.captured);
  const ns = browser.sandbox.__exporter;

  const result = await ns.dev.debugCapture.run({ enabled: true, adapter: 'gemini', options: {} }, async () => {
    const got = await ns.geminiApi.fetchAsset(okUrl);
    assert.ok(Buffer.from(got.bytes).equals(png), 'service-worker emulation returns the mocked bytes');
    await assert.rejects(ns.geminiApi.fetchAsset('https://lh3.googleusercontent.com/gg/missing'), /HTTP 404/);
    return { ok: true, filename: 'Chat-2026-10-01.md' };
  });
  assert.equal(result.ok, true);

  const harDownload = browser.captured.downloads.find((d) => d.filename === 'Chat-2026-10-01.debug.har');
  assert.ok(harDownload, 'HAR downloaded');
  const entries = JSON.parse(await harDownload.blob.text()).log.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].request.url, okUrl);
  assert.equal(entries[0].response.status, 200);
  assert.ok(Buffer.from(entries[0].response.content.text, 'base64').equals(png));
  assert.equal(entries[1].response.status, 502);
  assert.match(entries[1]._error, /HTTP 404/);
});

/**
 * Dev tooling (src/dev/) must stay out of store installs and must not be
 * needed by the product: the export works the same without it.
 */
test('dev tooling: store installs never load it, product works without it', async () => {
  const dir = path.join(SCENARIOS_DIR, 'examples', 'claude-uploaded-images');
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const zipExport = scenario.exports.find((e) => e.message.mode === 'zip');
  // Asking for debug capture must not matter where there is no dev tooling.
  const message = { ...zipExport.message, debugCapture: true };

  for (const storeInstall of [true, false]) {
    const { createBrowserContext } = require('./scaffolding/loader');
    const probe = createBrowserContext({ location: scenario.location, storeInstall });
    const urls = [];
    probe.sandbox.chrome.runtime.getURL = (f) => {
      urls.push(f);
      return `chrome-extension://test/${f}`;
    };
    const { loadScripts, scriptsFor } = require('./scaffolding/loader');
    loadScripts(probe.context, scriptsFor('claude'));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(probe.sandbox.__exporter.devLoader.isUnpacked(), !storeInstall);
    assert.deepEqual(urls.length > 0, !storeInstall,
      storeInstall ? 'store install must not try to load src/dev' : 'unpacked install tries src/dev');
    assert.equal(probe.sandbox.__exporter.dev, undefined);

    const r = await executeExport(dir, scenario, message, { storeInstall });
    assert.ok(r.response.ok, r.response.error);
    assert.equal(r.captured.downloads.length, 1, 'no .debug.har without dev tooling');
  }
});

/**
 * tools/live.js collect: what Claude Desktop leaves in the downloads folder
 * (an export tagged with a feature id + its .debug.har) becomes a report,
 * a replayable scenario and a remembered test-chat URL.
 */
test('live collect: tagged downloads become report, scenario and fixture', async () => {
  const { spawnSync } = require('node:child_process');
  const dir = path.join(SCENARIOS_DIR, 'examples', 'claude-uploaded-images');
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const message = { ...scenario.exports.find((e) => e.message.mode === 'zip').message,
    debugCapture: true, tag: 'claude.image-upload' };
  const run = await executeExport(dir, scenario, message, { dev: true });
  assert.equal(run.captured.downloads.length, 2);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-live-'));
  try {
    const downloads = path.join(tmp, 'downloads');
    fs.mkdirSync(downloads);
    for (const d of run.captured.downloads) {
      fs.writeFileSync(path.join(downloads, d.filename), Buffer.from(await d.blob.arrayBuffer()));
    }
    // A stray file from before the run must be ignored.
    fs.writeFileSync(path.join(downloads, 'old.debug.har'), '{}');
    fs.utimesSync(path.join(downloads, 'old.debug.har'), new Date('2020-01-01'), new Date('2020-01-01'));

    const liveDir = path.join(tmp, 'live');
    const runDir = path.join(liveDir, 'runs', 'test-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'config.local.json'), JSON.stringify({ downloadsDir: downloads }));
    fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({
      createdAt: new Date(Date.now() - 5000).toISOString(),
      tasks: [
        { featureId: 'claude.image-upload', provider: 'claude', title: 'Two uploaded images', action: 'create',
          chatUrlPattern: '^https://claude\.ai/chat/[0-9a-f-]{36}' },
        { featureId: 'claude.pdf-upload', provider: 'claude', title: 'Uploaded PDF', action: 'create',
          chatUrlPattern: '^https://claude\.ai/chat/[0-9a-f-]{36}' },
      ],
      skipped: [],
    }));

    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'live.js'), 'collect', runDir], {
      env: { ...process.env, LIVE_DIR: liveDir, LIVE_SCENARIOS_DIR: path.join(tmp, 'scenarios'),
        SCHEMA_BASELINE: path.join(tmp, 'baseline.json') },
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, `collect should flag the broken feature\n${res.stderr}`);

    const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
    const img = report.results.find((r) => r.featureId === 'claude.image-upload');
    // The example deliberately has one image that fails to download.
    assert.equal(img.status, 'BROKEN');
    assert.ok(img.audit.some((f) => f.code === 'image-not-loaded'));
    assert.ok(img.expect.results.some((x) => !x.ok && /images ==2, got 1/.test(x.check)));
    assert.equal(img.replayIdentical, true, 'replaying the HAR reproduces the downloaded export');
    assert.equal(report.results.find((r) => r.featureId === 'claude.pdf-upload').status, 'NOT_RUN');
    assert.ok(report.drift.length > 0, 'no baseline: everything is drift');

    assert.deepEqual(fs.readdirSync(downloads), ['old.debug.har'], 'run files moved out of downloads');
    const recorded = JSON.parse(fs.readFileSync(path.join(tmp, 'scenarios', 'live-claude.image-upload', 'scenario.json'), 'utf8'));
    assert.deepEqual(recorded.auditAllow, ['image-not-loaded']);
    assert.ok(fs.existsSync(path.join(tmp, 'scenarios', 'live-claude.image-upload', 'expected', 'zip-recorded')));
    const fixtures = JSON.parse(fs.readFileSync(path.join(liveDir, 'fixtures.local.json'), 'utf8'));
    assert.equal(fixtures['claude.image-upload'].url, scenario.location);
    assert.match(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), /## Broken[\s\S]*claude\.image-upload/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Every combination of export options on a conversation with artifacts,
 * reasoning, files, citations and voice: each output obeys its options.
 */
test('settings matrix: all 160 option combinations', async () => {
  const { runMatrix, summarize } = require('../tools/settings-matrix');
  for (const name of ['claude-new-tools', 'claude-uploaded-images']) {
    const sum = summarize(await runMatrix({ scenarioDir: path.join(SCENARIOS_DIR, 'examples', name) }));
    assert.equal(sum.total, 160);
    assert.deepEqual(sum.findings, [], `${name}: ${JSON.stringify(sum.findings, null, 1)}`);
  }
});

/**
 * Live expectations must test the export, not echo the prompt. mdMatches
 * sees the user's turns too, so a regex that matches the prompt or a
 * follow-up passes without the assistant doing anything.
 */
test('live catalog: expectations are valid and not satisfied by the prompt', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'live', 'features.json'), 'utf8'));
  const ids = new Set();
  for (const f of catalog.features) {
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.ok(catalog.providers[f.provider], `${f.id}: unknown provider`);
    assert.ok(f.refresh === undefined || f.refresh === 'each-run', `${f.id}: refresh must be "each-run"`);
    const e = f.expect || {};
    for (const key of ['mdMatches', 'mdNotMatches', 'assistantMatches', 'outputMatches']) {
      for (const re of e[key] || []) assert.doesNotThrow(() => new RegExp(re, 'm'), `${f.id}: bad regex ${re}`);
    }
    const typed = [f.prompt || '', ...(f.followUps || [])].join('\n');
    for (const re of e.mdMatches || []) {
      assert.ok(!new RegExp(re, 'm').test(typed),
        `${f.id}: mdMatches /${re}/ matches the prompt itself — use assistantMatches/outputMatches`);
    }
    for (const u of f.uploads || []) {
      assert.ok(fs.existsSync(path.join(__dirname, 'live', 'fixtures', u)), `${f.id}: missing fixture ${u}`);
    }
  }
});

/** What each expectation looks at (tools/live.js checkExpectations). */
test('live checks: scopes of md / assistant / output matches', () => {
  const { checkExpectations } = require('../tools/live');
  const md = [
    '# Chat', '', '## Human', '', 'PROMPT-TOKEN', '', '---', '',
    '## Assistant', '',
    '<details><summary>Thinking</summary>', '', 'THINK-TOKEN', '', '</details>', '',
    '**Tool call: `Write`**', '', '```json', '{"content": "DUMP-TOKEN"}', '```', '',
    'REPLY-TOKEN', '', '---', '',
  ].join('\n');
  const exp = { mode: 'zip', md, files: new Map([['files/user-upload.txt', Buffer.from('UPLOAD-TOKEN')]]) };
  const check = (expect) => checkExpectations({ expect }, exp).results.map((r) => r.ok);
  assert.deepEqual(check({ mdMatches: ['PROMPT-TOKEN', 'REPLY-TOKEN', 'DUMP-TOKEN', 'THINK-TOKEN'] }), [true, true, false, false]);
  assert.deepEqual(check({ assistantMatches: ['REPLY-TOKEN', 'PROMPT-TOKEN', 'DUMP-TOKEN'] }), [true, false, false]);
  assert.deepEqual(check({ outputMatches: ['REPLY-TOKEN', 'UPLOAD-TOKEN', 'PROMPT-TOKEN', 'DUMP-TOKEN'] }), [true, true, false, false]);
  assert.deepEqual(check({ reasoning: true }), [true]);
});

/**
 * ChatGPT generative UI: a layout tag inside a table cell stays inline, an
 * <svg> is kept whole with valid attribute names, a <Chart> becomes a table
 * of its data. (Shapes from a real chat, 2026-10-14.)
 */
const loadGenui = () => {
  const sandbox = {};
  sandbox.self = sandbox;
  const context = require('node:vm').createContext(sandbox);
  require('./scaffolding/loader').loadScripts(context, GENUI_SCRIPTS);
  return sandbox.__exporter.chatgptGenui;
};

/**
 * Model data as model_dil_v2 carries it: component results keyed by opaque
 * ids, listed in `constants` in the order of their tags.
 */
const genuiMeta = (results, extra = {}) => ({
  model_dil_v2: {
    constants: Object.fromEntries(results.map((_, i) => [String(i), `id-${i}`])),
    appData: {
      opGenui: {
        componentResults: Object.fromEntries(results.map(([componentName, state], i) => [`id-${i}`, { status: 'resolved', componentName, state }]).reverse()),
        modelDataBindings: extra.bindings || {},
      },
    },
    ...(extra.fallbackMarkdown ? { fallbackMarkdown: extra.fallbackMarkdown } : {}),
  },
  ...(extra.meta || {}),
});

test('chatgpt genui: table cells, svg drawings, charts', () => {
  const { render } = loadGenui();
  const md = render([
    '| Пара осей | Что показывают исследования |',
    '|---|---|',
    '| Доход ↔ Образование | <text color="green">Устойчивая связь</text> |',
    '| A | <text>x</text><text>y</text> |',
    '',
    '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">',
    '  <rect x="1" y="1" width="8" height="8" fillOpacity="0.13" strokeWidth={1.2}/>',
    '',
    '  <g fontSize="12" textAnchor="middle"><text x="5" y="5">Hi</text></g>',
    '</svg>',
    '<Chart content={{"chartType":"bar","meta":{"footer":"Source: ACS."},"xKey":"education","series":[{"dataKey":"income","label":"Median","valuePrefix":"$"}],"data":[{"education":"High school","income":40684},{"education":"Graduate","income":90191}]}}/>',
    '<box><text>Block</text></box>',
  ].join('\n'), { model_dil_v2: {} });
  assert.match(md, /^\| Доход ↔ Образование \| Устойчивая связь \|$/m);
  assert.match(md, /^\| A \| x y \|$/m);
  assert.match(md, /\n\n<svg viewBox="0 0 10 10"[^\n]*>\n<rect [^\n]*fill-opacity="0.13" stroke-width="1.2"\/>\n<g font-size="12" text-anchor="middle"><text x="5" y="5">Hi<\/text><\/g>\n<\/svg>\n\n/);
  assert.match(md, /📊 _Chart \(bar\)_\n\n\| education \| Median \|\n\|---\|---\|\n\| High school \| \$40684 \|\n\| Graduate \| \$90191 \|\n\n_Source: ACS\._/);
  assert.match(md, /\n\nBlock$/);
  // A grid of picture cards: picture, name and caption each on its own line
  // of the list item; plain tiles stay one line (R — Reset).
  const img = (u) => ({ componentName: 'AsyncImage', status: 'resolved', state: { images: [{ url: `https://p/${u}`, content_url: `https://i/${u}.jpg`, title: `T ${u}` }] } });
  const cards = render([
    '<grid columns={2}>',
    '  <grid-item>',
    '    <AsyncImage query="a"/>',
    '    <text weight="medium">«Український»</text>',
    '    <caption>Ржаная обдирная</caption>',
    '  </grid-item>',
    '</grid>',
    '<grid columns={4}><grid-item><text>R</text><caption>Reset</caption></grid-item></grid>',
  ].join('\n'), { model_dil_v2: { appData: { opGenui: { componentResults: { a: img('a') } } } } });
  assert.match(cards, /^- \[!\[T a\]\(https:\/\/i\/a\.jpg\)\]\(https:\/\/p\/a\)\n {2}«Український»\n {2}_Ржаная обдирная_$/m);
  assert.match(cards, /^- R — _Reset_$/m);
  // Nothing that runs code survives; JSX style objects become CSS.
  const unsafe = render([
    '<svg viewBox="0 0 10 10">',
    '<script>alert(1)</script><foreignObject><div>x</div></foreignObject>',
    '<rect onClick="steal()" onmouseover={go} style={{fillOpacity: 0.5, stroke: "red"}}/>',
    '<a href="javascript:alert(1)"><text>t</text></a>',
    '</svg>',
  ].join('\n'), { model_dil_v2: {} });
  assert.doesNotMatch(unsafe, /script|foreignObject|on-?click|onmouseover|javascript:/i);
  assert.match(unsafe, /<rect style="fill-opacity:0.5;stroke:red"\/>/);
  assert.match(unsafe, /<a href="#"><text>t<\/text><\/a>/);
  const { audit } = require('../tools/audit-export');
  assert.deepEqual(audit({ md: `# C\n\n## Assistant\n\n${md}\n`, files: new Map() }).filter((f) => f.severity === 'error'), []);
  const broken = '# C\n\n## Assistant\n\n| a | b |\n|---|---|\n| x |\n\ny\n\n |\n';
  assert.ok(audit({ md: broken, files: new Map() }).some((f) => f.code === 'broken-table-row'));
});

/**
 * ChatGPT generative UI program and controls: useState and const values
 * drive {#each}/{#if} and the controls' initial state; a value the
 * evaluator can't work out shows as nothing; braces naming nothing bound
 * stay text. (Shapes from the 2026-11-04 demo chats.)
 */
test('chatgpt genui: program state and controls', () => {
  const { render, unrendered } = loadGenui();
  const md = render([
    '{@body const [days,setDays] = DIL.useState("14")}',
    '{@body const [picked,setPicked] = DIL.useState(["a"])}',
    '{@body const [n,setN] = DIL.useState(3)}',
    '{@body const opts = [{id:"a",label:"Alpha"},{id:"b",label:"Beta"}]}',
    '{@body const total = n*2+1}',
    '{@body const money = v => "$"+v.toFixed(2)}',
    '{@body const pick = () => { return Math.random() }}',
    '<box gap={2}>',
    '  <radio-group value={days} onChange={setDays}>',
    '    <radio value="10">10 days</radio>',
    '    <radio value="14">14 days</radio>',
    '  </radio-group>',
    '  {#each opts as o}',
    '    <checkbox key={o.id} checked={picked.includes(o.id)} onChange={v=>setPicked(p=>[...p,o.id])}>{o.label}</checkbox>',
    '  {/each}',
    '  <slider min={0} max={30} step={1} value={n*6} marks={[{value:0,label:"0%"}]}/>',
    '  <label>Name</label>',
    '  <input value="" placeholder="Your name"/>',
    '  <date-picker value={"2026-12-08"} onChange={x=>x}/>',
    '  <segmented-control value="custom" options={[{value:"equal",label:"Split equally"},{value:"custom",label:"Custom"}]}/>',
    '  {#if days === "14" && !picked.includes("b")}Long trip: {total} km{:else if n > 2}Mid{:else}Short{/if}',
    '  <text>Each: {money(total)}</text>',
    '  <text>Draw: {pick()}</text>',
    '  <text>Width {`${n*10}%`}</text>',
    '  <button onClick={()=>GenUI.copy("x")}>Copy it</button>',
    '</box>',
    'Range \\frac{2}{g} and {1, 2}.',
  ].join('\n'), { model_dil_v2: {} });
  assert.match(md, /^- ○ 10 days\n- ◉ 14 days$/m);
  assert.match(md, /^- \[x\] Alpha\n- \[ \] Beta$/m);
  assert.match(md, /^🎚️ 18 \(0–30\)$/m);
  assert.match(md, /^Name\n\n____ _\(Your name\)_$/m);
  assert.match(md, /^`2026-12-08`$/m);
  assert.match(md, /^- ○ Split equally\n- ◉ Custom$/m);
  assert.match(md, /^Long trip: 7 km$/m);
  assert.match(md, /^Each: \$7\.00$/m);
  assert.match(md, /^Draw:$/m);
  assert.match(md, /^Width 30%$/m);
  assert.match(md, /Range \\frac\{2\}\{g\} and \{1, 2\}\.$/);
  assert.doesNotMatch(md, /Copy it|Mid|Short|DIL|@body|\{#|\{:|\{\//);
  assert.equal(unrendered(md), false);
});

/**
 * The genui expression interpreter: arrow functions, spread, the pure
 * helpers the programs use -- and everything else unknown, bounded.
 */
test('chatgpt genui: expression interpreter', () => {
  const { evaluate, MISSING } = loadGenui().expr;
  const scope = {
    events: [{ name: 'A', type: 'Test' }, { name: 'B', type: 'Landing' }, { name: 'C', type: 'Landing' }],
    filter: 'Landing',
    subtotal: '180',
    tip: 18,
    names: ['P1', 'P2'],
    later: MISSING,
  };
  const ev = (src) => evaluate(src, scope);
  // Arrows, object spread and shorthand, chained array helpers.
  assert.equal(JSON.stringify(ev('events.map((e,i)=>({...e,i})).filter(e=>filter==="All"||e.type===filter).map(e=>e.i)')), '[1,2]');
  assert.equal(ev('events.find(e=>e.type==="Landing").name'), 'B');
  assert.equal(ev('events.findIndex(e=>e.name==="C")'), 2);
  assert.equal(ev('events.some(e=>e.type==="Test") && events.every(e=>e.name.length===1)'), true);
  assert.equal(ev('[3,1,2].sort((a,b)=>a-b).slice(1).join("-")'), '2-3');
  assert.equal(ev('[1,2,3].reduce((a,b)=>a+b,0)'), 6);
  assert.equal(JSON.stringify(ev('[[1],[2]].flatMap(x=>x)')), '[1,2]');
  assert.equal(JSON.stringify(ev('Array.from({length:3},(_,i)=>i*2)')), '[0,2,4]');
  assert.equal(JSON.stringify(ev('[0.4,1.6].map(Math.floor)')), '[0,1]');
  // Numbers and strings as the page formats them (en-US only).
  assert.equal(ev('Math.round((Number(subtotal)||0)*tip)/100'), 32.4);
  assert.equal(ev('"$"+(1234.5).toFixed(2)'), '$1234.50');
  assert.equal(ev('(1234567.891).toLocaleString("en-US",{maximumFractionDigits:1})'), '1,234,567.9');
  assert.equal(ev('Math.max(...[1,5,3]) + Math.min(2, 4) + Math.pow(2, 3) + Math.abs(-1) + Math.sqrt(9)'), 19);
  assert.equal(ev('2**3**2'), 512);
  assert.equal(ev('"  Apollo ".trim().toUpperCase().replace("O", "0") + " " + "x".padStart(3, ".")'), 'AP0LLO ..x');
  assert.equal(ev('names.includes("P2") && "a-b".split("-").length === 2 && "abc".startsWith("ab")'), true);
  assert.equal(ev('parseInt("42px") + parseFloat("1.5") + String(3)'), '43.53');
  assert.equal(ev('`${names.length} of ${events.length}`'), '2 of 3');
  // A closure from the program, called later.
  const money = evaluate('n => "$"+(n/100).toFixed(2)', scope);
  assert.equal(evaluate('money(tip*100)', { ...scope, money }), '$18.00');
  // Unknown: statement bodies, assignments, other globals, unknown names,
  // Math.random, prototype methods, runaway recursion and huge arrays.
  for (const src of [
    '() => { return 1 }', 'tip = 2', 'Math.random()', 'window.location', 'Date.now()', 'later + 1', 'nope',
    'names.push("x")', 'names.constructor(1)', '"a".replace(/a/, "b")', 'Array.from({length:1e7})',
    // Lists that grow past the item cap as they are built.
    'Array.from({length:200}).flatMap(() => Array.from({length:200}))',
    'Array.from({length:9000}).concat(Array.from({length:9000}))',
    // Strings that grow past the char cap: doubled in a loop, padded,
    // joined, replaced; and a split into more items than the cap.
    'Array.from({length:28}).reduce(s => s + s, "x")',
    'Array.from({length:28}).reduce(s => `${s}${s}`, "x")',
    'Array.from({length:28}).reduce(s => s.replace("y", s), "xy")',
    '"x".padStart(1e9)',
    'Array.from({length:2000}).map(() => "x".padStart(1000)).join("")',
    '"x".padStart(2000).replaceAll(" ", "y".padStart(1000))',
    'Array.from({length:10000}).map(() => "abcdefghij").join("").split("")',
  ]) assert.equal(ev(src), MISSING, src);
  // Within the caps they work.
  assert.equal(ev('Array.from({length:19}).reduce(s => s + s, "x").length'), 2 ** 19);
  assert.equal(ev('Array.from({length:1000}).map(() => "x".padStart(1000)).join("").length'), 1e6);
  assert.equal(ev('names.constructor'), undefined); // no prototype access
  const loop = evaluate('f => f(f)', scope);
  assert.equal(evaluate('loop(loop)', { loop }), MISSING);
  // Lazy: an unknown part in a branch not taken doesn't matter.
  assert.equal(ev('tip > 10 ? "big" : later'), 'big');
  assert.equal(ev('false && later.x'), false);
});

/**
 * A {…} attribute value with quotes, a backslash or a line break is written
 * back as one quoted attribute (entities), so the tag still parses.
 */
test('chatgpt genui: attribute values with quotes', () => {
  const { render, unrendered } = loadGenui();
  // As the model writes it: JSON-style escapes inside the braces.
  const md = render(String.raw`See <Link url="https://x.test/a" title={"The \"Best\" guide & <more>"}/> now. <Link url="https://x.test/b" title={"C:\\temp"}/>`, { model_dil_v2: {} });
  assert.equal(md, String.raw`See [The "Best" guide & <more>](https://x.test/a) now. [C:\temp](https://x.test/b)`);
  assert.equal(unrendered(md), false);
});

/**
 * ChatGPT generative UI named widgets, from their resolved results (in the
 * order of their ids in `constants`) or their own attributes.
 */
test('chatgpt genui: named widgets', () => {
  const { render, unrendered } = loadGenui();
  const quizQ = (v) => ({ prompt: `Q${v}?`, options: [{ value: 'A', label: 'one', feedback: 'no' }, { value: 'B', label: 'two', feedback: 'yes, two' }], correct_values: ['B'] });
  const meta = genuiMeta(
    [
      ['LearningQuiz', { title: 'Quiz T', questions: [quizQ(1)] }],
      ['Rating', { rating_label: '4.3', review_count_label: '(1,740)', attribution: { provider_label: 'Tripadvisor', provider_url: 'https://ta/x' } }],
      ['StockChart', { asset_display_name: 'NVIDIA Corp (NVDA)', current_price_text: '$200.13', price_status_text: 'Closed', fallback_summary: { price_change_text: '-$6.41 (3.1%)' }, metrics_display: [{ cols: [{ label: 'Open', value: '203.58' }] }], timeframe_configs: { '1D': { chart: { data: [{ close: 1 }] } } } }],
      ['NbaScores', { rows: [{ games: [{ game: { game_id: 'g1', teams: [{ name: 'Celtics', score: '93' }, { name: 'Rockets', score: '109', winner: true }], primaryLabel: 'Final', secondaryLabel: 'Nov 2' } }] }] }],
      ['ReservationTimePillsRefWidget', { reservation_identity: { name: 'Barolo' }, groups: [{ request_date_label: 'Thu, Nov 5', party_size_label: '4 guests', times: [{ formatted_time: '7:00 PM', url: 'https://book/7' }], change_options: [{ provider_name: 'OpenTable', url: 'https://ot' }] }] }],
      ['FileCite', { refid: 'turn0file1', file_name: 'meeting-notes.md', file_action_payload: { input_pointer: { line_range_start: 12 } } }],
      ['AsyncImageGroup', { images: [{ url: 'https://p/1', content_url: 'https://i/1.jpg', title: 'One' }, { url: 'https://p/2', content_url: 'https://i/2.jpg', title: 'Two' }] }],
    ],
    { bindings: { turn1business2: { name: 'Barolo', rating: { $type: 'business_rating' } } } }
  );
  const md = render([
    '<LearningQuiz title="Ignored" questions={[{"question":"attr","options":[],"correctValues":[]}]}/>',
    '<text><Entity ref="turn1business2" value={turn1business2.name}/></text>',
    '<Rating data={turn1business2.rating}/>',
    '<StockChart ticker="NVDA"/>',
    '<NbaScores game_ids={["g1"]}/>',
    '<ReservationTimePillsRefWidget ref="turn1business2"/>',
    'Deadlines passed. <FileCite ref="turn0file1" line_range_start={12} line_range_end={16}/>',
    '<AsyncImageGroup query={["a","b"]}/>',
    '<row><favicon url="https://www.kayak.com" size="24px"/> **KAYAK**</row>',
    '<LearningFlashcards title="Deck" cards={[{"front":"F1","back":"B1"},{"front":"F2","back":"B2"}]}/>',
    '<LanguageLearningBlockWidgetPronunciation source_text="Worcestershire" pronunciation_hint="WUUS-tuh-shuh" pronunciation_language="en-GB"/>',
  ].join('\n'), meta);
  assert.match(md, /^\*\*📝 Quiz T\*\*\n\n\*\*1\. Q1\?\*\*\n\n- A\) one\n- B\) two\n\n<details><summary>Answer<\/summary>\n\n\*\*B\) two\*\* — yes, two\n\n<\/details>$/m);
  assert.match(md, /^★ 4\.3 \(1,740 reviews · \[Tripadvisor\]\(https:\/\/ta\/x\)\)$/m);
  assert.match(md, /^📈 \*\*NVIDIA Corp \(NVDA\)\*\* — \$200\.13 · -\$6\.41 \(3\.1%\) · Closed\n\n_Open 203\.58_$/m);
  assert.match(md, /^- 🏀 Celtics 93 – \*\*Rockets 109\*\* \(Final · Nov 2\)$/m);
  assert.match(md, /^- 🕒 Thu, Nov 5 · 4 guests: \[7:00 PM\]\(https:\/\/book\/7\) \(book: \[OpenTable\]\(https:\/\/ot\)\)$/m);
  assert.match(md, /^Deadlines passed\. \(meeting-notes\.md, lines 12–16\)$/m);
  assert.match(md, /^\[!\[One\]\(https:\/\/i\/1\.jpg\)\]\(https:\/\/p\/1\) \[!\[Two\]\(https:\/\/i\/2\.jpg\)\]\(https:\/\/p\/2\)$/m);
  assert.match(md, /^\*\*KAYAK\*\*$/m);
  assert.match(md, /^1\. \*\*F1\*\* — B1\n2\. \*\*F2\*\* — B2$/m);
  assert.match(md, /^🔊 \*\*Worcestershire\*\* — _WUUS-tuh-shuh_ \(en-GB\)$/m);
  assert.doesNotMatch(md, /object Object|attr|Ignored|favicon/);
  assert.equal(unrendered(md), false);
  // Without a result the tag's own data is used; with neither it can't render.
  const own = render('<LearningQuiz questions={[{"question":"Own?","options":[{"value":"A","label":"x"}],"correctValues":["A"]}]}/>', { model_dil_v2: {} });
  assert.match(own, /\*\*1\. Own\?\*\*\n\n- A\) x\n\n<details><summary>Answer<\/summary>\n\n\*\*A\) x\*\*/);
  assert.equal(unrendered(render('<LearningViz type_id="DNS_RESOLUTION"/>', { model_dil_v2: {} })), true);
});

/**
 * ChatGPT generative UI safety net: what can't be rendered (an unknown
 * widget, a condition the evaluator can't work out) makes the message come
 * from the server's static version, its genui markers resolved; the
 * entity/url markers stay for normalize.js.
 */
test('chatgpt genui: safety net falls back to the static version', () => {
  const { render } = loadGenui();
  const M = (...parts) => `\uE200${parts.join('\uE202')}\uE201`;
  const meta = genuiMeta(
    [
      ['Cite', { items: [{ ref_id: 'turn1search0', url: 'https://nps.gov/x', title: 'Sand temps', source_label: 'NPS' }] }],
      ['AsyncImage', { images: [{ url: 'https://p/hotel', content_url: 'https://i/hotel.jpg', title: 'Hotel', refs: [{ turn_index: 1, ref_type: 'business', ref_index: 4 }] }] }],
    ],
    {
      bindings: { turn1business4: { name: 'Aarchway Inn', address: 'Moab, UT' } },
      fallbackMarkdown: [
        `**${M('entity', '["turn1business4","Aarchway Inn"]')}** is hot. ${M('cite', 'turn1search0')}`,
        '',
        M('image_group', '{"entity_refs":["turn1business4"],"layout":"carousel"}'),
        '',
        M('genui', '{"map_widget_v2":{"points":[{"ref":"turn1business4"}]}}'),
        '',
        `Notes ${M('filecite', 'turn0file0', 'L44-L61')}`,
        '',
        '[Copy bill breakdown]',
        '',
        '[Previous] / [Next]',
        '',
        '[NASA](https://nasa.gov) [x]',
      ].join('\n'),
    }
  );
  const fromStatic = render('Intro\n\n<FancyFutureWidget data={turn1business4}/>\n\n<Cite ref="turn1search0"/>', meta);
  assert.match(fromStatic, /^\*\*\uE200entity\uE202\["turn1business4","Aarchway Inn"\]\uE201\*\* is hot\. \(\[NPS\]\(https:\/\/nps\.gov\/x "Sand temps"\)\)$/m);
  assert.match(fromStatic, /^\[!\[Hotel\]\(https:\/\/i\/hotel\.jpg\)\]\(https:\/\/p\/hotel\)$/m);
  assert.match(fromStatic, /^- 📍 \[Aarchway Inn\]\(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Aarchway%20Inn%2C%20Moab%2C%20UT\) — Moab, UT$/m);
  assert.match(fromStatic, /^Notes \(lines 44–61\)$/m);
  // The static version's buttons go; a line with a link stays.
  assert.match(fromStatic, /\(lines 44–61\)\n\n\[NASA\]\(https:\/\/nasa\.gov\) \[x\]$/);
  assert.doesNotMatch(fromStatic, /Fancy|Intro|Copy bill|Previous/);
  // An {#if} on a value nobody can work out → the static version too.
  const cond = render('{@body const x = Math.random()}\n<box>{#if x > 0.5}Yes{:else}No{/if}</box>', meta);
  assert.match(cond, /is hot/);
  // No static version: the render is kept as it is.
  const kept = render('<box>A</box>\n<FancyFutureWidget/>', { model_dil_v2: {} });
  assert.equal(kept, 'A\n\n<FancyFutureWidget/>');
});

/**
 * ChatGPT generative UI in a markdown table: a picture, a place and a
 * control written inside a cell stay on the row (pipes in them escaped).
 */
test('chatgpt genui: components inside a table cell stay on the row', () => {
  const { render } = loadGenui();
  const meta = genuiMeta([['AsyncImage', { images: [{ url: 'https://p/a', content_url: 'https://i/a.jpg', title: 'Guide | Site' }] }]]);
  const md = render([
    '| Photo | Stop | Time |',
    '|---|---|---|',
    '| <AsyncImage query="a" aspectRatio="5:4"/> | **<Entity category="place" value="Bryce"/>** <text size="xs">Hoodoos.</text> <text size="xs"><Link url="https://maps/x" title="Map"/></text> | 4 h |',
    '| <checkbox checked>Go</checkbox> | <Chart content={{"xKey":"k","data":[{"k":"a","v":1}]}}/> | 1 h |',
  ].join('\n'), meta);
  const rows = md.split('\n');
  assert.equal(rows.length, 4);
  assert.equal(rows[2], '| [![Guide \\| Site](https://i/a.jpg)](https://p/a) | **Bryce** Hoodoos. [Map](https://maps/x) | 4 h |');
  assert.match(rows[3], /^\| - \[x\] Go \| 📊 _Chart_ \\\| k \\\| v \\\|.* \| 1 h \|$/);
});

/**
 * Provider day: the plan follows scenarios.json (research first, provider
 * filter, paste text embedded, every dialog export carries the page
 * inventory), and the scenario catalog stays consistent.
 */
test('live day: plan and scenario catalog', () => {
  const liveDay = require('../tools/live-day');
  const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'live', 'scenarios.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'live', 'features.json'), 'utf8'));
  const { snippetFor } = require('../tools/live');
  const caps = new Set(scenarios.capabilities.map((c) => c.id));
  for (const s of scenarios.scenarios) {
    for (const t of s.turns) for (const x of t.exercises || []) assert.ok(caps.has(x), `${s.id}: unknown capability ${x}`);
    const files = [...(s.uploads || []), ...s.turns.flatMap((t) => [...(t.attach || []), ...(t.paste ? [t.paste] : [])])];
    for (const f of files) assert.ok(fs.existsSync(path.join(__dirname, 'live', 'fixtures', f)), `${s.id}: missing fixture ${f}`);
  }
  for (const c of scenarios.capabilities) {
    const used = scenarios.scenarios.some((s) => s.turns.some((t) => (t.exercises || []).includes(c.id)));
    assert.ok(used || c.incidental || c.coveredBy, `capability ${c.id} is not exercised by any scenario`);
  }

  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-day-'));
  try {
    fs.mkdirSync(path.join(runsDir, '2026-09-01-claude'));
    fs.mkdirSync(path.join(runsDir, '2026-09-20-chatgpt'));
    const plan = liveDay.planDay({
      provider: 'claude', scenarios, catalog,
      fixtures: { 'claude.web-search': { url: 'https://claude.ai/chat/x' }, 'chatgpt.kitchen-sink': { url: 'https://chatgpt.com/c/y' } },
      project: 'https://claude.ai/project/p', uploadsDir: path.join(__dirname, 'live', 'fixtures'), runsDir,
      today: '2026-10-12', chatUrlPattern: catalog.providers.claude.chatUrlPattern, snippetFor,
    });
    assert.equal(plan.since, '2026-09-01', 'research covers the time since this provider\'s previous day');
    assert.equal(plan.tasks[0].kind, 'research');
    assert.match(plan.tasks[0].prompt, /Claude chat product .* between 2026-09-01 and today/);
    assert.deepEqual(plan.tasks.filter((t) => t.kind === 'reexport').map((t) => t.featureId), ['claude.web-search']);
    const scn = plan.tasks.filter((t) => t.kind === 'scenario');
    assert.ok(!scn.some((t) => t.scenario === 'images'), 'image generation is not a Claude scenario');
    for (const t of [plan.tasks[0], ...scn]) {
      assert.match(t.exportSnippet, /screen/, `${t.featureId}: export without page inventory`);
      assert.deepEqual(t.extraExports.map((x) => x.tag), [`${t.featureId}#md`], `${t.featureId}: no second (.md) export`);
      assert.match(t.extraExports[0].snippet, /\\"mode\\":\\"md\\".*\\"inlineImages\\":true/);
    }
    const paste = scn.find((t) => t.scenario === 'reading').turns.find((t) => t.paste);
    assert.match(paste.pasteSnippet, /ClipboardEvent\('paste'/);
    assert.ok(paste.pasteSnippet.length > 10000, 'the long article is embedded in the paste snippet');
    const md = liveDay.renderDayPlan({ ...plan, createdAt: '2026-10-12T10:00:00Z' }, 'POLL');
    assert.match(md, /RESEARCH — start first/);
    assert.match(md, /Scenario `road-trip`/);

    // Official release notes: named in the research prompt and listed in the plan.
    const notes = plan.tasks[0].releaseNotes;
    assert.ok(notes.length >= 1 && notes.every((s) => /^https:\/\//.test(s.url) && s.title), 'claude has release-notes sources');
    for (const s of notes) assert.ok(plan.tasks[0].prompt.includes(s.url), `research prompt names ${s.url}`);
    for (const p of ['chatgpt', 'gemini']) assert.ok((scenarios.research.releaseNotes[p] || []).length, `${p} has release-notes sources`);
    const fetched = [{ ...notes[0], file: 'tests/live/runs/x/release-notes/1-a.txt' }, { title: 'B', url: 'https://b.example/notes', nothingNew: 'no entries since 2026-09-01' }, { title: 'C', url: 'https://c.example/notes', error: 'HTTP 403' }];
    const md2 = liveDay.renderDayPlan({ ...plan, createdAt: '2026-10-12T10:00:00Z', tasks: [{ ...plan.tasks[0], releaseNotes: fetched }] }, 'POLL');
    assert.match(md2, /Official release notes/);
    assert.match(md2, /downloaded: `tests\/live\/runs\/x\/release-notes\/1-a\.txt`/);
    assert.match(md2, /nothing new: no entries since 2026-09-01/);
    assert.match(md2, /not downloaded \(HTTP 403\) — open it in a new Chrome tab/);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

/** Release-notes pages: plain text, entries since the previous day only. */
test('live day: release notes since the previous day', () => {
  const { htmlToText, sinceSlice } = require('../tools/live-day');
  const text = htmlToText([
    '<html><head><style>.x{}</style><script>var a = "October 1, 2026";</script></head><body>',
    '<nav>Release notes &amp; updates</nav>',
    '<h2>October 30, 2026</h2><p>Maps in replies&nbsp;now show photos. Offer valid until December 31, 2026.</p>',
    '<h3>v4.29.0 2026-10-27</h3><p>Fixed charts.<br>Works since September 2, 2026 for some users.</p>',
    '<h2>2026.10.13</h2><p>Skills in chat &#8212; rolling out.</p>',
    '<h2>October 9, 2026</h2><p>Older entry.</p>',
    '<h2>September 30, 2026</h2><p>Much older.</p>',
    '</body></html>',
  ].join(''));
  assert.ok(!/October 1, 2026|\.x\{\}/.test(text), 'scripts and styles are dropped');
  assert.match(text, /^Release notes & updates$/m);
  assert.match(text, /Skills in chat — rolling out\./);

  const s = sinceSlice(text, '2026-10-12', { today: '2026-11-04' });
  assert.equal(s.newest, '2026-10-30', 'a future date inside an entry is not an entry date');
  assert.match(s.text, /Maps in replies/);
  assert.match(s.text, /Works since September 2, 2026/, 'an older date inside an entry does not cut it');
  assert.match(s.text, /Skills in chat/);
  assert.ok(!/Older entry|Much older/.test(s.text), 'entries before the previous day are cut');

  assert.deepEqual(sinceSlice(text, '2026-11-01', { today: '2026-11-04' }), { text: '', dated: true, newest: '2026-10-30' });
  const undated = sinceSlice('Some page\nwithout any dates', '2026-10-12');
  assert.equal(undated.dated, false);
  assert.match(undated.text, /without any dates/);
});

/** Page inventory vs export: lost text, pictures and links are errors. */
test('live day: what the page showed vs the export', () => {
  const { compareScreen, completeness } = require('../tools/live-day');
  const exp = {
    md: [
      '## Assistant', '',
      'Arches National Park needs at least half a day, more with kids in the August heat.',
      '([NPS](https://www.nps.gov/arch/index.htm "Arches"))', '',
      '[![Delicate Arch](https://img.example.com/arch.jpg)](https://example.com/arch)', '',
    ].join('\n'),
    files: new Map(),
  };
  const screen = {
    text: [
      'Arches National Park needs at least half a day, more with kids in the August heat.',
      'Copy', 'Share',
      'Moab hotels in mid-August usually cost between 180 and 260 dollars per night for a family room.',
    ].join('\n'),
    images: [
      { src: 'https://img.example.com/arch.jpg' },
      { src: 'https://img.example.com/canyonlands.jpg' },
    ],
    links: ['https://www.nps.gov/arch/index.htm?utm_source=chatgpt.com', 'https://chatgpt.com/c/abc', 'https://booking.example.com/moab'],
    counts: { codeBlocks: 0, tables: 0 },
  };
  const r = compareScreen(screen, exp);
  assert.deepEqual(r.missingText, ['Moab hotels in mid-August usually cost between 180 and 260 dollars per night for a family room.']);
  assert.deepEqual(r.missingImages, ['https://img.example.com/canyonlands.jpg']);
  assert.deepEqual(r.missingLinks, ['https://booking.example.com/moab'], 'utm-tagged and provider links are not losses');
  assert.equal(r.errors.length, 3);

  const all = compareScreen({ ...screen, text: screen.text.split('\n')[0], images: screen.images.slice(0, 1), links: screen.links.slice(0, 2) }, exp);
  assert.deepEqual(all.errors, []);

  // Claude's collapsed tool-step summary is UI, not lost text.
  const statusRow = compareScreen({ ...screen, images: [], links: [], text: [
    screen.text.split('\n')[0],
    'Використано «Claude Docs: Guide», додано завдання: Create the 13-day plan as an editable doc, а також ще 2 кроки',
    'Створив файл, поділився файлом і ще 19 кроків',
    'Searched the web, read three pages, created a file and 4 more steps',
  ].join('\n') }, exp);
  assert.deepEqual(statusRow.missingText, []);
  assert.deepEqual(statusRow.errors, []);

  const { checkCapabilities } = require('../tools/live-day');
  const docsSeen = (link) => checkCapabilities(['out.docs-artifact'], 'claude', [], { md: `🧩 [Plan.md](#artifact-docs-x) · [online](${link})` }, '', '')[0].seen;
  assert.equal(docsSeen('https://claude.ai/code/artifact/31630647-699c-4191-95b1-593d3d8cb02c'), true);
  assert.equal(docsSeen('https://claude.ai/artifact/76iLSb19bAnGUE1iMzf571'), true, 'short viewer link since 2026-11');
  assert.equal(docsSeen('https://example.com/artifact/x'), false);

  const har = (status) => ({ entries: [{ request: { url: 'https://chatgpt.com/backend-api/conversation/00000000-0000-0000-0000-000000000001' }, response: { content: { text: JSON.stringify({ current_node: 'm', mapping: { m: { message: { status } } } }) } } }] });
  assert.deepEqual(completeness('chatgpt', har('finished_successfully')), { complete: true });
  assert.equal(completeness('chatgpt', har('in_progress')).complete, false);
  assert.equal(completeness('gemini', har('x')), null);
});

/** The export snippet's page inventory lands in the debug HAR. */
test('debug capture: keeps the page inventory sent with the export', async () => {
  const dir = path.join(SCENARIOS_DIR, 'examples', 'chatgpt-basic-text');
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const base = scenario.exports.find((e) => e.message.mode === 'md').message;
  const screen = { text: 'hello', images: [], links: [], counts: {} };
  const r = await executeExport(dir, scenario, { ...base, debugCapture: true, tag: 'x', screen }, { dev: true });
  assert.ok(r.response && r.response.ok);
  const har = JSON.parse(await r.captured.downloads[1].blob.text());
  assert.deepEqual(har.log._exporter.screen, screen);
});

/** Deep Research report (Apps SDK widget): citations become links plus a Sources list. */
test('chatgpt deep research: report keeps its sources', () => {
  const sandbox = {};
  sandbox.self = sandbox;
  const context = require('node:vm').createContext(sandbox);
  const loader = require('./scaffolding/loader');
  loader.loadScripts(context, loader.SCRIPTS_BY_ADAPTER.chatgpt.filter((s) => !/content\.js$/.test(s)));
  const { chatgptNormalize } = sandbox.__exporter;
  const cite = (n) => `citeturn0search${n}`;
  const source = (n, extra = {}) => ({ url: `https://example.com/p${n}?utm_source=chatgpt.com`, title: `Page ${n}`, attribution: `Site${n}`, ...extra });
  const report = {
    status: 'completed',
    plan: { title: 'Trends' },
    report_message: {
      content: { content_type: 'text', parts: [`# Trends\n\nA claim ${cite(1)}. Another ${cite(2)} and ${cite(3)}.`] },
      metadata: {
        content_references: [
          { matched_text: cite(1), items: [source(1)] },
          { matched_text: cite(2), items: [source(2, { supporting_websites: [source(3)] })] },
          { matched_text: cite(3), items: [source(1), source(3)] },
        ],
      },
    },
  };
  const msg = (id, parent, message) => ({ id, parent, children: [], message: { id, ...message } });
  const raw = {
    conversation_id: 'c1', title: 'Research', current_node: 't', create_time: 1, update_time: 2,
    mapping: {
      root: { id: 'root', parent: null, children: ['u'], message: null },
      u: msg('u', 'root', { author: { role: 'user' }, create_time: 1, status: 'finished_successfully', content: { content_type: 'text', parts: ['Research it'] }, metadata: {} }),
      t: msg('t', 'u', {
        author: { role: 'tool', name: 'api_tool.call_tool' }, create_time: 2, status: 'finished_successfully',
        content: { content_type: 'text', parts: [''] },
        metadata: { chatgpt_sdk: { widget_state: JSON.stringify(report), widget_session_id: 's1' } },
      }),
    },
  };
  raw.mapping.root.children = ['u'];
  raw.mapping.u.children = ['t'];
  const { conversation } = chatgptNormalize.normalize(raw, {});
  const content = conversation.artifacts[0].content;
  assert.match(content, /A claim \(\[Site1\]\(https:\/\/example\.com\/p1 "Page 1"\)\)\./);
  assert.match(content, /Another \(\[Site2\]\(https:\/\/example\.com\/p2 "Page 2"\), \[Site3\]\(https:\/\/example\.com\/p3 "Page 3"\)\)/);
  assert.doesNotMatch(content, /[-]/);
  assert.match(content, /\n## Sources\n\n1\. \[Page 1\]\(https:\/\/example\.com\/p1\)\n2\. \[Page 2\]\(https:\/\/example\.com\/p2\)\n3\. \[Page 3\]\(https:\/\/example\.com\/p3\)\n$/);

  // Live-test tooling: a research capability needs source links and a Sources list.
  const { checkCapabilities, completeness, compareScreen } = require('../tools/live-day');
  const seen = (text) => checkCapabilities(['out.research'], 'chatgpt', [], { md: '', files: new Map([['artifacts/r.md', Buffer.from(text)]]) }, '', '')[0].seen;
  assert.equal(seen(content), true);
  assert.equal(seen(content.replace(/\]\(https?:\/\/[^)]*\)/g, ']')), false, 'no links');
  assert.equal(seen('# R\n\n[a](https://x.io)'), false, 'no Sources list');

  // An empty, never finalized reply behind a finished image tool result is not "unfinished".
  const har = (nodes) => ({ entries: [{ request: { url: 'https://chatgpt.com/backend-api/conversation/00000000-0000-0000-0000-000000000001' }, response: { content: { text: JSON.stringify({ current_node: 'c', mapping: nodes }) } } }] });
  const done = (role) => ({ parent: null, message: { author: { role }, status: 'finished_successfully', content: { content_type: 'text', parts: ['x'] } } });
  const empty = { parent: 'b', message: { author: { role: 'assistant' }, status: 'in_progress', content: { content_type: 'text', parts: [''] } } };
  assert.deepEqual(completeness('chatgpt', har({ b: { ...done('tool'), parent: 'a' }, a: done('user'), c: empty })), { complete: true });
  assert.equal(completeness('chatgpt', har({ b: { ...done('assistant'), parent: 'a' }, a: done('user'), c: empty })).complete, false, 'no tool result before it');
  const typing = { ...empty, message: { ...empty.message, content: { content_type: 'text', parts: ['Half a sent'] } } };
  assert.equal(completeness('chatgpt', har({ b: { ...done('tool'), parent: 'a' }, a: done('user'), c: typing })).complete, false, 'real text');

  // Business logos beside places are decorative.
  const logo = 'https://persistent.oaistatic.com/chatgpt/clients/business-logos/abc.png';
  const shot = compareScreen({ text: '', images: [{ src: logo }], links: [], counts: {} }, { md: '', files: new Map() });
  assert.deepEqual(shot.errors, []);
  assert.equal(shot.images.screen, 0);
});
