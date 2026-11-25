# scrm-webhook-attribution-kit

**Inbound First-Message Reference Code Attribution, HMAC-SHA256 Webhook Verifier & Human-in-the-Loop Safe Broadcast State Machine**

[![Tests](https://img.shields.io/badge/tests-26%20passing-brightgreen)](#quick-start)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#architecture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

In cross-border lead generation and customer support workflows (WhatsApp, Telegram, LINE), teams face two persistent engineering challenges:
1. **The "Button Click ≠ Real Inbound Message" Attribution Gap**: Firing a pixel on a landing page CTA button only records *intent to open the chat app*, not whether the visitor actually sent a message.
2. **Duplicate Follow-Up Spam on Uncertain Network States**: When an operator sends a scheduled follow-up list and a single message encounters a network or DOM timeout (`status = "unknown"`), naive queues automatically retry—often delivering the exact same message 2 or 3 times to the customer.

`scrm-webhook-attribution-kit` is a zero-dependency Node.js & browser reference toolkit providing lossless first-message `[ref:...]` attribution, replay-safe HMAC-SHA256 webhook verification, and a strict human-in-the-loop broadcast queue state machine.

---

## 1. The Attribution Gap: CTA Click vs. Real Inbound Message

```text
[Ad Click (fbclid / ttclid / gclid)]
       │
       ▼
[Landing Page CTA Click] ──► Fires Browser Pixel ("Contact")
       │                     ⚠️ 30%–60% drop off before sending first message!
       ▼
[WhatsApp / Telegram App Opens with Pre-filled Greeting + [ref:LP08_FB_9F2A]]
       │
       ▼
[Customer Sends First Inbound Message]  ◄── TRUE CONVERSION ("Real Inbound Open")
       │
       ▼
[parseInboundRefCode()] ──► Extracts LP08 + FB + ClickHash 9F2A
       │
       ▼
[signWebhookPayload() + DeduplicationStore] ──► Verified Webhook Callback
```

### Reference Code Closed-Loop Pseudocode

```js
import {
  injectRefCode,
  parseInboundRefCode,
  signWebhookPayload,
  verifyWebhookSignature,
  DeduplicationStore
} from './src/attribution-kit.mjs';

// Step 1: On the Landing Page — inject compact RefCode into pre-filled greeting
const outbound = injectRefCode({
  greeting: 'Hi, I would like the wholesale catalog',
  pageId: 'LP08',
  channel: 'FB',
  clickSeed: 'IwAR3x9kLmN0p'
});
// outbound.message => "Hi, I would like the wholesale catalog [ref:LP08_FB_9E4C]"

// Step 2: When the customer actually sends their first inbound message
const inbound = parseInboundRefCode(outbound.message);
// inbound => {
//   matched: true,
//   refCode: 'LP08_FB_9E4C',
//   cleanText: 'Hi, I would like the wholesale catalog',
//   pageId: 'LP08',
//   channel: 'FB',
//   clickHash: '9E4C',
//   attributionStage: 'REAL_INBOUND_OPEN'
// }
```

---

## 2. Webhook HMAC-SHA256 & Anti-Replay Specification

When forwarding verified inbound message events to your analytics or attribution endpoint, every webhook request is signed with a Unix timestamp (`t`) and HMAC-SHA256 digest (`v1`):

- **Header Format**: `X-SCRM-Signature: t=1732500000,v1=<64-char-hex>`
- **Signed String**: `${timestampSec}.${rawJsonBody}`
- **Verification Rules**:
  1. Reject if `|nowSec - timestampSec| > toleranceSec` (default `300` seconds replay window).
  2. Compare expected and received digests using `crypto.timingSafeEqual` to prevent timing side-channel leaks.
  3. Pass the event through `DeduplicationStore` (keyed by `message_id` or `visitor_id + channel`) so network retries never double-count conversions.

---

## 3. Safe Broadcast State Machine: Why `status = "unknown"` Never Auto-Retries

When sending customer service notifications or catalog follow-ups, network jitter or UI latency can cause an acknowledgment timeout even though the message **already reached the server**.

```text
                  ┌──────────────┐
                  │    QUEUED    │
                  └──────┬───────┘
                         │ verifyRecipientUid()
            ┌────────────┴────────────┐
            │ UID Mismatch            │ UID Matched (1st Attempt)
            ▼                         ▼
┌──────────────────────┐     ┌─────────────────┐
│ SKIPPED_INVALID_UID  │     │  Dispatch Once  │
└──────────────────────┘     └────────┬────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          │ status="sent"             │ status="unknown"          │ status="failed"
          ▼                           ▼                           ▼
   ┌──────────────┐     ┌───────────────────────────┐      ┌──────────────┐
   │     SENT     │     │   PENDING_MANUAL_REVIEW   │      │    FAILED    │
   └──────────────┘     │ (Queue Paused, 0 Retries) │      └──────────────┘
                        └─────────────┬─────────────┘
                                      │ Human Operator Inspection
                        ┌─────────────┴─────────────┐
                        │                           │
           confirm_already_sent           approve_manual_resend
                        ▼                           ▼
                 ┌──────────────┐            ┌──────────────┐
                 │     SENT     │            │    QUEUED    │
                 └──────────────┘            └──────────────┘
```

### Built-In Safety Controls in `SafeBroadcastQueue`
- **Character-by-Character UID Verification (`verifyRecipientUid`)**: Confirms the active chat session UID matches the intended recipient before dispatching.
- **Three Jitter Tiers (`computeThrottleDelayMs`)**:
  - `fast`: `3000ms – 6000ms` randomized interval
  - `medium`: `8000ms – 15000ms` randomized interval
  - `slow`: `20000ms – 30000ms` randomized interval
- **Hard Lock on `unknown`**: Calling `attemptAutoRetry()` on any item in `PENDING_MANUAL_REVIEW` throws `AUTO_RETRY_FORBIDDEN`. Only an explicit operator action (`resolveManualReview(idx, 'confirm_already_sent' | 'approve_manual_resend')`) can clear the lock.

---

## 4. Quick Start: CLI & Offline Sandbox

### Requirements
- Node.js `>= 18.0.0` (Zero external dependencies)

### CLI Usage

```bash
# 1. Parse an inbound first message with [ref:...]
node cli.mjs parse-msg --text "Hi, I want the catalog [ref:lp01_fb_7a9c]" --json

# 2. Generate and verify an HMAC-SHA256 webhook payload
node cli.mjs sign-webhook --secret "whsec_demo" --event "inbound_open" --visitor "v_101" --json

# 3. Simulate a 10-recipient broadcast where item #4 returns status="unknown"
node cli.mjs simulate-broadcast --count 10 --tier medium --inject-unknown-at 4 --json
```

### Offline Interactive Panel (`index.html`)
Open `index.html` directly in any browser (zero external requests):
- **Left Panel**: Test multilingual first-message `[ref:...]` extraction, inspect generated `X-SCRM-Signature` headers, and trigger duplicate webhook delivery blocks.
- **Right Panel**: Run the interactive broadcast state machine, trigger a simulated `status = "unknown"` pause at any index, and test manual operator resolution buttons.

### Run Unit Tests
```bash
node --test test/scrm-kit.test.mjs
```

---

## 5. FAQ

**Q: Does stripping `[ref:...]` alter the customer's original message formatting?**  
A: `parseInboundRefCode()` removes only the `[ref:...]` or `(ref:...)` token and normalizes redundant adjacent spaces, preserving emojis, line breaks, and non-Latin scripts (Chinese, Arabic, Spanish, etc.).

**Q: Why use `crypto.timingSafeEqual` for webhook verification?**  
A: Standard string comparison (`===`) short-circuits on the first mismatched byte, which can leak signature byte prefixes over high-volume timing measurements. `crypto.timingSafeEqual` runs in constant time.

**Q: Why pause the entire queue when a single item returns `status = "unknown"`?**  
A: An `unknown` acknowledgment typically indicates a degraded network connection or an unresponsive session state. Continuing to fire subsequent items under degraded conditions would multiply uncertain states; pausing immediately lets the operator inspect the session cleanly.

---

## Related Projects & Ecosystem

- Multi-session customer support workspace & inbound attribution workflows: [scrm.chuhaili.ai](https://scrm.chuhaili.ai)
- Visual landing page builder with pre-filled `[ref:...]` CTA generators: [builder.ipcloak.ai](https://builder.ipcloak.ai)

## License

[MIT](./LICENSE) © IpCloak
