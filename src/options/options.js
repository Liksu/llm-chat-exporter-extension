(function () {
  const saveBtn = document.getElementById('saveBtn');
  const savedMsg = document.getElementById('savedMsg');
  const includeReasoningEl = document.getElementById('includeReasoning');
  const inlineImagesEl = document.getElementById('inlineImages');
  const inlineTextFilesEl = document.getElementById('inlineTextFiles');
  const attachmentsAsMarkdownEl = document.getElementById('attachmentsAsMarkdown');

  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  const getRadio = (name) => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  };

  const init = async () => {
    const settings = await self.__exporter.settings.load();
    setRadio('mode', settings.global.mode);
    includeReasoningEl.checked = settings.global.includeReasoning;
    // inlineImages defaults to true; treat a missing field as enabled so
    // older settings records pick up the new default.
    inlineImagesEl.checked = settings.global.inlineImages !== false;
    inlineTextFilesEl.checked = !!settings.global.inlineTextFiles;
    attachmentsAsMarkdownEl.checked = !!settings.global.attachmentsAsMarkdown;
  };

  saveBtn.addEventListener('click', async () => {
    const settings = await self.__exporter.settings.load();
    settings.global.mode = getRadio('mode') || 'md';
    settings.global.includeReasoning = !!includeReasoningEl.checked;
    settings.global.inlineImages = !!inlineImagesEl.checked;
    settings.global.inlineTextFiles = !!inlineTextFilesEl.checked;
    settings.global.attachmentsAsMarkdown = !!attachmentsAsMarkdownEl.checked;
    await self.__exporter.settings.save(settings);
    savedMsg.hidden = false;
    setTimeout(() => {
      savedMsg.hidden = true;
    }, 1500);
  });

  init();
})();
