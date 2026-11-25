/**
 * @file test/integration.test.mjs
 * @description Comprehensive unit & E2E integration test suite (24 test cases)
 * for @ipcloak/cloak-integration-kit using Node.js built-in `node:test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractClientIp,
  extractClickIds,
  buildVisitorPayload,
  evaluateDemoVisitor,
  requestDecisionWithFailOpen,
  resolveGateEnforcement,
  createMockServer,
  matchIpCidr,
  inspectIpAddress,
  checkUtmGuard
} from '../mock-server/server.mjs';

import {
  DEFAULT_APP_PROXY_PATH,
  collectBrowserVisitorPayload,
  runBrowserTrafficGuard
} from '../js-sdk/cloak-sdk.js';

import workerGateway, { buildWorkerVisitorPayload } from '../cloudflare-worker/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ============================================================================
// Group 1: Visitor Context & Payload Construction (5 tests)
// ============================================================================

test('1. extractClientIp prioritizes CF-Connecting-IP over X-Forwarded-For and remoteAddress', () => {
  const headers = {
    'cf-connecting-ip': '198.51.100.77',
    'true-client-ip': '198.51.100.88',
    'x-real-ip': '198.51.100.99',
    'x-forwarded-for': '203.0.113.1, 10.0.0.1'
  };
  assert.equal(extractClientIp(headers, '127.0.0.1'), '198.51.100.77');
});

test('2. extractClientIp falls back through True-Client-IP, X-Real-IP, and first X-Forwarded-For hop', () => {
  assert.equal(
    extractClientIp({ 'true-client-ip': '198.51.100.12', 'x-forwarded-for': '203.0.113.5' }),
    '198.51.100.12'
  );
  assert.equal(
    extractClientIp({ 'x-real-ip': '198.51.100.23', 'x-forwarded-for': '203.0.113.5' }),
    '198.51.100.23'
  );
  assert.equal(
    extractClientIp({ 'x-forwarded-for': '203.0.113.45, 172.16.0.2' }),
    '203.0.113.45'
  );
  assert.equal(extractClientIp({}, '::ffff:192.0.2.55'), '192.0.2.55');
});

test('3. extractClickIds parses gclid, fbclid, ttclid, msclkid, and utm parameters accurately', () => {
  const url = 'https://store.example.com/item?gclid=GCL_123&fbclid=FB_456&ttclid=TT_789&utm_source=newsletter&ignored=abc';
  const ids = extractClickIds(url);
  assert.deepEqual(ids, {
    gclid: 'GCL_123',
    fbclid: 'FB_456',
    ttclid: 'TT_789',
    utm_source: 'newsletter'
  });
});

test('4. buildVisitorPayload constructs complete JSON contract matching Decision API spec', () => {
  const payload = buildVisitorPayload({
    storeToken: 'tok_live_demo',
    ip: '203.0.113.88',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)',
    acceptLanguage: 'en-US,en;q=0.9',
    referer: 'https://www.google.com/',
    secChUa: '"Chromium";v="124"',
    url: 'https://shop.example.com/p/mat?msclkid=MS_999',
    countryCode: 'us'
  });

  assert.equal(payload.store_token, 'tok_live_demo');
  assert.equal(payload.visitor.ip, '203.0.113.88');
  assert.equal(payload.visitor.ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)');
  assert.equal(payload.visitor.accept_language, 'en-US,en;q=0.9');
  assert.equal(payload.visitor.referer, 'https://www.google.com/');
  assert.equal(payload.visitor.sec_ch_ua, '"Chromium";v="124"');
  assert.equal(payload.visitor.country_code, 'US');
  assert.deepEqual(payload.visitor.click_ids, { msclkid: 'MS_999' });
});

test('5. buildVisitorPayload extracts headers automatically when explicit fields are omitted', () => {
  const payload = buildVisitorPayload({
    headers: {
      'CF-Connecting-IP': '198.51.100.33',
      'User-Agent': 'CustomAgent/2.0',
      'Accept-Language': 'en-GB,en;q=0.8',
      'Referer': 'https://bing.com',
      'Sec-CH-UA': '"Not-A.Brand";v="99"',
      'CF-IPCountry': 'ca'
    },
    url: 'https://shop.example.com/?fbclid=FB_AUTO'
  });

  assert.equal(payload.visitor.ip, '198.51.100.33');
  assert.equal(payload.visitor.ua, 'CustomAgent/2.0');
  assert.equal(payload.visitor.country_code, 'CA');
  assert.equal(payload.visitor.click_ids.fbclid, 'FB_AUTO');
});

// ============================================================================
// Group 2: Local Mock Decision Engine (3 Demo Rules + Default Pass) (5 tests)
// ============================================================================

test('6. evaluateDemoVisitor allows normal browser visitor by default (action: pass)', () => {
  const payload = buildVisitorPayload({
    ip: '203.0.113.10',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    url: 'https://shop.example.com/products/desk-shelf'
  });
  const decision = evaluateDemoVisitor(payload);
  assert.equal(decision.allow, true);
  assert.equal(decision.action, 'pass');
  assert.equal(decision.matched_demo_rule, null);
});

test('7. evaluateDemoVisitor triggers Demo Rule 1 on BotDemo / curl / HeadlessChrome User-Agent', () => {
  for (const botUa of ['curl/8.4.0', 'BotDemo/1.0 (+https://example.org)', 'Mozilla/5.0 HeadlessChrome/124.0']) {
    const payload = buildVisitorPayload({ ua: botUa });
    const decision = evaluateDemoVisitor(payload);
    assert.equal(decision.allow, false, `Expected ${botUa} to be blocked`);
    assert.equal(decision.action, 'render_safe');
    assert.equal(decision.matched_demo_rule, 'demo_rule_1_bot_ua');
  }
});

test('8. evaluateDemoVisitor triggers Demo Rule 2 on ?mock_block=1 and honors ?mock_action override', () => {
  const payloadSafe = buildVisitorPayload({
    ua: 'Mozilla/5.0',
    url: 'https://shop.example.com/item?mock_block=1'
  });
  const resSafe = evaluateDemoVisitor(payloadSafe);
  assert.equal(resSafe.allow, false);
  assert.equal(resSafe.action, 'render_safe');
  assert.equal(resSafe.matched_demo_rule, 'demo_rule_2_query_trigger');

  const payload404 = buildVisitorPayload({
    ua: 'Mozilla/5.0',
    url: 'https://shop.example.com/item?mock_block=1&mock_action=not_found'
  });
  const res404 = evaluateDemoVisitor(payload404);
  assert.equal(res404.allow, false);
  assert.equal(res404.action, 'not_found');
});

test('9. evaluateDemoVisitor triggers Demo Rule 3 when country_code or CF-IPCountry header is XX', () => {
  const payload = buildVisitorPayload({
    ua: 'Mozilla/5.0',
    url: 'https://shop.example.com/'
  });
  const decision = evaluateDemoVisitor(payload, { 'cf-ipcountry': 'XX' });
  assert.equal(decision.allow, false);
  assert.equal(decision.action, 'redirect');
  assert.ok(decision.target_url.startsWith('https://'));
  assert.equal(decision.matched_demo_rule, 'demo_rule_3_country_xx');
});

test('10. resolveGateEnforcement maps pass, redirect (302), render_safe (200), and not_found (404) accurately', () => {
  const passGate = resolveGateEnforcement({ allow: true, action: 'pass' });
  assert.equal(passGate.proceedToOrigin, true);
  assert.equal(passGate.statusCode, 200);

  const redirectGate = resolveGateEnforcement({
    allow: false,
    action: 'redirect',
    target_url: 'https://example.com/safe'
  });
  assert.equal(redirectGate.proceedToOrigin, false);
  assert.equal(redirectGate.statusCode, 302);
  assert.equal(redirectGate.headers.Location, 'https://example.com/safe');

  const safeGate = resolveGateEnforcement(
    { allow: false, action: 'render_safe' },
    { safePageHtml: '<html>Safe Demo</html>' }
  );
  assert.equal(safeGate.proceedToOrigin, false);
  assert.equal(safeGate.statusCode, 200);
  assert.equal(safeGate.body, '<html>Safe Demo</html>');

  const notFoundGate = resolveGateEnforcement({ allow: false, action: 'not_found' });
  assert.equal(notFoundGate.proceedToOrigin, false);
  assert.equal(notFoundGate.statusCode, 404);
});

// ============================================================================
// Group 3: End-to-End HTTP Mock Server & Fail-Open Resilience (5 tests)
// ============================================================================

test('11. Local Mock HTTP Server handles GET /health and POST /v1/decision end-to-end', async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.ok, true);

    const botPayload = buildVisitorPayload({ ua: 'curl/8.1.0', ip: '198.51.100.9' });
    const decision = await requestDecisionWithFailOpen(botPayload, {
      endpoint: `${baseUrl}/v1/decision`,
      timeoutMs: 1000
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.action, 'render_safe');
    assert.equal(decision.fail_open, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('12. requestDecisionWithFailOpen fails open (allow: true) when Mock Server times out', async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const payload = buildVisitorPayload({ ua: 'curl/8.1.0' });
    const decision = await requestDecisionWithFailOpen(payload, {
      endpoint: `http://127.0.0.1:${port}/v1/decision?delay_ms=600`,
      timeoutMs: 80
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.action, 'pass');
    assert.equal(decision.fail_open, true);
    assert.equal(decision.error, 'TIMEOUT_ABORT');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('13. requestDecisionWithFailOpen fails open when upstream returns HTTP 502/503 or invalid JSON', async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const payload = buildVisitorPayload({ ua: 'BotDemo/1.0' });
    const decision503 = await requestDecisionWithFailOpen(payload, {
      endpoint: `http://127.0.0.1:${port}/v1/decision?status=503`,
      timeoutMs: 800
    });
    assert.equal(decision503.allow, true);
    assert.equal(decision503.action, 'pass');
    assert.equal(decision503.fail_open, true);
    assert.equal(decision503.error, 'HTTP_503');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('14. Browser JS SDK (js-sdk/cloak-sdk.js) collects browser fields and works with App Proxy path', async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    assert.equal(DEFAULT_APP_PROXY_PATH, '/apps/traffic-guard/check');

    let redirectedUrl = null;
    const result = await runBrowserTrafficGuard({
      storeToken: 'tok_browser_demo',
      endpoint: `http://127.0.0.1:${port}${DEFAULT_APP_PROXY_PATH}`,
      navigatorObj: {
        userAgent: 'Mozilla/5.0',
        language: 'en-US',
        languages: ['en-US', 'en'],
        userAgentData: { brands: [{ brand: 'Chromium', version: '124' }] }
      },
      documentObj: { referrer: 'https://www.instagram.com/' },
      locationObj: {
        href: 'https://store.example.com/landing?fbclid=FB_CLICK_1&mock_action=redirect&target_url=https://example.com/safe-store'
      },
      onRedirect: (target) => {
        redirectedUrl = target;
      }
    });

    assert.equal(result.allow, false);
    assert.equal(result.action, 'redirect');
    assert.equal(redirectedUrl, 'https://example.com/safe-store');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('15. Browser JS SDK fails open gracefully when fetch rejects', async () => {
  const payload = collectBrowserVisitorPayload({
    storeToken: 'tok_unit',
    navigatorObj: { userAgent: 'Mozilla/5.0', language: 'en-GB' },
    documentObj: { referrer: '' },
    locationObj: { href: 'https://store.example.com/?gclid=GC_77' }
  });
  assert.equal(payload.visitor.click_ids.gclid, 'GC_77');

  const res = await runBrowserTrafficGuard({
    fetchImpl: async () => {
      throw new Error('Network unreachable');
    }
  });
  assert.equal(res.allow, true);
  assert.equal(res.action, 'pass');
  assert.equal(res.fail_open, true);
});

// ============================================================================
// Group 4: Cloudflare Worker Edge Gateway Verification (4 tests)
// ============================================================================

test('16. Cloudflare Worker passes normal visitor through to origin with X-Traffic-Guard: pass', async () => {
  const req = new Request('https://shop.example.com/products/stand?gclid=CF_1', {
    method: 'GET',
    headers: {
      'cf-connecting-ip': '203.0.113.77',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      'accept-language': 'en-US,en;q=0.9'
    }
  });

  const workerPayload = buildWorkerVisitorPayload(req, 'tok_cf');
  assert.equal(workerPayload.visitor.ip, '203.0.113.77');
  assert.equal(workerPayload.visitor.click_ids.gclid, 'CF_1');

  const response = await workerGateway.fetch(req, {
    CLOAK_STORE_TOKEN: 'tok_cf',
    DECISION_FETCH: async () => new Response(JSON.stringify({ allow: true, action: 'pass' }), { status: 200 }),
    ORIGIN_FETCH: async () => new Response('<html>Origin Storefront</html>', { status: 200 })
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Traffic-Guard'), 'pass');
  assert.equal(await response.text(), '<html>Origin Storefront</html>');
});

test('17. Cloudflare Worker serves Safe Page (HTTP 200) or 302 Redirect when visitor is blocked', async () => {
  const req = new Request('https://shop.example.com/products/stand', {
    method: 'GET',
    headers: { 'user-agent': 'BotDemo/1.0' }
  });

  const safeRes = await workerGateway.fetch(req, {
    DECISION_FETCH: async () => new Response(
      JSON.stringify({ allow: false, action: 'render_safe', safe_template: 'ecommerce' }),
      { status: 200 }
    ),
    ORIGIN_FETCH: async () => {
      throw new Error('Origin should not be called when render_safe is enforced');
    }
  });

  assert.equal(safeRes.status, 200);
  assert.equal(safeRes.headers.get('X-Traffic-Guard'), 'render_safe');
  const html = await safeRes.text();
  assert.ok(html.includes('Minimalist Workspace'));

  const redirectRes = await workerGateway.fetch(req, {
    DECISION_FETCH: async () => new Response(
      JSON.stringify({ allow: false, action: 'redirect', target_url: 'https://example.com/compliance' }),
      { status: 200 }
    )
  });
  assert.equal(redirectRes.status, 302);
  assert.equal(redirectRes.headers.get('Location'), 'https://example.com/compliance');
});

test('18. Cloudflare Worker honors KV cache hit without calling Decision API', async () => {
  const req = new Request('https://shop.example.com/item', {
    method: 'GET',
    headers: {
      'cf-connecting-ip': '198.51.100.50',
      'user-agent': 'CachedBot/1.0'
    }
  });

  let apiCalled = false;
  const res = await workerGateway.fetch(req, {
    CLOAK_DECISION_KV: {
      get: async () => JSON.stringify({ allow: false, action: 'not_found' })
    },
    DECISION_FETCH: async () => {
      apiCalled = true;
      return new Response('{}', { status: 200 });
    }
  });

  assert.equal(apiCalled, false);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('X-Traffic-Guard'), 'not_found');
});

test('19. Cloudflare Worker fails open to origin when Decision API throws or times out', async () => {
  const req = new Request('https://shop.example.com/item', { method: 'GET' });
  const res = await workerGateway.fetch(req, {
    DECISION_FETCH: async () => {
      throw new Error('Upstream timeout');
    },
    ORIGIN_FETCH: async () => new Response('Origin OK after fail-open', { status: 200 })
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Traffic-Guard'), 'pass');
  assert.equal(await res.text(), 'Origin OK after fail-open');
});

// ============================================================================
// Group 5: CLI Simulator, PHP SDK & WordPress Plugin Structural Verification (5 tests)
// ============================================================================

test('20. CLI simulator (cli.mjs) runs with --ua "curl/8.0" --ip "1.2.3.4" --json and outputs valid contract', () => {
  const cliPath = path.join(REPO_ROOT, 'cli.mjs');
  const stdout = execFileSync(
    process.execPath,
    [cliPath, 'simulate', '--ua', 'curl/8.0', '--ip', '1.2.3.4', '--json'],
    { encoding: 'utf8' }
  );

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.request_payload.visitor.ip, '1.2.3.4');
  assert.equal(parsed.request_payload.visitor.ua, 'curl/8.0');
  assert.equal(parsed.decision_response.allow, false);
  assert.equal(parsed.decision_response.action, 'render_safe');
  assert.equal(parsed.gate_enforcement.proceed_to_origin, false);
});

test('21. PHP files (install.php, CloakClient.php, ipcloak-traffic-guard.php) pass syntax & contract structure verification', () => {
  const phpFiles = [
    path.join(REPO_ROOT, 'php-installer/CloakClient.php'),
    path.join(REPO_ROOT, 'php-installer/install.php'),
    path.join(REPO_ROOT, 'wordpress-plugin/ipcloak-traffic-guard/ipcloak-traffic-guard.php')
  ];

  for (const file of phpFiles) {
    assert.ok(fs.existsSync(file), `Expected PHP file to exist: ${file}`);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('<?php'), `Expected ${path.basename(file)} to start with <?php`);
  }

  const clientPhp = fs.readFileSync(phpFiles[0], 'utf8');
  assert.ok(clientPhp.includes('HTTP_CF_CONNECTING_IP'));
  assert.ok(clientPhp.includes('HTTP_X_FORWARDED_FOR'));
  assert.ok(clientPhp.includes('CURLOPT_TIMEOUT_MS'));
  assert.ok(clientPhp.includes('failOpenDecision'));

  const installPhp = fs.readFileSync(phpFiles[1], 'utf8');
  assert.ok(installPhp.includes('cloak-config.json'));
  assert.ok(installPhp.includes('gate.php'));

  const wpPluginPhp = fs.readFileSync(phpFiles[2], 'utf8');
  assert.ok(wpPluginPhp.includes('Plugin Name:'));
  assert.ok(wpPluginPhp.includes('template_redirect'));
  assert.ok(wpPluginPhp.includes('protect_products'));
});

test('22. Safe Page HTML template (php-installer/safe-page.html) is valid, self-contained HTML5', () => {
  const safePagePath = path.join(REPO_ROOT, 'php-installer/safe-page.html');
  const html = fs.readFileSync(safePagePath, 'utf8');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>Nordic Craft Studio'));
  assert.ok(html.includes('</html>'));
});

test('23. package.json has strictly zero dependencies and devDependencies', () => {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('24. Repository strictly respects open-source demo boundary (zero internal IP2Location/GORM/ASN secrets)', () => {
  const filesToAudit = [
    'mock-server/server.mjs',
    'cli.mjs',
    'php-installer/CloakClient.php',
    'php-installer/install.php',
    'wordpress-plugin/ipcloak-traffic-guard/ipcloak-traffic-guard.php',
    'js-sdk/cloak-sdk.js',
    'cloudflare-worker/worker.js',
    'README.md'
  ];

  for (const relPath of filesToAudit) {
    const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    assert.ok(!/IP2Location|IP2Proxy|gorm\.io|32934/i.test(content), `File ${relPath} must not contain internal engine implementation details`);
  }
});

// ============================================================================
// Group 6: Public IP & CIDR Inspector (ipcheck) and UTM Whitelist Guard (4 tests)
// ============================================================================

test('25. matchIpCidr and inspectIpAddress accurately classify public IPv4, bogon/private ranges, and CIDR allow/deny lists', () => {
  assert.equal(matchIpCidr('203.0.113.45', '203.0.113.0/24'), true);
  assert.equal(matchIpCidr('203.0.114.1', '203.0.113.0/24'), false);
  assert.equal(matchIpCidr('::ffff:192.168.1.10', '192.168.0.0/16'), true);

  const pubReport = inspectIpAddress('8.8.8.8', { allowlist: ['8.8.8.0/24'], denylist: ['1.1.1.0/24'] });
  assert.equal(pubReport.valid, true);
  assert.equal(pubReport.version, 4);
  assert.equal(pubReport.is_bogon, false);
  assert.equal(pubReport.in_allowlist, true);
  assert.equal(pubReport.in_denylist, false);

  const bogonReport = inspectIpAddress('10.20.30.40');
  assert.equal(bogonReport.valid, true);
  assert.equal(bogonReport.is_bogon, true);
  assert.equal(bogonReport.bogon_reason, 'rfc1918_private');
});

test('26. checkUtmGuard validates allowed utm_source, utm_medium, and required ad click IDs', () => {
  const passRes = checkUtmGuard('https://shop.example.com/offer?utm_source=facebook&utm_medium=cpc&fbclid=IwAR999', {
    allowedSources: ['facebook', 'tiktok'],
    allowedMediums: ['cpc', 'paid'],
    requireClickId: true
  });
  assert.equal(passRes.pass, true);
  assert.equal(passRes.reason, 'utm_guard_ok');

  const failSource = checkUtmGuard('https://shop.example.com/offer?utm_source=newsletter&fbclid=IwAR999', {
    allowedSources: ['facebook', 'tiktok']
  });
  assert.equal(failSource.pass, false);
  assert.equal(failSource.reason, 'utm_source_not_allowed:newsletter');

  const failClickId = checkUtmGuard('https://shop.example.com/offer?utm_source=facebook', {
    allowedSources: ['facebook'],
    requireClickId: true
  });
  assert.equal(failClickId.pass, false);
  assert.equal(failClickId.reason, 'missing_ad_click_id');
});

test('27. CLI ipcheck & utmcheck commands execute and return structured JSON', () => {
  const cliPath = path.join(REPO_ROOT, 'cli.mjs');
  const ipOut = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, 'ipcheck', '--ip', '1.1.1.1', '--allow-cidrs', '1.1.1.0/24', '--json'],
    { encoding: 'utf8' }
  ));
  assert.equal(ipOut.valid, true);
  assert.equal(ipOut.is_bogon, false);
  assert.equal(ipOut.in_allowlist, true);

  const utmOut = JSON.parse(execFileSync(
    process.execPath,
    [cliPath, 'utmcheck', '--url', 'https://example.com/?utm_source=tiktok&ttclid=TT_123', '--allowed-sources', 'facebook,tiktok', '--require-click-id', '--json'],
    { encoding: 'utf8' }
  ));
  assert.equal(utmOut.pass, true);
});

