# Live tests

Unit/golden tests (`npm test`) replay recorded API responses, so they never
notice a provider changing its API or shipping something new. Live tests
export **real chats** on claude.ai, chatgpt.com and Gemini every few weeks
and check what comes out.

```
scenarios.json       catalog v2: capabilities (input / output / dialog, per provider)
                     + multi-turn dialog scenarios + the research prompt
features.json        catalog v1: one chat per feature; its chats are re-exported
fixtures/            files the test chats upload (photos, PDF, md, csv, js)
TASK.md              instructions Claude Desktop follows for a provider day
../../tools/live.js  day (plan a provider day) · collect (evaluate it) · prepare (v1 run) · status
../../tools/live-day.js  page snippets, page-vs-export check, capability checks
```

Local and gitignored: `config.local.json` (your downloads folder),
`fixtures.local.json` (URLs of your test chats), `runs/` (plans, downloaded
exports, reports).

## Provider day (current)

A test window is three days in a row — Claude, ChatGPT, Gemini, one a day —
every 3–4 weeks, so no day burns through every provider's quota at once.

```bash
node tools/live.js day --provider claude   # → runs/<date>-claude/plan.md
node tools/live.js collect                 # after the browser part
```

The day, in `TASK.md` order:

1. **Research** in the provider's test project on its top model: "what's
   new in <provider> chats since the previous day", with prepared answers
   to its clarifying questions. Started first, collected last. Its report
   tests research export and feeds discovery: features it finds become
   capability candidates once a dialog shows them.
2. **Re-export** of the provider's known test chats (features.json) —
   free, catches API changes.
3. **Scenarios**: fresh multi-turn dialogs in the test project (no
   approval needed there), on the tier each scenario names. Each export
   carries an inventory of what the page showed (text, pictures, links,
   code blocks, tables); `collect` checks that all of it is in the export.
   A reply is waited for by the page (stop button gone, text stable), and
   `collect` checks from the exported data that it really was finished.

Statuses for scenarios: **BROKEN** (the page showed something the export
lost, or an audit error) · **PREMATURE** (exported before the reply
finished) · **EXPORT_FAILED** · **NOT_RUN** · **OK**. The report lists
which exercised capabilities left a trace in the export, and earlier
scenario chats you may delete (each day makes new ones; nothing is
deleted automatically).

## How a v1 run works

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
mostly re-export them. That is cheap and catches changes in the API
envelope (old chats come back in the new format), but not changes in
what the model *writes*: a message keeps the markup it was generated
with. ChatGPT's generative-UI components (`<Link/>`, `<Cite/>`, `<box>`)
only appeared in new answers. So features marked `"refresh": "each-run"`
(web search, text formatting, generative UI) get a fresh chat every run.
`--recreate <id>` / `--recreate-all` make fresh ones for the rest.

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

In Claude Desktop create three scheduled tasks on consecutive days of the
month (e.g. the 1st, 2nd and 3rd), working folder = this repo, prompt:

> Run the live test day of LLM Chat Exporter for provider `claude`
> (`chatgpt`, `gemini`): follow `tests/live/TASK.md` in this repo.

New chats in the test projects need no approval; you approve download
prompts and anything it proposes at the end (bug fixes, catalog edits,
accepting drift).

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
    "mdMatches": ["regex"], "mdNotMatches": ["regex"],
    "assistantMatches": ["regex"], "outputMatches": ["regex"]
  }
}
```

Every export is also audited (`tools/audit-export.js`): any audit error
fails the feature regardless of `expect`.

### Writing checks that test the feature

Live exports include reasoning, and its tool-call dumps repeat almost
everything (prompts, file contents tools wrote, search results). So:

- All text checks ignore reasoning (Thinking blocks, tool calls/results).
- `mdMatches` sees the user's turns too — use it for what the user
  brought (upload names, inlined file contents). `npm test` fails if an
  `mdMatches` regex matches the feature's own prompt or follow-ups.
- `assistantMatches` sees only the assistant's turns; `outputMatches`
  sees the assistant's turns plus `artifacts/` and `files/`.
- Prefer structure over text: `files: ">=1"` proves the upload is in the
  export, a filename match only proves it's mentioned.
- `collect` also runs every feature's checks on a plain chat of the same
  provider (`*.text-formatting`); if they all pass there too, the report
  marks the check as weak.
