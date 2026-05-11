/**
 * Build a ZIP Blob from a NormalizedConversation.
 *
 * Layout:
 *   conversation.md
 *   metadata.json
 *   assets/      images (from message images + image files[])
 *   files/       non-image binaries (from files[])
 *   artifacts/   final artifact contents
 *
 * The walk is two-pass:
 *   1) decide on-disk paths (with collision resolution) and populate a path map
 *   2) call markdown.render with that map so links inside the .md match
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { uniqueName, utf8ToBytes, sanitizeFilename, extFromMime } = ns.utils;
  const fflate = self.fflate;

  /**
   * @param {import('./utils.js').NormalizedConversation} conv
   * @param {{
   *   includeReasoning: boolean,
   *   inlineImages?: boolean,
   *   attachmentsAsMarkdown?: boolean,
   *   sourceLabel?: string,
   * }} options
   * @returns {Promise<Blob>}
   */
  const build = async (conv, options) => {
    if (!fflate) throw new Error('fflate is not loaded');

    const ASSETS = 'assets';
    const FILES = 'files';
    const ARTIFACTS = 'artifacts';

    const usedAssets = new Set();
    const usedFiles = new Set();
    const usedArtifacts = new Set();

    const imagePathByName = new Map();
    const filePathByName = new Map();
    const artifactFileById = new Map();

    /** @type {Record<string, Uint8Array>} */
    const entries = {};

    let imgCounter = 0;
    // When images are inlined as base64 in the .md, there is nothing to
    // reference from disk, so we skip writing /assets/ entries entirely.
    // The renderer will still receive an empty imagePathByName and fall
    // back to base64 -- consistent because we pass the same inlineImages
    // flag through.
    const inlineImages = options.inlineImages === true;

    // 1) Pass over turns: register binaries / images.
    for (const turn of conv.turns) {
      for (const block of turn.blocks) {
        if (
          block.kind === 'image' &&
          block.bytes &&
          block.bytes.length > 0 &&
          !inlineImages
        ) {
          const baseName = block.name || `image-${++imgCounter}${extFromMime(block.mime) || '.bin'}`;
          const finalName = uniqueName(sanitizeFilename(baseName), usedAssets);
          entries[`${ASSETS}/${finalName}`] = block.bytes;
          imagePathByName.set(block.name || finalName, `${ASSETS}/${finalName}`);
        }
      }
      for (const att of turn.attachments) {
        if (att.category !== 'binary' || !att.bytes) continue;
        const finalName = uniqueName(sanitizeFilename(att.fileName || 'file.bin'), usedFiles);
        entries[`${FILES}/${finalName}`] = att.bytes;
        filePathByName.set(att.fileName, `${FILES}/${finalName}`);
      }
    }

    // 2) Artifacts.
    for (const art of conv.artifacts) {
      const finalName = uniqueName(sanitizeFilename(art.fileName || `${art.title}.txt`), usedArtifacts);
      entries[`${ARTIFACTS}/${finalName}`] = utf8ToBytes(art.content);
      artifactFileById.set(art.id, `${ARTIFACTS}/${finalName}`);
    }

    // 3) Render markdown with path maps.
    const md = ns.markdown.render(conv, {
      mode: 'zip',
      includeReasoning: options.includeReasoning,
      inlineImages,
      attachmentsAsMarkdown: options.attachmentsAsMarkdown,
      sourceLabel: options.sourceLabel,
      assetsDir: ASSETS,
      filesDir: FILES,
      artifactsDir: ARTIFACTS,
      imagePathByName,
      filePathByName,
      artifactFileById,
    });
    entries['conversation.md'] = utf8ToBytes(md);

    const meta = {
      title: conv.title,
      sourceLLM: conv.sourceLLM,
      model: conv.model,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      exportedAt: new Date().toISOString(),
      counts: {
        turns: conv.turns.length,
        artifacts: conv.artifacts.length,
        assets: usedAssets.size,
        files: usedFiles.size,
      },
    };
    entries['metadata.json'] = utf8ToBytes(JSON.stringify(meta, null, 2));

    const zipped = await new Promise((resolve, reject) => {
      fflate.zip(entries, { level: 6 }, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    return new Blob([zipped], { type: 'application/zip' });
  };

  ns.zip = { build };
})();
