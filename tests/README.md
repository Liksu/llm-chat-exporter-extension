# Tests

End-to-end regression tests for the LLM Chat Exporter extension.

Each test is a **scenario**: a raw API response (the JSON ChatGPT/Claude/Gemini
would return for a real chat) plus one or more expected export outputs. The
runner loads the actual content scripts in a vm sandbox, mocks `fetch` against
the scenario's recorded responses, fires an export message, captures the
resulting Blob, and compares it byte-for-byte against the goldens.

If anything in the pipeline regresses — adapter normalization, markdown
rendering, zip layout, filename generation — at least one golden mismatches
and the test fails with a diff.

## Running

```bash
npm test                                # compare against committed goldens
UPDATE_GOLDEN=1 npm run test:update     # rewrite goldens from current output
```

On Windows:

```cmd
set UPDATE_GOLDEN=1&& npm run test:update
```

```powershell
$env:UPDATE_GOLDEN=1; npm run test:update
```

The runner forces `TZ=UTC` internally so dates render the same regardless of
your machine's timezone.

After `UPDATE_GOLDEN=1`, **always `git diff` the result before committing** —
the variable rewrites the goldens unconditionally, including any genuine
regressions you didn't notice.

To add a new scenario from a real chat session, see
[**How to add a scenario**](#how-to-add-a-scenario) below — the recorder
turns a HAR file from your browser's Network tab into a working scenario
in one command.

## Layout

```
tests/
  README.md                    you are here
  test.js                      single discovery+runner; do not edit per-scenario
  scaffolding/                 plumbing — rarely touched
    loader.js                  builds the vm sandbox; loads content scripts
    fetch-mock.js              routes scenario.mocks[] against fetch calls
    compare.js                 golden compare + UPDATE_GOLDEN handling
    run-scenario.js            orchestrates one scenario end-to-end
  scenarios/
    examples/                  committed to the repo; synthetic data only
      chatgpt-basic-text/      one scenario per directory
    local/                     gitignored; put your real chats here
```

## What gets exercised

For each export variant the runner walks the full pipeline:

1. `chrome.runtime.onMessage` listener registration (content.js)
2. URL parsing → `convId` extraction
3. Token retrieval (short-circuited by `seedAuth` in the scenario)
4. `api.fetchConversation` against mocked routes
5. `normalize.normalize` for the adapter
6. Image/binary attachment fetching (also mocked) and inline-link rewriting
7. `markdown.render` or `zip.build`
8. `download.triggerDownload` (replaced with a capture stub)
9. `sendResponse({ok:true, filename})` returned to the message dispatch

Skipped intentionally:
- **popup.js / options.js** — UI layer, no business logic worth golden-testing
- **hook-iso.js / hook-main.js** — page-world token capture; tests pre-seed
  the token instead of running the real handshake
- **service-worker.js** — only declarative net-request rules; nothing to call

## How to add a scenario

Two paths: the **recorder** (HAR file → scenario directory, ~30 seconds)
or by hand (when you want to craft a synthetic scenario for `examples/`).
The recorder is the right tool 90% of the time.

### Option A: recorder (recommended)

#### 1. Capture the export as a HAR

1. Open the chat you want to record in your browser.
2. Open DevTools → **Network** tab.
3. (Optional but recommended) Right-click in the Network table → check
   **Preserve log** so navigations don't wipe entries.
4. Click the **Clear** button (Ctrl+L / ⌘+K in the Network panel) to drop
   pre-existing entries.
5. Click the LLM Chat Exporter icon → run the export. Wait for the file
   to download.
6. Right-click anywhere in the Network entry list → **Save all as HAR with
   content**. Pick a path; the file ends with `.har`.

The HAR contains every fetch the page made, including everything the
extension did, with response bodies inline (base64 for binaries).

#### 2. Run the recorder

```bash
node tools/record-from-har.js <input.har> tests/scenarios/local/<name>
```

Optional flags:

| Flag                  | Description |
|-----------------------|-------------|
| `--adapter <name>`    | Force adapter to `chatgpt`/`claude`/`gemini` (auto-detected from hosts otherwise). |
| `--location <url>`    | Override the URL the test pretends the tab is on. |
| `--name <label>`      | Human-readable scenario name. |
| `--fake-date <iso>`   | Date to freeze `Date.now()` to. Defaults to the first request's timestamp, rounded down to the hour. |
| `--force`             | Overwrite a non-empty output directory. |

The recorder writes:

```
<output-dir>/
  scenario.json        with mocks[] fully populated from the HAR
  responses/           one file per recorded route
```

It prints a summary including a list of **skipped non-extension hosts**
— analytics, fonts, page assets that landed on hosts not in our
`manifest.json` host_permissions. Skim that list; if you see a hostname
that *should* have been recorded, file a bug.

What the recorder does NOT auto-fill:

- `exports[].expectedFilename` — set after the first `UPDATE_GOLDEN=1`
  run, when you know what filename the extension actually produced.
- Additional export variants beyond the default md (zip mode,
  with-reasoning, etc) — add by hand to `exports[]`.

#### 3. Generate the goldens

```bash
UPDATE_GOLDEN=1 npm run test:update
```

The runner picks up your fresh scenario automatically (no registration
needed — it scans `tests/scenarios/**` for any directory with a
`scenario.json`).

Look at the generated `expected/` files. If they look right, lock them
in by running `npm test` — it should be green.

#### 4. Commit (if applicable)

Scenarios under `tests/scenarios/local/` are gitignored — they stay on
your machine. If you've crafted something synthetic and privacy-safe and
want to share it, move it to `tests/scenarios/examples/` and commit.

#### What the recorder handles automatically

- **Fetch cascade with retries** (eg. ChatGPT's META_PATHS that 404s
  before finding the right meta endpoint). Same URL hit multiple times
  with different query strings is recorded as separate routes; first 2xx
  wins for any duplicate `(method, url)` pair.
- **Binary responses** (PDFs, images). HAR encodes them as base64; the
  recorder decodes and writes raw bytes to `responses/<name>.<ext>`.
- **Adapter detection** by hostname (chatgpt.com → chatgpt, claude.ai →
  claude, gemini.google.com → gemini).
- **Location and document.title inference** from HAR page metadata
  + URL pattern recognition (eg. `/c/<UUID>` for ChatGPT).
- **Empty bodies** (HEAD, 204 No Content, redirect-only entries) are
  skipped — the extension never consumes them as data.

### Option B: by hand

For synthetic scenarios where you author the conversation JSON yourself.
Steps in order — about five minutes once you have your hand-written response
files ready.

#### 1. Pick a directory

```
tests/scenarios/examples/<adapter>-<short-description>/     # synthetic, committed
tests/scenarios/local/<adapter>-<short-description>/         # private, gitignored
```

#### 2. Author the response files

Drop one file per fetch the extension would make. The endpoints you'll
need to mock for each adapter:

- **ChatGPT**: `GET https://chatgpt.com/backend-api/conversation/<UUID>`
  for the conversation; plus `GET /backend-api/files/download/...` and
  `GET /backend-api/estuary/content?...` for attached images/files;
  plus `GET /backend-api/conversation/<UUID>/interpreter/download?...` for
  sandbox files.
- **Claude**: `GET https://claude.ai/api/organizations/<org>/chat_conversations/<uuid>?...`
- **Gemini**: `POST https://gemini.google.com/_/BardChatUi/data/batchexecute`
  with `rpcids=hNvQHb`; plus image/file URLs on `*.usercontent.google.com`,
  `*.googleusercontent.com`, `lh<N>.google.com`.

File names are arbitrary — they're referenced from `scenario.json`.

#### 3. Write `scenario.json`

```jsonc
{
  "name": "human-readable-label",
  "adapter": "chatgpt",            // "chatgpt" | "claude" | "gemini"
  "location": "https://chatgpt.com/c/<UUID>",  // value content.js sees in location.href
  "documentTitle": "",                          // optional; Gemini reads from document.title
  "fakeDate": "2026-05-14T12:00:00Z",           // freezes Date.now() and new Date()
  "host": "https://chatgpt.com",                // default origin for mocks below
  "auth": { "chatgpt-token": "mock-token" },    // see "Auth seeding" below

  "mocks": [
    {
      "method": "GET",
      "path": "/backend-api/conversation/<UUID>",
      "file": "conversation.json"
    },
    {
      "method": "GET",
      "pathRegex": "^/backend-api/files/download/file_[a-f0-9]+",
      "queryMatch": { "check_context_scopes_for_conversation_id": "<UUID>" },
      "file": "file-meta.json"
    },
    {
      "method": "GET",
      "path": "/backend-api/estuary/content",
      "queryMatch": { "id": "file_abc", "p": "fs" },
      "file": "file-bytes.bin",
      "contentType": "application/pdf"
    }
  ],

  "exports": [
    {
      "name": "md-default",
      "message": {
        "kind": "export",
        "mode": "md",
        "includeReasoning": false,
        "includeDates": false,
        "dateFormat": "iso-utc",
        "inlineImages": true,
        "inlineTextFiles": false,
        "attachmentsAsMarkdown": false
      },
      "expectedFilename": "Some Title-2026-05-14.md",
      "expectedContent": "expected/md-default.md"
    },
    {
      "name": "zip-default",
      "message": {
        "kind": "export",
        "mode": "zip",
        "includeReasoning": false,
        "includeDates": false,
        "dateFormat": "iso-utc",
        "inlineImages": false,
        "inlineTextFiles": false,
        "attachmentsAsMarkdown": false
      },
      "expectedFilename": "Some Title-2026-05-14.zip",
      "expectedContent": "expected/zip-default"
    }
  ]
}
```

#### 4. Generate the goldens

```bash
UPDATE_GOLDEN=1 npm run test:update
```

This runs every export and writes whatever came out into the path you named
in `expectedContent`. Open the files and verify they look right — at this
point you're effectively reviewing your own ground truth.

#### 5. Run the test for real

```bash
npm test
```

Should be green. From now on any regression in normalize / markdown / zip
will diff against these files.

#### 6. Commit

```bash
git add tests/scenarios/<your-scenario>/
```

If your scenario is in `local/` it's already gitignored, so commits only
include scenarios under `examples/`.

## scenario.json reference

### Top-level fields

| Field           | Required | Description |
|-----------------|----------|-------------|
| `name`          | no       | Display name in test output. Defaults to the directory path. |
| `adapter`       | yes      | `"chatgpt"`, `"claude"`, or `"gemini"`. Picks the content-script set to load. |
| `location`      | yes      | The URL the extension thinks the tab is on. Used by adapters to extract `convId`. |
| `documentTitle` | no       | What `document.title` evaluates to. Gemini reads chat title from there. |
| `fakeDate`      | no       | ISO date string. Freezes `Date.now()` and `new Date()` (no-arg form). Required if any export sets `includeDates: true` or if filenames depend on `todayStamp()`. |
| `host`          | no       | Default origin for mock routes that don't set their own `host`. |
| `auth`          | no       | Pre-seeded credentials (see below). |
| `mocks`         | yes      | Array of fetch routes (see below). |
| `exports`       | yes      | Array of export variants (see below). |

### Auth seeding

The real extension grabs tokens via page-world hooks that watch the SPA's
own network traffic. We sidestep that and inject the captured value
directly:

| Key                    | Effect |
|------------------------|--------|
| `auth.chatgpt-token`   | Sets `self.__exporterChatGPT.token` so `api.getAccessToken()` returns instantly. |
| `auth.gemini-at`       | Sets `self.__exporterGemini.at` for batchexecute calls. |

Claude uses cookie auth; the mock fetch doesn't honor cookies, so as long as
`/api/organizations/.../chat_conversations/...` is mocked, no seeding is
needed.

### Mock routes (`mocks[]`)

Each entry is one route. First match wins. Unmocked URLs throw with a
listing of all defined routes — silent fallthrough is intentional.

| Field         | Required | Description |
|---------------|----------|-------------|
| `method`      | no       | HTTP method. Default `"GET"`. Case-insensitive. |
| `host`        | no       | Override origin for this route. Defaults to scenario's `host`. |
| `path`        | one of   | Exact pathname match. |
| `pathRegex`   | one of   | Regex pattern matched against pathname. Either `path` or `pathRegex` must be set. |
| `queryMatch`  | no       | `{key: value}` — every key must appear in the URL's query with exactly that value. Extra query params don't break the match. |
| `file`        | yes      | Path under `<scenario>/responses/` to read response body from. |
| `contentType` | no       | `Content-Type` header. Default guessed from `file` extension. |
| `status`      | no       | HTTP status. Default `200`. |
| `headers`     | no       | Extra response headers `{name: value}`. |

### Export variants (`exports[]`)

| Field              | Required | Description |
|--------------------|----------|-------------|
| `name`             | no       | Sub-test name. Defaults to a stringified `message`. |
| `message`          | yes      | The `chrome.runtime.sendMessage` payload. Mode and options live here. |
| `expectedFilename` | no       | Asserted against `download.triggerDownload`'s filename arg. |
| `expectedContent`  | yes      | Path under scenario dir. For `mode:"md"` it's a single file; for `mode:"zip"` it's a directory representing the unzipped contents. |

### Export message reference

The `message` payload mirrors what `popup.js` sends in production:

```jsonc
{
  "kind": "export",
  "mode": "md" | "zip",
  "includeReasoning": false,
  "includeDates": false,
  "dateFormat": "iso-utc" | "iso" | "iso-offset" | "locale",
  "inlineImages": true,
  "inlineTextFiles": false,
  "attachmentsAsMarkdown": false
}
```

Use `"dateFormat": "iso-utc"` in tests — the other formats depend on local
timezone and are harder to keep deterministic.

## Debugging a failing scenario

### Unmocked URL

```
Error: mockFetch: no route matched GET https://chatgpt.com/backend-api/...
```

Add a route to `mocks[]`, or fix an existing one's `path`/`queryMatch` until
the runner finds it.

### Golden mismatch

`npm test` prints a unified diff. Read it:

- Small whitespace / formatting drift: probably an unintended renderer
  change. Inspect the code change.
- Wholesale content change: the adapter or normalizer changed semantics.
  If on purpose, regenerate with `UPDATE_GOLDEN=1` and review the diff.
- Filename mismatch: `fakeDate` not set, or title contains chars
  `sanitizeFilename` rewrites unexpectedly.

### "Export reported ok but triggerDownload was never called"

The export message reached content.js, normalize ran, but the flow exited
early. Usually a returned error path inside `handleExport`. Reproduce with
a `console.log` inside the relevant adapter's `content.js` (the vm sandbox
shares the host process's `console`).

### Date drift

If timestamps in metadata.json or message dates look wrong:
1. Confirm `fakeDate` is set in `scenario.json`.
2. Confirm `TZ=UTC` is in effect — the runner sets it but a host-shell
   override can clobber it.
3. Confirm `dateFormat` is `iso-utc` in the export options.

## Privacy

Anything under `tests/scenarios/local/` is gitignored. That's the only safe
place for real conversation data — your dumps contain user_profile content,
real usernames, and so on. Don't move them to `examples/` even after
manual cleanup unless you've audited every byte.

Scenarios under `examples/` should be hand-crafted synthetic data — invent
the conversation, write plausible API responses, commit. Treat them as
documentation of expected behaviors, not as anonymized real data.
