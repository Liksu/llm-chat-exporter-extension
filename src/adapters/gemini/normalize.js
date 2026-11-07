/**
 * Convert Gemini's batchexecute (RPC hNvQHb) response into our
 * NormalizedConversation shape.
 *
 * Tree shape (JSPB — sparse positional arrays, no field names):
 *
 *   parsed = [[ROUND_LATEST_FIELDS], …pad…]
 *
 *   ROUND_LATEST_FIELDS is a flat sequence of fields belonging to the most
 *   recent round, with the previous round (recursively, oldest at the
 *   bottom) tucked into one of the trailing slots:
 *     [0] [convId, requestId]                       — this round's identifier
 *     [1] [convId, prevReqId, prevCandidateId]      — pointer into the prev
 *         | null (when this is the first round)       round identifying which
 *                                                     candidate the user picked
 *     [2] user message tuple (text + attachments)
 *     [3] candidates wrapper
 *     [N] (optional) nested prev round, possibly inside one or more wrapper
 *         arrays. The slot index has varied across responses; we DFS the
 *         whole tree to collect every round-shaped subtree rather than
 *         following a fixed-slot linked list.
 *
 * User message tuple ([2]):
 *   [
 *     [
 *       "<user text>",                       — [0] visible prompt
 *       <number>,                            — [1] type flag (1 = text)
 *       null, null,
 *       [                                    — [4] attachments wrapper
 *         [null, null, null, [att, att, …]], — primary copy
 *         [att, att, …]                      — duplicate (we ignore it)
 *       ]
 *     ],
 *     <number>, null, 0,                     — [1..3] flags
 *     "<some_id>",                            — [4] turn id
 *     0, null, null, null, null,             — [5..9]
 *     []                                      — [10]
 *   ]
 *
 * Attachment shape (per item; index of relevant fields):
 *   type code at [1]:
 *     1  = image (inline)
 *           [3] = direct lh3.googleusercontent.com URL (fetchable as-is)
 *           [11] = mime
 *           [15] = [width, height, sizeBytes] (when present)
 *     3  = text file        ┐
 *     16 = generic file     ┘ both have:
 *           [7] = [thumbUrl, downloadUrl, uploadUrl]; we use [7][1]
 *           [11] = mime
 *
 * Candidate ([3] inside round.candidates, after drilling through wrappers):
 *   [
 *     "rc_<id>",                              — [0] candidate id
 *     ["<assistant markdown>"],               — [1] [text]; index 0 = markdown
 *     …a long sparse tail of metadata…
 *   ]
 *   The tail contains, at variable positions across model versions:
 *     - thinking summaries (an array containing one big string with
 *       "**Title**\n\nbody…\n\n\n**Title2**\n\n…" inside)
 *     - generated images (only for image-gen models like Nano Banana) as
 *       attachment-shaped tuples with type 1 and an lh3 URL
 *   We recover these via heuristic tree-walks rather than fixed indices.
 *
 * Citations: when Gemini answers questions about an uploaded document it
 * decorates the response with `[cite_start]` … `[cite: 49]` markers. We
 * strip them rather than render footnotes — the structured citation map
 * is interesting but adds a lot of noise.
 *
 * Image generation: assistant text contains placeholder URLs of the form
 *   http://googleusercontent.com/image_generation_content/<N>
 * pointing at images we collect from the response metadata. We strip the
 * placeholders from the text and emit each generated image as a separate
 * image block at the end of the assistant turn — the markdown renderer
 * embeds image blocks as base64 (md mode) or asset paths (zip mode), but
 * doesn't resolve free-form `![](filename)` markdown, so leaving an inline
 * reference would render as a broken duplicate.
 *
 * Reply elements: a placeholder URL on a line of its own marks where the
 * page draws an element whose data sits in the candidate:
 *   http://googleusercontent.com/immersive_entry_chip/<N>
 *     the chip of a document the reply opened in the side panel (Canvas
 *     document, code, slides, quiz, Deep Research report); its data is
 *     candidate[30][N] -- becomes an artifact, referenced where the chip was
 *   http://googleusercontent.com/deep_research_confirmation_content/<N>
 *     the Deep Research plan card -- becomes the plan as text
 * Components written as tags (<Callout>, <TemplateWidget>…) are turned into
 * markdown by components.js.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { isTextLikeMime, sanitizeFilename, log } = ns.utils;
  const { render: renderComponents } = ns.geminiComponents;

  // ---------------------------------------------------------------------- //
  //  Round walker                                                           //
  // ---------------------------------------------------------------------- //

  /**
   * Brief structural shape of a node, for diagnostic logging when something
   * doesn't match expectations. Returns e.g. `array(5)`, `string(42)`,
   * `null`, etc.
   */
  const shape = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `array(${v.length})`;
    if (typeof v === 'string') return `string(${v.length})`;
    return typeof v;
  };

  /**
   * Recognise a round container. Round shape (sparse positional array):
   *   [
   *     ["c_<convId>", "r_<reqId>"],          — [0] this round's ident
   *     <prev pointer or null>,                — [1]
   *     <user message tuple>,                  — [2]
   *     <candidates wrapper>,                  — [3]
   *     …trailing metadata, possibly more rounds nested somewhere…
   *   ]
   * The c_/r_ prefix pair on the ident is distinctive enough to use as a
   * unique signal; matching on both prefixes avoids false positives from
   * unrelated arrays that happen to start with a "c_…"-looking string.
   */
  const isRound = (node) =>
    Array.isArray(node) &&
    node.length >= 4 &&
    Array.isArray(node[0]) &&
    typeof node[0][0] === 'string' &&
    node[0][0].startsWith('c_') &&
    typeof node[0][1] === 'string' &&
    node[0][1].startsWith('r_');

  /**
   * Pull the round's completion timestamp out of its tuple. Gemini buries
   * a protobuf-style [unix_seconds, nanos] pair somewhere in the round's
   * trailing metadata (attached to whichever model variant served the
   * round). The exact position drifts across model families, so instead of
   * hard-coding an index we walk the tree and pick the LARGEST plausible
   * Unix-epoch value -- file-upload timestamps embedded inside the user
   * message attachments are always earlier than the round's own completion
   * time, so "max wins" reliably picks the right one.
   *
   * Range guard: 2020-01-01 .. 2040-01-01 in seconds. Returns ISO string
   * or undefined if nothing matched.
   */
  const TS_MIN = 1577836800; // 2020-01-01 UTC
  const TS_MAX = 2208988800; // 2040-01-01 UTC
  const extractRoundTimestamp = (roundNode) => {
    let bestSecs = 0;
    const visit = (n, depth) => {
      if (depth > 12) return;
      if (!Array.isArray(n)) return;
      // [secs, nanos] tuple — accept and stop descending into it.
      if (
        n.length === 2 &&
        typeof n[0] === 'number' &&
        typeof n[1] === 'number' &&
        n[0] >= TS_MIN &&
        n[0] <= TS_MAX &&
        n[1] >= 0 &&
        n[1] < 1e9
      ) {
        if (n[0] > bestSecs) bestSecs = n[0];
        return;
      }
      for (const c of n) visit(c, depth + 1);
    };
    visit(roundNode, 0);
    return bestSecs > 0 ? new Date(bestSecs * 1000).toISOString() : undefined;
  };

  /**
   * DFS the parsed payload and collect every round-shaped node we find,
   * deduped by request id. We don't try to follow a fixed linked-list
   * pattern: in practice Google has wrapped prior rounds with anywhere
   * from zero to a few extra array layers, and a strict next-slot walk
   * misses them. A flat tree-scan is simpler and survives any wrapper
   * shape Google chooses.
   *
   * Visit order is "latest first" because the latest round sits at the
   * outer level and prior rounds are nested inside it, so we reverse the
   * collected list to return chronological order. Dedup by reqId guards
   * against any accidental double-counting if the same round is reachable
   * via two paths.
   */
  const walkRounds = (data) => {
    log.debug('gemini walkRounds: input shape', shape(data),
      'data[0]:', shape(data && data[0]),
      'data[0][0]:', shape(data && data[0] && data[0][0]));

    const rounds = [];
    const seen = new Set();
    let visited = 0;

    const visit = (node, depth) => {
      if (depth > 40) return;
      if (!Array.isArray(node)) return;
      visited++;
      if (isRound(node)) {
        const reqId = node[0][1];
        if (!seen.has(reqId)) {
          seen.add(reqId);
          rounds.push({
            ident: node[0],
            prevPointer: node[1],
            userMsg: node[2],
            candidates: node[3],
            createdAt: extractRoundTimestamp(node),
          });
        }
        // Don't return — prior rounds are nested INSIDE this one, so we
        // need to keep descending.
      }
      for (const child of node) visit(child, depth + 1);
    };
    visit(data, 0);

    log.debug('gemini walkRounds: visited', visited, 'nodes, collected', rounds.length, 'rounds:',
      rounds.map((r) => r.ident && r.ident[1]).join(','));

    rounds.reverse();
    return rounds;
  };

  // ---------------------------------------------------------------------- //
  //  User message extraction                                                //
  // ---------------------------------------------------------------------- //

  const extractUserText = (userMsg) => {
    if (!Array.isArray(userMsg) || !Array.isArray(userMsg[0])) return '';
    const t = userMsg[0][0];
    return typeof t === 'string' ? t : '';
  };

  /**
   * Pull attachments from the user message. The wrapper at userMsg[0][4]
   * has up to two parallel copies of the attachment list; we read from the
   * first and ignore the duplicate. Each item is type-coded at index 1.
   */
  const extractUserAttachments = (userMsg) => {
    if (!Array.isArray(userMsg) || !Array.isArray(userMsg[0])) return [];
    const wrapper = userMsg[0][4];
    if (!Array.isArray(wrapper) || wrapper.length === 0) return [];

    // The "primary" attachment list is at wrapper[0][3]; fall back to
    // wrapper[1] (the duplicate) if the primary isn't shaped as expected.
    let atts = null;
    if (Array.isArray(wrapper[0]) && Array.isArray(wrapper[0][3])) {
      atts = wrapper[0][3];
    } else if (Array.isArray(wrapper[1])) {
      atts = wrapper[1];
    } else if (Array.isArray(wrapper[0])) {
      atts = wrapper[0];
    }
    if (!Array.isArray(atts)) return [];

    const out = [];
    for (const a of atts) {
      if (!Array.isArray(a) || a.length < 3) continue;
      const typeCode = a[1];
      const fileName = typeof a[2] === 'string' ? a[2] : '';
      if (!fileName) continue;

      if (typeCode === 1) {
        const url = typeof a[3] === 'string' ? a[3] : '';
        const mime = typeof a[11] === 'string' ? a[11] : 'image/png';
        if (!url) continue;
        out.push({ kind: 'image', fileName, url, mime });
        continue;
      }

      if (typeCode === 3 || typeCode === 16) {
        const urls = Array.isArray(a[7]) ? a[7] : [];
        const downloadUrl = typeof urls[1] === 'string' ? urls[1] : '';
        const mime = typeof a[11] === 'string' ? a[11] : 'application/octet-stream';
        if (!downloadUrl) continue;
        out.push({ kind: 'file', fileName, url: downloadUrl, mime });
        continue;
      }
      // Unknown type code — log and skip.
      log.debug('gemini: unknown attachment type code', typeCode, fileName);
    }
    return out;
  };

  // ---------------------------------------------------------------------- //
  //  Candidate extraction                                                   //
  // ---------------------------------------------------------------------- //

  /**
   * Drill through the candidate-wrapper layers to find the array whose
   * head is a string starting with "rc_". Each round currently has one
   * active candidate; if Gemini ever returns multiple in parallel (it
   * historically did A/B swap variants), we'd surface only the first.
   */
  const extractCandidate = (candidates) => {
    let node = candidates;
    for (let depth = 0; depth < 6; depth++) {
      if (!Array.isArray(node) || node.length === 0) return null;
      if (typeof node[0] === 'string' && node[0].startsWith('rc_')) return node;
      node = node[0];
    }
    return null;
  };

  /**
   * Immersive documents -- what a reply opens in the side panel -- are at
   * candidate[30][N], N being the number in the reply's
   * `immersive_entry_chip/<N>` placeholder. Common fields:
   *   [0] id, [2] title, [9] file name (Canvas), [10] kind:
   */
  const IMMERSIVE = {
    DOCUMENT: 1, // Canvas text document: [4] markdown
    CODE: 2, //     Canvas code: [4] the file in one fenced block
    RESEARCH: 3, // Deep Research report: [4] markdown, [5] sources
    QUIZ: 4, //     interactive quiz: [15] questions
    SLIDES: 15, //  slide deck: [19][0] one HTML page
  };

  /** Code-fence language for a file name's extension ('' when unknown). */
  const LANGUAGE_BY_EXT = {
    md: 'markdown',
    html: 'html',
    htm: 'html',
    css: 'css',
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    json: 'json',
    svg: 'xml',
    xml: 'xml',
  };
  const languageOf = (fileName) => {
    const ext = /\.([a-z0-9]+)$/i.exec(fileName || '');
    return (ext && LANGUAGE_BY_EXT[ext[1].toLowerCase()]) || '';
  };

  const docTitle = (doc) => (typeof doc[2] === 'string' ? doc[2].trim() : '');

  /** The Canvas file name ([9]), or one made from the title. */
  const docFileName = (doc, ext) =>
    typeof doc[9] === 'string' && /\.[a-z0-9]+$/i.test(doc[9])
      ? sanitizeFilename(doc[9])
      : `${sanitizeFilename(docTitle(doc) || 'canvas')}${ext}`;

  const docId = (doc) => (typeof doc[0] === 'string' && doc[0] ? doc[0] : `immersive:${docTitle(doc)}`);

  /**
   * A Canvas document or code file. Code comes as the whole file in one
   * fenced block (```html … ```); the file holds what is inside the fence.
   */
  const canvasDoc = (doc) => {
    const fileName = docFileName(doc, '.md');
    let content = doc[4];
    let language = languageOf(fileName);
    const fenced = doc[10] === IMMERSIVE.CODE && /^(`{3,}|~{3,})([^\n`]*)\n([\s\S]*)\n\1[ \t]*$/.exec(content.trim());
    if (fenced) {
      content = `${fenced[3]}\n`;
      language = fenced[2].trim() || language;
    }
    return { id: docId(doc), title: docTitle(doc) || fileName, language, content, fileName };
  };

  /** A slide deck: one HTML page with every slide. */
  const slidesDoc = (doc) => {
    const html = Array.isArray(doc[19]) ? doc[19][0] : null;
    if (typeof html !== 'string' || !html.trim()) return null;
    const fileName = docFileName(doc, '.html');
    return { id: docId(doc), title: docTitle(doc) || fileName, language: 'html', content: html, fileName };
  };

  /**
   * A quiz as markdown: each question with its options, the right one
   * ticked, and the explanation the quiz shows after an answer. Question
   * tuples are at [15][0][0]: [question, [[option, isCorrect, explanation, …], …]].
   */
  const quizDoc = (doc) => {
    const questions = Array.isArray(doc[15]) && Array.isArray(doc[15][0]) && Array.isArray(doc[15][0][0])
      ? doc[15][0][0].filter((q) => Array.isArray(q) && typeof q[0] === 'string')
      : [];
    if (!questions.length) return null;
    const title = docTitle(doc) || 'Quiz';
    const out = [`# ${title}`];
    questions.forEach((q, i) => {
      out.push('', `### ${i + 1}. ${q[0].trim()}`, '');
      for (const o of Array.isArray(q[1]) ? q[1] : []) {
        if (!Array.isArray(o) || typeof o[0] !== 'string') continue;
        const why = typeof o[2] === 'string' && o[2].trim() ? ` — _${o[2].trim()}_` : '';
        out.push(`- [${o[1] === true ? 'x' : ' '}] ${o[0].trim()}${why}`);
      }
    });
    // The file name says .json (what the page loads); the export is markdown.
    const fileName = docFileName(doc, '.md').replace(/\.json$/i, '.md');
    return { id: docId(doc), title, language: 'markdown', content: `${out.join('\n')}\n`, fileName };
  };

  /**
   * Deep Research report: [0] id "im_…", [2] title of the research plan,
   * [4] report markdown with "[cite: 1, 2]" markers, [5] citation data
   * where each source is [[favicon, url, title, …], n, …] (n = the number
   * used in markers). Returns an Artifact (markers turned into links,
   * Sources list appended) or null.
   */
  const researchReport = (doc) => {
    if (typeof doc[4] !== 'string' || !doc[4].trim()) return null;
    const sources = new Map();
    const visit = (node, depth) => {
      if (!Array.isArray(node) || depth > 12) return;
      const head = node[0];
      if (Array.isArray(head) && typeof head[1] === 'string' && /^https?:\/\//.test(head[1]) &&
          Number.isInteger(node[1]) && !sources.has(node[1])) {
        sources.set(node[1], { url: head[1], title: typeof head[2] === 'string' && head[2] ? head[2] : head[1] });
      }
      for (const child of node) visit(child, depth + 1);
    };
    for (const part of Array.isArray(doc[5]) ? doc[5] : []) {
      if (part && typeof part === 'object') for (const v of Object.values(part)) visit(v, 0);
    }
    let content = doc[4].replace(/\s?\[cite: ([\d,\s]+)\]/g, (m, nums) => {
      const refs = nums.split(',').map((n) => parseInt(n, 10)).filter(Number.isInteger);
      return ` ${refs.map((n) => (sources.has(n) ? `[[${n}]](${sources.get(n).url})` : `[${n}]`)).join(' ')}`;
    });
    if (sources.size) {
      const list = [...sources.entries()].sort((a, b) => a[0] - b[0])
        .map(([n, s]) => `${n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`);
      content = `${content.trimEnd()}\n\n## Sources\n\n${list.join('\n')}\n`;
    }
    const heading = /^#\s+(.+)$/m.exec(doc[4]);
    const title = (heading && heading[1].trim()) || (typeof doc[2] === 'string' && doc[2]) || 'Deep Research report';
    return {
      id: typeof doc[0] === 'string' ? doc[0] : `immersive:${title}`,
      title,
      language: 'markdown',
      mime: 'text/markdown',
      content,
      fileName: `${sanitizeFilename(title)}.md`,
      source: 'Deep Research',
    };
  };

  /** One immersive document → an Artifact, or null when it has no content we know. */
  const immersiveDoc = (doc) => {
    if (!Array.isArray(doc)) return null;
    const kind = doc[10];
    // Reports from before the kind field have an "im_…" id.
    if (kind === IMMERSIVE.RESEARCH || (typeof doc[0] === 'string' && doc[0].startsWith('im_'))) {
      return researchReport(doc);
    }
    if (kind === IMMERSIVE.QUIZ) return quizDoc(doc);
    if (kind === IMMERSIVE.SLIDES) return slidesDoc(doc);
    if (typeof doc[4] === 'string' && doc[4].trim()) return canvasDoc(doc);
    log.debug('gemini: immersive document of unknown kind', kind, docTitle(doc));
    return null;
  };

  /** candidate[30] as Artifacts, index-aligned with the chip numbers (null = skipped). */
  const extractImmersiveDocs = (cand) =>
    (Array.isArray(cand) && Array.isArray(cand[30]) ? cand[30] : []).map(immersiveDoc);

  /**
   * The Deep Research plan card ("Start research" / "Edit plan") shown at a
   * `deep_research_confirmation_content/<N>` placeholder. It sits in the
   * round's candidate metadata, tied to the placeholder by its URL:
   *   [title, [[1, step, details], [2, step], …], eta, [start label], [url, N], …]
   * Returns the plan as markdown, or '' when it isn't there.
   */
  const extractResearchPlan = (candidates, url) => {
    let plan = null;
    const visit = (node, depth) => {
      if (plan || depth > 20 || !Array.isArray(node)) return;
      if (typeof node[0] === 'string' && Array.isArray(node[1]) && Array.isArray(node[4]) && node[4][0] === url) {
        plan = node;
        return;
      }
      for (const child of node) visit(child, depth + 1);
    };
    visit(candidates, 0);
    if (!plan) return '';
    const steps = plan[1]
      .filter((s) => Array.isArray(s) && typeof s[1] === 'string')
      .map((s, i) => {
        const details = typeof s[2] === 'string' && s[2].trim()
          ? `\n${s[2].trim().split('\n').map((l) => `   ${l.trim()}`).join('\n')}`
          : '';
        return `${i + 1}. ${s[1].trim()}${details}`;
      });
    return [`📋 **Research plan: ${plan[0].trim()}**`, ...(steps.length ? ['', ...steps] : [])].join('\n');
  };

  const extractCandidateText = (candidate) => {
    if (!Array.isArray(candidate)) return '';
    const arr = candidate[1];
    if (!Array.isArray(arr)) return '';
    const t = arr[0];
    return typeof t === 'string' ? t : '';
  };

  /**
   * Recursive scan for the thinking-summary string. We look for an array
   * containing exactly one string that opens with "**" and contains at
   * least two "**…**" bold runs (the heading style Gemini uses for each
   * summary section). Returns the raw markdown (already a string), or null.
   *
   * Capped at depth 20 to avoid pathological recursion through huge
   * safety-classifier blobs.
   */
  const extractThinking = (candidate) => {
    let found = null;
    const visit = (node, depth) => {
      if (found || depth > 20) return;
      if (Array.isArray(node)) {
        if (
          node.length === 1 &&
          typeof node[0] === 'string' &&
          node[0].startsWith('**') &&
          (node[0].match(/\*\*/g) || []).length >= 4 &&
          node[0].length > 60
        ) {
          found = node[0];
          return;
        }
        for (const item of node) visit(item, depth + 1);
      } else if (node && typeof node === 'object') {
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(candidate, 0);
    return found;
  };

  /**
   * True iff `node` looks like a generated-image leaf tuple — same shape as
   * a user-uploaded image: type code 1 at [1], filename at [2], lh3 URL at
   * [3], image mime at [11]. We use this both to recognise leaves during
   * the scan and to skip descending into them.
   */
  const isGeneratedImageLeaf = (node) =>
    Array.isArray(node) &&
    node.length >= 12 &&
    node[0] === null &&
    node[1] === 1 &&
    typeof node[2] === 'string' &&
    typeof node[3] === 'string' &&
    node[3].startsWith('https://lh3.googleusercontent.com/') &&
    typeof node[11] === 'string' &&
    node[11].startsWith('image/');

  /**
   * Recursive scan for generated-image tuples (only present in responses
   * from image-gen models like Nano Banana / Imagen).
   *
   * Dedup strategy: when an array contains MULTIPLE image-leaf children as
   * siblings, those are alternative formats of one logical image — Gemini
   * typically returns both a PNG and a JPEG of the same generated picture,
   * with totally unrelated filenames (so a name-based dedup misses it).
   * We pick the PNG when available (better for screenshots/logos with
   * sharp edges, smaller for monochrome content too) and fall back to the
   * first leaf otherwise. We then DO NOT descend into image leaves so we
   * never count the alternates again.
   *
   * URL dedup is a second-line guard against the same image appearing in
   * multiple places of the tree (e.g. once inline in the assistant text
   * and once in the metadata array).
   */
  const extractGeneratedImages = (candidate) => {
    const seenUrls = new Set();
    const out = [];
    const visit = (node, depth) => {
      if (depth > 20) return;
      if (Array.isArray(node)) {
        // Collect direct image-leaf siblings (= format alternatives of one
        // logical image). Pick PNG, else first.
        const leaves = node.filter(isGeneratedImageLeaf);
        if (leaves.length > 0) {
          const pick = leaves.find((c) => c[11] === 'image/png') || leaves[0];
          if (!seenUrls.has(pick[3])) {
            seenUrls.add(pick[3]);
            out.push({ fileName: pick[2], url: pick[3], mime: pick[11] });
          }
        }
        // Descend into non-leaf children only.
        for (const item of node) {
          if (!isGeneratedImageLeaf(item)) visit(item, depth + 1);
        }
      } else if (node && typeof node === 'object') {
        for (const v of Object.values(node)) visit(v, depth + 1);
      }
    };
    visit(candidate, 0);
    return out;
  };

  // ---------------------------------------------------------------------- //
  //  Text post-processing                                                   //
  // ---------------------------------------------------------------------- //

  /** Strip Gemini's `[cite_start]` and `[cite: …]` markers — see header doc. */
  const stripCitationMarkers = (text) =>
    String(text || '')
      .replace(/\[cite_start\]/g, '')
      .replace(/\[cite:\s*[\d,\s]+\]/g, '');

  /**
   * Remove `http://googleusercontent.com/image_generation_content/<N>`
   * placeholder URLs from the assistant text. See header doc for why we
   * strip rather than substitute. Trailing whitespace cleanup is needed
   * because the placeholder is typically glued to the end of a sentence
   * ("...в хорошем качестве.<URL>") and removing it leaves a stray newline.
   */
  const stripImagePlaceholders = (text) =>
    String(text || '')
      .replace(/https?:\/\/googleusercontent\.com\/image_generation_content\/\d+/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

  /**
   * Split reply text at element placeholders (see header doc) into text
   * pieces and {kind, index, url} markers. Only a placeholder alone on its
   * line counts: a reply may quote such a URL as text.
   */
  const ELEMENT_PLACEHOLDER_RE =
    /^[ \t]*(https?:\/\/googleusercontent\.com\/(immersive_entry_chip|deep_research_confirmation_content)\/(\d+))[ \t]*$/gm;
  const splitPlaceholders = (text) => {
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(ELEMENT_PLACEHOLDER_RE)) {
      parts.push(text.slice(last, m.index));
      parts.push({ kind: m[2], index: Number(m[3]), url: m[1] });
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts;
  };

  // ---------------------------------------------------------------------- //
  //  Top-level normalize                                                    //
  // ---------------------------------------------------------------------- //

  /**
   * @param {any} raw    parsed batchexecute payload (output of api.js
   *                     fetchConversation)
   * @param {{title?:string, inlineTextFiles?:boolean}} options
   * @returns {{
   *   conversation: import('../../core/utils.js').NormalizedConversation,
   *   imageRefs: Array<{turnIndex:number, blockIndex:number, ref:{url:string}}>,
   *   binaryAttachmentRefs: Array<{turnIndex:number, attIndex:number, url:string}>,
   *   textFileRefs: Array<{turnIndex:number, attIndex:number, url:string}>
   * }}
   */
  const normalize = (raw, options) => {
    const opts = options || {};
    const inlineTextFiles = !!opts.inlineTextFiles;
    const rounds = walkRounds(raw);
    const turns = [];
    const imageRefs = [];
    const binaryAttachmentRefs = [];
    const textFileRefs = [];
    const artifacts = []; // side-panel documents: Canvas, Deep Research reports

    for (const round of rounds) {
      // ------- USER TURN --------------------------------------------------
      const userText = extractUserText(round.userMsg);
      const userAtts = extractUserAttachments(round.userMsg);

      const userBlocks = [];
      if (userText && userText.trim()) {
        userBlocks.push({ kind: 'text', text: userText });
      }

      const userTurnAttachments = [];
      const userTurnIndex = turns.length;

      for (const att of userAtts) {
        if (att.kind === 'image') {
          const blockIndex = userBlocks.length;
          userBlocks.push({
            kind: 'image',
            mime: att.mime,
            name: att.fileName,
            bytes: new Uint8Array(0),
          });
          imageRefs.push({
            turnIndex: userTurnIndex,
            blockIndex,
            ref: { url: att.url },
          });
          continue;
        }
        // file (text-like or binary)
        const isText = isTextLikeMime(att.mime, att.fileName);
        if (inlineTextFiles && isText) {
          const attIndex = userTurnAttachments.length;
          userTurnAttachments.push({
            category: 'text',
            fileName: att.fileName,
            mime: att.mime,
            text: '',
            needsContentFetch: true,
          });
          textFileRefs.push({
            turnIndex: userTurnIndex,
            attIndex,
            url: att.url,
          });
          continue;
        }
        const attIndex = userTurnAttachments.length;
        userTurnAttachments.push({
          category: 'binary',
          fileName: att.fileName,
          mime: att.mime,
          isImage: false,
        });
        binaryAttachmentRefs.push({
          turnIndex: userTurnIndex,
          attIndex,
          url: att.url,
        });
      }

      if (userBlocks.length > 0 || userTurnAttachments.length > 0) {
        turns.push({
          role: 'human',
          // Both turns in a round share the round's completion timestamp --
          // Gemini's payload doesn't separate "user sent at" from "assistant
          // replied at", and the difference is rarely interesting anyway.
          createdAt: round.createdAt,
          blocks: userBlocks,
          attachments: userTurnAttachments,
        });
      }

      // ------- ASSISTANT TURN ---------------------------------------------
      const cand = extractCandidate(round.candidates);
      if (!cand) continue;

      const rawText = extractCandidateText(cand);
      const generatedImages = extractGeneratedImages(cand);
      const cleanedText = renderComponents(stripImagePlaceholders(stripCitationMarkers(rawText)));
      const thinking = extractThinking(cand);
      const docs = extractImmersiveDocs(cand);

      const aBlocks = [];
      if (thinking) {
        aBlocks.push({ kind: 'thinking', text: thinking });
      }
      // A document keeps its id across rounds: one artifact, referenced
      // from each turn that showed its chip. Rounds run oldest first and
      // the last copy seen wins, so the file is the newest version even
      // where an earlier round holds an older one.
      const placedDocs = new Set();
      const placeDoc = (doc) => {
        const seen = artifacts.findIndex((a) => a.id === doc.id);
        if (seen < 0) artifacts.push(doc);
        else artifacts[seen] = doc;
        aBlocks.push({ kind: 'artifact_ref', artifactId: doc.id });
        placedDocs.add(doc);
      };
      for (const part of splitPlaceholders(cleanedText)) {
        if (typeof part === 'string') {
          const text = part.replace(/^\n+|\n+$/g, '');
          if (text.trim()) aBlocks.push({ kind: 'text', text });
        } else if (part.kind === 'immersive_entry_chip') {
          if (docs[part.index]) placeDoc(docs[part.index]);
        } else {
          const plan = extractResearchPlan(round.candidates, part.url);
          if (plan) aBlocks.push({ kind: 'text', text: plan });
        }
      }
      // A document whose chip isn't in the text still belongs to the reply.
      for (const doc of docs) if (doc && !placedDocs.has(doc)) placeDoc(doc);
      // Generated images get their own image blocks at the end of the turn,
      // since the renderer only embeds image blocks (it won't resolve any
      // free-form markdown image refs we'd leave behind in the text).
      const assistantTurnIndex = turns.length;
      for (const gi of generatedImages) {
        const blockIndex = aBlocks.length;
        aBlocks.push({
          kind: 'image',
          mime: gi.mime,
          name: gi.fileName,
          bytes: new Uint8Array(0),
        });
        imageRefs.push({
          turnIndex: assistantTurnIndex,
          blockIndex,
          ref: { url: gi.url },
        });
      }

      if (aBlocks.length > 0) {
        turns.push({
          role: 'assistant',
          createdAt: round.createdAt,
          blocks: aBlocks,
          attachments: [],
        });
      }
    }

    const title = typeof opts.title === 'string' && opts.title ? opts.title : 'Gemini conversation';
    const conversation = {
      title,
      sourceLLM: 'gemini',
      turns,
      artifacts,
    };
    return {
      conversation,
      imageRefs,
      binaryAttachmentRefs,
      textFileRefs,
    };
  };

  ns.geminiNormalize = { normalize };
})();
