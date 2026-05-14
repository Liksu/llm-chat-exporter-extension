/**
 * Boot a "browser-like" vm context and load extension content scripts into it,
 * the same way Chrome does on a real page. The scripts use `self.__exporter.*`
 * namespacing under an IIFE — we set up `self` (== context globalThis) before
 * loading, and after loading we can read out api/normalize/markdown/zip/etc.
 *
 * What's emulated:
 *   - self / window / globalThis (all === the vm context object)
 *   - document with a minimal title + event-target shape (CustomEvent dispatch)
 *   - chrome.runtime.onMessage (so content.js can register its handler)
 *   - location  (URL instance — adapters parse convId out of href)
 *   - fetch (mock supplied by caller; otherwise throws on first call)
 *   - Date frozen to a fixed timestamp (so todayStamp() and metadata.exportedAt
 *     are deterministic)
 *   - download.triggerDownload override that captures (blob, filename) instead
 *     of touching the (non-existent) DOM
 *
 * What's NOT emulated:
 *   - popup.js / options.js — only content scripts run.
 *   - hook-iso.js / hook-main.js — page-world token capture. Tests inject the
 *     captured token directly into `self.__exporterChatGPT.token` etc.
 *   - declarativeNetRequest rules — they're enforced by the browser, not by
 *     extension code, so there's nothing here to exercise.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Content-script ordering per adapter. Mirrors manifest.json's
 * content_scripts entries (the document_idle batch — we skip document_start
 * hooks since tests bypass token capture by direct injection).
 */
const SCRIPTS_BY_ADAPTER = {
  chatgpt: [
    'src/vendor/fflate.min.js',
    'src/core/utils.js',
    'src/core/fetch-binary.js',
    'src/core/markdown.js',
    'src/core/zip.js',
    'src/core/download.js',
    'src/adapters/chatgpt/api.js',
    'src/adapters/chatgpt/normalize.js',
    'src/adapters/chatgpt/content.js',
  ],
  claude: [
    'src/vendor/fflate.min.js',
    'src/core/utils.js',
    'src/core/fetch-binary.js',
    'src/core/markdown.js',
    'src/core/zip.js',
    'src/core/download.js',
    'src/adapters/claude/api.js',
    'src/adapters/claude/normalize.js',
    'src/adapters/claude/content.js',
  ],
  gemini: [
    'src/vendor/fflate.min.js',
    'src/core/utils.js',
    'src/core/fetch-binary.js',
    'src/core/markdown.js',
    'src/core/zip.js',
    'src/core/download.js',
    'src/adapters/gemini/api.js',
    'src/adapters/gemini/normalize.js',
    'src/adapters/gemini/content.js',
  ],
};

/**
 * Minimal Event/CustomEvent shapes. Real DOM Event has more (composedPath,
 * stopPropagation, …) but content scripts never call those — they only
 * read `event.detail` from CustomEvent.
 */
function makeEventClasses() {
  class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
    }
  }
  class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init && 'detail' in init ? init.detail : null;
    }
  }
  return { Event, CustomEvent };
}

/**
 * EventTarget-ish object for `document` — addEventListener / removeEventListener /
 * dispatchEvent. Used by api.js to wait for token-capture CustomEvents.
 * In tests we don't actually fire those; the token is pre-seeded.
 */
function makeDocument(initialTitle) {
  const listeners = new Map();
  return {
    title: initialTitle || '',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    dispatchEvent(event) {
      const set = listeners.get(event.type);
      if (set) for (const fn of [...set]) fn(event);
      return true;
    },
    // Some adapters touch document.body for `download.triggerDownload`. We
    // override that function from outside the context to capture (blob,
    // filename) directly, but if any code path peeks at body we don't want
    // a TypeError.
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement() {
      return {
        href: '',
        download: '',
        click() {},
        remove() {},
        appendChild() {},
      };
    },
  };
}

/**
 * chrome.runtime.onMessage shim. Returns the listener registry so the test
 * driver can fire export messages into content.js.
 */
function makeChromeRuntime({ manifestVersion = '0.0.0-test' } = {}) {
  const messageListeners = [];
  const chrome = {
    runtime: {
      getManifest: () => ({ version: manifestVersion }),
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
        removeListener: (fn) => {
          const i = messageListeners.indexOf(fn);
          if (i >= 0) messageListeners.splice(i, 1);
        },
      },
      // Some content scripts call sendMessage to talk to the service worker.
      // We don't model the service worker; swallow.
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      sync: {
        get: (_keys, cb) => cb && cb({}),
        set: (_items, cb) => cb && cb(),
      },
    },
  };
  return { chrome, messageListeners };
}

/**
 * Construct a Date class whose zero-argument constructor and `now()` return
 * a fixed timestamp. Used so `todayStamp()`, metadata.exportedAt etc. land
 * on a stable string across runs. Other constructor signatures pass through
 * to the real Date — we still want `new Date('2024-01-01T...')` to parse.
 */
function makeFrozenDate(frozenIsoString) {
  const RealDate = Date;
  const frozenMs = new RealDate(frozenIsoString).getTime();
  if (Number.isNaN(frozenMs)) {
    throw new Error(`Invalid fakeDate: ${frozenIsoString}`);
  }
  function FrozenDate(...args) {
    if (!(this instanceof FrozenDate)) {
      // Date() called as function returns a string in standard JS — keep that.
      return new RealDate(frozenMs).toString();
    }
    if (args.length === 0) return new RealDate(frozenMs);
    return new RealDate(...args);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = () => frozenMs;
  FrozenDate.parse = RealDate.parse.bind(RealDate);
  FrozenDate.UTC = RealDate.UTC.bind(RealDate);
  return FrozenDate;
}

/**
 * Build a vm context that looks enough like a browser tab to run our
 * content scripts. Returns { context, sandbox, messageListeners, captured,
 * setAuth } — the test driver mutates `sandbox.self.__exporter` after load
 * and reads `captured` once the export completes.
 *
 * @param {{
 *   location: string,
 *   documentTitle?: string,
 *   fakeDate?: string,
 *   mockFetch?: (input: any, init?: any) => Promise<Response>,
 * }} opts
 */
function createBrowserContext(opts) {
  const { Event, CustomEvent } = makeEventClasses();
  const { chrome, messageListeners } = makeChromeRuntime();
  const captured = { blob: null, filename: null };

  // Resolve location: URL constructor with no base must get an absolute URL.
  const loc = new URL(opts.location);

  // Build the sandbox object that will become globalThis inside the vm.
  const sandbox = {
    // --- standard globals proxied from host process ---
    Promise: globalThis.Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    Math,
    JSON,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    ArrayBuffer,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    DataView,
    Buffer,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    Blob: globalThis.Blob,
    File: globalThis.File,
    Response: globalThis.Response,
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    structuredClone: globalThis.structuredClone,
    queueMicrotask: globalThis.queueMicrotask,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
    console,

    // --- browser-specific ---
    Event,
    CustomEvent,
    document: makeDocument(opts.documentTitle),
    location: loc,
    navigator: { userAgent: 'test-runner' },
    chrome,
    fetch: opts.mockFetch || (() => {
      throw new Error('fetch not mocked for this test');
    }),

    // --- frozen Date (override after sandbox is built) ---
    Date: opts.fakeDate ? makeFrozenDate(opts.fakeDate) : globalThis.Date,
  };

  // Self-reference: in browsers self === window === globalThis. The extension
  // namespacing uses `self.__exporter`; we make that the same object as the
  // vm's global so adapters can also read e.g. `globalThis.fflate`.
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  return { context, sandbox, messageListeners, captured };
}

/**
 * Load a list of script files into an existing vm context, in order. After
 * this returns, `sandbox.self.__exporter` is fully populated.
 */
function loadScripts(context, scriptPaths) {
  for (const rel of scriptPaths) {
    const full = path.join(REPO_ROOT, rel);
    const code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, context, { filename: full });
  }
}

/**
 * Install the download capture hook: replace exporter.download.triggerDownload
 * with a function that records (blob, filename) into the supplied object.
 * Must be called AFTER loadScripts (so exporter.download exists).
 */
function installDownloadCapture(sandbox, captured) {
  const exporter = sandbox.self.__exporter;
  if (!exporter || !exporter.download) {
    throw new Error('download module not loaded — call loadScripts first');
  }
  exporter.download.triggerDownload = (blob, filename) => {
    captured.blob = blob;
    captured.filename = filename;
  };
}

module.exports = {
  SCRIPTS_BY_ADAPTER,
  createBrowserContext,
  loadScripts,
  installDownloadCapture,
  REPO_ROOT,
};
