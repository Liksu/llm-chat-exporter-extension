/**
 * "Developer" section of the options page (dev tooling, see dev-common.js).
 * Imported by src/options/options.js only in unpacked installs. Builds its
 * own controls and saves to chrome.storage.local `devSettings` on change --
 * independent of the page's Save button and of the user-facing settings.
 */
const DEFAULTS = { debugCapture: false, pageTrigger: false };

const OPTIONS = [
  {
    key: 'debugCapture',
    label: 'Save debug data with each export',
    hint: 'Also downloads <code>&lt;name&gt;.debug.har</code> with the raw responses the export ' +
      'received (also when it fails). Contains the full conversation; auth tokens are not recorded. ' +
      'Feed it to <code>npm run record</code> / <code>npm run drift</code>.',
  },
  {
    key: 'pageTrigger',
    label: 'Allow exports triggered from the page',
    hint: 'Scripts on the chat page (browser automation) can start an export with an ' +
      '<code>llm-exporter:export</code> event. See tests/README.md.',
  },
];

const load = () =>
  new Promise((resolve) =>
    chrome.storage.local.get('devSettings', (got) => resolve({ ...DEFAULTS, ...((got && got.devSettings) || {}) })));

const save = (settings) =>
  new Promise((resolve) => chrome.storage.local.set({ devSettings: settings }, resolve));

const render = async () => {
  const settings = await load();
  const section = document.createElement('section');
  section.id = 'devSection';
  section.innerHTML =
    '<h2>Developer <span style="text-transform:none;font-weight:400;color:#9ca3af">' +
    '— unpacked install only, saved immediately</span></h2>';
  for (const opt of OPTIONS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `dev-${opt.key}`;
    input.checked = !!settings[opt.key];
    input.addEventListener('change', async () => {
      settings[opt.key] = input.checked;
      await save(settings);
    });
    label.append(input, ` ${opt.label}`);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = opt.hint;
    section.append(label, hint);
  }
  const anchor = document.getElementById('saveBtn');
  anchor.parentNode.insertBefore(section, anchor);
};

render();
