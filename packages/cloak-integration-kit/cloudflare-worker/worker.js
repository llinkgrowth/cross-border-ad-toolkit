/**
 * @file cloudflare-worker/worker.js
 * @description Cloudflare Worker Edge Gateway Demo for IpCloak Traffic Guard.
 *
 * Intercepts incoming edge requests, optionally checks Cloudflare KV cache for recent
 * visitor decisions, queries the remote Decision API with a strict millisecond timeout,
 * and either passes through to origin (`fetch(request)`), returns an HTTP 302 redirect,
 * renders an edge Safe Page while keeping the URL intact, or returns HTTP 404.
 *
 * Environment Variables / Bindings (`env`):
 *   - CLOAK_STORE_TOKEN   : Store authentication token
 *   - CLOAK_API_ENDPOINT  : Remote Decision API URL (default: http://127.0.0.1:8787/v1/decision)
 *   - CLOAK_TIMEOUT_MS    : Millisecond timeout before Fail-Open (default: 600)
 *   - CLOAK_DECISION_KV   : (Optional) Cloudflare KV namespace binding for short-TTL decision caching
 */

const EDGE_SAFE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Nordic Craft Studio — Workspace Essentials</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 3rem 1.5rem; }
    .card { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 2.5rem; }
    h1 { margin-top: 0; font-size: 1.75rem; }
    p { color: #475569; line-height: 1.6; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Minimalist Workspace &amp; Desk Accessories</h1>
    <p>Explore our sustainable collection of merino wool desk pads, solid walnut monitor risers, and CNC-machined studio tools.</p>
  </main>
</body>
</html>`;

const CLICK_ID_KEYS = [
  'gclid',
  'fbclid',
  'ttclid',
  'msclkid',
  'twclid',
  'wbraid',
  'gbraid',
  'utm_source',
  'utm_campaign'
];

/**
 * Build the visitor payload from a Cloudflare Worker Request object.
 *
 * @param {Request} request
 * @param {string} storeToken
 */
export function buildWorkerVisitorPayload(request, storeToken = 'demo_store_token_local') {
  const headers = request.headers;
  const ip = (
    headers.get('cf-connecting-ip') ||
    headers.get('true-client-ip') ||
    headers.get('x-real-ip') ||
    (headers.get('x-forwarded-for') || '').split(',')[0] ||
    '127.0.0.1'
  ).trim();

  const reqUrl = new URL(request.url);
  const clickIds = {};
  for (const key of CLICK_ID_KEYS) {
    const val = reqUrl.searchParams.get(key);
    if (val && val.trim() !== '') {
      clickIds[key] = val.trim();
    }
  }

  const countryCode = (
    (request.cf && request.cf.country) ||
    headers.get('cf-ipcountry') ||
    ''
  ).toUpperCase();

  const visitor = {
    ip,
    ua: headers.get('user-agent') || '',
    accept_language: headers.get('accept-language') || '',
    referer: headers.get('referer') || '',
    sec_ch_ua: headers.get('sec-ch-ua') || '',
    url: request.url,
    click_ids: clickIds
  };

  if (countryCode) {
    visitor.country_code = countryCode;
  }

  return {
    store_token: storeToken,
    visitor
  };
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {any} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env = {}, ctx = {}) {
    // Only guard GET / HEAD document navigation requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const originFetcher = env.ORIGIN_FETCH || globalThis.fetch;
      return originFetcher(request);
    }

    const storeToken = env.CLOAK_STORE_TOKEN || 'demo_store_token_local';
    const endpoint = env.CLOAK_API_ENDPOINT || 'http://127.0.0.1:8787/v1/decision';
    const timeoutMs = Number(env.CLOAK_TIMEOUT_MS || 600);
    const apiFetcher = env.DECISION_FETCH || globalThis.fetch;
    const originFetcher = env.ORIGIN_FETCH || globalThis.fetch;

    const payload = buildWorkerVisitorPayload(request, storeToken);
    const cacheKey = `cloak:v1:${payload.visitor.ip}:${payload.visitor.ua.slice(0, 48)}`;

    let decision = null;

    // 1. Optional Edge KV Lookup
    if (env.CLOAK_DECISION_KV && typeof env.CLOAK_DECISION_KV.get === 'function') {
      try {
        const cachedRaw = await env.CLOAK_DECISION_KV.get(cacheKey);
        if (cachedRaw) {
          decision = JSON.parse(cachedRaw);
        }
      } catch {
        // Ignore KV error and proceed to live API call
      }
    }

    // 2. Query Remote Decision API with strict timeout & Fail-Open fallback
    if (!decision) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const apiRes = await apiFetcher(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Cloak-Client': 'cloudflare-worker/1.0.0'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (apiRes.ok) {
          const parsed = await apiRes.json();
          if (parsed && typeof parsed.allow === 'boolean') {
            decision = parsed;
            if (env.CLOAK_DECISION_KV && typeof env.CLOAK_DECISION_KV.put === 'function') {
              const putPromise = env.CLOAK_DECISION_KV.put(cacheKey, JSON.stringify(decision), {
                expirationTtl: 60
              });
              if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(putPromise);
              }
            }
          }
        }
      } catch {
        // Network error or timeout -> Fail-Open
      } finally {
        clearTimeout(timer);
      }
    }

    // Fail-open default if decision is missing or explicitly allowed
    if (!decision || decision.allow === true || decision.action === 'pass') {
      const originRes = await originFetcher(request);
      const headers = new Headers(originRes.headers);
      headers.set('X-Traffic-Guard', 'pass');
      return new Response(originRes.body, {
        status: originRes.status,
        headers
      });
    }

    // 3. Enforce Non-Allow Action at the Edge
    if (decision.action === 'redirect' && decision.target_url) {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': String(decision.target_url),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Traffic-Guard': 'redirect'
        }
      });
    }

    if (decision.action === 'not_found') {
      return new Response('<!doctype html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>', {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Traffic-Guard': 'not_found'
        }
      });
    }

    // Default non-allow action: render_safe (serve compliant safe HTML at edge keeping URL intact)
    return new Response(env.SAFE_PAGE_HTML || EDGE_SAFE_PAGE_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Traffic-Guard': 'render_safe'
      }
    });
  }
};
