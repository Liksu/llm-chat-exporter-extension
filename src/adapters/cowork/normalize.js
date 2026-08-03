/**
 * Convert a claude.ai Cowork event log into our NormalizedConversation shape.
 *
 * Cowork is an agent session, not a chat: the API returns a flat, append-only
 * log of everything the agent did. In the reference capture that was 7248
 * events, of which roughly TWENTY were the conversation a human would
 * recognise. The rest is machinery:
 *
 *   ~4500  subagent traffic          (payload.parent_tool_use_id !== null)
 *   ~2400  system/control/env noise  (task_progress, hooks, rate limits, …)
 *     ~40  top-level tool calls      (Agent, Write, TaskCreate, …)
 *
 * So the job here is mostly subtraction. What survives:
 *
 *   human turn      source 'client' + user + plain-string content that isn't
 *                   a <system-reminder> injection
 *   assistant text  assistant events at top level (parent_tool_use_id null)
 *   agent runs      one merged `thinking` line per Agent invocation, with
 *                   its tool/token/duration totals — so a session that
 *                   launched 16 research agents reads as 16 lines instead of
 *                   4500 events. Routed through `thinking` on purpose: with
 *                   "include reasoning" off, agent machinery disappears
 *                   entirely and the export is just the conversation.
 *   documents       `Write` tool calls carry their full file content inline,
 *                   so files the agent authored become artifacts without any
 *                   download API — which matters, because the sandbox file
 *                   endpoints reject cowork's non-UUID session id.
 *   answers         AskUserQuestion results are the human picking an option,
 *                   so they're attributed to the human, not to a tool.
 *
 * Thinking content is NOT recoverable: every thinking block in the log has
 * `thinking: ""` and only a `signature`. The server strips it. We drop those
 * empty blocks rather than emit hollow <details> sections.
 */
(function () {
  const ns = (self.__exporter = self.__exporter || {});
  const { safeStringify, sanitizeFilename } = ns.utils;

  const isObject = (v) => v !== null && typeof v === 'object';

  /** Injected context blocks that the UI never shows the user. */
  const isSystemReminder = (s) => /^\s*<system-reminder>/.test(String(s || ''));

  /** 140849 → "141k", 950 → "950" */
  const formatTokens = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return String(n);
    if (n < 1000000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1000000).toFixed(1)}M`;
  };

  /** 1017462 → "17m", 45000 → "45s" */
  const formatDuration = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  };

  const toIso = (s) => {
    if (typeof s !== 'string' || !s) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  /**
   * AskUserQuestion results arrive as a single sentence:
   *
   *   The user answered: "Q1"="A1", "Q2"="A2". Read the answers carefully —
   *   they may request clarification, changes, or that you not proceed…
   *
   * Strip the framing so the export shows what the user actually chose,
   * without the instruction addressed to the model.
   */
  const cleanAnswerText = (raw) => {
    let s = String(raw || '').trim();
    s = s.replace(/^The user (?:answered|has answered):\s*/i, '');
    s = s.replace(/\s*Read the answers carefully[\s\S]*$/i, '');
    return s.trim();
  };

  /** tool_result content is either a string or an array of {type:'text'} blocks. */
  const toolResultText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n\n');
    }
    return '';
  };

  /**
   * Pre-scan: last `task_progress` event per Agent tool_use_id carries the
   * cumulative usage for that subagent run, which is exactly what we need
   * for the one-line summary.
   */
  const collectAgentUsage = (events) => {
    const usage = new Map();
    for (const e of events) {
      const p = e && e.payload;
      if (!isObject(p) || p.subtype !== 'task_progress') continue;
      const id = p.tool_use_id;
      if (!id || !isObject(p.usage)) continue;
      const prev = usage.get(id);
      if (!prev || (p.usage.tool_uses || 0) >= (prev.tool_uses || 0)) usage.set(id, p.usage);
    }
    return usage;
  };

  /**
   * @param {object} session  session metadata (already unwrapped by api.js)
   * @param {Array}  events   full event log, ascending by sequence_num
   * @returns {{ conversation: import('../../core/utils.js').NormalizedConversation }}
   */
  const normalize = (session, events, options) => {
    void options;
    const list = Array.isArray(events) ? events : [];
    const agentUsage = collectAgentUsage(list);

    const turns = [];
    const artifacts = [];
    const artifactByPath = new Map();

    // Tool-call bookkeeping, so results can be routed (or dropped) by the
    // kind of call they answer.
    const agentToolIds = new Map(); // tool_use_id -> description
    const askToolIds = new Set();
    const writeToolIds = new Set();

    let currentRole = null;
    let currentBlocks = null;
    let currentCreatedAt;
    // Consecutive Agent summaries merge into a single thinking block —
    // agents are launched in parallel batches, and six <details> sections
    // in a row would be worse than one list.
    let openAgentBlock = null;

    const flush = () => {
      if (!currentRole) return;
      turns.push({
        role: currentRole,
        createdAt: currentCreatedAt,
        blocks: currentBlocks,
        attachments: [],
      });
      currentRole = null;
      currentBlocks = null;
      currentCreatedAt = undefined;
      openAgentBlock = null;
    };

    const ensureTurn = (role, createdAt) => {
      if (currentRole !== role) {
        flush();
        currentRole = role;
        currentBlocks = [];
        currentCreatedAt = createdAt;
      }
    };

    const pushBlock = (role, block, createdAt) => {
      ensureTurn(role, createdAt);
      currentBlocks.push(block);
      openAgentBlock = null;
    };

    const pushAgentLine = (line, createdAt) => {
      ensureTurn('assistant', createdAt);
      if (openAgentBlock) {
        openAgentBlock.text += `\n${line}`;
        return;
      }
      const block = { kind: 'thinking', text: line };
      currentBlocks.push(block);
      openAgentBlock = block;
    };

    for (const e of list) {
      if (!isObject(e)) continue;
      const p = isObject(e.payload) ? e.payload : {};
      const createdAt = toIso(e.created_at);

      // Subagent internals — summarised by the Agent line, never inlined.
      if (p.parent_tool_use_id) continue;

      const msg = isObject(p.message) ? p.message : null;

      // ---- human input -------------------------------------------------
      if (e.event_type === 'user' && e.source === 'client' && msg) {
        const c = msg.content;
        if (typeof c === 'string') {
          if (!c.trim() || isSystemReminder(c)) continue;
          pushBlock('human', { kind: 'text', text: c.trim() }, createdAt);
        } else if (Array.isArray(c)) {
          const text = c
            .filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
          if (text && !isSystemReminder(text)) {
            pushBlock('human', { kind: 'text', text }, createdAt);
          }
        }
        continue;
      }

      // ---- assistant output ---------------------------------------------
      if (e.event_type === 'assistant' && msg && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!isObject(b)) continue;

          if (b.type === 'text') {
            const text = typeof b.text === 'string' ? b.text.trim() : '';
            if (text) pushBlock('assistant', { kind: 'text', text }, createdAt);
            continue;
          }

          if (b.type === 'thinking') {
            // Always empty in practice — the server keeps only the signature.
            const text = typeof b.thinking === 'string' ? b.thinking.trim() : '';
            if (text) pushBlock('assistant', { kind: 'thinking', text }, createdAt);
            continue;
          }

          if (b.type !== 'tool_use') continue;

          const name = typeof b.name === 'string' ? b.name : 'tool';
          const input = isObject(b.input) ? b.input : {};

          // Agent → one merged line, gated behind the reasoning toggle.
          if (name === 'Agent') {
            const desc =
              (typeof input.description === 'string' && input.description.trim()) ||
              (typeof input.subagent_type === 'string' && input.subagent_type) ||
              'subagent';
            agentToolIds.set(b.id, desc);
            const u = agentUsage.get(b.id) || {};
            const parts = [
              formatTokens(u.tool_uses) && `${u.tool_uses} tool calls`,
              formatTokens(u.total_tokens) && `${formatTokens(u.total_tokens)} tokens`,
              formatDuration(u.duration_ms),
            ].filter(Boolean);
            const suffix = parts.length ? ` · ${parts.join(' · ')}` : '';
            pushAgentLine(`**Agent — ${desc}**${suffix}`, createdAt);
            continue;
          }

          // Write → the document itself. Content is inline in the call, so
          // this is the one place we recover files without a download API.
          if (name === 'Write' && typeof input.content === 'string' && input.content) {
            writeToolIds.add(b.id);
            const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
            const base = rawPath.split(/[\\/]/).pop() || 'document.md';
            const existing = artifactByPath.get(rawPath);
            if (existing) {
              // Re-write of the same path: update in place, no second link.
              existing.content = input.content;
              continue;
            }
            const fileName = sanitizeFilename(base) || 'document.md';
            const artifact = {
              id: `cowork-file-${artifacts.length}`,
              title: base,
              fileName,
              language: /\.mdx?$/i.test(fileName) ? 'markdown' : '',
              content: input.content,
            };
            artifacts.push(artifact);
            artifactByPath.set(rawPath, artifact);
            pushBlock('assistant', { kind: 'artifact_ref', artifactId: artifact.id }, createdAt);
            continue;
          }

          // SendUserFile just re-delivers a path we already captured via
          // Write; suppress it when we have the document, keep it as a tool
          // call otherwise so nothing vanishes silently.
          if (name === 'SendUserFile') {
            const files = Array.isArray(input.files) ? input.files : [];
            if (files.length && files.every((f) => artifactByPath.has(f))) continue;
          }

          if (name === 'AskUserQuestion') askToolIds.add(b.id);

          pushBlock(
            'assistant',
            { kind: 'tool_call', name, input: safeStringify(input) },
            createdAt
          );
        }
        continue;
      }

      // ---- tool results (top level only) ---------------------------------
      if (e.event_type === 'user' && msg && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!isObject(b) || b.type !== 'tool_result') continue;
          const id = b.tool_use_id;

          // Agent results are the subagent's full report — already accounted
          // for by the summary line, and re-inlining them would restore the
          // wall of text we set out to remove.
          if (agentToolIds.has(id)) continue;
          // "File created successfully" — pure noise next to the artifact.
          if (writeToolIds.has(id)) continue;

          const text = toolResultText(b.content).trim();
          if (!text) continue;

          // The user picking options in AskUserQuestion is human input, not
          // a tool result, so it belongs in a human turn.
          if (askToolIds.has(id)) {
            const answer = cleanAnswerText(text);
            if (answer) {
              pushBlock('human', { kind: 'text', text: `**Answered:** ${answer}` }, createdAt);
            }
            continue;
          }

          pushBlock(
            'assistant',
            { kind: 'tool_result', text, isError: b.is_error === true },
            createdAt
          );
        }
        continue;
      }

      // Everything else (system/*, control_*, env_manager_log, result,
      // rate_limit_event, active_goal, prompt_suggestion…) is session
      // machinery with no user-facing meaning.
    }
    flush();

    // Drop turns with nothing renderable (same lenient rule the other
    // adapters use — markdown.js makes the final visibility call).
    const filtered = turns.filter((t) => t.blocks.length > 0);

    const conversation = {
      title: (session && session.title) || 'Cowork session',
      sourceLLM: 'claude-cowork',
      model: session && isObject(session.config) ? session.config.model : undefined,
      createdAt: toIso(session && session.created_at),
      updatedAt: toIso(session && (session.updated_at || session.last_event_at)),
      turns: filtered,
      artifacts,
    };

    return { conversation };
  };

  ns.coworkNormalize = { normalize };
})();
