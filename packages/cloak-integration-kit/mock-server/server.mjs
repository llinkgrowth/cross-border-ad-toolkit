/**
 * @file mock-server/server.mjs
 * @description Zero-dependency Local Mock Decision Server & Contract Helper for Cloak Integration Kit.
 *
 * DISCLAIMER / 架构说明:
 * This local mock server is strictly for API contract verification, SDK integration testing,
 * and local developer debugging. It implements ONLY 3 deterministic demo triggers.
 * Production multi-dimensional traffic risk evaluation and rule orchestration are performed
 * in the cloud service.
 * （本服务仅为接口契约联调 Mock，生产环境多维风控在云端完成）
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STORE_TOKEN = 'demo_store_token_local';
export const TRACKING_CLICK_ID_KEYS = [
  'gclid',
  'fbclid',
  'ttclid',
  'msclkid',
  'twclid',
  'wbraid',
  'gbraid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id'
];

/**
 * Public / bogon IPv4 & IPv6 CIDR matcher and IP format validator (ipcheck).
 * Zero-dependency utility to inspect whether a visitor IP is valid IPv4/IPv6,
 * whether it belongs to private/loopback/reserved ranges (RFC1918 / RFC4193),
 * and whether it matches a custom allowlist/denylist of IPs or CIDR blocks.
 *
 * @param {string} ipStr
 * @returns {number | null} 32-bit unsigned integer for IPv4, or null
 */
export function ipv4ToUint32(ipStr = '') {
  const parts = String(ipStr).trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc >>> 0;
}

/**
 * Check if an IPv4 address matches a CIDR block (e.g. "203.0.113.0/24") or exact IP.
 *
 * @param {string} ip
 * @param {string} cidrOrIp
 * @returns {boolean}
 */
export function matchIpCidr(ip = '', cidrOrIp = '') {
  const cleanIp = String(ip).trim().replace(/^::ffff:/i, '');
  const cleanRule = String(cidrOrIp).trim().replace(/^::ffff:/i, '');
  if (!cleanIp || !cleanRule) return false;
  if (!cleanRule.includes('/')) {
    return cleanIp.toLowerCase() === cleanRule.toLowerCase();
  }
  const [subnet, bitsStr] = cleanRule.split('/');
  const bits = Number(bitsStr);
  const ipNum = ipv4ToUint32(cleanIp);
  const netNum = ipv4ToUint32(subnet);
  if (ipNum === null || netNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/**
 * Inspect an IP address (`ipcheck`): version, public vs bogon/private status, and CIDR list matching.
 *
 * @param {string} ip
 * @param {object} [options]
 * @param {string[]} [options.allowlist]
 * @param {string[]} [options.denylist]
 * @returns {{
 *   ip: string,
 *   valid: boolean,
 *   version: 4 | 6 | 0,
 *   is_bogon: boolean,
 *   bogon_reason: string | null,
 *   in_allowlist: boolean,
 *   in_denylist: boolean,
 *   matched_rule: string | null
 * }}
 */
export function inspectIpAddress(ip = '', options = {}) {
  const clean = String(ip || '').trim().replace(/^::ffff:/i, '');
  const allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];
  const denylist = Array.isArray(options.denylist) ? options.denylist : [];

  const v4 = ipv4ToUint32(clean);
  const isV6 = v4 === null && clean.includes(':') && /^[0-9a-fA-F:]+$/.test(clean);
  if (v4 === null && !isV6) {
    return {
      ip: clean,
      valid: false,
      version: 0,
      is_bogon: true,
      bogon_reason: 'invalid_ip_format',
      in_allowlist: false,
      in_denylist: false,
      matched_rule: null
    };
  }

  const bogonCidrs = [
    ['127.0.0.0/8', 'loopback'],
    ['10.0.0.0/8', 'rfc1918_private'],
    ['172.16.0.0/12', 'rfc1918_private'],
    ['192.168.0.0/16', 'rfc1918_private'],
    ['169.254.0.0/16', 'link_local'],
    ['100.64.0.0/10', 'cgnat_shared'],
    ['192.0.2.0/24', 'test_net_1'],
    ['198.51.100.0/24', 'test_net_2'],
    ['203.0.113.0/24', 'test_net_3']
  ];

  let isBogon = false;
  let bogonReason = null;
  if (v4 !== null) {
    for (const [cidr, reason] of bogonCidrs) {
      if (matchIpCidr(clean, cidr)) {
        isBogon = true;
        bogonReason = reason;
        break;
      }
    }
  } else if (clean === '::1' || clean.toLowerCase().startsWith('fe80:') || clean.toLowerCase().startsWith('fc') || clean.toLowerCase().startsWith('fd')) {
    isBogon = true;
    bogonReason = 'ipv6_local_or_loopback';
  }

  let matchedAllow = null;
  for (const rule of allowlist) {
    if (matchIpCidr(clean, rule)) {
      matchedAllow = rule;
      break;
    }
  }

  let matchedDeny = null;
  for (const rule of denylist) {
    if (matchIpCidr(clean, rule)) {
      matchedDeny = rule;
      break;
    }
  }

  return {
    ip: clean,
    valid: true,
    version: v4 !== null ? 4 : 6,
    is_bogon: isBogon,
    bogon_reason: bogonReason,
    in_allowlist: Boolean(matchedAllow),
    in_denylist: Boolean(matchedDeny),
    matched_rule: matchedAllow || matchedDeny || null
  };
}

/**
 * Check whether visitor query/click_ids satisfy a required UTM & Click-ID whitelist policy.
 * Public attribution guard utility: e.g. require `utm_source` in `['facebook','tiktok']` or require any ad click ID.
 *
 * @param {string | Record<string, string>} urlOrClickIds
 * @param {object} [policy]
 * @param {string[]} [policy.allowedSources]
 * @param {string[]} [policy.allowedMediums]
 * @param {boolean} [policy.requireClickId]
 * @returns {{
 *   pass: boolean,
 *   reason: string,
 *   extracted: Record<string, string>
 * }}
 */
export function checkUtmGuard(urlOrClickIds = '', policy = {}) {
  const extracted = typeof urlOrClickIds === 'string'
    ? extractClickIds(urlOrClickIds)
    : { ...(urlOrClickIds || {}) };

  const allowedSources = Array.isArray(policy.allowedSources)
    ? policy.allowedSources.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  const allowedMediums = Array.isArray(policy.allowedMediums)
    ? policy.allowedMediums.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
    : [];
  const requireClickId = Boolean(policy.requireClickId);

  if (allowedSources.length > 0) {
    const src = String(extracted.utm_source || '').toLowerCase().trim();
    if (!src) {
      return { pass: false, reason: 'missing_utm_source', extracted };
    }
    if (!allowedSources.includes(src)) {
      return { pass: false, reason: `utm_source_not_allowed:${src}`, extracted };
    }
  }

  if (allowedMediums.length > 0) {
    const med = String(extracted.utm_medium || '').toLowerCase().trim();
    if (!med) {
      return { pass: false, reason: 'missing_utm_medium', extracted };
    }
    if (!allowedMediums.includes(med)) {
      return { pass: false, reason: `utm_medium_not_allowed:${med}`, extracted };
    }
  }

  if (requireClickId) {
    const hasAdClickId = ['fbclid', 'ttclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'twclid']
      .some((k) => Boolean(extracted[k]));
    if (!hasAdClickId) {
      return { pass: false, reason: 'missing_ad_click_id', extracted };
    }
  }

  return { pass: true, reason: 'utm_guard_ok', extracted };
}

/**
 * Extract client IP using standard reverse-proxy and CDN header priority:
 * 1. CF-Connecting-IP (Cloudflare)
 * 2. True-Client-IP (Akamai / Cloudflare Enterprise)
 * 3. X-Real-IP (Nginx ingress)
 * 4. X-Forwarded-For (first public hop)
 * 5. Socket remoteAddress fallback
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} [remoteAddress]
 * @returns {string}
 */
export function extractClientIp(headers = {}, remoteAddress = '127.0.0.1') {
  const normalized = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined && v !== null) {
      normalized[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }

  const priorityKeys = [
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip',
    'x-forwarded-for'
  ];

  for (const key of priorityKeys) {
    const raw = normalized[key];
    if (raw && raw.trim() !== '') {
      const firstIp = raw.split(',')[0].trim();
      if (firstIp) {
        return firstIp.replace(/^::ffff:/i, '');
      }
    }
  }

  return String(remoteAddress || '127.0.0.1').replace(/^::ffff:/i, '');
}

/**
 * Parse marketing click IDs and UTM parameters from a URL or query string.
 *
 * @param {string} urlOrQuery
 * @returns {Record<string, string>}
 */
export function extractClickIds(urlOrQuery = '') {
  const result = {};
  if (!urlOrQuery || typeof urlOrQuery !== 'string') {
    return result;
  }

  try {
    const queryIndex = urlOrQuery.indexOf('?');
    const rawSearch = queryIndex >= 0
      ? urlOrQuery.slice(queryIndex + 1)
      : (urlOrQuery.includes('=') && !urlOrQuery.startsWith('http') ? urlOrQuery : '');
    const params = new URLSearchParams(rawSearch);
    for (const key of TRACKING_CLICK_ID_KEYS) {
      const val = params.get(key);
      if (val !== null && val.trim() !== '') {
        result[key] = val.trim();
      }
    }
  } catch {
    // Ignore malformed query string
  }

  return result;
}

/**
 * Construct a standardized Decision API request payload from visitor input.
 *
 * @param {object} options
 * @param {string} [options.storeToken]
 * @param {string} [options.ip]
 * @param {string} [options.ua]
 * @param {string} [options.acceptLanguage]
 * @param {string} [options.referer]
 * @param {string} [options.secChUa]
 * @param {string} [options.url]
 * @param {string} [options.countryCode]
 * @param {Record<string, string>} [options.clickIds]
 * @param {Record<string, string>} [options.headers]
 * @returns {{
 *   store_token: string,
 *   visitor: {
 *     ip: string,
 *     ua: string,
 *     accept_language: string,
 *     referer: string,
 *     sec_ch_ua: string,
 *     url: string,
 *     country_code?: string,
 *     click_ids: Record<string, string>
 *   }
 * }}
 */
export function buildVisitorPayload(options = {}) {
  const headers = options.headers || {};
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) {
      normalizedHeaders[k.toLowerCase()] = String(v);
    }
  }

  const url = String(options.url || normalizedHeaders['x-original-url'] || 'https://example.com/');
  const autoClickIds = extractClickIds(url);
  const mergedClickIds = {
    ...autoClickIds,
    ...(options.clickIds || {})
  };

  const ip = options.ip
    ? String(options.ip).trim()
    : extractClientIp(normalizedHeaders, '127.0.0.1');

  const ua = options.ua !== undefined
    ? String(options.ua)
    : (normalizedHeaders['user-agent'] || 'Mozilla/5.0 (Compatible; CloakKit/1.0)');

  const acceptLanguage = options.acceptLanguage !== undefined
    ? String(options.acceptLanguage)
    : (normalizedHeaders['accept-language'] || 'en-US,en;q=0.9');

  const referer = options.referer !== undefined
    ? String(options.referer)
    : (normalizedHeaders['referer'] || normalizedHeaders['referrer'] || '');

  const secChUa = options.secChUa !== undefined
    ? String(options.secChUa)
    : (normalizedHeaders['sec-ch-ua'] || '');

  const countryCode = options.countryCode !== undefined
    ? String(options.countryCode).toUpperCase()
    : (normalizedHeaders['cf-ipcountry'] || normalizedHeaders['x-country-code'] || '').toUpperCase();

  const visitor = {
    ip,
    ua,
    accept_language: acceptLanguage,
    referer,
    sec_ch_ua: secChUa,
    url,
    click_ids: mergedClickIds
  };

  if (countryCode) {
    visitor.country_code = countryCode;
  }

  return {
    store_token: String(options.storeToken || DEFAULT_STORE_TOKEN),
    visitor
  };
}

/**
 * Evaluate a visitor payload using ONLY the 3 local demo contract rules:
 *
 * - Demo Rule 1 (Crawler/CLI UA Demo):
 *   If `visitor.ua` matches `BotDemo`, `curl`, `wget`, `HeadlessChrome`, or `python-requests`,
 *   return `{ allow: false, action: "render_safe", safe_template: "ecommerce" }` (or overridden action).
 *
 * - Demo Rule 2 (Explicit Query Trigger Demo):
 *   If `visitor.url` contains `mock_block=1` or `mock_action=redirect|render_safe|not_found`,
 *   block and return the requested fallback action (`redirect`, `render_safe`, or `not_found`).
 *
 * - Demo Rule 3 (Test Country Header/Code Demo):
 *   If `visitor.country_code === "XX"` (or header `CF-IPCountry: XX`),
 *   return `{ allow: false, action: "redirect", target_url: "https://example.com/safe-compliance" }`.
 *
 * Otherwise, allow the visitor (`{ allow: true, action: "pass" }`).
 *
 * @param {object} payload
 * @param {Record<string, string | string[] | undefined>} [requestHeaders]
 * @returns {{
 *   allow: boolean,
 *   action: 'pass' | 'redirect' | 'render_safe' | 'not_found',
 *   target_url: string,
 *   safe_template: string,
 *   matched_demo_rule: string | null,
 *   mock_notice: string
 * }}
 */
export function evaluateDemoVisitor(payload = {}, requestHeaders = {}) {
  const visitor = payload?.visitor || {};
  const ua = String(visitor.ua || '');
  const urlStr = String(visitor.url || '');

  const headerCountry = String(
    requestHeaders['cf-ipcountry'] ||
    requestHeaders['CF-IPCountry'] ||
    requestHeaders['x-country-code'] ||
    requestHeaders['X-Country-Code'] ||
    ''
  ).trim().toUpperCase();

  const countryCode = String(visitor.country_code || headerCountry || '').trim().toUpperCase();

  let queryParams = new URLSearchParams();
  try {
    const qIdx = urlStr.indexOf('?');
    if (qIdx >= 0) {
      queryParams = new URLSearchParams(urlStr.slice(qIdx + 1));
    }
  } catch {
    // ignore URL parse error
  }

  const requestedAction = queryParams.get('mock_action');
  const validActions = new Set(['redirect', 'render_safe', 'not_found']);
  const defaultTargetUrl = queryParams.get('target_url') || 'https://example.com/safe-offer';
  const defaultSafeTemplate = queryParams.get('safe_template') || 'ecommerce';

  // Demo Rule 2: Query parameter trigger (?mock_block=1 or ?mock_action=...)
  if (queryParams.get('mock_block') === '1' || (requestedAction && validActions.has(requestedAction))) {
    const chosenAction = validActions.has(requestedAction) ? requestedAction : 'render_safe';
    return {
      allow: false,
      action: chosenAction,
      target_url: chosenAction === 'redirect' ? defaultTargetUrl : '',
      safe_template: defaultSafeTemplate,
      matched_demo_rule: 'demo_rule_2_query_trigger',
      mock_notice: 'Contract mock only (3 demo rules). Production multi-dimensional evaluation runs in cloud.'
    };
  }

  // Demo Rule 1: User-Agent contains BotDemo / curl / wget / HeadlessChrome / python-requests
  if (/(BotDemo|curl\/|Wget\/|HeadlessChrome|python-requests)/i.test(ua)) {
    const chosenAction = validActions.has(requestedAction) ? requestedAction : 'render_safe';
    return {
      allow: false,
      action: chosenAction,
      target_url: chosenAction === 'redirect' ? defaultTargetUrl : '',
      safe_template: defaultSafeTemplate,
      matched_demo_rule: 'demo_rule_1_bot_ua',
      mock_notice: 'Contract mock only (3 demo rules). Production multi-dimensional evaluation runs in cloud.'
    };
  }

  // Demo Rule 3: Country code or header is 'XX'
  if (countryCode === 'XX') {
    const chosenAction = validActions.has(requestedAction) ? requestedAction : 'redirect';
    return {
      allow: false,
      action: chosenAction,
      target_url: chosenAction === 'redirect' ? defaultTargetUrl : '',
      safe_template: defaultSafeTemplate,
      matched_demo_rule: 'demo_rule_3_country_xx',
      mock_notice: 'Contract mock only (3 demo rules). Production multi-dimensional evaluation runs in cloud.'
    };
  }

  // Default: Pass real visitor
  return {
    allow: true,
    action: 'pass',
    target_url: '',
    safe_template: defaultSafeTemplate,
    matched_demo_rule: null,
    mock_notice: 'Contract mock only (3 demo rules). Production multi-dimensional evaluation runs in cloud.'
  };
}

/**
 * Client-side decision requester with strict millisecond timeout and Fail-Open fallback.
 * Guarantees business continuity if the Decision API is unreachable, slow, or returns 5xx.
 *
 * @param {object} payload
 * @param {object} [options]
 * @param {string} [options.endpoint]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{
 *   allow: boolean,
 *   action: string,
 *   target_url: string,
 *   safe_template: string,
 *   fail_open: boolean,
 *   error?: string
 * }>}
 */
export async function requestDecisionWithFailOpen(payload, options = {}) {
  const endpoint = options.endpoint || 'http://127.0.0.1:8787/v1/decision';
  const timeoutMs = Number(options.timeoutMs ?? 800);
  const fetchFn = options.fetchImpl || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Cloak-Client': 'cloak-integration-kit/1.0.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        allow: true,
        action: 'pass',
        target_url: '',
        safe_template: 'ecommerce',
        fail_open: true,
        error: `HTTP_${response.status}`
      };
    }

    const data = await response.json();
    if (typeof data !== 'object' || data === null || typeof data.allow !== 'boolean') {
      return {
        allow: true,
        action: 'pass',
        target_url: '',
        safe_template: 'ecommerce',
        fail_open: true,
        error: 'INVALID_JSON_CONTRACT'
      };
    }

    return {
      allow: Boolean(data.allow),
      action: String(data.action || (data.allow ? 'pass' : 'render_safe')),
      target_url: String(data.target_url || ''),
      safe_template: String(data.safe_template || 'ecommerce'),
      fail_open: false
    };
  } catch (err) {
    return {
      allow: true,
      action: 'pass',
      target_url: '',
      safe_template: 'ecommerce',
      fail_open: true,
      error: err?.name === 'AbortError' ? 'TIMEOUT_ABORT' : String(err?.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a decision response to a concrete HTTP gate instruction (used by SDKs, gateways, and tests).
 *
 * @param {object} decision
 * @param {object} [options]
 * @param {string} [options.safePageHtml]
 * @returns {{
 *   proceedToOrigin: boolean,
 *   statusCode: number,
 *   headers: Record<string, string>,
 *   body: string | null
 * }}
 */
export function resolveGateEnforcement(decision = {}, options = {}) {
  const allow = decision.allow !== false;
  const action = decision.action || (allow ? 'pass' : 'render_safe');
  const safeHtml = options.safePageHtml || '<!doctype html><html><body><h1>Safe Compliance Page</h1></body></html>';

  if (allow || action === 'pass') {
    return {
      proceedToOrigin: true,
      statusCode: 200,
      headers: { 'X-Traffic-Guard': 'pass' },
      body: null
    };
  }

  if (action === 'redirect' && decision.target_url) {
    return {
      proceedToOrigin: false,
      statusCode: 302,
      headers: {
        'Location': String(decision.target_url),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Traffic-Guard': 'redirect'
      },
      body: ''
    };
  }

  if (action === 'not_found') {
    return {
      proceedToOrigin: false,
      statusCode: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Traffic-Guard': 'not_found'
      },
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>The requested resource could not be found.</p></body></html>'
    };
  }

  // Default non-allow action: render_safe (keeps URL intact, returns 200 with safe template)
  return {
    proceedToOrigin: false,
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Traffic-Guard': 'render_safe'
    },
    body: safeHtml
  };
}

/**
 * Create a Node.js HTTP server instance for the Local Mock Decision Server.
 *
 * Supported routes:
 * - GET  /health               -> Service health & contract info
 * - POST /v1/decision          -> Visitor Access Rule decision endpoint
 * - POST /apps/traffic-guard/check -> App Proxy compatible same-origin decision endpoint
 *
 * @returns {import('node:http').Server}
 */
export function createMockServer() {
  return http.createServer((req, res) => {
    // CORS headers for browser JS SDK local testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cloak-Client, CF-IPCountry, X-Country-Code');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && (reqUrl.pathname === '/health' || reqUrl.pathname === '/ping')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        service: 'cloak-integration-kit-mock-server',
        version: '1.0.0',
        notice: 'Local contract mock only (3 demo rules). Production multi-dimensional risk engine runs in the cloud.'
      }));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/v1/ipcheck') {
      const targetIp = reqUrl.searchParams.get('ip') || extractClientIp(req.headers, req.socket?.remoteAddress);
      const allowParam = (reqUrl.searchParams.get('allow') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const denyParam = (reqUrl.searchParams.get('deny') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const report = inspectIpAddress(targetIp, { allowlist: allowParam, denylist: denyParam });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(report));
      return;
    }

    if (
      req.method === 'POST' &&
      (reqUrl.pathname === '/v1/decision' || reqUrl.pathname === '/apps/traffic-guard/check')
    ) {
      let rawBody = '';
      req.on('data', (chunk) => {
        rawBody += chunk;
        if (rawBody.length > 64 * 1024) {
          req.destroy();
        }
      });

      req.on('end', () => {
        let parsedBody;
        try {
          parsedBody = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: 'INVALID_JSON',
            message: 'Request body must be valid JSON matching the Visitor Decision Contract.'
          }));
          return;
        }

        // Optional simulated delay for testing client timeout / fail-open behavior
        const simulateDelayMs = Number(reqUrl.searchParams.get('delay_ms') || parsedBody?.simulate_delay_ms || 0);
        const simulateStatus = Number(reqUrl.searchParams.get('status') || parsedBody?.simulate_status || 200);

        const respond = () => {
          if (simulateStatus !== 200) {
            res.writeHead(simulateStatus, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `SIMULATED_HTTP_${simulateStatus}` }));
            return;
          }

          const decision = evaluateDemoVisitor(parsedBody, req.headers);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(decision));
        };

        if (simulateDelayMs > 0) {
          setTimeout(respond, Math.min(simulateDelayMs, 5000));
        } else {
          respond();
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'NOT_FOUND',
      supported_endpoints: [
        'GET /health',
        'POST /v1/decision',
        'POST /apps/traffic-guard/check'
      ]
    }));
  });
}

// Start standalone HTTP server if executed directly via `node mock-server/server.mjs`
const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = createMockServer();
  server.listen(port, host, () => {
    console.log(`[Cloak Mock Server] Listening on http://${host}:${port}`);
    console.log(`[Cloak Mock Server] Decision Endpoint: POST http://${host}:${port}/v1/decision`);
    console.log(`[Cloak Mock Server] Notice: Local contract mock with 3 demo rules only.`);
  });
}
