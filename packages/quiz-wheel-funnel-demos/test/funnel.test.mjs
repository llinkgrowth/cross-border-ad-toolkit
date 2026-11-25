import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_QUIZ_CONFIG,
  DEFAULT_WHEEL_CONFIG,
  fnv1aHash,
  preserveFunnelAttribution,
  parseQuizAnswersInput,
  evaluateQuizFunnel,
  validateWheelConfig,
  spinPrizeWheel,
  buildExternalBrowserHandoff,
} from '../src/funnel-engine.mjs';

import { runWheelSimulation, parseCliArgs, runCli } from '../cli.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

test('1. fnv1aHash generates deterministic unsigned 32-bit integer', () => {
  const h1 = fnv1aHash('wheel:visitor-001');
  const h2 = fnv1aHash('wheel:visitor-001');
  const h3 = fnv1aHash('wheel:visitor-002');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.ok(h1 >= 0 && h1 <= 0xffffffff);
});

test('2. parseQuizAnswersInput parses compact CLI string "q1:b,q2:a,q3:c" and plain objects', () => {
  assert.deepEqual(parseQuizAnswersInput('q1:b, q2:a, q3:c'), {
    q1: 'b',
    q2: 'a',
    q3: 'c',
  });
  assert.deepEqual(parseQuizAnswersInput({ q1: 'a', q2: 'd' }), {
    q1: 'a',
    q2: 'd',
  });
  assert.deepEqual(parseQuizAnswersInput(''), {});
});

test('3. Quiz Funnel: high-intent answers route to VIP WhatsApp specialist desk', () => {
  // q1:a (Dry, 30, high_intent), q2:a (AntiAging, 40, high_intent), q3:a (Immediate, 40, urgent/high_intent) => 110
  const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:a,q2:a,q3:a');
  assert.equal(res.ok, true);
  assert.equal(res.totalScore, 110);
  assert.equal(res.primaryTag, 'high_intent');
  assert.equal(res.matchedRoute.id, 'route-vip-whatsapp');
  assert.equal(res.matchedRoute.tier, 'vip_concierge');
});

test('4. Quiz Funnel: medium score with urgent tag routes to Priority Fast-Track WhatsApp desk', () => {
  // q1:c (Combo, 20), q2:d (Maintenance, 10), q3:a (Immediate, 40, urgent) => score 70, has 'urgent'
  const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:c,q2:d,q3:a');
  assert.equal(res.ok, true);
  assert.equal(res.totalScore, 70);
  assert.ok(res.tags.includes('urgent'));
  assert.equal(res.matchedRoute.id, 'route-urgent-whatsapp');
});

test('5. Quiz Funnel: budget-sensitive browsing answers route to self-serve coupon page', () => {
  // q1:c (20), q2:d (10, budget_sensitive), q3:c (10, budget_sensitive) => score 40
  const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:c,q2:d,q3:c');
  assert.equal(res.ok, true);
  assert.equal(res.totalScore, 40);
  assert.equal(res.primaryTag, 'budget_sensitive');
  assert.equal(res.matchedRoute.id, 'route-coupon-checkout');
  assert.equal(res.matchedRoute.destinationType, 'landing_page');
});

test('6. Quiz Funnel: encodes compact answer summary [Quiz: SkinType=... | Goal=...] into WhatsApp text param', () => {
  const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:a,q2:a,q3:b');
  assert.equal(res.summaryTag, '[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=ThisWeek]');
  assert.ok(res.prefilledMessage.includes('[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=ThisWeek]'));

  const parsedUrl = new URL(res.destinationUrl);
  assert.equal(parsedUrl.hostname, 'wa.me');
  assert.ok(parsedUrl.searchParams.get('text').includes('[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=ThisWeek]'));
});

test('7. Quiz Funnel: preserves utm_*, fbclid, ttclid onto destination URL and ignores non-attribution noise', () => {
  const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:b,q2:a,q3:c', {
    incomingUrl: 'https://example.com/lp?utm_source=tiktok&utm_campaign=fall&ttclid=TT99&fbclid=FB88&random_debug=1',
  });
  assert.equal(res.ok, true);
  const u = new URL(res.destinationUrl);
  assert.equal(u.searchParams.get('utm_source'), 'tiktok');
  assert.equal(u.searchParams.get('utm_campaign'), 'fall');
  assert.equal(u.searchParams.get('ttclid'), 'TT99');
  assert.equal(u.searchParams.get('fbclid'), 'FB88');
  assert.equal(u.searchParams.get('random_debug'), null);
});

test('8. Quiz Funnel: returns explicit error for invalid option ID or empty answers', () => {
  const badOption = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, 'q1:invalid_opt');
  assert.equal(badOption.ok, false);
  assert.match(badOption.error, /Invalid option/);

  const emptyAns = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, {});
  assert.equal(emptyAns.ok, false);
});

test('9. Wheel Validation Gate (validateWheelConfig): accepts valid 6-sector DEFAULT_WHEEL_CONFIG', () => {
  const res = validateWheelConfig(DEFAULT_WHEEL_CONFIG);
  assert.equal(res.ok, true);
  assert.equal(res.sectorCount, 6);
  assert.equal(res.totalWeight, 100);
  assert.equal(res.errors.length, 0);
});

test('10. Wheel Validation Gate: rejects wheel when total weight is 0', () => {
  const zeroConfig = {
    wheelId: 'zero-w',
    sectors: [
      { id: 's1', label: 'A', weight: 0, couponCode: 'C1', ctaUrl: 'https://example.com/1' },
      { id: 's2', label: 'B', weight: 0, couponCode: 'C2', ctaUrl: 'https://example.com/2' },
    ],
  };
  const res = validateWheelConfig(zeroConfig);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /Total sector weight sum must be greater than 0/.test(e)));
});

test('11. Wheel Validation Gate: rejects non-empty prize sector missing valid ctaUrl or couponCode', () => {
  const badCtaConfig = {
    wheelId: 'bad-cta',
    sectors: [
      { id: 's1', label: 'Prize 1', weight: 50, couponCode: 'VIP1', ctaUrl: '' },
      { id: 's2', label: 'Prize 2', weight: 50, couponCode: '', ctaUrl: 'javascript:alert(1)' },
    ],
  };
  const res = validateWheelConfig(badCtaConfig);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /must bind a valid "ctaUrl"/.test(e)));
  assert.ok(res.errors.some((e) => /must use http:\/\/ or https:\/\/ protocol/.test(e)));
  assert.ok(res.errors.some((e) => /must provide a "couponCode"/.test(e)));
});

test('12. Wheel Validation Gate: rejects duplicate sector IDs or fewer than 2 sectors', () => {
  const dupConfig = {
    wheelId: 'dup',
    sectors: [
      { id: 'dup-id', label: 'A', weight: 10, couponCode: 'C1', ctaUrl: 'https://example.com/1' },
      { id: 'dup-id', label: 'B', weight: 10, couponCode: 'C2', ctaUrl: 'https://example.com/2' },
    ],
  };
  const res = validateWheelConfig(dupConfig);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /duplicate sector id/.test(e)));
});

test('13. spinPrizeWheel: calculates exact sectorCenterAngle and rotationDeg (360 * minSpins + center)', () => {
  // rng = 0.01 -> hits first sector (index 0, 0..60 deg, center = 30 deg, rotation = 360*5 + 30 = 1830)
  const spin0 = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.01 });
  assert.equal(spin0.ok, true);
  assert.equal(spin0.sectorIndex, 0);
  assert.equal(spin0.sector.id, 'sec-10off');
  assert.equal(spin0.sectorAngleDeg, 60);
  assert.equal(spin0.sectorCenterAngle, 30);
  assert.equal(spin0.rotationDeg, 1830);
});

test('14. spinPrizeWheel: maps RNG proportionally across all 6 weighted sectors', () => {
  // Weights: 35, 25, 20, 12, 5, 3 (cumulative: 35, 60, 80, 92, 97, 100)
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.10 }).sector.id, 'sec-10off');
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.45 }).sector.id, 'sec-15off');
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.70 }).sector.id, 'sec-freeship');
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.85 }).sector.id, 'sec-gift');
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.94 }).sector.id, 'sec-vip25');
  assert.equal(spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.985 }).sector.id, 'sec-bonus5');
});

test('15. spinPrizeWheel: localStorage idempotency lock guarantees identical result on repeat refreshes', () => {
  const storage = createMemoryStorage();

  // First spin with RNG hitting index 4 ('sec-vip25')
  const first = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, {
    rng: () => 0.94,
    storage,
    incomingUrl: 'https://lp.example.com?utm_source=meta&fbclid=IwAR1',
  });
  assert.equal(first.locked, false);
  assert.equal(first.sector.id, 'sec-vip25');
  assert.equal(first.couponCode, 'VIP25');

  // Second spin after page refresh with completely different RNG (0.01) -> MUST return locked VIP25!
  const second = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, {
    rng: () => 0.01,
    storage,
    incomingUrl: 'https://lp.example.com?utm_source=meta&fbclid=IwAR1',
  });
  assert.equal(second.locked, true);
  assert.equal(second.sector.id, 'sec-vip25');
  assert.equal(second.couponCode, 'VIP25');
  assert.equal(second.rotationDeg, first.rotationDeg);
  assert.match(second.ctaUrl, /utm_source=meta/);
});

test('16. spinPrizeWheel: forceRespin=true bypasses existing storage lock and updates lock', () => {
  const storage = createMemoryStorage();
  spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { rng: () => 0.94, storage }); // locks sec-vip25
  const forced = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, {
    rng: () => 0.05,
    storage,
    forceRespin: true,
  });
  assert.equal(forced.locked, false);
  assert.equal(forced.sector.id, 'sec-10off');
});

test('17. spinPrizeWheel: deterministic visitorId seed produces repeatable sector without storage', () => {
  const a = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { visitorId: 'user-7788' });
  const b = spinPrizeWheel(DEFAULT_WHEEL_CONFIG, { visitorId: 'user-7788' });
  assert.equal(a.sector.id, b.sector.id);
  assert.equal(a.rotationDeg, b.rotationDeg);
});

test('18. WebView Handoff: detects Android Facebook In-App Browser (FBAN/FB4A) and builds intent:// URL', () => {
  const ua =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.0;]';
  const res = buildExternalBrowserHandoff(ua, 'https://wa.me/6581009001?text=Hi', '?utm_source=fb&fbclid=FB123');

  assert.equal(res.ok, true);
  assert.equal(res.isInAppWebView, true);
  assert.equal(res.appName, 'facebook');
  assert.equal(res.os, 'android');
  assert.equal(res.action, 'android_intent_wakeup');
  assert.match(res.androidIntentUrl, /^intent:\/\/wa\.me\/6581009001\?text=Hi&utm_source=fb&fbclid=FB123#Intent;scheme=https;/);
  assert.match(res.androidIntentUrl, /S\.browser_fallback_url=/);
});

test('19. WebView Handoff: detects iOS Facebook/Instagram In-App Browser and returns Safari guide action', () => {
  const ua =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 Instagram 328.0.0.0.0 (iPhone15,2; iOS 17_4; en_US;)';
  const res = buildExternalBrowserHandoff(ua, 'https://wa.me/6581009001?text=Hi');

  assert.equal(res.ok, true);
  assert.equal(res.isInAppWebView, true);
  assert.equal(res.appName, 'instagram');
  assert.equal(res.os, 'ios');
  assert.equal(res.action, 'show_ios_safari_guide');
  assert.equal(res.androidIntentUrl, null);
  assert.ok(res.iosGuideText.includes('Open in External Browser / Safari'));
});

test('20. WebView Handoff: detects Android TikTok In-App Browser (BytedanceWebview / musical_ly)', () => {
  const ua =
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 BytedanceWebview/d8a21c6 musical_ly_33.5.0';
  const res = buildExternalBrowserHandoff(ua, 'https://wa.me/6581009001');

  assert.equal(res.isInAppWebView, true);
  assert.equal(res.appName, 'tiktok');
  assert.equal(res.os, 'android');
  assert.equal(res.action, 'android_intent_wakeup');
  assert.ok(res.androidIntentUrl.startsWith('intent://wa.me/6581009001#Intent;'));
});

test('21. WebView Handoff: standard system Chrome/Safari returns direct_redirect', () => {
  const ua =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const res = buildExternalBrowserHandoff(ua, 'https://wa.me/6581009001');

  assert.equal(res.isInAppWebView, false);
  assert.equal(res.appName, 'standard_browser');
  assert.equal(res.action, 'direct_redirect');
  assert.equal(res.androidIntentUrl, null);
  assert.equal(res.iosGuideText, null);
});

test('22. preserveFunnelAttribution: handles URL, URLSearchParams, query string, and plain object', () => {
  const r1 = preserveFunnelAttribution('https://wa.me/123', new URLSearchParams('utm_medium=cpc&gclid=G1'));
  assert.equal(r1.preservedParams.utm_medium, 'cpc');
  assert.equal(r1.preservedParams.gclid, 'G1');

  const r2 = preserveFunnelAttribution('https://wa.me/123', { utm_source: 'ig', fbclid: 'F2' });
  assert.match(r2.finalUrl, /utm_source=ig/);
  assert.match(r2.finalUrl, /fbclid=F2/);
});

test('23. CLI Simulator: 1000-spin wheel simulation matches theoretical sector weights within tolerance', () => {
  const report = runWheelSimulation(DEFAULT_WHEEL_CONFIG, { spins: 1000, seed: 42 });
  assert.equal(report.totalSpins, 1000);
  assert.equal(report.sectorCount, 6);

  const totalHits = report.sectors.reduce((s, r) => s + r.hits, 0);
  assert.equal(totalHits, 1000);

  for (const row of report.sectors) {
    assert.ok(Math.abs(row.deltaPct) < 5, `Sector ${row.id} delta ${row.deltaPct}% exceeded 5%`);
  }
});

test('24. CLI Commands: simulate-wheel, route-quiz, check-webview execute with exit code 0', () => {
  assert.equal(runCli(['simulate-wheel', '--spins', '200', '--json']), 0);
  assert.equal(
    runCli([
      'route-quiz',
      '--answers',
      'q1:b,q2:a,q3:c',
      '--url',
      'https://example.com/lp?utm_source=tiktok&ttclid=TT99',
      '--json',
    ]),
    0
  );
  assert.equal(
    runCli([
      'check-webview',
      '--ua',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) [FBAN/FBIOS;]',
      '--target',
      'https://wa.me/123456',
      '--json',
    ]),
    0
  );
});

test('25. CLI Argument Parser: handles --key value and --key=value flags', () => {
  const parsed = parseCliArgs(['route-quiz', '--answers=q1:a,q2:b', '--json']);
  assert.deepEqual(parsed.positionals, ['route-quiz']);
  assert.equal(parsed.flags.answers, 'q1:a,q2:b');
  assert.equal(parsed.flags.json, true);
});

test('26. Single-file index.html exists and contains zero external network requests', () => {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf-8');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(!/<script[^>]+src=/i.test(html), 'index.html must not load external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'index.html must not load external stylesheets');
});
