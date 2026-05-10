# Privacy Policy

**Extension:** LLM Chat Exporter
**Last updated:** 2026-05-10

## Summary

LLM Chat Exporter does not collect, transmit, sell, or share any personal data. All extraction happens locally in your browser. No analytics. No telemetry. No remote server.

## What the extension does

When you open the popup on a supported site ([claude.ai](https://claude.ai), [chatgpt.com](https://chatgpt.com), or [gemini.google.com](https://gemini.google.com)) and click **Export**, the extension reads the contents of the conversation in the active tab — text, images, file attachments, artifacts, and (optionally) reasoning — and assembles a Markdown file or a ZIP archive. The result is saved to your computer through Chrome's normal download flow.

The extension includes a small service worker that proxies asset downloads (uploaded files and inline / generated images) when those live on a different host than the chat page. This is purely a CORS workaround so the same bytes the page already displays can be embedded in the export — the bytes never leave your browser and are not transmitted to any third party.

## Data the extension accesses

| Data | Where it goes |
|---|---|
| Conversation content on the active tab | Used to build the export file. Never leaves your browser. |
| Your option preferences (default format, toggle states) | Stored in [`chrome.storage.sync`](https://developer.chrome.com/docs/extensions/reference/api/storage). Synced across your Chrome profile by Google if you have Chrome Sync enabled. |

The extension does not read tabs other than the active one, and does not access browsing history, cookies, passwords, or any data outside the supported sites.

## Permissions and why they are needed

| Permission | Purpose |
|---|---|
| `activeTab` | Read the current chat tab when you click Export. |
| `storage` | Remember your default-format and toggle preferences. |
| `declarativeNetRequestWithHostAccess` | Rewrite CORS response headers on requests to Google's asset CDNs so the extension can read Gemini's inline images and file uploads. The rule is scoped to the asset hosts listed below and only modifies `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`; no request URLs are changed and no traffic is redirected. |
| Host access to `claude.ai`, `chatgpt.com`, and `gemini.google.com` | Run the content scripts that extract the conversation. |
| Host access to `*.googleusercontent.com`, `*.usercontent.google.com`, and `lh1.google.com`–`lh7.google.com` | Fetch Gemini-attached files and inline / generated images. The extension's service worker downloads these via the user's existing Google session — same files the browser already loads when displaying the chat. |

## Third parties

None. The extension makes no network requests of its own. It does not contact any analytics, advertising, or telemetry service.

The only network activity that may occur is when the extension fetches images and file attachments already shown in your conversation, so it can embed them into the export. Those requests go to the LLM provider's own servers (Anthropic for Claude, OpenAI for ChatGPT, and Google's asset CDNs for Gemini) — the same ones your browser already loads when displaying the chat.

## Data retention and deletion

There is no remote storage to retain or delete. To clear your local preferences, uninstall the extension or reset its storage from `chrome://extensions`.

## Children

The extension is not directed at children under 13 and does not knowingly collect any personal information.

## Changes to this policy

If the extension's behavior ever changes in a way that affects this policy, the policy will be updated and the date at the top will change. Material changes will also be reflected in the Chrome Web Store listing.

## Contact

For questions or bug reports, please open an issue on the project's GitHub repository.
