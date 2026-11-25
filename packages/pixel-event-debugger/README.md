# pixel-event-debugger

**Cross-Platform Ad Pixel Event Mapper, Deterministic Deduplication ID Generator, Offline Sandbox & Static HTML Linter (Meta / TikTok / GA4)**

[![CI](https://img.shields.io/badge/tests-25%20passing-brightgreen)](#quick-start)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#architecture)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

When running multi-channel paid traffic across **Meta Ads**, **TikTok Ads**, and **Google Ads / GA4**, engineering teams frequently run into silent tracking failures: inconsistent event names (`Purchase` vs `CompletePayment` vs `purchase`), broken Browser-to-Server deduplication due to mismatched `event_id` placement, unformatted `_fbc` cookies, or missing ISO-4217 currency parameters.

`pixel-event-debugger` is a zero-dependency open-source toolkit and offline sandbox that unifies pixel event schemas, generates deterministic deduplication IDs, parses click attribution IDs (`fbclid` / `ttclid` / `gclid`), and statically audits HTML landing pages before deployment.

---

## 1. Cross-Platform Standard Event Reference Table

A single user action on a landing page must be translated into distinct standard event names and parameter structures across Meta, TikTok, and GA4:

| Unified Business Action | Meta Pixel (`fbq`) | TikTok Pixel (`ttq`) | Google Analytics 4 (`gtag`) | Required Parameters | Deduplication ID Carrier |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `page_view` | `PageView` | `ViewContent` | `page_view` | *(none)* | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `lead` | `Lead` | `SubmitForm` | `generate_lead` | *(optional `value`, `currency`)* | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `contact` | `Contact` | `Contact` | `contact` | *(none)* | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `add_to_cart` | `AddToCart` | `AddToCart` | `add_to_cart` | `value` (Number), `currency` (ISO-4217) | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `initiate_checkout` | `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` | *(recommended `value`, `currency`)* | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `purchase` | `Purchase` | `CompletePayment` | `purchase` | `value`, `currency` (+ `transaction_id` on GA4) | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `complete_registration` | `CompleteRegistration` | `CompleteRegistration` | `sign_up` | *(optional `status`, `method`)* | 4th arg `{ eventID }` (Meta) / `event_id` param |
| `download` | `Download` | `Download` | `file_download` | *(recommended `content_name` / `file_name`)* | 4th arg `{ eventID }` (Meta) / `event_id` param |

---

## 2. Browser Pixel + Server Event Deduplication Principle

When hybrid tracking (Browser Pixel + Server API) is active, both channels report the same conversion. Ad platforms deduplicate events by matching **`event_name` + `event_id`** within their attribution window. If both sides generate random UUIDs independently, deduplication fails and conversions are double-counted.

### Deterministic `event_id` Pseudocode

By deriving `event_id` deterministically from a shared visitor seed, page slug, action name, and a coarse time bucket (e.g. 5-second window), both the browser click handler and the form/order webhook produce the exact same ID without race conditions:

```js
import { generateEventId, captureClickIds } from './src/pixel-bridge.mjs';

// 1. Capture click attribution on landing page entry
const clickInfo = captureClickIds(window.location.href, { timestampMs: Date.now() });
// => clickInfo.fbc === "fb.1.1732500000000.IwAR3x9kLm..."

// 2. Generate deterministic event_id within a 5-second bucket
const eventId = generateEventId({
  pageSlug: 'lp-us-v1',
  action: 'purchase',
  visitorSeed: clickInfo.fbclid || 'sess_98a7b6',
  timestampMs: Date.now(),
  bucketSeconds: 5
});
// => "evt_lp-us-v1_purchase_346500000_a94f6e8d2c1b0347"

// 3. Fire Browser Pixels with explicit deduplication ID
fbq('track', 'Purchase', { value: 49.9, currency: 'USD' }, { eventID: eventId });
ttq.track('CompletePayment', { value: 49.9, currency: 'USD', event_id: eventId });
gtag('event', 'purchase', { transaction_id: 'ord_0347', value: 49.9, currency: 'USD', event_id: eventId });
```

---

## 3. Top 5 Real-World Pixel Tracking Failure Cases

`validatePixelPayload()` and `lintHtmlPixelSetup()` specifically guard against the 5 most frequent landing page tracking bugs:

1. **Case #1: Misplaced `event_id` in Meta Pixel (`META_EVENT_ID_MISPLACED`)**
   - *Bug*: Calling `fbq('track', 'Lead', { event_id: 'evt_123' })`.
   - *Why it fails*: Meta's `fbevents.js` ignores `event_id` inside the 3rd `parameters` object—it treats it as a custom property instead of the deduplication key.
   - *Fix*: Pass `{ eventID: 'evt_123' }` in the **4th** `options` argument: `fbq('track', 'Lead', {}, { eventID: 'evt_123' })`.

2. **Case #2: Cross-Platform Event Name Typos (`EVENT_NAME_TYPO`)**
   - *Bug*: Firing `fbq('track', 'init_checkout')`, `ttq.track('purchase')`, or `gtag('event', 'Purchase')`.
   - *Why it fails*: Ad platforms only optimize delivery for exact case-sensitive standard events (`InitiateCheckout`, `CompletePayment`, `purchase`). Misspelled names fall into unindexed custom events.

3. **Case #3: Missing or Non-ISO Currency on Monetary Events (`INVALID_CURRENCY_CODE` / `MISSING_CURRENCY`)**
   - *Bug*: Passing `{ value: "$49.90", currency: "us" }` or omitting `currency` on `Purchase` / `CompletePayment`.
   - *Why it fails*: Meta and TikTok reject monetary events where `value` is a formatted string with currency symbols or `currency` is not a 3-letter uppercase ISO-4217 code (`USD`, `EUR`, `GBP`, `JPY`, etc.).

4. **Case #4: Duplicate SDK Script or Pixel Init on the Same Page (`DUPLICATE_PIXEL_SCRIPT` / `DUPLICATE_PIXEL_INIT`)**
   - *Bug*: Pasting the base pixel code in both the global `<head>` layout and a page-level custom HTML block.
   - *Why it fails*: Every button click fires `fbq` or `ttq` twice, inflating reported leads/purchases by 200% and skewing automated bidding.

5. **Case #5: Unbound Conversion CTA Buttons (`UNBOUND_CTA_BUTTON`)**
   - *Bug*: Replacing a landing page WhatsApp/Telegram/Order button in a visual editor without re-attaching the click listener or `data-pixel-action` attribute.
   - *Why it fails*: Traffic clicks through to the chat or checkout, but 0 `Contact` or `InitiateCheckout` events are recorded.

---

## 4. Quick Start: CLI & Offline Sandbox

### Requirements
- Node.js `>= 18.0.0` (Zero external `npm` dependencies required)

### Run CLI Event Mapper
Generate ready-to-paste Meta, TikTok, and GA4 snippets along with deterministic `event_id` and `_fbc` formatting:

```bash
node cli.mjs map --action purchase --value 49.9 --currency USD
```

Output as structured JSON (including click attribution parsing):

```bash
node cli.mjs map --action lead --url "https://offer.example.com/?fbclid=IwAR123&utm_source=meta" --json
```

### Run Static HTML Pixel Linter
Scan any local HTML landing page file for duplicate pixel scripts, missing required parameters, or inline `onclick` event typos:

```bash
node cli.mjs lint index.html
node cli.mjs lint index.html --json
```

### Open the Offline Interactive Sandbox (`index.html`)
Open `index.html` directly in any browser (`file://` protocol supported, zero external network requests):
- **Left Panel**: Edit simulated landing URL (`fbclid` / `ttclid` / `utm_*`), visitor seed, order value, and currency; click the **Contact**, **Lead**, **Purchase**, or **Broken Payload Demo** buttons.
- **Right Panel**: Inspect real-time `fbq('track', ...)`, `ttq.track(...)`, and `gtag('event', ...)` payloads, deterministic `event_id`, formatted `_fbc` cookie value, and static validation alerts.

### Run Unit Tests
```bash
node --test test/pixel.test.mjs
```

---

## 5. FAQ

**Q: Why does `generateEventId` use a 5-second time bucket by default?**  
A: When a user submits a form or completes a checkout, the browser event and the webhook/form-handler event typically occur within milliseconds to a few seconds of each other. Bucketing timestamps into 5-second windows allows deterministic matching while still permitting repeat legitimate actions (like adding another item to cart) later in the session.

**Q: Should `_fbc` be URL-encoded or modified when read from `fbclid`?**  
A: No. Per Meta's specification, `_fbc` is formatted strictly as `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>` where `<fbclid>` is preserved case-sensitively from the query string.

**Q: Can I use `src/pixel-bridge.mjs` directly in browser ES modules?**  
A: Yes. `src/pixel-bridge.mjs` uses pure standard JavaScript (`BigInt`, `URL`, `URLSearchParams`) with zero Node-only built-ins, so it runs identically in modern browsers, Cloudflare Workers, and Node.js.

---

## Related Tools

If you prefer visual landing page assembly with pre-wired multi-platform pixel event bindings and click-ID forwarding out of the box, check out [builder.ipcloak.ai](https://builder.ipcloak.ai).

## License

[MIT](./LICENSE) © IpCloak
