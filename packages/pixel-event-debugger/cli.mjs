#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  EVENT_MAP,
  buildCrossPlatformPayloads,
  captureClickIds,
  lintHtmlPixelSetup,
  validatePixelPayload
} from './src/pixel-bridge.mjs';

const HELP_TEXT = `
pixel-event-debugger CLI — Cross-Platform Ad Pixel Mapper & HTML Linter (Meta / TikTok / GA4)

Usage:
  node cli.mjs map --action <action> [--value <num>] [--currency <ISO>] [--page <slug>] [--seed <id>] [--url <url>] [--json]
  node cli.mjs lint <html-file> [--json]
  node cli.mjs --help

Supported Actions:
  ${Object.keys(EVENT_MAP).join(', ')}

Examples:
  node cli.mjs map --action purchase --value 49.9 --currency USD
  node cli.mjs map --action lead --url "https://example.com/?fbclid=IwAR123&utm_source=fb" --json
  node cli.mjs lint index.html
  node cli.mjs lint index.html --json
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
    } else if (token === '--json') {
      flags.json = true;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { command: positionals[0], target: positionals[1], flags };
}

function runMap(flags) {
  const action = flags.action || 'purchase';
  const payloadBundle = buildCrossPlatformPayloads({
    action,
    value: flags.value,
    currency: flags.currency,
    contentName: flags.name || flags['content-name'],
    contentId: flags.id || flags['content-id'],
    pageSlug: flags.page || 'lp-offer',
    visitorSeed: flags.seed || 'visitor-demo',
    timestampMs: flags.timestamp ? Number(flags.timestamp) : 1732500000000
  });

  const clickAttribution = flags.url
    ? captureClickIds(flags.url, { timestampMs: payloadBundle.timestampMs })
    : null;

  const validations = {
    meta: validatePixelPayload({
      platform: 'meta',
      eventName: payloadBundle.platforms.meta.eventName,
      params: payloadBundle.platforms.meta.params,
      options: payloadBundle.platforms.meta.options
    }),
    tiktok: validatePixelPayload({
      platform: 'tiktok',
      eventName: payloadBundle.platforms.tiktok.eventName,
      params: payloadBundle.platforms.tiktok.params
    }),
    ga4: validatePixelPayload({
      platform: 'ga4',
      eventName: payloadBundle.platforms.ga4.eventName,
      params: payloadBundle.platforms.ga4.params
    })
  };

  const output = {
    ...payloadBundle,
    ...(clickAttribution ? { clickAttribution } : {}),
    validations
  };

  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  console.log(`=== Unified Pixel Event Mapping (${output.action.toUpperCase()}) ===`);
  console.log(`Deterministic event_id : ${output.eventId}`);
  if (clickAttribution && clickAttribution.hasAnyClickId) {
    console.log(`Captured _fbc          : ${clickAttribution.fbc || 'N/A'}`);
    console.log(`Click IDs              : ${JSON.stringify({ fbclid: clickAttribution.fbclid, ttclid: clickAttribution.ttclid, gclid: clickAttribution.gclid })}`);
  }
  console.log('\n[1] Meta Pixel (Browser SDK)');
  console.log(`  Snippet : ${output.platforms.meta.snippet}`);
  console.log(`  Status  : ${validations.meta.valid ? 'VALID' : 'INVALID'}`);

  console.log('\n[2] TikTok Pixel (Browser SDK)');
  console.log(`  Snippet : ${output.platforms.tiktok.snippet}`);
  console.log(`  Status  : ${validations.tiktok.valid ? 'VALID' : 'INVALID'}`);

  console.log('\n[3] Google Analytics 4 (gtag.js)');
  console.log(`  Snippet : ${output.platforms.ga4.snippet}`);
  console.log(`  Status  : ${validations.ga4.valid ? 'VALID' : 'INVALID'}`);

  const allErrors = [
    ...validations.meta.errors,
    ...validations.tiktok.errors,
    ...validations.ga4.errors
  ];
  if (allErrors.length > 0) {
    console.log('\n[!] Validation Errors:');
    for (const err of allErrors) {
      console.log(`  - [${err.code}] ${err.message}`);
    }
    return 1;
  }

  return 0;
}

function runLint(filePath, flags) {
  if (!filePath) {
    console.error('Error: Missing HTML file path. Usage: node cli.mjs lint <html-file>');
    return 1;
  }
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: File not found: ${resolved}`);
    return 1;
  }

  const html = fs.readFileSync(resolved, 'utf8');
  const report = lintHtmlPixelSetup(html);

  if (flags.json) {
    console.log(JSON.stringify({ file: filePath, ...report }, null, 2));
    return report.valid ? 0 : 1;
  }

  console.log(`=== Pixel Static Audit: ${filePath} ===`);
  console.log(
    `Scanned ${report.summary.totalLines} lines | fbq: ${report.summary.fbqTrackCalls} | ttq: ${report.summary.ttqTrackCalls} | gtag: ${report.summary.gtagEventCalls}`
  );

  if (report.issues.length === 0) {
    console.log('Result: PASS (0 errors, 0 warnings)');
    return 0;
  }

  for (const issue of report.issues) {
    const tag = issue.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  [${tag}] Line ${issue.line} (${issue.code}): ${issue.message}`);
  }

  console.log(
    `\nResult: ${report.valid ? 'PASS WITH WARNINGS' : 'FAIL'} (${report.summary.errorCount} errors, ${report.summary.warningCount} warnings)`
  );
  return report.valid ? 0 : 1;
}

function main() {
  const { command, target, flags } = parseArgs(process.argv);

  if (flags.help || !command) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  try {
    if (command === 'map') {
      process.exit(runMap(flags));
    } else if (command === 'lint') {
      process.exit(runLint(target, flags));
    } else {
      console.error(`Unknown command "${command}". Run "node cli.mjs --help" for usage.`);
      process.exit(1);
    }
  } catch (err) {
    if (flags.json) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
