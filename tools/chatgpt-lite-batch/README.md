# ChatGPT Lite Batch Export

One-off Bun script for exporting several ChatGPT conversations to Markdown without downloading images or attached files.

## Setup

1. Open `chatgpt.com` in the browser where you are logged in.
2. Copy a current `Authorization: Bearer ...` token from any `https://chatgpt.com/backend-api/...` request in DevTools Network.
3. Put conversation ids into `ids.txt`, one per line. Empty lines and `# comments` are ignored.

Conversation ids are the UUIDs from URLs like:

```text
https://chatgpt.com/c/00000000-0000-0000-0000-000000000000
```

You may paste either raw ids or full ChatGPT conversation URLs.

## Run

PowerShell:

```powershell
$env:CHATGPT_ACCESS_TOKEN = "paste-token-without-Bearer-prefix"
bun run tools/chatgpt-lite-batch/export-chatgpt-lite.ts tools/chatgpt-lite-batch/ids.txt
```

If ChatGPT returns `401`/`403` even with a fresh token, also copy the request's `Cookie` header:

```powershell
$env:CHATGPT_COOKIE = "__Secure-next-auth.session-token=...; ..."
```

Optional flags:

```powershell
bun run tools/chatgpt-lite-batch/export-chatgpt-lite.ts ids.txt --out exports --delay-ms 500 --include-reasoning
```

Output:

- One `.md` file per successful conversation.
- `_manifest.json` with per-id status.
- `_errors.json` when any id fails.

This script intentionally does not call ChatGPT file download endpoints. Images and files are rendered as lightweight placeholders or attachment metadata.

`bun run export-chatgpt-lite.ts ids.txt --delay-ms 500`