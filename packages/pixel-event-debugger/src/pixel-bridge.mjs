/**
 * Ad Pixel Event Bridge & Debugger Core
 * Zero-dependency utility for cross-platform ad pixel mapping (Meta, TikTok, GA4),
 * deterministic event_id generation, click attribution parsing (_fbc), and static payload/HTML linting.
 */

export const ISO_4217_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'TWD', 'SGD', 'AUD', 'CAD',
  'CHF', 'SEK', 'NZD', 'MXN', 'BRL', 'INR', 'IDR', 'MYR', 'PHP', 'THB',
  'VND', 'KRW', 'AED', 'SAR', 'TRY', 'PLN', 'ZAR', 'NOK', 'DKK', 'ILS',
  'CLP', 'COP', 'PEN', 'ARS', 'EGP', 'NGN', 'PKR', 'BDT', 'CZK', 'HUF',
  'RON', 'BGN', 'HRK', 'RUB', 'UAH', 'KZT', 'QAR', 'KWD', 'BHD', 'OMR'
]);

/**
 * Unified Business Action -> Meta Pixel / TikTok Pixel / GA4 Standard Event Map
 */
export const EVENT_MAP = Object.freeze({
  page_view: {
    action: 'page_view',
    description: 'Initial landing page view',
    meta: {
      eventName: 'PageView',
      requiredParams: [],
      recommendedParams: ['content_name', 'content_category']
    },
    tiktok: {
      eventName: 'ViewContent',
      requiredParams: [],
      recommendedParams: ['content_id', 'content_type', 'content_name']
    },
    ga4: {
      eventName: 'page_view',
      requiredParams: [],
      recommendedParams: ['page_location', 'page_title']
    }
  },
  lead: {
    action: 'lead',
    description: 'Lead form submission or inquiry capture',
    meta: {
      eventName: 'Lead',
      requiredParams: [],
      recommendedParams: ['content_name', 'value', 'currency']
    },
    tiktok: {
      eventName: 'SubmitForm',
      requiredParams: [],
      recommendedParams: ['content_name', 'value', 'currency']
    },
    ga4: {
      eventName: 'generate_lead',
      requiredParams: [],
      recommendedParams: ['value', 'currency', 'lead_source']
    }
  },
  contact: {
    action: 'contact',
    description: 'Click to WhatsApp, Telegram, LINE, phone, or support chat',
    meta: {
      eventName: 'Contact',
      requiredParams: [],
      recommendedParams: ['content_name', 'content_category']
    },
    tiktok: {
      eventName: 'Contact',
      requiredParams: [],
      recommendedParams: ['content_name', 'content_type']
    },
    ga4: {
      eventName: 'contact',
      requiredParams: [],
      recommendedParams: ['method', 'link_url']
    }
  },
  add_to_cart: {
    action: 'add_to_cart',
    description: 'Add item or package to shopping cart',
    meta: {
      eventName: 'AddToCart',
      requiredParams: ['value', 'currency'],
      recommendedParams: ['content_ids', 'content_type', 'contents']
    },
    tiktok: {
      eventName: 'AddToCart',
      requiredParams: ['value', 'currency'],
      recommendedParams: ['content_id', 'content_type', 'quantity']
    },
    ga4: {
      eventName: 'add_to_cart',
      requiredParams: ['value', 'currency'],
      recommendedParams: ['items']
    }
  },
  initiate_checkout: {
    action: 'initiate_checkout',
    description: 'Start checkout or order step',
    meta: {
      eventName: 'InitiateCheckout',
      requiredParams: [],
      recommendedParams: ['value', 'currency', 'num_items', 'content_ids']
    },
    tiktok: {
      eventName: 'InitiateCheckout',
      requiredParams: [],
      recommendedParams: ['value', 'currency', 'content_id', 'quantity']
    },
    ga4: {
      eventName: 'begin_checkout',
      requiredParams: [],
      recommendedParams: ['value', 'currency', 'items']
    }
  },
  purchase: {
    action: 'purchase',
    description: 'Completed order or payment',
    meta: {
      eventName: 'Purchase',
      requiredParams: ['value', 'currency'],
      recommendedParams: ['content_ids', 'content_type', 'num_items']
    },
    tiktok: {
      eventName: 'CompletePayment',
      requiredParams: ['value', 'currency'],
      recommendedParams: ['content_id', 'content_type', 'quantity']
    },
    ga4: {
      eventName: 'purchase',
      requiredParams: ['transaction_id', 'value', 'currency'],
      recommendedParams: ['items']
    }
  },
  complete_registration: {
    action: 'complete_registration',
    description: 'Account sign-up or membership registration completed',
    meta: {
      eventName: 'CompleteRegistration',
      requiredParams: [],
      recommendedParams: ['content_name', 'status', 'value', 'currency']
    },
    tiktok: {
      eventName: 'CompleteRegistration',
      requiredParams: [],
      recommendedParams: ['content_name', 'value', 'currency']
    },
    ga4: {
      eventName: 'sign_up',
      requiredParams: [],
      recommendedParams: ['method']
    }
  },
  download: {
    action: 'download',
    description: 'App APK/IPA, whitepaper, or resource download click',
    meta: {
      eventName: 'Download',
      requiredParams: [],
      recommendedParams: ['content_name', 'content_type']
    },
    tiktok: {
      eventName: 'Download',
      requiredParams: [],
      recommendedParams: ['content_id', 'content_name', 'content_type']
    },
    ga4: {
      eventName: 'file_download',
      requiredParams: [],
      recommendedParams: ['file_name', 'file_extension', 'link_url']
    }
  }
});

/**
 * Common event name misspellings across platforms
 */
export const COMMON_EVENT_TYPOS = Object.freeze({
  meta: {
    init_checkout: 'InitiateCheckout',
    initiatecheckout: 'InitiateCheckout',
    begin_checkout: 'InitiateCheckout',
    pageview: 'PageView',
    page_view: 'PageView',
    add_to_cart: 'AddToCart',
    addtocart: 'AddToCart',
    purchase: 'Purchase',
    complete_payment: 'Purchase',
    completepayment: 'Purchase',
    lead: 'Lead',
    submit_form: 'Lead',
    generate_lead: 'Lead',
    contact: 'Contact',
    completeregistration: 'CompleteRegistration',
    complete_registration: 'CompleteRegistration',
    sign_up: 'CompleteRegistration',
    download: 'Download'
  },
  tiktok: {
    pageview: 'ViewContent',
    page_view: 'ViewContent',
    view_content: 'ViewContent',
    viewcontent: 'ViewContent',
    lead: 'SubmitForm',
    submit_form: 'SubmitForm',
    submitform: 'SubmitForm',
    generate_lead: 'SubmitForm',
    purchase: 'CompletePayment',
    complete_payment: 'CompletePayment',
    completepayment: 'CompletePayment',
    init_checkout: 'InitiateCheckout',
    initiate_checkout: 'InitiateCheckout',
    initiatecheckout: 'InitiateCheckout',
    add_to_cart: 'AddToCart',
    addtocart: 'AddToCart',
    contact: 'Contact',
    complete_registration: 'CompleteRegistration',
    completeregistration: 'CompleteRegistration',
    download: 'Download'
  },
  ga4: {
    PageView: 'page_view',
    pageview: 'page_view',
    Lead: 'generate_lead',
    lead: 'generate_lead',
    SubmitForm: 'generate_lead',
    submit_form: 'generate_lead',
    Purchase: 'purchase',
    CompletePayment: 'purchase',
    complete_payment: 'purchase',
    InitiateCheckout: 'begin_checkout',
    initiate_checkout: 'begin_checkout',
    init_checkout: 'begin_checkout',
    AddToCart: 'add_to_cart',
    Contact: 'contact',
    CompleteRegistration: 'sign_up',
    complete_registration: 'sign_up',
    Download: 'file_download',
    download: 'file_download'
  }
});

/**
 * Fast, deterministic FNV-1a 64-bit hash (implemented via BigInt for zero Node/Browser divergence)
 */
function fnv1a64Hex(input) {
  const str = String(input);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Normalize a slug or action token
 */
function normalizeToken(val, fallback) {
  const cleaned = String(val ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/**
 * Generate a deterministic event_id for Browser Pixel + Server CAPI deduplication.
 *
 * Formula: evt_<pageSlug>_<action>_<timeBucket>_<16charHash>
 *
 * @param {Object} options
 * @param {string} [options.pageSlug='lp-default'] - Landing page identifier
 * @param {string} [options.action='lead'] - Unified action name
 * @param {string} [options.visitorSeed='anon'] - Visitor session seed, clickId, or lead key
 * @param {number|string} [options.timestampMs=Date.now()] - Event timestamp in ms (or explicit bucket)
 * @param {number} [options.bucketSeconds=5] - Deduplication time window in seconds (default 5s)
 * @param {number|string} [options.timeBucket] - Explicit time bucket override
 * @returns {string} Deterministic event_id
 */
export function generateEventId({
  pageSlug = 'lp-default',
  action = 'lead',
  visitorSeed = 'anon',
  timestampMs = Date.now(),
  bucketSeconds = 5,
  timeBucket
} = {}) {
  const slug = normalizeToken(pageSlug, 'lp-default');
  const act = normalizeToken(action, 'event');
  const seed = String(visitorSeed ?? 'anon').trim() || 'anon';
  const windowMs = Math.max(1, Number(bucketSeconds) || 5) * 1000;
  const bucket =
    timeBucket !== undefined && timeBucket !== null
      ? String(timeBucket)
      : String(Math.floor(Number(timestampMs) / windowMs));

  const canonical = `${slug}|${act}|${seed}|${bucket}`;
  const digest = fnv1a64Hex(canonical);
  return `evt_${slug}_${act}_${bucket}_${digest}`;
}

/**
 * Extract ad click attribution IDs (fbclid, ttclid, gclid, gbraid, wbraid) and UTM parameters from URL,
 * and format Meta's `_fbc` cookie value (`fb.1.<timestamp>.<fbclid>`).
 *
 * @param {string|URL} urlInput - Full URL or query string
 * @param {Object} [options]
 * @param {number} [options.timestampMs=Date.now()] - Creation timestamp in ms for _fbc
 * @param {number} [options.subdomainIndex=1] - Subdomain index for _fbc (1 for domain.com)
 * @returns {Object} Extracted click IDs, UTM map, and formatted _fbc / _ttp hints
 */
export function captureClickIds(urlInput, options = {}) {
  const timestampMs = Number(options.timestampMs ?? Date.now());
  const subdomainIndex = Number(options.subdomainIndex ?? 1);

  let searchParams;
  try {
    const raw = String(urlInput ?? '').trim();
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      searchParams = new URL(raw).searchParams;
    } else if (raw.includes('?')) {
      searchParams = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
    } else {
      searchParams = new URLSearchParams(raw);
    }
  } catch {
    searchParams = new URLSearchParams();
  }

  const getClean = (key) => {
    const val = searchParams.get(key);
    return val !== null && val.trim() !== '' ? val.trim() : null;
  };

  const fbclid = getClean('fbclid');
  const ttclid = getClean('ttclid');
  const gclid = getClean('gclid');
  const gbraid = getClean('gbraid');
  const wbraid = getClean('wbraid');

  const utm = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_Content', 'utm_content', 'utm_term', 'utm_id']) {
    const val = getClean(key);
    if (val) {
      utm[key.toLowerCase()] = val;
    }
  }

  const fbc = fbclid ? `fb.${subdomainIndex}.${ timestampMs }.${fbclid}` : null;

  return {
    fbclid,
    ttclid,
    gclid,
    gbraid,
    wbraid,
    fbc,
    utm,
    hasAnyClickId: Boolean(fbclid || ttclid || gclid || gbraid || wbraid)
  };
}

/**
 * Map a unified business action and parameters into standardized Meta, TikTok, and GA4 payloads + snippets.
 *
 * @param {Object} input
 * @param {string} input.action - Unified action key (e.g. 'purchase', 'lead', 'contact')
 * @param {number|string} [input.value] - Monetary value
 * @param {string} [input.currency] - 3-letter ISO currency code
 * @param {string} [input.contentName] - Product or offer name
 * @param {string} [input.contentId] - SKU or offer ID
 * @param {string} [input.transactionId] - Order ID for purchase
 * @param {string} [input.pageSlug='lp-main'] - Page identifier for event_id
 * @param {string} [input.visitorSeed='visitor-1'] - Visitor seed for event_id
 * @param {number} [input.timestampMs=Date.now()] - Timestamp for deterministic event_id
 * @param {string} [input.eventId] - Explicit event_id override
 * @returns {Object} Standardized payloads and code snippets for Meta, TikTok, and GA4
 */
export function buildCrossPlatformPayloads(input = {}) {
  const actionKey = String(input.action ?? '').trim().toLowerCase();
  const mapping = EVENT_MAP[actionKey];
  if (!mapping) {
    const supported = Object.keys(EVENT_MAP).join(', ');
    throw new Error(`Unsupported business action "${input.action}". Supported actions: ${supported}`);
  }

  const timestampMs = Number(input.timestampMs ?? Date.now());
  const eventId =
    input.eventId ||
    generateEventId({
      pageSlug: input.pageSlug || 'lp-main',
      action: actionKey,
      visitorSeed: input.visitorSeed || 'visitor-1',
      timestampMs
    });

  const hasValue = input.value !== undefined && input.value !== null && input.value !== '';
  const numericValue = hasValue ? Number(input.value) : undefined;
  const currency = input.currency ? String(input.currency).trim().toUpperCase() : undefined;
  const contentName = input.contentName ? String(input.contentName).trim() : undefined;
  const contentId = input.contentId ? String(input.contentId).trim() : undefined;
  const transactionId =
    input.transactionId ||
    (actionKey === 'purchase' ? `ord_${eventId.slice(-10)}` : undefined);

  // Meta Payload
  const metaParams = {};
  if (numericValue !== undefined && !Number.isNaN(numericValue)) metaParams.value = numericValue;
  if (currency) metaParams.currency = currency;
  if (contentName) metaParams.content_name = contentName;
  if (contentId) {
    metaParams.content_ids = [contentId];
    metaParams.content_type = 'product';
  }
  const metaOptions = { eventID: eventId };

  // TikTok Payload
  const tiktokParams = { event_id: eventId };
  if (numericValue !== undefined && !Number.isNaN(numericValue)) tiktokParams.value = numericValue;
  if (currency) tiktokParams.currency = currency;
  if (contentName) tiktokParams.content_name = contentName;
  if (contentId) {
    tiktokParams.content_id = contentId;
    tiktokParams.content_type = 'product';
  }

  // GA4 Payload
  const ga4Params = { event_id: eventId };
  if (transactionId) ga4Params.transaction_id = transactionId;
  if (numericValue !== undefined && !Number.isNaN(numericValue)) ga4Params.value = numericValue;
  if (currency) ga4Params.currency = currency;
  if (contentName || contentId) {
    ga4Params.items = [
      {
        item_id: contentId || 'item_default',
        item_name: contentName || 'Landing Page Offer'
      }
    ];
  }

  const metaSnippet = `fbq('track', '${mapping.meta.eventName}', ${JSON.stringify(metaParams)}, ${JSON.stringify(metaOptions)});`;
  const tiktokSnippet = `ttq.track('${mapping.tiktok.eventName}', ${JSON.stringify(tiktokParams)});`;
  const ga4Snippet = `gtag('event', '${mapping.ga4.eventName}', ${JSON.stringify(ga4Params)});`;

  return {
    action: actionKey,
    eventId,
    timestampMs,
    platforms: {
      meta: {
        platform: 'meta',
        eventName: mapping.meta.eventName,
        params: metaParams,
        options: metaOptions,
        snippet: metaSnippet
      },
      tiktok: {
        platform: 'tiktok',
        eventName: mapping.tiktok.eventName,
        params: tiktokParams,
        snippet: tiktokSnippet
      },
      ga4: {
        platform: 'ga4',
        eventName: mapping.ga4.eventName,
        params: ga4Params,
        snippet: ga4Snippet
      }
    }
  };
}

/**
 * Validate a pixel event payload or page context for common tracking bugs.
 *
 * Checks:
 * 1. Event name validity and common typo detection (e.g., `init_checkout` instead of `InitiateCheckout`)
 * 2. Missing required `value` or `currency` on Purchase / AddToCart / CompletePayment
 * 3. Invalid currency format (must be 3-letter uppercase ISO-4217 code, e.g., USD, not $ or us)
 * 4. Negative or NaN `value`
 * 5. Missing `eventID` / `event_id` for deduplication
 * 6. Duplicate pixel SDK or init calls on the same page (`duplicateScriptLoads`)
 * 7. Unbound CTA buttons (`unboundButtons`)
 *
 * @param {Object} input
 * @param {'meta'|'tiktok'|'ga4'} [input.platform='meta'] - Target platform
 * @param {string} input.eventName - Fired event name
 * @param {Object} [input.params={}] - Event parameters object
 * @param {Object} [input.options={}] - Additional options (e.g. Meta `{ eventID }`)
 * @param {Object} [input.pageContext={}] - Optional page-level diagnostics (scriptCounts, unboundButtons)
 * @returns {{ valid: boolean, errors: Array<{code: string, message: string, fix?: string}>, warnings: Array<{code: string, message: string, fix?: string}> }}
 */
export function validatePixelPayload(input = {}) {
  const platform = String(input.platform ?? 'meta').trim().toLowerCase();
  const eventName = String(input.eventName ?? '').trim();
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  const pageContext = input.pageContext && typeof input.pageContext === 'object' ? input.pageContext : {};

  const errors = [];
  const warnings = [];

  if (!['meta', 'tiktok', 'ga4'].includes(platform)) {
    errors.push({
      code: 'UNKNOWN_PLATFORM',
      message: `Unsupported platform "${platform}". Expected meta, tiktok, or ga4.`
    });
    return { valid: false, errors, warnings };
  }

  // Standard event list for platform
  const standardEvents = new Map();
  for (const item of Object.values(EVENT_MAP)) {
    const platSpec = item[platform];
    if (platSpec) {
      standardEvents.set(platSpec.eventName, platSpec);
    }
  }

  if (!eventName) {
    errors.push({
      code: 'MISSING_EVENT_NAME',
      message: `Event name is empty for platform "${platform}".`
    });
  } else if (!standardEvents.has(eventName)) {
    const typoMap = COMMON_EVENT_TYPOS[platform] || {};
    const suggestion = typoMap[eventName] || typoMap[eventName.toLowerCase()];
    if (suggestion) {
      errors.push({
        code: 'EVENT_NAME_TYPO',
        message: `Invalid ${platform.toUpperCase()} event name "${eventName}". Did you mean "${suggestion}"?`,
        fix: `Replace "${eventName}" with standard event "${suggestion}".`
      });
    } else {
      warnings.push({
        code: 'NON_STANDARD_EVENT',
        message: `"${eventName}" is not a standard ${platform.toUpperCase()} event (${Array.from(standardEvents.keys()).join(', ')}). Custom events require manual custom conversion rules.`
      });
    }
  }

  // Determine required params if event matches standard or known typo target
  const typoTarget = (COMMON_EVENT_TYPOS[platform] || {})[eventName] || (COMMON_EVENT_TYPOS[platform] || {})[eventName.toLowerCase()];
  const spec = standardEvents.get(eventName) || (typoTarget ? standardEvents.get(typoTarget) : null);

  const isMonetaryRequired =
    (spec && spec.requiredParams.includes('value')) ||
    ['Purchase', 'CompletePayment', 'purchase', 'AddToCart', 'add_to_cart'].includes(eventName);

  if (isMonetaryRequired) {
    if (params.value === undefined || params.value === null || params.value === '') {
      errors.push({
        code: 'MISSING_VALUE',
        message: `${platform.toUpperCase()} "${eventName}" requires a numeric "value" parameter.`,
        fix: 'Pass a numeric value (e.g. { value: 49.90, currency: "USD" }).'
      });
    }
    if (params.currency === undefined || params.currency === null || params.currency === '') {
      errors.push({
        code: 'MISSING_CURRENCY',
        message: `${platform.toUpperCase()} "${eventName}" requires a 3-letter ISO "currency" parameter.`,
        fix: 'Pass a 3-letter ISO 4217 currency code (e.g. { currency: "USD" }).'
      });
    }
  }

  // Validate value whenever present
  if (params.value !== undefined && params.value !== null && params.value !== '') {
    const num = Number(params.value);
    if (typeof params.value === 'boolean' || Number.isNaN(num) || !Number.isFinite(num)) {
      errors.push({
        code: 'INVALID_VALUE_TYPE',
        message: `Parameter "value" must be a valid number, received "${params.value}".`,
        fix: 'Convert price strings (like "$49.90") to plain numbers (49.9) before firing pixel.'
      });
    } else if (num < 0) {
      errors.push({
        code: 'NEGATIVE_VALUE',
        message: `Parameter "value" cannot be negative (${num}).`
      });
    } else if (typeof params.value === 'string') {
      warnings.push({
        code: 'STRING_VALUE_COERCION',
        message: `Parameter "value" was passed as string "${params.value}". Pass a native Number (${num}) to avoid schema warnings.`
      });
    }
  }

  // Validate currency whenever present
  if (params.currency !== undefined && params.currency !== null && params.currency !== '') {
    const rawCurr = String(params.currency);
    if (!/^[A-Z]{3}$/.test(rawCurr) || !ISO_4217_CURRENCIES.has(rawCurr)) {
      errors.push({
        code: 'INVALID_CURRENCY_CODE',
        message: `Invalid currency "${rawCurr}". Must be an uppercase 3-letter ISO 4217 code (e.g. USD, EUR, GBP).`,
        fix: `Change "${rawCurr}" to a valid 3-letter uppercase ISO currency code like "USD".`
      });
    }
  }

  // GA4 purchase requires transaction_id
  if (platform === 'ga4' && (eventName === 'purchase' || typoTarget === 'purchase')) {
    if (!params.transaction_id || String(params.transaction_id).trim() === '') {
      errors.push({
        code: 'MISSING_TRANSACTION_ID',
        message: 'GA4 "purchase" event requires a unique "transaction_id" to prevent duplicate conversion counting.',
        fix: 'Add transaction_id (e.g. { transaction_id: "ord_12345", value: 49.9, currency: "USD" }).'
      });
    }
  }

  // Deduplication event_id check
  const dedupId =
    platform === 'meta'
      ? options.eventID || options.event_id || params.event_id
      : params.event_id || options.event_id;

  if (!dedupId || String(dedupId).trim() === '') {
    warnings.push({
      code: 'MISSING_EVENT_ID',
      message:
        platform === 'meta'
          ? 'Missing 4th argument { eventID: "..." } in fbq("track", ...). Browser-to-Server CAPI deduplication will not work.'
          : `Missing "event_id" in ${platform.toUpperCase()} payload. Browser and server events cannot be deduplicated.`
    });
  } else if (platform === 'meta' && params.event_id && !options.eventID) {
    errors.push({
      code: 'META_EVENT_ID_MISPLACED',
      message: 'Meta Pixel ignores "event_id" inside the 3rd parameters object. It must be passed in the 4th options argument as { eventID: "..." }.',
      fix: `Use fbq('track', '${eventName || 'Lead'}', params, { eventID: '${params.event_id}' })`
    });
  }

  // Page-level duplicate script loading checks
  if (pageContext.scriptCounts && typeof pageContext.scriptCounts === 'object') {
    for (const [sdkName, count] of Object.entries(pageContext.scriptCounts)) {
      if (Number(count) > 1) {
        errors.push({
          code: 'DUPLICATE_PIXEL_SCRIPT',
          message: `Pixel SDK "${sdkName}" is loaded ${count} times on the same page, causing double event firing.`,
          fix: `Remove duplicate <script> tags or init calls for ${sdkName}.`
        });
      }
    }
  }

  // Page-level unbound CTA button checks
  if (Array.isArray(pageContext.unboundButtons) && pageContext.unboundButtons.length > 0) {
    for (const btnLabel of pageContext.unboundButtons) {
      errors.push({
        code: 'UNBOUND_CTA_BUTTON',
        message: `Conversion CTA button "${btnLabel}" has no pixel tracking hook or click handler attached.`,
        fix: 'Bind a click listener or data-pixel-action attribute to fire Lead/Contact/Purchase before navigation.'
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Static HTML scanner for ad pixel installation bugs:
 * - Duplicate loading of Meta (`fbevents.js` / `fbq('init', ...)`), TikTok (`events.js` / `ttq.load(...)`), or GA4 (`gtag/js`)
 * - Event name typos inside inline `fbq('track', ...)`, `ttq.track(...)`, `gtag('event', ...)` calls
 * - Missing `value` or `currency` in Purchase / CompletePayment calls
 * - Conversion CTA buttons (`data-pixel-expect` or `.cta-track-required`) without tracking bindings
 *
 * @param {string} html - Raw HTML content
 * @returns {{ valid: boolean, summary: Object, issues: Array<{severity: 'error'|'warning', code: string, line: number, message: string, snippet?: string}> }}
 */
export function lintHtmlPixelSetup(html = '') {
  const source = String(html ?? '');
  const lines = source.split(/\r?\n/);
  const issues = [];

  const lineOfOffset = (offset) => {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === '\n') line++;
    }
    return line;
  };

  // Strip <script> bodies when matching external script tags, or inspect all
  const countMatches = (regex) => {
    const matches = [];
    let m;
    while ((m = regex.exec(source)) !== null) {
      matches.push({ index: m.index, text: m[0], groups: m.slice(1) });
    }
    return matches;
  };

  // 1. Check duplicate SDK script inclusions
  const fbeventsScripts = countMatches(/<script[^>]+src=["'][^"']*connect\.facebook\.net\/[^"']*\/fbevents\.js[^"']*["'][^>]*>/gi);
  if (fbeventsScripts.length > 1) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_PIXEL_SCRIPT',
      line: lineOfOffset(fbeventsScripts[1].index),
      message: `Meta Pixel SDK (fbevents.js) is included ${fbeventsScripts.length} times in HTML.`
    });
  }

  const tiktokScripts = countMatches(/<script[^>]+src=["'][^"']*analytics\.tiktok\.com\/i18n\/pixel\/events\.js[^"']*["'][^>]*>/gi);
  if (tiktokScripts.length > 1) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_PIXEL_SCRIPT',
      line: lineOfOffset(tiktokScripts[1].index),
      message: `TikTok Pixel SDK (events.js) is included ${tiktokScripts.length} times in HTML.`
    });
  }

  const gtagScripts = countMatches(/<script[^>]+src=["'][^"']*googletagmanager\.com\/gtag\/js[^"']*["'][^>]*>/gi);
  if (gtagScripts.length > 1) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_PIXEL_SCRIPT',
      line: lineOfOffset(gtagScripts[1].index),
      message: `Google Tag (gtag/js) is included ${gtagScripts.length} times in HTML.`
    });
  }

  // 2. Check duplicate Pixel ID initialization calls
  const fbqInits = countMatches(/fbq\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/g);
  const seenFbIds = new Map();
  for (const item of fbqInits) {
    const id = item.groups[0];
    seenFbIds.set(id, (seenFbIds.get(id) || 0) + 1);
    if (seenFbIds.get(id) > 1) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_PIXEL_INIT',
        line: lineOfOffset(item.index),
        message: `Duplicate fbq('init', '${id}') call detected on the same page.`
      });
    }
  }

  const ttqLoads = countMatches(/ttq\.load\(\s*['"]([^'"]+)['"]/g);
  const seenTtIds = new Map();
  for (const item of ttqLoads) {
    const id = item.groups[0];
    seenTtIds.set(id, (seenTtIds.get(id) || 0) + 1);
    if (seenTtIds.get(id) > 1) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_PIXEL_INIT',
        line: lineOfOffset(item.index),
        message: `Duplicate ttq.load('${id}') call detected on the same page.`
      });
    }
  }

  // Helper to loosely parse inline object literal for static inspection
  const parseLooseObject = (rawObj) => {
    if (!rawObj) return {};
    const out = {};
    const valMatch = rawObj.match(/\bvalue\s*:\s*(['"][^'"]*['"]|-?\d+(?:\.\d+)?)/);
    if (valMatch) {
      const rawVal = valMatch[1];
      out.value = /^['"]/.test(rawVal) ? rawVal.slice(1, -1) : Number(rawVal);
    }
    const currMatch = rawObj.match(/\bcurrency\s*:\s*['"]([^'"]*)['"]/);
    if (currMatch) {
      out.currency = currMatch[1];
    }
    const txMatch = rawObj.match(/\btransaction_id\s*:\s*['"]([^'"]*)['"]/);
    if (txMatch) {
      out.transaction_id = txMatch[1];
    }
    const evtIdMatch = rawObj.match(/\bevent_id\s*:\s*([^,\s}]+)/);
    if (evtIdMatch) {
      out.event_id = evtIdMatch[1].replace(/^['"]|['"]$/g, '');
    }
    const metaEvtIdMatch = rawObj.match(/\beventID\s*:\s*([^,\s}]+)/);
    if (metaEvtIdMatch) {
      out.eventID = metaEvtIdMatch[1].replace(/^['"]|['"]$/g, '');
    }
    return out;
  };

  // 3. Inspect fbq('track', 'EventName', {...}, {...}) calls
  const fbqCalls = countMatches(/fbq\(\s*['"]track['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*(\{[\s\S]*?\}))?(?:\s*,\s*(\{[\s\S]*?\}))?\s*\)/g);
  for (const call of fbqCalls) {
    const eventName = call.groups[0];
    const params = parseLooseObject(call.groups[1]);
    const options = parseLooseObject(call.groups[2]);
    const res = validatePixelPayload({ platform: 'meta', eventName, params, options });
    const line = lineOfOffset(call.index);
    for (const err of res.errors) {
      issues.push({ severity: 'error', code: err.code, line, message: err.message });
    }
    for (const warn of res.warnings) {
      issues.push({ severity: 'warning', code: warn.code, line, message: warn.message });
    }
  }

  // 4. Inspect ttq.track('EventName', {...}) calls
  const ttqCalls = countMatches(/ttq\.track\(\s*['"]([^'"]+)['"](?:\s*,\s*(\{[\s\S]*?\}))?\s*\)/g);
  for (const call of ttqCalls) {
    const eventName = call.groups[0];
    const params = parseLooseObject(call.groups[1]);
    const res = validatePixelPayload({ platform: 'tiktok', eventName, params });
    const line = lineOfOffset(call.index);
    for (const err of res.errors) {
      issues.push({ severity: 'error', code: err.code, line, message: err.message });
    }
    for (const warn of res.warnings) {
      issues.push({ severity: 'warning', code: warn.code, line, message: warn.message });
    }
  }

  // 5. Inspect gtag('event', 'event_name', {...}) calls
  const gtagCalls = countMatches(/gtag\(\s*['"]event['"]\s*,\s*['"]([^'"]+)['"](?:\s*,\s*(\{[\s\S]*?\}))?\s*\)/g);
  for (const call of gtagCalls) {
    const eventName = call.groups[0];
    const params = parseLooseObject(call.groups[1]);
    const res = validatePixelPayload({ platform: 'ga4', eventName, params });
    const line = lineOfOffset(call.index);
    for (const err of res.errors) {
      issues.push({ severity: 'error', code: err.code, line, message: err.message });
    }
    for (const warn of res.warnings) {
      issues.push({ severity: 'warning', code: warn.code, line, message: warn.message });
    }
  }

  // 6. Check for CTA buttons marked as requiring tracking that have neither onclick nor data-pixel-action nor id bound
  const buttonTags = countMatches(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi);
  for (const btn of buttonTags) {
    const attrs = btn.groups[0] || '';
    const innerText = (btn.groups[1] || '').replace(/<[^>]+>/g, '').trim();
    const isMarkedCta = /data-cta-required|class=["'][^"']*cta-track-required[^"']*["']/i.test(attrs);
    const hasBinding = /onclick=|data-pixel-action=|data-action=|id=/i.test(attrs);
    if (isMarkedCta && !hasBinding) {
      issues.push({
        severity: 'error',
        code: 'UNBOUND_CTA_BUTTON',
        line: lineOfOffset(btn.index),
        message: `CTA button "${innerText || 'unnamed'}" is marked as conversion-critical but has no onclick, id, or data-pixel-action binding.`
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    summary: {
      totalLines: lines.length,
      fbqTrackCalls: fbqCalls.length,
      ttqTrackCalls: ttqCalls.length,
      gtagEventCalls: gtagCalls.length,
      errorCount,
      warningCount
    },
    issues
  };
}
