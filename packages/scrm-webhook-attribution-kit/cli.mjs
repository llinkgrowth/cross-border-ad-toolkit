#!/usr/bin/env node
import {
  DeduplicationStore,
  SafeBroadcastQueue,
  injectRefCode,
  parseInboundRefCode,
  signWebhookPayload,
  verifyWebhookSignature
} from './src/attribution-kit.mjs';

const HELP_TEXT = `
scrm-webhook-attribution-kit CLI — Inbound RefCode Attribution, Webhook HMAC Signer & Safe Broadcast Simulator

Usage:
  node cli.mjs parse-msg --text "<inbound-message>" [--json]
  node cli.mjs sign-webhook --secret "<secret>" --event "<event>" --visitor "<id>" [--channel "<ch>"] [--ref "<code>"] [--json]
  node cli.mjs simulate-broadcast --count <n> --tier <fast|medium|slow> [--inject-unknown-at <idx>] [--json]
  node cli.mjs --help

Examples:
  node cli.mjs parse-msg --text "Hi, I want the catalog [ref:lp01_fb_7a9c]" --json
  node cli.mjs sign-webhook --secret "whsec_demo" --event "inbound_open" --visitor "v_101" --json
  node cli.mjs simulate-broadcast --count 10 --tier medium --inject-unknown-at 4 --json
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

  return { command: positionals[0], flags };
}

function cmdParseMsg(flags) {
  const text = flags.text || 'Hi, I want the catalog [ref:lp01_fb_7a9c]';
  const parsed = parseInboundRefCode(text);
  const sampleInjected = injectRefCode({
    greeting: parsed.cleanText || 'Hello',
    refCode: parsed.refCode || 'LP01_FB_7A9C'
  });

  const out = {
    input: text,
    parsed,
    reconstructedGreeting: sampleInjected.message
  };

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  console.log('=== Inbound First-Message RefCode Attribution ===');
  console.log(`Raw Message        : ${out.input}`);
  console.log(`Matched RefCode    : ${parsed.refCode || 'NONE'}`);
  console.log(`Clean Message      : ${parsed.cleanText}`);
  console.log(`Attribution Stage  : ${parsed.attributionStage}`);
  console.log(`Landing Page / Ch  : ${parsed.pageId || '-'} / ${parsed.channel || '-'} (ClickHash: ${parsed.clickHash || '-'})`);
  return 0;
}

function cmdSignWebhook(flags) {
  const secret = flags.secret || 'whsec_demo';
  const timestampSec = flags.timestamp ? Number(flags.timestamp) : 1732500000;
  const payload = {
    event: flags.event || 'inbound_open',
    message_id: flags['message-id'] || `msg_${ flags.visitor || 'v_101' }_${timestampSec}`,
    visitor_id: flags.visitor || 'v_101',
    channel: flags.channel || 'whatsapp',
    ref_code: flags.ref || 'LP01_FB_7A9C',
    occurred_at: new Date(timestampSec * 1000).toISOString()
  };

  const signed = signWebhookPayload(payload, secret, { timestampSec });
  const dedupStore = new DeduplicationStore();
  const verification = verifyWebhookSignature({
    payload: signed.rawBody,
    headerValue: signed.headerValue,
    secret,
    nowSec: timestampSec + 5,
    dedupStore
  });

  const output = {
    payload,
    signatureHeader: signed.headerValue,
    headers: signed.headers,
    verification
  };

  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  console.log('=== Webhook HMAC-SHA256 Sign & Verify ===');
  console.log(`X-SCRM-Signature   : ${signed.headerValue}`);
  console.log(`Payload            : ${signed.rawBody}`);
  console.log(`Self-Verification  : ${verification.valid ? 'VALID (Replay & Timing-Safe Checked)' : 'INVALID'}`);
  return 0;
}

function cmdSimulateBroadcast(flags) {
  const count = Math.max(1, Number(flags.count || 10));
  const tier = flags.tier || 'medium';
  const injectUnknownAt = flags['inject-unknown-at'] ? Number(flags['inject-unknown-at']) : null;

  // Deterministic RNG so CLI output is reproducible
  let seed = 42;
  const deterministicRng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const queue = new SafeBroadcastQueue({
    tier,
    template: 'Hi {{name}}, we received your request from {{phone}}.',
    rng: deterministicRng,
    pauseQueueOnUnknown: true
  });

  const recipients = [];
  for (let i = 1; i <= count; i++) {
    recipients.push({
      uid: `wa_user_${String(i).padStart(3, '0')}`,
      name: `Contact_${i}`,
      phone: `+1555000${String(i).padStart(4, '0')}`
    });
  }

  queue.enqueue(recipients);

  const snapshot = queue.runSync((item) => {
    if (injectUnknownAt && item.index === injectUnknownAt) {
      return {
        status: 'unknown',
        reason: `Network/DOM acknowledgment timed out on item #${item.index}; locked as PENDING_MANUAL_REVIEW (0 auto-retries).`
      };
    }
    return { status: 'sent' };
  });

  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  console.log(`=== Safe Broadcast Simulation (tier=${tier}, total=${count}) ===`);
  console.log(`Queue Status          : ${snapshot.queueStatus}`);
  console.log(
    `Counts                : sent=${snapshot.counts.sent}, pendingManualReview=${snapshot.counts.pendingManualReview}, queued=${snapshot.counts.queued}`
  );
  for (const item of snapshot.items) {
    console.log(
      `  #${String(item.index).padStart(2, '0')} [${item.uid}] delay=${item.plannedDelayMs}ms -> ${item.state}${item.lastReason ? ` (${item.lastReason})` : ''}`
    );
  }
  return 0;
}

function main() {
  const { command, flags } = parseArgs(process.argv);

  if (flags.help || !command) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  try {
    if (command === 'parse-msg') {
      process.exit(cmdParseMsg(flags));
    } else if (command === 'sign-webhook') {
      process.exit(cmdSignWebhook(flags));
    } else if (command === 'simulate-broadcast') {
      process.exit(cmdSimulateBroadcast(flags));
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
