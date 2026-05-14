/**
 * Golden-file compare. Two modes:
 *
 *   - default            assert.strictEqual(actual, expected); on mismatch
 *                        node:test prints a unified diff.
 *   - UPDATE_GOLDEN=1    overwrite the golden file with the actual output and
 *                        skip the comparison. After this you `git diff` the
 *                        changes by hand. Use sparingly — it's a foot-gun.
 *
 * Supports two kinds of expected outputs:
 *
 *   - "text-or-binary file" — single golden file at expectedPath. Compared
 *     as utf-8 text if both look textual, else byte-by-byte.
 *   - "directory tree" — golden is a directory; we treat the actual side as
 *     an unzipped layout and compare entry by entry. Used for zip exports.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const UPDATE = process.env.UPDATE_GOLDEN === '1';

function isUpdating() {
  return UPDATE;
}

/** Recursive directory walk: list every file (relative to root), sorted. */
function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Heuristic: should we display this content as text in diff output, or treat
 * as opaque bytes? Looks at NUL bytes — anything with a NUL in first 8 KB is
 * binary (zip entries, PDFs, images).
 */
function looksTextual(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

/**
 * Compare a single file. `actual` is a Buffer or string; `expectedPath` is
 * a path in the repo (or scenario dir). In UPDATE_GOLDEN mode, writes
 * `actual` to `expectedPath` and returns without asserting.
 */
function compareFile(actual, expectedPath) {
  const actualBuf = Buffer.isBuffer(actual)
    ? actual
    : Buffer.from(String(actual), 'utf8');

  if (UPDATE) {
    ensureDir(path.dirname(expectedPath));
    fs.writeFileSync(expectedPath, actualBuf);
    return;
  }

  if (!fs.existsSync(expectedPath)) {
    throw new Error(
      `Golden file missing: ${expectedPath}\n  Re-run with UPDATE_GOLDEN=1 to create it.`
    );
  }
  const expectedBuf = fs.readFileSync(expectedPath);

  if (looksTextual(actualBuf) && looksTextual(expectedBuf)) {
    // Use text equality so node:test prints a readable diff. Normalize CRLF
    // → LF on both sides — file checkout on Windows can rewrite line endings.
    const actualStr = actualBuf.toString('utf8').replace(/\r\n/g, '\n');
    const expectedStr = expectedBuf.toString('utf8').replace(/\r\n/g, '\n');
    assert.strictEqual(
      actualStr,
      expectedStr,
      `Mismatch vs golden ${expectedPath}`
    );
  } else {
    // Byte comparison for binaries.
    if (!actualBuf.equals(expectedBuf)) {
      throw new Error(
        `Binary mismatch vs golden ${expectedPath} (actual ${actualBuf.length} bytes, expected ${expectedBuf.length} bytes)`
      );
    }
  }
}

/**
 * Compare an entry map (filename → Buffer/Uint8Array) against a directory
 * tree of golden files. Used for zip exports: unzip, then check that the
 * set of entries matches and each entry's contents match the file at the
 * same relative path under expectedDir.
 *
 * @param {Record<string, Uint8Array | Buffer>} entries
 * @param {string} expectedDir
 */
function compareDir(entries, expectedDir) {
  const actualNames = Object.keys(entries).sort();

  if (UPDATE) {
    // Wipe + rewrite the golden directory. We can't just overwrite — if the
    // actual export dropped a file, an old golden of the same name would
    // linger and never trigger a mismatch later.
    if (fs.existsSync(expectedDir)) {
      fs.rmSync(expectedDir, { recursive: true, force: true });
    }
    ensureDir(expectedDir);
    for (const name of actualNames) {
      const dest = path.join(expectedDir, name);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, Buffer.from(entries[name]));
    }
    return;
  }

  if (!fs.existsSync(expectedDir)) {
    throw new Error(
      `Golden directory missing: ${expectedDir}\n  Re-run with UPDATE_GOLDEN=1 to create it.`
    );
  }
  const expectedNames = listFiles(expectedDir);

  // Set-level diff first — clearer error message than "byte mismatch in file N".
  const actualSet = new Set(actualNames);
  const expectedSet = new Set(expectedNames);
  const missing = expectedNames.filter((n) => !actualSet.has(n));
  const extra = actualNames.filter((n) => !expectedSet.has(n));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`Missing from actual zip: ${missing.join(', ')}`);
    if (extra.length) parts.push(`Unexpected in actual zip: ${extra.join(', ')}`);
    throw new Error(
      `Zip entry set mismatch vs golden ${expectedDir}\n  ${parts.join('\n  ')}`
    );
  }

  // Same set of names — now check contents.
  for (const name of actualNames) {
    compareFile(Buffer.from(entries[name]), path.join(expectedDir, name));
  }
}

module.exports = { compareFile, compareDir, isUpdating };
