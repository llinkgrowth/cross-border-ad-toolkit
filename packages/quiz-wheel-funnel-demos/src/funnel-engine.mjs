/**
 * Interactive Landing Page Funnel Engine (Quiz / StepFlow + PrizeWheel + WebView Handoff)
 * Zero-dependency pure ES Module for browser sandboxes, edge workers, and Node.js CLI.
 *
 * Implements:
 * 1. `evaluateQuizFunnel`: Multi-step quiz scoring & audience tag routing, WhatsApp pre-filled
 *    answer summary (`[Quiz: SkinType=Dry | Goal=AntiAging]`), and `utm_*` / `fbclid` / `ttclid` pass-through.
 * 2. `spinPrizeWheel` & `validateWheelConfig`: Deterministic/weighted 6–8 sector prize wheel with
 *    exact rotation angle calculation (`360 * minSpins + sectorCenterAngle`), coupon generation,
 *    `localStorage` idempotency lock (prevents refresh-spamming), and pre-launch validation gate.
 * 3. `buildExternalBrowserHandoff`: In-app browser (Facebook `FBAN`/`FBAV`, Instagram, TikTok
 *    `BytedanceWebview`, etc.) detector and Android `intent://` / iOS Safari handoff builder.
 */

export const ATTRIBUTION_KEYS = Object.freeze([
  'fbclid',
  'ttclid',
  'gclid',
  'wbraid',
  'gbraid',
  'msclkid',
  'twclid',
]);

export const WHEEL_STORAGE_PREFIX = 'ipcloak_wheel_lock_';

/**
 * 32-bit FNV-1a deterministic hash
 * @param {string} input
 * @returns {number}
 */
export function fnv1aHash(input) {
  const str = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Default 3-step Skincare & Consultation Quiz Funnel preset
 */
export const DEFAULT_QUIZ_CONFIG = Object.freeze({
  id: 'skincare-diagnostic-v1',
  title: '30-Second Skin Diagnostic & Routine Matcher',
  steps: [
    {
      id: 'q1',
      key: 'SkinType',
      question: 'How does your skin typically feel 2 hours after cleansing?',
      options: [
        { id: 'a', label: 'Tight & flaky (Dry)', value: 'Dry', score: 30, tags: ['high_intent', 'hydration_focus'] },
        { id: 'b', label: 'Shiny all over (Oily)', value: 'Oily', score: 25, tags: ['oil_control'] },
        { id: 'c', label: 'Oily T-zone, dry cheeks (Combo)', value: 'Combo', score: 20, tags: ['balanced_care'] },
        { id: 'd', label: 'Red or easily irritated (Sensitive)', value: 'Sensitive', score: 35, tags: ['high_intent', 'barrier_repair'] },
      ],
    },
    {
      id: 'q2',
      key: 'Goal',
      question: 'What is your #1 skincare goal for the next 30 days?',
      options: [
        { id: 'a', label: 'Firming & fine lines (AntiAging)', value: 'AntiAging', score: 40, tags: ['high_intent', 'premium_tier'] },
        { id: 'b', label: 'Brightening dark spots (Brightening)', value: 'Brightening', score: 30, tags: ['high_intent'] },
        { id: 'c', label: 'Calming redness & barrier (Soothing)', value: 'Soothing', score: 25, tags: ['barrier_repair'] },
        { id: 'd', label: 'Basic daily maintenance (Maintenance)', value: 'Maintenance', score: 10, tags: ['budget_sensitive'] },
      ],
    },
    {
      id: 'q3',
      key: 'Timeline',
      question: 'When are you looking to start your personalized routine?',
      options: [
        { id: 'a', label: 'Immediately — need 1-on-1 specialist advice', value: 'Immediate', score: 40, tags: ['urgent', 'high_intent'] },
        { id: 'b', label: 'Within this week', value: 'ThisWeek', score: 25, tags: ['warm_lead'] },
        { id: 'c', label: 'Just browsing for starter discounts', value: 'Browsing', score: 10, tags: ['budget_sensitive'] },
      ],
    },
  ],
  routes: [
    {
      id: 'route-vip-whatsapp',
      tier: 'vip_concierge',
      label: 'VIP 1-on-1 Senior Esthetician Desk (WhatsApp)',
      minScore: 80,
      requiredTags: ['high_intent'],
      destinationType: 'whatsapp',
      whatsappPhone: '6581009001',
      baseUrl: 'https://wa.me/6581009001',
      greetingPrefix: 'Hi VIP Specialist! Here is my skin diagnostic result:',
    },
    {
      id: 'route-urgent-whatsapp',
      tier: 'priority_support',
      label: 'Priority Fast-Track Specialist (WhatsApp)',
      minScore: 60,
      requiredTags: ['urgent'],
      destinationType: 'whatsapp',
      whatsappPhone: '6581009002',
      baseUrl: 'https://wa.me/6581009002',
      greetingPrefix: 'Hello! I would like to start my routine right away:',
    },
    {
      id: 'route-coupon-checkout',
      tier: 'self_serve_coupon',
      label: 'Standard Starter Kit & Coupon Claim Page',
      minScore: 0,
      requiredTags: [],
      destinationType: 'landing_page',
      baseUrl: 'https://shop.example.com/starter-bundle',
      greetingPrefix: 'Hi team, my quiz profile:',
    },
  ],
});

/**
 * Default 6-sector Promotional Prize Wheel preset
 */
export const DEFAULT_WHEEL_CONFIG = Object.freeze({
  wheelId: 'summer-promo-wheel-v1',
  minSpins: 5,
  sectors: [
    {
      id: 'sec-10off',
      label: '10% OFF Starter Coupon',
      weight: 35,
      isWin: true,
      couponCode: 'WELCOME10',
      ctaUrl: 'https://shop.example.com/claim?tier=10off',
    },
    {
      id: 'sec-15off',
      label: '15% OFF Bundle Voucher',
      weight: 25,
      isWin: true,
      couponCode: 'BUNDLE15',
      ctaUrl: 'https://shop.example.com/claim?tier=15off',
    },
    {
      id: 'sec-freeship',
      label: 'Free Express Shipping',
      weight: 20,
      isWin: true,
      couponCode: 'FREESHIP',
      ctaUrl: 'https://shop.example.com/claim?tier=freeship',
    },
    {
      id: 'sec-gift',
      label: 'Free Travel-Size Gift + WA Consult',
      weight: 12,
      isWin: true,
      couponCode: 'GIFTWA',
      ctaUrl: 'https://wa.me/6581009001?text=Hi%21%20I%20unlocked%20code%20GIFTWA',
    },
    {
      id: 'sec-vip25',
      label: '25% OFF VIP Specialist Pack',
      weight: 5,
      isWin: true,
      couponCode: 'VIP25',
      ctaUrl: 'https://wa.me/6581009001?text=Hi%21%20I%20unlocked%20VIP25',
    },
    {
      id: 'sec-bonus5',
      label: '$5 Instant Store Credit',
      weight: 3,
      isWin: true,
      couponCode: 'CREDIT5',
      ctaUrl: 'https://shop.example.com/claim?tier=credit5',
    },
  ],
});

/**
 * Extract and preserve attribution parameters (`utm_*`, `fbclid`, `ttclid`, `gclid`, etc.)
 * from an incoming URL or query string onto a destination URL.
 *
 * @param {string} targetUrl
 * @param {string|URL|URLSearchParams|Record<string,string>} [incomingUrl]
 * @returns {{ finalUrl: string, preservedParams: Record<string, string> }}
 */
export function preserveFunnelAttribution(targetUrl, incomingUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('targetUrl must be a non-empty string');
  }

  const preservedParams = {};
  if (!incomingUrl) {
    return { finalUrl: targetUrl, preservedParams };
  }

  let searchParams;
  if (incomingUrl instanceof URL) {
    searchParams = incomingUrl.searchParams;
  } else if (incomingUrl instanceof URLSearchParams) {
    searchParams = incomingUrl;
  } else if (typeof incomingUrl === 'string') {
    const trimmed = incomingUrl.trim();
    if (trimmed.includes('://')) {
      try {
        searchParams = new URL(trimmed).searchParams;
      } catch {
        const qIdx = trimmed.indexOf('?');
        searchParams = new URLSearchParams(qIdx >= 0 ? trimmed.slice(qIdx + 1) : '');
      }
    } else {
      searchParams = new URLSearchParams(trimmed.replace(/^\?/, ''));
    }
  } else if (typeof incomingUrl === 'object') {
    searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(incomingUrl)) {
      if (v !== undefined && v !== null && v !== '') {
        searchParams.set(k, String(v));
      }
    }
  }

  if (!searchParams) {
    return { finalUrl: targetUrl, preservedParams };
  }

  const dest = new URL(targetUrl);
  for (const [key, value] of searchParams.entries()) {
    const lower = key.trim().toLowerCase();
    if ((lower.startsWith('utm_') || ATTRIBUTION_KEYS.includes(lower)) && value !== '') {
      preservedParams[key] = value;
      if (!dest.searchParams.has(key)) {
        dest.searchParams.set(key, value);
      }
    }
  }

  return {
    finalUrl: dest.toString(),
    preservedParams,
  };
}

/**
 * Parse compact CLI answer string like `"q1:a,q2:a,q3:b"` into `{ q1: 'a', q2: 'a', q3: 'b' }`.
 * Also accepts an existing object or array.
 *
 * @param {string|Record<string,string>} rawAnswers
 * @returns {Record<string, string>}
 */
export function parseQuizAnswersInput(rawAnswers) {
  if (!rawAnswers) return {};
  if (typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    return { ...rawAnswers };
  }
  if (typeof rawAnswers === 'string') {
    const map = {};
    const pairs = rawAnswers.split(',');
    for (const pair of pairs) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (k && v) {
        map[k] = v;
      }
    }
    return map;
  }
  return {};
}

/**
 * Evaluate a multi-step quiz funnel (`evaluateQuizFunnel`).
 *
 * Computes total score, aggregates audience tags & frequency counts, determines the dominant
 * audience segment, selects the matching route tier, encodes the compact answer summary
 * (e.g., `[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=Immediate]`) into the WhatsApp
 * pre-filled greeting message (`text=...`), and preserves `utm_*` / `fbclid` / `ttclid`.
 *
 * @param {object} quizConfig Quiz funnel configuration (defaults to `DEFAULT_QUIZ_CONFIG`)
 * @param {string|Record<string,string>} answers User selected option IDs per step (`{ q1: 'a', q2: 'a', q3: 'a' }` or `"q1:a,q2:a,q3:a"`)
 * @param {object} [context={}]
 * @param {string|URL|Record<string,string>} [context.incomingUrl] Incoming landing page URL with UTM / click IDs
 * @returns {{
 *   ok: boolean,
 *   quizId?: string,
 *   totalScore?: number,
 *   tags?: Array<string>,
 *   tagCounts?: Record<string, number>,
 *   primaryTag?: string,
 *   answerDetails?: Array<{ stepId: string, key: string, optionId: string, value: string, label: string, score: number, tags: Array<string> }>,
 *   summaryTag?: string,
 *   prefilledMessage?: string,
 *   matchedRoute?: object,
 *   destinationUrl?: string,
 *   preservedAttribution?: Record<string, string>,
 *   error?: string
 * }}
 */
export function evaluateQuizFunnel(quizConfig = DEFAULT_QUIZ_CONFIG, answers = {}, context = {}) {
  const config = quizConfig || DEFAULT_QUIZ_CONFIG;
  if (!config || !Array.isArray(config.steps) || config.steps.length === 0) {
    return { ok: false, error: 'Quiz configuration must contain a non-empty steps array' };
  }

  const answerMap = parseQuizAnswersInput(answers);
  let totalScore = 0;
  const tagCounts = {};
  const tagOrder = [];
  const answerDetails = [];

  for (const step of config.steps) {
    const chosenOptionId = answerMap[step.id] ?? answerMap[step.key];
    if (!chosenOptionId) continue;

    const option = (step.options || []).find(
      (opt) =>
        String(opt.id).toLowerCase() === String(chosenOptionId).toLowerCase() ||
        String(opt.value).toLowerCase() === String(chosenOptionId).toLowerCase()
    );

    if (!option) {
      return {
        ok: false,
        error: `Invalid option "${chosenOptionId}" for step "${step.id}"`,
      };
    }

    const stepScore = Number(option.score) || 0;
    totalScore += stepScore;

    const optTags = Array.isArray(option.tags) ? option.tags : [];
    for (const tag of optTags) {
      if (!tagCounts[tag]) {
        tagCounts[tag] = 0;
        tagOrder.push(tag);
      }
      tagCounts[tag] += 1;
    }

    answerDetails.push({
      stepId: step.id,
      key: step.key || step.id,
      optionId: option.id,
      value: option.value || option.label,
      label: option.label,
      score: stepScore,
      tags: optTags,
    });
  }

  if (answerDetails.length === 0) {
    return { ok: false, error: 'No valid quiz answers provided' };
  }

  // Sort tags by frequency descending, then by first appearance order
  const sortedTags = [...tagOrder].sort((a, b) => {
    if (tagCounts[b] !== tagCounts[a]) return tagCounts[b] - tagCounts[a];
    return tagOrder.indexOf(a) - tagOrder.indexOf(b);
  });
  const primaryTag = sortedTags[0] || 'general';

  // Format compact answer summary: `[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=Immediate]`
  const summaryPairs = answerDetails.map((d) => `${d.key}=${d.value}`);
  const summaryTag = `[Quiz: ${summaryPairs.join(' | ')}]`;

  // Evaluate routing rules in order
  const routes = Array.isArray(config.routes) && config.routes.length > 0
    ? config.routes
    : DEFAULT_QUIZ_CONFIG.routes;

  let matchedRoute = routes[routes.length - 1];
  for (const route of routes) {
    const minScore = typeof route.minScore === 'number' ? route.minScore : 0;
    const reqTags = Array.isArray(route.requiredTags) ? route.requiredTags : [];
    const scoreOk = totalScore >= minScore;
    const tagsOk =
      reqTags.length === 0 || reqTags.every((reqTag) => Boolean(tagCounts[reqTag]));

    if (scoreOk && tagsOk) {
      matchedRoute = route;
      break;
    }
  }

  const greetingPrefix =
    matchedRoute.greetingPrefix || 'Hello! Here is my quiz summary:';
  const prefilledMessage = `${greetingPrefix} ${summaryTag} (Score: ${totalScore}, Segment: ${primaryTag})`;

  // Build destination URL with WhatsApp `text` or landing page `quiz_summary`
  const baseUrlObj = new URL(matchedRoute.baseUrl);
  if (
    matchedRoute.destinationType === 'whatsapp' ||
    baseUrlObj.hostname === 'wa.me' ||
    baseUrlObj.hostname.endsWith('.whatsapp.com')
  ) {
    baseUrlObj.searchParams.set('text', prefilledMessage);
  } else {
    baseUrlObj.searchParams.set('quiz_summary', summaryTag);
    baseUrlObj.searchParams.set('quiz_segment', primaryTag);
    baseUrlObj.searchParams.set('quiz_score', String(totalScore));
  }

  const { finalUrl, preservedParams } = preserveFunnelAttribution(
    baseUrlObj.toString(),
    context.incomingUrl
  );

  return {
    ok: true,
    quizId: config.id || 'quiz-funnel',
    totalScore,
    tags: sortedTags,
    tagCounts,
    primaryTag,
    answerDetails,
    summaryTag,
    prefilledMessage,
    matchedRoute: {
      id: matchedRoute.id,
      tier: matchedRoute.tier,
      label: matchedRoute.label,
      destinationType: matchedRoute.destinationType,
    },
    destinationUrl: finalUrl,
    preservedAttribution: preservedParams,
  };
}

/**
 * Pre-launch gate validator for Prize Wheel configuration (`validateWheelConfig`).
 *
 * Enforces:
 * - 2 to 12 sectors (recommended 6–8)
 * - Total weight > 0 and no negative weights
 * - Every winning/non-empty prize sector (`isWin !== false`) MUST bind a valid `http://` or `https://` CTA URL
 *   and a non-empty `couponCode` before going live.
 *
 * @param {object} wheelConfig
 * @returns {{ ok: boolean, totalWeight: number, sectorCount: number, errors: Array<string> }}
 */
export function validateWheelConfig(wheelConfig) {
  const errors = [];
  if (!wheelConfig || typeof wheelConfig !== 'object') {
    return {
      ok: false,
      totalWeight: 0,
      sectorCount: 0,
      errors: ['Wheel configuration must be an object'],
    };
  }

  const sectors = wheelConfig.sectors;
  if (!Array.isArray(sectors) || sectors.length < 2) {
    return {
      ok: false,
      totalWeight: 0,
      sectorCount: Array.isArray(sectors) ? sectors.length : 0,
      errors: ['Wheel configuration must contain at least 2 sectors'],
    };
  }

  let totalWeight = 0;
  const seenIds = new Set();

  sectors.forEach((sec, idx) => {
    const prefix = `Sector[${idx}] (${sec?.id || 'unnamed'})`;
    if (!sec || typeof sec !== 'object') {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    if (!sec.id || typeof sec.id !== 'string' || !sec.id.trim()) {
      errors.push(`${prefix}: missing valid "id"`);
    } else if (seenIds.has(sec.id)) {
      errors.push(`${prefix}: duplicate sector id "${sec.id}"`);
    } else {
      seenIds.add(sec.id);
    }

    if (!sec.label || typeof sec.label !== 'string' || !sec.label.trim()) {
      errors.push(`${prefix}: missing valid "label"`);
    }

    const weight = Number(sec.weight);
    if (!Number.isFinite(weight) || weight < 0) {
      errors.push(`${prefix}: weight must be a non-negative number`);
    } else {
      totalWeight += weight;
    }

    const isWinningSector = sec.isWin !== false && !sec.isEmpty;
    if (isWinningSector) {
      if (!sec.ctaUrl || typeof sec.ctaUrl !== 'string' || !sec.ctaUrl.trim()) {
        errors.push(`${prefix}: non-empty prize sector must bind a valid "ctaUrl"`);
      } else {
        try {
          const parsed = new URL(sec.ctaUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push(`${prefix}: ctaUrl must use http:// or https:// protocol`);
          }
        } catch {
          errors.push(`${prefix}: ctaUrl "${sec.ctaUrl}" is not a valid URL`);
        }
      }

      if (!sec.couponCode || typeof sec.couponCode !== 'string' || !sec.couponCode.trim()) {
        errors.push(`${prefix}: non-empty prize sector must provide a "couponCode"`);
      }
    }
  });

  if (totalWeight <= 0) {
    errors.push('Total sector weight sum must be greater than 0');
  }

  return {
    ok: errors.length === 0,
    totalWeight,
    sectorCount: sectors.length,
    errors,
  };
}

/**
 * Browser / local deterministic & weighted Prize Wheel spinner (`spinPrizeWheel`).
 *
 * Features:
 * - Validates wheel config via `validateWheelConfig`
 * - Checks `storage` (`localStorage`-compatible interface `{ getItem, setItem }`) first so the
 *   same visitor/device gets an idempotent locked result across page refreshes (`locked: true`)
 * - Picks a sector proportionally by `weight` using either a deterministic `seed` (FNV-1a) or `rng()`
 * - Computes exact rotation angle: `360 * minSpins + sectorCenterAngle`
 * - Preserves incoming `utm_*` / `fbclid` / `ttclid` onto the winning `ctaUrl`
 *
 * @param {object} [wheelConfig=DEFAULT_WHEEL_CONFIG]
 * @param {object} [options={}]
 * @param {string} [options.visitorId] Visitor or session seed for deterministic draw
 * @param {string} [options.seed] Explicit seed string
 * @param {function(): number} [options.rng=Math.random] Custom RNG function
 * @param {object} [options.storage] `localStorage`-like object (`getItem(k)`, `setItem(k, v)`)
 * @param {boolean} [options.forceRespin=false] Bypass existing storage lock if true
 * @param {string|URL|Record<string,string>} [options.incomingUrl] Incoming URL for attribution pass-through
 * @returns {{
 *   ok: boolean,
 *   wheelId?: string,
 *   locked?: boolean,
 *   storageKey?: string,
 *   sectorIndex?: number,
 *   sector?: object,
 *   couponCode?: string,
 *   sectorAngleDeg?: number,
 *   sectorCenterAngle?: number,
 *   rotationDeg?: number,
 *   minSpins?: number,
 *   ctaUrl?: string,
 *   preservedAttribution?: Record<string, string>,
 *   errors?: Array<string>
 * }}
 */
export function spinPrizeWheel(wheelConfig = DEFAULT_WHEEL_CONFIG, options = {}) {
  const config = wheelConfig || DEFAULT_WHEEL_CONFIG;
  const validation = validateWheelConfig(config);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
    };
  }

  const wheelId = String(config.wheelId || 'default-wheel').trim();
  const storageKey = `${WHEEL_STORAGE_PREFIX}${wheelId}`;
  const storage = options.storage || null;

  // 1. Check idempotency lock in storage unless forceRespin is true
  if (storage && typeof storage.getItem === 'function' && !options.forceRespin) {
    try {
      const rawSaved = storage.getItem(storageKey);
      if (rawSaved) {
        const parsed = JSON.parse(rawSaved);
        const savedSectorIdx = config.sectors.findIndex((s) => s.id === parsed.sectorId);
        if (savedSectorIdx !== -1) {
          const savedSector = config.sectors[savedSectorIdx];
          const { finalUrl, preservedParams } = preserveFunnelAttribution(
            savedSector.ctaUrl,
            options.incomingUrl
          );
          return {
            ok: true,
            wheelId,
            locked: true,
            storageKey,
            sectorIndex: savedSectorIdx,
            sector: savedSector,
            couponCode: parsed.couponCode || savedSector.couponCode,
            sectorAngleDeg: parsed.sectorAngleDeg,
            sectorCenterAngle: parsed.sectorCenterAngle,
            rotationDeg: parsed.rotationDeg,
            minSpins: parsed.minSpins,
            ctaUrl: finalUrl,
            preservedAttribution: preservedParams,
          };
        }
      }
    } catch {
      // Corrupted storage entry -> fall through and respin
    }
  }

  // 2. Weighted sector selection
  const sectors = config.sectors;
  const totalWeight = validation.totalWeight;
  let point = 0;

  const seedStr = options.seed ?? options.visitorId;
  if (typeof seedStr === 'string' && seedStr.trim() !== '') {
    const hash = fnv1aHash(`${wheelId}:${seedStr}`);
    point = (hash % 100000) / 100000 * totalWeight;
  } else {
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const r = Math.min(0.999999999, Math.max(0, Number(rng()) || 0));
    point = r * totalWeight;
  }

  let chosenIndex = sectors.length - 1;
  let cumulative = 0;
  for (let i = 0; i < sectors.length; i++) {
    cumulative += Number(sectors[i].weight) || 0;
    if (point < cumulative) {
      chosenIndex = i;
      break;
    }
  }

  const chosenSector = sectors[chosenIndex];
  const minSpins =
    typeof config.minSpins === 'number' && config.minSpins >= 1
      ? Math.floor(config.minSpins)
      : 5;
  const sectorAngleDeg = Number((360 / sectors.length).toFixed(4));
  const sectorCenterAngle = Number(
    (chosenIndex * sectorAngleDeg + sectorAngleDeg / 2).toFixed(2)
  );
  const rotationDeg = Number((360 * minSpins + sectorCenterAngle).toFixed(2));

  const { finalUrl, preservedParams } = preserveFunnelAttribution(
    chosenSector.ctaUrl,
    options.incomingUrl
  );

  // 3. Persist lock to storage
  if (storage && typeof storage.setItem === 'function') {
    try {
      storage.setItem(
        storageKey,
        JSON.stringify({
          wheelId,
          sectorId: chosenSector.id,
          sectorIndex: chosenIndex,
          couponCode: chosenSector.couponCode,
          sectorAngleDeg,
          sectorCenterAngle,
          rotationDeg,
          minSpins,
          lockedAt: '2026-11-25T00:00:00.000Z',
        })
      );
    } catch {
      // Ignore quota errors
    }
  }

  return {
    ok: true,
    wheelId,
    locked: false,
    storageKey,
    sectorIndex: chosenIndex,
    sector: chosenSector,
    couponCode: chosenSector.couponCode,
    sectorAngleDeg,
    sectorCenterAngle,
    rotationDeg,
    minSpins,
    ctaUrl: finalUrl,
    preservedAttribution: preservedParams,
  };
}

/**
 * Detect mobile In-App WebViews (Facebook, Instagram, TikTok, Line, WeChat, Snapchat)
 * and construct an external system browser handoff strategy (`buildExternalBrowserHandoff`).
 *
 * Why needed:
 * Calling `https://wa.me/...` or custom schemes inside Facebook (`FBAN`/`FBAV`), Instagram,
 * or TikTok (`BytedanceWebview`/`musical_ly`) In-App WebViews frequently fails or gets trapped
 * in a blank WebView tab.
 * - On Android In-App WebViews: constructs an `intent://<host><path>#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=...;end`
 *   URI to pop out to Chrome / system default browser.
 * - On iOS In-App WebViews: returns `action: "show_ios_safari_guide"` with step-by-step UI overlay metadata
 *   prompting the user to tap the top-right `•••` menu and choose "Open in External Browser / Safari".
 *
 * @param {string} userAgent Browser `navigator.userAgent` string
 * @param {string} targetUrl Destination URL (e.g. `https://wa.me/6581009001?text=...`)
 * @param {string|URL|Record<string,string>} [incomingUrl] Optional incoming URL for attribution preservation
 * @returns {{
 *   ok: boolean,
 *   isInAppWebView: boolean,
 *   appName: string,
 *   os: 'android' | 'ios' | 'other',
 *   action: 'direct_redirect' | 'android_intent_wakeup' | 'show_ios_safari_guide',
 *   targetUrl: string,
 *   androidIntentUrl: string | null,
 *   iosGuideText: string | null,
 *   error?: string
 * }}
 */
export function buildExternalBrowserHandoff(userAgent, targetUrl, incomingUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return { ok: false, error: 'targetUrl is required' };
  }

  const { finalUrl } = preserveFunnelAttribution(targetUrl, incomingUrl);
  const ua = String(userAgent || '');

  // Detect OS
  let os = 'other';
  if (/android/i.test(ua)) {
    os = 'android';
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = 'ios';
  }

  // Detect specific In-App WebView containers
  let appName = 'standard_browser';
  let isInAppWebView = false;

  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(ua)) {
    appName = 'facebook';
    isInAppWebView = true;
  } else if (/Instagram/i.test(ua)) {
    appName = 'instagram';
    isInAppWebView = true;
  } else if (/BytedanceWebview|musical_ly|TikTok|aweme/i.test(ua)) {
    appName = 'tiktok';
    isInAppWebView = true;
  } else if (/\bLine\//i.test(ua)) {
    appName = 'line';
    isInAppWebView = true;
  } else if (/MicroMessenger/i.test(ua)) {
    appName = 'wechat';
    isInAppWebView = true;
  } else if (/Snapchat/i.test(ua)) {
    appName = 'snapchat';
    isInAppWebView = true;
  }

  if (!isInAppWebView) {
    return {
      ok: true,
      isInAppWebView: false,
      appName,
      os,
      action: 'direct_redirect',
      targetUrl: finalUrl,
      androidIntentUrl: null,
      iosGuideText: null,
    };
  }

  const parsedTarget = new URL(finalUrl);
  const hostAndPath = `${parsedTarget.host}${parsedTarget.pathname}${parsedTarget.search}${parsedTarget.hash}`;
  const scheme = parsedTarget.protocol.replace(':', '') || 'https';

  if (os === 'android') {
    const encodedFallback = encodeURIComponent(finalUrl);
    const androidIntentUrl =
      `intent://${hostAndPath}#Intent;scheme=${scheme};` +
      `action=android.intent.action.VIEW;` +
      `S.browser_fallback_url=${encodedFallback};end`;

    return {
      ok: true,
      isInAppWebView: true,
      appName,
      os,
      action: 'android_intent_wakeup',
      targetUrl: finalUrl,
      androidIntentUrl,
      iosGuideText: null,
    };
  }

  // iOS or other In-App WebView -> show top-right Safari breakout guide
  return {
    ok: true,
    isInAppWebView: true,
    appName,
    os,
    action: 'show_ios_safari_guide',
    targetUrl: finalUrl,
    androidIntentUrl: null,
    iosGuideText:
      'Tap the [•••] icon in the top-right corner and select "Open in External Browser / Safari" to launch WhatsApp smoothly.',
  };
}
