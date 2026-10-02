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
