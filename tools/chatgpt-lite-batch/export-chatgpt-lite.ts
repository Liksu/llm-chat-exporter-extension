#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

type JsonObject = Record<string, unknown>;

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; name: string; input: string }
  | { kind: 'tool_result'; text: string; isError: boolean }
  | { kind: 'image'; mime: string; name: string; fetchError?: string };

type Attachment = {
  category: 'binary' | 'text';
  fileName: string;
  mime?: string;
  fileUuid?: string;
  isImage?: boolean;
  size?: number;
  text?: string;
};

type Turn = {
  role: 'human' | 'assistant';
  createdAt?: string;
  blocks: Block[];
  attachments: Attachment[];
};

type Conversation = {
  id: string;
  title: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  turns: Turn[];
};

type Options = {
  idsFile: string;
  outDir: string;
  delayMs: number;
  includeReasoning: boolean;
  rawJson: boolean;
};

const API_BASE = 'https://chatgpt.com/backend-api';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));
  const token = normalizeToken(Bun.env.CHATGPT_ACCESS_TOKEN || Bun.env.OPENAI_CHATGPT_TOKEN || '');
  if (!token) {
    fail(
      'Set CHATGPT_ACCESS_TOKEN to a current chatgpt.com Bearer token. See tools/chatgpt-lite-batch/README.md.'
    );
  }

  const ids = await readIds(opts.idsFile);
  if (ids.length === 0) fail(`No conversation ids found in ${opts.idsFile}`);

  await ensureDir(opts.outDir);

  const manifest: JsonObject[] = [];
  const errors: JsonObject[] = [];

  console.log(`Exporting ${ids.length} conversation(s) to ${opts.outDir}`);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const prefix = `[${i + 1}/${ids.length}] ${id}`;
    try {
      console.log(`${prefix} fetching`);
      const raw = await fetchConversation(id, token);
      if (opts.rawJson) {
        await Bun.write(`${opts.outDir}/${id}.raw.json`, JSON.stringify(raw, null, 2));
      }

      const conversation = normalizeConversation(id, raw);
      const filename = uniqueOutputName(
        opts.outDir,
        `${sanitizeFilename(conversation.title || 'chatgpt-conversation')}-${id.slice(0, 8)}.md`
      );
      const md = renderMarkdown(conversation, { includeReasoning: opts.includeReasoning });
      await Bun.write(`${opts.outDir}/${filename}`, md);

      manifest.push({
        id,
        ok: true,
        filename,
        title: conversation.title,
        model: conversation.model,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turns: conversation.turns.length,
      });
      console.log(`${prefix} saved ${filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      manifest.push({ id, ok: false, error: message });
      errors.push({ id, error: message });
      console.warn(`${prefix} failed: ${message}`);
    }

    if (opts.delayMs > 0 && i < ids.length - 1) {
      await sleep(opts.delayMs);
    }
  }

  await Bun.write(`${opts.outDir}/_manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  if (errors.length > 0) {
    await Bun.write(`${opts.outDir}/_errors.json`, JSON.stringify(errors, null, 2) + '\n');
  }

  const ok = manifest.filter((item) => item.ok === true).length;
  console.log(`Done: ${ok}/${ids.length} exported`);
  if (errors.length > 0) process.exitCode = 1;
}

function parseArgs(args: string[]): Options {
  const opts: Options = {
    idsFile: 'ids.txt',
    outDir: 'exports',
    delayMs: 300,
    includeReasoning: false,
    rawJson: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out') {
      opts.outDir = requiredValue(args, ++i, '--out');
    } else if (arg === '--delay-ms') {
      opts.delayMs = Number(requiredValue(args, ++i, '--delay-ms'));
      if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) fail('--delay-ms must be a non-negative number');
    } else if (arg === '--include-reasoning') {
      opts.includeReasoning = true;
    } else if (arg === '--raw-json') {
      opts.rawJson = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      fail(`Unknown flag: ${arg}`);
    } else {
      opts.idsFile = arg;
    }
  }

  return opts;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  bun run tools/chatgpt-lite-batch/export-chatgpt-lite.ts [ids-file] [options]

Options:
  --out DIR              Output directory (default: tools/chatgpt-lite-batch/exports)
  --delay-ms N           Delay between conversations (default: 300)
  --include-reasoning    Include thinking/tool-call/tool-result blocks
  --raw-json             Save raw conversation JSON next to Markdown
`);
}

async function readIds(path: string): Promise<string[]> {
  const text = await Bun.file(path).text();
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(UUID_RE);
    if (!match) {
      console.warn(`Skipping line without conversation UUID: ${rawLine}`);
      continue;
    }
    const id = match[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

async function fetchConversation(id: string, token: string): Promise<JsonObject> {
  const cookie = Bun.env.CHATGPT_COOKIE || '';
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (cookie.trim()) headers.cookie = cookie.trim();

  const res = await fetch(`${API_BASE}/conversation/${encodeURIComponent(id)}`, {
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET /conversation/${id} -> ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  return (await res.json()) as JsonObject;
}

function normalizeConversation(id: string, raw: JsonObject): Conversation {
  const ordered = orderNodes(raw);
  const turns: Turn[] = [];
  let currentRole: 'human' | 'assistant' | null = null;
  let currentBlocks: Block[] = [];
  let currentAttachments: Attachment[] = [];
  let currentCreatedAt: string | undefined;

  const flush = () => {
    if (!currentRole) return;
    if (currentBlocks.length > 0 || currentAttachments.length > 0) {
      turns.push({
        role: currentRole,
        createdAt: currentCreatedAt,
        blocks: currentBlocks,
        attachments: currentAttachments,
      });
    }
    currentRole = null;
    currentBlocks = [];
    currentAttachments = [];
    currentCreatedAt = undefined;
  };

  for (const node of ordered) {
    const message = asObject(node.message);
    if (!message || shouldDropNode(node)) continue;
    const role = effectiveTurnRole(message);
    if (role !== currentRole) {
      flush();
      currentRole = role;
      const createTime = numberValue(message.create_time);
      currentCreatedAt = createTime ? toIso(createTime) : undefined;
    }

    currentBlocks.push(...transformMessage(message));
    currentAttachments.push(...transformAttachments(message));
  }
  flush();

  const meta = extractMeta(raw, ordered);
  return {
    id,
    title: meta.title,
    model: meta.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    turns,
  };
}

function orderNodes(raw: JsonObject): JsonObject[] {
  const mapping = asObject(raw.mapping) || {};
  let cur = typeof raw.current_node === 'string' ? raw.current_node : '';
  if (!cur) {
    return Object.values(mapping)
      .map((value) => asObject(value))
      .filter((node): node is JsonObject => !!node && !!asObject(node.message))
      .sort((a, b) => numberValue(asObject(a.message)?.create_time) - numberValue(asObject(b.message)?.create_time));
  }

  const out: JsonObject[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = asObject(mapping[cur]);
    if (!node) break;
    out.push(node);
    cur = typeof node.parent === 'string' ? node.parent : '';
  }
  return out.reverse();
}

function shouldDropNode(node: JsonObject): boolean {
  const message = asObject(node.message);
  if (!message) return true;
  const author = asObject(message.author);
  if (author?.role === 'system') return true;
  const metadata = asObject(message.metadata) || {};
  if (metadata.is_visually_hidden_from_conversation === true) return true;
  const content = asObject(message.content);
  const contentType = content?.content_type;
  return contentType === 'user_editable_context' || contentType === 'model_editable_context';
}

function effectiveTurnRole(message: JsonObject): 'human' | 'assistant' {
  const author = asObject(message.author);
  return author?.role === 'user' ? 'human' : 'assistant';
}

function transformMessage(message: JsonObject): Block[] {
  const content = asObject(message.content);
  if (!content) return [];

  const author = asObject(message.author);
  const role = typeof author?.role === 'string' ? author.role : '';
  const channel = typeof message.channel === 'string' ? message.channel : '';
  const contentType = typeof content.content_type === 'string' ? content.content_type : '';
  const out: Block[] = [];

  if (role === 'tool' && contentType === 'text') {
    const text = partsToText(content.parts);
    if (text) out.push({ kind: 'tool_result', text, isError: false });
    return out;
  }

  if (role === 'tool' && contentType === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const hasImage = parts.some((part) => asObject(part)?.content_type === 'image_asset_pointer');
    if (!hasImage) {
      const text = parts.filter((part) => typeof part === 'string').join('\n\n').trim();
      if (text) out.push({ kind: 'tool_result', text, isError: false });
      return out;
    }
  }

  if (role === 'assistant' && channel === 'commentary' && contentType === 'text') {
    const text = partsToText(content.parts);
    if (text) out.push({ kind: 'thinking', text });
    return out;
  }

  if (contentType === 'text') {
    const text = partsToText(content.parts);
    if (text) out.push({ kind: 'text', text });
    return out;
  }

  if (contentType === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) out.push({ kind: 'text', text: part.trim() });
        continue;
      }
      const obj = asObject(part);
      if (!obj) continue;
      if (obj.content_type === 'image_asset_pointer') {
        const pointer = typeof obj.asset_pointer === 'string' ? obj.asset_pointer : '';
        const name = pointer.replace(/^sediment:\/\//, '') || 'image';
        const metadata = asObject(obj.metadata) || {};
        const mime = typeof metadata.mime_type === 'string' ? metadata.mime_type : 'image/png';
        out.push({ kind: 'image', mime, name });
      } else if (
        obj.content_type === 'audio_asset_pointer' ||
        obj.content_type === 'real_time_user_audio_video_asset_pointer'
      ) {
        out.push({ kind: 'text', text: `_[${String(obj.content_type).replace(/_asset_pointer$/, '')} attachment]_` });
      }
    }
    return out;
  }

  if (contentType === 'thoughts') {
    const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
    const text = thoughts
      .map((item) => {
        const thought = asObject(item);
        if (!thought) return '';
        const summary = stringValue(thought.summary).trim();
        const body = stringValue(thought.content).trim();
        return summary && body ? `**${summary}**\n\n${body}` : summary || body;
      })
      .filter(Boolean)
      .join('\n\n');
    if (text) out.push({ kind: 'thinking', text });
    return out;
  }

  if (contentType === 'reasoning_recap') {
    const text = stringValue(content.content).trim();
    if (text) out.push({ kind: 'thinking', text });
    return out;
  }

  if (contentType === 'code') {
    const language = stringValue(content.language);
    const text = stringValue(content.text);
    const recipient = stringValue(message.recipient);
    if (recipient && recipient !== 'all') {
      out.push({ kind: 'tool_call', name: recipient, input: language ? `[${language}]\n${text}` : text });
    } else {
      out.push({ kind: 'text', text: `\`\`\`${language}\n${text}\n\`\`\`` });
    }
    return out;
  }

  if (contentType === 'execution_output') {
    out.push({ kind: 'tool_result', text: stringValue(content.text), isError: false });
    return out;
  }

  if (contentType === 'tether_browsing_display' || contentType === 'tether_quote') {
    out.push({ kind: 'tool_call', name: contentType, input: safeStringify(content) });
    return out;
  }

  if (contentType === 'system_error') {
    out.push({ kind: 'tool_result', text: stringValue(content.text) || safeStringify(content), isError: true });
    return out;
  }

  out.push({ kind: 'tool_call', name: `chatgpt:${contentType || 'unknown'}`, input: safeStringify(content) });
  return out;
}

function transformAttachments(message: JsonObject): Attachment[] {
  const metadata = asObject(message.metadata) || {};
  const list = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  const out: Attachment[] = [];

  for (const item of list) {
    const attachment = asObject(item);
    if (!attachment) continue;
    const fileUuid = stringValue(attachment.id);
    if (!fileUuid) continue;
    const fileName = stringValue(attachment.name) || fileUuid;
    const mime = stringValue(attachment.mime_type) || 'application/octet-stream';
    const size = typeof attachment.size === 'number' ? attachment.size : undefined;
    out.push({
      category: 'binary',
      fileName,
      mime,
      fileUuid,
      isImage: mime.startsWith('image/'),
      size,
    });
  }

  return out;
}

function extractMeta(raw: JsonObject, ordered: JsonObject[]) {
  let model = '';
  for (const node of ordered) {
    const message = asObject(node.message);
    const author = asObject(message?.author);
    if (author?.role !== 'assistant') continue;
    const metadata = asObject(message?.metadata) || {};
    model = stringValue(metadata.model_slug) || stringValue(metadata.default_model_slug);
    if (model) break;
  }

  return {
    title: stringValue(raw.title) || 'ChatGPT conversation',
    model: model || undefined,
    createdAt: toIso(numberValue(raw.create_time)),
    updatedAt: toIso(numberValue(raw.update_time)),
  };
}

function renderMarkdown(conversation: Conversation, opts: { includeReasoning: boolean }): string {
  const out: string[] = [];
  out.push(`# ${conversation.title || 'Conversation'}`);
  out.push('');
  out.push(`_Source: ChatGPT_  `);
  out.push(`_Conversation ID: ${conversation.id}_  `);
  if (conversation.model) out.push(`_Model: ${conversation.model}_  `);
  if (conversation.createdAt) out.push(`_Created: ${conversation.createdAt}_  `);
  if (conversation.updatedAt) out.push(`_Updated: ${conversation.updatedAt}_  `);
  out.push('');

  for (const turn of conversation.turns) {
    out.push(turn.role === 'human' ? '## Human' : '## Assistant');
    if (turn.createdAt) {
      out.push('');
      out.push(`_${turn.createdAt}_`);
    }
    out.push('');

    for (const block of turn.blocks) {
      const rendered = renderBlock(block, opts);
      if (!rendered) continue;
      out.push(rendered);
      out.push('');
    }

    for (const attachment of turn.attachments) {
      out.push(renderAttachment(attachment));
      out.push('');
    }

    out.push('---');
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderBlock(block: Block, opts: { includeReasoning: boolean }): string | null {
  if (block.kind === 'text') return softBreaks(block.text);
  if (block.kind === 'thinking') {
    if (!opts.includeReasoning) return null;
    return `<details><summary>Thinking</summary>\n\n${block.text}\n\n</details>`;
  }
  if (block.kind === 'tool_call') {
    if (!opts.includeReasoning) return null;
    const fence = fenceFor(block.input);
    return `**Tool call: \`${block.name}\`**\n\n${fence}json\n${block.input}\n${fence}`;
  }
  if (block.kind === 'tool_result') {
    if (!opts.includeReasoning) return null;
    const fence = fenceFor(block.text);
    const label = block.isError ? 'Tool error' : 'Tool result';
    return `**${label}**\n\n${fence}\n${block.text}\n${fence}`;
  }
  if (block.kind === 'image') {
    return `_[image: ${escapeMdInline(block.name)}${block.mime ? `, ${block.mime}` : ''}]_`;
  }
  return null;
}

function renderAttachment(attachment: Attachment): string {
  const parts = [attachment.fileName];
  if (attachment.size !== undefined) parts.push(formatBytes(attachment.size));
  if (attachment.mime) parts.push(attachment.mime);
  return `_[attachment: ${parts.map(escapeMdInline).join(' | ')}]_`;
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.filter((part) => typeof part === 'string').join('\n\n').trim();
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toIso(seconds: number): string | undefined {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) || String(value);
  } catch {
    return String(value);
  }
}

function fenceFor(text: string): string {
  let max = 2;
  for (const match of String(text).matchAll(/`+/g)) {
    max = Math.max(max, match[0].length);
  }
  return '`'.repeat(max + 1);
}

function softBreaks(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, '  \n');
}

function escapeMdInline(value: unknown): string {
  return String(value ?? '').replace(/([\\`*_{}\[\]()#+!~<>|])/g, '\\$1');
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sanitizeFilename(value: string): string {
  return String(value || 'file')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

function uniqueOutputName(outDir: string, baseName: string): string {
  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : '';
  let candidate = baseName;
  let i = 1;
  while (existsSync(`${outDir}/${candidate}`)) {
    candidate = `${stem}-${i}${ext}`;
    i++;
  }
  return candidate;
}

function normalizeToken(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, '');
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
