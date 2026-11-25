import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fnv1aHash,
  getActiveTargets,
  parseStickyCookie,
  formatStickyCookie,
  selectRandomTarget,
  selectWeightedTarget,
  selectRoundRobinTarget,
  selectQuotaTarget,
  buildSocialDeeplink,
  preserveAttributionParams,
  resolveRoute,
} from '../src/router.mjs';

import worker from '../src/worker.mjs';
import { runSimulation, parseCliArgs, runCli } from '../cli.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_TARGETS = [
  { id: 't1', label: 'Agent 1', url: 'https://wa.me/6581001001', weight: 50, daily_limit: 5, enabled: true },
  { id: 't2', label: 'Agent 2', url: 'https://wa.me/6581001002', weight: 30, daily_limit: 3, enabled: true },
  { id: 't3', label: 'Agent 3', url: 'https://wa.me/6581001003', weight: 20, daily_limit: 2, enabled: true },
  { id: 't4-off', label: 'Agent 4 Offline', url: 'https://wa.me/6581001004', weight: 50, daily_limit: 10, enabled: false },
];

test('1. fnv1aHash returns deterministic 32-bit unsigned integer', () => {
  const h1 = fnv1aHash('wa-vip:visitor-101');
  const h2 = fnv1aHash('wa-vip:visitor-101');
  const h3 = fnv1aHash('wa-vip:visitor-102');
  assert.equal(typeof h1, 'number');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.ok(h1 >= 0 && h1 <= 0xffffffff);
});

test('2. getActiveTargets filters out disabled, offline, or malformed targets', () => {
  const active = getActiveTargets([
    ...SAMPLE_TARGETS,
    { id: 't5-offline', url: 'https://example.com', online: false },
    { id: '', url: 'https://example.com' },
    null,
  ]);
  assert.equal(active.length, 3);
  assert.deepEqual(
    active.map((t) => t.id),
    ['t1', 't2', 't3']
  );
});

test('3. Mode 1 (random): selects target deterministically given custom RNG', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  assert.equal(selectRandomTarget(active, () => 0.05).target.id, 't1');
  assert.equal(selectRandomTarget(active, () => 0.5).target.id, 't2');
  assert.equal(selectRandomTarget(active, () => 0.95).target.id, 't3');
});

test('4. Mode 2 (weighted): FNV-1a deterministic hash bucket assigns consistent target for same visitor', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  const first = selectWeightedTarget(active, { hashKey: 'wa-vip:visitor-abc' });
  const second = selectWeightedTarget(active, { hashKey: 'wa-vip:visitor-abc' });
  assert.equal(first.target.id, second.target.id);
  assert.equal(first.reason, 'weighted_fnv1a_hash');
  assert.equal(first.totalWeight, 100);
});

test('5. Mode 2 (weighted): RNG proportional selection matches weight boundaries (50/30/20)', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  assert.equal(selectWeightedTarget(active, { rng: () => 0.1 }).target.id, 't1');
  assert.equal(selectWeightedTarget(active, { rng: () => 0.49 }).target.id, 't1');
  assert.equal(selectWeightedTarget(active, { rng: () => 0.51 }).target.id, 't2');
  assert.equal(selectWeightedTarget(active, { rng: () => 0.79 }).target.id, 't2');
  assert.equal(selectWeightedTarget(active, { rng: () => 0.85 }).target.id, 't3');
});

test('6. Mode 2 (weighted): falls back to first active target when all weights are zero', () => {
  const zeroTargets = [
    { id: 'z1', url: 'https://example.com/1', weight: 0 },
    { id: 'z2', url: 'https://example.com/2', weight: 0 },
  ];
  const res = selectWeightedTarget(zeroTargets);
  assert.equal(res.target.id, 'z1');
  assert.equal(res.reason, 'weighted_zero_fallback');
});

test('7. Mode 3 (round_robin): cycles sequentially through active targets', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  const r0 = selectRoundRobinTarget(active, 0);
  const r1 = selectRoundRobinTarget(active, r0.nextCounter);
  const r2 = selectRoundRobinTarget(active, r1.nextCounter);
  const r3 = selectRoundRobinTarget(active, r2.nextCounter);

  assert.equal(r0.target.id, 't1');
  assert.equal(r1.target.id, 't2');
  assert.equal(r2.target.id, 't3');
  assert.equal(r3.target.id, 't1');
  assert.equal(r3.nextCounter, 4);
});

test('8. Mode 4 (quota): selects available target with lowest clicks today', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  const usage = { t1: 3, t2: 1, t3: 1 };
  const res = selectQuotaTarget(active, usage);
  assert.equal(res.target.id, 't2'); // t2 and t3 tied at 1 click, t2 comes first
  assert.equal(res.quotaExhausted, false);
  assert.equal(res.reason, 'quota_least_used_available');
});

test('9. Mode 4 (quota): falls back to first active target when all daily limits are exhausted', () => {
  const active = getActiveTargets(SAMPLE_TARGETS);
  const exhaustedUsage = { t1: 5, t2: 3, t3: 2 };
  const res = selectQuotaTarget(active, exhaustedUsage);
  assert.equal(res.target.id, 't1');
  assert.equal(res.quotaExhausted, true);
  assert.equal(res.reason, 'quota_exhausted_fallback_first');
});

test('10. Sticky Cookie: parseStickyCookie extracts lf_d_<slug> from multi-cookie header', () => {
  const header = 'theme=dark; lf_d_wa-vip=agent-bryan; _ga=GA1.2.123';
  assert.equal(parseStickyCookie(header, 'wa-vip'), 'agent-bryan');
  assert.equal(parseStickyCookie(header, 'other-slug'), null);
  assert.equal(parseStickyCookie('', 'wa-vip'), null);
});

test('11. Sticky Cookie: formatStickyCookie outputs 1-year Max-Age=31536000', () => {
  const cookie = formatStickyCookie('wa-vip', 'agent-alice');
  assert.match(cookie, /^lf_d_wa-vip=agent-alice;/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /SameSite=Lax/);
});

test('12. Sticky Session Retention: resolveRoute keeps visitor on pinned active target', () => {
  const route = { slug: 'wa-vip', mode: 'weighted', sticky: true, targets: SAMPLE_TARGETS };
  const decision = resolveRoute(route, {
    visitorId: 'new-visitor-id',
    cookieHeader: 'lf_d_wa-vip=t3',
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.target.id, 't3');
  assert.equal(decision.stickyHit, true);
  assert.equal(decision.stickyRecalculated, false);
  assert.equal(decision.reason, 'sticky_cookie_hit');
});

test('13. Sticky Failover Recalculation: recalculates when sticky target goes offline', () => {
  const route = { slug: 'wa-vip', mode: 'round_robin', sticky: true, targets: SAMPLE_TARGETS };
  const decision = resolveRoute(route, {
    cookieHeader: 'lf_d_wa-vip=t4-off', // t4-off is disabled
    roundRobinCounter: 1,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.target.id, 't2');
  assert.equal(decision.stickyHit, false);
  assert.equal(decision.stickyRecalculated, true);
  assert.match(decision.reason, /^sticky_offline_recalc_/);
  assert.match(decision.setCookie, /lf_d_wa-vip=t2/);
});

test('14. Social Deeplink (WhatsApp): formats country code, phone and URL-encoded welcome text', () => {
  const res = buildSocialDeeplink({
    type: 'whatsapp',
    countryCode: '+86',
    phone: '138-0000-0000',
    text: 'Hello World & 20% Off!',
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://wa.me/8613800000000?text=Hello%20World%20%26%2020%25%20Off!');
});

test('15. Social Deeplink (Telegram): supports @username and phone number with text', () => {
  const byUser = buildSocialDeeplink({
    type: 'telegram',
    phone: '@vip_support_bot',
    text: 'Start VIP',
  });
  assert.equal(byUser.ok, true);
  assert.equal(byUser.url, 'https://t.me/vip_support_bot?text=Start%20VIP');

  const byPhone = buildSocialDeeplink({
    type: 'telegram',
    countryCode: '65',
    phone: '81001001',
  });
  assert.equal(byPhone.ok, true);
  assert.equal(byPhone.url, 'https://t.me/+6581001001');
});

test('16. Social Deeplink (LINE): supports Official Account oaMessage and direct profile link', () => {
  const withMsg = buildSocialDeeplink({
    type: 'line',
    phone: '@shop_jp',
    text: 'こんにちは',
  });
  assert.equal(withMsg.ok, true);
  assert.equal(withMsg.url, 'https://line.me/R/oaMessage/@shop_jp/?%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF');

  const noMsg = buildSocialDeeplink({
    type: 'line',
    phone: 'line_user_01',
  });
  assert.equal(noMsg.ok, true);
  assert.equal(noMsg.url, 'https://line.me/ti/p/~line_user_01');
});

test('17. Social Deeplink (Viber): encodes +number and draft parameter', () => {
  const res = buildSocialDeeplink({
    type: 'viber',
    countryCode: '63',
    phone: '9171234567',
    text: 'Inquire promo',
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'viber://chat?number=%2B639171234567&draft=Inquire%20promo');
});

test('18. Social Deeplink (Zalo): builds https://zalo.me/<phone> with template variables', () => {
  const res = buildSocialDeeplink({
    type: 'zalo',
    countryCode: '84',
    phone: '901234567',
    text: 'Xin chao {{agent}}, code {{code}}',
    variables: { agent: 'Linh', code: 'VN88' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://zalo.me/84901234567?text=Xin%20chao%20Linh%2C%20code%20VN88');
});

test('19. Social Deeplink validation: rejects unsupported platforms or missing phone/handle', () => {
  assert.equal(buildSocialDeeplink({ type: 'wechat', phone: '123' }).ok, false);
  assert.equal(buildSocialDeeplink({ type: 'whatsapp', phone: '' }).ok, false);
});

test('20. Attribution Pass-Through: preserves utm_*, fbclid, ttclid, gclid and drops non-attribution noise', () => {
  const target = 'https://wa.me/6581001001?text=Hi%20Alice';
  const incoming =
    'https://go.example.com/wa-vip?utm_source=tiktok&utm_medium=cpc&ttclid=E.C.P.111&fbclid=IwAR222&gclid=Cj0KC333&debug_token=secret999';
  const finalUrl = preserveAttributionParams(target, incoming);
  const parsed = new URL(finalUrl);

  assert.equal(parsed.searchParams.get('text'), 'Hi Alice');
  assert.equal(parsed.searchParams.get('utm_source'), 'tiktok');
  assert.equal(parsed.searchParams.get('utm_medium'), 'cpc');
  assert.equal(parsed.searchParams.get('ttclid'), 'E.C.P.111');
  assert.equal(parsed.searchParams.get('fbclid'), 'IwAR222');
  assert.equal(parsed.searchParams.get('gclid'), 'Cj0KC333');
  assert.equal(parsed.searchParams.get('debug_token'), null);
});

test('21. Attribution Pass-Through: does not overwrite existing target query params unless overrideExisting=true', () => {
  const target = 'https://shop.example.com/deals?utm_source= preset_partner';
  const incoming = '?utm_source=facebook&utm_campaign=q4';

  const preserved = preserveAttributionParams(target, incoming);
  assert.equal(new URL(preserved).searchParams.get('utm_source'), ' preset_partner');
  assert.equal(new URL(preserved).searchParams.get('utm_campaign'), 'q4');

  const overridden = preserveAttributionParams(target, incoming, { overrideExisting: true });
  assert.equal(new URL(overridden).searchParams.get('utm_source'), 'facebook');
});

test('22. Cloudflare Worker Edge 302 Demo: returns 302 redirect, Set-Cookie, and invokes ctx.waitUntil', async () => {
  let waitUntilCalled = false;
  const ctx = {
    waitUntil(promise) {
      waitUntilCalled = true;
      return promise;
    },
  };
  const req = new Request('https://go.example.com/wa-vip?utm_source=meta&fbclid=IwAR999', {
    headers: {
      'cf-connecting-ip': '203.0.113.42',
    },
  });

  const resp = await worker.fetch(req, {}, ctx);
  assert.equal(resp.status, 302);
  assert.equal(waitUntilCalled, true);

  const location = resp.headers.get('Location');
  assert.ok(location.startsWith('https://wa.me/'));
  assert.match(location, /utm_source=meta/);
  assert.match(location, /fbclid=IwAR999/);

  const setCookie = resp.headers.get('Set-Cookie');
  assert.match(setCookie, /^lf_d_wa-vip=agent-/);
});

test('23. Cloudflare Worker Edge 302 Demo: returns 404 for unknown slug and 200 for /healthz', async () => {
  const healthResp = await worker.fetch(new Request('https://go.example.com/healthz'));
  assert.equal(healthResp.status, 200);

  const notFoundResp = await worker.fetch(new Request('https://go.example.com/non-existent'));
  assert.equal(notFoundResp.status, 404);
});

test('24. CLI Simulator: 1000-click weighted simulation closely matches theoretical 50/30/20 weights', () => {
  const routesData = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'demo-routes.json'), 'utf-8')
  );
  const waRoute = routesData.routes.find((r) => r.slug === 'wa-vip');
  const report = runSimulation(waRoute, { clicks: 1000 });

  assert.equal(report.totalClicks, 1000);
  assert.equal(report.activeTargetCount, 3);
  const sumHits = report.targets.reduce((s, r) => s + r.hits, 0);
  assert.equal(sumHits, 1000);

  // Check theoretical percentages are 50%, 30%, 20% and actual shares are within reasonable tolerance
  assert.equal(report.targets[0].theoreticalSharePct, 50);
  assert.equal(report.targets[1].theoreticalSharePct, 30);
  assert.equal(report.targets[2].theoreticalSharePct, 20);
  for (const row of report.targets) {
    assert.ok(Math.abs(row.deltaPct) < 6, `Expected delta < 6%, got ${row.deltaPct}%`);
  }
});

test('25. CLI Simulator: 1000-click quota simulation triggers exact fallback count once daily caps are full', () => {
  const routesData = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'demo-routes.json'), 'utf-8')
  );
  const quotaRoute = routesData.routes.find((r) => r.slug === 'promo-quota');
  // Daily caps: 300 + 250 + 150 = 700. With 1000 clicks, exactly 300 clicks must fall back to target[0]
  const report = runSimulation(quotaRoute, { clicks: 1000 });

  assert.equal(report.totalDailyQuota, 700);
  assert.equal(report.quotaExhaustedFallbacks, 300);
  assert.equal(report.targets[0].hits, 600); // 300 normal + 300 fallback
  assert.equal(report.targets[0].fallbackHits, 300);
  assert.equal(report.targets[1].hits, 250);
  assert.equal(report.targets[2].hits, 150);
});

test('26. CLI Argument Parser & Commands: route, simulate, deeplink return exit code 0', () => {
  const parsed = parseCliArgs(['simulate', 'wa-vip', '--clicks', '500', '--json']);
  assert.deepEqual(parsed.positionals, ['simulate', 'wa-vip']);
  assert.equal(parsed.flags.clicks, '500');
  assert.equal(parsed.flags.json, true);

  assert.equal(
    runCli(['deeplink', '--type', 'whatsapp', '--phone', '8613800000000', '--text', 'Hello', '--json']),
    0
  );
  assert.equal(runCli(['route', 'wa-vip', '--visitor', 'v123', '--json']), 0);
});

test('27. Single-file index.html exists and contains zero external HTTP/CDN dependencies', () => {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!/<script[^>]+src=/i.test(html), 'index.html must not load external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'index.html must not load external stylesheets');
});
