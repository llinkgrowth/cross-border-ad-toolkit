/**
 * Shortlink Multi-Target Rotator Core (Zero-Dependency Pure ES Module)
 *
 * Implements:
 * 1. Four distribution strategies: random, weighted (FNV-1a deterministic hash or RNG), round_robin, quota
 * 2. Sticky session cookie parsing & generation (`lf_d_<slug>=<targetId>`, 1-year TTL)
 * 3. Social messenger Deeplink builder (WhatsApp / Telegram / LINE / Viber / Zalo)
 * 4. Attribution parameter pass-through (`utm_*`, `fbclid`, `ttclid`, `gclid`, etc.)
 */

export const SUPPORTED_MODES = Object.freeze([
  'random',
  'weighted',
  'round_robin',
  'quota',
]);

export const SUPPORTED_PLATFORMS = Object.freeze([
  'whatsapp',
  'telegram',
  'line',
  'viber',
  'zalo',
]);

export const DEFAULT_ATTRIBUTION_KEYS = Object.freeze([
  'fbclid',
  'ttclid',
  'gclid',
  'wbraid',
  'gbraid',
  'msclkid',
  'twclid',
  'li_fat_id',
  'sccid',
]);

export const STICKY_COOKIE_PREFIX = 'lf_d_';
export const STICKY_MAX_AGE_SECONDS = 31536000; // 365 days

/**
 * 32-bit FNV-1a deterministic hash
 * @param {string} input
 * @returns {number} Unsigned 32-bit integer
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
 * Filter active targets from route configuration.
 * A target is considered active when `enabled !== false` and `online !== false` and it has an `id` and `url`.
 * @param {Array<object>} targets
 * @returns {Array<object>}
 */
export function getActiveTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    (t) =>
      t &&
      typeof t === 'object' &&
      typeof t.id === 'string' &&
      t.id.trim() !== '' &&
      typeof t.url === 'string' &&
      t.url.trim() !== '' &&
      t.enabled !== false &&
      t.online !== false
  );
}

/**
 * Parse HTTP `Cookie` header into key-value map and extract sticky target for a slug.
 * Cookie name convention: `lf_d_<slug>=<targetId>`
 * @param {string} cookieHeader
 * @param {string} slug
 * @returns {string|null} targetId or null
 */
export function parseStickyCookie(cookieHeader, slug) {
  if (!cookieHeader || typeof cookieHeader !== 'string' || !slug) {
    return null;
  }
  const cookieName = `${STICKY_COOKIE_PREFIX}${slug}`;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = pair.slice(0, eqIdx).trim();
    if (rawKey !== cookieName) continue;
    const rawVal = pair.slice(eqIdx + 1).trim();
    if (!rawVal) return null;
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return rawVal;
    }
  }
  return null;
}

/**
 * Format `Set-Cookie` header value for sticky target binding (1-year TTL).
 * @param {string} slug
 * @param {string} targetId
 * @param {object} [options]
 * @param {number} [options.maxAge=31536000]
 * @param {string} [options.path='/']
 * @param {boolean} [options.secure=true]
 * @param {string} [options.sameSite='Lax']
 * @returns {string}
 */
export function formatStickyCookie(slug, targetId, options = {}) {
  if (!slug || !targetId) {
    throw new Error('slug and targetId are required to format sticky cookie');
  }
  const maxAge =
    typeof options.maxAge === 'number' && Number.isFinite(options.maxAge)
      ? Math.max(0, Math.floor(options.maxAge))
      : STICKY_MAX_AGE_SECONDS;
  const path = options.path || '/';
  const sameSite = options.sameSite || 'Lax';
  const secure = options.secure !== false;

  const parts = [
    `${STICKY_COOKIE_PREFIX}${slug}=${encodeURIComponent(String(targetId))}`,
    `Max-Age=${maxAge}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push('Secure');
  if (options.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * Select target using `random` strategy.
 * @param {Array<object>} activeTargets
 * @param {function(): number} [rng=Math.random]
 * @returns {{ target: object, reason: string }}
 */
export function selectRandomTarget(activeTargets, rng = Math.random) {
  const r = Math.min(0.999999999, Math.max(0, Number(rng()) || 0));
  const index = Math.floor(r * activeTargets.length);
  return {
    target: activeTargets[index],
    reason: 'random_selection',
  };
}

/**
 * Select target using `weighted` strategy.
 * If `hashKey` is provided, uses 32-bit FNV-1a deterministic hash bucket `hash(hashKey) % totalWeight`.
 * Otherwise uses `rng() * totalWeight`.
 * @param {Array<object>} activeTargets
 * @param {object} [options]
 * @param {string} [options.hashKey]
 * @param {function(): number} [options.rng=Math.random]
 * @returns {{ target: object, reason: string, bucket: number, totalWeight: number }}
 */
export function selectWeightedTarget(activeTargets, options = {}) {
  const weights = activeTargets.map((t) => {
    const w = Number(t.weight);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  if (totalWeight <= 0) {
    return {
      target: activeTargets[0],
      reason: 'weighted_zero_fallback',
      bucket: 0,
      totalWeight: 0,
    };
  }

  let point = 0;
  let reason = 'weighted_rng';
  if (typeof options.hashKey === 'string' && options.hashKey.trim() !== '') {
    const hash = fnv1aHash(options.hashKey);
    point = hash % totalWeight;
    reason = 'weighted_fnv1a_hash';
  } else {
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const r = Math.min(0.999999999, Math.max(0, Number(rng()) || 0));
    point = r * totalWeight;
  }

  let cumulative = 0;
  for (let i = 0; i < activeTargets.length; i++) {
    cumulative += weights[i];
    if (point < cumulative) {
      return {
        target: activeTargets[i],
        reason,
        bucket: point,
        totalWeight,
      };
    }
  }

  return {
    target: activeTargets[activeTargets.length - 1],
    reason,
    bucket: point,
    totalWeight,
  };
}

/**
 * Select target using `round_robin` strategy.
 * @param {Array<object>} activeTargets
 * @param {number} [counter=0]
 * @returns {{ target: object, reason: string, nextCounter: number, index: number }}
 */
export function selectRoundRobinTarget(activeTargets, counter = 0) {
  const safeCounter =
    typeof counter === 'number' && Number.isFinite(counter) && counter >= 0
      ? Math.floor(counter)
      : 0;
  const index = safeCounter % activeTargets.length;
  return {
    target: activeTargets[index],
    reason: 'round_robin_cycle',
    index,
    nextCounter: safeCounter + 1,
  };
}

/**
 * Select target using `quota` strategy.
 * Picks the active target that still has remaining daily capacity (`clicksToday < daily_limit` or `daily_limit <= 0`/unlimited)
 * and has the fewest clicks today (`clicksToday` ascending).
 * If all targets have exhausted their daily quota, falls back to the first active target (or configured fallback target).
 *
 * @param {Array<object>} activeTargets
 * @param {Record<string, number>} [quotaUsage={}] Map of targetId -> clicks today
 * @returns {{ target: object, reason: string, quotaExhausted: boolean }}
 */
export function selectQuotaTarget(activeTargets, quotaUsage = {}) {
  const usageMap = quotaUsage && typeof quotaUsage === 'object' ? quotaUsage : {};

  const available = [];
  for (let i = 0; i < activeTargets.length; i++) {
    const target = activeTargets[i];
    const usedFromMap = Number(usageMap[target.id]);
    const usedFromTarget = Number(target.today_clicks ?? target.clicksToday ?? 0);
    const used = Number.isFinite(usedFromMap)
      ? Math.max(0, usedFromMap)
      : Number.isFinite(usedFromTarget)
        ? Math.max(0, usedFromTarget)
        : 0;

    const rawLimit = target.daily_limit ?? target.dailyLimit;
    const hasLimit =
      rawLimit !== undefined &&
      rawLimit !== null &&
      Number.isFinite(Number(rawLimit)) &&
      Number(rawLimit) >= 0;
    const limit = hasLimit ? Number(rawLimit) : Infinity;

    if (used < limit) {
      available.push({ target, used, limit, order: i });
    }
  }

  if (available.length > 0) {
    // Sort by lowest clicks today first; tie-break by original declaration order
    available.sort((a, b) => {
      if (a.used !== b.used) return a.used - b.used;
      return a.order - b.order;
    });
    return {
      target: available[0].target,
      reason: 'quota_least_used_available',
      quotaExhausted: false,
    };
  }

  // All targets reached daily_limit -> fall back to first active target
  return {
    target: activeTargets[0],
    reason: 'quota_exhausted_fallback_first',
    quotaExhausted: true,
  };
}

/**
 * Build a standardized social messenger deeplink URL.
 * Supports:
 * - `whatsapp`: `https://wa.me/<cc><phone>?text=<encoded>`
 * - `telegram`: `https://t.me/<handle_or_+phone>?text=<encoded>`
 * - `line`: `https://line.me/R/oaMessage/@<id>/?<encoded>` or `https://line.me/ti/p/~<id>`
 * - `viber`: `viber://chat?number=%2B<cc><phone>&draft=<encoded>`
 * - `zalo`: `https://zalo.me/<cc><phone>` (with optional `?text=<encoded>`)
 *
 * @param {object} input
 * @param {string} input.type Platform type: whatsapp | telegram | line | viber | zalo
 * @param {string} [input.countryCode=''] Optional country calling code (e.g., '86', '+1')
 * @param {string} [input.phone=''] Phone number or account handle/ID
 * @param {string} [input.account=''] Alias for handle/ID (Telegram username, LINE ID)
 * @param {string} [input.text=''] Pre-filled welcome message template
 * @param {Record<string, string>} [input.variables={}] Template variables e.g. `{ name: 'Leo', code: 'VIP' }` for `{{name}}`
 * @returns {{ ok: boolean, url?: string, platform?: string, error?: string }}
 */
export function buildSocialDeeplink(input = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Input must be an object' };
  }

  const platform = String(input.type || input.platform || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return {
      ok: false,
      error: `Unsupported platform "${platform}". Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
    };
  }

  const rawCountry = String(input.countryCode ?? '').replace(/[^\d]/g, '');
  const rawPhoneInput = String(input.phone ?? input.account ?? '').trim();

  // Render template variables if any `{{var}}` placeholders exist
  let message = String(input.text ?? input.message ?? '');
  if (message && input.variables && typeof input.variables === 'object') {
    message = message.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
      const val = input.variables[key];
      return val !== undefined && val !== null ? String(val) : '';
    });
  }

  if (platform === 'whatsapp') {
    const digitsPhone = rawPhoneInput.replace(/[^\d]/g, '');
    const fullNumber =
      rawCountry && !digitsPhone.startsWith(rawCountry)
        ? `${rawCountry}${digitsPhone}`
        : digitsPhone;
    if (!fullNumber) {
      return { ok: false, error: 'WhatsApp requires a valid phone number' };
    }
    const base = `https://wa.me/${fullNumber}`;
    if (!message) {
      return { ok: true, platform, url: base };
    }
    return {
      ok: true,
      platform,
      url: `${base}?text=${encodeURIComponent(message)}`,
    };
  }

  if (platform === 'telegram') {
    const cleaned = rawPhoneInput.replace(/^@/, '').trim();
    if (!cleaned && !rawCountry) {
      return {
        ok: false,
        error: 'Telegram requires a username or phone number',
      };
    }
    // Check if phone number vs username
    const isPhone = /^\+?\d+$/.test(cleaned);
    let targetPath = cleaned;
    if (isPhone) {
      const digits = cleaned.replace(/[^\d]/g, '');
      const full =
        rawCountry && !digits.startsWith(rawCountry)
          ? `${rawCountry}${digits}`
          : digits;
      targetPath = `+${full}`;
    }
    const base = `https://t.me/${targetPath}`;
    if (!message) {
      return { ok: true, platform, url: base };
    }
    return {
      ok: true,
      platform,
      url: `${base}?text=${encodeURIComponent(message)}`,
    };
  }

  if (platform === 'line') {
    const lineId = rawPhoneInput.replace(/^@/, '').trim();
    if (!lineId) {
      return { ok: false, error: 'LINE requires a LINE ID or Official Account ID' };
    }
    if (message) {
      return {
        ok: true,
        platform,
        url: `https://line.me/R/oaMessage/@${encodeURIComponent(lineId)}/?${encodeURIComponent(message)}`,
      };
    }
    return {
      ok: true,
      platform,
      url: `https://line.me/ti/p/~${encodeURIComponent(lineId)}`,
    };
  }

  if (platform === 'viber') {
    const digitsPhone = rawPhoneInput.replace(/[^\d]/g, '');
    const fullNumber =
      rawCountry && !digitsPhone.startsWith(rawCountry)
        ? `${rawCountry}${digitsPhone}`
        : digitsPhone;
    if (!fullNumber) {
      return { ok: false, error: 'Viber requires a valid phone number' };
    }
    const base = `viber://chat?number=%2B${fullNumber}`;
    if (!message) {
      return { ok: true, platform, url: base };
    }
    return {
      ok: true,
      platform,
      url: `${base}&draft=${encodeURIComponent(message)}`,
    };
  }

  if (platform === 'zalo') {
    const digitsPhone = rawPhoneInput.replace(/[^\d]/g, '');
    const fullNumber =
      rawCountry && !digitsPhone.startsWith(rawCountry)
        ? `${rawCountry}${digitsPhone}`
        : digitsPhone;
    const identifier = fullNumber || rawPhoneInput;
    if (!identifier) {
      return { ok: false, error: 'Zalo requires a phone number or Zalo ID' };
    }
    const base = `https://zalo.me/${encodeURIComponent(identifier)}`;
    if (!message) {
      return { ok: true, platform, url: base };
    }
    return {
      ok: true,
      platform,
      url: `${base}?text=${encodeURIComponent(message)}`,
    };
  }

  return { ok: false, error: 'Unhandled platform' };
}

/**
 * Check whether a query parameter key is an attribution / tracking parameter
 * that should be preserved across shortlink redirects.
 * Matches `utm_*`, `fbclid`, `ttclid`, `gclid`, and custom allowlisted keys.
 *
 * @param {string} key
 * @param {Array<string>} [extraKeys=[]]
 * @returns {boolean}
 */
export function isAttributionParam(key, extraKeys = []) {
  if (!key || typeof key !== 'string') return false;
  const lower = key.trim().toLowerCase();
  if (lower.startsWith('utm_')) return true;
  if (DEFAULT_ATTRIBUTION_KEYS.includes(lower)) return true;
  if (Array.isArray(extraKeys) && extraKeys.some((k) => String(k).toLowerCase() === lower)) {
    return true;
  }
  return false;
}

/**
 * Losslessly preserve attribution parameters (`utm_*`, `fbclid`, `ttclid`, `gclid`, etc.)
 * from the incoming request URL or query object onto the resolved destination URL.
 *
 * By default, existing query parameters already explicitly set on the target URL are preserved
 * unless `overrideExisting: true` is passed.
 *
 * @param {string} targetUrl Destination URL
 * @param {string|URL|URLSearchParams|Record<string, string>} incomingSource Incoming URL, query string, or params object
 * @param {object} [options]
 * @param {boolean} [options.overrideExisting=false]
 * @param {Array<string>} [options.extraKeys=[]]
 * @returns {string} Final URL with attribution parameters attached
 */
export function preserveAttributionParams(targetUrl, incomingSource, options = {}) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('targetUrl must be a non-empty string');
  }

  let incomingParams;
  if (!incomingSource) {
    return targetUrl;
  } else if (incomingSource instanceof URL) {
    incomingParams = incomingSource.searchParams;
  } else if (incomingSource instanceof URLSearchParams) {
    incomingParams = incomingSource;
  } else if (typeof incomingSource === 'string') {
    const trimmed = incomingSource.trim();
    if (trimmed.includes('://') || trimmed.startsWith('http')) {
      try {
        incomingParams = new URL(trimmed).searchParams;
      } catch {
        const qIdx = trimmed.indexOf('?');
        incomingParams = new URLSearchParams(qIdx >= 0 ? trimmed.slice(qIdx + 1) : '');
      }
    } else {
      const q = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
      incomingParams = new URLSearchParams(q);
    }
  } else if (typeof incomingSource === 'object') {
    incomingParams = new URLSearchParams();
    for (const [k, v] of Object.entries(incomingSource)) {
      if (v !== undefined && v !== null && v !== '') {
        incomingParams.set(k, String(v));
      }
    }
  } else {
    return targetUrl;
  }

  const extraKeys = Array.isArray(options.extraKeys) ? options.extraKeys : [];
  const overrideExisting = Boolean(options.overrideExisting);

  // Filter only attribution entries
  const entriesToCopy = [];
  for (const [key, value] of incomingParams.entries()) {
    if (isAttributionParam(key, extraKeys) && value !== '') {
      entriesToCopy.push([key, value]);
    }
  }

  if (entriesToCopy.length === 0) {
    return targetUrl;
  }

  const destUrl = new URL(targetUrl);
  for (const [key, value] of entriesToCopy) {
    if (overrideExisting || !destUrl.searchParams.has(key)) {
      destUrl.searchParams.set(key, value);
    }
  }

  return destUrl.toString();
}

/**
 * Main pure routing decision engine (`resolveRoute`).
 *
 * Evaluates sticky session cookies first (if `route.sticky !== false`), verifies the pinned target
 * is still online and within daily quota (if in quota mode), or recalculates a new target using
 * one of the 4 distribution modes (`random`, `weighted`, `round_robin`, `quota`), preserves incoming
 * attribution parameters, and emits the updated state and Set-Cookie header.
 *
 * @param {object} route Route configuration object (`{ slug, mode, sticky, targets }`)
 * @param {object} [context={}] Request & runtime state context
 * @param {string} [context.visitorId] Visitor identifier (for deterministic weighted hashing)
 * @param {string} [context.cookieHeader] Incoming HTTP `Cookie` header
 * @param {string|URL|URLSearchParams|Record<string,string>} [context.incomingUrl] Incoming request URL or query params
 * @param {number} [context.roundRobinCounter=0] Current counter for `round_robin` mode
 * @param {Record<string, number>} [context.quotaUsage={}] Current daily click counts per target ID
 * @param {function(): number} [context.rng=Math.random] Custom random number generator (for deterministic tests)
 * @returns {{
 *   ok: boolean,
 *   slug?: string,
 *   mode?: string,
 *   target?: object,
 *   destinationUrl?: string,
 *   reason?: string,
 *   stickyHit?: boolean,
 *   stickyRecalculated?: boolean,
 *   quotaExhausted?: boolean,
 *   setCookie?: string|null,
 *   nextState?: { roundRobinCounter: number, quotaUsage: Record<string, number> },
 *   error?: string
 * }}
 */
export function resolveRoute(route, context = {}) {
  if (!route || typeof route !== 'object') {
    return { ok: false, error: 'Route configuration must be an object' };
  }

  const slug = String(route.slug || 'default').trim();
  const mode = String(route.mode || 'random')
    .trim()
    .toLowerCase();

  if (!SUPPORTED_MODES.includes(mode)) {
    return {
      ok: false,
      slug,
      error: `Unsupported routing mode "${mode}". Supported modes: ${SUPPORTED_MODES.join(', ')}`,
    };
  }

  const activeTargets = getActiveTargets(route.targets);
  if (activeTargets.length === 0) {
    return {
      ok: false,
      slug,
      mode,
      error: 'No active targets available in route configuration',
    };
  }

  const stickyEnabled = route.sticky !== false;
  const currentCounter =
    typeof context.roundRobinCounter === 'number' && Number.isFinite(context.roundRobinCounter)
      ? Math.max(0, Math.floor(context.roundRobinCounter))
      : 0;
  const currentQuotaUsage = {
    ...(context.quotaUsage && typeof context.quotaUsage === 'object' ? context.quotaUsage : {}),
  };

  let chosenTarget = null;
  let reason = '';
  let stickyHit = false;
  let stickyRecalculated = false;
  let quotaExhausted = false;
  let nextCounter = currentCounter;

  // 1. Check Sticky Cookie if enabled
  if (stickyEnabled && context.cookieHeader) {
    const stickyTargetId = parseStickyCookie(context.cookieHeader, slug);
    if (stickyTargetId) {
      const matched = activeTargets.find((t) => t.id === stickyTargetId);
      if (matched) {
        chosenTarget = matched;
        reason = 'sticky_cookie_hit';
        stickyHit = true;
      } else {
        // Target went offline or was removed from active targets -> recalculate
        stickyRecalculated = true;
      }
    }
  }

  // 2. If not resolved via sticky session, run distribution mode algorithm
  if (!chosenTarget) {
    if (mode === 'random') {
      const res = selectRandomTarget(activeTargets, context.rng);
      chosenTarget = res.target;
      reason = stickyRecalculated ? 'sticky_offline_recalc_random' : res.reason;
    } else if (mode === 'weighted') {
      const hashKey =
        context.visitorId !== undefined && context.visitorId !== null && String(context.visitorId) !== ''
          ? `${slug}:${context.visitorId}`
          : undefined;
      const res = selectWeightedTarget(activeTargets, {
        hashKey,
        rng: context.rng,
      });
      chosenTarget = res.target;
      reason = stickyRecalculated ? `sticky_offline_recalc_${res.reason}` : res.reason;
    } else if (mode === 'round_robin') {
      const res = selectRoundRobinTarget(activeTargets, currentCounter);
      chosenTarget = res.target;
      nextCounter = res.nextCounter;
      reason = stickyRecalculated ? 'sticky_offline_recalc_round_robin' : res.reason;
    } else if (mode === 'quota') {
      const res = selectQuotaTarget(activeTargets, currentQuotaUsage);
      chosenTarget = res.target;
      quotaExhausted = res.quotaExhausted;
      reason = stickyRecalculated ? `sticky_offline_recalc_${res.reason}` : res.reason;
    }
  }

  // 3. Update quota counter for the selected target
  const prevClicks = Number(currentQuotaUsage[chosenTarget.id] ?? chosenTarget.today_clicks ?? 0);
  currentQuotaUsage[chosenTarget.id] = (Number.isFinite(prevClicks) ? prevClicks : 0) + 1;

  // 4. Preserve incoming attribution parameters (utm_*, fbclid, ttclid, gclid)
  const destinationUrl = preserveAttributionParams(
    chosenTarget.url,
    context.incomingUrl,
    context.attributionOptions
  );

  // 5. Generate Set-Cookie header if sticky is enabled
  const setCookie = stickyEnabled
    ? formatStickyCookie(slug, chosenTarget.id, route.cookieOptions)
    : null;

  return {
    ok: true,
    slug,
    mode,
    target: chosenTarget,
    destinationUrl,
    reason,
    stickyHit,
    stickyRecalculated,
    quotaExhausted,
    setCookie,
    nextState: {
      roundRobinCounter: nextCounter,
      quotaUsage: currentQuotaUsage,
    },
  };
}
