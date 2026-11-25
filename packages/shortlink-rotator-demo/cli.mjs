#!/usr/bin/env node

/**
 * Shortlink Multi-Target Rotator CLI Simulator
 *
 * Commands:
 *   node cli.mjs route <slug> [--visitor <id>] [--cookie <header>] [--query <params>] [--mode <mode>] [--json]
 *   node cli.mjs simulate <slug> [--clicks 1000] [--mode <mode>] [--seed <num>] [--json]
 *   node cli.mjs deeplink --type <platform> [--country <code>] --phone <num_or_id> [--text <msg>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRoute,
  buildSocialDeeplink,
  getActiveTargets,
  fnv1aHash,
} from './src/router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DATA_PATH = path.join(__dirname, 'data', 'demo-routes.json');

function printHelp() {
  const helpText = `
shortlink-rotator-demo CLI — Multi-Target Shortlink Routing & Social Deeplink Simulator

Usage:
  node cli.mjs <command> [options]

Commands:
  route <slug>       Evaluate a single shortlink redirect decision
  simulate <slug>    Simulate N clicks and compare actual vs theoretical share & quota fallback
  deeplink           Build a standardized social messenger deeplink (WhatsApp/TG/LINE/Viber/Zalo)

Options for 'route':
  --visitor <id>     Visitor identifier for deterministic FNV-1a weighted bucket
  --cookie <str>     Incoming HTTP Cookie header (e.g. "lf_d_wa-vip=agent-bryan")
  --query <str>      Incoming query string for attribution pass-through (e.g. "utm_source=fb&fbclid=IwAR123")
  --mode <mode>      Override route mode (random | weighted | round_robin | quota)
  --config <path>    Custom routes JSON file (defaults to data/demo-routes.json)
  --json             Output machine-readable JSON

Options for 'simulate':
  --clicks <n>       Number of clicks to simulate (default: 1000)
  --mode <mode>      Override route mode (random | weighted | round_robin | quota)
  --sticky-ratio <r> Ratio of repeat visitors with sticky cookies 0..1 (default: 0)
  --config <path>    Custom routes JSON file
  --json             Output machine-readable JSON

Options for 'deeplink':
  --type <platform>  Platform: whatsapp | telegram | line | viber | zalo
  --country <code>   Optional country calling code (e.g. 86, 65)
  --phone <val>      Phone number or username/ID
  --text <msg>       Pre-filled greeting message
  --json             Output machine-readable JSON

Examples:
  node cli.mjs route wa-vip --visitor v123 --query "utm_source=tiktok&ttclid=E.C.P.123"
  node cli.mjs simulate wa-vip --clicks 1000
  node cli.mjs simulate promo-quota --clicks 1000
  node cli.mjs deeplink --type whatsapp --phone 8613800000000 --text "Hello"
`.trim();
  console.log(helpText);
}

/**
 * Parse CLI arguments into positional args and flags
 * @param {Array<string>} argv
 */
export function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function loadRoutesData(customPath) {
  const filePath = customPath ? path.resolve(process.cwd(), customPath) : DEFAULT_DATA_PATH;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function findRouteBySlug(data, slug) {
  if (!data || !Array.isArray(data.routes)) return null;
  const lower = String(slug || '').toLowerCase();
  return (
    data.routes.find((r) => String(r.slug).toLowerCase() === lower) || null
  );
}

/**
 * Deterministic PRNG (Mulberry32) so simulations are reproducible
 * @param {number} seed
 */
function createSeededRng(seed = 20261125) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run a multi-click simulation on a route config
 */
export function runSimulation(routeConfig, options = {}) {
  const clicks = Math.max(1, Math.floor(Number(options.clicks) || 1000));
  const modeOverride = options.mode ? String(options.mode).toLowerCase() : null;
  const route = modeOverride ? { ...routeConfig, mode: modeOverride } : { ...routeConfig };
  const activeTargets = getActiveTargets(route.targets);

  if (activeTargets.length === 0) {
    throw new Error(`Route "${route.slug}" has no active targets`);
  }

  const totalWeight = activeTargets.reduce((sum, t) => sum + (Number(t.weight) > 0 ? Number(t.weight) : 0), 0);
  const totalDailyQuota = activeTargets.reduce((sum, t) => {
    const lim = Number(t.daily_limit ?? t.dailyLimit);
    return sum + (Number.isFinite(lim) && lim >= 0 ? lim : 0);
  }, 0);

  let roundRobinCounter = 0;
  let quotaUsage = {};
  for (const t of activeTargets) {
    quotaUsage[t.id] = Number(t.today_clicks ?? 0) || 0;
  }

  const hitCounts = {};
  const normalHits = {};
  const fallbackHits = {};
  const stickyHits = {};

  for (const t of activeTargets) {
    hitCounts[t.id] = 0;
    normalHits[t.id] = 0;
    fallbackHits[t.id] = 0;
    stickyHits[t.id] = 0;
  }

  let quotaExhaustedTotal = 0;
  let stickyHitTotal = 0;
  const rng = createSeededRng(Number(options.seed) || fnv1aHash(route.slug));
  const stickyRatio = Math.min(1, Math.max(0, Number(options.stickyRatio) || 0));
  let lastStickyCookie = '';

  for (let i = 0; i < clicks; i++) {
    const useSticky =
      route.sticky !== false && stickyRatio > 0 && lastStickyCookie && rng() < stickyRatio;
    const cookieHeader = useSticky ? lastStickyCookie.split(';')[0] : '';
    const visitorId = `sim-visitor-${i + 1}`;

    const res = resolveRoute(route, {
      visitorId,
      cookieHeader,
      incomingUrl: 'https://go.example.com/' + route.slug + '?utm_source=cli_sim',
      roundRobinCounter,
      quotaUsage,
      rng,
    });

    if (!res.ok) {
      throw new Error(res.error);
    }

    const tid = res.target.id;
    hitCounts[tid] = (hitCounts[tid] || 0) + 1;
    if (res.stickyHit) {
      stickyHits[tid] = (stickyHits[tid] || 0) + 1;
      stickyHitTotal++;
    } else if (res.quotaExhausted) {
      fallbackHits[tid] = (fallbackHits[tid] || 0) + 1;
      quotaExhaustedTotal++;
    } else {
      normalHits[tid] = (normalHits[tid] || 0) + 1;
    }

    roundRobinCounter = res.nextState.roundRobinCounter;
    quotaUsage = res.nextState.quotaUsage;
    if (res.setCookie) {
      lastStickyCookie = res.setCookie;
    }
  }

  const rows = activeTargets.map((t, idx) => {
    const hits = hitCounts[t.id] || 0;
    const actualShare = (hits / clicks) * 100;

    let theoreticalShare = 0;
    if (route.mode === 'weighted' && totalWeight > 0) {
      theoreticalShare = ((Number(t.weight) || 0) / totalWeight) * 100;
    } else if (route.mode === 'random' || route.mode === 'round_robin') {
      theoreticalShare = 100 / activeTargets.length;
    } else if (route.mode === 'quota') {
      const cap = Number(t.daily_limit ?? 0);
      if (clicks <= totalDailyQuota && totalDailyQuota > 0) {
        theoreticalShare = (Math.min(cap, clicks / activeTargets.length) / clicks) * 100;
      } else {
        const overflow = Math.max(0, clicks - totalDailyQuota);
        const expectedHits = idx === 0 ? cap + overflow : cap;
        theoreticalShare = (expectedHits / clicks) * 100;
      }
    }

    const deltaPct = actualShare - theoreticalShare;
    const dailyLimit = t.daily_limit !== undefined ? Number(t.daily_limit) : null;

    return {
      id: t.id,
      label: t.label || t.id,
      weight: Number(t.weight) || 0,
      dailyLimit,
      hits,
      normalHits: normalHits[t.id] || 0,
      fallbackHits: fallbackHits[t.id] || 0,
      stickyHits: stickyHits[t.id] || 0,
      actualSharePct: Number(actualShare.toFixed(2)),
      theoreticalSharePct: Number(theoreticalShare.toFixed(2)),
      deltaPct: Number(deltaPct.toFixed(2)),
      quotaStatus:
        dailyLimit !== null && hits >= dailyLimit
          ? idx === 0 && fallbackHits[t.id] > 0
            ? 'CAPPED + FALLBACK'
            : 'EXHAUSTED'
          : 'AVAILABLE',
    };
  });

  return {
    slug: route.slug,
    name: route.name || route.slug,
    mode: route.mode,
    sticky: route.sticky !== false,
    totalClicks: clicks,
    activeTargetCount: activeTargets.length,
    totalDailyQuota,
    quotaExhaustedFallbacks: quotaExhaustedTotal,
    stickySessionHits: stickyHitTotal,
    targets: rows,
  };
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

function formatSimulationReport(report) {
  const lines = [];
  lines.push(`==========================================================================================`);
  lines.push(`Shortlink Simulation Report · slug="${report.slug}" · mode="${report.mode.toUpperCase()}"`);
  lines.push(`Route Name : ${report.name}`);
  lines.push(`Total Clicks: ${report.totalClicks} | Active Targets: ${report.activeTargetCount} | Sticky Enabled: ${report.sticky}`);
  lines.push(`------------------------------------------------------------------------------------------`);
  lines.push(
    `${padRight('Target ID', 18)} | ${padLeft('Weight', 6)} | ${padLeft('Daily Cap', 9)} | ${padLeft('Hits', 6)} | ${padLeft('Actual %', 8)} | ${padLeft('Theory %', 8)} | ${padLeft('Delta', 7)} | ${padRight('Quota / Fallback Status', 22)}`
  );
  lines.push(`------------------------------------------------------------------------------------------`);

  for (const row of report.targets) {
    const capStr = row.dailyLimit !== null ? String(row.dailyLimit) : '∞';
    const deltaSign = row.deltaPct > 0 ? `+${row.deltaPct.toFixed(2)}%` : `${row.deltaPct.toFixed(2)}%`;
    const statusStr =
      row.fallbackHits > 0
        ? `${row.quotaStatus} (+${row.fallbackHits} fb)`
        : row.quotaStatus;
    lines.push(
      `${padRight(row.id, 18)} | ${padLeft(row.weight, 6)} | ${padLeft(capStr, 9)} | ${padLeft(row.hits, 6)} | ${padLeft(row.actualSharePct.toFixed(2) + '%', 8)} | ${padLeft(row.theoreticalSharePct.toFixed(2) + '%', 8)} | ${padLeft(deltaSign, 7)} | ${padRight(statusStr, 22)}`
    );
  }

  lines.push(`------------------------------------------------------------------------------------------`);
  lines.push(
    `Quota Fallback Summary: ${report.quotaExhaustedFallbacks} / ${report.totalClicks} clicks triggered quota-exhausted fallback (Total Pool Daily Cap: ${report.totalDailyQuota})`
  );
  lines.push(`==========================================================================================`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseCliArgs(argv);

  if (flags.help || positionals.length === 0) {
    printHelp();
    return 0;
  }

  const command = positionals[0];

  if (command === 'deeplink') {
    const result = buildSocialDeeplink({
      type: flags.type || flags.platform,
      countryCode: flags.country || flags.cc || '',
      phone: flags.phone || flags.account || '',
      text: flags.text || flags.message || '',
    });

    if (!result.ok) {
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.error}`);
      }
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.url);
    }
    return 0;
  }

  if (command === 'route') {
    const slug = positionals[1] || flags.slug || 'wa-vip';
    const data = loadRoutesData(flags.config);
    const found = findRouteBySlug(data, slug);

    if (!found) {
      const errObj = { ok: false, error: `Route slug "${slug}" not found in config` };
      if (flags.json) {
        console.log(JSON.stringify(errObj, null, 2));
      } else {
        console.error(`Error: ${errObj.error}`);
      }
      return 1;
    }

    const route = flags.mode ? { ...found, mode: String(flags.mode) } : found;
    const incomingUrl = flags.query
      ? `https://go.example.com/${slug}?${String(flags.query).replace(/^\?/, '')}`
      : flags.url || `https://go.example.com/${slug}`;

    const decision = resolveRoute(route, {
      visitorId: flags.visitor || '',
      cookieHeader: flags.cookie || '',
      incomingUrl,
      roundRobinCounter: Number(flags.counter) || 0,
    });

    if (!decision.ok) {
      if (flags.json) {
        console.log(JSON.stringify(decision, null, 2));
      } else {
        console.error(`Error: ${decision.error}`);
      }
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(decision, null, 2));
    } else {
      console.log(`Slug           : ${decision.slug}`);
      console.log(`Mode           : ${decision.mode}`);
      console.log(`Selected Target: ${decision.target.id} (${decision.target.label || ''})`);
      console.log(`Decision Reason: ${decision.reason}`);
      console.log(`Sticky Hit     : ${decision.stickyHit}`);
      console.log(`Location (302) : ${decision.destinationUrl}`);
      if (decision.setCookie) {
        console.log(`Set-Cookie     : ${decision.setCookie}`);
      }
    }
    return 0;
  }

  if (command === 'simulate') {
    const slug = positionals[1] || flags.slug || 'wa-vip';
    const data = loadRoutesData(flags.config);
    const found = findRouteBySlug(data, slug);

    if (!found) {
      const errObj = { ok: false, error: `Route slug "${slug}" not found in config` };
      if (flags.json) {
        console.log(JSON.stringify(errObj, null, 2));
      } else {
        console.error(`Error: ${errObj.error}`);
      }
      return 1;
    }

    const report = runSimulation(found, {
      clicks: flags.clicks || 1000,
      mode: flags.mode,
      seed: flags.seed,
      stickyRatio: flags['sticky-ratio'],
    });

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatSimulationReport(report));
    }
    return 0;
  }

  console.error(`Unknown command "${command}". Run with --help for usage.`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}
