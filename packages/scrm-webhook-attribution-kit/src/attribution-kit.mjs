import crypto from 'node:crypto';

/**
 * SCRM Webhook Attribution & Safe Broadcast Throttler Kit
 * Zero-dependency reference implementation for:
 * 1. First-Message Reference Code injection & lossless parsing (injectRefCode / parseInboundRefCode)
 * 2. Webhook HMAC-SHA256 signing, replay-window verification & idempotency (signWebhookPayload / verifyWebhookSignature / DeduplicationStore)
 * 3. Human-in-the-loop Safe Broadcast State Machine (SafeBroadcastQueue) where status="unknown" locks into PENDING_MANUAL_REVIEW and never auto-retries.
 */

export const THROTTLE_TIERS = Object.freeze({
  fast: { minMs: 3000, maxMs: 6000, label: 'Fast (3s–6s jitter)' },
  medium: { minMs: 8000, maxMs: 15000, label: 'Medium (8s–15s jitter)' },
  slow: { minMs: 20000, maxMs: 30000, label: 'Slow (20s–30s jitter)' }
});

export const ITEM_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  PENDING_MANUAL_REVIEW: 'PENDING_MANUAL_REVIEW',
  SKIPPED_INVALID_UID: 'SKIPPED_INVALID_UID'
});

function sanitizeToken(input, fallback = 'NA') {
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, '')
    .toUpperCase();
  return cleaned || fallback;
}

/**
 * Build a compact, deterministic or seeded Reference Code token (`LP08_FB_9F2A`)
 * and inject it into a pre-filled WhatsApp / Telegram / LINE greeting message.
 *
 * @param {Object} options
 * @param {string} options.greeting - Base greeting text (e.g. "Hi, I want the catalog")
 * @param {string} [options.pageId='LP01'] - Landing page identifier
 * @param {string} [options.channel='FB'] - Traffic source code (FB, TT, GG, IG, etc.)
 * @param {string} [options.clickSeed] - Click ID or session seed to hash (4-8 hex chars)
 * @param {string} [options.refCode] - Explicit refCode override (e.g. "lp01_fb_7a9c")
 * @returns {{ message: string, refCode: string, tag: string, metadata: { pageId: string, channel: string, clickHash: string } }}
 */
export function injectRefCode({
  greeting = 'Hello, I would like more details.',
  pageId = 'LP01',
  channel = 'FB',
  clickSeed = 'anon',
  refCode
} = {}) {
  const baseText = String(greeting ?? '').trim();
  let finalCode;
  let parsedMeta;

  if (refCode && String(refCode).trim() !== '') {
    finalCode = String(refCode).trim();
    const parts = finalCode.split('_');
    parsedMeta = {
      pageId: (parts[0] || pageId).toUpperCase(),
      channel: (parts[1] || channel).toUpperCase(),
      clickHash: (parts.slice(2).join('_') || '0000').toUpperCase()
    };
  } else {
    const cleanPage = sanitizeToken(pageId, 'LP01');
    const cleanChannel = sanitizeToken(channel, 'FB');
    const digest = crypto
      .createHash('sha256')
      .update(`${cleanPage}|${cleanChannel}|${String(clickSeed)}`)
      .digest('hex')
      .slice(0, 4)
      .toUpperCase();
    finalCode = `${cleanPage}_${cleanChannel}_${digest}`;
    parsedMeta = {
      pageId: cleanPage,
      channel: cleanChannel,
      clickHash: digest
    };
  }

  const tag = `[ref:${finalCode}]`;
  // Avoid double injection if already present
  const cleanGreeting = baseText.replace(/\s*\[ref:[a-zA-Z0-9_-]+\]\s*/gi, ' ').trim();
  const message = cleanGreeting ? `${cleanGreeting} ${tag}` : tag;

  return {
    message,
    refCode: finalCode,
    tag,
    metadata: parsedMeta
  };
}

/**
 * Losslessly extract `[ref:...]` or `(ref:...)` from an inbound customer's first message,
 * restoring the clean human message and the structured attribution context.
 *
 * @param {string} inboundText - Raw first message received in WhatsApp/Telegram/LINE
 * @returns {{
 *   matched: boolean,
 *   refCode: string|null,
 *   cleanText: string,
 *   pageId: string|null,
 *   channel: string|null,
 *   clickHash: string|null,
 *   attributionStage: 'REAL_INBOUND_OPEN'|'UNATTRIBUTED_ORGANIC'
 * }}
 */
export function parseInboundRefCode(inboundText = '') {
  const raw = String(inboundText ?? '');
  const regex = /(?:\[ref:([a-zA-Z0-9_-]{3,64})\]|\(ref:([a-zA-Z0-9_-]{3,64})\))/i;
  const match = raw.match(regex);

  if (!match) {
    return {
      matched: false,
      refCode: null,
      cleanText: raw.trim(),
      pageId: null,
      channel: null,
      clickHash: null,
      attributionStage: 'UNATTRIBUTED_ORGANIC'
    };
  }

  const extracted = match[1] || match[2];
  const cleanText = raw
    .replace(match[0], '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const segments = extracted.split('_').filter(Boolean);
  const pageId = segments[0] ? segments[0].toUpperCase() : null;
  const channel = segments[1] ? segments[1].toUpperCase() : null;
  const clickHash = segments.length > 2 ? segments.slice(2).join('_').toUpperCase() : null;

  return {
    matched: true,
    refCode: extracted,
    cleanText,
    pageId,
    channel,
    clickHash,
    attributionStage: 'REAL_INBOUND_OPEN'
  };
}

/**
 * Sign a webhook payload using HMAC-SHA256 with a unix timestamp (`t=<sec>,v1=<hex>`).
 *
 * @param {Object|string} payload - Webhook body (object or serialized JSON string)
 * @param {string} secret - Shared webhook secret (e.g. "whsec_...")
 * @param {Object} [options]
 * @param {number} [options.timestampSec] - Unix timestamp in seconds (defaults to Math.floor(Date.now() / 1000))
 * @returns {{
 *   timestampSec: number,
 *   rawBody: string,
 *   signature: string,
 *   headerValue: string,
 *   headers: Record<string, string>
 * }}
 */
export function signWebhookPayload(payload, secret, options = {}) {
  if (!secret || typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('Webhook secret must be a non-empty string.');
  }
  const timestampSec =
    options.timestampSec !== undefined
      ? Math.floor(Number(options.timestampSec))
      : Math.floor(Date.now() / 1000);

  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedContent = `${timestampSec}.${rawBody}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedContent, 'utf8')
    .digest('hex');

  const headerValue = `t=${timestampSec},v1=${signature}`;

  return {
    timestampSec,
    rawBody,
    signature,
    headerValue,
    headers: {
      'Content-Type': 'application/json',
      'X-SCRM-Signature': headerValue,
      'X-SCRM-Timestamp': String(timestampSec)
    }
  };
}

/**
 * Verify an inbound webhook HMAC-SHA256 signature with constant-time comparison (`crypto.timingSafeEqual`)
 * and replay window enforcement (default 300 seconds).
 *
 * @param {Object} params
 * @param {string|Object} params.payload - Raw request body string (or object)
 * @param {string} params.headerValue - Value of `X-SCRM-Signature` (`t=...,v1=...`)
 * @param {string} params.secret - Shared webhook secret
 * @param {number} [params.toleranceSec=300] - Allowed clock skew / replay window in seconds
 * @param {number} [params.nowSec] - Current unix timestamp in seconds for testing
 * @param {DeduplicationStore} [params.dedupStore] - Optional idempotency store to block duplicate deliveries
 * @returns {{ valid: boolean, reason: string|null, timestampSec: number|null, deduplicated?: boolean }}
 */
export function verifyWebhookSignature({
  payload,
  headerValue,
  secret,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
  dedupStore
} = {}) {
  if (!secret || typeof secret !== 'string') {
    return { valid: false, reason: 'MISSING_SECRET', timestampSec: null };
  }
  if (!headerValue || typeof headerValue !== 'string') {
    return { valid: false, reason: 'MISSING_SIGNATURE_HEADER', timestampSec: null };
  }

  const parts = {};
  for (const piece of headerValue.split(',')) {
    const [k, v] = piece.trim().split('=');
    if (k && v) parts[k] = v;
  }

  const timestampSec = Number(parts.t);
  const receivedHex = parts.v1;

  if (!Number.isFinite(timestampSec) || !receivedHex || !/^[0-9a-fA-F]{64}$/.test(receivedHex)) {
    return { valid: false, reason: 'MALFORMED_SIGNATURE_HEADER', timestampSec: null };
  }

  const ageSec = Math.abs(nowSec - timestampSec);
  if (ageSec > toleranceSec) {
    return { valid: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE', timestampSec };
  }

  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const receivedBuf = Buffer.from(receivedHex, 'hex');

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH', timestampSec };
  }

  // Optional idempotency check
  if (dedupStore) {
    let parsedObj = null;
    try {
      parsedObj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      parsedObj = null;
    }
    if (parsedObj) {
      const check = dedupStore.checkAndRecord(parsedObj, nowSec * 1000);
      if (check.duplicate) {
        return {
          valid: false,
          reason: 'DUPLICATE_EVENT_IDEMPOTENT_BLOCK',
          timestampSec,
          deduplicated: true,
          dedupKey: check.key
        };
      }
    }
  }

  return { valid: true, reason: null, timestampSec, deduplicated: false };
}

/**
 * In-memory Idempotency & Deduplication Store for inbound conversion webhooks.
 * Deduplicates by `message_id` or `visitor_id + channel` within a configurable TTL.
 */
export class DeduplicationStore {
  /**
   * @param {Object} [options]
   * @param {number} [options.ttlMs=86400000] - Deduplication retention window in ms (default 24h)
   */
  constructor({ ttlMs = 86400 * 1000 } = {}) {
    this.ttlMs = Number(ttlMs) || 86400 * 1000;
    this.records = new Map();
  }

  /**
   * Derive canonical idempotency key from event payload
   */
  deriveKey(event = {}) {
    if (event.message_id) {
      return `msg:${String(event.message_id).trim()}`;
    }
    if (event.visitor_id && event.channel) {
      return `vis:${String(event.visitor_id).trim().toLowerCase()}:ch:${String(event.channel).trim().toLowerCase()}`;
    }
    if (event.ref_code && event.visitor_id) {
      return `ref:${String(event.ref_code).trim().toUpperCase()}:vis:${String(event.visitor_id).trim().toLowerCase()}`;
    }
    throw new Error('Cannot derive idempotency key: require message_id or (visitor_id + channel).');
  }

  /**
   * Check if event was already processed; if not, record it.
   *
   * @param {Object} event
   * @param {number} [nowMs=Date.now()]
   * @returns {{ duplicate: boolean, key: string, firstSeenAt: number }}
   */
  checkAndRecord(event, nowMs = Date.now()) {
    const key = this.deriveKey(event);
    const existing = this.records.get(key);

    if (existing && nowMs - existing.firstSeenAt <= this.ttlMs) {
      existing.hitCount += 1;
      return {
        duplicate: true,
        key,
        firstSeenAt: existing.firstSeenAt,
        hitCount: existing.hitCount
      };
    }

    this.records.set(key, { firstSeenAt: nowMs, hitCount: 1 });
    return {
      duplicate: false,
      key,
      firstSeenAt: nowMs,
      hitCount: 1
    };
  }

  size() {
    return this.records.size;
  }

  clear() {
    this.records.clear();
  }
}

/**
 * Render template variables like `{{name}}`, `{{phone}}`, `{{company}}` safely.
 *
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {string}
 */
export function renderMessageTemplate(template = '', variables = {}) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = variables[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * Compute randomized jitter interval in milliseconds for a given throttle tier.
 *
 * @param {'fast'|'medium'|'slow'} [tier='medium']
 * @param {() => number} [rng=Math.random] - Optional deterministic RNG returning [0, 1)
 * @returns {number} Delay in milliseconds
 */
export function computeThrottleDelayMs(tier = 'medium', rng = Math.random) {
  const spec = THROTTLE_TIERS[tier];
  if (!spec) {
    throw new Error(`Invalid throttle tier "${tier}". Supported: ${Object.keys(THROTTLE_TIERS).join(', ')}`);
  }
  const ratio = Math.max(0, Math.min(0.999999, Number(rng())));
  return Math.floor(spec.minMs + ratio * (spec.maxMs - spec.minMs + 1));
}

/**
 * Character-by-character recipient UID / phone identifier verifier.
 * Ensures the active chat window UID matches the intended recipient before dispatching.
 *
 * @param {string} expectedUid
 * @param {string} activeWindowUid
 * @returns {{ matched: boolean, normalizedExpected: string, normalizedActive: string, mismatchIndex: number }}
 */
export function verifyRecipientUid(expectedUid, activeWindowUid) {
  const normExp = String(expectedUid ?? '').trim();
  const normAct = String(activeWindowUid ?? '').trim();

  if (!normExp || !normAct) {
    return {
      matched: false,
      normalizedExpected: normExp,
      normalizedActive: normAct,
      mismatchIndex: 0
    };
  }

  const maxLen = Math.max(normExp.length, normAct.length);
  for (let i = 0; i < maxLen; i++) {
    if (normExp[i] !== normAct[i]) {
      return {
        matched: false,
        normalizedExpected: normExp,
        normalizedActive: normAct,
        mismatchIndex: i
      };
    }
  }

  return {
    matched: true,
    normalizedExpected: normExp,
    normalizedActive: normAct,
    mismatchIndex: -1
  };
}

/**
 * Human-in-the-Loop Safe Broadcast Queue State Machine.
 *
 * Core Engineering Invariant:
 * When any single dispatch returns `status = "unknown"` (e.g. network timeout, DOM ack timeout,
 * or uncertain delivery state), the state machine MUST lock that item as `PENDING_MANUAL_REVIEW`
 * and pause the queue (`PAUSED_ON_UNKNOWN`) rather than auto-retrying and spamming the contact.
 */
export class SafeBroadcastQueue {
  /**
   * @param {Object} [options]
   * @param {'fast'|'medium'|'slow'} [options.tier='medium']
   * @param {string} [options.template='Hi {{name}}, following up on your inquiry ({{phone}}).']
   * @param {() => number} [options.rng=Math.random]
   * @param {boolean} [options.pauseQueueOnUnknown=true]
   */
  constructor({
    tier = 'medium',
    template = 'Hi {{name}}, following up on your inquiry ({{phone}}).',
    rng = Math.random,
    pauseQueueOnUnknown = true
  } = {}) {
    if (!THROTTLE_TIERS[tier]) {
      throw new Error(`Unsupported throttle tier "${tier}".`);
    }
    this.tier = tier;
    this.template = template;
    this.rng = rng;
    this.pauseQueueOnUnknown = pauseQueueOnUnknown;
    this.status = 'IDLE'; // IDLE | RUNNING | PAUSED_ON_UNKNOWN | COMPLETED
    this.items = [];
  }

  /**
   * Enqueue a list of recipients
   * @param {Array<{ uid: string, name?: string, phone?: string, activeWindowUid?: string }>} recipients
   */
  enqueue(recipients = []) {
    for (const r of recipients) {
      const uid = String(r.uid ?? '').trim();
      const renderedText = renderMessageTemplate(this.template, {
        name: r.name || 'Customer',
        phone: r.phone || uid,
        uid
      });
      const delayMs = computeThrottleDelayMs(this.tier, this.rng);
      this.items.push({
        index: this.items.length + 1,
        uid,
        activeWindowUid: r.activeWindowUid !== undefined ? String(r.activeWindowUid).trim() : uid,
        name: r.name || 'Customer',
        phone: r.phone || uid,
        renderedText,
        plannedDelayMs: delayMs,
        state: ITEM_STATES.QUEUED,
        attempts: 0,
        autoRetryAllowed: false,
        lastReason: null
      });
    }
    return this.items.length;
  }

  /**
   * Process next queued items using a synchronous or async sender callback.
   *
   * @param {(item: Object) => { status: 'sent'|'failed'|'unknown', reason?: string }} senderFn
   * @returns {Object} Execution summary and item states
   */
  runSync(senderFn) {
    if (this.status === 'PAUSED_ON_UNKNOWN') {
      return this.getSnapshot();
    }
    this.status = 'RUNNING';

    for (const item of this.items) {
      if (item.state !== ITEM_STATES.QUEUED) {
        continue;
      }

      // Step 1: Verify UID character-by-character before sending
      const uidCheck = verifyRecipientUid(item.uid, item.activeWindowUid);
      if (!uidCheck.matched) {
        item.state = ITEM_STATES.SKIPPED_INVALID_UID;
        item.lastReason = `UID mismatch at index ${uidCheck.mismatchIndex}: expected "${uidCheck.normalizedExpected}", got "${uidCheck.normalizedActive}"`;
        continue;
      }

      // Step 2: Dispatch exactly once
      item.attempts += 1;
      const result = senderFn(item) || { status: 'unknown' };
      const outcome = String(result.status || 'unknown').toLowerCase();

      if (outcome === 'sent' || outcome === 'ok') {
        item.state = ITEM_STATES.SENT;
        item.lastReason = 'DELIVERED_ACK';
      } else if (outcome === 'unknown' || outcome === 'timeout') {
        // CORE RULE: Never auto-retry unknown delivery states; lock for manual human verification
        item.state = ITEM_STATES.PENDING_MANUAL_REVIEW;
        item.autoRetryAllowed = false;
        item.lastReason =
          result.reason ||
          'DELIVERY_ACK_UNKNOWN: Locked for manual operator review. Automatic retry is strictly prohibited.';
        if (this.pauseQueueOnUnknown) {
          this.status = 'PAUSED_ON_UNKNOWN';
          break;
        }
      } else {
        item.state = ITEM_STATES.FAILED;
        item.lastReason = result.reason || 'EXPLICIT_SEND_ERROR';
      }
    }

    if (this.status !== 'PAUSED_ON_UNKNOWN') {
      const hasQueued = this.items.some((i) => i.state === ITEM_STATES.QUEUED);
      this.status = hasQueued ? 'RUNNING' : 'COMPLETED';
    }

    return this.getSnapshot();
  }

  /**
   * Attempt an automatic retry on an item — strictly throws/rejects if item is in PENDING_MANUAL_REVIEW.
   */
  attemptAutoRetry(itemIndex) {
    const item = this.items.find((i) => i.index === itemIndex);
    if (!item) {
      throw new Error(`Queue item #${itemIndex} not found.`);
    }
    if (item.state === ITEM_STATES.PENDING_MANUAL_REVIEW) {
      throw new Error(
        `AUTO_RETRY_FORBIDDEN: Item #${itemIndex} (${item.uid}) is in PENDING_MANUAL_REVIEW due to unknown delivery status. Human verification is required.`
      );
    }
    return false;
  }

  /**
   * Human operator resolution for an item in PENDING_MANUAL_REVIEW
   *
   * @param {number} itemIndex - 1-based item index
   * @param {'confirm_already_sent'|'approve_manual_resend'} resolution
   */
  resolveManualReview(itemIndex, resolution) {
    const item = this.items.find((i) => i.index === itemIndex);
    if (!item) {
      throw new Error(`Queue item #${itemIndex} not found.`);
    }
    if (item.state !== ITEM_STATES.PENDING_MANUAL_REVIEW) {
      throw new Error(`Item #${itemIndex} is not in PENDING_MANUAL_REVIEW (current: ${item.state}).`);
    }

    if (resolution === 'confirm_already_sent') {
      item.state = ITEM_STATES.SENT;
      item.lastReason = 'MANUAL_CONFIRMED_SENT';
    } else if (resolution === 'approve_manual_resend') {
      item.state = ITEM_STATES.QUEUED;
      item.lastReason = 'MANUAL_REQUEUED_BY_OPERATOR';
    } else {
      throw new Error(`Unknown manual resolution "${resolution}".`);
    }

    const stillPendingReview = this.items.some(
      (i) => i.state === ITEM_STATES.PENDING_MANUAL_REVIEW
    );
    if (!stillPendingReview && this.status === 'PAUSED_ON_UNKNOWN') {
      this.status = 'IDLE';
    }
    return item;
  }

  getSnapshot() {
    const counts = {
      total: this.items.length,
      queued: 0,
      sent: 0,
      failed: 0,
      pendingManualReview: 0,
      skippedInvalidUid: 0
    };
    for (const item of this.items) {
      if (item.state === ITEM_STATES.QUEUED) counts.queued++;
      else if (item.state === ITEM_STATES.SENT) counts.sent++;
      else if (item.state === ITEM_STATES.FAILED) counts.failed++;
      else if (item.state === ITEM_STATES.PENDING_MANUAL_REVIEW) counts.pendingManualReview++;
      else if (item.state === ITEM_STATES.SKIPPED_INVALID_UID) counts.skippedInvalidUid++;
    }
    return {
      queueStatus: this.status,
      tier: this.tier,
      counts,
      items: this.items.map((i) => ({ ...i }))
    };
  }
}
