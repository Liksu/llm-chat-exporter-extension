/**
 * Tiny fetch mock driven by scenario.mocks[]. Each entry describes one route:
 *
 *   {
 *     host?: "https://chatgpt.com",       // optional override of scenario.host
 *     method?: "GET",                       // default GET; case-insensitive
 *     path?: "/backend-api/conversation/UUID",  // exact pathname match
 *     pathRegex?: "^/backend-api/files/download/file_[a-f0-9]+",  // alternative
 *     queryMatch?: { key: "value", ... },   // all entries must match exactly
 *     file: "conversation.json",            // path under <scenarioDir>/responses/
 *     contentType?: "application/json",     // defaults guessed from extension
 *     status?: 200,
 *     headers?: { "x-foo": "bar" }
 *   }
 *
 * Match order: first route wins. If no route matches, the mock throws — the
 * test then fails loudly with the exact URL that was requested. This catches
 * "extension code reached for a URL we forgot to mock" instead of silently
 * succeeding with empty bytes.
 *
 * Why a custom mock instead of undici MockAgent: in the vm context we inject
 * `fetch` directly as a sandbox global, so we never touch the host process's
 * global dispatcher — meaning undici's interceptor wouldn't see our calls
 * anyway. A 50-line mock is simpler and zero-dep.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXT_CONTENT_TYPES = {
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
};

function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * Try one route against an actual fetch URL. Returns true on full match.
 */
function routeMatches(route, defaultHost, method, parsedUrl) {
  const wantedMethod = (route.method || 'GET').toUpperCase();
  if (wantedMethod !== method) return false;

  const wantedHost = route.host || defaultHost;
  if (wantedHost && wantedHost !== parsedUrl.origin) return false;

  if (route.path != null) {
    if (parsedUrl.pathname !== route.path) return false;
  } else if (route.pathRegex != null) {
    if (!new RegExp(route.pathRegex).test(parsedUrl.pathname)) return false;
  } else {
    throw new Error(`Route missing path/pathRegex: ${JSON.stringify(route)}`);
  }

  if (route.queryMatch) {
    for (const [k, v] of Object.entries(route.queryMatch)) {
      if (parsedUrl.searchParams.get(k) !== v) return false;
    }
  }

  return true;
}

/**
 * Build the mock fetch function for a given scenario.
 *
 * @param {string} scenarioDir   directory containing scenario.json + responses/
 * @param {object} scenario      parsed scenario.json
 * @returns {Function}           a fetch(input, init) that returns Response
 */
function createMockFetch(scenarioDir, scenario) {
  const mocks = scenario.mocks || [];
  const defaultHost = scenario.host || '';
  const responsesDir = path.join(scenarioDir, 'responses');

  // Track which routes got hit. Useful for "did the test exercise every
  // mock we set up?" assertions if we add them later.
  const hits = new Map();

  const mockFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!url) throw new Error('mockFetch: missing URL');
    const method = ((init && init.method) || 'GET').toUpperCase();
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      throw new Error(`mockFetch: unparseable URL ${url}: ${e.message}`);
    }

    for (let i = 0; i < mocks.length; i++) {
      const route = mocks[i];
      if (!routeMatches(route, defaultHost, method, parsedUrl)) continue;
      hits.set(i, (hits.get(i) || 0) + 1);

      const filePath = path.join(responsesDir, route.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `mockFetch: response file not found for route ${i}: ${filePath}`
        );
      }
      const body = fs.readFileSync(filePath);
      const headers = new Headers({
        'content-type': route.contentType || guessContentType(route.file),
        ...(route.headers || {}),
      });
      return new Response(body, {
        status: route.status || 200,
        headers,
      });
    }

    throw new Error(
      `mockFetch: no route matched ${method} ${url}\n  ` +
        `Defined routes:\n  ` +
        mocks
          .map(
            (r, i) =>
              `[${i}] ${(r.method || 'GET').toUpperCase()} ${r.host || defaultHost}${
                r.path || r.pathRegex
              }${r.queryMatch ? ' query=' + JSON.stringify(r.queryMatch) : ''}`
          )
          .join('\n  ')
    );
  };

  mockFetch.hits = hits;
  return mockFetch;
}

module.exports = { createMockFetch, guessContentType };
