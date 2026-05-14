/**
 * Scenario runner. End-to-end: spins up a browser-like vm, loads the
 * adapter's content scripts, fires the export message, captures the
 * resulting Blob, and compares against goldens.
 *
 * scenario.json shape (see any tests/scenarios/examples scenario for a
 * working sample):
 *
 *   {
 *     "name": "human-readable",
 *     "adapter": "chatgpt" | "claude" | "gemini",
 *     "location": "https://chatgpt.com/c/UUID",        // browser URL
 *     "documentTitle": "...",                            // optional, Gemini
 *     "fakeDate": "2026-05-14T12:00:00Z",                 // freeze Date
 *     "host": "https://chatgpt.com",                      // default for mocks
 *     "auth": { "chatgpt-token": "mock-token" },          // seed token caches
 *     "mocks": [ ...routes ],                             // see fetch-mock.js
 *     "exports": [
 *       {
 *         "name": "default",
 *         "message": { "kind": "export", "mode": "md", ... },
 *         "expectedFilename": "Foo-2026-05-14.md",
 *         "expectedContent": "expected/default.md"        // file (md) or dir (zip)
 *       }
 *     ]
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const {
  SCRIPTS_BY_ADAPTER,
  createBrowserContext,
  loadScripts,
  installDownloadCapture,
} = require('./loader');
const { createMockFetch } = require('./fetch-mock');
const { compareFile, compareDir, isUpdating } = require('./compare');

const TESTS_ROOT = path.resolve(__dirname, '..');

/**
 * Walk scenarios directory and collect every scenario.json. A scenario is
 * any directory that contains a scenario.json file.
 */
function findScenarios(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const scenarioJson = path.join(full, 'scenario.json');
        if (fs.existsSync(scenarioJson)) {
          out.push({ dir: full, configPath: scenarioJson });
        } else {
          walk(full);
        }
      }
    }
  };
  walk(rootDir);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Seed adapter-specific token caches before content.js asks for them. The
 * real extension captures tokens via page-world hooks (hook-iso.js /
 * hook-main.js); in tests we sidestep that and inject what would have been
 * captured.
 */
function seedAuth(sandbox, auth) {
  if (!auth) return;
  if (auth['chatgpt-token']) {
    sandbox.self.__exporterChatGPT = { token: auth['chatgpt-token'] };
  }
  if (auth['gemini-at']) {
    sandbox.self.__exporterGemini = { at: auth['gemini-at'] };
  }
  // Claude uses cookie session — but our mock fetch doesn't honor cookies,
  // and the Claude content script's auth flow just calls fetch directly with
  // credentials:include. As long as mocks reply with valid bodies it works
  // without explicit token seeding.
}

/**
 * Decompress an in-memory zip Blob into a name→bytes map, using the same
 * fflate vendored in the extension. We reach into the vm sandbox to get it
 * (otherwise we'd need a second copy in test/).
 */
async function unzipBlob(blob, sandbox) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const fflate = sandbox.self.fflate;
  if (!fflate || !fflate.unzipSync) {
    throw new Error('fflate not available in sandbox — content scripts not loaded?');
  }
  return fflate.unzipSync(bytes);
}

/**
 * Fire a message into chrome.runtime.onMessage listeners and resolve with
 * whatever sendResponse(...) gets called with. Mirrors how popup.js talks
 * to content.js in the real extension.
 *
 * Listeners that return `true` are claiming an async response — we wait for
 * sendResponse. Listeners that return falsy either responded synchronously
 * or aren't handling this message.
 */
function dispatchMessage(messageListeners, message) {
  return new Promise((resolve, reject) => {
    let responded = false;
    const sendResponse = (resp) => {
      if (responded) return;
      responded = true;
      resolve(resp);
    };
    let claimedAsync = false;
    for (const listener of messageListeners) {
      const result = listener(message, { id: 'test' }, sendResponse);
      if (result === true) claimedAsync = true;
      if (responded) return; // sync response already arrived
    }
    if (!claimedAsync && !responded) {
      reject(new Error('No listener handled message and none returned true (async)'));
      return;
    }
    // Safety net so a stuck export doesn't hang the test runner forever.
    setTimeout(() => {
      if (!responded) {
        responded = true;
        reject(new Error('Export listener did not call sendResponse within 30s'));
      }
    }, 30_000).unref?.();
  });
}

/**
 * Run a single export from a scenario: set up context, fire message,
 * compare against goldens. Throws on failure (test runner catches).
 */
async function runExport(scenarioDir, scenario, exp) {
  const mockFetch = createMockFetch(scenarioDir, scenario);

  const browser = createBrowserContext({
    location: scenario.location,
    documentTitle: scenario.documentTitle,
    fakeDate: scenario.fakeDate,
    mockFetch,
  });

  // Seed token caches BEFORE content.js loads (some adapters synchronously
  // touch self.__exporter<Adapter>.token at module init).
  seedAuth(browser.sandbox, scenario.auth);

  const scripts = SCRIPTS_BY_ADAPTER[scenario.adapter];
  if (!scripts) {
    throw new Error(`Unknown adapter: ${scenario.adapter}`);
  }
  loadScripts(browser.context, scripts);
  installDownloadCapture(browser.sandbox, browser.captured);

  // Fire export.
  const response = await dispatchMessage(browser.messageListeners, exp.message);

  // The content script may report ok:false legitimately (eg "not on a chat
  // page" or "could not capture token"). If a scenario expects that, surface
  // the failure and let the golden compare cover the error message somehow
  // — but for now treat ok:false as a hard failure.
  if (!response || !response.ok) {
    throw new Error(
      `Export failed: ${response && response.error ? response.error : JSON.stringify(response)}`
    );
  }

  if (!browser.captured.blob) {
    throw new Error('Export reported ok but triggerDownload was never called');
  }

  // Filename check, if scenario specified one.
  if (exp.expectedFilename != null) {
    assert.strictEqual(
      browser.captured.filename,
      exp.expectedFilename,
      'Filename mismatch'
    );
  }

  // Content compare. Switch on export mode.
  const mode = exp.message && exp.message.mode === 'zip' ? 'zip' : 'md';
  const expectedPath = path.join(scenarioDir, exp.expectedContent);

  if (mode === 'zip') {
    const entries = await unzipBlob(browser.captured.blob, browser.sandbox);
    compareDir(entries, expectedPath);
  } else {
    const text = await browser.captured.blob.text();
    compareFile(text, expectedPath);
  }
}

module.exports = { findScenarios, runExport, TESTS_ROOT, isUpdating };
