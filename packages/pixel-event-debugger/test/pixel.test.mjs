import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_MAP,
  buildCrossPlatformPayloads,
  captureClickIds,
  generateEventId,
  lintHtmlPixelSetup,
  validatePixelPayload
} from '../src/pixel-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('1. Cross-Platform Event Mapping (EVENT_MAP & buildCrossPlatformPayloads)', () => {
  it('1.1 covers all 8 standard business actions', () => {
    const actions = Object.keys(EVENT_MAP);
    assert.deepEqual(actions, [
      'page_view',
      'lead',
      'contact',
      'add_to_cart',
      'initiate_checkout',
      'purchase',
      'complete_registration',
      'download'
    ]);
  });

  it('1.2 maps page_view to PageView (Meta), ViewContent (TikTok), and page_view (GA4)', () => {
    const res = buildCrossPlatformPayloads({ action: 'page_view', timestampMs: 1700000000000 });
    assert.equal(res.platforms.meta.eventName, 'PageView');
    assert.equal(res.platforms.tiktok.eventName, 'ViewContent');
    assert.equal(res.platforms.ga4.eventName, 'page_view');
  });

  it('1.3 maps lead to Lead (Meta), SubmitForm (TikTok), and generate_lead (GA4)', () => {
    const res = buildCrossPlatformPayloads({ action: 'lead', timestampMs: 1700000000000 });
    assert.equal(res.platforms.meta.eventName, 'Lead');
    assert.equal(res.platforms.tiktok.eventName, 'SubmitForm');
    assert.equal(res.platforms.ga4.eventName, 'generate_lead');
  });

  it('1.4 maps contact to Contact (Meta), Contact (TikTok), and contact (GA4)', () => {
    const res = buildCrossPlatformPayloads({ action: 'contact', timestampMs: 1700000000000 });
    assert.equal(res.platforms.meta.eventName, 'Contact');
    assert.equal(res.platforms.tiktok.eventName, 'Contact');
    assert.equal(res.platforms.ga4.eventName, 'contact');
  });

  it('1.5 maps purchase to Purchase (Meta), CompletePayment (TikTok), and purchase (GA4) with shared event_id', () => {
    const res = buildCrossPlatformPayloads({
      action: 'purchase',
      value: 49.9,
      currency: 'usd',
      contentId: 'sku-01',
      contentName: 'Pro Bundle',
      timestampMs: 1700000000000
    });
    assert.equal(res.platforms.meta.eventName, 'Purchase');
    assert.equal(res.platforms.tiktok.eventName, 'CompletePayment');
    assert.equal(res.platforms.ga4.eventName, 'purchase');
    assert.equal(res.platforms.meta.params.value, 49.9);
    assert.equal(res.platforms.meta.params.currency, 'USD');
    assert.equal(res.platforms.meta.options.eventID, res.eventId);
    assert.equal(res.platforms.tiktok.params.event_id, res.eventId);
    assert.equal(res.platforms.ga4.params.event_id, res.eventId);
    assert.ok(res.platforms.ga4.params.transaction_id.startsWith('ord_'));
  });

  it('1.6 maps initiate_checkout to InitiateCheckout (Meta/TikTok) and begin_checkout (GA4)', () => {
    const res = buildCrossPlatformPayloads({ action: 'initiate_checkout', timestampMs: 1700000000000 });
    assert.equal(res.platforms.meta.eventName, 'InitiateCheckout');
    assert.equal(res.platforms.tiktok.eventName, 'InitiateCheckout');
    assert.equal(res.platforms.ga4.eventName, 'begin_checkout');
  });

  it('1.7 maps complete_registration and download accurately', () => {
    const reg = buildCrossPlatformPayloads({ action: 'complete_registration' });
    assert.equal(reg.platforms.meta.eventName, 'CompleteRegistration');
    assert.equal(reg.platforms.tiktok.eventName, 'CompleteRegistration');
    assert.equal(reg.platforms.ga4.eventName, 'sign_up');

    const dl = buildCrossPlatformPayloads({ action: 'download' });
    assert.equal(dl.platforms.meta.eventName, 'Download');
    assert.equal(dl.platforms.tiktok.eventName, 'Download');
    assert.equal(dl.platforms.ga4.eventName, 'file_download');
  });

  it('1.8 throws descriptive error for unsupported business action', () => {
    assert.throws(
      () => buildCrossPlatformPayloads({ action: 'invalid_action_xyz' }),
      /Unsupported business action/
    );
  });
});

describe('2. Deterministic Event ID Generator (generateEventId)', () => {
  it('2.1 is idempotent for identical pageSlug, action, visitorSeed, and time bucket', () => {
    const id1 = generateEventId({
      pageSlug: 'lp-summer',
      action: 'purchase',
      visitorSeed: 'user_42',
      timestampMs: 1700000001000,
      bucketSeconds: 5
    });
    const id2 = generateEventId({
      pageSlug: 'lp-summer',
      action: 'purchase',
      visitorSeed: 'user_42',
      timestampMs: 1700000004900,
      bucketSeconds: 5
    });
    assert.equal(id1, id2);
    assert.match(id1, /^evt_lp-summer_purchase_\d+_[0-9a-f]{16}$/);
  });

  it('2.2 produces distinct event_ids when action or visitorSeed changes', () => {
    const base = { pageSlug: 'lp-1', visitorSeed: 'seed-a', timestampMs: 1700000000000 };
    const leadId = generateEventId({ ...base, action: 'lead' });
    const contactId = generateEventId({ ...base, action: 'contact' });
    const otherUserId = generateEventId({ ...base, action: 'lead', visitorSeed: 'seed-b' });

    assert.notEqual(leadId, contactId);
    assert.notEqual(leadId, otherUserId);
  });

  it('2.3 produces distinct event_ids across different time buckets', () => {
    const t1 = generateEventId({
      pageSlug: 'lp-1',
      action: 'lead',
      visitorSeed: 'seed-a',
      timestampMs: 1700000000000,
      bucketSeconds: 5
    });
    const t2 = generateEventId({
      pageSlug: 'lp-1',
      action: 'lead',
      visitorSeed: 'seed-a',
      timestampMs: 1700000006000,
      bucketSeconds: 5
    });
    assert.notEqual(t1, t2);
  });

  it('2.4 sanitizes special characters in pageSlug and action', () => {
    const id = generateEventId({
      pageSlug: '  US Offer / V2! ',
      action: 'Lead Submit',
      visitorSeed: 'v1',
      timeBucket: 999
    });
    assert.ok(id.startsWith('evt_us-offer-v2_lead-submit_999_'));
  });
});

describe('3. Click Attribution & _fbc Formatter (captureClickIds)', () => {
  it('3.1 extracts fbclid, ttclid, gclid, gbraid, wbraid and formats Meta _fbc', () => {
    const url =
      'https://offer.example.com/sale?fbclid=IwAR998877&ttclid=TT_1122&gclid=GC_3344&gbraid=GB_55&wbraid=WB_66';
    const res = captureClickIds(url, { timestampMs: 1712345678901 });
    assert.equal(res.fbclid, 'IwAR998877');
    assert.equal(res.ttclid, 'TT_1122');
    assert.equal(res.gclid, 'GC_3344');
    assert.equal(res.gbraid, 'GB_55');
    assert.equal(res.wbraid, 'WB_66');
    assert.equal(res.fbc, 'fb.1.1712345678901.IwAR998877');
    assert.equal(res.hasAnyClickId, true);
  });

  it('3.2 extracts UTM parameters and normalizes keys to lowercase', () => {
    const url = 'https://example.com/?utm_source=facebook&utm_medium=cpc&utm_campaign=spring_launch&utm_term=shoes';
    const res = captureClickIds(url);
    assert.deepEqual(res.utm, {
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'spring_launch',
      utm_term: 'shoes'
    });
    assert.equal(res.hasAnyClickId, false);
    assert.equal(res.fbc, null);
  });

  it('3.3 supports raw query strings without protocol or domain', () => {
    const res = captureClickIds('?fbclid=AbCdEfG&utm_source=ig', { timestampMs: 1700000000123 });
    assert.equal(res.fbclid, 'AbCdEfG');
    assert.equal(res.fbc, 'fb.1.1700000000123.AbCdEfG');
    assert.equal(res.utm.utm_source, 'ig');
  });

  it('3.4 handles empty or malformed URLs gracefully without throwing', () => {
    const res = captureClickIds('');
    assert.equal(res.fbclid, null);
    assert.equal(res.fbc, null);
    assert.equal(res.hasAnyClickId, false);
  });
});

describe('4. Payload Static Validator (validatePixelPayload)', () => {
  it('4.1 passes valid Meta Purchase payload with value, currency, and options.eventID', () => {
    const res = validatePixelPayload({
      platform: 'meta',
      eventName: 'Purchase',
      params: { value: 79.0, currency: 'USD' },
      options: { eventID: 'evt_lp_purchase_1' }
    });
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.warnings.length, 0);
  });

  it('4.2 catches event name typo (e.g. init_checkout instead of InitiateCheckout)', () => {
    const res = validatePixelPayload({
      platform: 'meta',
      eventName: 'init_checkout',
      params: {},
      options: { eventID: 'evt_1' }
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'EVENT_NAME_TYPO' && e.message.includes('InitiateCheckout')));
  });

  it('4.3 catches missing value and currency on Purchase / CompletePayment', () => {
    const metaRes = validatePixelPayload({
      platform: 'meta',
      eventName: 'Purchase',
      params: {},
      options: { eventID: 'evt_1' }
    });
    assert.equal(metaRes.valid, false);
    assert.ok(metaRes.errors.some((e) => e.code === 'MISSING_VALUE'));
    assert.ok(metaRes.errors.some((e) => e.code === 'MISSING_CURRENCY'));

    const ttRes = validatePixelPayload({
      platform: 'tiktok',
      eventName: 'CompletePayment',
      params: { event_id: 'evt_1' }
    });
    assert.equal(ttRes.valid, false);
    assert.ok(ttRes.errors.some((e) => e.code === 'MISSING_VALUE'));
    assert.ok(ttRes.errors.some((e) => e.code === 'MISSING_CURRENCY'));
  });

  it('4.4 catches non-ISO currency codes (e.g. "$", "us", "USDT")', () => {
    for (const badCurr of ['$', 'us', 'usd', 'USDT', 'RMB']) {
      const res = validatePixelPayload({
        platform: 'meta',
        eventName: 'Purchase',
        params: { value: 25, currency: badCurr },
        options: { eventID: 'evt_1' }
      });
      assert.equal(res.valid, false, `Expected currency "${badCurr}" to fail validation`);
      assert.ok(res.errors.some((e) => e.code === 'INVALID_CURRENCY_CODE'));
    }
  });

  it('4.5 catches negative or non-numeric value', () => {
    const negRes = validatePixelPayload({
      platform: 'meta',
      eventName: 'Purchase',
      params: { value: -10, currency: 'USD' },
      options: { eventID: 'evt_1' }
    });
    assert.equal(negRes.valid, false);
    assert.ok(negRes.errors.some((e) => e.code === 'NEGATIVE_VALUE'));

    const nanRes = validatePixelPayload({
      platform: 'meta',
      eventName: 'Purchase',
      params: { value: '$49.90', currency: 'USD' },
      options: { eventID: 'evt_1' }
    });
    assert.equal(nanRes.valid, false);
    assert.ok(nanRes.errors.some((e) => e.code === 'INVALID_VALUE_TYPE'));
  });

  it('4.6 catches Meta event_id misplaced inside 3rd params object instead of 4th options argument', () => {
    const res = validatePixelPayload({
      platform: 'meta',
      eventName: 'Lead',
      params: { event_id: 'evt_wrong_place' },
      options: {}
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'META_EVENT_ID_MISPLACED'));
  });

  it('4.7 catches GA4 purchase missing transaction_id', () => {
    const res = validatePixelPayload({
      platform: 'ga4',
      eventName: 'purchase',
      params: { value: 39.9, currency: 'USD', event_id: 'evt_1' }
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'MISSING_TRANSACTION_ID'));
  });

  it('4.8 catches page-level duplicate pixel scripts and unbound CTA buttons', () => {
    const res = validatePixelPayload({
      platform: 'meta',
      eventName: 'PageView',
      params: {},
      options: { eventID: 'evt_1' },
      pageContext: {
        scriptCounts: { 'fbevents.js': 2 },
        unboundButtons: ['Submit Order Now']
      }
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_PIXEL_SCRIPT'));
    assert.ok(res.errors.some((e) => e.code === 'UNBOUND_CTA_BUTTON'));
  });
});

describe('5. HTML Pixel Linter (lintHtmlPixelSetup)', () => {
  it('5.1 detects duplicate fbevents.js and duplicate fbq init calls in broken HTML', () => {
    const brokenHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
        <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
        <script>
          fbq('init', '1234567890');
          fbq('init', '1234567890');
          fbq('track', 'init_checkout', { value: 29.9 });
          fbq('track', 'Purchase', { value: 49.9 });
        </script>
      </head>
      <body>
        <button class="cta-track-required">Buy Now Unbound</button>
      </body>
      </html>
    `;
    const report = lintHtmlPixelSetup(brokenHtml);
    assert.equal(report.valid, false);
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes('DUPLICATE_PIXEL_SCRIPT'));
    assert.ok(codes.includes('DUPLICATE_PIXEL_INIT'));
    assert.ok(codes.includes('EVENT_NAME_TYPO'));
    assert.ok(codes.includes('MISSING_CURRENCY'));
    assert.ok(codes.includes('UNBOUND_CTA_BUTTON'));
  });

  it('5.2 passes clean index.html sandbox with 0 errors', () => {
    const indexHtmlPath = path.resolve(__dirname, '../index.html');
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    const report = lintHtmlPixelSetup(html);
    assert.equal(report.valid, true);
    assert.equal(report.summary.errorCount, 0);
  });
});
