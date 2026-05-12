/**
 * Content-script entry for claude.ai. Listens for { kind: 'export', ... }
 * messages from the popup, drives:
 *   1. Resolve org + conversation id.
 *   2. Fetch conversation JSON.
 *   3. Normalize.
 *   4. (zip mode only) Fetch binary file bytes for each files[]/image block.
 *   5. Render markdown / build zip.
 *   6. Trigger download from the page (popups can't trigger downloads with
 *      large blobs reliably).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { claudeApi, claudeNormalize, markdown, zip, download, utils } = ns;
  const { sanitizeFilename, todayStamp, utf8ToBytes, log } = utils;

  const handleExport = async ({ mode, includeReasoning, includeDates, dateFormat, inlineImages, inlineTextFiles, attachmentsAsMarkdown }) => {
    const convId = claudeApi.parseConvIdFromUrl(location.href);
    if (!convId) {
      return { ok: false, error: 'Not on a claude.ai conversation page.' };
    }
    const orgId = await claudeApi.getOrgId();
    const raw = await claudeApi.fetchConversation(orgId, convId);
    const userScopeId = claudeApi.extractUserScopeId(raw);
    if (userScopeId) {
      log.debug('user-scope id:', userScopeId);
    }
    // For sandbox file downloads claude.ai uses orgId = userScopeId (the
    // `c{uuid}` segment seen in image preview_urls). Prefer it; fall back to
    // whatever /api/organizations gave us.
    const fileOrgId = userScopeId || orgId;
    const { conversation, imageRefs, binaryAttachmentRefs, textFileRefs } =
      claudeNormalize.normalize(raw, { inlineTextFiles });

    // Images: in zip mode we always fetch (they're written to /assets/,
    // not embedded inline -- "inline" is an md-only concept). In md mode,
    // the inlineImages toggle controls fetching; when off, the empty
    // block.bytes left over from normalize() triggers the placeholder
    // branch in markdown.js (`_[image: name]_`).
    if (mode === 'zip' || inlineImages) {
      for (const { turnIndex, blockIndex, ref } of imageRefs) {
        const block = conversation.turns[turnIndex].blocks[blockIndex];
        try {
          let bytes;
          let mime = ref.mime;
          if (ref.url) {
            const r = await ns.fetchBinary.fetchAsBytes(ref.url);
            bytes = r.bytes;
            if (r.mime) mime = r.mime;
          } else if (ref.fileUuid) {
            const r = await claudeApi.fetchFile(orgId, ref.fileUuid, userScopeId);
            bytes = r.bytes;
            if (r.mime) mime = r.mime;
          }
          if (bytes) {
            block.bytes = bytes;
            block.mime = mime;
          }
        } catch (err) {
          log.warn('image fetch failed', ref, err);
        }
      }
    }

    /**
     * Try the sandbox /wiggle/download-file endpoint first (uses path), fall
     * back to file_uuid candidates if path is unavailable or it 404s.
     */
    const downloadAttachment = async (att) => {
      if (att.path) {
        try {
          return await claudeApi.fetchFileByPath(fileOrgId, convId, att.path);
        } catch (err) {
          log.debug('fetchFileByPath failed, falling back to fetchFile', att.fileName, err);
        }
      }
      return await claudeApi.fetchFile(orgId, att.fileUuid, userScopeId);
    };

    // Non-image binaries: only fetched in zip mode (md mode shows file name only).
    if (mode === 'zip') {
      for (const { turnIndex, attIndex } of binaryAttachmentRefs) {
        const att = conversation.turns[turnIndex].attachments[attIndex];
        try {
          const r = await downloadAttachment(att);
          att.bytes = r.bytes;
          if (!att.mime || att.mime === 'application/octet-stream') {
            if (r.mime) att.mime = r.mime;
          }
        } catch (err) {
          log.warn('file fetch failed', att.fileName, err);
          att.fetchError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Text files (only when inlineTextFiles is on): always fetched, in both
    // modes — content goes inline as a paste-style code-block.
    for (const { turnIndex, attIndex } of textFileRefs) {
      const att = conversation.turns[turnIndex].attachments[attIndex];
      try {
        const r = await downloadAttachment(att);
        const decoder = new TextDecoder('utf-8', { fatal: false });
        att.text = decoder.decode(r.bytes);
        delete att.needsContentFetch;
      } catch (err) {
        log.warn('text file fetch failed', att.fileName, err);
        att.text = '_(failed to load file content)_';
        delete att.needsContentFetch;
      }
    }

    const baseName = sanitizeFilename(conversation.title || 'conversation');
    const stamp = todayStamp();
    const filename = `${baseName}-${stamp}.${mode === 'zip' ? 'zip' : 'md'}`;

    if (mode === 'zip') {
      const blob = await zip.build(conversation, {
        includeReasoning,
        includeDates,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'Claude',
      });
      download.triggerDownload(blob, filename);
    } else {
      const md = markdown.render(conversation, {
        mode: 'md',
        includeReasoning,
        includeDates,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'Claude',
      });
      const blob = new Blob([utf8ToBytes(md)], { type: 'text/markdown;charset=utf-8' });
      download.triggerDownload(blob, filename);
    }

    return { ok: true, filename };
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.kind !== 'export') return false;
    handleExport({
      mode: msg.mode === 'zip' ? 'zip' : 'md',
      includeReasoning: !!msg.includeReasoning,
      includeDates: !!msg.includeDates,
      dateFormat: msg.dateFormat || 'locale',
      // Default to true so an older popup (or a programmatic caller that
      // forgets the field) still inlines images, matching the new default.
      inlineImages: msg.inlineImages !== false,
      inlineTextFiles: !!msg.inlineTextFiles,
      attachmentsAsMarkdown: !!msg.attachmentsAsMarkdown,
    })
      .then(sendResponse)
      .catch((err) => {
        log.error('export failed', err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async response
  });
})();
