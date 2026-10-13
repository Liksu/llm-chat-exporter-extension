/**
 * Live tests, provider day (tests/live/TASK.md): plans one provider's day
 * from tests/live/scenarios.json and checks scenario exports against what
 * the page showed. Used by tools/live.js (`day`, `collect`).
 *
 *   planDay(...)        research + re-exports + scenario dialogs → plan
 *   compareScreen(...)  page inventory (log._exporter.screen) vs export
 *   checkCapabilities() what the scenario exercised vs what the export has
 *   completeness(...)   was the last reply finished when it was exported?
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -- page snippets --------------------------------------------------------------

/**
 * Page-side selectors per provider. The page is the only signal that works
 * the same way everywhere (no extra API requests); if a selector stops
 * matching, STATUS says so instead of waiting forever.
 */
// No aria-labels: the UI language is the user's (uk, ru, en…). Checked on
// the live sites 2026-10-12.
const PAGE = {
  claude: {
    // the transcript (not the sidebar, header, composer or artifact panel)
    root: '[data-testid="transcript-list"]',
    turns: '[data-testid="user-message"], [data-testid="assistant-message"]',
    reply: '[data-testid="assistant-message"], [data-is-streaming]',
    streaming: '[data-is-streaming="true"]',
  },
  chatgpt: {
    root: null,
    turns: '[data-user-message-bubble], [data-talvt-turn-state], [data-message-author-role]',
    reply: '[data-talvt-turn-state], [data-message-author-role="assistant"]',
    streaming: '[data-talvt-turn-state]:not([data-talvt-turn-state="complete"]), [data-testid="stop-button"]',
  },
  gemini: {
    root: '#chat-history',
    turns: 'user-query, model-response',
    reply: 'model-response',
    // the composer's send button turns into a stop button while it writes
    streaming: 'mat-icon[fonticon="stop"], [aria-busy="true"]',
  },
};

/**
 * Is the last reply finished? Page only, no requests. Done = no stop
 * button and the last reply's text unchanged for >= 10 s (so it needs two
 * calls). Returns a JSON string.
 */
const statusSnippet = (provider) => `(() => {
  const sel = ${JSON.stringify(PAGE[provider])};
  const replies = document.querySelectorAll(sel.reply);
  if (!replies.length) return JSON.stringify({ done: null, why: 'no replies found on the page (selector ' + sel.reply + ')' });
  const len = (replies[replies.length - 1].innerText || '').length;
  const prev = window.__llmExporterStatus;
  const now = Date.now();
  window.__llmExporterStatus = { len, at: now, count: replies.length };
  if (document.querySelector(sel.streaming)) return JSON.stringify({ done: false, why: 'still writing (stop button)', len });
  if (!prev || prev.len !== len || prev.count !== replies.length) return JSON.stringify({ done: false, why: 'first check or text changed: check again in 20 s', len });
  if (now - prev.at < 10000) return JSON.stringify({ done: false, why: 'check again in 20 s', len });
  return JSON.stringify({ done: true, len });
})()`;

/**
 * What the page shows, collected right before the export: the visible
 * text, pictures (not icons/avatars), outbound links and a few element
 * counts. Runs in the page; the result rides along with the export
 * (log._exporter.screen in the debug HAR).
 */
const inventoryJs = (provider) => `const sel = ${JSON.stringify(PAGE[provider] || {})};
  // The conversation only: the provider's transcript element, else the
  // closest element holding every turn, else <main>.
  const lca = (els) => {
    if (!els.length) return null;
    let a = els[0];
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a;
  };
  const root = (sel.root && document.querySelector(sel.root)) ||
    (sel.turns && lca([...document.querySelectorAll(sel.turns)])) ||
    document.querySelector('main') || document.body;
  const big = (el) => { const r = el.getBoundingClientRect(); return Math.max(r.width, el.naturalWidth || 0) >= 64 && Math.max(r.height, el.naturalHeight || 0) >= 64; };
  // What a reader sees: without screen-reader-only hints ("Claude replied:",
  // keyboard help) and button labels (copy, retry, collapsed tool groups).
  const readText = (el) => {
    const hide = [...el.querySelectorAll('[class*="sr-only"], [class*="visually-hidden"], button, [role="button"]')];
    const prev = hide.map((h) => h.style.display);
    hide.forEach((h) => { h.style.display = 'none'; });
    try { return el.innerText || ''; } finally { hide.forEach((h, i) => { h.style.display = prev[i]; }); }
  };
  const screen = {
    url: location.href,
    at: new Date().toISOString(),
    text: readText(root).slice(0, 400000),
    images: [...root.querySelectorAll('img')].filter(big).map((i) => ({ src: (i.currentSrc || i.src || '').slice(0, 2000), alt: (i.alt || '').slice(0, 300) })).slice(0, 300),
    links: [...new Set([...root.querySelectorAll('a[href^="http"]')].map((a) => a.href))].slice(0, 1000),
    counts: {
      codeBlocks: root.querySelectorAll('pre').length,
      tables: root.querySelectorAll('table').length,
      iframes: root.querySelectorAll('iframe').length,
      canvases: root.querySelectorAll('canvas').length,
      bigSvgs: [...root.querySelectorAll('svg')].filter((s) => s.getBoundingClientRect().width >= 160).length,
    },
  };`;

/** Inventory + export (+ wait up to 30 s for the result, like snippetFor). */
const exportWithScreenSnippet = (detail, provider) => `(async () => {
  ${inventoryJs(provider)}
  const detail = Object.assign(${JSON.stringify(detail)}, { screen });
  const el = document.documentElement;
  delete el.dataset.llmExporterResult;
  window.dispatchEvent(new CustomEvent('llm-exporter:export', { detail: JSON.stringify(detail) }));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (el.dataset.llmExporterResult) return el.dataset.llmExporterResult;
  }
  return 'PENDING: export still running -- run the poll snippet';
})()`;

/**
 * Paste a text into the focused composer the way a user's Ctrl+V does: a
 * paste event with the text on its clipboardData, so the site can turn a
 * long paste into an attachment chip.
 */
const pasteSnippet = (text) => `(() => {
  const text = ${JSON.stringify(text)};
  const a = document.activeElement;
  const el = a && (a.isContentEditable || /^(TEXTAREA|INPUT)$/.test(a.tagName)) ? a
    : document.querySelector('[contenteditable="true"], textarea');
  if (!el) return 'NO_COMPOSER: click into the message box first';
  el.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented
    ? 'PASTED ' + text.length + ' chars (the page handled the paste: check for an attachment chip or the text in the box)'
    : 'NOT_HANDLED: the page ignored the paste event -- attach the file instead and note it';
})()`;

// -- planning -------------------------------------------------------------------

const PROVIDER_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const APP_URLS = { claude: 'https://claude.ai', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com' };

/** Date (YYYY-MM-DD) of this provider's previous day, or `fallback`. */
const previousDay = (runsDir, provider, today, fallback) => {
  if (!fs.existsSync(runsDir)) return fallback;
  const days = fs.readdirSync(runsDir)
    .map((d) => new RegExp(`^(\\d{4}-\\d{2}-\\d{2})(?:-\\d+)?-${provider}$`).exec(d))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((d) => d < today)
    .sort();
  return days.pop() || fallback;
};

const monthsBack = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * Second export of every dialog: md with images and text files inline.
 * The .md path fetches differently (image previews as data URLs, sandbox
 * pictures, text uploads); with both HARs collect replays all option
 * combinations offline (tools/settings-matrix.js).
 */
const mdExport = (detail, snippetFor) => {
  const tag = `${detail.tag}#md`;
  return { tag, snippet: snippetFor({ ...detail, mode: 'md', inlineImages: true, inlineTextFiles: true, tag }) };
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * One provider's day.
 *   scenarios   tests/live/scenarios.json
 *   catalog     tests/live/features.json (re-exports of its known chats)
 *   fixtures    tests/live/fixtures.local.json
 *   exportDefaults  export options (catalog.defaults.export)
 */
const planDay = ({ provider, scenarios, catalog, fixtures, project, uploadsDir, runsDir, today, chatUrlPattern, snippetFor }) => {
  const since = previousDay(runsDir, provider, today, monthsBack(today, 3));
  const tiers = scenarios.modelTiers[provider] || {};
  const exportOptions = { ...catalog.defaults.export, debugCapture: true };
  const vars = { providerName: PROVIDER_NAMES[provider], appUrl: APP_URLS[provider], since };
  const tasks = [];

  const research = scenarios.research;
  // Not `${provider}.research`: that catalog feature re-exports a chat of
  // the user's own; sharing its id made collect mix the two up.
  const researchId = `${provider}.day.research`;
  const researchDetail = { ...exportOptions, tag: researchId };
  tasks.push({
    kind: 'research',
    featureId: researchId,
    provider,
    title: `Research: what's new in ${PROVIDER_NAMES[provider]} chats since ${since}`,
    action: 'create',
    url: project,
    inProject: true,
    chatUrlPattern,
    tier: research.tier,
    tierName: tiers[research.tier] || research.tier,
    prompt: fill(research.prompt, vars),
    clarify: Object.fromEntries(Object.entries(research.clarify.answers).map(([k, v]) => [k, fill(v, vars)])),
    planApproval: research.clarify.planApproval,
    exercises: ['out.research'],
    exportDetail: researchDetail,
    exportSnippet: exportWithScreenSnippet(researchDetail, provider),
    extraExports: [mdExport(researchDetail, snippetFor)],
  });

  for (const f of catalog.features) {
    if (f.provider !== provider) continue;
    const known = fixtures[f.id] && fixtures[f.id].url;
    if (!known) continue;
    const detail = { ...catalog.defaults.export, ...(f.export || {}), debugCapture: true, tag: f.id };
    tasks.push({
      kind: 'reexport',
      featureId: f.id,
      provider,
      title: f.title,
      action: 'reexport',
      url: known,
      chatUrlPattern: f.chatUrlPattern || chatUrlPattern,
      note: fixtures[f.id].note || null,
      exportDetail: detail,
      exportSnippet: snippetFor(detail),
      extraExports: f.matrix
        ? [{ tag: `${f.id}#md`, snippet: snippetFor({ ...detail, mode: 'md', inlineImages: true, inlineTextFiles: true, tag: `${f.id}#md` }) }]
        : [],
    });
  }

  for (const s of scenarios.scenarios) {
    if (s.providers && !s.providers.includes(provider)) continue;
    const id = `${provider}.scn.${s.id}`;
    const detail = { ...exportOptions, tag: id };
    tasks.push({
      kind: 'scenario',
      featureId: id,
      scenario: s.id,
      provider,
      title: s.title,
      action: 'create',
      url: project,
      inProject: true,
      chatUrlPattern,
      tier: s.tier,
      tierName: tiers[s.tier] || s.tier,
      uploads: (s.uploads || []).map((u) => path.join(uploadsDir, u)),
      turns: s.turns.map((t) => ({
        ...t,
        attach: (t.attach || []).map((u) => path.join(uploadsDir, u)),
        pasteSnippet: t.paste ? pasteSnippet(fs.readFileSync(path.join(uploadsDir, t.paste), 'utf8')) : undefined,
      })),
      exercises: [...new Set(s.turns.flatMap((t) => t.exercises || []))],
      exportDetail: detail,
      exportSnippet: exportWithScreenSnippet(detail, provider),
      extraExports: [mdExport(detail, snippetFor)],
    });
  }

  return { provider, since, tasks, skipped: [], tiers };
};

/** The second export of the same chat, as one .md with everything inline. */
const extraLines = (t) => (t.extraExports || []).flatMap((x) => [
  `Then, on the same page, the second export (\`${x.tag}\`: one .md with images and text files inline):`, '',
  '```js', x.snippet, '```', '',
]);

const renderDayPlan = (plan, pollSnippet) => {
  const out = [];
  const p = plan.provider;
  out.push(`# Live test day — ${PROVIDER_NAMES[p]} — ${plan.createdAt.slice(0, 10)}`, '');
  out.push('Follow tests/live/TASK.md. Read this whole plan first.', '');
  out.push('## Snippets', '');
  out.push('Run these with the JavaScript tool on the chat tab.', '');
  out.push('**STATUS** — is the last reply finished? Run every 20–30 s (it needs two calls ≥10 s apart to say `done: true`):', '');
  out.push('```js', statusSnippet(p), '```', '');
  out.push('**POLL** — when an export snippet returned `PENDING`:', '');
  out.push('```js', pollSnippet, '```', '');
  out.push('Each task below has its own **EXPORT** snippet (it records what the page shows, then exports).', '');
  out.push('## Model tiers', '');
  for (const [tier, name] of Object.entries(plan.tiers)) out.push(`- **${tier}**: ${name}`);
  out.push('', 'Note in notes.md which model the picker actually showed.', '');

  plan.tasks.forEach((t, i) => {
    const n = i + 1;
    if (t.kind === 'research') {
      out.push(`## ${n}. RESEARCH — start first, collect last`, '');
      out.push(`Open ${t.url} (the test project), start a new chat from the project's composer, select the **${t.tier}** tier (${t.tierName}) and turn on research mode. Send:`, '');
      out.push('````text', t.prompt, '````', '');
      out.push('If it asks questions first, answer in one message from these:', '');
      for (const [k, v] of Object.entries(t.clarify)) out.push(`- *${k}*: ${v}`);
      out.push('', `${t.planApproval}`, '');
      out.push('Then move on. When it has finished (STATUS, every 2 min), run:', '');
      out.push('```js', t.exportSnippet, '```', '');
      out.push(...extraLines(t));
      return;
    }
    if (t.kind === 'reexport') {
      out.push(`## ${n}. ${t.featureId} — re-export`, '');
      out.push(`_${t.title}_`, '');
      if (t.note) out.push(`> **Note from the user about this chat:** ${t.note}`, '');
      out.push(`Open ${t.url}, wait until the conversation has loaded, run:`, '');
      out.push('```js', t.exportSnippet, '```', '');
      for (const x of t.extraExports || []) {
        out.push(`Then, on the same page, the second export (\`${x.tag}\`, for the settings matrix):`, '');
        out.push('```js', x.snippet, '```', '');
      }
      return;
    }
    out.push(`## ${n}. Scenario \`${t.scenario}\` — new chat`, '');
    out.push(`_${t.title}_`, '');
    out.push(`Open ${t.url} (the test project), start a new chat from the project's composer, select the **${t.tier}** tier (${t.tierName}).`, '');
    t.turns.forEach((turn, k) => {
      const lines = [];
      if (turn.action === 'edit-turn-1') lines.push(`Edit the **first** message (pencil under it), replace its text with: \`${turn.say}\`, submit.`);
      else if (turn.action === 'regenerate-last') lines.push('Regenerate the last reply (retry button under it).');
      else {
        if (turn.attach.length) lines.push(`Attach: ${turn.attach.map((a) => `\`${a}\``).join(', ')}`);
        if (turn.pasteSnippet) lines.push('Click into the message box and run the PASTE snippet below; then type the text.');
        lines.push(`Send: \`${turn.say}\``);
      }
      if (turn.onQuestion) lines.push(`If it asks questions instead: ${turn.onQuestion}`);
      lines.push('Wait until STATUS says done.');
      out.push(`${k + 1}. ${lines.join(' ')}`);
      if (turn.pasteSnippet) out.push('', '   PASTE:', '', '   ```js', ...turn.pasteSnippet.split('\n').map((l) => `   ${l}`), '   ```', '');
    });
    out.push('', 'Scroll to the top and back down once, then run:', '');
    out.push('```js', t.exportSnippet, '```', '');
    out.push(...extraLines(t));
  });
  return out.join('\n') + '\n';
};

// -- checks ---------------------------------------------------------------------

const PROVIDER_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|chatgpt\.com|openai\.com|oaiusercontent\.com|gemini\.google\.com|google\.com|gstatic\.com|googleusercontent\.com)$/i;

const normUrl = (u) => {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_/i.test(k)) x.searchParams.delete(k);
    return x.toString().replace(/\/$/, '').replace(/\?$/, '');
  } catch (_) {
    return u;
  }
};

/** Text for comparison: no markdown syntax, link targets or case. */
const flatten = (s) => String(s)
  .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  // Only tag-looking things: `i < n; … >` in code is not a tag.
  .replace(/<\/?[A-Za-z][^<>\n]{0,300}>/g, ' ')
  .replace(/[*_`#>|~\\]/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase()
  .trim();

/**
 * Everything the page showed vs the export.
 *   screen  log._exporter.screen ({text, images, links, counts})
 *   exp     loaded export ({md, files}) -- md WITH reasoning hidden or not
 *           doesn't matter: the page shows reasoning collapsed
 * Returns { missingText[], textCoverage, images:{screen, export}, missingLinks[],
 *           counts:{…}, errors[], warnings[] }.
 */
// The reasoning's tool-call / tool-result dumps: JSON the reader never saw
// as such (a widget's input is not the widget), so they don't count as
// "in the export".
const TOOL_DUMP_RE = /^\*\*(?:Tool call: `[^`\n]*`|Tool result|Tool error)\*\*\n\n(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm;

const compareScreen = (screen, exp) => {
  const files = exp.files ? [...exp.files.entries()] : [];
  const md = (exp.md || '').replace(TOOL_DUMP_RE, '');
  const exportText = [md, ...files.filter(([k]) => /^(artifacts|files)\//.test(k) && !/\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(k)).map(([, b]) => b.toString('utf8'))].join('\n');
  // Both sides reduced the same way: words of 3+ letters (short words and
  // punctuation differ between the page and markdown).
  const words = (s) => s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const flat = ` ${words(flatten(exportText)).join(' ')} `;

  // Lines of real content (UI labels are short): present when most of
  // their 4-word runs are in the export -- markdown and chips make exact
  // matching useless.
  const lines = String(screen.text || '').split('\n').map((l) => l.trim()).filter((l) => l.length >= 40);
  const missingText = [];
  let present = 0;
  for (const line of lines) {
    const w = words(flatten(line));
    if (w.length < 4) {
      present++;
      continue;
    }
    let hit = 0;
    let total = 0;
    for (let i = 0; i + 4 <= w.length; i += 2) {
      total++;
      if (flat.includes(` ${w.slice(i, i + 4).join(' ')} `)) hit++;
    }
    if (total === 0 || hit / total >= 0.6) present++;
    else missingText.push(line.slice(0, 200));
  }
  const textCoverage = lines.length ? present / lines.length : 1;

  // Pictures: web pictures by URL; the rest (uploads, generated) by count.
  const exportImageCount = (md.match(/!\[[^\]]*\]\(/g) || []).length;
  const screenImages = (screen.images || []).filter((i) => i.src && !/^data:image\/svg/i.test(i.src));
  const mdUrls = new Set((md.match(/\]\((https?:\/\/[^)\s]+)/g) || []).map((m) => normUrl(m.slice(2))));
  const missingImages = screenImages.filter((i) => {
    if (!/^https?:/i.test(i.src)) return false;
    let host = '';
    try { host = new URL(i.src).hostname; } catch (_) { /* ignore */ }
    return !PROVIDER_HOSTS.test(host) && !mdUrls.has(normUrl(i.src)) && !md.includes(i.src);
  });

  const missingLinks = (screen.links || []).filter((u) => {
    let host = '';
    try { host = new URL(u).hostname; } catch (_) { return false; }
    if (PROVIDER_HOSTS.test(host)) return false;
    const n = normUrl(u);
    return !mdUrls.has(n) && !exportText.includes(u) && !exportText.includes(n);
  });

  // Code blocks the reader sees: not the reasoning's tool-call dumps.
  const visibleMd = md.replace(/<details><summary>Thinking<\/summary>[\s\S]*?<\/details>\n?/g, '');
  const fences = (visibleMd.match(/^\s*(`{3,}|~{3,})/gm) || []).length / 2;
  const tables = (md.match(/^\|.*\|\s*\n\|[\s:|-]+\|/gm) || []).length;
  const counts = {
    codeBlocks: { screen: (screen.counts || {}).codeBlocks || 0, export: Math.floor(fences) },
    tables: { screen: (screen.counts || {}).tables || 0, export: tables },
  };

  const errors = [];
  const warnings = [];
  const longMissing = missingText.filter((l) => l.length >= 80);
  if (longMissing.length) errors.push(`${longMissing.length} line(s) of text shown on the page are not in the export, e.g. "${longMissing[0].slice(0, 120)}"`);
  else if (missingText.length) warnings.push(`${missingText.length} short line(s) shown on the page not found in the export, e.g. "${missingText[0].slice(0, 100)}"`);
  if (screenImages.length > exportImageCount) {
    (missingImages.length ? errors : warnings).push(`page shows ${screenImages.length} picture(s), export has ${exportImageCount}${missingImages.length ? `; missing web pictures: ${missingImages.slice(0, 3).map((i) => i.src).join(', ')}` : ''}`);
  }
  if (missingLinks.length) errors.push(`${missingLinks.length} link(s) on the page are not in the export: ${missingLinks.slice(0, 5).join(', ')}`);
  for (const [k, c] of Object.entries(counts)) {
    if (c.screen > c.export) warnings.push(`page shows ${c.screen} ${k}, export has ${c.export}`);
  }
  return { textCoverage, missingText: missingText.slice(0, 20), images: { screen: screenImages.length, export: exportImageCount }, missingImages: missingImages.map((i) => i.src).slice(0, 20), missingLinks: missingLinks.slice(0, 50), counts, errors, warnings };
};

/**
 * Cheap export-side evidence for a capability the scenario exercised.
 * null = can't tell from the export alone (the screen check covers it).
 */
const CAPABILITY_EVIDENCE = {
  'out.code-block': (x) => /^\s*```\w*/m.test(x.assistant),
  'out.code-document': (x) => x.artifacts.some((k) => /\.(py|js|ts|html|css|json|sh|java|go|rs|c|cpp)$/i.test(k)),
  'out.document': (x) => x.artifacts.some((k) => /\.(md|txt)$/i.test(k)) || /🧩 \[/.test(x.md),
  'out.file': (x) => x.artifacts.length + x.files.length > 0 || /📎 \[/.test(x.assistant),
  'out.code-chart': (x) => /!\[[^\]]*\]\((assets\/|data:image)/.test(x.assistant),
  'out.chart-widget': (x) => /^\*\*📊 /m.test(x.assistant),
  'out.docs-artifact': (x) => /🧩 \[[^\]]*\]\([^)]*\) · \[online\]\(https:\/\/claude\.ai\/code\/artifact\//.test(x.md),
  'out.slides': (x) => x.artifacts.filter((k) => /\.html$/i.test(k)).length >= 2,
  'out.recipe': (x) => /^\*\*🍳 /m.test(x.assistant),
  'out.places': (x) => /^\*\*🗺️ /m.test(x.assistant) || /📍 \[/.test(x.assistant),
  'out.weather': (x) => /^\*\*🌤️ Weather/m.test(x.assistant),
  'out.interactive': (x) => /^\*\*(?:📝 |Questions\*\*)/m.test(x.assistant) || /<details><summary>Answer<\/summary>/.test(x.assistant),
  'out.image-gen': (x) => /!\[[^\]]*\]\((assets\/|data:image)/.test(x.assistant),
  'out.web-sources': (x) => /\]\(https?:\/\//.test(x.assistant),
  'out.web-images': (x) => /!\[[^\]]*\]\(https?:\/\//.test(x.assistant),
  'out.math': (x) => /\$[^$\n]+\$|\$\$/.test(x.assistant),
  'out.diagram': (x) => /```mermaid/.test(x.assistant) || x.artifacts.some((k) => /\.(svg|html|mermaid|mmd)$/i.test(k)) || /!\[[^\]]*\]\((assets\/|data:image)/.test(x.assistant),
  // table rows end in "|  " (the renderer's line breaks)
  'out.formatting': (x) => /^\|.*\|[ \t]*$/m.test(x.assistant) || /^#{1,6} /m.test(x.assistant) || /^\s*[-*] /m.test(x.assistant),
  'out.reasoning': (x) => /<details><summary>Thinking<\/summary>/.test(x.md),
  'out.research': (x) => x.artifacts.length > 0 || x.assistant.length > 3000,
  'in.image': (x) => /!\[[^\]]*\]\(/.test(x.human),
  'in.pdf': (x) => /\.pdf\b/i.test(x.md),
  'in.text-file': (x) => /\.(md|csv|js|txt)\b/i.test(x.human) || /\.(md|csv|js|txt)\b/i.test(x.md),
};

/**
 * Per exercised capability: supported here? evidence in the export?
 * Missing evidence is a warning: the model may not have used the tool;
 * the screen check is what turns a real loss into an error.
 */
const checkCapabilities = (exercises, provider, capabilities, exp, assistantText, humanText) => {
  const keys = exp.files ? [...exp.files.keys()] : [];
  const x = {
    md: exp.md || '',
    assistant: assistantText,
    human: humanText,
    artifacts: keys.filter((k) => k.startsWith('artifacts/')),
    files: keys.filter((k) => k.startsWith('files/')),
  };
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  return exercises.map((id) => {
    const cap = byId.get(id);
    const support = cap ? cap.providers[provider] || 'unknown' : 'unknown';
    const test = CAPABILITY_EVIDENCE[id];
    const seen = test ? !!test(x) : null;
    return { id, title: cap ? cap.title : id, support, seen };
  });
};

/**
 * Was the last reply complete when exported? Looks at the conversation the
 * export fetched (HAR). ChatGPT: the current node's message status; Claude:
 * the last message's stop_reason. Gemini: can't tell (null).
 */
const completeness = (provider, harLog) => {
  const bodies = (harLog.entries || [])
    .filter((e) => e.response && e.response.content && typeof e.response.content.text === 'string')
    .map((e) => ({ url: e.request.url, text: e.response.content.text }));
  try {
    if (provider === 'chatgpt') {
      const b = bodies.find((x) => /\/backend-api\/conversation\/[0-9a-f-]{36}(\?|$)/.test(x.url));
      if (!b) return null;
      const conv = JSON.parse(b.text);
      const node = conv.mapping && conv.mapping[conv.current_node];
      const m = node && node.message;
      if (!m) return null;
      return m.status === 'finished_successfully' ? { complete: true } : { complete: false, why: `last message status ${m.status}` };
    }
    if (provider === 'claude') {
      const b = bodies.find((x) => /\/chat_conversations\/[0-9a-f-]{36}\?/.test(x.url));
      if (!b) return null;
      const conv = JSON.parse(b.text);
      const msgs = conv.chat_messages || [];
      const last = msgs[msgs.length - 1];
      if (!last || last.sender !== 'assistant') return { complete: false, why: 'no reply after the last message' };
      return last.stop_reason ? { complete: true } : { complete: false, why: 'last reply has no stop_reason (still streaming)' };
    }
  } catch (_) {
    return null;
  }
  return null;
};

module.exports = {
  PAGE,
  statusSnippet,
  exportWithScreenSnippet,
  pasteSnippet,
  previousDay,
  planDay,
  renderDayPlan,
  compareScreen,
  checkCapabilities,
  completeness,
  flatten,
};
