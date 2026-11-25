#!/usr/bin/env node
/**
 * cli.mjs — 零依赖命令行入口。
 *
 * 用法：
 *   node cli.mjs list
 *   node cli.mjs check-i18n
 *   node cli.mjs render --template cod-single-page --locale ar --out /tmp/cod-ar.html
 *
 * 退出码：0 成功 / 1 检查发现错误 / 2 用法错误（未知命令、模板或语言）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_LOCALES_DIR,
  DEFAULT_TEMPLATES_DIR,
  checkI18n,
  getPath,
  listLocales,
  listTemplates,
  loadLocale,
  renderPage,
} from './src/i18n-builder.mjs';

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;

/** `list` 命令里每套模板的一句话说明（与 README 保持一致）。 */
const TEMPLATE_DESCRIPTIONS = Object.freeze({
  'cod-single-page': 'COD cash-on-delivery single product page',
  'whatsapp-lead-page': 'WhatsApp chat-first lead page',
  'pwa-app-landing': 'Installable PWA app landing page',
});

const HELP = `Landing Page Starter Demos CLI

用法：
  node cli.mjs list
      列出 3 套模板与 4 套语言包

  node cli.mjs check-i18n
      校验语言包 key 对齐、缺词、按钮文案长度、货币/数字格式

  node cli.mjs render --template <name> --locale <code> [--out <file>]
      渲染指定模板到 HTML；省略 --out 时输出到 stdout

  node cli.mjs --help
      显示本帮助

示例：
  node cli.mjs render --template cod-single-page --locale ar --out /tmp/cod-ar.html
  node cli.mjs render --template pwa-app-landing --locale en --out /tmp/pwa-en.html

退出码：
  0  成功
  1  check-i18n 发现错误
  2  用法错误（未知命令 / 未知模板 / 未知语言 / 缺少参数）`;

/**
 * 解析 CLI 参数（纯函数，便于单测）。
 * @param {string[]} argv 不含 node 与脚本路径。
 * @returns {{command: string, flags: Record<string, string>, help: boolean, errors: string[]}}
 */
export function parseCliArgs(argv) {
  const parsed = { command: '', flags: {}, help: false, errors: [] };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const flag = separator === -1 ? arg : arg.slice(0, separator);
      let value = separator === -1 ? undefined : arg.slice(separator + 1);
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          parsed.errors = [...parsed.errors, `参数 ${flag} 缺少值`];
          continue;
        }
        index += 1;
      }
      parsed.flags[flag] = value;
      continue;
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    parsed.errors = [...parsed.errors, `未知的多余参数：${positionals.slice(1).join(' ')}`];
  }
  parsed.command = positionals.length > 0 ? positionals[0] : '';
  return parsed;
}

function printList() {
  const templates = listTemplates(DEFAULT_TEMPLATES_DIR);
  const locales = listLocales(DEFAULT_LOCALES_DIR);

  console.log(`Templates (${templates.length})`);
  for (const name of templates) {
    console.log(`  ${name.padEnd(22)} ${TEMPLATE_DESCRIPTIONS[name] ?? ''}`.trimEnd());
  }

  console.log(`\nLocales (${locales.length})`);
  for (const code of locales) {
    const data = loadLocale(code, DEFAULT_LOCALES_DIR);
    const label = getPath(data, '_meta.label') ?? code;
    const direction = getPath(data, '_meta.direction') ?? 'ltr';
    const count = Object.keys(getPath(data, 'messages') ?? {}).length;
    console.log(`  ${code.padEnd(4)} ${String(label).padEnd(12)} ${direction.padEnd(4)} ${count} sections`);
  }
  return EXIT_OK;
}

function printCheck() {
  const report = checkI18n();
  console.log(
    `多语言检查：${report.locales.length} 套语言包 · ${report.templates.length} 套模板 · ${report.keyCount} 个词条`
  );
  console.log(`语言包：${report.locales.join(', ')}`);
  console.log(`模板：${report.templates.join(', ')}`);

  for (const warning of report.warnings) {
    console.log(`[预警] ${warning.message}`);
  }
  for (const error of report.errors) {
    console.log(`[错误] ${error.message}`);
  }

  console.log(`\n结果：${report.errors.length} 个错误 · ${report.warnings.length} 个预警`);
  if (!report.ok) {
    console.log('检查未通过：请先修复上面的错误。');
    return EXIT_CHECK_FAILED;
  }
  return EXIT_OK;
}

function printRender(parsed) {
  const templateName = parsed.flags['--template'];
  const localeName = parsed.flags['--locale'];

  if (!templateName || !localeName) {
    console.error('错误：render 需要 --template 与 --locale。');
    console.error('示例：node cli.mjs render --template cod-single-page --locale en --out /tmp/cod-en.html');
    return EXIT_USAGE;
  }

  const templates = listTemplates(DEFAULT_TEMPLATES_DIR);
  if (!templates.includes(templateName)) {
    console.error(`错误：未知模板 ${templateName}（可选：${templates.join(', ')}）`);
    return EXIT_USAGE;
  }
  const locales = listLocales(DEFAULT_LOCALES_DIR);
  if (!locales.includes(localeName)) {
    console.error(`错误：未知语言 ${localeName}（可选：${locales.join(', ')}）`);
    return EXIT_USAGE;
  }

  const rendered = renderPage({ templateName, localeName });
  for (const warning of rendered.warnings) {
    console.error(`预警：${warning.message}`);
  }

  const outPath = parsed.flags['--out'];
  if (!outPath) {
    process.stdout.write(rendered.html);
    return EXIT_OK;
  }

  const absolute = path.resolve(outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, rendered.html, 'utf8');
  console.log(
    `已渲染 ${templateName} · ${localeName}（dir=${rendered.direction}，${Buffer.byteLength(rendered.html, 'utf8')} 字节）`
  );
  console.log(`输出：${absolute}`);
  return EXIT_OK;
}

/**
 * CLI 入口。
 * @param {string[]} argv
 * @returns {number} 进程退出码。
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);

  if (parsed.help || !parsed.command) {
    console.log(HELP);
    return parsed.help ? EXIT_OK : EXIT_USAGE;
  }
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) console.error(`错误：${message}`);
    console.error('使用 --help 查看用法。');
    return EXIT_USAGE;
  }

  switch (parsed.command) {
    case 'list':
      return printList();
    case 'check-i18n':
      return printCheck();
    case 'render':
      return printRender(parsed);
    default:
      console.error(`错误：未知命令 ${parsed.command}`);
      console.error('使用 --help 查看用法。');
      return EXIT_USAGE;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`内部错误：${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
