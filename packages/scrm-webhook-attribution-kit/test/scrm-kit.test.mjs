import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeduplicationStore,
  ITEM_STATES,
  SafeBroadcastQueue,
  THROTTLE_TIERS,
  computeThrottleDelayMs,
  injectRefCode,
  parseInboundRefCode,
  renderMessageTemplate,
  signWebhookPayload,
  verifyRecipientUid,
  verifyWebhookSignature
} from '../src/attribution-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../cli.mjs');

describe('1. First-Message Reference Code Injection & Parsing (injectRefCode / parseInboundRefCode)', () => {
  it('1.1 generates a deterministic refCode and appends [ref:...] to greeting text', () => {
    const res1 = injectRefCode({
      greeting: 'Hi, I want the catalog',
      pageId: 'LP08',
      channel: 'FB',
      clickSeed: 'IwAR9988'
    });
    const res2 = injectRefCode({
      greeting: 'Hi, I want the catalog',
      pageId: 'LP08',
      channel: 'FB',
      clickSeed: 'IwAR9988'
    });
    assert.equal(res1.refCode, res2.refCode);
    assert.match(res1.refCode, /^LP08_FB_[0-9A-F]{4}$/);
    assert.equal(res1.message, `Hi, I want the catalog [ref:${res1.refCode}]`);
  });

  it('1.2 supports explicit refCode override and replaces any pre-existing [ref:...]', () => {
    const res = injectRefCode({
      greeting: 'Hello [ref:OLD_CODE_1111] need quote',
      refCode: 'lp01_fb_7a9c'
    });
    assert.equal(res.refCode, 'lp01_fb_7a9c');
    assert.equal(res.message, 'Hello need quote [ref:lp01_fb_7a9c]');
    assert.equal(res.metadata.pageId, 'LP01');
    assert.equal(res.metadata.channel, 'FB');
    assert.equal(res.metadata.clickHash, '7A9C');
  });

  it('1.3 losslessly parses English inbound first message with [ref:...]', () => {
    const parsed = parseInboundRefCode('Hi, I want the catalog [ref:lp01_fb_7a9c]');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.refCode, 'lp01_fb_7a9c');
    assert.equal(parsed.cleanText, 'Hi, I want the catalog');
    assert.equal(parsed.pageId, 'LP01');
    assert.equal(parsed.channel, 'FB');
    assert.equal(parsed.clickHash, '7A9C');
    assert.equal(parsed.attributionStage, 'REAL_INBOUND_OPEN');
  });

  it('1.4 losslessly parses Chinese, Spanish, and Arabic multilingual greetings', () => {
    const zh = parseInboundRefCode('你好，我想咨询批发报价单 [ref:LP09_TT_3B8E] 谢谢');
    assert.equal(zh.matched, true);
    assert.equal(zh.cleanText, '你好，我想咨询批发报价单 谢谢');
    assert.equal(zh.pageId, 'LP09');
    assert.equal(zh.channel, 'TT');

    const es = parseInboundRefCode('Hola, quiero más información sobre el envío (ref:LP12_GG_55AA)');
    assert.equal(es.matched, true);
    assert.equal(es.cleanText, 'Hola, quiero más información sobre el envío');
    assert.equal(es.pageId, 'LP12');
    assert.equal(es.channel, 'GG');

    const ar = parseInboundRefCode('مرحبا، أريد قائمة الأسعار [ref:LP03_IG_99FF]');
    assert.equal(ar.matched, true);
    assert.equal(ar.pageId, 'LP03');
    assert.equal(ar.channel, 'IG');
  });

  it('1.5 returns UNATTRIBUTED_ORGANIC when message contains no refCode', () => {
    const parsed = parseInboundRefCode('Hello, do you ship to Canada?');
    assert.equal(parsed.matched, false);
    assert.equal(parsed.refCode, null);
    assert.equal(parsed.cleanText, 'Hello, do you ship to Canada?');
    assert.equal(parsed.attributionStage, 'UNATTRIBUTED_ORGANIC');
  });
});

describe('2. Webhook HMAC-SHA256 Signing, Replay Protection & Idempotency', () => {
  it('2.1 signs payload and passes constant-time signature verification within tolerance window', () => {
    const payload = { event: 'inbound_open', visitor_id: 'v_101', channel: 'whatsapp' };
    const signed = signWebhookPayload(payload, 'whsec_test_secret', { timestampSec: 1732500000 });

    const verified = verifyWebhookSignature({
      payload: signed.rawBody,
      headerValue: signed.headerValue,
      secret: 'whsec_test_secret',
      toleranceSec: 300,
      nowSec: 1732500120
    });

    assert.equal(verified.valid, true);
    assert.equal(verified.reason, null);
    assert.equal(verified.timestampSec, 1732500000);
  });

  it('2.2 rejects tampered payload with SIGNATURE_MISMATCH', () => {
    const signed = signWebhookPayload(
      { event: 'inbound_open', visitor_id: 'v_101' },
      'whsec_test_secret',
      { timestampSec: 1732500000 }
    );

    const verified = verifyWebhookSignature({
      payload: JSON.stringify({ event: 'inbound_open', visitor_id: 'v_999_tampered' }),
      headerValue: signed.headerValue,
      secret: 'whsec_test_secret',
      nowSec: 1732500010
    });

    assert.equal(verified.valid, false);
    assert.equal(verified.reason, 'SIGNATURE_MISMATCH');
  });

  it('2.3 rejects wrong webhook secret with SIGNATURE_MISMATCH', () => {
    const signed = signWebhookPayload({ event: 'inbound_open' }, 'whsec_correct', {
      timestampSec: 1732500000
    });
    const verified = verifyWebhookSignature({
      payload: signed.rawBody,
      headerValue: signed.headerValue,
      secret: 'whsec_wrong',
      nowSec: 1732500010
    });
    assert.equal(verified.valid, false);
    assert.equal(verified.reason, 'SIGNATURE_MISMATCH');
  });

  it('2.4 rejects expired timestamp outside replay tolerance window (TIMESTAMP_OUTSIDE_TOLERANCE)', () => {
    const signed = signWebhookPayload({ event: 'inbound_open' }, 'whsec_secret', {
      timestampSec: 1732500000
    });
    const verified = verifyWebhookSignature({
      payload: signed.rawBody,
      headerValue: signed.headerValue,
      secret: 'whsec_secret',
      toleranceSec: 300,
      nowSec: 1732500301 // 301 seconds later
    });
    assert.equal(verified.valid, false);
    assert.equal(verified.reason, 'TIMESTAMP_OUTSIDE_TOLERANCE');
  });

  it('2.5 rejects malformed or missing signature header', () => {
    const missing = verifyWebhookSignature({
      payload: '{}',
      headerValue: '',
      secret: 'whsec_secret'
    });
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'MISSING_SIGNATURE_HEADER');

    const malformed = verifyWebhookSignature({
      payload: '{}',
      headerValue: 't=notanumber,v1=xyz',
      secret: 'whsec_secret'
    });
    assert.equal(malformed.valid, false);
    assert.equal(malformed.reason, 'MALFORMED_SIGNATURE_HEADER');
  });

  it('2.6 throws when attempting to sign with an empty secret', () => {
    assert.throws(() => signWebhookPayload({ a: 1 }, ''), /Webhook secret must be a non-empty string/);
  });

  it('2.7 DeduplicationStore blocks duplicate deliveries by message_id or visitor_id + channel', () => {
    const store = new DeduplicationStore({ ttlMs: 60000 });
    const first = store.checkAndRecord({ message_id: 'msg_001' }, 1000);
    const second = store.checkAndRecord({ message_id: 'msg_001' }, 2000);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.hitCount, 2);

    const visFirst = store.checkAndRecord({ visitor_id: 'v_88', channel: 'WhatsApp' }, 1000);
    const visSecond = store.checkAndRecord({ visitor_id: 'V_88', channel: 'whatsapp' }, 1500);
    assert.equal(visFirst.duplicate, false);
    assert.equal(visSecond.duplicate, true);
  });

  it('2.8 DeduplicationStore allows event again after TTL expiration', () => {
    const store = new DeduplicationStore({ ttlMs: 5000 });
    const first = store.checkAndRecord({ message_id: 'msg_ttl' }, 1000);
    const afterTtl = store.checkAndRecord({ message_id: 'msg_ttl' }, 7000);
    assert.equal(first.duplicate, false);
    assert.equal(afterTtl.duplicate, false);
  });

  it('2.9 verifyWebhookSignature integrates with DeduplicationStore to block replay retries', () => {
    const store = new DeduplicationStore();
    const payload = { message_id: 'msg_777', visitor_id: 'v_1', channel: 'tg' };
    const signed = signWebhookPayload(payload, 'whsec_1', { timestampSec: 1732500000 });

    const attempt1 = verifyWebhookSignature({
      payload: signed.rawBody,
      headerValue: signed.headerValue,
      secret: 'whsec_1',
      nowSec: 1732500010,
      dedupStore: store
    });
    const attempt2 = verifyWebhookSignature({
      payload: signed.rawBody,
      headerValue: signed.headerValue,
      secret: 'whsec_1',
      nowSec: 1732500012,
      dedupStore: store
    });

    assert.equal(attempt1.valid, true);
    assert.equal(attempt2.valid, false);
    assert.equal(attempt2.reason, 'DUPLICATE_EVENT_IDEMPOTENT_BLOCK');
    assert.equal(attempt2.deduplicated, true);
  });
});

describe('3. Template Rendering, Throttle Jitter Tiers & UID Verification', () => {
  it('3.1 renders {{name}} and {{phone}} placeholders and replaces missing keys with empty string', () => {
    const text = renderMessageTemplate('Hello {{ name }}, your number is {{phone}} {{unknown_var}}.', {
      name: 'Alice',
      phone: '+14155550199'
    });
    assert.equal(text, 'Hello Alice, your number is +14155550199 .');
  });

  it('3.2 computes fast tier delay strictly within 3000–6000ms', () => {
    assert.equal(computeThrottleDelayMs('fast', () => 0), 3000);
    assert.equal(computeThrottleDelayMs('fast', () => 0.999999), 6000);
  });

  it('3.3 computes medium tier delay strictly within 8000–15000ms', () => {
    assert.equal(computeThrottleDelayMs('medium', () => 0), 8000);
    assert.equal(computeThrottleDelayMs('medium', () => 0.999999), 15000);
  });

  it('3.4 computes slow tier delay strictly within 20000–30000ms', () => {
    assert.equal(computeThrottleDelayMs('slow', () => 0), 20000);
    assert.equal(computeThrottleDelayMs('slow', () => 0.999999), 30000);
  });

  it('3.5 throws on unknown throttle tier name', () => {
    assert.throws(() => computeThrottleDelayMs('ultra_turbo'), /Invalid throttle tier/);
  });

  it('3.6 verifies recipient UID character-by-character and pinpoints mismatch index', () => {
    const ok = verifyRecipientUid('wa_85291234567', 'wa_85291234567');
    assert.equal(ok.matched, true);
    assert.equal(ok.mismatchIndex, -1);

    const bad = verifyRecipientUid('wa_85291234567', 'wa_85291234568');
    assert.equal(bad.matched, false);
    assert.equal(bad.mismatchIndex, 13);
  });
});

describe('4. SafeBroadcastQueue & Unknown-Status Lock State Machine', () => {
  it('4.1 sends all valid items when every dispatch returns status="sent"', () => {
    const q = new SafeBroadcastQueue({ tier: 'fast', rng: () => 0.5 });
    q.enqueue([
      { uid: 'u_1', name: 'Tom', phone: '+1001' },
      { uid: 'u_2', name: 'Jerry', phone: '+1002' }
    ]);

    const snap = q.runSync(() => ({ status: 'sent' }));
    assert.equal(snap.queueStatus, 'COMPLETED');
    assert.equal(snap.counts.sent, 2);
    assert.equal(snap.counts.pendingManualReview, 0);
  });

  it('4.2 locks item in PENDING_MANUAL_REVIEW and pauses queue when sender returns status="unknown"', () => {
    const q = new SafeBroadcastQueue({ tier: 'medium', rng: () => 0.25 });
    q.enqueue([
      { uid: 'u_1', name: 'C1' },
      { uid: 'u_2', name: 'C2' },
      { uid: 'u_3', name: 'C3' },
      { uid: 'u_4', name: 'C4' }
    ]);

    const snap = q.runSync((item) => {
      if (item.index === 3) {
        return { status: 'unknown', reason: 'DOM send ACK timeout after 10s' };
      }
      return { status: 'sent' };
    });

    assert.equal(snap.queueStatus, 'PAUSED_ON_UNKNOWN');
    assert.equal(snap.counts.sent, 2);
    assert.equal(snap.counts.pendingManualReview, 1);
    assert.equal(snap.counts.queued, 1);
    assert.equal(snap.items[2].state, ITEM_STATES.PENDING_MANUAL_REVIEW);
    assert.equal(snap.items[2].attempts, 1);
    assert.equal(snap.items[2].autoRetryAllowed, false);
  });

  it('4.3 strictly forbids automatic retry on PENDING_MANUAL_REVIEW items (throws AUTO_RETRY_FORBIDDEN)', () => {
    const q = new SafeBroadcastQueue({ tier: 'fast' });
    q.enqueue([{ uid: 'u_1', name: 'C1' }]);
    q.runSync(() => ({ status: 'unknown' }));

    assert.throws(
      () => q.attemptAutoRetry(1),
      /AUTO_RETRY_FORBIDDEN/
    );
  });

  it('4.4 allows human operator to resolve PENDING_MANUAL_REVIEW as confirm_already_sent and resume remaining queue', () => {
    const q = new SafeBroadcastQueue({ tier: 'fast' });
    q.enqueue([
      { uid: 'u_1', name: 'C1' },
      { uid: 'u_2', name: 'C2' },
      { uid: 'u_3', name: 'C3' }
    ]);

    q.runSync((item) => (item.index === 2 ? { status: 'unknown' } : { status: 'sent' }));
    assert.equal(q.status, 'PAUSED_ON_UNKNOWN');

    // Operator checks WhatsApp window and confirms message #2 was already sent
    q.resolveManualReview(2, 'confirm_already_sent');
    assert.equal(q.status, 'IDLE');

    const finalSnap = q.runSync(() => ({ status: 'sent' }));
    assert.equal(finalSnap.queueStatus, 'COMPLETED');
    assert.equal(finalSnap.counts.sent, 3);
    // Item #2 was never sent a second time
    assert.equal(finalSnap.items[1].attempts, 1);
  });

  it('4.5 skips recipient when activeWindowUid does not match intended uid character-by-character', () => {
    const q = new SafeBroadcastQueue({ tier: 'fast' });
    q.enqueue([
      { uid: 'wa_1001', activeWindowUid: 'wa_9999_wrong_chat', name: 'MismatchUser' },
      { uid: 'wa_1002', activeWindowUid: 'wa_1002', name: 'ValidUser' }
    ]);

    const snap = q.runSync(() => ({ status: 'sent' }));
    assert.equal(snap.counts.skippedInvalidUid, 1);
    assert.equal(snap.counts.sent, 1);
    assert.equal(snap.items[0].state, ITEM_STATES.SKIPPED_INVALID_UID);
    assert.equal(snap.items[0].attempts, 0);
  });
});

describe('5. CLI End-to-End Verification (cli.mjs)', () => {
  it('5.1 executes parse-msg, sign-webhook, and simulate-broadcast via CLI with --json', () => {
    const parseOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, 'parse-msg', '--text', 'Hi, I want the catalog [ref:lp01_fb_7a9c]', '--json'],
        { encoding: 'utf8' }
      )
    );
    assert.equal(parseOut.parsed.matched, true);
    assert.equal(parseOut.parsed.refCode, 'lp01_fb_7a9c');

    const signOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, 'sign-webhook', '--secret', 'whsec_demo', '--event', 'inbound_open', '--visitor', 'v_101', '--json'],
        { encoding: 'utf8' }
      )
    );
    assert.equal(signOut.verification.valid, true);
    assert.ok(signOut.signatureHeader.startsWith('t='));

    const simOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI_PATH, 'simulate-broadcast', '--count', '10', '--tier', 'medium', '--inject-unknown-at', '4', '--json'],
        { encoding: 'utf8' }
      )
    );
    assert.equal(simOut.queueStatus, 'PAUSED_ON_UNKNOWN');
    assert.equal(simOut.counts.sent, 3);
    assert.equal(simOut.counts.pendingManualReview, 1);
    assert.equal(simOut.counts.queued, 6);
    assert.equal(simOut.items[3].state, 'PENDING_MANUAL_REVIEW');
  });
});
