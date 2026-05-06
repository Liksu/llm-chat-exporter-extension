/**
 * Shared utilities. Loaded into content_script context; exposes window.__exporter.utils.
 *
 * Type definitions (JSDoc):
 *
 * @typedef {Object} NormalizedConversation
 * @property {string} title
 * @property {string} sourceLLM
 * @property {string} [model]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {Turn[]} turns
 * @property {Artifact[]} artifacts
 *
 * @typedef {Object} Turn
 * @property {'human'|'assistant'} role
 * @property {string} [createdAt]
 * @property {Block[]} blocks
 * @property {Attachment[]} attachments
 *
 * @typedef {{kind:'text', text:string}
 *  | {kind:'thinking', text:string}
 *  | {kind:'tool_call', name:string, input:string}
 *  | {kind:'tool_result', text:string, isError:boolean}
 *  | {kind:'artifact_ref', artifactId:string}
 *  | {kind:'image', mime:string, name:string, bytes:Uint8Array}
 * } Block
 *
 * @typedef {Object} Attachment
 * @property {'text'|'binary'} category
 * @property {string} fileName
 * @property {string} [mime]
 * @property {string} [text]
 * @property {Uint8Array} [bytes]
 * @property {string} [fileUuid]
 * @property {boolean} [isImage]
 * @property {number} [size]
 *
 * @typedef {Object} Artifact
 * @property {string} id
 * @property {string} title
 * @property {string} [language]
 * @property {string} [mime]
 * @property {string} content
 * @property {string} fileName
 */

(function () {
  const ns = (self.__exporter = self.__exporter || {});

  /**
   * Version-stamped console wrapper. Every diagnostic line emitted by the
   * extension is prefixed with `[exporter vX.Y.Z]` so users copy-pasting an
   * error can tell which build produced it.
   */
  const VERSION =
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : '?';
  const LOG_PREFIX = `[exporter v${VERSION}]`;
  const log = {
    debug: (...args) => console.debug(LOG_PREFIX, ...args),
    info: (...args) => console.info(LOG_PREFIX, ...args),
    warn: (...args) => console.warn(LOG_PREFIX, ...args),
    error: (...args) => console.error(LOG_PREFIX, ...args),
  };

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /** Pick a fence longer than any backtick run inside the text. */
  const fenceFor = (text) => {
    let max = 2;
    const matches = String(text).matchAll(/`+/g);
    for (const m of matches) max = Math.max(max, m[0].length);
    return '`'.repeat(max + 1);
  };

  const sanitizeFilename = (s, fallback = 'file') => {
    const cleaned = String(s ?? '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return cleaned || fallback;
  };

  const todayStamp = (d = new Date()) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  /** Escape characters that have meaning in inline markdown. */
  const escapeMdInline = (s) =>
    String(s ?? '').replace(/([\\`*_{}\[\]()#+!~<>|])/g, '\\$1');

  /** Human-readable byte count. */
  const formatBytes = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  /** Heuristic: is this mime/filename a "text-like" file we can inline? */
  const isTextLikeMime = (mime, fileName) => {
    const m = String(mime || '').toLowerCase().split(';')[0].trim();
    if (m.startsWith('text/')) return true;
    if (
      m === 'application/json' ||
      m === 'application/xml' ||
      m === 'application/yaml' ||
      m === 'application/x-yaml' ||
      m === 'application/javascript' ||
      m === 'application/typescript' ||
      m === 'application/x-sh' ||
      m === 'application/sql'
    )
      return true;
    const ext = String(fileName || '').toLowerCase().split('.').pop();
    const TEXT_EXTS = new Set([
      'md',
      'txt',
      'json',
      'xml',
      'yaml',
      'yml',
      'csv',
      'tsv',
      'html',
      'htm',
      'css',
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'php',
      'swift',
      'sh',
      'bash',
      'zsh',
      'sql',
      'log',
      'ini',
      'toml',
      'conf',
      'env',
    ]);
    return ext ? TEXT_EXTS.has(ext) : false;
  };

  /** Slugify for HTML anchor ids. */
  const slugifyAnchor = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artifact';

  /** Map mime type to a markdown code-fence language tag. */
  const langFromMime = (mime) => {
    if (!mime) return '';
    const m = String(mime).toLowerCase();
    if (m === 'text/plain') return '';
    if (m === 'text/markdown' || m === 'text/x-markdown') return 'markdown';
    if (m === 'application/json' || m === 'text/json') return 'json';
    if (m === 'application/xml' || m === 'text/xml') return 'xml';
    if (m === 'text/html') return 'html';
    if (m === 'text/css') return 'css';
    if (m === 'text/javascript' || m === 'application/javascript') return 'javascript';
    if (m === 'application/typescript' || m === 'text/typescript') return 'typescript';
    if (m === 'application/x-yaml' || m === 'text/yaml' || m === 'application/yaml') return 'yaml';
    if (m === 'text/x-python') return 'python';
    if (m.startsWith('text/')) return '';
    return '';
  };

  /** Map mime → file extension (for ZIP filenames). */
  const extFromMime = (mime) => {
    if (!mime) return '';
    const m = String(mime).toLowerCase().split(';')[0].trim();
    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'application/pdf': '.pdf',
      'application/json': '.json',
      'application/xml': '.xml',
      'application/zip': '.zip',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'text/css': '.css',
      'text/javascript': '.js',
      'application/javascript': '.js',
    };
    return map[m] || '';
  };

  /** Map artifact `language`/`type` → file extension. */
  const extFromArtifactKind = (language, mime) => {
    const lang = String(language || '').toLowerCase();
    const m = String(mime || '').toLowerCase();
    if (m === 'text/html' || lang === 'html') return '.html';
    if (m.includes('react') || lang === 'jsx' || lang === 'react') return '.jsx';
    if (lang === 'tsx') return '.tsx';
    if (m === 'application/vnd.ant.code' || lang === 'javascript' || lang === 'js') return '.js';
    if (lang === 'typescript' || lang === 'ts') return '.ts';
    if (lang === 'python' || lang === 'py') return '.py';
    if (lang === 'css') return '.css';
    if (lang === 'json') return '.json';
    if (lang === 'markdown' || lang === 'md' || m === 'text/markdown') return '.md';
    if (lang === 'svg' || m === 'image/svg+xml') return '.svg';
    if (lang === 'mermaid' || m === 'application/vnd.ant.mermaid') return '.mmd';
    if (lang === 'xml' || m.includes('xml')) return '.xml';
    return '.txt';
  };

  /** Best-effort stringify of arbitrary value for code-block dump. */
  const safeStringify = (v) => {
    try {
      return JSON.stringify(v, null, 2) ?? String(v);
    } catch {
      return String(v);
    }
  };

  /** Convert Uint8Array → base64 (chunked, avoids stack overflow on large arrays). */
  const uint8ToBase64 = (bytes) => {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunk, bytes.length))
      );
    }
    return btoa(binary);
  };

  /** Encode UTF-8 string → Uint8Array. */
  const utf8ToBytes = (s) => new TextEncoder().encode(s);

  /**
   * Insert markdown soft breaks: replace single newlines with "  \n" so that
   * line breaks survive in CommonMark renderers, while leaving paragraph
   * breaks (\n\n) and content inside fenced/inline code untouched.
   */
  const softBreaks = (text) => {
    if (!text) return text;
    // Split on fenced code blocks (``` ... ```), keep the delimiters.
    const fenceParts = String(text).split(/(```[\s\S]*?```)/g);
    return fenceParts
      .map((part, i) => {
        if (i % 2 === 1) return part; // inside fenced block — leave alone
        // Inside a non-code segment, also protect inline code spans (`...`).
        const inlineParts = part.split(/(`[^`\n]*`)/g);
        return inlineParts
          .map((seg, j) => {
            if (j % 2 === 1) return seg;
            // Single \n that is NOT part of a paragraph break gets a trailing
            // double-space to render as a hard line-break in markdown.
            return seg.replace(/(?<!\n)\n(?!\n)/g, '  \n');
          })
          .join('');
      })
      .join('');
  };

  /** Resolve a name conflict in a Set, appending -1, -2, ... before extension. */
  const uniqueName = (name, used) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    let candidate;
    do {
      candidate = `${base}-${i}${ext}`;
      i++;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };

  ns.utils = {
    log,
    VERSION,
    escapeHtml,
    escapeMdInline,
    formatBytes,
    isTextLikeMime,
    fenceFor,
    sanitizeFilename,
    todayStamp,
    slugifyAnchor,
    langFromMime,
    extFromMime,
    extFromArtifactKind,
    safeStringify,
    uint8ToBase64,
    utf8ToBytes,
    softBreaks,
    uniqueName,
  };
})();
