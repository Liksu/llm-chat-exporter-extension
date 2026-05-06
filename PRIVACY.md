# Privacy Policy

**Extension:** LLM Chat Exporter
**Last updated:** 2026-05-06

## Summary

LLM Chat Exporter does not collect, transmit, sell, or share any personal data. All extraction happens locally in your browser. No analytics. No telemetry. No remote server.

## What the extension does

When you open the popup on a supported site ([claude.ai](https://claude.ai) or [chatgpt.com](https://chatgpt.com)) and click **Export**, the extension reads the contents of the conversation in the active tab — text, images, file attachments, artifacts, and (optionally) reasoning — and assembles a Markdown file or a ZIP archive. The result is saved to your computer through Chrome's normal download flow.

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
| Host access to `claude.ai` and `chatgpt.com` | Run the content scripts that extract the conversation. |

## Third parties

None. The extension makes no network requests of its own. It does not contact any analytics, advertising, or telemetry service.

The only network activity that may occur is when the extension fetches images already shown in your conversation (from the same domain) so it can embed them into the export. Those requests go to the LLM provider's own servers, just like the ones your browser already makes when displaying the chat.

## Data retention and deletion

There is no remote storage to retain or delete. To clear your local preferences, uninstall the extension or reset its storage from `chrome://extensions`.

## Children

The extension is not directed at children under 13 and does not knowingly collect any personal information.

## Changes to this policy

If the extension's behavior ever changes in a way that affects this policy, the policy will be updated and the date at the top will change. Material changes will also be reflected in the Chrome Web Store listing.

## Contact

For questions or bug reports, please open an issue on the project's GitHub repository.
