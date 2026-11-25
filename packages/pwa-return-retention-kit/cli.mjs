#!/usr/bin/env node
/**
 * pwa-return-retention-kit CLI（零依赖）
 *
 * 三个子命令：
 *   manifest          生成 manifest.webmanifest（start_url 自动带 utm_source=pwa_homescreen）
 *   simulate-trigger  在终端里跑一遍回流触发状态机（触发条件 + 频次闸门）
 *   detect-pwa        输入 UA，输出该环境该走哪种 PWA 安装引导
 *
 * 所有命令都不联网、不写文件（除非显式传 --out），只读参数并打印结果。
 */

import { writeFileSync } from 'node:fs';

import {
  DEFAULT_RETENTION_POLICY,
  buildReturnViewModel,
  detectInstallStrategy,
  evaluateRetentionTrigger,
  generatePwaManifest,
  shouldFireRetention,
  validateManifest
} from './src/retention-engine.mjs';

const VERSION = '1.0.0';

const USAGE = `pwa-return-retention-kit v${VERSION} · PWA 桌面留存 + 回流页状态机工具包（零依赖）

用法：
  node cli.mjs <command> [options]
  node cli.mjs --help

命令：
  manifest          生成 manifest.webmanifest（自动追加 utm_source=pwa_homescreen）
  simulate-trigger  跑一遍回流触发状态机：触发条件 → 频次闸门 → 是否展示
  detect-pwa        输入 UA，输出 PWA 安装引导策略（Android / iOS / WebView / standalone）

通用参数：
  --json            以 JSON 输出（便于脚本 / CI 断言）
  --help            显示本说明

manifest 参数：
  --name <string>        应用全名（必填），如 "PulsePlay"
  --short <string>       桌面图标下的简称（必填），如 "Pulse"
  --color <hex>          主题色，默认 #0f172a
  --background <hex>     启动背景色，默认 #0f172a
  --start-url <path>     启动路径，默认 /；会自动追加 utm_source=pwa_homescreen
  --scope <path>         scope，默认 /
  --lang <lang>          默认 zh-CN
  --display <mode>       standalone / fullscreen / minimal-ui / browser，默认 standalone
  --utm-source <value>   自定义启动归因来源，默认 pwa_homescreen
  --out <path>           把 manifest 写入文件（默认打印到 stdout）

simulate-trigger 参数：
  --trigger <mode>           back / revisit / both，默认 both
  --signal <signal>          back / revisit / exit_intent；不传时按 trigger 推断
  --dwell-ms <number>        进站已停留毫秒，默认 4500
  --away-sec <number>        切后台时长秒数，默认 12（仅 revisit 生效）
  --already-converted <bool> true / false，默认 false
  --frequency <mode>         once_per_session / cooldown_hours / always，默认 once_per_session
  --last-fired-at <ms>       上次展示时间戳（cooldown_hours 模式下用）
  --format <popup|feed>      可选：同时生成回流视图模型
  --utm-source <string>      可选：透传到视图模型的 utm_source
  --utm-campaign <string>    可选：透传到视图模型的 utm_campaign
  --fbclid <string>          可选：透传 fbclid

detect-pwa 参数：
  --ua <string>          User-Agent（必填）
  --standalone           传了表示当前已经在桌面模式下运行

例子：
  node cli.mjs manifest --name "PulsePlay" --short "Pulse" --color "#0f172a" --start-url "/offer"
  node cli.mjs simulate-trigger --trigger both --dwell-ms 4500 --away-sec 12 --already-converted false --json
  node cli.mjs detect-pwa --ua "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1" --json

退出码：
  0  成功
  2  参数错误 / 生成失败

说明：
  纯 Demo 工具，零第三方依赖；不联网、不上传数据、不包含任何商业后台代码。
`;

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 把 `--key value` / `--key=value` / `--flag` 解析成对象。 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new CliError(`未知参数：${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function readFlag(flags, key, { fallback = undefined, required = false, type = 'string' } = {}) {
  const value = Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : undefined;
  if (value === undefined) {
    if (required) throw new CliError(`缺少 --${key}`);
    return fallback;
  }
  if (value === true) {
    if (type === 'boolean') return true;
    throw new CliError(`--${key} 需要一个值`);
  }
  if (type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new CliError(`--${key} 需要数字，收到 "${value}"`);
    return number;
  }
  if (type === 'boolean') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new CliError(`--${key} 只接受 true / false，收到 "${value}"`);
  }
  return value;
}

function printHumanManifest(manifest) {
  const validation = validateManifest(manifest);
  const lines = [
    '# manifest.webmanifest（复制到站点根目录，或由服务端动态返回）',
    JSON.stringify(manifest, null, 2),
    '',
    `校验：${validation.valid ? '通过' : '未通过'}`,
    ...validation.errors.map((error) => `  ✗ ${error}`),
    ...validation.warnings.map((warning) => `  ! ${warning}`),
    '',
    `桌面启动归因：start_url 已带 utm_source，来自桌面图标的会话可以和浏览器会话分开统计。`
  ];
  return lines.join('\n');
}

function runManifest(flags) {
  const name = readFlag(flags, 'name', { required: true });
  const shortName = readFlag(flags, 'short', { required: true });
  const manifest = generatePwaManifest({
    name,
    shortName,
    description: readFlag(flags, 'description', { fallback: '' }),
    themeColor: readFlag(flags, 'color', { fallback: '#0f172a' }),
    backgroundColor: readFlag(flags, 'background', { fallback: '#0f172a' }),
    startUrl: readFlag(flags, 'start-url', { fallback: '/' }),
    scope: readFlag(flags, 'scope', { fallback: '/' }),
    lang: readFlag(flags, 'lang', { fallback: 'zh-CN' }),
    display: readFlag(flags, 'display', { fallback: 'standalone' }),
    utmSource: readFlag(flags, 'utm-source', { fallback: 'pwa_homescreen' })
  });

  const out = readFlag(flags, 'out', { fallback: undefined });
  if (out) {
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  if (flags.json) {
    return {
      command: 'manifest',
      manifest,
      validation: validateManifest(manifest)
    };
  }
  return out ? `已写入 ${out}\n\n${printHumanManifest(manifest)}` : printHumanManifest(manifest);
}

function inferSignal(flags, trigger, awaySecProvided) {
  const explicit = readFlag(flags, 'signal', { fallback: undefined });
  if (explicit) {
    if (!['back', 'revisit', 'exit_intent'].includes(explicit)) {
      throw new CliError(`--signal 只接受 back / revisit / exit_intent，收到 "${explicit}"`);
    }
    return explicit;
  }
  if (trigger === 'revisit') return 'revisit';
  if (trigger === 'back') return 'back';
  return awaySecProvided ? 'revisit' : 'back';
}

function buildModelFromFlags(flags) {
  const format = readFlag(flags, 'format', { fallback: undefined });
  if (!format) return null;
  const attribution = {
    utm_source: readFlag(flags, 'utm-source', { fallback: undefined }),
    utm_campaign: readFlag(flags, 'utm-campaign', { fallback: undefined }),
    fbclid: readFlag(flags, 'fbclid', { fallback: undefined })
  };
  const cleaned = Object.fromEntries(Object.entries(attribution).filter(([, value]) => value !== undefined));

  if (format === 'popup') {
    return buildReturnViewModel({ format, attribution: cleaned });
  }
  if (format === 'feed') {
    return buildReturnViewModel({
      format,
      attribution: cleaned,
      cards: [
        { title: '继续看这一系列', subtitle: '刚才看到一半的那一期', href: '/series/continue' },
        { title: '换一个更轻松的题材', subtitle: '3 分钟一集，随时能停', href: '/series/light' },
        { title: '本周热播榜单', subtitle: '按本周播放量排序', href: '/series/ranking' }
      ]
    });
  }
  throw new CliError(`--format 只接受 popup / feed，收到 "${format}"`);
}

function runSimulateTrigger(flags) {
  const trigger = readFlag(flags, 'trigger', { fallback: DEFAULT_RETENTION_POLICY.trigger });
  if (!['back', 'revisit', 'both'].includes(trigger)) {
    throw new CliError(`--trigger 只接受 back / revisit / both，收到 "${trigger}"`);
  }
  const awaySecProvided = Object.prototype.hasOwnProperty.call(flags, 'away-sec');
  const signal = inferSignal(flags, trigger, awaySecProvided);
  const dwellMs = readFlag(flags, 'dwell-ms', {
    fallback: 4500,
    type: 'number'
  });
  const awaySec = readFlag(flags, 'away-sec', { fallback: 12, type: 'number' });
  const alreadyConverted = readFlag(flags, 'already-converted', {
    fallback: false,
    type: 'boolean'
  });
  const frequency = readFlag(flags, 'frequency', { fallback: DEFAULT_RETENTION_POLICY.frequency });
  const minDwellMs = readFlag(flags, 'min-dwell-ms', {
    fallback: DEFAULT_RETENTION_POLICY.minDwellMs,
    type: 'number'
  });
  const minAwaySeconds = readFlag(flags, 'min-away-sec', {
    fallback: DEFAULT_RETENTION_POLICY.minAwaySeconds,
    type: 'number'
  });
  const cooldownHours = readFlag(flags, 'cooldown-hours', {
    fallback: DEFAULT_RETENTION_POLICY.cooldownHours,
    type: 'number'
  });
  const lastFiredAt = readFlag(flags, 'last-fired-at', { fallback: null, type: 'number' });
  const now = readFlag(flags, 'now', { fallback: 0, type: 'number' });

  const triggerResult = evaluateRetentionTrigger({
    signal,
    trigger,
    dwellMs,
    minDwellMs,
    awayMs: awaySec * 1000,
    minAwaySeconds
  });

  const gate = shouldFireRetention({
    frequency,
    cooldownHours,
    suppressAfterConversion: DEFAULT_RETENTION_POLICY.suppressAfterConversion,
    converted: alreadyConverted,
    sessionFired: false,
    sessionImpressions: 0,
    maxImpressionsPerSession: DEFAULT_RETENTION_POLICY.maxImpressionsPerSession,
    lastFiredAt,
    now
  });

  const fire = triggerResult.matched && gate.fire;
  const model = fire ? buildModelFromFlags(flags) : null;

  const report = {
    command: 'simulate-trigger',
    policy: {
      trigger,
      minDwellMs,
      minAwaySeconds,
      frequency,
      cooldownHours,
      suppressAfterConversion: DEFAULT_RETENTION_POLICY.suppressAfterConversion,
      maxImpressionsPerSession: DEFAULT_RETENTION_POLICY.maxImpressionsPerSession
    },
    input: {
      signal,
      dwellMs,
      awaySec,
      alreadyConverted
    },
    trigger: { matched: triggerResult.matched, reason: triggerResult.reason },
    gate: { fire: gate.fire, reason: gate.reason },
    decision: {
      fire,
      reason: triggerResult.matched ? gate.reason : triggerResult.reason,
      showFormat: model ? model.format : null
    },
    model
  };

  if (flags.json) return report;

  const lines = [
    `触发模式：${trigger} · 信号：${signal}`,
    `停留：${dwellMs}ms（门槛 ${minDwellMs}ms）· 切后台：${awaySec}s（门槛 ${minAwaySeconds}s）`,
    `已转化：${alreadyConverted ? '是（自动静默）' : '否'} · 频次策略：${frequency}`,
    `触发条件：${triggerResult.matched ? '成立' : `未成立（${triggerResult.reason}）`}`,
    `频次闸门：${gate.fire ? '放行' : `拦截（${gate.reason}）`}`,
    `结论：${fire ? `展示回流页${model ? `（${model.format}）` : ''}` : '不展示'}`
  ];
  if (model) lines.push('', '视图模型：', JSON.stringify(model, null, 2));
  return lines.join('\n');
}

function runDetectPwa(flags) {
  const ua = readFlag(flags, 'ua', { required: true });
  const standalone = flags.standalone === true;
  const strategy = detectInstallStrategy(ua, standalone);
  if (flags.json) {
    return { command: 'detect-pwa', standalone, strategy };
  }
  return [
    `环境：${strategy.environment}`,
    `策略：${strategy.strategy}`,
    `可原生弹安装：${strategy.canPrompt ? '是' : '否'}`,
    `标题：${strategy.title}`,
    '步骤：',
    ...strategy.steps.map((step, index) => `  ${index + 1}. ${step}`)
  ].join('\n');
}

const COMMAND_FLAGS = {
  manifest: new Set([
    'name', 'short', 'description', 'color', 'background', 'start-url', 'scope',
    'lang', 'display', 'utm-source', 'out', 'json', 'help'
  ]),
  'simulate-trigger': new Set([
    'trigger', 'signal', 'dwell-ms', 'away-sec', 'already-converted', 'frequency',
    'min-dwell-ms', 'min-away-sec', 'cooldown-hours', 'last-fired-at', 'now',
    'format', 'utm-source', 'utm-campaign', 'fbclid', 'json', 'help'
  ]),
  'detect-pwa': new Set(['ua', 'standalone', 'json', 'help'])
};

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || positional.length === 0 || positional[0] === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = positional[0];
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, command)) {
    throw new CliError(`未知命令：${command}（可用：manifest / simulate-trigger / detect-pwa）`);
  }
  const allowed = COMMAND_FLAGS[command];
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new CliError(`未知参数：--${key}（${command} 不接受这个参数）`);
  }

  let output;
  if (command === 'manifest') output = runManifest(flags);
  else if (command === 'simulate-trigger') output = runSimulateTrigger(flags);
  else output = runDetectPwa(flags);

  process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
  return 0;
}

try {
  const code = main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`参数错误：${error.message}\n\n用 node cli.mjs --help 查看用法。\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`执行失败：${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
