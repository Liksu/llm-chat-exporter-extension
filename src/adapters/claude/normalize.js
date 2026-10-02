/**
 * Convert raw Claude conversation JSON into NormalizedConversation.
 *
 * Key behaviours:
 *   - Walk current_leaf_message_uuid → root via parent_message_uuid (single
 *     branch only).
 *   - tool_use with name='artifacts': fold create / update / rewrite by
 *     `id` (or `version_uuid`/`identifier`) into a final Artifact. Place an
 *     `artifact_ref` block at the *create* site only; subsequent edits are
 *     not surfaced in the body of the conversation.
 *   - tool_use with name='create_file' (sandbox file-write tool, payload
 *     `{path, file_text}`): treated like an artifact — claude.ai surfaces
 *     these as downloadable files in the chat, so they're model-generated
 *     deliverables conceptually identical to `artifacts` outputs. Keyed by
 *     full path so re-writes collapse to the latest version.
 *   - attachments[] → Attachment{category:'text'}
 *   - files[] → Attachment{category:'binary'}, with bytes fetched on demand
 *     by the caller (we record file_uuid for that).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { sanitizeFilename, extFromArtifactKind, safeStringify, isTextLikeMime, log } = ns.utils;

  /** Walk from current leaf upward; return root → leaf order. */
  const orderMessages = (raw) => {
    const messages = raw.chat_messages ?? [];
    const leaf = raw.current_leaf_message_uuid;
    if (!leaf) {
      return [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }
    const byUuid = new Map(messages.map((m) => [m.uuid, m]));
    const acc = [];
    const seen = new Set();
    let cur = leaf;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const m = byUuid.get(cur);
      if (!m) break;
      acc.push(m);
      cur = m.parent_message_uuid ?? null;
    }
    return acc.reverse();
  };

  /** Read string field by trying multiple key candidates. */
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };

  const isObject = (v) => v !== null && typeof v === 'object';

  /**
   * Claude.ai sometimes auto-linkifies file names by wrapping them in markdown
   * link syntax: "[name.md](http://name.md)". Strip that back to the bare name
   * so it doesn't render as a link in the exported markdown.
   */
  const cleanFileName = (s) => {
    if (typeof s !== 'string') return '';
    const m = s.match(/^\[([^\]]+)\]\([^)]*\)$/);
    return m ? m[1] : s;
  };

  /**
   * Same idea as cleanFileName but for paths: strip every inline
   * `[name](url)` wrapper that appears inside the path. The sandbox path
   * `/mnt/user-data/uploads/[name.md](http://name.md)` becomes
   * `/mnt/user-data/uploads/name.md`, which is what claude.ai's own
   * download-file endpoint expects.
   */
  const cleanFilePath = (p) => {
    if (typeof p !== 'string') return '';
    return p.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1');
  };

  /**
   * When Claude reads an uploaded file via its `view` tool, the file's text
   * is dumped into the corresponding `tool_result` block, line-prefixed with
   * `     N\t`. We can harvest that as a fallback when direct file download
   * isn't available (no preview_url on non-image files in claude.ai's API).
   *
   * Returns Map<path, joinedText> keyed by `view`'s `input.path`.
   */
  const harvestViewToolContent = (orderedMessages) => {
    const linesByPath = new Map(); // path → Map<lineNumber, lineContent>
    for (const m of orderedMessages) {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!isObject(b) || b.type !== 'tool_use' || b.name !== 'view') continue;
        const path = pick(b.input || {}, ['path']);
        if (!path) continue;
        const toolUseId = b.id;
        // tool_result for the same tool_use_id usually follows immediately
        let result = null;
        for (let j = i + 1; j < blocks.length; j++) {
          const r = blocks[j];
          if (isObject(r) && r.type === 'tool_result' && r.tool_use_id === toolUseId) {
            result = r;
            break;
          }
        }
        if (!result || result.is_error) continue;
        const text = extractToolResultText(result.content);
        if (!text) continue;
        const cleanedPath = cleanFilePath(path);
        const lines = linesByPath.get(cleanedPath) || new Map();
        // parse lines like "     N\t<content>"
        const lineRe = /^[ \t]*(\d+)\t(.*)$/gm;
        let lm;
        while ((lm = lineRe.exec(text)) !== null) {
          const n = parseInt(lm[1], 10);
          if (!lines.has(n)) lines.set(n, lm[2]);
        }
        linesByPath.set(cleanedPath, lines);
      }
    }
    const out = new Map();
    for (const [path, lines] of linesByPath) {
      const sorted = Array.from(lines.entries()).sort((a, b) => a[0] - b[0]);
      out.set(path, sorted.map(([, c]) => c).join('\n'));
    }
    return out;
  };

  const extractToolResultText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p) =>
          typeof p === 'string'
            ? p
            : isObject(p) && typeof p.text === 'string'
              ? p.text
              : ''
        )
        .filter(Boolean)
        .join('\n');
    }
    return '';
  };

  /**
   * Claude.ai injects a placeholder into text-export representation when the
   * UI shows a rich block (artifact card, calendar, etc.) that has no plain
   * text fallback. The placeholder appears wrapped in a code fence:
   *     ```
   *     This block is not supported on your current device yet.
   *     ```
   * Strip every such occurrence from a text block.
   */
  const PLACEHOLDER_RE =
    /(^|\n)\s*```[ \t]*\n?\s*This block is not supported on your current device yet\.\s*\n?\s*```\s*(?=\n|$)/g;
  const stripUnsupportedPlaceholder = (text) =>
    String(text || '').replace(PLACEHOLDER_RE, '\n').replace(/\n{3,}/g, '\n\n');

  /**
   * Apply a `create_file` tool_use call (Claude's sandbox file-write tool;
   * payload is `{path, file_text, description?}`) to the artifact map.
   *
   * Why this is treated as an artifact: claude.ai surfaces these as
   * downloadable files in the conversation (the user clicks a link and gets
   * the file). They're conceptually the same as `artifacts`-tool outputs —
   * model-generated deliverables the user is meant to keep — just produced
   * through the sandbox-tool API. Without this handler they'd fall through
   * to the generic `tool_call` branch and be hidden whenever reasoning is
   * off, which silently drops a file the user explicitly asked Claude to
   * write.
   *
   * Returns the artifact id touched (or null if the call was unusable).
   */
  const applyCreateFileCall = (raw, artifactMap) => {
    const input = raw && raw.input;
    if (!isObject(input)) return null;
    const path = pick(input, ['path']);
    const text = typeof input.file_text === 'string' ? input.file_text : '';
    if (!path || !text) return null;

    // Key by full path so successive writes to the same file (regenerations)
    // collapse to a single artifact whose content reflects the latest call.
    const id = `create_file:${path}`;
    const { fileName, title, language } = describeFile(path);
    artifactMap.set(id, {
      id,
      title,
      language,
      mime: undefined,
      content: text,
      fileName,
    });
    return id;
  };

  const LANG_BY_EXT = {
    md: 'markdown', markdown: 'markdown',
    txt: '', text: '',
    json: 'json', yml: 'yaml', yaml: 'yaml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    html: 'html', htm: 'html', css: 'css', scss: 'scss',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', xml: 'xml', toml: 'toml', ini: 'ini',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', svg: 'xml',
  };

  /** File name, title (name sans extension) and code language for a path. */
  const describeFile = (path) => {
    const basename = String(path).split('/').pop() || 'file';
    const fileName = sanitizeFilename(basename);
    const dot = fileName.lastIndexOf('.');
    const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
    const language = Object.prototype.hasOwnProperty.call(LANG_BY_EXT, ext) ? LANG_BY_EXT[ext] : ext;
    return { fileName, title: dot >= 0 ? fileName.slice(0, dot) : fileName, language };
  };

  /**
   * Apply one textual edit -- `str_replace` ({path, old_str, new_str}) of
   * the create_file era, `Edit` ({file_path, old_string, new_string,
   * replace_all}) of the Write era. Returns the new content, or the old one
   * when old text isn't found.
   */
  const applyTextEdit = (content, oldStr, newStr, all) => {
    if (typeof content !== 'string' || typeof oldStr !== 'string' || !oldStr) return content;
    if (!content.includes(oldStr)) return content;
    const replacement = typeof newStr === 'string' ? newStr : '';
    return all ? content.split(oldStr).join(replacement) : content.replace(oldStr, () => replacement);
  };

  /**
   * Sources for citations. claude.ai keeps them out of the text: Research
   * reports carry `md_citations` on the artifact, web-search answers carry
   * `citations` on text blocks -- each {url, title, metadata, start_index,
   * end_index}. Without this an export has no sources at all.
   *
   * Inserts a ` [[n]](url)` marker at each citation's end_index (indices
   * count code points -- Python-side strings) and records the source in
   * `sources` (Map url → {n, title}), which numbers sources across calls so
   * blocks of one turn share numbering.
   */
  const applyCitations = (text, citations, sources) => {
    if (typeof text !== 'string' || !Array.isArray(citations) || citations.length === 0) return text;
    const chars = Array.from(text);
    const marks = [];
    for (const c of citations) {
      if (!isObject(c)) continue;
      const src = Array.isArray(c.sources) && isObject(c.sources[0]) ? c.sources[0] : {};
      const url = pick(c, ['url']) || pick(src, ['url']);
      if (!url) continue;
      if (!sources.has(url)) {
        const title =
          pick(c.metadata || {}, ['preview_title']) || pick(c, ['title']) || pick(src, ['title']) || url;
        sources.set(url, { n: sources.size + 1, title });
      }
      const at = c.end_index;
      if (Number.isInteger(at) && at >= 0 && at <= chars.length) {
        marks.push({ at, n: sources.get(url).n, url });
      }
    }
    const seen = new Set();
    marks.sort((a, b) => b.at - a.at || b.n - a.n);
    for (const m of marks) {
      const key = `${m.at}:${m.n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chars.splice(m.at, 0, ` [[${m.n}]](${m.url})`);
    }
    return chars.join('');
  };

  /** Numbered markdown list of sources; `only` limits it to those urls. */
  const formatSources = (sources, only) => {
    const rows = [];
    for (const [url, s] of sources) {
      if (only && !only.has(url)) continue;
      const title = String(s.title).replace(/[[\]]/g, '');
      rows.push(`${s.n}. [${title}](${url})`);
    }
    return rows.join('\n');
  };

  /**
   * Format the body of a "content widget" tool call -- a tool_use whose
   * input field IS the user-facing assistant content (not a backend
   * operation). Currently:
   *
   *   message_compose_v1 — multi-variant message drafts. Claude offers the
   *                        user a tabbed picker; we emit each variant in
   *                        sequence with its label as a subheading.
   *   ask_user_input_v0  — questionnaire widget. Renders as a numbered
   *                        list of questions with their options.
   *
   * These belong in the conversation body regardless of includeReasoning,
   * because for the reader they ARE the assistant's reply. The matching
   * tool_result that follows ("Generated widget") stays reasoning-only.
   *
   * Returns the markdown string, or null if the name isn't a known widget
   * or the input doesn't have the expected shape.
   */
  const formatMessageComposeV1 = (input) => {
    if (!isObject(input)) return null;
    const variants = Array.isArray(input.variants) ? input.variants : [];
    if (variants.length === 0) return null;
    const title =
      typeof input.summary_title === 'string' && input.summary_title.trim()
        ? input.summary_title.trim()
        : 'Message draft';
    const kind = typeof input.kind === 'string' ? input.kind : '';
    const out = [`**${title}**`];
    variants.forEach((v, i) => {
      if (!isObject(v)) return;
      const label =
        typeof v.label === 'string' && v.label.trim()
          ? v.label.trim()
          : `Variant ${String.fromCharCode(65 + i)}`;
      out.push('');
      out.push(`**${label}**`);
      if (kind === 'email' && typeof v.subject === 'string' && v.subject.trim()) {
        out.push('');
        out.push(`_Subject:_ ${v.subject.trim()}`);
      }
      if (typeof v.body === 'string' && v.body.trim()) {
        out.push('');
        out.push(v.body);
      }
    });
    return out.join('\n');
  };

  const formatAskUserInputV0 = (input) => {
    if (!isObject(input)) return null;
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (questions.length === 0) return null;
    const out = ['**Questions**'];
    questions.forEach((q, i) => {
      if (!isObject(q)) return;
      const qText = typeof q.question === 'string' ? q.question.trim() : '';
      if (!qText) return;
      out.push('');
      out.push(`${i + 1}. ${qText}`);
      const options = Array.isArray(q.options) ? q.options : [];
      for (const opt of options) {
        if (typeof opt === 'string' && opt.trim()) out.push(`   - ${opt.trim()}`);
      }
    });
    return out.join('\n');
  };

  const formatContentWidget = (name, input) => {
    if (name === 'message_compose_v1') return formatMessageComposeV1(input);
    if (name === 'ask_user_input_v0') return formatAskUserInputV0(input);
    return null;
  };

  /**
   * Apply an artifacts tool_use call to the artifact map.
   * Returns the artifact id touched (or null if input was unusable).
   */
  const applyArtifactsCall = (input, artifactMap) => {
    if (!isObject(input)) return null;
    const id = pick(input, ['id', 'identifier', 'artifact_id', 'uuid']);
    if (!id) return null;
    const command = (pick(input, ['command', 'operation']) || 'create').toLowerCase();
    let art = artifactMap.get(id);

    if (command === 'create' || !art) {
      const title = pick(input, ['title', 'name']) || id;
      const language = pick(input, ['language', 'lang']);
      const mime = pick(input, ['type', 'mime', 'content_type']);
      const content = withSources(typeof input.content === 'string' ? input.content : '', input.md_citations);
      const ext = extFromArtifactKind(language, mime);
      const fileName = sanitizeFilename(title) + ext;
      art = { id, title, language, mime, content, fileName };
      artifactMap.set(id, art);
      return id;
    }

    if (command === 'update') {
      const oldStr = typeof input.old_str === 'string' ? input.old_str : null;
      const newStr = typeof input.new_str === 'string' ? input.new_str : '';
      if (oldStr !== null && art.content.includes(oldStr)) {
        art.content = art.content.replace(oldStr, newStr);
      }
      return id;
    }

    if (command === 'rewrite') {
      if (typeof input.content === 'string') art.content = withSources(input.content, input.md_citations);
      return id;
    }

    return id;
  };

  /** Artifact text with citation markers and a trailing Sources section. */
  const withSources = (content, citations) => {
    if (!Array.isArray(citations) || citations.length === 0) return content;
    const sources = new Map();
    const marked = applyCitations(content, citations, sources);
    return sources.size ? `${marked.trimEnd()}\n\n## Sources\n\n${formatSources(sources)}\n` : marked;
  };

  /**
   * Write-era artifacts. Claude writes a file with `Write` ({file_path,
   * content}), changes it with `Edit`, and publishes it with `Artifact`
   * ({file_path, ...}); the result text holds the published URL. Each
   * publish snapshots the file's current content into one artifact per
   * path. Returns the artifact id on the first publish (where the reference
   * goes in the body), null otherwise.
   */
  const applyArtifactPublish = (input, ctx) => {
    const path = pick(input || {}, ['file_path', 'path']);
    if (!path || !ctx.files.has(path)) return null;
    const id = `artifact:${path}`;
    const existing = ctx.artifactMap.get(id);
    const content = ctx.files.get(path);
    const { fileName, title, language } = describeFile(path);
    const htmlTitle = /<title>([^<]{1,200})<\/title>/i.exec(content);
    ctx.artifactMap.set(id, {
      id,
      title: (htmlTitle && htmlTitle[1].trim()) || pick(input, ['title']) || title,
      language,
      mime: undefined,
      content,
      fileName,
      url: existing ? existing.url : undefined,
    });
    return existing ? null : id;
  };

  /** "Published <path> at https://claude.ai/artifact/<id> (Version N…" */
  const PUBLISHED_RE = /Published (\S+) at (https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+)/;
  /** "Created a new Artifact at https://claude.ai/artifact/<id> (…) from the Artifact type …" */
  const TYPED_CREATED_RE = /Created a new Artifact at (https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+)/;

  /**
   * Content-bearing tool output kept as an artifact: `show_widget` draws an
   * SVG / HTML widget inline in the chat ({title, widget_code}).
   */
  const applyWidgetCall = (raw, ctx) => {
    const input = raw.input || {};
    const code = typeof input.widget_code === 'string' ? input.widget_code : '';
    if (!code.trim()) return null;
    const title = pick(input, ['title']) || 'widget';
    const isSvg = /^\s*<svg[\s>]/i.test(code);
    const id = `widget:${raw.id || title}`;
    ctx.artifactMap.set(id, {
      id,
      title,
      language: isSvg ? 'xml' : 'html',
      mime: undefined,
      content: code,
      fileName: sanitizeFilename(title) + (isSvg ? '.svg' : '.html'),
    });
    return id;
  };

  /**
   * `flag` content block: claude.ai shows a support banner (e.g. a crisis
   * helpline) next to the message. Keep what the reader saw as a note.
   */
  const formatFlag = (raw) => {
    const h = isObject(raw.helpline) ? raw.helpline : null;
    if (!h) return `> ⚠️ claude.ai flagged this message${raw.flag ? ` (${raw.flag})` : ''}.`;
    const ways = [];
    if (h.phone_number) ways.push(`call ${h.phone_number}`);
    if (h.sms_number) ways.push(`text ${h.sms_number}`);
    if (h.web_chat_url) ways.push(`chat: ${h.web_chat_url}`);
    return `> ⚠️ claude.ai showed a support resource here: **${h.name || 'helpline'}**${ways.length ? ` — ${ways.join(' · ')}` : ''}`;
  };

  /** Extract image bytes loader info from a content block. Returns null if
   *  it is not an image block. The fetch itself happens in content.js. */
  const detectImageBlockRef = (block) => {
    if (!isObject(block)) return null;
    if (block.type === 'image' || block.type === 'image_url') {
      // Various shapes seen in the wild — record what we can.
      const src = block.source ?? block.image ?? block.image_url ?? null;
      const url = pick(src || {}, ['url']) || pick(block, ['url']);
      const fileUuid = pick(src || {}, ['file_uuid', 'file_id']) ||
        pick(block, ['file_uuid', 'file_id']);
      const mime = pick(src || {}, ['media_type', 'mime']) || pick(block, ['media_type', 'mime']);
      if (url || fileUuid) {
        return { url: url || null, fileUuid: fileUuid || null, mime: mime || 'image/png' };
      }
    }
    return null;
  };

  /**
   * Convert one Claude content block into normalized blocks (zero or more).
   * Returns an array of { block, _imageRef? } — _imageRef indicates the
   * caller must populate bytes before rendering.
   */
  const transformBlock = (raw, ctx) => {
    const t = raw?.type;
    const { artifactMap } = ctx;

    if (t === 'text') {
      const raw_text = typeof raw.text === 'string' ? raw.text : '';
      ctx.turnText.push(raw_text);
      const cited = applyCitations(raw_text, raw.citations, ctx.turnSources);
      const cleaned = stripUnsupportedPlaceholder(cited);
      return cleaned.trim().length > 0 ? [{ block: { kind: 'text', text: cleaned } }] : [];
    }

    if (t === 'thinking') {
      let text =
        typeof raw.thinking === 'string'
          ? raw.thinking
          : typeof raw.text === 'string'
            ? raw.text
            : '';
      // claude.ai increasingly hides the reasoning itself (thinking: "",
      // thinking_hidden: true) and only keeps the one-line summaries the UI
      // shows while it thinks.
      if (!text && Array.isArray(raw.summaries)) {
        const lines = raw.summaries.map((s) => pick(s || {}, ['summary'])).filter(Boolean);
        if (lines.length) text = `${lines.map((l) => `- ${l}`).join('\n')}\n\n_(summary — claude.ai doesn't keep the full reasoning)_`;
      }
      return text ? [{ block: { kind: 'thinking', text } }] : [];
    }

    // Internal bookkeeping, nothing a reader saw.
    if (t === 'token_budget') return [];

    if (t === 'flag') return [{ block: { kind: 'text', text: formatFlag(raw) } }];

    if (t === 'tool_use') {
      const name = typeof raw.name === 'string' ? raw.name : 'tool';
      const input = isObject(raw.input) ? raw.input : {};
      const asCall = { block: { kind: 'tool_call', name, input: safeStringify(raw.input) } };
      if (raw.id) ctx.toolInputs.set(raw.id, input);
      if (name === 'artifacts') {
        const id = applyArtifactsCall(raw.input, artifactMap);
        const command = (pick(raw.input || {}, ['command', 'operation']) || 'create').toLowerCase();
        if (id && command === 'create') {
          return [{ block: { kind: 'artifact_ref', artifactId: id } }];
        }
        return [];
      }
      if (name === 'create_file') {
        const path = pick(input, ['path']);
        if (path && typeof input.file_text === 'string') ctx.files.set(path, input.file_text);
        const id = applyCreateFileCall(raw, artifactMap);
        if (id) return [{ block: { kind: 'artifact_ref', artifactId: id } }];
        return [];
      }
      // Edits to sandbox files. A create_file artifact shows the file as it
      // is now, so its edits apply right away; Write-era files become
      // artifacts only when published (Artifact below).
      if (name === 'str_replace' || name === 'Edit') {
        const path = pick(input, name === 'Edit' ? ['file_path', 'path'] : ['path']);
        const oldStr = name === 'Edit' ? input.old_string : input.old_str;
        const newStr = name === 'Edit' ? input.new_string : input.new_str;
        if (path && ctx.files.has(path)) {
          ctx.files.set(path, applyTextEdit(ctx.files.get(path), oldStr, newStr, input.replace_all === true));
          const created = artifactMap.get(`create_file:${path}`);
          if (created) created.content = ctx.files.get(path);
        }
        return [asCall];
      }
      if (name === 'Write') {
        const path = pick(input, ['file_path', 'path']);
        if (path && typeof input.content === 'string') ctx.files.set(path, input.content);
        return [asCall];
      }
      if (name === 'Artifact' && pick(input, ['file_path'])) {
        const id = applyArtifactPublish(input, ctx);
        return id ? [asCall, { block: { kind: 'artifact_ref', artifactId: id } }] : [asCall];
      }
      if (/(^|:)show_widget$/.test(name)) {
        const id = applyWidgetCall(raw, ctx);
        if (id) return [{ block: { kind: 'artifact_ref', artifactId: id } }];
        return [asCall];
      }
      // Content-bearing widgets (message drafts, questionnaires) surface
      // their input as regular text -- it IS the assistant's content, the
      // tool call is just delivery mechanism.
      const widgetText = formatContentWidget(name, raw.input);
      if (widgetText) {
        return [{ block: { kind: 'text', text: widgetText } }];
      }
      return [
        {
          block: { kind: 'tool_call', name, input: safeStringify(raw.input) },
        },
      ];
    }

    if (t === 'tool_result') {
      let text;
      if (typeof raw.content === 'string') {
        text = raw.content;
      } else if (Array.isArray(raw.content)) {
        text = raw.content
          .map((p) =>
            typeof p === 'string'
              ? p
              : isObject(p) && typeof p.text === 'string'
                ? p.text
                : safeStringify(p)
          )
          .join('\n');
      } else {
        text = safeStringify(raw.content);
      }
      if (raw.name === 'Artifact') {
        const m = PUBLISHED_RE.exec(text);
        const art = m && artifactMap.get(`artifact:${m[1]}`);
        if (art) art.url = m[2];
        // Docs / Slides / Design artifacts are created from an Artifact type;
        // their content lives in that type's own service and is edited via
        // its tools, so all an export can carry is the link.
        const typed = TYPED_CREATED_RE.exec(text);
        const call = ctx.toolInputs.get(raw.tool_use_id);
        if (typed && call && call.type_url) {
          const title = pick(call, ['title']) || 'claude.ai document';
          return [
            { block: { kind: 'text', text: `📄 **${title}** — made on claude.ai; its content isn't included in this export: [open](${typed[1]})` } },
            { block: { kind: 'tool_result', text, isError: raw.is_error === true } },
          ];
        }
      }
      return [
        {
          block: { kind: 'tool_result', text, isError: raw.is_error === true },
        },
      ];
    }

    const imgRef = detectImageBlockRef(raw);
    if (imgRef) {
      return [
        {
          block: {
            kind: 'image',
            mime: imgRef.mime,
            name: imgRef.fileUuid ? `${imgRef.fileUuid}` : 'image',
            bytes: new Uint8Array(0), // populated later
          },
          _imageRef: imgRef,
        },
      ];
    }

    // Unknown block type — surface as a tool_call so it shows up under
    // includeReasoning, but don't pollute the main thread.
    return [
      {
        block: {
          kind: 'tool_call',
          name: `unknown:${t || '?'}`,
          input: safeStringify(raw),
        },
      },
    ];
  };

  /** Classify Claude attachments → text-attachments. */
  const transformAttachments = (rawList) => {
    if (!Array.isArray(rawList)) return [];
    const out = [];
    for (const a of rawList) {
      if (!isObject(a)) continue;
      const text =
        typeof a.extracted_content === 'string'
          ? a.extracted_content
          : typeof a.text === 'string'
            ? a.text
            : '';
      out.push({
        category: 'text',
        fileName: cleanFileName(a.file_name),
        mime: typeof a.file_type === 'string' ? a.file_type : 'text/plain',
        text,
        size: typeof a.file_size === 'number' ? a.file_size : undefined,
      });
    }
    return out;
  };

  /**
   * Split Claude files[] into:
   *   - imageItems: inline image blocks placed in turn.blocks (with preview_url)
   *   - attachments: non-image binaries kept in turn.attachments
   *
   * Reason: Claude's UI shows uploaded/pasted images inline in the message
   * body. The API returns them in files[] with file_kind === 'image' and a
   * ready-to-fetch preview_url / preview_asset.url.
   */
  const transformFiles = (rawList, options, viewHarvest) => {
    if (!Array.isArray(rawList)) return { imageItems: [], attachments: [] };
    const inlineTextFiles = !!(options && options.inlineTextFiles);
    const imageItems = [];
    const attachments = [];
    for (const f of rawList) {
      if (!isObject(f)) continue;
      const fileUuid = pick(f, ['file_uuid', 'uuid', 'id']);
      const fileName = cleanFileName(f.file_name) || 'file.bin';
      const filePath = typeof f.path === 'string' ? cleanFilePath(f.path) : null;
      const kind = typeof f.file_kind === 'string' ? f.file_kind.toLowerCase() : '';
      const mimeFromExt = guessMimeFromName(fileName);
      const isImage = kind === 'image' || mimeFromExt.startsWith('image/');
      const size = typeof f.size_bytes === 'number' ? f.size_bytes : undefined;

      if (isImage) {
        const previewUrl =
          pick(f, ['preview_url']) ||
          (isObject(f.preview_asset) ? pick(f.preview_asset, ['url']) : undefined);
        const fullUrl = previewUrl ? toAbsoluteClaudeUrl(previewUrl) : null;
        imageItems.push({
          block: {
            kind: 'image',
            mime: mimeFromExt.startsWith('image/') ? mimeFromExt : 'image/png',
            name: fileName,
            bytes: new Uint8Array(0),
          },
          ref: { url: fullUrl, fileUuid, mime: mimeFromExt },
        });
        continue;
      }

      if (inlineTextFiles && isTextLikeMime(mimeFromExt, fileName)) {
        // Text-like file. Prefer content harvested from `view` tool_results
        // (works whenever Claude has already read this file in the chat).
        // Fall back to attempted direct fetch if we have nothing.
        const harvested =
          viewHarvest && filePath ? viewHarvest.get(filePath) : undefined;
        attachments.push({
          category: 'text',
          fileName,
          mime: mimeFromExt,
          text: harvested || '',
          fileUuid,
          path: filePath,
          needsContentFetch: !harvested,
          size,
        });
        continue;
      }

      attachments.push({
        category: 'binary',
        fileName,
        mime: mimeFromExt,
        fileUuid,
        path: filePath,
        isImage: false,
        size,
      });
    }
    return { imageItems, attachments };
  };

  /**
   * Files the assistant handed over with SendUserFile / present_files whose
   * tool_result names them ("<path> → file_uuid: <uuid>") but that are
   * missing from the message's files[]. Returned as files[]-shaped entries.
   */
  const DELIVERED_RE = /^\s*(\S[^\n]*?)\s+→\s+file_uuid:\s*([0-9a-f-]{36})/gm;
  const deliveredFiles = (m) => {
    const known = new Set((Array.isArray(m.files) ? m.files : []).map((f) => f && (f.file_uuid || f.uuid)));
    const out = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!isObject(b) || b.type !== 'tool_result' || !/^(SendUserFile|present_files)$/.test(b.name || '')) continue;
      const text = extractToolResultText(b.content);
      for (const x of text.matchAll(DELIVERED_RE)) {
        if (known.has(x[2])) continue;
        known.add(x[2]);
        out.push({ file_uuid: x[2], file_name: x[1].split('/').pop(), file_kind: 'blob' });
      }
    }
    return out;
  };

  const toAbsoluteClaudeUrl = (path) => {
    if (!path) return null;
    if (/^https?:/i.test(path)) return path;
    return `https://claude.ai${path.startsWith('/') ? '' : '/'}${path}`;
  };

  const guessMimeFromName = (name) => {
    const ext = String(name || '').toLowerCase().split('.').pop();
    const map = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      pdf: 'application/pdf',
      zip: 'application/zip',
      json: 'application/json',
      md: 'text/markdown',
      txt: 'text/plain',
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      ts: 'application/typescript',
      py: 'text/x-python',
    };
    return map[ext] || 'application/octet-stream';
  };

  /**
   * @param {any} raw  Conversation JSON from claude.ai API
   * @param {{ inlineTextFiles?: boolean }} [options]
   * @returns {{
   *   conversation: import('../../core/utils.js').NormalizedConversation,
   *   imageRefs: Array<{turnIndex:number, blockIndex:number, ref:any}>,
   *   binaryAttachmentRefs: Array<{turnIndex:number, attIndex:number}>,
   *   textFileRefs: Array<{turnIndex:number, attIndex:number}>
   * }}
   */
  const normalize = (raw, options) => {
    const opts = options || {};
    const ordered = orderMessages(raw);
    const artifactMap = new Map(); // id → Artifact
    const viewHarvest = opts.inlineTextFiles ? harvestViewToolContent(ordered) : null;
    // Shared across blocks: sandbox files by path (create_file / Write and
    // their edits). Per turn: citation sources and the raw text they number.
    const ctx = { artifactMap, files: new Map(), toolInputs: new Map(), turnSources: new Map(), turnText: [] };

    const turns = [];
    const imageRefs = [];
    const binaryAttachmentRefs = [];
    const textFileRefs = [];

    for (let ti = 0; ti < ordered.length; ti++) {
      const m = ordered[ti];
      const role = m.sender === 'human' ? 'human' : 'assistant';
      const blocks = [];
      ctx.turnSources = new Map();
      ctx.turnText = [];

      // Long chats get compacted: the model continues from a summary of
      // what came before. Reasoning-level detail, like thinking.
      const compaction = extractToolResultText(m.compaction_summary);
      if (compaction.trim()) {
        blocks.push({ kind: 'thinking', text: `**Context compacted here.** Summary the model continued from:\n\n${compaction}` });
      }

      // Files[] images render inline at the top of the message (matches the
      // way claude.ai displays uploaded/pasted images above the user's text).
      // Plus files handed over with SendUserFile / present_files that
      // files[] doesn't list (it often doesn't for Write-era outputs).
      const filesResult = transformFiles(
        [...(Array.isArray(m.files) ? m.files : []), ...deliveredFiles(m)],
        opts,
        viewHarvest
      );
      const fileImageUuids = new Set();
      for (const item of filesResult.imageItems) {
        const blockIndex = blocks.length;
        blocks.push(item.block);
        imageRefs.push({ turnIndex: ti, blockIndex, ref: item.ref });
        if (item.ref.fileUuid) fileImageUuids.add(item.ref.fileUuid);
      }

      const contentArr = Array.isArray(m.content) ? m.content : [];
      if (contentArr.length === 0 && typeof m.text === 'string' && m.text) {
        blocks.push({ kind: 'text', text: m.text });
      } else {
        for (const c of contentArr) {
          const produced = transformBlock(c, ctx);
          for (const item of produced) {
            // claude.ai also lists uploaded images as `image` content blocks
            // pointing at the same file_uuid as files[] -- already emitted
            // above with the real file name, so skip the duplicate.
            if (item._imageRef && item._imageRef.fileUuid &&
                fileImageUuids.has(item._imageRef.fileUuid)) {
              continue;
            }
            const blockIndex = blocks.length;
            blocks.push(item.block);
            if (item._imageRef) {
              imageRefs.push({ turnIndex: ti, blockIndex, ref: item._imageRef });
            }
          }
        }
      }

      // Cited sources the reply's own text doesn't already link to.
      if (ctx.turnSources.size) {
        const plain = ctx.turnText.join('\n');
        const missing = new Set([...ctx.turnSources.keys()].filter((url) => !plain.includes(url)));
        if (missing.size) blocks.push({ kind: 'text', text: `**Sources**\n\n${formatSources(ctx.turnSources, missing)}` });
      }

      const attachments = [
        ...transformAttachments(m.attachments),
        ...filesResult.attachments,
      ];
      attachments.forEach((att, attIndex) => {
        if (att.category === 'binary' && att.fileUuid) {
          binaryAttachmentRefs.push({ turnIndex: ti, attIndex });
        } else if (att.category === 'text' && att.needsContentFetch && att.fileUuid) {
          textFileRefs.push({ turnIndex: ti, attIndex });
        }
      });

      turns.push({
        role,
        createdAt: typeof m.created_at === 'string' ? m.created_at : undefined,
        // Dictated messages (the renderer marks them with 🎙️).
        isVoice: m.input_mode === 'speech_input' || undefined,
        blocks,
        attachments,
      });
    }

    const conversation = {
      title: typeof raw.name === 'string' && raw.name ? raw.name : 'Claude conversation',
      sourceLLM: 'claude',
      model: typeof raw.model === 'string' ? raw.model : undefined,
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined,
      updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
      turns,
      artifacts: Array.from(artifactMap.values()),
    };

    log.debug('claude normalize done:',
      { turns: turns.length, artifacts: conversation.artifacts.length });

    return { conversation, imageRefs, binaryAttachmentRefs, textFileRefs };
  };

  ns.claudeNormalize = { normalize };
})();
