#!/usr/bin/env node
/**
 * @file cli.mjs
 * @description Command-line contract simulator & integration debugger for Cloak Integration Kit.
 *
 * Examples:
 *   node cli.mjs simulate --ua "curl/8.0" --ip "1.2.3.4"
 *   node cli.mjs simulate --ua "Mozilla/5.0" --url "https://shop.example.com/item?gclid=EAIaIQob&mock_block=1" --json
 *   node cli.mjs simulate --country "XX" --ua "Mozilla/5.0"
 */

import {
  buildVisitorPayload,
  evaluateDemoVisitor,
  resolveGateEnforcement,
  requestDecisionWithFailOpen,
  inspectIpAddress,
  checkUtmGuard
} from './mock-server/server.mjs';

function parseCliArgs(argv) {
  const args = {
    command: 'simulate',
    ip: '203.0.113.10',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
    url: 'https://store.example.com/products/wireless-earbuds',
    lang: 'en-US,en;q=0.9',
    referer: '',
    secChUa: '"Chromium";v="124", "Google Chrome";v="124"',
    country: '',
    token: 'demo_store_token_local',
    endpoint: '',
    timeoutMs: 800,
    allowCidrs: '',
    denyCidrs: '',
    allowedSources: '',
    allowedMediums: '',
    requireClickId: false,
    json: false,
    help: false
  };

  const tokens = argv.slice(2);
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      args.command = token;
      i += 1;
      continue;
    }

    const eqIdx = token.indexOf('=');
    let key = token;
    let inlineVal = null;
    if (eqIdx > 0) {
      key = token.slice(0, eqIdx);
      inlineVal = token.slice(eqIdx + 1);
    }

    const readNext = () => {
      if (inlineVal !== null) return inlineVal;
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        i += 1;
        return next;
      }
      return '';
    };

    switch (key) {
      case '--ip':
        args.ip = readNext();
        break;
      case '--ua':
        args.ua = readNext();
        break;
      case '--url':
        args.url = readNext();
        break;
      case '--lang':
      case '--accept-language':
        args.lang = readNext();
        break;
      case '--referer':
      case '--referrer':
        args.referer = readNext();
        break;
      case '--sec-ch-ua':
        args.secChUa = readNext();
        break;
      case '--country':
        args.country = readNext();
        break;
      case '--token':
        args.token = readNext();
        break;
      case '--endpoint':
        args.endpoint = readNext();
        break;
      case '--timeout':
        args.timeoutMs = Number(readNext() || 800);
        break;
      case '--allow-cidrs':
        args.allowCidrs = readNext();
        break;
      case '--deny-cidrs':
        args.denyCidrs = readNext();
        break;
      case '--allowed-sources':
        args.allowedSources = readNext();
        break;
      case '--allowed-mediums':
        args.allowedMediums = readNext();
        break;
      case '--require-click-id':
        args.requireClickId = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        break;
    }
    i += 1;
  }

  return args;
}

function printHelp() {
  console.log(`
Cloak Integration Kit — CLI Contract Simulator

Usage:
  node cli.mjs simulate [options]
  node cli.mjs ipcheck --ip <ip> [--allow-cidrs "1.2.3.0/24"] [--deny-cidrs "10.0.0.0/8"] [--json]
  node cli.mjs utmcheck --url <url> [--allowed-sources "facebook,tiktok"] [--require-click-id] [--json]

Options:
  --ua <string>         Visitor User-Agent string (e.g., "curl/8.0" or "BotDemo/1.0")
  --ip <string>         Visitor IPv4/IPv6 address (default: "203.0.113.10")
  --url <string>        Landing page URL (supports ?mock_block=1, ?mock_action=redirect, ?gclid=...)
  --country <string>    Simulated country code header (e.g., "XX" triggers demo rule 3)
  --lang <string>       Accept-Language header value
  --referer <string>    HTTP Referer header value
  --token <string>      Store Token sent in request payload
  --endpoint <url>      Optional live/mock HTTP endpoint to POST payload to
  --timeout <ms>        HTTP timeout in milliseconds before Fail-Open (default: 800)
  --json                Output machine-readable JSON only
  -h, --help            Show this help message
`.trim());
}

export async function runCli(argv = process.argv) {
  const args = parseCliArgs(argv);

  if (args.help || args.command === 'help') {
    printHelp();
    return 0;
  }

  if (args.command === 'ipcheck') {
    const allowlist = args.allowCidrs.split(',').map((s) => s.trim()).filter(Boolean);
    const denylist = args.denyCidrs.split(',').map((s) => s.trim()).filter(Boolean);
    const report = inspectIpAddress(args.ip, { allowlist, denylist });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('=== Cloak Integration Kit : IP & CIDR Inspector (ipcheck) ===');
      console.log(JSON.stringify(report, null, 2));
    }
    return report.valid ? 0 : 2;
  }

  if (args.command === 'utmcheck') {
    const allowedSources = args.allowedSources.split(',').map((s) => s.trim()).filter(Boolean);
    const allowedMediums = args.allowedMediums.split(',').map((s) => s.trim()).filter(Boolean);
    const report = checkUtmGuard(args.url, {
      allowedSources,
      allowedMediums,
      requireClickId: args.requireClickId
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('=== Cloak Integration Kit : UTM & Click-ID Whitelist Check ===');
      console.log(JSON.stringify(report, null, 2));
    }
    return report.pass ? 0 : 1;
  }

  const requestPayload = buildVisitorPayload({
    storeToken: args.token,
    ip: args.ip,
    ua: args.ua,
    acceptLanguage: args.lang,
    referer: args.referer,
    secChUa: args.secChUa,
    url: args.url,
    countryCode: args.country
  });

  let decisionResponse;
  if (args.endpoint) {
    decisionResponse = await requestDecisionWithFailOpen(requestPayload, {
      endpoint: args.endpoint,
      timeoutMs: args.timeoutMs
    });
  } else {
    decisionResponse = evaluateDemoVisitor(
      requestPayload,
      args.country ? { 'cf-ipcountry': args.country } : {}
    );
  }

  const gateAction = resolveGateEnforcement(decisionResponse);

  const report = {
    mode: args.endpoint ? 'http_endpoint' : 'local_contract_mock',
    request_payload: requestPayload,
    decision_response: decisionResponse,
    gate_enforcement: {
      proceed_to_origin: gateAction.proceedToOrigin,
      http_status: gateAction.statusCode,
      response_headers: gateAction.headers
    }
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log('=== Cloak Integration Kit : Visitor Contract Simulation ===');
  console.log('\n[1] Outgoing Decision Request Payload (Client -> Decision API):');
  console.log(JSON.stringify(requestPayload, null, 2));
  console.log('\n[2] Decision Response (Decision API -> Client Gate):');
  console.log(JSON.stringify(decisionResponse, null, 2));
  console.log('\n[3] Gate Enforcement Action:');
  console.log(`  - Allow Visitor     : ${decisionResponse.allow}`);
  console.log(`  - Executed Action   : ${decisionResponse.action}`);
  console.log(`  - Proceed to Origin : ${gateAction.proceedToOrigin}`);
  console.log(`  - HTTP Status Code  : ${gateAction.statusCode}`);
  if (gateAction.headers.Location) {
    console.log(`  - Redirect Location : ${gateAction.headers.Location}`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
