#!/usr/bin/env node
/**
 * src/verify-browser.mjs — 可选的真实浏览器行为校验。
 *
 * 目的：防止 DOM 层（app.js）与纯函数核心（core.mjs）脱节。
 * 做法：
 *   1. 在 Node 里用 core 算出每个用例的期望结果；
 *   2. 把同样的输入注入构建好的 index.html，在 headless Chrome 里跑一遍；
 *   3. 逐条对比输出 URL、状态文案与错误态。
 *
 * 需要本机安装 Chrome / Chromium，不联网，不参与 npm test（CI 常规任务不依赖浏览器）。
 *
 * 用法：
 *   node src/verify-browser.mjs
 *   CHROME_PATH=/path/to/chrome node src/verify-browser.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildUtmUrl } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(HERE, '..', 'index.html');
const PROBE_ID = 'probe-result';
const RESULT_PATTERN = new RegExp(`<pre id="${PROBE_ID}">([^<]*)</pre>`);
const MAX_CHROME_OUTPUT = 64 * 1024 * 1024;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** 与 app.js 一致的 UI 常量，用来构造期望值。 */
const EMPTY_OUTPUT_TEXT = '填写上面的落地页 URL 和至少一个参数，这里会实时生成链接。';
const NO_FIELDS_STATUS = '还没有填写参数，加一个 utm_source 就能生成。';

/** 覆盖正常、清理、编码、错误、空状态；只选 Node 与浏览器结果一致的用例。 */
const CASES = [
  { name: 'auto-protocol', base: 'example.com/landing', fields: { utm_source: 'facebook', utm_medium: 'social' } },
  { name: 'strip-keep-query-hash', base: 'https://example.com/path?a=1&utm_source=old&b=2#frag', fields: { utm_source: 'new', utm_campaign: 'spring sale' } },
  { name: 'localhost-http', base: 'http://localhost:3000', fields: { utm_source: 'fb' } },
  { name: 'legacy-ipv4', base: '192.168.1.5:8080/landing', fields: { utm_source: 'ip' } },
  { name: 'no-fields', base: 'example.com', fields: {} },
  { name: 'invalid-url', base: 'http://', fields: { utm_source: 'x' } },
  { name: 'dotless-host', base: 'example', fields: { utm_source: 'x' } },
  { name: 'unicode', base: 'https://例子.cn/路径', fields: { utm_campaign: '春季 大促' } },
  { name: 'blank-query', base: 'https://example.com/?', fields: { utm_source: 'a' } },
  { name: 'flag-pair', base: 'https://example.com/cb?x=1&flag', fields: { utm_id: '007' } },
  { name: 'empty-base', base: '', fields: { utm_source: 'x' } },
  { name: 'ipv6-loopback', base: '[::1]:8080/app?utm_medium=old#h', fields: { utm_source: 'v6', utm_medium: 'social' } },
  { name: 'uppercase-utm', base: 'HTTPS://EXAMPLE.COM/Path?UTM_Source=old#Frag', fields: { utm_source: 'up' } },
  { name: 'encoded-and-spaces', base: 'https://example.com/p?a=%E4%B8%AD&utm_campaign=old', fields: { utm_content: '视频 A' } },
  { name: 'spaces-base', base: '   ', fields: { utm_source: 'x' } },
];

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** 用 Node 核心推导页面应显示的内容，逻辑与 app.js 的 build()/render() 对齐。 */
function expectedView(base, fields) {
  const result = buildUtmUrl(base, fields);

  if (result.empty) {
    return { out: EMPTY_OUTPUT_TEXT, status: '', invalid: false };
  }
  if (!result.ok) {
    return { out: EMPTY_OUTPUT_TEXT, status: result.error, invalid: true };
  }

  let status = '';
  if (!result.fieldCount) {
    status = NO_FIELDS_STATUS;
  } else {
    status = `已生成 · ${result.fieldCount} 个参数`;
    if (result.removedUtmCount) {
      status += ` · 已覆盖原有 ${result.removedUtmCount} 个 utm_* 参数`;
    }
  }

  return { out: result.url || EMPTY_OUTPUT_TEXT, status, invalid: false };
}

function makeProbeHtml(html, cases) {
  const injection = `<script>
window.addEventListener('load', function () {
  var cases = ${JSON.stringify(cases)};
  var out = document.getElementById('out');
  var status = document.getElementById('status');
  var base = document.getElementById('baseUrl');
  function setFields(fields) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (input) {
      input.value = fields[input.getAttribute('data-key')] || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  var results = cases.map(function (item) {
    setFields({});
    base.value = item.base;
    base.dispatchEvent(new Event('input', { bubbles: true }));
    var onlyBase = { out: out.textContent, status: status.textContent, invalid: base.classList.contains('invalid') };
    setFields(item.fields || {});
    return { name: item.name, onlyBase: onlyBase, out: out.textContent, status: status.textContent, invalid: base.classList.contains('invalid') };
  });
  var pre = document.createElement('pre');
  pre.id = '${PROBE_ID}';
  pre.textContent = encodeURIComponent(JSON.stringify(results));
  document.body.appendChild(pre);
});
</script>`;

  if (!html.includes('</body>')) {
    throw new Error('index.html 缺少 </body>，无法注入校验脚本');
  }
  return html.replace('</body>', `${injection}\n</body>`);
}

function runInChrome(chrome, html, cases) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'utm-builder-verify-'));
  try {
    const probePath = path.join(workspace, 'probe.html');
    writeFileSync(probePath, makeProbeHtml(html, cases), 'utf8');

    const dumped = execFileSync(
      chrome,
      [
        '--headless=new',
        // 容器/CI 内无法初始化 Chrome 自身沙箱；这是本地校验脚本，页面只读本地文件。
        '--no-sandbox',
        '--disable-gpu',
        '--disable-crashpad',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(workspace, 'profile')}`,
        '--virtual-time-budget=3000',
        '--dump-dom',
        `file://${probePath}`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: MAX_CHROME_OUTPUT,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const match = dumped.match(RESULT_PATTERN);
    if (!match) throw new Error('未在 Chrome 输出中找到校验结果（页面脚本可能报错）');
    return JSON.parse(decodeURIComponent(match[1]));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('跳过：未找到 Chrome / Chromium。可设置 CHROME_PATH 后重试。');
    return 0;
  }
  if (!existsSync(INDEX_PATH)) {
    console.error('index.html 不存在，请先运行 npm run build。');
    return 1;
  }

  const html = readFileSync(INDEX_PATH, 'utf8');
  const actual = runInChrome(chrome, html, CASES);
  const failures = [];

  for (const [index, item] of CASES.entries()) {
    // 页面先只填 base（参数为空），再填参数；两步都要对齐核心逻辑。
    const expected = {
      onlyBase: expectedView(item.base, {}),
      ...expectedView(item.base, item.fields),
    };
    const observed = actual[index];
    const comparable = {
      onlyBase: observed.onlyBase,
      out: observed.out,
      status: observed.status,
      invalid: observed.invalid,
    };
    if (JSON.stringify(expected) !== JSON.stringify(comparable)) {
      failures.push({ name: item.name, expected, observed: comparable });
    }
  }

  if (failures.length > 0) {
    console.error(`浏览器行为与核心逻辑不一致：${failures.length}/${CASES.length} 个用例失败`);
    console.error(JSON.stringify(failures, null, 2));
    return 1;
  }

  console.log(`浏览器校验通过：${CASES.length}/${CASES.length} 个用例与 Node 核心一致（${chrome}）`);
  return 0;
}

process.exitCode = main();
