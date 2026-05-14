#!/usr/bin/env node
/**
 * Recorder: HAR file → test scenario directory.
 *
 * The browser already records every fetch the extension makes in its
 * DevTools Network panel. Save that as HAR ("Save all as HAR with content"
 * in the Network tab context menu) and this script turns it into a
 * test scenario that npm test will pick up.
 *
 * Usage:
 *   node tools/record-from-har.js <input.har> <output-scenario-dir> [options]
 *
 * Options:
 *   --adapter <chatgpt|claude|gemini>   pin adapter; auto-detected from
 *                                       request hosts if omitted.
 *   --location <url>                    set scenario.location (the URL the
 *                                       tab was on). Auto-detected from HAR
 *                                       page metadata when present.
 *   --name <label>                      human-readable scenario name.
 *   --fake-date <iso>                   freeze Date.now() to this time.
 *                                       Defaults to the first request time
 *                                       from the HAR, rounded down.
 *   --force                             overwrite output dir if it exists.
 *
 * Filtering policy:
 *   Every request whose host matches manifest.json host_permissions is
 *   recorded, regardless of path. We deliberately do not filter by path
 *   prefix — that would silently drop calls if the extension started
 *   hitting a new endpoint we didn't know about. Look at the printed
 *   summary for an "unexpected hosts" list and decide whether to clean up.
 *
 * Deduplication:
 *   The extension's file-fetch cascade may hit the same URL multiple times
 *   with different META_PATHS, getting 404s before a 200. We keep the
 *   first 2xx for any (method, url) pair; only if every attempt failed do
 *   we keep the last response (so the failure mode is at least preserved).
 *
 * Output:
 *   <scenario-dir>/
 *     scenario.json     with mocks[] filled in, exports[] left empty —
 *                       you write those by hand based on what your test
 *                       cares about.
 *     responses/<N>-<descriptive-name>.<ext>
 *
 *   Next step after recording:
 *     1. Edit scenario.json: fill in exports[] with the option variants
 *        you want goldens for.
 *     2. Run: UPDATE_GOLDEN=1 npm run test:update
 *     3. Review the generated expected/ files.
 *     4. Run: npm test (should pass against your own goldens).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// -- manifest helpers ---------------------------------------------------------

function loadManifestHosts() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8')
  );
  return (manifest.host_permissions || []).map((entry) => {
    // entry shapes:
    //   "https://claude.ai/*"           exact host
    //   "https://*.googleusercontent.com/*"  wildcard subdomain
    // Convert to a host-matcher function.
    const m = entry.match(/^https?:\/\/([^/]+)\//);
    if (!m) return () => false;
    const hostPattern = m[1];
    if (hostPattern.startsWith('*.')) {
      const suffix = hostPattern.slice(2);
      // matches `<anything>.<suffix>` AND bare `<suffix>`
      return (h) => h === suffix || h.endsWith('.' + suffix);
    }
    return (h) => h === hostPattern;
  });
}

function isManifestHost(host, matchers) {
  return matchers.some((m) => m(host));
}

// -- adapter inference --------------------------------------------------------

const ADAPTER_HOST_HINTS = {
  chatgpt: ['chatgpt.com'],
  claude: ['claude.ai'],
  gemini: ['gemini.google.com'],
};

function inferAdapter(hosts) {
  for (const [adapter, hints] of Object.entries(ADAPTER_HOST_HINTS)) {
    if (hints.some((hint) => hosts.has(hint))) return adapter;
  }
  return null;
}

// -- HAR parsing --------------------------------------------------------------

function parseHar(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let har;
  try {
    har = JSON.parse(raw);
  } catch (e) {
    throw new Error(`HAR file is not valid JSON: ${e.message}`);
  }
  if (!har.log || !Array.isArray(har.log.entries)) {
    throw new Error('HAR file missing log.entries[]');
  }
  return har;
}

/**
 * Decode a HAR entry's response body to a Buffer. HAR stores binary content
 * as base64 with `encoding: "base64"`; text content (JSON, HTML, etc) is
 * stored verbatim with no encoding field.
 *
 * Returns null when the response has no body (HEAD, 204, redirect-only).
 */
function decodeBody(content) {
  if (!content || content.text == null) return null;
  if (content.encoding === 'base64') {
    return Buffer.from(content.text, 'base64');
  }
  return Buffer.from(content.text, 'utf8');
}

/**
 * Derive a descriptive filename for a response file from its URL + mime.
 * Keeps the leading numeric prefix so files sort in chronological order.
 */
function deriveResponseFilename(index, url, mimeType) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `${pad3(index)}-unparseable.bin`;
  }
  // Last meaningful path segment(s).
  const segments = u.pathname.split('/').filter(Boolean);
  let base =
    segments.length === 0
      ? u.hostname
      : segments.slice(-2).join('-');
  // If query is the distinguishing bit, fold in a hint from it (eg `id=file_XXX`).
  for (const [k, v] of u.searchParams) {
    if (/^(id|file|name|sandbox_path)$/i.test(k) && v) {
      base += `-${v.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)}`;
      break;
    }
  }
  base = base.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'response';
  const ext = extFromMime(mimeType) || extFromUrl(u) || '.bin';
  // Avoid double extension if base already has one matching ext.
  const baseHasExt = /\.[a-zA-Z0-9]{1,5}$/.test(base);
  return `${pad3(index)}-${baseHasExt ? base : base + ext}`;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function extFromMime(mime) {
  if (!mime) return '';
  const m = mime.split(';')[0].trim().toLowerCase();
  const map = {
    'application/json': '.json',
    'text/json': '.json',
    'text/html': '.html',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/zip': '.zip',
    'application/octet-stream': '.bin',
  };
  return map[m] || '';
}

function extFromUrl(u) {
  const m = u.pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
  return m ? '.' + m[1].toLowerCase() : '';
}

// -- deduplication ------------------------------------------------------------

/**
 * Keep the most "useful" entry for each (method, url) pair. Useful means
 * 2xx if any; otherwise the last attempt (so the failure mode is preserved
 * in the recording).
 */
function dedupeEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.request.method} ${entry.request.url}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    const existingOk = existing.response.status >= 200 && existing.response.status < 300;
    const newOk = entry.response.status >= 200 && entry.response.status < 300;
    if (newOk && !existingOk) {
      byKey.set(key, entry);
    }
    // else: keep existing (first 2xx wins; otherwise the first failure)
  }
  return [...byKey.values()];
}

// -- route construction -------------------------------------------------------

/**
 * Build a route entry suitable for scenario.json mocks[].
 *
 * We always include exact `path` and put all query params under `queryMatch`
 * — the runner's match-first-wins semantics ensure the most specific route
 * gets picked. Users can simplify by hand later (collapse to pathRegex,
 * drop unnecessary queryMatch entries, etc).
 */
function buildRoute(entry, file) {
  const u = new URL(entry.request.url);
  const route = {
    method: entry.request.method,
    path: u.pathname,
    file,
  };
  const queryMatch = {};
  let hasQuery = false;
  for (const [k, v] of u.searchParams) {
    queryMatch[k] = v;
    hasQuery = true;
  }
  if (hasQuery) route.queryMatch = queryMatch;

  // host only if different from scenario's default host (filled in caller)
  route._host = u.origin;

  // mimetype: prefer Content-Type from response headers if present.
  const ctHeader = (entry.response.headers || []).find(
    (h) => h.name.toLowerCase() === 'content-type'
  );
  if (ctHeader) {
    const ct = ctHeader.value.split(';')[0].trim();
    if (ct) route.contentType = ct;
  } else if (entry.response.content && entry.response.content.mimeType) {
    route.contentType = entry.response.content.mimeType.split(';')[0].trim();
  }

  if (entry.response.status && entry.response.status !== 200) {
    route.status = entry.response.status;
  }

  return route;
}

// -- main ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter') args.adapter = argv[++i];
    else if (a === '--location') args.location = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--fake-date') args.fakeDate = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function printHelp() {
  // Just print the top-of-file doc comment between the first /** and */.
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/^\/\*\*([\s\S]*?)\*\//);
  if (m) {
    const cleaned = m[1]
      .split('\n')
      .map((l) => l.replace(/^ \* ?/, ''))
      .join('\n')
      .trim();
    console.log(cleaned);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (args.help || args.positional.length < 2) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const [harPath, outDir] = args.positional;

  if (!fs.existsSync(harPath)) {
    console.error(`HAR file not found: ${harPath}`);
    process.exit(1);
  }
  if (fs.existsSync(outDir) && !args.force) {
    const contents = fs.readdirSync(outDir);
    if (contents.length > 0) {
      console.error(
        `Output directory not empty: ${outDir}\n  Use --force to overwrite, or pick a fresh directory.`
      );
      process.exit(1);
    }
  }

  const har = parseHar(harPath);
  const hostMatchers = loadManifestHosts();

  // -- Filter to extension-relevant entries
  const allEntries = har.log.entries;
  const relevant = [];
  const skipped = []; // {host, count}
  const skippedCounts = new Map();
  for (const entry of allEntries) {
    if (!entry.request || !entry.response) continue;
    let u;
    try {
      u = new URL(entry.request.url);
    } catch {
      continue;
    }
    if (isManifestHost(u.hostname, hostMatchers)) {
      relevant.push(entry);
    } else {
      skippedCounts.set(u.hostname, (skippedCounts.get(u.hostname) || 0) + 1);
    }
  }
  for (const [host, count] of skippedCounts) {
    skipped.push({ host, count });
  }

  if (relevant.length === 0) {
    console.error(
      'No requests to extension-permitted hosts found in HAR.\n' +
        '  Check that the HAR was captured while the extension actually ran an export.'
    );
    process.exit(1);
  }

  // -- Dedup
  const deduped = dedupeEntries(relevant);

  // -- Adapter detection
  const presentHosts = new Set(deduped.map((e) => new URL(e.request.url).hostname));
  const adapter = args.adapter || inferAdapter(presentHosts);
  if (!adapter) {
    console.error(
      'Could not infer adapter from hosts: ' +
        [...presentHosts].join(', ') +
        '\n  Specify with --adapter chatgpt|claude|gemini.'
    );
    process.exit(1);
  }
  if (!['chatgpt', 'claude', 'gemini'].includes(adapter)) {
    console.error(`Unknown adapter: ${adapter}`);
    process.exit(1);
  }

  // -- Default host for scenario.json (most frequent primary host)
  const primaryHost =
    adapter === 'chatgpt'
      ? 'https://chatgpt.com'
      : adapter === 'claude'
      ? 'https://claude.ai'
      : 'https://gemini.google.com';

  // -- Build routes + response files
  fs.mkdirSync(path.join(outDir, 'responses'), { recursive: true });

  const routes = [];
  const usedFilenames = new Set();
  for (let i = 0; i < deduped.length; i++) {
    const entry = deduped[i];
    const body = decodeBody(entry.response.content);
    if (body == null) {
      // Empty body — skip. (HEAD, 204, redirect-only — extension never
      // consumes these as data.)
      continue;
    }
    const mime =
      entry.response.content && entry.response.content.mimeType
        ? entry.response.content.mimeType
        : '';
    let filename = deriveResponseFilename(i + 1, entry.request.url, mime);
    // Collisions: deriveResponseFilename embeds index in prefix, so collisions
    // shouldn't happen — but guard just in case.
    while (usedFilenames.has(filename)) filename = `dup-${filename}`;
    usedFilenames.add(filename);

    fs.writeFileSync(path.join(outDir, 'responses', filename), body);

    const route = buildRoute(entry, filename);
    // Strip _host if it's the scenario's default host (cleaner output).
    if (route._host === primaryHost) {
      delete route._host;
    } else {
      route.host = route._host;
      delete route._host;
    }
    routes.push(route);
  }

  // -- Page metadata for location/title hints
  let inferredLocation = '';
  let inferredTitle = '';
  if (Array.isArray(har.log.pages) && har.log.pages.length > 0) {
    inferredTitle = har.log.pages[0].title || '';
    // HAR doesn't directly store the page URL; use the first entry from that
    // page that lands on the primary host with no path or "/c/" path.
    for (const e of deduped) {
      const u = new URL(e.request.url);
      if (u.origin === primaryHost && /^\/[a-z]\/[0-9a-f-]{36}/i.test(u.pathname)) {
        inferredLocation = u.origin + u.pathname;
        break;
      }
    }
  }
  // ChatGPT specific fallback: first request to /backend-api/conversation/<id>
  // gives us the convId, so we can build the location from that.
  if (!inferredLocation && adapter === 'chatgpt') {
    for (const e of deduped) {
      const m = e.request.url.match(
        /^https:\/\/chatgpt\.com\/backend-api\/conversation\/([0-9a-f-]{36})/i
      );
      if (m) {
        inferredLocation = `https://chatgpt.com/c/${m[1]}`;
        break;
      }
    }
  }

  // -- fakeDate fallback: first request's startedDateTime, floored to the hour
  let fakeDate = args.fakeDate;
  if (!fakeDate && deduped[0] && deduped[0].startedDateTime) {
    const d = new Date(deduped[0].startedDateTime);
    if (!isNaN(d.getTime())) {
      d.setUTCMinutes(0, 0, 0);
      fakeDate = d.toISOString();
    }
  }
  if (!fakeDate) fakeDate = '2026-01-01T00:00:00Z';

  // -- auth stub
  const authKey =
    adapter === 'chatgpt'
      ? 'chatgpt-token'
      : adapter === 'gemini'
      ? 'gemini-at'
      : null;
  const auth = authKey ? { [authKey]: 'mock-token' } : {};

  // -- scenario.json
  const scenario = {
    name: args.name || path.basename(outDir),
    adapter,
    location: args.location || inferredLocation || `${primaryHost}/`,
    documentTitle: inferredTitle,
    fakeDate,
    host: primaryHost,
    auth,
    mocks: routes,
    // exports[] is a scaffold — one md variant with no expectedFilename
    // (so UPDATE_GOLDEN works straight away). Add zip / with-reasoning
    // variants by hand once you've reviewed the first golden, then set
    // expectedFilename to lock the filename format.
    exports: [
      {
        name: 'md-default',
        message: {
          kind: 'export',
          mode: 'md',
          includeReasoning: false,
          includeDates: false,
          dateFormat: 'iso-utc',
          inlineImages: true,
          inlineTextFiles: false,
          attachmentsAsMarkdown: false,
        },
        expectedContent: 'expected/md-default.md',
      },
    ],
  };
  fs.writeFileSync(
    path.join(outDir, 'scenario.json'),
    JSON.stringify(scenario, null, 2) + '\n'
  );

  // -- summary
  console.log(`Wrote scenario: ${outDir}`);
  console.log(`  Adapter: ${adapter}`);
  console.log(`  Routes recorded: ${routes.length}`);
  console.log(`  Responses dir: ${path.join(outDir, 'responses')}`);
  if (inferredLocation) console.log(`  Inferred location: ${inferredLocation}`);
  if (inferredTitle) console.log(`  Inferred page title: ${inferredTitle}`);
  console.log('');
  console.log('Skipped non-extension hosts:');
  if (skipped.length === 0) {
    console.log('  (none)');
  } else {
    for (const { host, count } of skipped.sort((a, b) => b.count - a.count)) {
      console.log(`  ${count.toString().padStart(4)}  ${host}`);
    }
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Open scenario.json and edit exports[]:');
  console.log('     - Set expectedFilename to the file the extension produced');
  console.log('     - Add more variants (zip mode, with-reasoning, etc) as needed');
  console.log('  2. UPDATE_GOLDEN=1 npm run test:update    # generate golden output');
  console.log('  3. Inspect expected/ files for correctness');
  console.log('  4. npm test                                # verify clean run');
}

main();
