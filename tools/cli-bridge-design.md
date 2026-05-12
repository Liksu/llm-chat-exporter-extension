# CLI + Extension Architecture — Design Sketch

Status: **deferred**. Idea captured for later; do not implement now.

## Why

Today the extension is the only way to export. A CLI would unlock:

- Scripting: `cron`-driven archival of conversations.
- Pipeline integration: export → process → push to Obsidian / Notion.
- Batch operations: "export all 100+ of my chats to disk" in a few
  minutes of background work, not an evening of clicking.

Three "obvious" CLI approaches were considered and rejected:

1. **Pure CLI talking directly to the chat API.** Killed by auth: none
   of Claude.ai / ChatGPT / Gemini expose OAuth for conversation
   history. The API-key products they sell talk to different endpoints
   with no access to web-chat data.
2. **Playwright spawning a headed Chromium.** Works, but ships 200 MB
   of browser, manages a separate profile, reimplements the
   auth-capture the extension already does well. Saved as a possible
   future path for users without our extension.
3. **OAuth desktop loopback flow** (`gh`, `gcloud`, `aws sso` pattern).
   The gold standard — but providers don't grant OAuth scope to web
   chat data, so impossible.

## The shape

```
┌─────────────────────────────────────────────────────────────────────┐
│  Library — pure JS, takes (adapter, convId, auth, options) → file   │
│  Lives in src/lib/ inside the extension's installed directory.      │
│  No Chrome APIs, no DOM. Just fetch + transform.                    │
└────────▲────────────────────────▲──────────────────────▲────────────┘
         │ loaded by              │ loaded by            │ loaded by
         │                        │                      │
┌────────┴─────────┐    ┌─────────┴──────────┐   ┌───────┴─────────┐
│  Extension       │    │  CLI (Node)        │   │  Future clients │
│                  │    │                    │   │  (Electron,     │
│  Chrome wrapper: │    │  Filesystem wrapper│   │   bookmarklets, │
│  - popup / opts  │    │  - reads ids list  │   │   server jobs,  │
│  - hook scripts  │    │  - parallel limit  │   │   etc.)         │
│  - settings store│    │  - writes files    │   │                 │
│  - chrome.downl. │    │  - one-time auth   │   │  Bring your own │
│  - (NEW) handoff │    │    handoff via     │   │  auth and fetch,│
│    endpoint for  │    │    extension       │   │  reuse same lib │
│    sharing auth  │    │                    │   │                 │
│    with CLI      │    │  Locates ext dir,  │   │                 │
│                  │    │  imports lib from  │   │                 │
│  Uses lib for    │    │  there. Runs lib   │   │                 │
│  popup-Export.   │    │  in Node process.  │   │                 │
└──────────────────┘    └────────────────────┘   └─────────────────┘
```

Three independent units, one shared piece of code.

## The premise

CLI cannot operate without the extension — extension is the only path
to capturing auth from web sessions. **Since the extension must be
installed anyway, the library code is already on disk** in Chrome's
extension directory. CLI doesn't need to ship a duplicate copy via
npm; it locates the extension on disk and loads the library from there
at runtime.

Benefits:
- **No code duplication.** Library lives in one place.
- **No version skew.** Chrome auto-updates the extension; CLI sees the
  new code the next time it runs.
- **Small CLI binary.** The npm package for the CLI is ~200 lines of
  glue. No adapter logic, no fetch logic, no normalize/render code.

## Library contract

```js
import { exportConversation } from '<ext-dir>/src/lib/export.js';

const { filename, bytes, mime } = await exportConversation({
  adapter: 'chatgpt',           // 'claude' | 'chatgpt' | 'gemini'
  convId: 'abc123',
  auth: {
    // shape varies per adapter
    bearerToken: 'eyJ...',      // ChatGPT
    // or
    cookies: 'sessionKey=...; ', // Claude
    orgId: 'xyz',
    // or
    atToken: '...',             // Gemini
    cookies: '...',
    userScope: 'u/0',
  },
  options: {
    mode: 'md' | 'zip',
    includeReasoning, includeDates, dateFormat,
    inlineImages, inlineTextFiles, attachmentsAsMarkdown,
  },
  fetch: globalThis.fetch,      // optional override
});
```

Caller is responsible for:
- Providing valid auth.
- Writing `bytes` to wherever it wants.
- Catching errors (network, auth expired, conv not found).

Library is responsible for:
- HTTP requests with the supplied auth.
- Normalizing the response.
- Rendering to markdown or building zip.
- Fetching binary attachments (images, files) using the same auth.
- Returning everything in memory.

The library NEVER touches chrome.\*, the DOM, the filesystem, or
chrome.storage. It is pure transformation given inputs.

## Fetch and environment differences

The library uses standard `fetch` — global in Node 18+ and in Chrome
extension contexts. Most things work identically: headers, bodies,
streaming, redirects, `response.arrayBuffer()` for binary downloads.
But there's one real asymmetry the library has to handle: **cookies**.

### The cookie problem

In Chrome (content script or service worker), the `Cookie` header is a
"forbidden header name" per the Fetch spec — you can't set it
explicitly. Cookies are attached implicitly by the browser based on
the request URL and the `credentials` option, drawing from Chrome's
cookie store where the user is already logged in.

In Node, the opposite: no implicit cookie jar. To send cookies, you
MUST set the `Cookie` header explicitly. No restriction.

This means a single fetch call can't be written identically for both
environments when the adapter relies on cookie auth. Claude uses
session cookies. Gemini uses cookies in addition to its `at` token.
ChatGPT uses bearer in `Authorization:` and works the same everywhere.

### The library's strategy

One small environment branch inside each adapter's `api.js`:

```js
const isExtension = typeof chrome !== 'undefined' && chrome.runtime?.id;

const headers = {};
if (auth.bearerToken) {
  headers['Authorization'] = `Bearer ${auth.bearerToken}`;
}
if (!isExtension && auth.cookies) {
  // Node: explicit Cookie header
  headers['Cookie'] = auth.cookies;
}
// Extension: browser attaches cookies implicitly when credentials='include'

return fetchImpl(url, {
  method,
  headers,
  body,
  credentials: isExtension ? 'include' : 'omit',  // Node ignores credentials
});
```

This works because the premise differs by environment:

- **In Chrome extension**, the user is logged into the provider's site
  in this very browser. Cookies are in Chrome's cookie store. Implicit
  attachment with `credentials: 'include'` works as long as
  `host_permissions` covers the target URL.
- **In Node CLI**, the user got the cookies via the auth handoff (the
  extension captured them via `chrome.cookies.getAll()` and POSTed
  them to CLI). CLI hands them to the library as `auth.cookies` and
  the library sets them as a header.

### Library's fetch override

For testing, proxying, or custom HTTP clients (undici with cookie
jars, retry middleware, etc.), the library accepts an explicit `fetch`:

```js
await exportConversation({
  adapter, convId, auth, options,
  fetch: globalThis.fetch,  // default; override as needed
});
```

CLI never needs to override; it relies on Node 18+ global fetch.
Extension also relies on the platform's fetch. Override exists for
power-users and tests.

### What about response cookies?

The library doesn't process Set-Cookie. Refresh of expired tokens is
the **caller's** responsibility — when the library throws 401, the
caller (CLI) re-runs the auth handoff. Stateless library, simpler
design.

### Per-adapter summary

| Adapter | Auth in Chrome | Auth in Node | Asymmetric branch needed? |
|---|---|---|---|
| Claude  | implicit cookies + `credentials: 'include'` | explicit `Cookie:` header + orgId | yes |
| ChatGPT | bearer in `Authorization:` | bearer in `Authorization:` | no — same code both ways |
| Gemini  | implicit cookies + `at` in form body | explicit `Cookie:` + `at` in form body | yes (for cookies) |

### Other minor differences ignored on purpose

- CORS — irrelevant in Node, handled by `host_permissions` +
  `declarativeNetRequest` in extension. Library doesn't care either
  way.
- Forbidden headers beyond `Cookie` — none we use.
- Streaming responses — fetch in both environments supports
  `response.body` as a ReadableStream. We don't currently stream
  anywhere, but if needed, works in both.

### Node version requirement

CLI's `package.json` declares `"engines": { "node": ">=18" }`. Below
that, global `fetch` doesn't exist and a polyfill (`undici` or
`node-fetch`) would be required. Not worth supporting; Node 18 is
widely available.

## File layout

```
src/
├── lib/                              ← THE LIBRARY
│   ├── export.js                     → exportConversation()
│   ├── markdown.js                   ← render(conv, opts) → string
│   ├── zip.js                        ← build(conv, opts) → Uint8Array
│   ├── utils.js                      ← pure helpers (VERSION injected)
│   └── adapters/
│       ├── claude/
│       │   ├── api.js                → fetchConversation(auth, convId, fetch)
│       │   │                            fetchFile(auth, fileUuid, fetch)
│       │   └── normalize.js          ← raw JSON → NormalizedConversation
│       ├── chatgpt/{api,normalize}.js
│       └── gemini/{api,normalize}.js
│
├── background/                       ← Chrome service worker (orchestration only)
│   ├── service-worker.js
│   ├── cli-bridge.js                 → onMessageExternal handler for CLI
│   └── auth-store.js                 → save/load tokens in chrome.storage.session
│
├── adapters/{claude,chatgpt,gemini}/  ← Chrome-specific glue
│   ├── hook-main.js                  ← captures tokens, calls auth-store.save()
│   ├── hook-iso.js
│   └── content.js                    ← thin: get auth from page,
│                                       call lib/export.js, hand blob to popup
│
├── popup/, options/                  ← unchanged
└── icons/                            ← unchanged
```

Two key shifts compared to today:

1. **Pure pipeline modules (`api.js`, `normalize.js`, `markdown.js`,
   `zip.js`, `utils.js`) move from `src/core/` and
   `src/adapters/*/` into `src/lib/`.** They become explicit ESM
   exports instead of IIFE-on-global-self.
2. **`api.js` per adapter gets explicit auth parameters** instead of
   relying on browser-context implicit cookies and globally-captured
   tokens. The auth shape per adapter is documented; the extension's
   own popup-Export code passes auth scraped from the active page, the
   CLI passes auth received via handoff.

## How the extension loads the library

The library is pure ESM. The extension's manifest needs to be tweaked
so the same ESM modules are loadable in:

- **Background service worker** — already supports modules via
  `"background": { "service_worker": "...", "type": "module" }`.
- **Content scripts** — MV3 content scripts can't be modules directly,
  but they can use dynamic `import()` to pull in module code. So
  `content.js` (the orchestration glue) can do:

  ```js
  const lib = await import(chrome.runtime.getURL('lib/export.js'));
  const result = await lib.exportConversation({ adapter, convId, auth, options });
  ```

  Alternatively, a small esbuild step bundles the library into a single
  IIFE file for content scripts. Choice between "dynamic import in
  content script" (no build) and "esbuild bundle" (cleaner code) is a
  tactical call — try dynamic import first.

## How the CLI loads the library

CLI process is Node. Discovery + load steps:

```js
// 1. Locate the Chrome user data directory for the platform
const profileDir = (() => {
  if (process.platform === 'linux')  return `${HOME}/.config/google-chrome/Default`;
  if (process.platform === 'darwin') return `${HOME}/Library/Application Support/Google/Chrome/Default`;
  if (process.platform === 'win32')  return `${LOCALAPPDATA}\\Google\\Chrome\\User Data\\Default`;
})();

// 2. Locate the extension within that profile
const extId = process.env.LLM_EXPORTER_EXTENSION_ID ?? PUBLISHED_CWS_ID;
const versions = await readdir(`${profileDir}/Extensions/${extId}`);
const latest = pickHighestVersion(versions);  // e.g. "0.7.26_0"
const libDir = `${profileDir}/Extensions/${extId}/${latest}/src/lib`;

// 3. Import the library
const { exportConversation } = await import(`file://${libDir}/export.js`);

// 4. Use it
const result = await exportConversation({ adapter, convId, auth, options });
await writeFile(result.filename, result.bytes);
```

Edge cases the locator must handle:
- **Multiple Chrome profiles.** Probably search `Default` first, then
  numbered profiles, take the one that has the extension. Or accept a
  `--profile` flag.
- **Alternative browsers** (Brave, Edge, Vivaldi, Chromium) — same
  extension store layout, different root paths. Cover the common ones
  out of the box; allow overriding via `LLM_EXPORTER_PROFILE_DIR`.
- **Unpacked dev extensions** — these have a non-stable ID. For dev
  workflow, set `LLM_EXPORTER_LIB_PATH=/path/to/repo/src/lib` to skip
  discovery entirely.
- **Version directories** — Chrome unpacks to `<version>_<incremental>/`.
  Take the highest version.

## Auth handoff (the only thing the CLI needs the extension for at runtime)

Once CLI has auth, it operates autonomously. Auth comes from the
extension via a one-time handshake:

```
CLI:
  1. generate 32-byte random secret
  2. start localhost server on random port
  3. open default browser to http://localhost:<port>/handoff
     (this URL is served by CLI's own server)

Localhost page (served by CLI):
  4. JS does:
     chrome.runtime.sendMessage(EXTENSION_ID, {
       kind: 'cli-auth-handoff',
       adapter,
       callbackUrl: 'http://localhost:<port>/auth',
       secret,
     });

Extension service worker:
  5. validates sender.origin starts with http://localhost:
  6. shows a desktop notification or popup: "CLI requesting auth for
     <adapter>. Allow?"
  7. on approval, reads auth from chrome.storage.session (captured
     earlier by hook-main when user had a chat tab open)
  8. POSTs to callbackUrl with the secret header and auth body

CLI:
  9. validates secret on incoming POST
  10. stores auth in ~/.config/llm-export/<adapter>.json (mode 0600)
  11. shuts down server, prints "auth captured"
```

After this, CLI runs without involving the browser again — until the
stored auth expires (ChatGPT ~8h, Claude weeks, Gemini hours). On 401,
CLI prompts: `auth expired, run llm-export login chatgpt to refresh`.

## What the CLI actually is

A single Node entry point. Conceptual sketch:

```js
#!/usr/bin/env node
// llm-export

const cmd = process.argv[2];
if (cmd === 'login') {
  await runAuthHandoff(process.argv[3]);  // opens browser, gets token, saves
  return;
}

const adapter = cmd;
const ids = parseIdsFromArgv();  // [..."abc", "def", ...] or --all to fetch list
const auth = await loadAuthFromConfig(adapter);
const lib = await import(await locateLibrary());

const limit = pLimit(8);
await Promise.all(ids.map(id => limit(async () => {
  try {
    const { filename, bytes } = await lib.exportConversation({
      adapter, convId: id, auth, options: optionsFromArgvOrDefaults(),
    });
    await writeFile(filename, bytes);
    console.log(`✓ ${filename}`);
  } catch (err) {
    console.error(`✗ ${id}: ${err.message}`);
  }
})));
```

User flow:

```
$ npm install -g llm-export

$ llm-export login chatgpt
→ opening browser... authorize the request in the extension popup...
→ ✓ auth saved (expires ~2026-05-12 03:00)

$ llm-export chatgpt abc123 def456
→ ✓ Tech-Brief-2026-05-11.md
→ ✓ Resume-Builder-2026-05-08.md

$ llm-export chatgpt --all
→ fetching list... 247 conversations
→ [████████░░░░░░] 142/247
→ done. 247 files in ./exports/
```

`--all` requires the library to expose a `listConversations(auth)`
function per adapter — small addition, just hits the existing list
endpoint at the chat host.

## Auth visibility per adapter

The auth shape differs but the storage pattern is uniform: tokens get
stashed into `chrome.storage.session` by hook-main when a tab is open,
extension service worker hands them to CLI on request.

| Adapter  | Auth content | Lifetime | Notes |
|---|---|---|---|
| Claude   | session cookies + orgId | weeks | Cookies expire on logout / password change. CLI fetches with `Cookie:` header. |
| ChatGPT  | bearer token + cookies | ~8h | Bearer captured by hook-main. Refresh requires user-visited tab. |
| Gemini   | at-token + cookies + userScope | hours | `at` rotates per page load. May need extension to keep a sidecar tab open to refresh, or skip Gemini in v1. |

The CLI doesn't care about these details — it just gets back an `auth`
object and passes it to the library.

## Security

- **Auth in CLI's hands.** Stored in `~/.config/llm-export/<adapter>.json`,
  `0600` perms. Document that this file is as sensitive as the
  underlying browser session. Future: opt-in OS keychain via `keytar`.
- **Handoff secret.** 32-byte random per `login` invocation, validated
  both ways. Server times out after 60s.
- **Origin check** on extension side: `onMessageExternal` only accepts
  from `http://localhost:*`. `externally_connectable.matches` enforces
  this at the Chrome level too.
- **Explicit consent.** Extension shows a confirmation each time
  (with "remember this CLI for N hours" option). User declines → nothing
  happens.
- **Library is read-only at the disk level.** CLI just imports; doesn't
  write to the extension dir.

## Trade-offs

| | This design | Self-contained CLI (Playwright) |
|---|---|---|
| Code duplication | None | Full duplicate of adapter logic |
| Auto-updates | Free, via Chrome | Manual npm update |
| Disk footprint | Tiny CLI + existing extension | Tiny CLI + 200 MB Chromium |
| Works on headless server | No | Yes (after first auth) |
| Works without browser running | No (Chrome must be running for first auth; then yes for stored auth) | Yes |
| User must install | Extension (already had) + CLI | CLI only |

For users who already have the extension (every current user of this
project), the design here is strictly better. For users who want CLI
without the extension at all — separate v2 effort.

## Implementation phases

When picked up later:

1. **Refactor: move pipeline to `src/lib/` as ESM.** Make
   normalize/api/markdown/zip/utils into proper ES modules with explicit
   exports. Update extension's content scripts to dynamic-import them.
   Verify popup-Export still works end-to-end. **No new functionality;
   this is the prerequisite.**

2. **Add `chrome.storage.session` auth store.** Hook-main writes
   captured tokens there. Refactor existing content scripts to read
   from there as well (so behavior is unchanged from user's
   perspective).

3. **Add `cli-bridge.js`** in service worker. Handles
   `onMessageExternal` for `cli-auth-handoff`. Origin check, consent
   dialog, POSTs auth to localhost.

4. **Write CLI shim.** Single Node script. `login`, `<adapter> <ids...>`,
   `<adapter> --all`. Extension-dir locator. Auth storage.

5. **Polish UX.** Progress bars, error recovery, refresh-on-401,
   per-platform packaging.

Step 1 is a worthwhile refactor regardless of CLI — it isolates pure
code from Chrome-specific glue and makes both testable. Steps 2–5 only
make sense in sequence.

## What does NOT change

- Popup UI, options page, settings storage, per-adapter overrides.
- Behavior of the existing Export button — user notices nothing.
- The list of supported adapters / formats.
- Manifest is only modified to add `externally_connectable` for
  localhost and possibly `chrome.storage.session` permission.

## Future paths (NOT v1)

- **Playwright-based CLI** for users without our extension or for
  headless CI servers.
- **BYO-auth CLI mode** — paste a token, skip the handoff.
- **Standalone npm publish of the library** (`@llm-chat-exporter/core`)
  for third-party tools. Trivially extractable once `src/lib/` exists
  as a clean ESM module set.
- **Bookmarklet / userscript clients** — anything that can run JS and
  has auth can call into the same library.

---

When picking this up: start with Phase 1 (the `src/lib/` carve-out).
That alone makes the codebase cleaner and is independently useful even
if the CLI never ships.
