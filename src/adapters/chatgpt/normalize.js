/**
 * Convert raw chatgpt.com /backend-api/conversation/{id} JSON into our
 * NormalizedConversation shape.
 *
 * Conversation tree:
 *   raw.mapping is a graph keyed by node id. Each node = { id, parent,
 *   children:[id], message? }. We walk current_node up via parent, reverse,
 *   then filter and map nodes to turn blocks.
 *
 * Visibility filter (drop the node entirely):
 *   - message missing or message.author.role === 'system'
 *   - metadata.is_visually_hidden_from_conversation === true
 *   - content_type ∈ { user_editable_context, model_editable_context }
 *
 * Role grouping:
 *   - author.role === 'user'                         → human turn
 *   - author.role ∈ { assistant, tool }              → assistant turn
 *   Consecutive same-role nodes coalesce into one turn so that the assistant's
 *   reasoning trace + tool dance + final answer all live under one "## Assistant".
 *
 * Content-type mapping (note: role and channel override these; see below):
 *   - text                  parts:[string]                          → text block(s)
 *   - multimodal_text       parts:[string | image_asset_pointer]   → text + image blocks
 *   - thoughts              {thoughts:[{summary,content}]}          → thinking block
 *   - reasoning_recap       {content:"Thought for ..."}             → thinking block (small)
 *   - code                  {language,text}                         → tool_call (commentary) or text (final)
 *   - execution_output      {text}                                  → tool_result
 *   - tether_*              search/citation payloads                → tool_call (with includeReasoning)
 *   - everything else                                                → tool_call dump
 *
 * Role/channel overrides (applied BEFORE the content-type table):
 *   - role==='tool' + text                            → tool_result
 *   - role==='tool' + multimodal_text (strings only) → tool_result
 *     file_search/web.run/container.exec emit text-shaped payloads that look
 *     like prose but are raw context fed to the model (parsed PDF pages,
 *     "Make sure to include filecite…" boilerplate). Without this rule the
 *     full text of every uploaded PDF leaks into the assistant turn.
 *   - role==='tool' + multimodal_text with image_asset_pointer → falls
 *     through to the multimodal_text handler. This is the image-generation
 *     tool's deliverable (the picture itself); we must keep it.
 *   - role==='assistant' + channel==='commentary'    → thinking
 *     "Thinking preamble" messages flash in the UI before tool calls but
 *     aren't part of the final answer.
 *
 * Files / images:
 *   image_asset_pointer.asset_pointer = "sediment://file-..." → register an
 *   image block; bytes fetched in content.js via the two-step download API.
 *   File attachments (PDFs, audio, etc.) appear in message.metadata.attachments
 *   as {id, name, mime_type, ...}; we surface them as binary attachments.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { safeStringify, isTextLikeMime, sanitizeFilename } = ns.utils;

  const isObject = (v) => v !== null && typeof v === 'object';

  /** Walk current_node → root via parent; return root → leaf order. */
  const orderNodes = (raw) => {
    const mapping = isObject(raw) && isObject(raw.mapping) ? raw.mapping : {};
    let cur = raw && raw.current_node;
    if (!cur) {
      // Fallback: walk all nodes that have a message, sorted by create_time.
      return Object.values(mapping)
        .filter((n) => isObject(n) && isObject(n.message))
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    }
    const acc = [];
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n = mapping[cur];
      if (!n) break;
      acc.push(n);
      cur = n.parent || null;
    }
    return acc.reverse();
  };

  /** Hidden-from-user filter — return true iff this node should NOT appear. */
  const shouldDropNode = (node) => {
    const m = node && node.message;
    if (!isObject(m)) return true;
    const role = m.author && m.author.role;
    if (role === 'system') return true;
    const meta = isObject(m.metadata) ? m.metadata : {};
    if (meta.is_visually_hidden_from_conversation === true) return true;
    const ct = m.content && m.content.content_type;
    if (ct === 'user_editable_context' || ct === 'model_editable_context') return true;
    return false;
  };

  const effectiveTurnRole = (m) => {
    const role = m && m.author && m.author.role;
    return role === 'user' ? 'human' : 'assistant';
  };

  /**
   * Strip ChatGPT's citation markers from a text string.
   *
   * The SPA wraps citation tokens (`filecite…`, `webcite…`, etc.) in Private
   * Use Area Unicode chars and renders them as file/source preview chips in
   * the UI. The DOM never shows the raw `fileciteturn0file0` text — only the
   * chip. Our export pulls the conversation tree directly, so these markers
   * leak through and look like garbage in the .md.
   *
   * Real-world structure of one marker (observed in Deep Research output):
   *
   *   U+E200 cite U+E202 turn21view7 U+E202 turn25view2 U+E202 … U+E201
   *
   * — opening char U+E200, then the citation type (`cite`, `webcite`, …),
   * then U+E202 separators between each ref id, and a closing U+E201. The
   * older "any-PUA-pair" regex only ate the first U+E200…U+E202 pair and
   * left the ref names and inner separators visible. Lazy-matching from
   * U+E200 to U+E201 sweeps the whole token in one go.
   *
   * We strip the entire marker rather than try to reconstruct the chip
   * (matched file name lives in `metadata.content_references`, but the
   * inline reference is rarely useful in a read-back export). Cleans up
   * the residue too: double spaces collapse, space-before-punctuation
   * collapses, and per-line trailing whitespace gets trimmed.
   */
  const CITE_MARKER_RE = /\uE200[\s\S]*?\uE201/g;
  const stripCiteMarkers = (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text.replace(CITE_MARKER_RE, '');
    if (out === text) return text;
    out = out.replace(/ {2,}/g, ' ');
    out = out.replace(/ +([.,;:!?])/g, '$1');
    out = out.replace(/[ \t]+$/gm, '');
    return out;
  };

  /** Pull plain text out of a `parts` array, ignoring non-string entries. */
  const partsToText = (parts) => {
    if (!Array.isArray(parts)) return '';
    return stripCiteMarkers(
      parts.filter((p) => typeof p === 'string').join('\n\n').trim()
    );
  };

  /**
   * Scan an assistant text block for `[label](sandbox:/path)` references —
   * pointers to files the model produced inside its python/interpreter
   * sandbox. These files don't exist in the conversation tree as
   * `sediment://file_…` ids; the only way to retrieve their bytes is via the
   * `/conversation/<id>/interpreter/download` endpoint, keyed by the
   * referencing message's id + sandbox path.
   *
   * The label inside the markdown link is what the user sees ("Download the
   * report"); the path's basename is the actual filename on disk. We use
   * the basename as the attachment fileName so zip output is sensible
   * (`files/report.md` rather than `files/Download the report`).
   *
   * Returns Array<{sandboxPath, fileName}>. Duplicate paths inside the same
   * text block are collapsed; cross-block / cross-turn dedup happens in
   * the main normalize() loop.
   */
  const SANDBOX_LINK_RE = /\[[^\]\n]*\]\(sandbox:([^)\s]+)\)/g;
  const extractSandboxLinks = (text) => {
    const refs = [];
    if (typeof text !== 'string' || !text) return refs;
    const seen = new Set();
    SANDBOX_LINK_RE.lastIndex = 0;
    let m;
    while ((m = SANDBOX_LINK_RE.exec(text)) !== null) {
      const sandboxPath = m[1].trim();
      if (!sandboxPath || seen.has(sandboxPath)) continue;
      seen.add(sandboxPath);
      // basename, with URL decoding if the model emitted percent-escapes
      let tail = sandboxPath.split('/').pop() || sandboxPath;
      try {
        tail = decodeURIComponent(tail);
      } catch {
        /* leave as-is */
      }
      refs.push({ sandboxPath, fileName: tail });
    }
    return refs;
  };

  /**
   * ChatGPT "canvas" textdocs — the model writes structured documents (HTML,
   * Python, Markdown…) into a side panel via tool calls. Two relevant
   * recipients on assistant messages:
   *
   *   canmore.create_textdoc   { name, type, content }
   *   canmore.update_textdoc   { updates: [{ pattern, replacement, multiple? }] }
   *
   * These map cleanly onto our existing `artifact` concept (Claude artifacts
   * use the same shape). We parse the tool-call JSON, register the document
   * as an artifact, and emit an `artifact_ref` block at the call site.
   * Updates apply regex pattern→replacement edits to the most recently
   * created canvas. Tool responses are dropped — the artifact replaces them.
   */
  const parseCanmoreCreate = (jsonText) => {
    try {
      const obj = JSON.parse(jsonText);
      if (!isObject(obj)) return null;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      const type = typeof obj.type === 'string' ? obj.type.trim() : '';
      const cnt = typeof obj.content === 'string' ? obj.content : '';
      if (!cnt) return null;
      return { name, type, content: cnt };
    } catch {
      return null;
    }
  };

  const parseCanmoreUpdate = (jsonText) => {
    try {
      const obj = JSON.parse(jsonText);
      if (!isObject(obj) || !Array.isArray(obj.updates)) return null;
      const updates = [];
      for (const u of obj.updates) {
        if (!isObject(u)) continue;
        if (typeof u.pattern !== 'string' || typeof u.replacement !== 'string') continue;
        updates.push({
          pattern: u.pattern,
          replacement: u.replacement,
          multiple: u.multiple === true,
        });
      }
      return updates.length ? { updates } : null;
    } catch {
      return null;
    }
  };

  /**
   * Apply a sequence of canmore pattern/replacement edits to a string.
   * Canvas uses dotall semantics: `.` matches across newlines. The
   * `multiple` flag controls global vs. single replacement. Bad regexes
   * are silently skipped — an unparseable model-emitted pattern should
   * not crash the export, and keeping stale content beats losing the
   * whole artifact.
   */
  const applyCanvasUpdates = (content, updates) => {
    let out = content;
    for (const u of updates) {
      try {
        const flags = u.multiple ? 'gs' : 's';
        const re = new RegExp(u.pattern, flags);
        out = out.replace(re, u.replacement);
      } catch {
        /* leave content unchanged for this update */
      }
    }
    return out;
  };

  /**
   * Decide markdown language + filename for a canvas document.
   *
   * `type` shapes observed on chatgpt.com:
   *   code/<lang>     fenced under <lang>; extension derived from LANG_TO_EXT
   *   document, ""    treat as markdown doc (.md)
   *
   * If `name` already has an extension, we honor it. Otherwise we tack one
   * on so the artifact lands as `artifacts/<sensible name>.<ext>` in zip
   * mode.
   */
  const LANG_TO_EXT = {
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    markdown: 'md',
    html: 'html',
    css: 'css',
    json: 'json',
    yaml: 'yaml',
    bash: 'sh',
    shell: 'sh',
  };
  const deriveCanvasMeta = (name, type) => {
    let language = '';
    let extFallback = '';
    if (typeof type === 'string' && type.startsWith('code/')) {
      language = type.slice(5).toLowerCase();
      extFallback = '.' + (LANG_TO_EXT[language] || language || 'txt');
    } else {
      // `document`, empty, or anything we don't recognize → markdown doc.
      language = 'markdown';
      extFallback = '.md';
    }
    let fileName = (name || 'canvas-document').trim();
    fileName = fileName.replace(/^[\\\/]+/, ''); // strip any leading slashes
    if (!/\.[a-z0-9]+$/i.test(fileName) && extFallback) fileName += extFallback;
    return { language, fileName };
  };

  /**
   * ChatGPT Apps SDK reports — Deep Research, custom connectors that render
   * inside the chat as an embedded widget. The visible assistant message has
   * `chatgpt_sdk_suppressed_response: true` with empty parts (because the UI
   * paints the report from the widget, not from the assistant text). The
   * actual report text lives buried in the matching tool response under
   * `metadata.chatgpt_sdk.widget_state` — a STRINGIFIED JSON containing the
   * widget's full state, including a `report_message` once the run is done.
   *
   * We extract the report and route it through the existing artifact pipeline
   * so it lands as `🧩 [Title.md](…)` inline + a separate file in `/artifacts/`
   * in zip mode, or as a "## Artifacts" section in md mode.
   *
   * Returns null when there's no widget_state, it can't be parsed, the run
   * isn't yet complete (status !== "completed"), or no report_message has
   * been produced. Intermediate plan states (status:
   * waiting_for_user_response_on_plan, in_progress, …) are ignored so the
   * same widget appearing across multiple tool turns only surfaces once.
   */
  const parseAppsSdkReport = (m) => {
    const meta = isObject(m.metadata) ? m.metadata : null;
    if (!meta) return null;
    const sdk = isObject(meta.chatgpt_sdk) ? meta.chatgpt_sdk : null;
    if (!sdk) return null;

    const widgetStateRaw = typeof sdk.widget_state === 'string' ? sdk.widget_state : '';
    if (!widgetStateRaw) return null;

    let widgetState;
    try {
      widgetState = JSON.parse(widgetStateRaw);
    } catch {
      return null;
    }
    if (!isObject(widgetState)) return null;
    if (widgetState.status !== 'completed') return null;

    const reportMsg = widgetState.report_message;
    if (!isObject(reportMsg) || !isObject(reportMsg.content)) return null;
    if (reportMsg.content.content_type !== 'text') return null;

    const parts = Array.isArray(reportMsg.content.parts) ? reportMsg.content.parts : [];
    const text = parts.filter((p) => typeof p === 'string').join('\n\n').trim();
    if (!text) return null;

    const cleaned = stripCiteMarkers(text);

    // Title preference: plan title (set when the deep-research planner ran),
    // then the report's first H1, then a generic fallback.
    let title = '';
    if (
      isObject(widgetState.plan) &&
      typeof widgetState.plan.title === 'string' &&
      widgetState.plan.title.trim()
    ) {
      title = widgetState.plan.title.trim();
    }
    if (!title) {
      const h1 = cleaned.match(/^\s*#\s+(.+?)\s*$/m);
      if (h1) title = h1[1].trim();
    }
    if (!title) title = 'Deep Research Report';

    // Session id used by the main loop to dedupe across the multiple tool
    // turns the same widget produces while updating its state. We prefer the
    // ChatGPT widget session id; the conversation-level session id is a
    // weaker fallback.
    const sessionId =
      (typeof sdk.widget_session_id === 'string' && sdk.widget_session_id) ||
      (typeof sdk.async_task_conversation_id === 'string' && sdk.async_task_conversation_id) ||
      '';

    // Friendly source label — `app_name` is the human-readable connector
    // name when present (eg "Deep Research App"). Used to caption the
    // artifact_ref in the conversation body. Strip a trailing " App" so
    // "Result of Deep Research" reads cleaner than "Result of Deep
    // Research App".
    let source =
      (isObject(meta.invoked_resource) && typeof meta.invoked_resource.app_name === 'string'
        ? meta.invoked_resource.app_name
        : '') ||
      (typeof sdk.app_name === 'string' ? sdk.app_name : '') ||
      'Apps SDK';
    source = source.replace(/\s+App$/i, '').trim() || 'Apps SDK';

    return { title, content: cleaned, sessionId, source };
  };

  /**
   * Transform one chatgpt message's content into normalized blocks.
   * Returns Array<{
   *   block?: NormalizedBlock,
   *   _imageRef?: {fileId},
   *   _canvasCreate?: {name, type, content},
   *   _canvasUpdate?: {updates},
   *   _canvasResponse?: {tool, textdoc_id, title},
   *   _appsSdkReport?: {title, content, sessionId, source}
   * }>.
   *
   * The `_canvas*` markers are consumed in normalize()'s main loop, where
   * we have the conversation-wide artifact state. Items with only a
   * marker (no `block`) contribute nothing to the visible turn body.
   *
   * `imageRef` = { fileId } — content.js will resolve to bytes via
   * chatgptApi.fetchFile(fileId, convId, token).
   */
  const transformMessage = (m) => {
    const content = isObject(m.content) ? m.content : null;
    const meta = isObject(m.metadata) ? m.metadata : {};
    const role = m.author && m.author.role;
    const channel = typeof m.channel === 'string' ? m.channel : '';
    const ct = content && content.content_type;
    const out = [];

    if (!content) return out;

    // Apps SDK (Deep Research and other ChatGPT connectors that render an
    // embedded widget) — three distinct messages to handle BEFORE everything
    // else, all related to a single widget invocation:
    //
    //   1. Assistant `code` with recipient `api_tool.call_tool` — the request
    //      that opens the widget. The args.user_query just repeats what the
    //      user already asked one turn earlier, so the tool_call dump is pure
    //      duplication. Drop.
    //
    //   2. Tool messages from `api_tool*` — intermediate plan states
    //      (waiting_for_user_response_on_plan, in_progress) AND the final
    //      one with the completed report. parseAppsSdkReport returns the
    //      report only when status==='completed' with a report_message; we
    //      emit an `_appsSdkReport` marker the main loop turns into an
    //      artifact. Other intermediate states are dropped silently so they
    //      don't surface as noisy tool_result dumps.
    //
    //   3. Assistant `text` with `chatgpt_sdk_suppressed_response: true` and
    //      empty parts — the SPA paints the report from the widget, so the
    //      "real" assistant text is intentionally blank. Drop or we'd emit
    //      an empty `## Assistant` heading right after the artifact link.
    if (
      role === 'assistant' &&
      ct === 'code' &&
      typeof m.recipient === 'string' &&
      m.recipient === 'api_tool.call_tool'
    ) {
      return out;
    }
    if (role === 'tool' && typeof m.author?.name === 'string' && m.author.name.startsWith('api_tool')) {
      const report = parseAppsSdkReport(m);
      if (report) {
        out.push({ _appsSdkReport: report });
      }
      return out;
    }
    if (
      role === 'assistant' &&
      ct === 'text' &&
      meta.chatgpt_sdk_suppressed_response === true &&
      !partsToText(content.parts)
    ) {
      return out;
    }

    // Canvas (side-panel docs). Intercept canmore.* create/update tool calls
    // and their matching tool responses BEFORE the generic tool/code handlers
    // below so we can surface the document as an artifact rather than as a
    // pile of tool_call JSON dumps.
    if (role === 'assistant' && ct === 'code') {
      const recipient = typeof m.recipient === 'string' ? m.recipient : '';
      const codeText = typeof content.text === 'string' ? content.text : '';
      if (recipient === 'canmore.create_textdoc') {
        const parsed = parseCanmoreCreate(codeText);
        if (parsed) {
          out.push({ _canvasCreate: parsed });
          return out;
        }
        // unparseable → fall through to generic code handling below (don't lose data)
      } else if (recipient === 'canmore.update_textdoc') {
        const parsed = parseCanmoreUpdate(codeText);
        if (parsed) {
          out.push({ _canvasUpdate: parsed });
          return out;
        }
      }
    }
    if (role === 'tool' && ct === 'text') {
      const toolName = m.author && m.author.name;
      if (toolName === 'canmore.create_textdoc' || toolName === 'canmore.update_textdoc') {
        // The textual body is just "Successfully created/updated text document
        // 'X' with textdoc_id 'Y'" — noise once the artifact itself is
        // surfaced. We still capture textdoc_id and the human-readable title
        // from metadata.canvas so the main normalize loop can bind them.
        const canvasMeta = isObject(meta.canvas) ? meta.canvas : null;
        out.push({
          _canvasResponse: {
            tool: toolName,
            textdoc_id:
              canvasMeta && typeof canvasMeta.textdoc_id === 'string'
                ? canvasMeta.textdoc_id
                : '',
            title:
              canvasMeta && typeof canvasMeta.title === 'string' ? canvasMeta.title : '',
          },
        });
        return out;
      }
    }

    // Tool-role text payloads are NEVER user-visible content. file_search,
    // web.run, container.exec and friends emit `content_type:"text"` /
    // `"multimodal_text"` strings that look like prose but are raw context
    // fed to the model (parsed PDF pages, "All files loaded" status pings,
    // "Make sure to include filecite…" boilerplate). Surface them as
    // tool_result so they're hidden by default and only show with
    // reasoning on. Without this the export leaks the full text of every
    // uploaded PDF into the assistant turn.
    //
    // EXCEPTION: tool multimodal_text containing image_asset_pointer parts
    // is the image-generation tool's actual deliverable (the picture the
    // user asked for). Those need to fall through to the normal
    // multimodal_text handler below so they become real image blocks.
    if (role === 'tool' && ct === 'text') {
      const text = partsToText(content.parts);
      if (text) out.push({ block: { kind: 'tool_result', text, isError: false } });
      return out;
    }
    if (role === 'tool' && ct === 'multimodal_text') {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      // The exception (fall-through to image rendering) only applies to
      // genuine image-generation output. file_search ALSO emits
      // image_asset_pointer parts for PDF page thumbnails it uses
      // internally for visual grounding — those have asset pointers like
      // `sediment://<hash>#file_<id>#p_<N>.<hash>.jpg` (note the `#`
      // separators) and are NOT user-visible images.
      //
      // Distinguish by asset_pointer shape: image-gen output is always
      // `sediment://file_<hex>` with nothing after the file id. Anything
      // with `#` segments is internal tool plumbing and must NOT leak
      // into the conversation.
      const CLEAN_POINTER_RE = /^sediment:\/\/file_[a-f0-9]+$/i;
      const hasRealImage = parts.some(
        (p) =>
          isObject(p) &&
          p.content_type === 'image_asset_pointer' &&
          typeof p.asset_pointer === 'string' &&
          CLEAN_POINTER_RE.test(p.asset_pointer)
      );
      if (!hasRealImage) {
        // file_search, web.run, container.exec results all land here.
        // Keep string parts (the human-readable tool output); drop
        // asset_pointer thumbnails entirely. Hidden behind reasoning toggle.
        const text = parts
          .filter((p) => typeof p === 'string')
          .join('\n\n')
          .trim();
        if (text) out.push({ block: { kind: 'tool_result', text, isError: false } });
        return out;
      }
      // else: real image-gen output, fall through to the multimodal_text handler.
    }

    // Assistant "commentary" messages are pre-tool-call thinking preambles
    // ("I'll check the docs first…", flagged with channel:"commentary" and
    // metadata.is_thinking_preamble_message). They flash in the chat UI
    // while the model reasons but aren't part of the final answer. Treat
    // as thinking so the include-reasoning toggle controls visibility.
    if (role === 'assistant' && channel === 'commentary' && ct === 'text') {
      const text = partsToText(content.parts);
      if (text) out.push({ block: { kind: 'thinking', text } });
      return out;
    }

    if (ct === 'text') {
      const text = partsToText(content.parts);
      if (!text) return out;
      // Assistant -> tool dispatch: the message has content_type "text" but
      // recipient is a specific tool id (e.g. image-gen's "t2uay3k.sj1i4kz"
      // or "file_search.msearch"), and the body is the JSON/text payload
      // being sent to that tool. Not user-visible content. Surface as a
      // tool_call so it's hidden unless reasoning is on. Mirrors the same
      // recipient check that already exists in the `code` branch below.
      const recipient = typeof m.recipient === 'string' ? m.recipient : '';
      if (role === 'assistant' && recipient && recipient !== 'all') {
        out.push({ block: { kind: 'tool_call', name: recipient, input: text } });
      } else {
        out.push({ block: { kind: 'text', text } });
      }
      return out;
    }

    if (ct === 'multimodal_text') {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      // Voice-mode messages carry BOTH an audio_transcription part (the
      // recognized text) AND an audio asset pointer (the raw wav). If we
      // have the transcription, the audio pointer becomes noise — the user
      // already sees the spoken content as text. Pre-scan so the loop below
      // can suppress the placeholder when a transcription is present.
      const hasTranscription = parts.some(
        (p) => isObject(p) && p.content_type === 'audio_transcription' && typeof p.text === 'string' && p.text.trim()
      );
      for (const p of parts) {
        if (typeof p === 'string') {
          const cleaned = stripCiteMarkers(p);
          if (cleaned.trim()) out.push({ block: { kind: 'text', text: cleaned } });
          continue;
        }
        if (!isObject(p)) continue;
        if (p.content_type === 'audio_transcription' && typeof p.text === 'string') {
          // Voice message recognized text. Both user (direction:'in') and
          // assistant (direction:'out') speak through this content type;
          // we surface both as plain text blocks within their existing turn.
          const text = stripCiteMarkers(p.text).trim();
          if (text) out.push({ block: { kind: 'text', text } });
          continue;
        }
        if (p.content_type === 'image_asset_pointer' && typeof p.asset_pointer === 'string') {
          // Defensive: only accept asset pointers in the canonical
          // `sediment://file_<hex>` shape. Anything containing `#` is a
          // file_search-style thumbnail (PDF page snapshot etc.) that
          // can't actually be fetched and shouldn't render as a broken
          // image placeholder in the export.
          if (!/^sediment:\/\/file_[a-f0-9]+$/i.test(p.asset_pointer)) continue;
          const fileId = p.asset_pointer.replace(/^sediment:\/\//, '');
          if (!fileId) continue;
          const mime = typeof p.metadata?.mime_type === 'string' ? p.metadata.mime_type : 'image/png';
          out.push({
            block: {
              kind: 'image',
              mime,
              name: fileId,
              bytes: new Uint8Array(0),
            },
            _imageRef: { fileId },
          });
          continue;
        }
        if (p.content_type === 'audio_asset_pointer' || p.content_type === 'real_time_user_audio_video_asset_pointer') {
          // Audio/video asset pointers — not embeddable inline. When a sibling
          // audio_transcription already gave us the text, drop the placeholder
          // entirely. Otherwise surface a marker so the user knows an audio
          // attachment existed.
          if (hasTranscription) continue;
          out.push({ block: { kind: 'text', text: `_[${p.content_type.replace(/_asset_pointer$/, '')} attachment]_` } });
          continue;
        }
      }
      return out;
    }

    if (ct === 'thoughts') {
      const arr = Array.isArray(content.thoughts) ? content.thoughts : [];
      const text = arr
        .map((t) => {
          if (!isObject(t)) return '';
          const summary = typeof t.summary === 'string' ? stripCiteMarkers(t.summary).trim() : '';
          const body = typeof t.content === 'string' ? stripCiteMarkers(t.content).trim() : '';
          if (summary && body) return `**${summary}**\n\n${body}`;
          return summary || body;
        })
        .filter(Boolean)
        .join('\n\n');
      if (text) out.push({ block: { kind: 'thinking', text } });
      return out;
    }

    if (ct === 'reasoning_recap') {
      const text = typeof content.content === 'string' ? stripCiteMarkers(content.content).trim() : '';
      if (text) out.push({ block: { kind: 'thinking', text } });
      return out;
    }

    if (ct === 'code') {
      const language = typeof content.language === 'string' ? content.language : '';
      const text = typeof content.text === 'string' ? content.text : '';
      const recipient = typeof m.recipient === 'string' ? m.recipient : '';
      if (recipient && recipient !== 'all') {
        // Assistant invoking a tool. Render as a tool_call so it's hidden
        // unless includeReasoning is on.
        out.push({
          block: {
            kind: 'tool_call',
            name: recipient,
            input: language ? `[${language}]\n${text}` : text,
          },
        });
      } else {
        // Code emitted as user-facing content (rare; usually rendered as text).
        // Wrap in a fenced block via plain text so the markdown layer formats it.
        const fenced = '```' + (language || '') + '\n' + text + '\n```';
        out.push({ block: { kind: 'text', text: fenced } });
      }
      return out;
    }

    if (ct === 'execution_output') {
      const text = typeof content.text === 'string' ? content.text : '';
      out.push({
        block: { kind: 'tool_result', text, isError: false },
      });
      return out;
    }

    if (ct === 'tether_browsing_display' || ct === 'tether_quote') {
      // Web-search rendering payloads. Useful only with reasoning on; dump
      // the JSON for transparency.
      out.push({
        block: {
          kind: 'tool_call',
          name: ct,
          input: safeStringify(content),
        },
      });
      return out;
    }

    if (ct === 'system_error') {
      const text = typeof content.text === 'string' ? content.text : safeStringify(content);
      out.push({ block: { kind: 'tool_result', text, isError: true } });
      return out;
    }

    // Fallback: dump the entire content under a tool_call so it's preserved
    // when reasoning is on but doesn't pollute the main thread.
    out.push({
      block: {
        kind: 'tool_call',
        name: `chatgpt:${ct || 'unknown'}${role && role !== 'assistant' ? `(${role})` : ''}`,
        input: safeStringify(content),
      },
    });
    return out;
  };

  /**
   * Pull file/audio attachments from message.metadata.attachments. ChatGPT
   * lists user-uploaded files there with { id, name, mime_type, size, ... }.
   * `id` is the same `file-...` you'd pass to fetchFile (no sediment:// prefix
   * is needed; fetchFile strips one if present).
   *
   * When inlineTextFiles is on, text-like uploads are flagged 'text' with
   * needsContentFetch:true so content.js can fetch the bytes and decode them
   * inline (matches the Claude adapter's behavior).
   */
  const transformAttachments = (m, opts) => {
    const inlineTextFiles = !!(opts && opts.inlineTextFiles);
    const meta = isObject(m.metadata) ? m.metadata : {};
    const list = Array.isArray(meta.attachments) ? meta.attachments : [];
    const out = [];
    for (const a of list) {
      if (!isObject(a)) continue;
      const fileId = typeof a.id === 'string' ? a.id : '';
      if (!fileId) continue;
      const fileName = typeof a.name === 'string' && a.name ? a.name : `${fileId}`;
      const mime = typeof a.mime_type === 'string' ? a.mime_type : 'application/octet-stream';
      const size = typeof a.size === 'number' ? a.size : undefined;
      const isImage = mime.startsWith('image/');
      if (isImage) {
        // Image attachments without an inline image_asset_pointer in
        // multimodal_text — surface as a binary attachment. (Inline images
        // go through transformMessage's image_asset_pointer branch instead.)
        out.push({
          category: 'binary',
          fileName,
          mime,
          fileUuid: fileId,
          isImage: true,
          size,
        });
        continue;
      }
      if (inlineTextFiles && isTextLikeMime(mime, fileName)) {
        out.push({
          category: 'text',
          fileName,
          mime,
          text: '',
          fileUuid: fileId,
          needsContentFetch: true,
          size,
        });
        continue;
      }
      out.push({
        category: 'binary',
        fileName,
        mime,
        fileUuid: fileId,
        isImage: false,
        size,
      });
    }
    return out;
  };

  /**
   * Best-effort title + model extraction.
   * - title: raw.title (chatgpt.com sets it after first reply).
   * - model: first assistant message's metadata.model_slug or
   *   default_model_slug.
   * - createdAt/updatedAt: raw.create_time / raw.update_time as ISO.
   */
  const extractMeta = (raw, ordered) => {
    const title = typeof raw.title === 'string' && raw.title ? raw.title : 'ChatGPT conversation';
    let model;
    for (const node of ordered) {
      const m = node && node.message;
      if (!isObject(m)) continue;
      if (m.author && m.author.role === 'assistant') {
        const meta = isObject(m.metadata) ? m.metadata : {};
        model = meta.model_slug || meta.default_model_slug;
        if (model) break;
      }
    }
    const toIso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t * 1000).toISOString() : undefined);
    return {
      title,
      model,
      createdAt: toIso(raw.create_time),
      updatedAt: toIso(raw.update_time),
    };
  };

  /**
   * @param {any} raw  Conversation JSON from chatgpt.com backend
   * @returns {{
   *   conversation: import('../../core/utils.js').NormalizedConversation,
   *   imageRefs: Array<{turnIndex:number, blockIndex:number, ref:{fileId:string}}>,
   *   binaryAttachmentRefs: Array<{turnIndex:number, attIndex:number}>,
   *   textFileRefs: Array<{turnIndex:number, attIndex:number}>
   * }}
   */
  const normalize = (raw, options) => {
    const opts = options || {};
    const ordered = orderNodes(raw);
    const turns = [];
    const imageRefs = [];
    const binaryAttachmentRefs = [];
    const textFileRefs = [];

    let currentRole = null; // 'human' | 'assistant'
    let currentBlocks = null;
    let currentAttachments = null;
    let currentCreatedAt = undefined;
    // Voice flag: true once any message in the current turn was sent via
    // voice mode. Used by markdown.js to append a 🎙️ marker to the role
    // heading so the transcribed text is contextualized (helps a reader
    // make sense of disfluencies and recognition errors).
    let currentIsVoice = false;
    // Sandbox files referenced in assistant text. Tracked at conversation
    // scope (not per-turn) because the same file is often mentioned in
    // multiple messages — we register the synthetic attachment exactly
    // once, on the first turn where it appears.
    const sandboxPathsSeen = new Set();
    // Canvas (canmore) state. `artifacts` accumulates the conversation-wide
    // list (mirrors Claude's artifact array). `currentArtifact` points at
    // the last create so subsequent update_textdoc edits apply to the right
    // document — ChatGPT lets only one canvas be "active" at a time, and
    // update calls don't carry textdoc_id, so most-recent-create wins.
    const artifacts = [];
    let currentArtifact = null;
    // Apps SDK reports (Deep Research and similar embedded widgets) are
    // surfaced as artifacts too. `appsSdkArtifactBySession` maps the
    // widget's session id → the artifact we already created, so subsequent
    // tool turns for the same widget refresh content/title in place instead
    // of producing duplicates. We register the artifact_ref block ONLY on
    // first sighting; later updates just mutate the existing artifact.
    const appsSdkArtifactBySession = new Map();

    const flush = () => {
      if (!currentRole) return;
      turns.push({
        role: currentRole,
        createdAt: currentCreatedAt,
        isVoice: currentIsVoice,
        blocks: currentBlocks,
        attachments: currentAttachments,
      });
      currentRole = null;
      currentBlocks = null;
      currentAttachments = null;
      currentCreatedAt = undefined;
      currentIsVoice = false;
    };

    for (const node of ordered) {
      if (shouldDropNode(node)) continue;
      const m = node.message;
      const role = effectiveTurnRole(m);
      if (role !== currentRole) {
        flush();
        currentRole = role;
        currentBlocks = [];
        currentAttachments = [];
        if (typeof m.create_time === 'number' && Number.isFinite(m.create_time)) {
          currentCreatedAt = new Date(m.create_time * 1000).toISOString();
        }
      }

      const ti = turns.length; // future turn index after flush

      // OR-merge per-message voice signals into the turn. We check both the
      // explicit `voice_mode_message` flag and fall back to "has any
      // audio_transcription part" -- the flag is the canonical signal, the
      // fallback catches edge cases where the message metadata is missing
      // but the content is clearly transcribed audio.
      if (m.metadata && m.metadata.voice_mode_message === true) {
        currentIsVoice = true;
      } else if (m.content && Array.isArray(m.content.parts)) {
        for (const p of m.content.parts) {
          if (isObject(p) && p.content_type === 'audio_transcription') {
            currentIsVoice = true;
            break;
          }
        }
      }

      // Build content blocks first so we know which file ids are already
      // surfaced inline as images (image_asset_pointer in multimodal_text).
      // Those should NOT be duplicated as `📎 file` attachments — common case
      // is a user-uploaded image that ChatGPT lists in BOTH the multimodal
      // content AND in metadata.attachments[].
      const blocks = transformMessage(m);
      const inlineImageIds = new Set();
      for (const item of blocks) {
        if (item._imageRef && item._imageRef.fileId) {
          inlineImageIds.add(item._imageRef.fileId);
        }
      }
      for (const item of blocks) {
        // Canvas markers (consumed here; never make it to currentBlocks
        // except via the artifact_ref we push for `create`).
        if (item._canvasCreate) {
          const { name, type, content: artContent } = item._canvasCreate;
          const cmeta = deriveCanvasMeta(name, type);
          const artifact = {
            id: `canvas-${artifacts.length}`,
            title: name || cmeta.fileName,
            fileName: cmeta.fileName,
            language: cmeta.language,
            content: artContent,
          };
          artifacts.push(artifact);
          currentArtifact = artifact;
          currentBlocks.push({ kind: 'artifact_ref', artifactId: artifact.id });
          continue;
        }
        if (item._canvasUpdate) {
          if (currentArtifact) {
            currentArtifact.content = applyCanvasUpdates(
              currentArtifact.content,
              item._canvasUpdate.updates
            );
          }
          continue;
        }
        if (item._canvasResponse) {
          // Bind the prettier title from the tool response if we have one.
          // textdoc_id is currently informational only — we key artifacts by
          // our own `canvas-N` id since update_textdoc doesn't carry an id.
          if (
            currentArtifact &&
            item._canvasResponse.tool === 'canmore.create_textdoc' &&
            item._canvasResponse.title
          ) {
            currentArtifact.title = item._canvasResponse.title;
          }
          continue;
        }
        if (item._appsSdkReport) {
          const report = item._appsSdkReport;
          const sessionKey = report.sessionId || `apps-sdk-${artifacts.length}`;
          const existing = appsSdkArtifactBySession.get(sessionKey);
          if (existing) {
            // Same widget reappeared in a later tool turn (refreshed widget_state).
            // Update content/title in place; no second artifact_ref.
            existing.content = report.content;
            if (report.title) existing.title = report.title;
            continue;
          }
          // First sighting — create artifact and insert the inline ref.
          const safeTitle = sanitizeFilename(report.title) || 'deep-research-report';
          const fileName = `${safeTitle}.md`;
          const artifact = {
            id: `apps-sdk-${artifacts.length}`,
            title: report.title,
            fileName,
            language: 'markdown',
            content: report.content,
            // `source` is rendered as `**Result of {source}:**` above the
            // artifact link by markdown.js. Set ONLY for Apps SDK reports
            // — Claude and canvas artifacts leave it undefined and keep
            // the bare `🧩 [name]` form.
            source: report.source,
          };
          artifacts.push(artifact);
          appsSdkArtifactBySession.set(sessionKey, artifact);
          currentBlocks.push({ kind: 'artifact_ref', artifactId: artifact.id });
          continue;
        }
        if (!item.block) continue;
        const blockIndex = currentBlocks.length;
        currentBlocks.push(item.block);
        if (item._imageRef) {
          imageRefs.push({ turnIndex: ti, blockIndex, ref: item._imageRef });
        }
      }

      // Attachments ride on user messages (and rarely on assistant ones).
      const atts = transformAttachments(m, opts).filter(
        (a) => !(a.fileUuid && inlineImageIds.has(a.fileUuid))
      );
      for (const a of atts) {
        const attIndex = currentAttachments.length;
        currentAttachments.push(a);
        if (a.category === 'binary' && a.fileUuid) {
          binaryAttachmentRefs.push({ turnIndex: ti, attIndex });
        } else if (a.category === 'text' && a.needsContentFetch && a.fileUuid) {
          textFileRefs.push({ turnIndex: ti, attIndex });
        }
      }

      // Sandbox/interpreter file references — only assistant messages emit
      // these. Each unique sandbox path produces one synthetic binary
      // attachment, registered on the first turn it's mentioned. The
      // markdown layer rewrites `(sandbox:/path)` links inline to point at
      // the resulting `files/<name>`; the `fromInlineLink` flag suppresses
      // a duplicate entry in the bottom Attachments section.
      if (
        currentRole === 'assistant' &&
        typeof m.id === 'string' &&
        m.id
      ) {
        for (const item of blocks) {
          if (!item.block || item.block.kind !== 'text' || typeof item.block.text !== 'string') {
            continue;
          }
          const refs = extractSandboxLinks(item.block.text);
          for (const ref of refs) {
            if (sandboxPathsSeen.has(ref.sandboxPath)) continue;
            sandboxPathsSeen.add(ref.sandboxPath);
            const attIndex = currentAttachments.length;
            currentAttachments.push({
              category: 'binary',
              fileName: ref.fileName,
              mime: 'application/octet-stream',
              isSandbox: true,
              sandboxPath: ref.sandboxPath,
              sandboxMessageId: m.id,
              fromInlineLink: true,
            });
            binaryAttachmentRefs.push({ turnIndex: ti, attIndex });
          }
        }
      }
    }
    flush();

    // Drop turns whose visible content (with reasoning rules applied) is empty —
    // common for "tool said nothing visible" runs that we coalesced into the
    // assistant. We use a lenient definition: any text/image/tool_* block keeps
    // the turn alive even if reasoning is off, because the markdown renderer
    // makes the final visibility decision.
    const indexMap = new Map();
    const filteredTurns = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const keep =
        t.attachments.length > 0 ||
        t.blocks.some(
          (b) =>
            b.kind === 'text' ||
            b.kind === 'image' ||
            b.kind === 'thinking' ||
            b.kind === 'tool_call' ||
            b.kind === 'tool_result' ||
            b.kind === 'artifact_ref'
        );
      if (keep) {
        indexMap.set(i, filteredTurns.length);
        filteredTurns.push(t);
      }
    }
    const remap = (ref) => {
      const ni = indexMap.get(ref.turnIndex);
      if (ni === undefined) return null;
      return { ...ref, turnIndex: ni };
    };
    const finalImageRefs = imageRefs.map(remap).filter(Boolean);
    const finalBinaryRefs = binaryAttachmentRefs.map(remap).filter(Boolean);
    const finalTextRefs = textFileRefs.map(remap).filter(Boolean);

    const meta = extractMeta(raw, ordered);
    const conversation = {
      title: meta.title,
      sourceLLM: 'chatgpt',
      model: meta.model,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      turns: filteredTurns,
      artifacts, // canvas (canmore) textdocs surfaced as Claude-style artifacts
    };

    return {
      conversation,
      imageRefs: finalImageRefs,
      binaryAttachmentRefs: finalBinaryRefs,
      textFileRefs: finalTextRefs,
    };
  };

  ns.chatgptNormalize = { normalize };
})();
