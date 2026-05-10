/**
 * Content-script entry for gemini.google.com. Mirrors the Claude/ChatGPT
 * adapters' flow:
 *   1. Parse conversation id (and any /u/<N>/ multi-account prefix) from URL.
 *   2. Wait for hook-main.js to capture an `at` token.
 *   3. POST batchexecute(hNvQHb) to fetch the conversation tree.
 *   4. Normalize → NormalizedConversation.
 *   5. Resolve image bytes (md + zip) and binary attachments (zip only).
 *   6. Render markdown / build zip and trigger download from the page.
 *
 * Title source: Gemini doesn't include the conversation title in the
 * batchexecute response, so we read it from `document.title` (the SPA
 * updates the tab title to the chat name shortly after page load) and fall
 * back to a generic name otherwise.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { geminiApi, geminiNormalize, markdown, zip, download, utils } = ns;
  const { sanitizeFilename, todayStamp, utf8ToBytes, log } = utils;

  /**
   * Pull the visible chat title out of `document.title`. Gemini formats the
   * tab title as either:
   *   "<chat title> — Gemini"
   *   "<chat title> - Gemini"
   *   "Gemini"            (when no title yet)
   * We strip the trailing " — Gemini"/" - Gemini" suffix; if nothing remains
   * (empty or just "Gemini"), the caller falls back to a generic name.
   */
  const titleFromDocument = () => {
    const raw = (document.title || '').trim();
    if (!raw) return '';
    const cleaned = raw.replace(/\s*[—\-–]\s*Gemini\s*$/i, '').trim();
    if (!cleaned || /^gemini$/i.test(cleaned)) return '';
    return cleaned;
  };

  const handleExport = async ({ mode, includeReasoning, inlineTextFiles, attachmentsAsMarkdown }) => {
    const locator = geminiApi.parseConvLocator(location.href);
    if (!locator) {
      return { ok: false, error: 'Not on a gemini.google.com conversation page.' };
    }

    let atToken;
    try {
      atToken = await geminiApi.getAtToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let raw;
    try {
      raw = await geminiApi.fetchConversation({
        convId: locator.convId,
        userScope: locator.userScope,
        atToken,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const { conversation, imageRefs, binaryAttachmentRefs, textFileRefs } =
      geminiNormalize.normalize(raw, {
        title: titleFromDocument(),
        inlineTextFiles,
      });

    // Images: needed in both modes (md = base64; zip = assets/).
    for (const { turnIndex, blockIndex, ref } of imageRefs) {
      const block = conversation.turns[turnIndex].blocks[blockIndex];
      try {
        const r = await geminiApi.fetchAsset(ref.url);
        block.bytes = r.bytes;
        if (r.mime) block.mime = r.mime;
      } catch (err) {
        log.warn('gemini image fetch failed', ref.url, err);
        block.fetchError = err instanceof Error ? err.message : String(err);
      }
    }

    // Non-image binaries: only fetched in zip mode (md mode shows file name).
    if (mode === 'zip') {
      for (const { turnIndex, attIndex, url } of binaryAttachmentRefs) {
        const att = conversation.turns[turnIndex].attachments[attIndex];
        try {
          const r = await geminiApi.fetchAsset(url);
          att.bytes = r.bytes;
          if (r.mime && (!att.mime || att.mime === 'application/octet-stream')) {
            att.mime = r.mime;
          }
        } catch (err) {
          log.warn('gemini file fetch failed', att.fileName, err);
        }
      }
    }

    // Text files (only when inlineTextFiles is on): fetch + decode UTF-8.
    if (inlineTextFiles) {
      for (const { turnIndex, attIndex, url } of textFileRefs) {
        const att = conversation.turns[turnIndex].attachments[attIndex];
        try {
          const r = await geminiApi.fetchAsset(url);
          const decoder = new TextDecoder('utf-8', { fatal: false });
          att.text = decoder.decode(r.bytes);
          att.category = 'text';
          delete att.needsContentFetch;
        } catch (err) {
          log.warn('gemini text file fetch failed', att.fileName, err);
        }
      }
    }

    const baseName = sanitizeFilename(conversation.title || 'gemini-conversation');
    const stamp = todayStamp();
    const filename = `${baseName}-${stamp}.${mode === 'zip' ? 'zip' : 'md'}`;

    if (mode === 'zip') {
      const blob = await zip.build(conversation, {
        includeReasoning,
        attachmentsAsMarkdown,
        sourceLabel: 'Gemini',
      });
      download.triggerDownload(blob, filename);
    } else {
      const md = markdown.render(conversation, {
        mode: 'md',
        includeReasoning,
        attachmentsAsMarkdown,
        sourceLabel: 'Gemini',
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
      inlineTextFiles: !!msg.inlineTextFiles,
      attachmentsAsMarkdown: !!msg.attachmentsAsMarkdown,
    })
      .then(sendResponse)
      .catch((err) => {
        log.error('gemini export failed', err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async response
  });
})();
