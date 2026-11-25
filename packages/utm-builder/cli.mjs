#!/usr/bin/env node
/**
 * cli.mjs — UTM 链接生成器的命令行入口。
 *
 * 复用 src/core.mjs 的纯函数核心，与网页版输出逐字节一致。
 *
 * 用法示例：
 *   node cli.mjs example.com/landing --source facebook --medium cpc --campaign spring
 *   node cli.mjs https://example.com/p?a=1#top --source tiktok --json
 *
 * 退出码：0 成功 / 1 内部错误 / 2 输入不合法。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { UTM_KEYS, buildUtmUrl } from './src/core.mjs';

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

/** 命令行长参数 → 标准 UTM 参数名。同时接受 --source 与 --utm_source 两种写法。 */
const FLAG_TO_FIELD = Object.freeze({
  '--source': 'utm_source',
  '--medium': 'utm_medium',
  '--campaign': 'utm_campaign',
  '--term': 'utm_term',
  '--content': 'utm_content',
  '--id': 'utm_id',
  '--utm_source': 'utm_source',
  '--utm_medium': 'utm_medium',
  '--utm_campaign': 'utm_campaign',
  '--utm_term': 'utm_term',
  '--utm_content': 'utm_content',
  '--utm_id': 'utm_id',
});

const HELP = `UTM 链接生成器 CLI

用法：
  node cli.mjs <落地页URL> [参数选项] [--json]

参数选项：
  --source <值>     utm_source（来源，例如 facebook）
  --medium <值>     utm_medium（媒介，例如 cpc）
  --campaign <值>   utm_campaign（活动名）
  --term <值>       utm_term（关键词）
  --content <值>    utm_content（素材区分）
  --id <值>         utm_id（内部编号）
  --json            输出结构化 JSON（含 warnings 与 removedUtmCount）
  -h, --help        显示本帮助

参数也可以写成 --utm_source 这样的完整形式，或用 --source=facebook 赋值。

示例：
  node cli.mjs example.com/landing --source facebook --medium cpc --campaign spring
  node cli.mjs "https://example.com/p?a=1#top" --source tiktok --json

退出码：
  0  成功
  1  内部错误
  2  输入不合法（URL 无法解析、参数缺失或未知）`;

/**
 * 解析 CLI 参数（纯函数，便于单测）。
 *
 * @param {string[]} argv 不含 node 与脚本路径。
 * @returns {{help: boolean, json: boolean, base: string, fields: Record<string, string>, errors: string[]}}
 */
export function parseCliArgs(argv) {
  const parsed = { help: false, json: false, base: '', fields: {}, errors: [] };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const flag = separator === -1 ? arg : arg.slice(0, separator);
      const field = FLAG_TO_FIELD[flag];
      if (!field) {
        parsed.errors.push(`未知参数：${flag}`);
        continue;
      }

      let value = separator === -1 ? undefined : arg.slice(separator + 1);
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          parsed.errors.push(`参数 ${flag} 缺少值`);
          continue;
        }
        value = next;
        index += 1;
      }
      parsed.fields[field] = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      parsed.errors.push(`未知参数：${arg}`);
      continue;
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    parsed.errors.push('只支持一个落地页 URL。');
  }
  parsed.base = positionals.length > 0 ? positionals[0] : '';
  return parsed;
}

/**
 * 按 UTM_KEYS 顺序整理参数，保证输出与参数书写顺序无关。
 * @param {Record<string, string>} fields
 * @returns {Record<string, string>}
 */
export function canonicalFields(fields) {
  const ordered = {};
  for (const key of UTM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      ordered[key] = fields[key];
    }
  }
  return ordered;
}

function reportFailure(parsed, messages, exitCode) {
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors: messages }, null, 2)}\n`);
  } else {
    for (const message of messages) {
      process.stderr.write(`错误：${message}\n`);
    }
    process.stderr.write('\n使用 --help 查看用法。\n');
  }
  return exitCode;
}

/**
 * CLI 入口。
 * @param {string[]} argv 不含 node 与脚本路径。
 * @returns {number} 进程退出码。
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }
  if (parsed.errors.length > 0) {
    return reportFailure(parsed, parsed.errors, EXIT_INVALID_INPUT);
  }
  if (!parsed.base) {
    return reportFailure(parsed, ['缺少落地页 URL。'], EXIT_INVALID_INPUT);
  }

  const result = buildUtmUrl(parsed.base, canonicalFields(parsed.fields));
  if (!result.ok) {
    return reportFailure(
      parsed,
      result.errors.map((error) => error.message),
      EXIT_INVALID_INPUT
    );
  }

  if (parsed.json) {
    const payload = {
      ok: true,
      url: result.url,
      fields: result.fields,
      warnings: result.warnings,
      removedUtmCount: result.removedUtmCount,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT_OK;
  }

  process.stdout.write(`${result.url}\n`);
  for (const warning of result.warnings) {
    process.stderr.write(`提示：${warning.message}\n`);
  }
  return EXIT_OK;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`内部错误：${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = EXIT_INTERNAL;
  }
}
