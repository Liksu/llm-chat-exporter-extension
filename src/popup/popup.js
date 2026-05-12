(function () {
  // -- Element refs ----------------------------------------------------------
  const gearBtn = document.getElementById('gearBtn');
  const detectedGlyph = document.getElementById('detectedGlyph');
  const detectedName = document.getElementById('detectedName');
  const unsupportedAlertText = document.getElementById('unsupportedAlertText');
  const segments = Array.from(document.querySelectorAll('.segment'));
  const helperText = document.getElementById('helperText');
  const includeReasoningEl = document.getElementById('includeReasoning');
  const includeDatesEl = document.getElementById('includeDates');
  const inlineImagesEl = document.getElementById('inlineImages');
  const inlineTextFilesEl = document.getElementById('inlineTextFiles');
  const attachmentsAsMarkdownEl = document.getElementById('attachmentsAsMarkdown');
  const exportBtn = document.getElementById('exportBtn');
  const postError = document.getElementById('postError');
  const postSuccess = document.getElementById('postSuccess');

  // Adapter registry (loaded via <script src="../adapters/.../info.js">).
  const ADAPTERS = [self.__adapterClaude, self.__adapterChatGPT, self.__adapterGemini].filter(Boolean);

  // -- Local view state ------------------------------------------------------
  let view = 'idle'; // 'idle' | 'exporting' | 'success' | 'error' | 'unsupported'
  let mode = 'md'; // 'md' | 'zip'
  let activeTab = null;
  let activeAdapter = null;
  let lastError = '';
  let lastFilename = '';
  let successTimer = null;
  // Effective settings (global merged with per-adapter overrides for the
  // detected adapter). Kept in scope because the popup needs values for
  // export-message fields that aren't exposed in the UI -- right now just
  // `dateFormat`, which is options-page-only.
  let effectiveSettings = null;

  // -- Inline SVGs (keep markup in popup.html minimal) -----------------------
  const SVG = {
    spinner:
      '<svg class="spinner" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/>' +
        '<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>',
    check:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3 8.5l3.2 3.2L13 5"/>' +
      '</svg>',
    alert:
      '<svg class="alert-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="8" cy="8" r="6.5"/>' +
        '<path d="M8 5v3.5M8 11v0.01"/>' +
      '</svg>',
    glyphClaude:
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
        '<circle cx="6" cy="6" r="5" fill="#D97757"/>' +
        '<path d="M4.2 4 L4.2 8 M7.8 4 L7.8 8 M4.2 6 L7.8 6" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>' +
      '</svg>',
    glyphChatgpt:
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
        '<circle cx="6" cy="6" r="5" fill="#10A37F"/>' +
        '<path d="M4 4.5 L6 3.5 L8 4.5 L8 7.5 L6 8.5 L4 7.5 Z" stroke="#fff" stroke-width="0.9" fill="none"/>' +
      '</svg>',
    glyphGemini:
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
        '<circle cx="6" cy="6" r="5" fill="#4285F4"/>' +
        '<path d="M6 2.5 L6.9 5.1 L9.5 6 L6.9 6.9 L6 9.5 L5.1 6.9 L2.5 6 L5.1 5.1 Z" fill="#fff"/>' +
      '</svg>',
  };

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  // -- View transitions ------------------------------------------------------
  const setView = (v) => {
    view = v;
    document.body.dataset.view = v;
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    renderButton();
  };

  const renderButton = () => {
    if (view === 'exporting') {
      exportBtn.innerHTML = SVG.spinner + '<span>Exporting…</span>';
      exportBtn.disabled = true;
      exportBtn.setAttribute('aria-busy', 'true');
      return;
    }
    if (view === 'success') {
      exportBtn.innerHTML = SVG.check + '<span>Saved</span>';
      exportBtn.disabled = true;
      exportBtn.setAttribute('aria-busy', 'false');
      postSuccess.textContent = lastFilename || '';
      return;
    }
    if (view === 'error') {
      exportBtn.innerHTML = '<span>Try again</span>';
      exportBtn.disabled = false;
      exportBtn.removeAttribute('aria-busy');
      postError.innerHTML = SVG.alert + '<span>' + escapeHtml(lastError) + '</span>';
      return;
    }
    // 'idle' (also covers post-unsupported when adapter changes — though tab
    // can't change without popup re-open, so safe).
    exportBtn.innerHTML = '<span>Export</span>';
    exportBtn.disabled = false;
    exportBtn.removeAttribute('aria-busy');
  };

  const refreshHelper = () => {
    const inline = inlineImagesEl.checked;
    if (mode === 'md') {
      helperText.textContent = inline
        ? 'Single .md file. Images embedded inline as base64.'
        : 'Single .md file. Image placeholders only — no embedded data.';
    } else {
      helperText.textContent = inline
        ? 'Folder of files. chat.md is self-contained with images inline.'
        : 'Folder of files: chat.md plus images in /assets/.';
    }
  };

  const setMode = (m) => {
    mode = m === 'zip' ? 'zip' : 'md';
    segments.forEach((s) => {
      s.setAttribute('aria-pressed', s.dataset.mode === mode ? 'true' : 'false');
    });
    refreshHelper();
  };

  const showAdapter = (adapter) => {
    if (!adapter) {
      detectedGlyph.innerHTML = '';
      detectedName.textContent = '';
      return;
    }
    detectedName.textContent = adapter.displayName || '';
    detectedGlyph.innerHTML =
      adapter.id === 'claude'
        ? SVG.glyphClaude
        : adapter.id === 'chatgpt'
          ? SVG.glyphChatgpt
          : adapter.id === 'gemini'
            ? SVG.glyphGemini
            : '';
  };

  // -- Init ------------------------------------------------------------------
  const init = async () => {
    gearBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

    // Resolve active tab + matching adapter BEFORE prefilling toggles, so we
    // can apply per-adapter overrides on top of the global defaults.
    const [tabs, settings] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      self.__exporter.settings.load(),
    ]);
    activeTab = tabs[0] || null;
    let hostname = '';
    try {
      if (activeTab && activeTab.url) hostname = new URL(activeTab.url).hostname;
    } catch {
      hostname = '';
    }
    activeAdapter = ADAPTERS.find((a) => a.matches(hostname)) || null;

    // Pre-fill from per-adapter overrides if we have a matching adapter,
    // otherwise fall back to plain global defaults.
    effectiveSettings = activeAdapter
      ? self.__exporter.settings.resolveFor(settings, activeAdapter.id)
      : settings.global;
    setMode(effectiveSettings.mode);
    includeReasoningEl.checked = !!effectiveSettings.includeReasoning;
    includeDatesEl.checked = !!effectiveSettings.includeDates;
    // inlineImages is ON by default — treat anything that isn't explicit
    // false as enabled (covers pre-0.7.21 settings records).
    inlineImagesEl.checked = effectiveSettings.inlineImages !== false;
    inlineTextFilesEl.checked = !!effectiveSettings.inlineTextFiles;
    attachmentsAsMarkdownEl.checked = !!effectiveSettings.attachmentsAsMarkdown;

    segments.forEach((s) => {
      s.addEventListener('click', () => {
        if (view === 'exporting' || view === 'success') return;
        setMode(s.dataset.mode);
      });
    });

    // The md helper line reflects the inlineImages state, so refresh on toggle.
    inlineImagesEl.addEventListener('change', refreshHelper);

    exportBtn.addEventListener('click', () => {
      // Both 'idle' and 'error' (Try again) trigger an export.
      if (view !== 'idle' && view !== 'error') return;
      doExport();
    });

    if (!activeAdapter) {
      unsupportedAlertText.textContent = 'Open a Claude, ChatGPT, or Gemini chat tab to export.';
      setView('unsupported');
      return;
    }
    if (activeAdapter.available === false) {
      unsupportedAlertText.textContent = `${activeAdapter.displayName} support is coming soon.`;
      setView('unsupported');
      return;
    }
    showAdapter(activeAdapter);
    setView('idle');
  };

  // -- Export flow -----------------------------------------------------------
  const doExport = async () => {
    if (!activeTab || !activeAdapter || activeAdapter.available === false) return;
    setView('exporting');
    try {
      const resp = await sendWithReload(activeTab.id, {
        kind: 'export',
        mode,
        includeReasoning: !!includeReasoningEl.checked,
        includeDates: !!includeDatesEl.checked,
        // dateFormat lives in options only -- pull it from the loaded
        // settings rather than any UI element.
        dateFormat: (effectiveSettings && effectiveSettings.dateFormat) || 'locale',
        inlineImages: !!inlineImagesEl.checked,
        inlineTextFiles: !!inlineTextFilesEl.checked,
        attachmentsAsMarkdown: !!attachmentsAsMarkdownEl.checked,
      });
      if (!resp) throw new Error('No response from page. Try reloading the tab.');
      if (!resp.ok) throw new Error(resp.error || 'Export failed.');
      lastFilename = resp.filename || '';
      setView('success');
      // Brief "Saved" flash so the user sees confirmation, then close the
      // popup. Browser usually closes it anyway when focus shifts to the
      // download bar, but doing it explicitly keeps the behavior consistent.
      successTimer = setTimeout(() => window.close(), 2500);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      setView('error');
    }
  };

  const sendWithReload = async (tabId, message) => {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        throw err;
      }
      await chrome.tabs.reload(tabId);
      await new Promise((resolve) => {
        const listener = (id, info) => {
          if (id === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await new Promise((r) => setTimeout(r, 400));
      return chrome.tabs.sendMessage(tabId, message);
    }
  };

  init().catch((err) => {
    lastError = err instanceof Error ? err.message : String(err);
    setView('error');
  });
})();
