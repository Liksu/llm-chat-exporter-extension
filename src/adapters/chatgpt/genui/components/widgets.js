/**
 * ChatGPT generative UI -- named widgets: cards drawn from data the server
 * resolved (componentResults) or that the model wrote into the tag.
 *
 *   <LearningQuiz title questions={[…]}/>   → numbered questions, options,
 *                                             the answer and its feedback
 *                                             folded in <details> (as the
 *                                             Claude quiz)
 *   <LearningFlashcards title cards={[{front, back}]}/> → front — back
 *   <LanguageLearningBlockWidgetPronunciation source_text
 *     pronunciation_hint pronunciation_language/> → word, how to say it
 *   <StockChart ticker="NVDA"/>             → price, change, key stats
 *                                             (not the intraday series)
 *   <NbaScores game_ids={[…]}/>             → teams, scores, status
 *   <ReservationTimePillsRefWidget ref/>    → free time slots, each a
 *                                             booking link
 *   <LearningViz type_id/>                  → its title and description
 *
 * The page shows the resolved data when there is some (a quiz's options
 * come shuffled and re-lettered there), else the tag's own. A widget with
 * neither renders as null: the message then falls back to the server's
 * static version (render.js).
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const g = (ns.chatgptGenui = ns.chatgptGenui || {});
  const { register } = g.registry;
  const { isObject, oneLine, linkText, str } = g.util;

  const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);
  const block = (rows) => `\n\n${rows.filter((r) => r != null).join('\n')}\n\n`;

  register('LearningQuiz', {
    kind: 'leaf',
    render: (a, ctx) => {
      const res = ctx.take('LearningQuiz');
      const questions = list(res && res.questions).length ? list(res.questions) : list(a.questions);
      if (!questions.length) return null;
      const out = [`**📝 ${oneLine(str(res && res.title) || str(a.title) || 'Quiz')}**`];
      questions.forEach((q, i) => {
        out.push('', `**${i + 1}. ${oneLine(str(q.prompt) || str(q.question))}**`);
        const options = list(q.options);
        const name = (o) => `${/^[A-Z0-9]$/i.test(str(o.value)) ? `${str(o.value)}) ` : ''}${oneLine(str(o.label))}`;
        if (options.length) out.push('', ...options.map((o) => `- ${name(o)}`));
        const correct = [q.correct_values, q.correctValues].find(Array.isArray) || [];
        const right = options.filter((o) => correct.map(String).includes(str(o.value)));
        const answer = right.map((o) => [`**${name(o)}**`, str(o.feedback)].filter(Boolean).join(' — ')).join('\n\n');
        if (answer) out.push('', '<details><summary>Answer</summary>', '', answer, '', '</details>');
      });
      return block(out);
    },
  });

  register('LearningFlashcards', {
    kind: 'leaf',
    render: (a, ctx) => {
      const res = ctx.take('LearningFlashcards');
      const cards = list(res && res.cards).length ? list(res.cards) : list(a.cards);
      if (!cards.length) return null;
      const title = oneLine(str(res && res.title) || str(a.title) || 'Flashcards');
      return block([`**🗂️ ${title}**`, '', ...cards.map((c, i) => `${i + 1}. **${oneLine(str(c.front))}** — ${oneLine(str(c.back))}`)]);
    },
  });

  register('LanguageLearningBlockWidgetPronunciation', {
    kind: 'leaf',
    render: (a) => {
      const word = oneLine(str(a.source_text));
      if (!word) return null;
      const hint = str(a.pronunciation_hint) ? ` — _${oneLine(a.pronunciation_hint)}_` : '';
      const lang = str(a.pronunciation_language) ? ` (${oneLine(a.pronunciation_language)})` : '';
      return block([`🔊 **${word}**${hint}${lang}`]);
    },
  });

  // Title and description only: the diagram itself is drawn by the app.
  register('LearningViz', {
    kind: 'leaf',
    render: (a, ctx) => {
      const res = ctx.take('LearningViz') || {};
      const title = oneLine(str(res.title) || str(a.title));
      const about = oneLine(str(res.description) || str(a.description));
      if (!title && !about) return null;
      return block([[title && `**📊 ${title}**`, about && `_${about}_`].filter(Boolean).join('\n\n')]);
    },
  });

  register('StockChart', {
    kind: 'leaf',
    render: (a, ctx) => {
      const s = ctx.take('StockChart');
      const ticker = oneLine(str(a.ticker));
      if (!s) return ticker ? block([`📈 **${ticker}**`]) : null;
      const range = isObject(s.timeframe_configs) && isObject(s.timeframe_configs[s.default_range]) ? s.timeframe_configs[s.default_range] : {};
      const summary = isObject(s.fallback_summary) ? s.fallback_summary : isObject(range.summary) ? range.summary : {};
      const head = [str(s.current_price_text) || str(summary.price_text), str(summary.price_change_text), str(s.price_status_text)].filter(Boolean);
      const after = isObject(s.after_hours) ? s.after_hours : {};
      const afterLine = str(after.price_text)
        ? `${str(after.label) || 'After hours'}: ${[after.price_text, after.change_text, after.percent_text].map(str).filter(Boolean).join(' ')}`
        : '';
      const stats = list(s.metrics_display)
        .flatMap((row) => list(row.cols))
        .filter((c) => str(c.label) && str(c.value))
        .map((c) => `${oneLine(c.label)} ${oneLine(c.value)}`);
      return block([
        `📈 **${oneLine(str(s.asset_display_name) || ticker || 'Stock')}** — ${head.join(' · ')}`,
        ...(afterLine ? ['', afterLine] : []),
        ...(stats.length ? ['', `_${stats.join(' · ')}_`] : []),
      ]);
    },
  });

  register('NbaScores', {
    kind: 'leaf',
    render: (a, ctx) => {
      const ids = (Array.isArray(a.game_ids) ? a.game_ids : []).map(String);
      const gamesOf = (s) => list(s.rows).flatMap((r) => list(r.games)).map((x) => x.game).filter(isObject);
      const s = ctx.take('NbaScores', (st) => !ids.length || gamesOf(st).some((x) => ids.includes(String(x.game_id))));
      const games = s ? gamesOf(s).filter((x) => !ids.length || ids.includes(String(x.game_id))) : [];
      if (!games.length) return null;
      const team = (t) => {
        const t1 = `${oneLine(str(t.name))}${str(t.score) ? ` ${str(t.score)}` : ''}`;
        return t.winner === true ? `**${t1}**` : t1;
      };
      return block(
        games.map((x) => {
          const status = [x.primaryLabel, x.secondaryLabel].map(str).filter(Boolean).join(' · ');
          return `- 🏀 ${list(x.teams).map(team).join(' – ')}${status ? ` (${status})` : ''}`;
        })
      );
    },
  });

  register('ReservationTimePillsRefWidget', {
    kind: 'leaf',
    render: (a, ctx) => {
      const place = typeof a.ref === 'string' ? ctx.data.places.get(a.ref) : null;
      const name = place && str(place.name);
      const ident = (st) => (isObject(st.reservation_identity) ? st.reservation_identity : {});
      const s = (name && ctx.take('ReservationTimePillsRefWidget', (st) => str(ident(st).name) === name)) || ctx.take('ReservationTimePillsRefWidget');
      if (!s) return null;
      const link = (label, url) => (str(url) ? `[${linkText(label)}](${str(url)})` : oneLine(label));
      const rows = list(s.groups).map((grp) => {
        const when = [grp.request_date_label, grp.party_size_label].map(str).filter(Boolean).join(' · ');
        const times = list(grp.times).map((t) => link(str(t.formatted_time) || str(t.start_date_time), t.url));
        const book = list(grp.change_options).filter((o) => str(o.provider_name) && str(o.url)).map((o) => link(o.provider_name, o.url));
        const slots = times.length ? times.join(' · ') : oneLine(str(grp.empty_state_label));
        return `- 🕒 ${when ? `${when}: ` : ''}${slots}${book.length ? ` (book: ${book.join(', ')})` : ''}`;
      });
      return rows.length ? block(rows) : null;
    },
  });
})();
