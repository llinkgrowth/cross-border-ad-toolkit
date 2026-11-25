/**
 * @file js-sdk/cloak-sdk.js
 * @description Lightweight Browser JS SDK Demo for Visitor Access Rule & App Proxy Integration.
 *
 * Collects browser context (`navigator.language`, `document.referrer`, `sec-ch-ua`,
 * URL query click IDs), posts to the same-origin App Proxy path (`/apps/traffic-guard/check`)
 * or custom Decision API endpoint, and executes the returned action with Fail-Open protection.
 */

export const DEFAULT_APP_PROXY_PATH = '/apps/traffic-guard/check';

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
 * Collect visitor context in a browser or simulated DOM environment.
 *
 * @param {object} [env]
 * @param {string} [env.storeToken]
 * @param {object} [env.navigatorObj]
 * @param {object} [env.documentObj]
 * @param {object} [env.locationObj]
 * @returns {{
 *   store_token: string,
 *   visitor: {
 *     ip: string,
 *     ua: string,
 *     accept_language: string,
 *     referer: string,
 *     sec_ch_ua: string,
 *     url: string,
 *     click_ids: Record<string, string>
 *   }
 * }}
 */
export function collectBrowserVisitorPayload(env = {}) {
  const nav = env.navigatorObj || (typeof navigator !== 'undefined' ? navigator : {});
  const doc = env.documentObj || (typeof document !== 'undefined' ? document : {});
  const loc = env.locationObj || (typeof location !== 'undefined' ? location : { href: 'https://example.com/' });

  const currentUrl = String(loc.href || 'https://example.com/');
  const clickIds = {};

  try {
    const parsedUrl = new URL(currentUrl, 'https://example.com');
    for (const key of CLICK_ID_KEYS) {
      const val = parsedUrl.searchParams.get(key);
      if (val && val.trim() !== '') {
        clickIds[key] = val.trim();
      }
    }
  } catch {
    // Ignore malformed URL
  }

  let secChUa = '';
  if (nav.userAgentData && Array.isArray(nav.userAgentData.brands)) {
    secChUa = nav.userAgentData.brands
      .map((b) => `"${b.brand}";v="${b.version}"`)
      .join(', ');
  }

  const acceptLanguage = Array.isArray(nav.languages) && nav.languages.length > 0
    ? nav.languages.join(',')
    : String(nav.language || 'en-US');

  return {
    store_token: String(env.storeToken || 'demo_store_token_local'),
    visitor: {
      ip: String(env.clientIp || ''),
      ua: String(nav.userAgent || ''),
      accept_language: acceptLanguage,
      referer: String(doc.referrer || ''),
      sec_ch_ua: secChUa,
      url: currentUrl,
      click_ids: clickIds
    }
  };
}

/**
 * Execute the visitor access check via same-origin App Proxy (`/apps/traffic-guard/check`)
 * or custom endpoint with strict millisecond timeout and Fail-Open fallback.
 *
 * @param {object} [options]
 * @param {string} [options.storeToken]
 * @param {string} [options.endpoint] Defaults to `/apps/traffic-guard/check`
 * @param {number} [options.timeoutMs] Defaults to 800ms
 * @param {typeof fetch} [options.fetchImpl]
 * @param {object} [options.navigatorObj]
 * @param {object} [options.documentObj]
 * @param {object} [options.locationObj]
 * @param {(url: string) => void} [options.onRedirect]
 * @param {(template: string) => void} [options.onRenderSafe]
 * @returns {Promise<{
 *   allow: boolean,
 *   action: string,
 *   target_url: string,
 *   safe_template: string,
 *   fail_open: boolean
 * }>}
 */
export async function runBrowserTrafficGuard(options = {}) {
  const endpoint = options.endpoint || DEFAULT_APP_PROXY_PATH;
  const timeoutMs = Number(options.timeoutMs ?? 800);
  const fetchFn = options.fetchImpl || globalThis.fetch;

  const payload = collectBrowserVisitorPayload({
    storeToken: options.storeToken,
    navigatorObj: options.navigatorObj,
    documentObj: options.documentObj,
    locationObj: options.locationObj
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let decision = {
    allow: true,
    action: 'pass',
    target_url: '',
    safe_template: 'ecommerce',
    fail_open: false
  };

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Cloak-Client': 'js-sdk/1.0.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      decision.fail_open = true;
      return decision;
    }

    const data = await res.json();
    if (data && typeof data.allow === 'boolean') {
      decision = {
        allow: data.allow,
        action: String(data.action || (data.allow ? 'pass' : 'render_safe')),
        target_url: String(data.target_url || ''),
        safe_template: String(data.safe_template || 'ecommerce'),
        fail_open: false
      };
    } else {
      decision.fail_open = true;
    }
  } catch {
    decision.fail_open = true;
  } finally {
    clearTimeout(timer);
  }

  if (!decision.allow) {
    if (decision.action === 'redirect' && decision.target_url) {
      if (typeof options.onRedirect === 'function') {
        options.onRedirect(decision.target_url);
      } else if (typeof window !== 'undefined' && window.location) {
        window.location.replace(decision.target_url);
      }
    } else if (decision.action === 'render_safe' || decision.action === 'not_found') {
      if (typeof options.onRenderSafe === 'function') {
        options.onRenderSafe(decision.safe_template);
      }
    }
  }

  return decision;
}

// Attach to global window when loaded via standard <script> tag
if (typeof window !== 'undefined') {
  window.IpCloakSDK = {
    DEFAULT_APP_PROXY_PATH,
    collectBrowserVisitorPayload,
    runBrowserTrafficGuard
  };
}
