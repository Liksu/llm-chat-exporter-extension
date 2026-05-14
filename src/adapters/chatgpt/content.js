/**
 * Content-script entry for chatgpt.com. Mirrors the Claude adapter's flow:
 *   1. Parse conversation id from URL.
 *   2. Steal a Bearer token captured by hook.js.
 *   3. Fetch raw conversation JSON.
 *   4. Normalize → NormalizedConversation.
 *   5. Resolve image bytes (md + zip) and binary attachments (zip only).
 *   6. Render markdown / build zip and trigger download from the page.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { chatgptApi, chatgptNormalize, markdown, zip, download, utils } = ns;
  const { sanitizeFilename, todayStamp, utf8ToBytes, log } = utils;

  const handleExport = async ({ mode, includeReasoning, includeDates, dateFormat, inlineImages, inlineTextFiles, attachmentsAsMarkdown }) => {
    const convId = chatgptApi.parseConvIdFromUrl(location.href);
    if (!convId) {
      return { ok: false, error: 'Not on a chatgpt.com conversation page.' };
    }

    let token;
    try {
      token = await chatgptApi.getAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const raw = await chatgptApi.fetchConversation(convId, token);

    const { conversation, imageRefs, binaryAttachmentRefs, textFileRefs } =
      chatgptNormalize.normalize(raw, { inlineTextFiles });

    // Images: zip always fetches (writes to /assets/); md respects the
    // inlineImages toggle. When skipped, empty bytes from normalize() turn
    // into `_[image: name]_` placeholders via markdown.js.
    if (mode === 'zip' || inlineImages) {
      for (const { turnIndex, blockIndex, ref } of imageRefs) {
        const block = conversation.turns[turnIndex].blocks[blockIndex];
        try {
          const r = await chatgptApi.fetchFile(ref.fileId, convId, token);
          block.bytes = r.bytes;
          if (r.mime) block.mime = r.mime;
          if (r.fileName) block.name = r.fileName;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('chatgpt image fetch failed', ref, msg);
          block.fetchError = msg;
        }
      }
    }

    // Non-image binaries: only fetched in zip mode (md mode shows file name).
    // Two flavors share this loop:
    //   - regular uploads     → fetchFile(fileUuid, convId, token)
    //   - sandbox/interpreter → fetchSandboxFile(convId, msgId, path, token)
    // The latter is identified by `att.isSandbox` set during normalize.
    if (mode === 'zip') {
      for (const { turnIndex, attIndex } of binaryAttachmentRefs) {
        const att = conversation.turns[turnIndex].attachments[attIndex];
        try {
          const r = att.isSandbox
            ? await chatgptApi.fetchSandboxFile(
                convId,
                att.sandboxMessageId,
                att.sandboxPath,
                token
              )
            : await chatgptApi.fetchFile(att.fileUuid, convId, token);
          att.bytes = r.bytes;
          if (r.mime && (!att.mime || att.mime === 'application/octet-stream')) {
            att.mime = r.mime;
          }
          if (r.fileName && !att.fileName) att.fileName = r.fileName;
        } catch (err) {
          log.warn('chatgpt file fetch failed', att.fileName, err);
          // Mark so markdown renderer can show the file as expired/removed
          // instead of emitting a dangling link to a file the zip doesn't
          // contain.
          att.fetchError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Text files (only when inlineTextFiles is on): fetch content as UTF-8.
    if (inlineTextFiles) {
      for (const { turnIndex, attIndex } of textFileRefs) {
        const att = conversation.turns[turnIndex].attachments[attIndex];
        try {
          const r = await chatgptApi.fetchFile(att.fileUuid, convId, token);
          const decoder = new TextDecoder('utf-8', { fatal: false });
          att.text = decoder.decode(r.bytes);
          att.category = 'text';
          delete att.needsContentFetch;
        } catch (err) {
          log.warn('chatgpt text file fetch failed', att.fileName, err);
        }
      }
    }

    const baseName = sanitizeFilename(conversation.title || 'chatgpt-conversation');
    const stamp = todayStamp();
    const innerBase = `${baseName}-${stamp}`;
    const filename = `${innerBase}.${mode === 'zip' ? 'zip' : 'md'}`;

    if (mode === 'zip') {
      const blob = await zip.build(conversation, {
        includeReasoning,
        includeDates,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'ChatGPT',
        innerName: innerBase,
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
        sourceLabel: 'ChatGPT',
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
      inlineImages: msg.inlineImages !== false,
      inlineTextFiles: !!msg.inlineTextFiles,
      attachmentsAsMarkdown: !!msg.attachmentsAsMarkdown,
    })
      .then(sendResponse)
      .catch((err) => {
        log.error('chatgpt export failed', err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async response
  });
})();
