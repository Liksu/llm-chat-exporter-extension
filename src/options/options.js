(function () {
  const ns = self.__exporter;

  // -- Global section refs --------------------------------------------------
  const saveBtn = document.getElementById('saveBtn');
  const savedMsg = document.getElementById('savedMsg');
  const includeReasoningEl = document.getElementById('includeReasoning');
  const includeDatesEl = document.getElementById('includeDates');
  const dateFormatEl = document.getElementById('dateFormat');
  const inlineImagesEl = document.getElementById('inlineImages');
  const inlineTextFilesEl = document.getElementById('inlineTextFiles');
  const attachmentsAsMarkdownEl = document.getElementById('attachmentsAsMarkdown');
  const perAdapterContainer = document.getElementById('perAdapterContainer');

  // -- Per-adapter section definitions --------------------------------------
  // Option metadata drives the select dropdowns. `mode` is the only key with
  // string values (md/zip); the rest are booleans, which we encode as the
  // strings 'true'/'false' inside <option value>.
  const OPTION_META = [
    {
      key: 'mode',
      label: 'Default format',
      kind: 'mode',
      options: [
        { value: '', text: 'Inherit' },
        { value: 'md', text: 'Markdown' },
        { value: 'zip', text: 'ZIP' },
      ],
    },
    {
      key: 'includeReasoning',
      label: 'Include reasoning',
      kind: 'bool',
    },
    {
      key: 'includeDates',
      label: 'Include timestamps',
      kind: 'bool',
    },
    {
      key: 'inlineImages',
      label: 'Inline images',
      kind: 'bool',
    },
    {
      key: 'inlineTextFiles',
      label: 'Inline text uploads',
      kind: 'bool',
    },
    {
      key: 'attachmentsAsMarkdown',
      label: 'Markdown attachments',
      kind: 'bool',
    },
  ];

  // Default options for boolean keys.
  const BOOL_OPTIONS = [
    { value: '', text: 'Inherit' },
    { value: 'true', text: 'Always on' },
    { value: 'false', text: 'Always off' },
  ];

  const ADAPTERS = [
    { id: 'claude', name: 'Claude' },
    { id: 'chatgpt', name: 'ChatGPT' },
    { id: 'gemini', name: 'Gemini' },
  ];

  // -- Tri-state value <-> serialized form ---------------------------------
  // Storage uses real types (boolean, string); the <select> values are
  // strings, so we translate here.
  const selectValueFromStored = (meta, stored, present) => {
    if (!present) return '';
    if (meta.kind === 'mode') return typeof stored === 'string' ? stored : '';
    return stored === true ? 'true' : stored === false ? 'false' : '';
  };
  const storedValueFromSelect = (meta, selectValue) => {
    if (selectValue === '') return undefined;
    if (meta.kind === 'mode') return selectValue;
    return selectValue === 'true';
  };

  // -- Build the per-adapter sections in DOM -------------------------------
  const sectionEls = {}; // id → { details, summary, count, selects: {key: el}, resetBtn }

  const buildAdapterSection = (adapter) => {
    const details = document.createElement('details');
    details.className = 'adapter-section';
    details.dataset.adapter = adapter.id;

    const summary = document.createElement('summary');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'adapter-name';
    nameSpan.textContent = adapter.name;
    summary.appendChild(nameSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'adapter-overrides-count';
    countSpan.textContent = '(no overrides)';
    summary.appendChild(countSpan);

    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'adapter-body';

    const grid = document.createElement('div');
    grid.className = 'options-grid';

    const selects = {};
    for (const meta of OPTION_META) {
      const label = document.createElement('span');
      label.className = 'opt-label';
      label.textContent = meta.label;
      grid.appendChild(label);

      const select = document.createElement('select');
      select.dataset.key = meta.key;
      const opts = meta.kind === 'mode' ? meta.options : BOOL_OPTIONS;
      for (const opt of opts) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.text;
        select.appendChild(o);
      }
      select.addEventListener('change', () => {
        markModified(select);
        refreshCount(adapter.id);
      });
      selects[meta.key] = select;
      grid.appendChild(select);
    }

    body.appendChild(grid);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'reset-btn';
    resetBtn.textContent = 'Reset to global';
    resetBtn.addEventListener('click', () => {
      for (const sel of Object.values(selects)) {
        sel.value = '';
        markModified(sel);
      }
      refreshCount(adapter.id);
    });
    body.appendChild(resetBtn);

    details.appendChild(body);
    perAdapterContainer.appendChild(details);

    sectionEls[adapter.id] = { details, summary, count: countSpan, selects, resetBtn };
  };

  const markModified = (select) => {
    if (select.value === '') {
      select.removeAttribute('data-modified');
    } else {
      select.setAttribute('data-modified', 'true');
    }
  };

  const refreshCount = (adapterId) => {
    const section = sectionEls[adapterId];
    if (!section) return;
    let n = 0;
    for (const sel of Object.values(section.selects)) {
      if (sel.value !== '') n++;
    }
    if (n === 0) {
      section.count.textContent = '(no overrides)';
      section.count.classList.remove('has-overrides');
      section.resetBtn.disabled = true;
    } else {
      section.count.textContent = `(${n} ${n === 1 ? 'override' : 'overrides'})`;
      section.count.classList.add('has-overrides');
      section.resetBtn.disabled = false;
    }
  };

  // -- Global section helpers ----------------------------------------------
  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  const getRadio = (name) => {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  };

  // -- Init / Save ---------------------------------------------------------
  /** Stamp the dateFormat dropdown options with live "now" examples so the
   *  difference between locale, local-ISO, and UTC-ISO is obvious at a
   *  glance (especially the local vs UTC distinction, which is otherwise
   *  invisible if your timezone happens to be UTC+0 or if both labels show
   *  the same time of day). */
  const refreshDateFormatExamples = () => {
    const now = new Date();
    const fmt = ns.utils.formatTurnDate;
    const LABELS = {
      'locale': 'Locale',
      'iso': 'ISO, local time',
      'iso-offset': 'Local time with GMT offset',
      'iso-utc': 'ISO, UTC',
    };
    for (const opt of dateFormatEl.options) {
      const label = LABELS[opt.value] || opt.value;
      opt.textContent = `${label} (e.g. ${fmt(now, opt.value)})`;
    }
  };

  const init = async () => {
    // 1) Build per-adapter sections first so they exist when we populate.
    for (const adapter of ADAPTERS) buildAdapterSection(adapter);

    refreshDateFormatExamples();

    const settings = await ns.settings.load();

    // 2) Populate global section.
    setRadio('mode', settings.global.mode);
    includeReasoningEl.checked = settings.global.includeReasoning;
    includeDatesEl.checked = !!settings.global.includeDates;
    dateFormatEl.value = settings.global.dateFormat || 'locale';
    inlineImagesEl.checked = settings.global.inlineImages !== false;
    inlineTextFilesEl.checked = !!settings.global.inlineTextFiles;
    attachmentsAsMarkdownEl.checked = !!settings.global.attachmentsAsMarkdown;

    // 3) Populate per-adapter sections from stored overrides.
    for (const adapter of ADAPTERS) {
      const override = (settings.perAdapter && settings.perAdapter[adapter.id]) || {};
      const section = sectionEls[adapter.id];
      for (const meta of OPTION_META) {
        const present = Object.prototype.hasOwnProperty.call(override, meta.key);
        const sel = section.selects[meta.key];
        sel.value = selectValueFromStored(meta, override[meta.key], present);
        markModified(sel);
      }
      refreshCount(adapter.id);
      // Auto-expand sections that already have overrides — otherwise users
      // forget they're there.
      if (ns.settings.countOverrides(override) > 0) section.details.open = true;
    }
  };

  saveBtn.addEventListener('click', async () => {
    const settings = await ns.settings.load();

    // Global.
    settings.global.mode = getRadio('mode') || 'md';
    settings.global.includeReasoning = !!includeReasoningEl.checked;
    settings.global.includeDates = !!includeDatesEl.checked;
    settings.global.dateFormat = dateFormatEl.value || 'locale';
    settings.global.inlineImages = !!inlineImagesEl.checked;
    settings.global.inlineTextFiles = !!inlineTextFilesEl.checked;
    settings.global.attachmentsAsMarkdown = !!attachmentsAsMarkdownEl.checked;

    // Per-adapter — rebuild from selects. Keys whose value is "" (Inherit)
    // are omitted; the resulting object may be empty.
    settings.perAdapter = settings.perAdapter || {};
    for (const adapter of ADAPTERS) {
      const section = sectionEls[adapter.id];
      const out = {};
      for (const meta of OPTION_META) {
        const v = storedValueFromSelect(meta, section.selects[meta.key].value);
        if (v !== undefined) out[meta.key] = v;
      }
      settings.perAdapter[adapter.id] = out;
    }

    await ns.settings.save(settings);
    savedMsg.hidden = false;
    setTimeout(() => {
      savedMsg.hidden = true;
    }, 1500);
  });

  init();
})();
