# Live tests

Unit/golden tests (`npm test`) replay recorded API responses, so they never
notice a provider changing its API or shipping something new. Live tests
export **real chats** on claude.ai, chatgpt.com and Gemini every few weeks
and check what comes out.

```
features.json        catalog: what to test, how to create it, what the export must contain
fixtures/            synthetic files the test chats upload (images, PDF, md, csv)
TASK.md              instructions Claude Desktop follows for a run
../../tools/live.js  prepare (plan a run) · collect (evaluate it) · status
```

Local and gitignored: `config.local.json` (your downloads folder),
`fixtures.local.json` (URLs of your test chats), `runs/` (plans, downloaded
exports, reports).

## How a run works

1. `npm run live:prepare` plans the run: known test chats are re-exported;
   features without a test chat get a "create" task with setup, uploads and
   prompt. Writes `runs/<date>/plan.md`.
2. Claude Desktop, driving your Chrome (Claude in Chrome), follows
   `TASK.md`: searches release notes for new chat features, creates /
   opens the chats, and exports each one with a page event
   (`llm-exporter:export`, tagged with the feature id, debug capture on).
3. `npm run live:collect` takes the tagged exports + `.debug.har` files
   out of your downloads folder and, per feature, runs the audit
   (`tools/audit-export.js`), the feature's `expect` checks, records a
   regression scenario into `tests/scenarios/local/live-<id>/` (so
   `npm test` covers it from now on), and checks API schema drift
   (`tools/schema-drift.js`). Report: `runs/<date>/report.md`.

Statuses: **BROKEN** (a `supported` feature fails) · **EXPORT_FAILED** ·
**GAP** (`unsupported`/`unknown` feature fails) · **NEWLY_WORKING** ·
**NOT_RUN** · **OK**.

The first run creates all test chats (one per feature, ~25); later runs
mostly re-export them — cheap, and enough to catch API changes, because
old chats come back in the new format too. `--recreate <id>` /
`--recreate-all` make fresh ones.

## One-time setup

1. **Unpacked dev build.** `chrome://extensions` → Developer mode → *Load
   unpacked* → this repo's root. (Remove/disable a Web Store copy if you
   have one.) After pulling new code, press reload on the extension card.
2. **Dev option.** Extension options → **Developer** → *Allow exports
   triggered from the page*. (Only unpacked installs have this section.)
3. **Downloads.** Check `config.local.json` → `downloadsDir` is where
   Chrome saves files. In Chrome's site settings allow *Automatic
   downloads* for claude.ai, chatgpt.com, gemini.google.com (each export
   is two files).
4. **Accounts.** Be signed in to all three in that Chrome profile. Code
   execution / file creation on claude.ai should be enabled.
5. **Test projects** (recommended). Keep test chats — and what the models
   remember from them — out of your own history: a Claude project, a
   ChatGPT project created with **Project-only memory** (can't be changed
   later), optionally a Gemini notebook. No instructions, no files in
   them. Put their URLs in `config.local.json`:

   ```json
   {
     "downloadsDir": "D:/Downloads",
     "projects": {
       "claude": "https://claude.ai/project/…",
       "chatgpt": "https://chatgpt.com/g/g-p-…/project",
       "gemini": "https://gemini.google.com/notebook/…"
     },
     "useProjectFor": ["claude", "chatgpt"]
   }
   ```

   New test chats for providers in `useProjectFor` start in the project.
   Features with `"context": "outside-project"` (the `*.text-formatting`
   ones) still use a regular chat, so both kinds stay covered;
   `"context": "project"` (`gemini.notebook-chat`) always uses it. Add
   `gemini` to `useProjectFor` once `gemini.notebook-chat` passes.
6. **Claude Desktop** with the Claude in Chrome extension connected, and
   access to this folder.

## Scheduling

In Claude Desktop create a scheduled task (e.g. every 2 weeks or monthly),
working folder = this repo, prompt:

> Run the live test of LLM Chat Exporter: follow
> `tests/live/TASK.md` in this repo. Ask me before creating new chats.

You approve the new-chat list, any download prompts, and anything it
proposes at the end (bug fixes, `features.json` edits, accepting drift).

## Manual use

```bash
npm run live:status                      # catalog coverage, last results
npm run live:prepare -- --only claude    # plan just one provider
npm run live:collect                     # evaluate the latest run
```

You can do the browser part yourself: open a chat and paste the task's
snippet from `plan.md` into DevTools console.

## Adding a feature

Add an entry to `features.json`:

```jsonc
{
  "id": "claude.something",          // provider.slug, stable: it tags exports
  "provider": "claude",
  "title": "One line",
  "support": "unknown",              // supported | unsupported | unknown
  "cost": "high",                    // optional: only with --include-expensive
  "automation": "manual",            // optional: never automated
  "context": "outside-project",      // optional: project | outside-project (default: per useProjectFor)
  "chatUrlPattern": "^https://…",    // optional: override the provider's chat URL pattern
  "setup": "Toggle X in the composer",
  "uploads": ["bar-chart.png"],      // from fixtures/
  "prompt": "What to send",
  "followUps": ["What to do after the reply"],
  "export": { "mode": "md" },        // optional overrides of defaults.export
  "expect": {
    "turns": ">=2", "images": "==2", "files": ">=1", "artifacts": ">=1",
    "reasoning": true,
    "mdMatches": ["regex"], "mdNotMatches": ["regex"]
  }
}
```

Every export is also audited (`tools/audit-export.js`): any audit error
fails the feature regardless of `expect`.
