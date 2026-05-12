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
  const { safeStringify, isTextLikeMime } = ns.utils;

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

  /** Pull plain text out of a `parts` array, ignoring non-string entries. */
  const partsToText = (parts) => {
    if (!Array.isArray(parts)) return '';
    return parts.filter((p) => typeof p === 'string').join('\n\n').trim();
  };

  /**
   * Transform one chatgpt message's content into normalized blocks.
   * Returns Array<{block, _imageRef?}>.
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
      const hasImage = parts.some(
        (p) => isObject(p) && p.content_type === 'image_asset_pointer'
      );
      if (!hasImage) {
        const text = parts
          .filter((p) => typeof p === 'string')
          .join('\n\n')
          .trim();
        if (text) out.push({ block: { kind: 'tool_result', text, isError: false } });
        return out;
      }
      // else: image-gen output, fall through to the multimodal_text handler.
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
          if (p.trim()) out.push({ block: { kind: 'text', text: p } });
          continue;
        }
        if (!isObject(p)) continue;
        if (p.content_type === 'audio_transcription' && typeof p.text === 'string') {
          // Voice message recognized text. Both user (direction:'in') and
          // assistant (direction:'out') speak through this content type;
          // we surface both as plain text blocks within their existing turn.
          const text = p.text.trim();
          if (text) out.push({ block: { kind: 'text', text } });
          continue;
        }
        if (p.content_type === 'image_asset_pointer' && typeof p.asset_pointer === 'string') {
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
          const summary = typeof t.summary === 'string' ? t.summary.trim() : '';
          const body = typeof t.content === 'string' ? t.content.trim() : '';
          if (summary && body) return `**${summary}**\n\n${body}`;
          return summary || body;
        })
        .filter(Boolean)
        .join('\n\n');
      if (text) out.push({ block: { kind: 'thinking', text } });
      return out;
    }

    if (ct === 'reasoning_recap') {
      const text = typeof content.content === 'string' ? content.content.trim() : '';
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
      artifacts: [], // ChatGPT has no canvas/artifact concept in this normalization
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
