# LLM Chat Exporter

A Chrome extension that exports your conversations from **Claude** and **ChatGPT** to a single Markdown file or a ZIP archive — including images, pasted attachments, artifacts, and (optionally) the model's reasoning.

## Features

- **Two formats**
  - **Markdown** — a single `.md` file with images embedded as base64 data-URLs and binary attachments listed at the bottom.
  - **ZIP** — a clean folder structure (`assets/`, `files/`, `artifacts/`) with the Markdown referencing assets by relative path.
- **Supported platforms**
  - [claude.ai](https://claude.ai) — text, images, file uploads, artifacts, thinking blocks, tool calls.
  - [chatgpt.com](https://chatgpt.com) — text, images, file uploads, reasoning.
- **Configurable output**
  - Include or exclude the model's reasoning (thinking + tool calls).
  - Inline pasted text files (`.md`, `.txt`, `.json`, …) into the Markdown body, or keep them as separate attachments.
  - Render Markdown attachments inline (no code fence) so headings and lists keep their formatting.
- **No accounts, no servers** — all extraction happens locally in your browser.

## Install

### From the Chrome Web Store

*Coming soon.*

### From source (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the project root (the folder with `manifest.json`).
4. Pin the extension to the toolbar for quick access.

## Usage

1. Open a conversation on **claude.ai** or **chatgpt.com**.
2. Click the extension icon.
3. Pick **Markdown** or **ZIP**, toggle options if needed, and hit **Export**.
4. The file is saved through the browser's normal download flow.

The extension auto-detects which platform you're on. Defaults can be changed on the **Options** page (right-click the extension icon → *Options*, or the gear icon in the popup).

## Privacy

The extension reads conversation data **only on the active tab** and **only when you click Export**. Nothing is sent anywhere — there is no analytics, no telemetry, no remote server. The only storage used is `chrome.storage.sync` for your option preferences.

Required permissions:

| Permission | Why |
|---|---|
| `activeTab` | Read the current chat tab when you trigger an export. |
| `storage` | Persist your default-format and toggle preferences. |
| `host_permissions: claude.ai, chatgpt.com` | Run the content scripts that read conversation data. |

## Project layout

```
manifest.json
src/
  popup/        Popup UI (the dropdown when you click the icon)
  options/      Options page
  core/         Shared logic: Markdown rendering, ZIP packing, downloads
  adapters/
    claude/    Claude.ai-specific extraction & normalization
    chatgpt/   ChatGPT-specific extraction & normalization
  icons/
  vendor/      fflate (ZIP)
```

The two adapters produce a common **NormalizedConversation** shape that the shared `core/markdown.js` and `core/zip.js` consume.

## Development

No build step. Edit the source, then click the **Reload** button on `chrome://extensions` for the extension card.

To package a release ZIP for the store, zip the project root (excluding `.git`, the source PSD, and any local notes).

## Contributing

Issues and PRs are welcome. If you want to add support for another LLM (Gemini, Mistral, etc.), the cleanest path is adding a new adapter under `src/adapters/<name>/` that produces a `NormalizedConversation` — the rendering and ZIP layers are reusable.

## License

MIT
