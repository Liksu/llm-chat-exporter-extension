/**
 * ChatGPT generative UI -- layout components (the vocabulary mirrors
 * OpenAI's ChatKit widgets):
 *
 *   <box gap={2}> <row> <col> <grid columns={2}> <grid-item> <card> <text>
 *   <label> <form> <list> …   containers: their content stays, de-indented
 *                             so it isn't read as a code block; a grid → a
 *                             list (one item per tile)
 *   <caption> <badge> <title> inline formatting (_…_, _(…)_, **…**)
 *   <icon name="…"/>          arrow icons stay as ↓ → (the edges of the
 *                             little flow diagrams the model draws); other
 *                             icons are decoration
 *   <divider/>                a rule
 *   <image src alt/>          the picture
 *   <WritingBlock>…</…>       a draft to copy and send as is (a card with a
 *                             copy button) → a ```text block
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { register } = g.registry;
  const { linkText } = g.util;

  register(
    ['box', 'row', 'col', 'grid-item', 'card', 'text', 'markdown', 'list', 'list-item', 'list-view', 'list-view-item', 'label', 'form'],
    { kind: 'block' }
  );
  register('grid', { kind: 'block', list: true });

  register('caption', { kind: 'wrap', wrap: (s) => `_${s}_` });
  register('badge', { kind: 'wrap', wrap: (s) => `_(${s})_` });
  register('title', { kind: 'wrap', wrap: (s) => `**${s}**` });

  register(['spacer', 'Spacer'], { kind: 'drop' });
  register('WritingBlock', { kind: 'draft' });

  const ARROWS = { 'arrow-down': '↓', 'arrow-up': '↑', 'arrow-right': '→', 'arrow-left': '←' };
  register(['icon', 'Icon'], { kind: 'leaf', render: (a) => ARROWS[a.name] || '' });
  register(['divider', 'Divider'], { kind: 'leaf', render: () => '\n\n---\n\n' });
  register(['image', 'Image'], {
    kind: 'leaf',
    render: (a) => (typeof a.src === 'string' && a.src ? `![${linkText(a.alt || '')}](${a.src})` : ''),
  });
})();
