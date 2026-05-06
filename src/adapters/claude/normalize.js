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
 *   - attachments[] → Attachment{category:'text'}
 *   - files[] → Attachment{category:'binary'}, with bytes fetched on demand
 *     by the caller (we record file_uuid for that).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { sanitizeFilename, extFromArtifactKind, safeStringify, isTextLikeMime } = ns.utils;

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
      const content = typeof input.content === 'string' ? input.content : '';
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
      if (typeof input.content === 'string') art.content = input.content;
      return id;
    }

    return id;
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
  const transformBlock = (raw, artifactMap) => {
    const t = raw?.type;

    if (t === 'text') {
      const raw_text = typeof raw.text === 'string' ? raw.text : '';
      const cleaned = stripUnsupportedPlaceholder(raw_text);
      return cleaned.trim().length > 0 ? [{ block: { kind: 'text', text: cleaned } }] : [];
    }

    if (t === 'thinking') {
      const text =
        typeof raw.thinking === 'string'
          ? raw.thinking
          : typeof raw.text === 'string'
            ? raw.text
            : '';
      return text ? [{ block: { kind: 'thinking', text } }] : [];
    }

    if (t === 'tool_use') {
      const name = typeof raw.name === 'string' ? raw.name : 'tool';
      if (name === 'artifacts') {
        const id = applyArtifactsCall(raw.input, artifactMap);
        const command = (pick(raw.input || {}, ['command', 'operation']) || 'create').toLowerCase();
        if (id && command === 'create') {
          return [{ block: { kind: 'artifact_ref', artifactId: id } }];
        }
        return [];
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

    const turns = [];
    const imageRefs = [];
    const binaryAttachmentRefs = [];
    const textFileRefs = [];

    for (let ti = 0; ti < ordered.length; ti++) {
      const m = ordered[ti];
      const role = m.sender === 'human' ? 'human' : 'assistant';
      const blocks = [];

      // Files[] images render inline at the top of the message (matches the
      // way claude.ai displays uploaded/pasted images above the user's text).
      const filesResult = transformFiles(m.files, opts, viewHarvest);
      for (const item of filesResult.imageItems) {
        const blockIndex = blocks.length;
        blocks.push(item.block);
        imageRefs.push({ turnIndex: ti, blockIndex, ref: item.ref });
      }

      const contentArr = Array.isArray(m.content) ? m.content : [];
      if (contentArr.length === 0 && typeof m.text === 'string' && m.text) {
        blocks.push({ kind: 'text', text: m.text });
      } else {
        for (const c of contentArr) {
          const produced = transformBlock(c, artifactMap);
          for (const item of produced) {
            const blockIndex = blocks.length;
            blocks.push(item.block);
            if (item._imageRef) {
              imageRefs.push({ turnIndex: ti, blockIndex, ref: item._imageRef });
            }
          }
        }
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

    return { conversation, imageRefs, binaryAttachmentRefs, textFileRefs };
  };

  ns.claudeNormalize = { normalize };
})();
