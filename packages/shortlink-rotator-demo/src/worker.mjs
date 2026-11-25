/**
 * Cloudflare Worker Edge 302 Shortlink Rotator Demo
 *
 * - Evaluates multi-target routing in <1ms on the edge (`random`, `weighted`, `round_robin`, `quota`)
 * - Maintains sticky visitor-to-agent assignment via `lf_d_<slug>` HTTP cookie
 * - Preserves `utm_*`, `fbclid`, `ttclid`, `gclid` attribution parameters losslessly
 * - Uses `ctx.waitUntil(...)` for non-blocking asynchronous click telemetry & counter updates
 */

import { resolveRoute } from './router.mjs';

const FALLBACK_ROUTES = {
  'wa-vip': {
    slug: 'wa-vip',
    mode: 'weighted',
    sticky: true,
    targets: [
      { id: 'agent-alice', url: 'https://wa.me/6581001001?text=Hi%20Alice', weight: 50, daily_limit: 500, enabled: true },
      { id: 'agent-bryan', url: 'https://wa.me/60123002002?text=Hi%20Bryan', weight: 30, daily_limit: 300, enabled: true },
      { id: 'agent-chloe', url: 'https://wa.me/6581001003?text=Hi%20Chloe', weight: 20, daily_limit: 200, enabled: true },
    ],
  },
};

const memoryState = {
  roundRobin: new Map(),
  quotaUsage: new Map(),
};

async function loadRouteConfig(slug, env) {
  if (env?.SHORTLINK_ROUTES && typeof env.SHORTLINK_ROUTES.get === 'function') {
    const raw = await env.SHORTLINK_ROUTES.get(`route:${slug}`, 'json');
    if (raw) return raw;
  }
  return FALLBACK_ROUTES[slug] || null;
}

async function recordTelemetryAsync(payload, env) {
  const { slug, nextState } = payload;
  if (nextState) {
    memoryState.roundRobin.set(slug, nextState.roundRobinCounter);
    memoryState.quotaUsage.set(slug, nextState.quotaUsage);
  }
  if (env?.TELEMETRY_WEBHOOK_URL && typeof fetch === 'function') {
    await fetch(env.TELEMETRY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const slug = url.pathname.replace(/^\/+|\/+$/g, '');

    if (!slug || slug === 'healthz') {
      return new Response(JSON.stringify({ status: 'ok', service: 'shortlink-rotator-worker' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const route = await loadRouteConfig(slug, env);
    if (!route) {
      return new Response(JSON.stringify({ error: 'Shortlink slug not found', slug }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const visitorId =
      url.searchParams.get('vid') ||
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '';

    const decision = resolveRoute(route, {
      visitorId,
      cookieHeader: request.headers.get('cookie') || '',
      incomingUrl: url,
      roundRobinCounter: memoryState.roundRobin.get(slug) || 0,
      quotaUsage: memoryState.quotaUsage.get(slug) || {},
    });

    if (!decision.ok) {
      return new Response(JSON.stringify({ error: decision.error, slug }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // Non-blocking telemetry & counter update via ctx.waitUntil
    const telemetryTask = recordTelemetryAsync(
      {
        timestamp: new Date().toISOString(),
        slug,
        mode: decision.mode,
        targetId: decision.target.id,
        reason: decision.reason,
        stickyHit: decision.stickyHit,
        quotaExhausted: decision.quotaExhausted,
        nextState: decision.nextState,
      },
      env
    );
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(telemetryTask);
    }

    const headers = new Headers({
      Location: decision.destinationUrl,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Shortlink-Target': decision.target.id,
      'X-Shortlink-Mode': decision.mode,
      'X-Shortlink-Reason': decision.reason,
    });
    if (decision.setCookie) {
      headers.set('Set-Cookie', decision.setCookie);
    }

    return new Response(null, { status: 302, headers });
  },
};
