#!/usr/bin/env node

/**
 * CLI for Quiz / StepFlow & PrizeWheel Funnel Demos
 *
 * Commands:
 *   node cli.mjs simulate-wheel [--spins 1000] [--seed <num>] [--json]
 *   node cli.mjs route-quiz [--answers "q1:a,q2:a,q3:b"] [--url "https://example.com/lp?utm_source=tiktok&ttclid=TT99"] [--json]
 *   node cli.mjs check-webview --ua "<User-Agent>" --target "<URL>" [--json]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_QUIZ_CONFIG,
  DEFAULT_WHEEL_CONFIG,
  evaluateQuizFunnel,
  spinPrizeWheel,
  validateWheelConfig,
  buildExternalBrowserHandoff,
  fnv1aHash,
} from './src/funnel-engine.mjs';

const __filename = fileURLToPath(import.meta.url);

function printHelp() {
  const text = `
quiz-wheel-funnel-demos CLI — Interactive Quiz Funnel, PrizeWheel & WebView Handoff Tool

Usage:
  node cli.mjs <command> [options]

Commands:
  simulate-wheel    Simulate N prize wheel spins and compare theoretical vs actual share & angle range
  route-quiz        Evaluate a multi-step quiz funnel, audience tag routing & WhatsApp pre-filled message
  check-webview     Detect FB/IG/TikTok In-App WebView and build Android intent:// or iOS Safari guide

Options for 'simulate-wheel':
  --spins <n>       Number of wheel spins to simulate (default: 1000)
  --seed <n>        PRNG seed for reproducible output
  --json            Output machine-readable JSON

Options for 'route-quiz':
  --answers <str>   Comma-separated step answers, e.g. "q1:a,q2:a,q3:a" (default: "q1:a,q2:a,q3:b")
  --url <str>       Incoming URL with UTM / click IDs (default: "https://example.com/lp?utm_source=tiktok&ttclid=TT99")
  --json            Output machine-readable JSON

Options for 'check-webview':
  --ua <str>        Browser User-Agent string
  --target <url>    Target redirect URL (default: "https://wa.me/6581009001")
  --json            Output machine-readable JSON

Examples:
  node cli.mjs simulate-wheel --spins 1000
  node cli.mjs route-quiz --answers "q1:b,q2:a,q3:c" --url "https://example.com/lp?utm_source=tiktok&ttclid=TT99" --json
  node cli.mjs check-webview --ua "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) [FBAN/FB4A;FBAV/440.0]" --target "https://wa.me/123456" --json
`.trim();
  console.log(text);
}

/**
 * Parse CLI arguments
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
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
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
 * Run a multi-spin wheel simulation
 */
export function runWheelSimulation(wheelConfig = DEFAULT_WHEEL_CONFIG, options = {}) {
  const validation = validateWheelConfig(wheelConfig);
  if (!validation.ok) {
    throw new Error(`Invalid wheel config: ${validation.errors.join('; ')}`);
  }

  const spins = Math.max(1, Math.floor(Number(options.spins) || 1000));
  const rng = createSeededRng(Number(options.seed) || fnv1aHash(wheelConfig.wheelId));
  const hitCounts = {};
  const anglesBySector = {};

  for (const sec of wheelConfig.sectors) {
    hitCounts[sec.id] = 0;
    anglesBySector[sec.id] = { min: Infinity, max: -Infinity, center: 0, rotationDeg: 0 };
  }

  for (let i = 0; i < spins; i++) {
    const res = spinPrizeWheel(wheelConfig, { rng });
    const sid = res.sector.id;
    hitCounts[sid] = (hitCounts[sid] || 0) + 1;
    const startDeg = Number((res.sectorIndex * res.sectorAngleDeg).toFixed(2));
    const endDeg = Number(((res.sectorIndex + 1) * res.sectorAngleDeg).toFixed(2));
    anglesBySector[sid] = {
      min: startDeg,
      max: endDeg,
      center: res.sectorCenterAngle,
      rotationDeg: res.rotationDeg,
    };
  }

  const sectorsReport = wheelConfig.sectors.map((sec, idx) => {
    const hits = hitCounts[sec.id] || 0;
    const actualPct = (hits / spins) * 100;
    const theoryPct = (Number(sec.weight) / validation.totalWeight) * 100;
    const deltaPct = actualPct - theoryPct;
    const sectorAngleDeg = Number((360 / wheelConfig.sectors.length).toFixed(2));
    const startDeg = Number((idx * sectorAngleDeg).toFixed(2));
    const endDeg = Number(((idx + 1) * sectorAngleDeg).toFixed(2));
    const centerDeg = Number((startDeg + sectorAngleDeg / 2).toFixed(2));
    const rotationDeg = Number((360 * (wheelConfig.minSpins || 5) + centerDeg).toFixed(2));

    return {
      id: sec.id,
      label: sec.label,
      couponCode: sec.couponCode,
      weight: Number(sec.weight),
      hits,
      actualSharePct: Number(actualPct.toFixed(2)),
      theoreticalSharePct: Number(theoryPct.toFixed(2)),
      deltaPct: Number(deltaPct.toFixed(2)),
      angleRangeDeg: `${startDeg}°–${endDeg}°`,
      centerAngleDeg: centerDeg,
      targetRotationDeg: rotationDeg,
    };
  });

  return {
    wheelId: wheelConfig.wheelId,
    totalSpins: spins,
    sectorCount: wheelConfig.sectors.length,
    totalWeight: validation.totalWeight,
    minSpins: wheelConfig.minSpins || 5,
    sectors: sectorsReport,
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

function formatWheelReport(report) {
  const lines = [];
  lines.push(`====================================================================================================`);
  lines.push(`PrizeWheel Simulation Report · wheelId="${report.wheelId}" · totalSpins=${report.totalSpins}`);
  lines.push(`Sectors: ${report.sectorCount} | Total Weight: ${report.totalWeight} | Base Full Spins: ${report.minSpins} (${report.minSpins * 360}°)`);
  lines.push(`----------------------------------------------------------------------------------------------------`);
  lines.push(
    `${padRight('Sector ID', 14)} | ${padRight('Coupon', 10)} | ${padLeft('Weight', 6)} | ${padLeft('Hits', 6)} | ${padLeft('Actual %', 8)} | ${padLeft('Theory %', 8)} | ${padLeft('Delta', 7)} | ${padRight('Sector Angle / Stop Deg', 24)}`
  );
  lines.push(`----------------------------------------------------------------------------------------------------`);

  for (const row of report.sectors) {
    const deltaStr = row.deltaPct > 0 ? `+${row.deltaPct.toFixed(2)}%` : `${row.deltaPct.toFixed(2)}%`;
    const angleStr = `${row.angleRangeDeg} (${row.targetRotationDeg}°)`;
    lines.push(
      `${padRight(row.id, 14)} | ${padRight(row.couponCode, 10)} | ${padLeft(row.weight, 6)} | ${padLeft(row.hits, 6)} | ${padLeft(row.actualSharePct.toFixed(2) + '%', 8)} | ${padLeft(row.theoreticalSharePct.toFixed(2) + '%', 8)} | ${padLeft(deltaStr, 7)} | ${padRight(angleStr, 24)}`
    );
  }

  lines.push(`====================================================================================================`);
  return lines.join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseCliArgs(argv);

  if (flags.help || positionals.length === 0) {
    printHelp();
    return 0;
  }

  const command = positionals[0];

  if (command === 'simulate-wheel') {
    const report = runWheelSimulation(DEFAULT_WHEEL_CONFIG, {
      spins: flags.spins || 1000,
      seed: flags.seed,
    });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatWheelReport(report));
    }
    return 0;
  }

  if (command === 'route-quiz') {
    const answersStr = flags.answers || 'q1:a,q2:a,q3:a';
    const incomingUrl = flags.url || 'https://example.com/lp?utm_source=tiktok&ttclid=TT99';
    const res = evaluateQuizFunnel(DEFAULT_QUIZ_CONFIG, answersStr, { incomingUrl });

    if (!res.ok) {
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.error(`Error: ${res.error}`);
      }
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Quiz ID        : ${res.quizId}`);
      console.log(`Total Score    : ${res.totalScore}`);
      console.log(`Primary Segment: ${res.primaryTag} (Tags: ${res.tags.join(', ')})`);
      console.log(`Matched Route  : ${res.matchedRoute.id} (${res.matchedRoute.label})`);
      console.log(`Summary Tag    : ${res.summaryTag}`);
      console.log(`Pre-filled Msg : ${res.prefilledMessage}`);
      console.log(`Final CTA URL  : ${res.destinationUrl}`);
    }
    return 0;
  }

  if (command === 'check-webview') {
    const ua =
      flags.ua ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E219 [FBAN/FBIOS;FBAV/455.0.0.0;]';
    const target = flags.target || 'https://wa.me/6581009001?text=Hello';
    const res = buildExternalBrowserHandoff(ua, target, flags.url);

    if (!res.ok) {
      if (flags.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.error(`Error: ${res.error}`);
      }
      return 1;
    }

    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`In-App WebView : ${res.isInAppWebView} (${res.appName})`);
      console.log(`Detected OS    : ${res.os}`);
      console.log(`Handoff Action : ${res.action}`);
      console.log(`Target URL     : ${res.targetUrl}`);
      if (res.androidIntentUrl) {
        console.log(`Android Intent : ${res.androidIntentUrl}`);
      }
      if (res.iosGuideText) {
        console.log(`iOS Guide      : ${res.iosGuideText}`);
      }
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
