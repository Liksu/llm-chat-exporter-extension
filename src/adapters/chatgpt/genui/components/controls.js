/**
 * ChatGPT generative UI -- form controls, shown as text in their initial
 * state (what the page shows before anyone touches them; the state comes
 * from the program, see template.js):
 *
 *   <radio-group value={days}><radio value="14">14 days</radio>…
 *                                   → - ◉ 14 days / - ○ 10 days
 *   <segmented-control value options={[{value,label}]}/> → the same list
 *   <checkbox checked={…}>Tent</checkbox>  → - [x] Tent / - [ ] Tent
 *   <slider min max value marks/>  → 🎚️ 18 (0–30)
 *   <input value/> <textarea/> <date-picker/> → `value`, or ____ when
 *                                    empty (with its placeholder)
 *   <button>…</button>             → nothing (an action, not content)
 *   <pressable>…</pressable>       → its content as one list item (a card
 *                                    you can tap, one of a list)
 *
 * A value the program couldn't work out shows as not chosen / empty.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { register } = g.registry;
  const { isObject, oneLine, str, listItem } = g.util;

  const option = (selected, label) => `- ${selected ? '◉' : '○'} ${label}`;
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const titled = (a, body) => (body ? `\n\n${str(a.label) ? `**${oneLine(a.label)}**\n\n` : ''}${body}\n\n` : '');

  register('radio-group', { kind: 'collect', render: (a, inner) => titled(a, lines(inner)) });
  register('radio', {
    kind: 'collect',
    line: true,
    render: (a, inner, ctx) => {
      const group = ctx.parent('radio-group');
      const label = oneLine(inner) || str(a.label) || str(a.value);
      return label ? option(group && same(group.value, a.value), label) : '';
    },
  });

  register('segmented-control', {
    kind: 'leaf',
    render: (a) => {
      const opts = (Array.isArray(a.options) ? a.options : []).filter(isObject);
      return titled(a, opts.map((o) => option(same(o.value, a.value), oneLine(str(o.label) || str(o.value)))).join('\n'));
    },
  });

  register('checkbox', {
    kind: 'collect',
    line: true,
    render: (a, inner) => {
      const label = oneLine(inner) || str(a.label);
      return label ? `- [${a.checked === true ? 'x' : ' '}] ${label}` : '';
    },
  });

  register('slider', {
    kind: 'leaf',
    render: (a) => {
      const value = str(a.value);
      const mark = (Array.isArray(a.marks) ? a.marks : []).find((m) => isObject(m) && same(m.value, a.value) && str(m.label));
      const range = str(a.min) && str(a.max) ? ` (${str(a.min)}–${str(a.max)})` : '';
      const shown = mark ? str(mark.label) : value;
      return shown ? `\n\n🎚️ ${str(a.label) ? `${oneLine(a.label)}: ` : ''}${shown}${range}\n\n` : '';
    },
  });

  // A field: its value as code (what was typed), or a blank.
  register(['input', 'textarea', 'date-picker', 'Input', 'Textarea', 'DatePicker'], {
    kind: 'leaf',
    render: (a) => {
      const value = oneLine(str(a.value)).replace(/`/g, "'");
      const hint = str(a.placeholder) ? ` _(${oneLine(a.placeholder)})_` : '';
      return `\n\n${str(a.label) ? `${oneLine(a.label)}: ` : ''}${value ? `\`${value}\`` : `____${hint}`}\n\n`;
    },
  });

  register(['button', 'Button'], { kind: 'collect', render: () => '' });
  register('pressable', { kind: 'collect', line: true, render: (a, inner) => listItem(inner) });
})();
