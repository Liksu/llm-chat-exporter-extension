/**
 * MV3 service worker. Two responsibilities:
 *
 * 1. Install a `declarativeNetRequest` rule that rewrites CORS response
 *    headers on Google asset CDNs so our extension can read the bytes.
 * 2. Proxy asset fetches for the content scripts (chrome.runtime.message
 *    in, base64 bytes back).
 *
 * Why DNR:
 * Google's image CDNs (lh*.googleusercontent.com → redirects to
 * lh*.google.com/rd-gg/...) reply to authenticated requests with
 * `ACAO: *`. The browser refuses to combine `ACAO: *` with
 * `credentials:'include'`, so the response is blocked even though our
 * extension has host_permissions for these domains. Without auth the
 * server either 400s or returns no ACAO at all.
 *
 * Solution: a DNR `modifyHeaders` rule running in the network layer
 * BEFORE the browser's CORS check. It overrides the response's
 * `Access-Control-Allow-Origin` with our extension's origin and adds
 * `Access-Control-Allow-Credentials: true`. The browser then sees a
 * matching named origin (no wildcard) and credentials are allowed.
 *
 * Scope: the rule applies only to requests to googleusercontent /
 * lh*.google.com / *.usercontent.google.com hosts, and only to XHR-style
 * requests, so we don't accidentally rewrite anything for the SPA's own
 * `<img>` loads (image resourceType is excluded).
 */
const log = (...args) => console.log('[exporter sw]', ...args);
const warn = (...args) => console.warn('[exporter sw]', ...args);

const DNR_RULE_ID = 1001;

const installDnrRule = async () => {
  const extOrigin = `chrome-extension://${chrome.runtime.id}`;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [
        {
          id: DNR_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              {
                header: 'access-control-allow-origin',
                operation: 'set',
                value: extOrigin,
              },
              {
                header: 'access-control-allow-credentials',
                operation: 'set',
                value: 'true',
              },
            ],
          },
          condition: {
            // Apply to the asset CDNs we care about. Every Gemini asset
            // (uploaded files + inline images + generated images) lives on
            // one of these hosts.
            requestDomains: [
              'lh1.googleusercontent.com',
              'lh2.googleusercontent.com',
              'lh3.googleusercontent.com',
              'lh4.googleusercontent.com',
              'lh5.googleusercontent.com',
              'lh6.googleusercontent.com',
              'lh7.googleusercontent.com',
              'lh1.google.com',
              'lh2.google.com',
              'lh3.google.com',
              'lh4.google.com',
              'lh5.google.com',
              'lh6.google.com',
              'lh7.google.com',
              'contribution-rt.usercontent.google.com',
            ],
            // xmlhttprequest covers fetch() from the SW. We deliberately
            // do NOT include `image` so the SPA's own <img> loads on
            // gemini.google.com aren't affected.
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
    log('DNR rule installed; ACAO override =', extOrigin);
  } catch (e) {
    warn('DNR rule install failed:', e && e.message ? e.message : e);
  }
};

// Install on every SW startup. Dynamic rules persist across restarts, but
// re-installing is cheap and ensures the rule reflects the current
// extension id (which can change for unpacked dev installs).
installDnrRule();
chrome.runtime.onInstalled.addListener(installDnrRule);
chrome.runtime.onStartup.addListener(installDnrRule);

// -------------------------------------------------------------------- //
//  Asset fetch proxy                                                     //
// -------------------------------------------------------------------- //

/**
 * Encode a Uint8Array as base64. Chunked through String.fromCharCode +
 * btoa so we don't blow the call-stack on multi-MB payloads.
 */
const bytesToBase64 = (bytes) => {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const describeError = (e) => {
  if (!(e instanceof Error)) return String(e);
  const parts = [];
  if (e.name) parts.push(e.name);
  if (e.message) parts.push(e.message);
  if (e.cause) parts.push(`cause=${describeError(e.cause)}`);
  return parts.join(': ') || String(e);
};

/**
 * Fetch one asset URL. With DNR rewriting CORS, a single creds:'include'
 * request is enough — but we keep a creds:'omit' fallback for cases where
 * the DNR rule wasn't installed (older Chrome, install race) or the URL
 * is on a host outside the rule's scope.
 */
const fetchAsset = async (url) => {
  log('fetch:', url);
  const attempts = [
    { credentials: 'include', referrerPolicy: 'no-referrer' },
    { credentials: 'omit', referrerPolicy: 'no-referrer' },
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const opts = attempts[i];
    const label = `[#${i + 1}] creds=${opts.credentials}`;
    let res;
    try {
      res = await fetch(url, { ...opts, headers: { accept: '*/*' } });
    } catch (e) {
      lastErr = e;
      warn(`${label} threw:`, describeError(e));
      continue;
    }
    log(`${label} → ${res.status} ${res.statusText}`);
    if (!res.ok) {
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      continue;
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    log(`${label} ✓ ${bytes.length} bytes ${mime}`);
    return { base64: bytesToBase64(bytes), mime, size: bytes.length };
  }
  throw lastErr || new Error('all fetch attempts failed');
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.kind !== 'fetch-asset') return false;
  const url = typeof msg.url === 'string' ? msg.url : '';
  if (!url) {
    sendResponse({ ok: false, error: 'missing url' });
    return false;
  }
  fetchAsset(url)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((err) => {
      const errStr = describeError(err);
      warn('fetch-asset failed:', url, errStr);
      sendResponse({ ok: false, error: errStr });
    });
  return true;
});

log('service worker installed');
