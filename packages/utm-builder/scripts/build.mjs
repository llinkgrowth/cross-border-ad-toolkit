#!/usr/bin/env node
/**
 * scripts/build.mjs — 把 src/ 内联成根目录 index.html。
 *
 * 为什么需要构建：产物必须保持「单文件、双击离线可用、零外部请求」，
 * 但源码要拆成 core / app / template / styles 才能测试与维护。
 * 构建只做文本内联，不压缩、不混淆、不引入时间戳，因此输出是确定性的：
 * 同样的 src/ 永远得到同一个 index.html（可用 `--check` 在 CI 里验证）。
 *
 * 用法：
 *   node scripts/build.mjs            # 生成 index.html
 *   node scripts/build.mjs --check    # 只校验磁盘产物是否最新，过期 exit 1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = path.join(ROOT, 'index.html');

/** 构建输入；顺序影响 hash，不要随意调整。 */
const SOURCES = Object.freeze({
  template: 'src/template.html',
  styles: 'src/styles.css',
  core: 'src/core.mjs',
  app: 'src/app.js',
});

const STYLES_MARKER = '<!-- INLINE:styles.css -->';
const CODE_MARKER = '<!-- INLINE:core+app -->';

/** core.mjs 的公开符号；构建时转成 window.UTMCore 的成员。 */
const CORE_EXPORTS = Object.freeze([
  'UTM_KEYS',
  'ERROR_CODES',
  'WARNING_CODES',
  'normalizeBaseUrl',
  'parseQuery',
  'collectParams',
  'stripUtmParams',
  'validateFields',
  'buildUtmUrl',
]);

/** 统一换行符，保证 macOS / Linux / Windows 构建结果一致。 */
function normalize(source) {
  return source.replace(/\r\n?/g, '\n');
}

function readSource(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  return normalize(readFileSync(absolutePath, 'utf8'));
}

/** 只替换恰好出现一次的标记；缺失或重复都说明模板坏了。 */
function replaceMarker(template, marker, replacement) {
  const occurrences = template.split(marker).length - 1;
  if (occurrences !== 1) {
    throw new Error(`模板标记 ${marker} 应出现 1 次，实际 ${occurrences} 次`);
  }
  return template.replace(marker, replacement);
}

/** 去掉 core.mjs 顶层的 `export ` 关键字，让它能作为普通脚本内联。 */
function stripEsmExports(source) {
  return source.replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
}

function assertInlineSafe(label, source) {
  if (source.includes('</script')) {
    throw new Error(`${label} 含有 </script，不能直接内联`);
  }
}

function buildStyles(stylesSource) {
  if (stylesSource.includes('</style')) {
    throw new Error('src/styles.css 含有 </style，不能直接内联');
  }
  return `<style>\n${stylesSource.trimEnd()}\n</style>`;
}

function buildCode(coreSource, appSource) {
  const core = stripEsmExports(coreSource).trimEnd();
  assertInlineSafe('src/core.mjs', core);
  assertInlineSafe('src/app.js', appSource);

  const namespace = CORE_EXPORTS.map((name) => `    ${name}: ${name},`).join('\n');

  return [
    '<script>',
    '(function () {',
    "  'use strict';",
    '',
    '  /* ===== src/core.mjs（去 export 后内联） ===== */',
    core,
    '',
    '  /* DOM 层只通过 window.UTMCore 使用核心逻辑，不直接依赖源码路径。 */',
    '  window.UTMCore = Object.freeze({',
    namespace,
    '  });',
    '',
    '  /* ===== src/app.js ===== */',
    appSource.trimEnd(),
    '})();',
    '</script>',
  ].join('\n');
}

function buildBanner(hash) {
  return [
    '<!--',
    '  AUTO-GENERATED FILE — DO NOT EDIT.',
    '  Source:  src/template.html + src/styles.css + src/core.mjs + src/app.js',
    '  Rebuild: npm run build',
    '  Verify:  npm run check',
    `  SHA-256: ${hash}`,
    '-->',
  ].join('\n');
}

/**
 * 生成完整 HTML 字符串（纯函数，不写盘）。
 * @returns {{html: string, hash: string}}
 */
export function buildPage() {
  const template = readSource(SOURCES.template);
  const styles = readSource(SOURCES.styles);
  const core = readSource(SOURCES.core);
  const app = readSource(SOURCES.app);

  const hash = createHash('sha256')
    .update([template, styles, core, app].join('\n'))
    .digest('hex');

  let html = replaceMarker(template, STYLES_MARKER, buildStyles(styles));
  html = replaceMarker(html, CODE_MARKER, buildCode(core, app));

  return { html: `${buildBanner(hash)}\n${html.trimEnd()}\n`, hash };
}

/**
 * CLI 入口。
 * @param {string[]} argv 不含 node 与脚本路径。
 * @returns {number} 进程退出码：0 成功 / 1 校验失败或构建错误。
 */
export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}`);
    console.error('用法：node scripts/build.mjs [--check]');
    return 1;
  }

  let built;
  try {
    built = buildPage();
  } catch (error) {
    console.error(`构建失败：${error.message}`);
    return 1;
  }

  if (argv.includes('--check')) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error('index.html 不存在，请先运行 npm run build。');
      return 1;
    }
    const current = normalize(readFileSync(OUTPUT_PATH, 'utf8'));
    if (current !== built.html) {
      const actualHash = createHash('sha256').update(current).digest('hex');
      console.error('index.html 与 src/ 不一致，请运行 npm run build 并提交产物。');
      console.error(`  expected sha256: ${built.hash}`);
      console.error(`  actual   sha256: ${actualHash}`);
      return 1;
    }
    console.log(`index.html 已是最新（sha256 ${built.hash.slice(0, 12)}…）`);
    return 0;
  }

  writeFileSync(OUTPUT_PATH, built.html, 'utf8');
  console.log(
    `已生成 index.html（${Buffer.byteLength(built.html, 'utf8')} 字节，sha256 ${built.hash.slice(0, 12)}…）`
  );
  return 0;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  process.exitCode = main();
}
