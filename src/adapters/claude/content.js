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
 *
 * claude.ai hosts two different products on one origin, so this entry also
 * dispatches: `/cowork/cse_…` pages are agent sessions with a separate API
 * and data model, handled by the cowork adapter (see adapters/cowork/).
 * So are scheduled tasks' runs, although claude.ai shows them at
 * `/chat/<uuid>` like a chat: the chat endpoint 404s for them and the run's
 * session is looked up by that uuid.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { claudeApi, claudeNormalize, markdown, zip, download, utils } = ns;
  const { sanitizeFilename, todayStamp, utf8ToBytes, log } = utils;

  /**
   * Fill image blocks with bytes. `items` are `{block, ref}`, ref being
   * `{url, fileUuid, mime}`. ZIP keeps the original upload; md (images
   * inlined as data URLs) prefers the lighter preview so the file doesn't
   * balloon. Either falls back to the other.
   */
  const fetchImages = async (items, { mode, orgId, userScopeId }) => {
    for (const { block, ref } of items) {
      const original = async () => {
        const r = await claudeApi.fetchOriginal(orgId, ref.fileUuid);
        return { bytes: r.bytes, mime: utils.sniffImageMime(r.bytes) || r.mime };
      };
      const preview = () => (ref.url
        ? ns.fetchBinary.fetchAsBytes(ref.url)
        : claudeApi.fetchFile(orgId, ref.fileUuid, userScopeId));
      const sources = [];
      if (ref.fileUuid) sources.push(original);
      if (ref.url || ref.fileUuid) {
        if (mode === 'zip') sources.push(preview);
        else sources.unshift(preview);
      }
      let lastErr = null;
      for (const source of sources) {
        try {
          const r = await source();
          if (r.bytes && r.bytes.length > 0) {
            block.bytes = r.bytes;
            // Files Claude sends come back as application/octet-stream.
            block.mime = utils.sniffImageMime(r.bytes) ||
              (/^image\//.test(r.mime || '') ? r.mime : '') || ref.mime;
            break;
          }
        } catch (err) {
          lastErr = err;
        }
      }
      if (!block.bytes || block.bytes.length === 0) {
        if (lastErr) log.fetchFailed('image fetch failed', ref.fileName || ref.fileUuid || ref.url, lastErr);
        block.fetchError = lastErr
          ? (lastErr instanceof Error ? lastErr.message : String(lastErr))
          : sources.length ? 'empty response' : 'no download reference';
      }
    }
  };

  /**
   * Cowork sessions: fetch the event log, normalize, render. Documents
   * arrive inline as artifacts (the sandbox file endpoints reject cowork's
   * non-UUID session id); only files the human attached are fetched, from
   * the org-wide file endpoints.
   *
   * Reached two ways: a `/cowork/cse_…` page, or a scheduled task's run,
   * which claude.ai shows at `/chat/<uuid>` — then the caller has already
   * resolved `sessionId` and `orgId`.
   */
  const handleCoworkExport = async ({ sessionId, orgId, mode, includeReasoning, includeDates, link, dateFormat, inlineImages, attachmentsAsMarkdown }) => {
    const { coworkApi, coworkNormalize } = ns;
    sessionId = sessionId || coworkApi.parseSessionIdFromUrl(location.href);
    if (!sessionId) {
      return { ok: false, error: 'Not on a cowork session page.' };
    }

    // Org id is a request header for the session API and the scope of the
    // file endpoints; a failure to resolve it shouldn't block the export.
    if (!orgId) {
      try {
        orgId = await claudeApi.getOrgId();
      } catch (err) {
        log.debug('cowork: could not resolve org id, continuing without it', err);
      }
    }

    const session = await coworkApi.fetchSession(sessionId, orgId);
    const events = await coworkApi.fetchAllEvents(sessionId, orgId, (n) =>
      log.debug('cowork: loaded', n, 'events')
    );
    const { conversation, imageRefs = [], binaryAttachments = [] } =
      coworkNormalize.normalize(session, events, {});

    if (orgId && (mode === 'zip' || inlineImages)) {
      // /api/<org>/files/<uuid>/preview is the downscaled WebP the UI shows.
      const items = imageRefs.map(({ block, ref }) => ({
        block,
        ref: { ...ref, url: ref.url || (ref.fileUuid ? `https://claude.ai/api/${orgId}/files/${ref.fileUuid}/preview` : null) },
      }));
      await fetchImages(items, { mode, orgId, userScopeId: orgId });
    }
    if (orgId && mode === 'zip') {
      for (const att of binaryAttachments) {
        try {
          const r = await claudeApi.fetchOriginal(orgId, att.fileUuid);
          att.bytes = r.bytes;
          if (r.mime && (!att.mime || att.mime === 'application/octet-stream')) att.mime = r.mime;
        } catch (err) {
          log.fetchFailed('file fetch failed', att.fileName, err);
          att.fetchError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const baseName = sanitizeFilename(conversation.title || 'cowork-session');
    const innerBase = `${baseName}-${todayStamp()}`;
    const filename = `${innerBase}.${mode === 'zip' ? 'zip' : 'md'}`;

    if (mode === 'zip') {
      const blob = await zip.build(conversation, {
        includeReasoning,
        includeDates,
        link,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'Claude Cowork',
        innerName: innerBase,
      });
      download.triggerDownload(blob, filename);
    } else {
      const md = markdown.render(conversation, {
        mode: 'md',
        includeReasoning,
        includeDates,
        link,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'Claude Cowork',
      });
      const blob = new Blob([utf8ToBytes(md)], { type: 'text/markdown;charset=utf-8' });
      download.triggerDownload(blob, filename);
    }

    return { ok: true, filename };
  };

  const handleExport = async ({ mode, includeReasoning, includeDates, link, dateFormat, inlineImages, inlineTextFiles, attachmentsAsMarkdown }) => {
    if (ns.coworkApi && ns.coworkApi.isCoworkUrl(location.href)) {
      return handleCoworkExport({
        mode,
        includeReasoning,
        includeDates,
        link,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
      });
    }

    const convId = claudeApi.parseConvIdFromUrl(location.href);
    if (!convId) {
      return { ok: false, error: 'Not on a claude.ai conversation page.' };
    }
    const orgId = await claudeApi.getOrgId();
    let raw;
    try {
      raw = await claudeApi.fetchConversation(orgId, convId);
    } catch (err) {
      // A scheduled task's run opens at /chat/<uuid> but is a cowork
      // session: the chat endpoint doesn't know it (404). Look it up among
      // the scheduled tasks' runs; anything else keeps the original error.
      if (!(err && err.status === 404) || !ns.coworkApi) throw err;
      let sessionId = null;
      try {
        sessionId = await ns.coworkApi.findScheduledRunSession(orgId, convId);
      } catch (lookupErr) {
        log.debug('scheduled run lookup failed', lookupErr);
      }
      if (!sessionId) throw err;
      return handleCoworkExport({
        sessionId,
        orgId,
        mode,
        includeReasoning,
        includeDates,
        link,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
      });
    }
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
      const items = imageRefs.map(({ turnIndex, blockIndex, ref }) => ({
        block: conversation.turns[turnIndex].blocks[blockIndex],
        ref,
      }));
      await fetchImages(items, { mode, orgId, userScopeId });
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
          log.fetchFailed('file fetch failed', att.fileName, err);
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
        log.fetchFailed('text file fetch failed', att.fileName, err);
        att.text = '_(failed to load file content)_';
        delete att.needsContentFetch;
      }
    }

    // Text files Claude created → artifacts (needs their content, so after
    // the fetches above).
    claudeNormalize.promoteFileArtifacts(conversation);

    const baseName = sanitizeFilename(conversation.title || 'conversation');
    const stamp = todayStamp();
    const innerBase = `${baseName}-${stamp}`;
    const filename = `${innerBase}.${mode === 'zip' ? 'zip' : 'md'}`;

    if (mode === 'zip') {
      const blob = await zip.build(conversation, {
        includeReasoning,
        includeDates,
        link,
        dateFormat,
        inlineImages,
        attachmentsAsMarkdown,
        sourceLabel: 'Claude',
        innerName: innerBase,
      });
      download.triggerDownload(blob, filename);
    } else {
      const md = markdown.render(conversation, {
        mode: 'md',
        includeReasoning,
        includeDates,
        link,
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

  ns.exportEntry.register('claude', handleExport);
})();
