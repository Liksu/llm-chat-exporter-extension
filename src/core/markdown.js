/**
 * Render NormalizedConversation → Markdown string.
 *
 * Modes:
 *   - 'md'  : single-file output. Images = base64 data-URLs. Binary files (from
 *             chat_message.files[]) are rendered as 📎 links pointing to a
 *             "## Attachments" section at the bottom of the document.
 *             Artifacts are rendered in a "## Artifacts" section at the bottom;
 *             in the body a markdown link to the anchor replaces the create site.
 *   - 'zip' : assumes images and binary files are placed in assets/ and files/
 *             on disk. Markdown references them via relative paths. Artifacts
 *             are referenced as artifacts/<name> links; their content is NOT
 *             duplicated into the .md (they are written as separate files).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const {
    fenceFor,
    langFromMime,
    slugifyAnchor,
    softBreaks,
    uint8ToBase64,
    escapeMdInline,
    formatBytes,
  } = ns.utils;

  /**
   * @param {import('./utils.js').NormalizedConversation} conv
   * @param {{
   *   mode: 'md'|'zip',
   *   includeReasoning: boolean,
   *   sourceLabel?: string,
   *   assetsDir?: string,
   *   filesDir?: string,
   *   artifactsDir?: string,
   *   imagePathByName?: Map<string,string>,
   *   filePathByName?: Map<string,string>,
   *   artifactFileById?: Map<string,string>,
   * }} options
   * @returns {string}
   */
  const render = (conv, options) => {
    const opts = {
      assetsDir: 'assets',
      filesDir: 'files',
      artifactsDir: 'artifacts',
      imagePathByName: new Map(),
      filePathByName: new Map(),
      artifactFileById: new Map(),
      sourceLabel: conv.sourceLLM || 'LLM',
      ...options,
    };
    const registry = createAttachmentRegistry();
    const out = [];
    out.push(`# ${conv.title || 'Conversation'}`);
    const meta = [];
    if (opts.sourceLabel) meta.push(`Source: ${opts.sourceLabel}`);
    if (conv.model) meta.push(`Model: ${conv.model}`);
    if (conv.createdAt) meta.push(`Created: ${conv.createdAt}`);
    if (conv.updatedAt) meta.push(`Updated: ${conv.updatedAt}`);
    if (meta.length) {
      out.push('');
      // each meta field on its own line — trailing two spaces force a soft break
      out.push(meta.map((m) => `_${m}_  `).join('\n'));
    }
    out.push('');

    for (const turn of conv.turns) {
      out.push(turn.role === 'human' ? '## Human' : '## Assistant');
      out.push('');
      for (const block of turn.blocks) {
        const rendered = renderBlock(block, conv, opts);
        if (rendered === null) continue;
        out.push(rendered);
        out.push('');
      }
      for (const att of turn.attachments) {
        const rendered = renderAttachment(att, opts, registry);
        if (rendered === null) continue;
        out.push(rendered);
        out.push('');
      }
      out.push('---');
      out.push('');
    }

    if (conv.artifacts.length) {
      out.push('## Artifacts');
      out.push('');
      for (const art of conv.artifacts) {
        out.push(renderArtifact(art, opts));
        out.push('');
      }
    }

    if (registry.size() > 0) {
      out.push('## Attachments');
      out.push('');
      out.push(registry.renderSection(opts));
      out.push('');
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  };

  /** Returns markdown chunk or null if block is filtered out. */
  const renderBlock = (block, conv, opts) => {
    switch (block.kind) {
      case 'text':
        return softBreaks(block.text);

      case 'thinking':
        if (!opts.includeReasoning) return null;
        return `<details><summary>Thinking</summary>\n\n${block.text}\n\n</details>`;

      case 'tool_call': {
        if (!opts.includeReasoning) return null;
        const fence = fenceFor(block.input);
        return `**Tool call: \`${block.name}\`**\n\n${fence}json\n${block.input}\n${fence}`;
      }

      case 'tool_result': {
        if (!opts.includeReasoning) return null;
        const fence = fenceFor(block.text);
        const label = block.isError ? 'Tool error' : 'Tool result';
        return `**${label}**\n\n${fence}\n${block.text}\n${fence}`;
      }

      case 'image': {
        const alt = block.name || 'image';
        if (!block.bytes || block.bytes.length === 0) {
          if (block.fetchError) return `_[image not loaded: ${alt} — ${block.fetchError}]_`;
          return `_[image: ${alt}]_`;
        }
        if (opts.mode === 'zip') {
          const path = opts.imagePathByName.get(block.name) ?? `${opts.assetsDir}/${alt}`;
          return `![${alt}](${path})`;
        }
        const b64 = uint8ToBase64(block.bytes);
        return `![${alt}](data:${block.mime || 'image/png'};base64,${b64})`;
      }

      case 'artifact_ref': {
        const art = conv.artifacts.find((a) => a.id === block.artifactId);
        if (!art) return null;
        if (opts.mode === 'zip') {
          const path =
            opts.artifactFileById.get(art.id) ?? `${opts.artifactsDir}/${art.fileName}`;
          return `🧩 [${art.fileName}](${path})`;
        }
        return `🧩 [${art.fileName}](#artifact-${slugifyAnchor(art.id)})`;
      }
    }
    return null;
  };

  const renderAttachment = (att, opts, registry) => {
    if (att.category === 'text') {
      // Both pastes (from attachments[]) and inlined text files (from files[]
      // with inlineTextFiles=true) render here. The label distinguishes
      // them: "Pasted" for clipboard pastes (no fileUuid), "File" for
      // uploaded text files.
      const isFile = !!att.fileUuid;
      let header;
      if (isFile) {
        header = att.fileName ? `**File: \`${att.fileName}\`**` : `**File:**`;
      } else if (att.fileName) {
        header = `**Pasted: \`${att.fileName}\`**`;
      } else {
        header = `**Pasted${typeof att.size === 'number' ? ` (${att.size} bytes)` : ''}:**`;
      }
      const body = att.text || '';
      if (opts.attachmentsAsMarkdown) {
        // Render content directly so embedded markdown (esp. for .md files)
        // is parsed by the viewer. User opted in; trade-off is that non-md
        // text formats may not look clean.
        return `${header}\n\n${body}`;
      }
      const fence = fenceFor(body);
      const lang = langFromMime(att.mime || '');
      return `${header}\n\n${fence}${lang}\n${body}\n${fence}`;
    }
    // binary (non-image): images are handled as image blocks, not attachments
    const anchorId = registry.register(att);
    if (opts.mode === 'zip') {
      const path = opts.filePathByName.get(att.fileName) ?? `${opts.filesDir}/${att.fileName}`;
      return `📎 [${escapeMdInline(att.fileName)}](${path})`;
    }
    return `📎 [${escapeMdInline(att.fileName)}](#${anchorId})`;
  };

  const renderArtifact = (art, opts) => {
    if (opts.mode === 'zip') {
      const path = opts.artifactFileById.get(art.id) ?? `${opts.artifactsDir}/${art.fileName}`;
      return `- [${art.fileName}](${path})`;
    }
    const fence = fenceFor(art.content);
    const lang = art.language || '';
    const anchor = `<a id="artifact-${slugifyAnchor(art.id)}"></a>`;
    return `### ${anchor}${art.fileName}\n\n${fence}${lang}\n${art.content}\n${fence}`;
  };

  /**
   * Tracks every binary attachment encountered during render and assigns
   * sequential anchor ids (att-1, att-2, ...). Used to build the bottom
   * "## Attachments" section, which gives each file a stable address inside
   * the document so inline links can scroll to it.
   */
  const createAttachmentRegistry = () => {
    const items = [];
    let nextId = 1;
    return {
      register(att) {
        const anchorId = `att-${nextId++}`;
        items.push({
          anchorId,
          fileName: att.fileName,
          mime: att.mime,
          size: att.size,
        });
        return anchorId;
      },
      size() {
        return items.length;
      },
      renderSection(opts) {
        const lines = [];
        for (const item of items) {
          const metaParts = [];
          const sizeStr = formatBytes(item.size);
          if (sizeStr) metaParts.push(sizeStr);
          if (item.mime) metaParts.push(item.mime);
          const metaSuffix = metaParts.length ? ` _(${metaParts.join(' · ')})_` : '';

          let label;
          if (opts.mode === 'zip') {
            const path =
              opts.filePathByName.get(item.fileName) ?? `${opts.filesDir}/${item.fileName}`;
            label = `[${escapeMdInline(item.fileName)}](${path})`;
          } else {
            label = `**${escapeMdInline(item.fileName)}**`;
          }
          lines.push(`- <a id="${item.anchorId}"></a>${label}${metaSuffix}`);
        }
        return lines.join('\n');
      },
    };
  };

  ns.markdown = { render };
})();
