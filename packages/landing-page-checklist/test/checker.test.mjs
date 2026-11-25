import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  parseArgs,
  RULES,
  AUTO_CHECKLIST_ITEMS,
  MANUAL_ITEMS_COUNT,
  DEFAULT_TIMEOUT_MS
} from '../checker.mjs';

const CHECKER = fileURLToPath(new URL('../checker.mjs', import.meta.url));

/**
 * 一个"各项都合格"的页面。测试用内联字符串，不读文件、不联网。
 */
const GOOD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>出海投放落地页上线前检查清单 37 项</title>
  <meta name="description" content="面向出海投放团队的落地页上线前检查清单：37 项判断标准，涵盖首屏、信任、表单、速度、像素、本地化与合规，逐项说明不合格怎么改。">
  <link rel="canonical" href="https://example.com/pricing">
  <meta name="robots" content="index,follow">
  <script src="/assets/app.js" defer></script>
</head>
<body>
  <h1>上线前，把落地页逐项过一遍</h1>
  <img src="/hero.webp" alt="产品界面截图" width="800" height="600">
  <form action="/submit" method="post">
    <label for="email">邮箱</label>
    <input type="email" id="email" name="email">
  </form>
  <footer><a href="/privacy">隐私说明</a><a href="/terms">条款</a></footer>
</body>
</html>`;

const GOOD_META = {
  url: 'https://example.com/pricing',
  status: 200,
  finalUrl: 'https://example.com/pricing',
  contentType: 'text/html; charset=utf-8',
  bytes: 48 * 1024
};

const meta = (over = {}) => ({ ...GOOD_META, ...over });
const check = (result, id) => result.checks.find((item) => item.id === id);
const statusOf = (result, id) => check(result, id).status;

/** 有 FAIL 时 summary.overall 必须是 fail；无 FAIL 有 WARN 是 warn；全 PASS 是 pass。 */
function assertSummaryConsistent(result) {
  const { pass, warn, fail, total, overall } = result.summary;
  assert.equal(pass + warn + fail, total);
  assert.equal(total, result.checks.length);
  assert.equal(total, RULES.length);
  assert.equal(overall, fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'pass');
}

test('好页面：16 条规则全部 PASS，汇总为 pass', () => {
  const result = analyze(GOOD_HTML, meta());
  assert.deepEqual(
    result.checks.map((item) => `${item.id}:${item.status}`).filter((text) => !text.endsWith(':PASS')),
    []
  );
  assertSummaryConsistent(result);
  assert.equal(result.summary.pass, RULES.length);
  assert.equal(result.summary.warn, 0);
  assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.overall, 'pass');
  assert.equal(result.status, 200);
  assert.equal(result.url, 'https://example.com/pricing');
});

test('无 title：title FAIL', () => {
  const html = GOOD_HTML.replace(/<title>[\s\S]*?<\/title>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'title'), 'FAIL');
  assert.match(check(result, 'title').detail, /没有找到 <title>/);
  assertSummaryConsistent(result);
});

test('title 过长：WARN 并给出实际长度', () => {
  const longTitle = '出海投放落地页上线前检查清单与完整自查指南以及常见问题与逐项说明合集版本包含首屏内容信任表单速度像素本地化合规七个分组共三十七项判断标准';
  const html = GOOD_HTML.replace(/<title>[\s\S]*?<\/title>/, `<title>${longTitle}</title>`);
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'title'), 'WARN');
  assert.match(check(result, 'title').detail, /长度 \d+ 字/);
  assert.match(check(result, 'title').detail, /超出建议范围/);
});

test('title 为空：FAIL', () => {
  const html = GOOD_HTML.replace(/<title>[\s\S]*?<\/title>/, '<title>   </title>');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'title'), 'FAIL');
});

test('无 viewport：viewport FAIL', () => {
  const html = GOOD_HTML.replace(/<meta name="viewport"[^>]*>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'viewport'), 'FAIL');
  assert.match(check(result, 'viewport').detail, /没有 viewport/);
});

test('viewport 缺 width=device-width：WARN', () => {
  const html = GOOD_HTML.replace(
    /<meta name="viewport"[^>]*>/,
    '<meta name="viewport" content="initial-scale=1">'
  );
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'viewport'), 'WARN');
  assert.match(check(result, 'viewport').detail, /device-width/);
});

test('无 html lang：html-lang WARN', () => {
  const html = GOOD_HTML.replace('<html lang="zh-CN">', '<html>');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'html-lang'), 'WARN');
  assert.match(check(result, 'html-lang').detail, /没有 html lang/);
});

test('多个 h1：h1 WARN', () => {
  const html = GOOD_HTML.replace(
    '</body>',
    '<h1>第二个主标题</h1></body>'
  );
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'h1'), 'WARN');
  assert.match(check(result, 'h1').detail, /有 2 个 h1/);
});

test('没有 h1：h1 WARN', () => {
  const html = GOOD_HTML.replace(/<h1>[\s\S]*?<\/h1>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'h1'), 'WARN');
  assert.match(check(result, 'h1').detail, /没有 h1/);
});

test('meta robots 含 noindex：meta-robots FAIL', () => {
  const html = GOOD_HTML.replace(
    /<meta name="robots"[^>]*>/,
    '<meta name="robots" content="noindex,nofollow">'
  );
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'meta-robots'), 'FAIL');
  assertSummaryConsistent(result);
});

test('图片没有 alt：image-alt WARN，缺失比例正确', () => {
  const html = GOOD_HTML.replace(' alt="产品界面截图"', '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'image-alt'), 'WARN');
  assert.match(check(result, 'image-alt').detail, /1\/1 张图片没有 alt/);
});

test('alt="" 视为装饰图：不算缺失', () => {
  const html = GOOD_HTML.replace(' alt="产品界面截图"', ' alt=""');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'image-alt'), 'PASS');
});

test('表单控件没有 label：form-labels WARN', () => {
  const html = GOOD_HTML
    .replace('<label for="email">邮箱</label>', '')
    .replace('id="email"', 'id="email"');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'form-labels'), 'WARN');
  assert.match(check(result, 'form-labels').detail, /1\/1 个控件没有 label/);
});

test('aria-label 也算标签：form-labels PASS', () => {
  const html = GOOD_HTML
    .replace('<label for="email">邮箱</label>', '')
    .replace('<input type="email"', '<input type="email" aria-label="邮箱"');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'form-labels'), 'PASS');
});

test('表单字段超过 5 个：form-fields WARN', () => {
  const extra = Array.from({ length: 5 }, (_, index) => `<input type="text" id="f${index}">`).join('');
  const html = GOOD_HTML.replace('</form>', `${extra}</form>`);
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'form-fields'), 'WARN');
  assert.match(check(result, 'form-fields').detail, /6 个可见字段/);
});

test('http URL：https FAIL（正式环境必须 https）', () => {
  const result = analyze(GOOD_HTML, meta({ url: 'http://example.com/pricing' }));
  assert.equal(statusOf(result, 'https'), 'FAIL');
  assert.match(check(result, 'https').detail, /http:/);
  assertSummaryConsistent(result);
  assert.equal(result.summary.overall, 'fail');
});

test('本地地址 http：https WARN，不判 FAIL', () => {
  const result = analyze(GOOD_HTML, meta({ url: 'http://127.0.0.1:8000/demo.html' }));
  assert.equal(statusOf(result, 'https'), 'WARN');
  assert.match(check(result, 'https').detail, /本地地址/);
});

test('非 200 状态：http-status FAIL', () => {
  const result = analyze(GOOD_HTML, meta({ status: 404 }));
  assert.equal(statusOf(result, 'http-status'), 'FAIL');
  assert.match(check(result, 'http-status').detail, /HTTP 404/);
  assertSummaryConsistent(result);
});

test('redirect 后 finalUrl 不同：状态 PASS 且注明重定向', () => {
  const result = analyze(GOOD_HTML, meta({ finalUrl: 'https://www.example.com/pricing' }));
  assert.equal(statusOf(result, 'http-status'), 'PASS');
  assert.match(check(result, 'http-status').detail, /已重定向到/);
});

test('canonical 缺失：WARN 不 FAIL', () => {
  const html = GOOD_HTML.replace(/<link rel="canonical"[^>]*>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'canonical'), 'WARN');
  assert.match(check(result, 'canonical').detail, /没有 canonical/);
});

test('description 过短：WARN；缺失：FAIL', () => {
  const shortHtml = GOOD_HTML.replace(
    /<meta name="description"[^>]*>/,
    '<meta name="description" content="落地页检查清单">'
  );
  assert.equal(statusOf(analyze(shortHtml, meta()), 'meta-description'), 'WARN');

  const missingHtml = GOOD_HTML.replace(/<meta name="description"[^>]*>/, '');
  assert.equal(statusOf(analyze(missingHtml, meta()), 'meta-description'), 'FAIL');
});

test('页面体积超过 1MB：page-size WARN', () => {
  const result = analyze(GOOD_HTML, meta({ bytes: 2 * 1024 * 1024 }));
  assert.equal(statusOf(result, 'page-size'), 'WARN');
  assert.match(check(result, 'page-size').detail, /超过 1 MB/);
});

test('同一脚本重复引入：script-duplicates WARN', () => {
  const html = GOOD_HTML.replace(
    '</head>',
    '<script src="/assets/app.js"></script></head>'
  );
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'script-duplicates'), 'WARN');
  assert.match(check(result, 'script-duplicates').detail, /app\.js ×2/);
});

test('没有隐私/条款链接：privacy-links WARN', () => {
  const html = GOOD_HTML.replace(/<footer>[\s\S]*?<\/footer>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'privacy-links'), 'WARN');
});

test('没有表单、没有图片：对应检查 PASS（不误报）', () => {
  const html = GOOD_HTML
    .replace(/<form[\s\S]*?<\/form>/, '')
    .replace(/<img[^>]*>/, '');
  const result = analyze(html, meta());
  assert.equal(statusOf(result, 'form-labels'), 'PASS');
  assert.equal(statusOf(result, 'form-fields'), 'PASS');
  assert.equal(statusOf(result, 'image-alt'), 'PASS');
  assert.equal(statusOf(result, 'image-dimensions'), 'PASS');
});

test('每条 check 都带清单编号和局限说明（非工程用户能看懂）', () => {
  const result = analyze(GOOD_HTML, meta());
  for (const item of result.checks) {
    assert.match(item.checklist, /^\d+\.\d+$/, `${item.id} 缺清单编号`);
    assert.ok(item.title.length > 0, `${item.id} 缺标题`);
    assert.ok(item.detail.length > 0, `${item.id} 缺细节`);
    assert.ok(item.limitation.length > 20, `${item.id} 的局限说明太短`);
    assert.match(item.limitation, /判断不了|看不到|只|不/);
  }
});

test('规则表：16 条规则，覆盖 12 个清单编号，12 + 25 = 37', () => {
  assert.equal(RULES.length, 16);
  assert.equal(new Set(RULES.map((rule) => rule.id)).size, RULES.length);
  assert.equal(new Set(RULES.map((rule) => rule.checklist)).size, AUTO_CHECKLIST_ITEMS);
  assert.equal(AUTO_CHECKLIST_ITEMS + MANUAL_ITEMS_COUNT, 37);
});

test('analyze 是纯函数：重复调用结果一致，且不修改入参', () => {
  const metaBefore = structuredClone(GOOD_META);
  const htmlBefore = GOOD_HTML;
  const first = analyze(GOOD_HTML, GOOD_META);
  const second = analyze(GOOD_HTML, GOOD_META);
  assert.deepEqual(first, second);
  assert.deepEqual(GOOD_META, metaBefore);
  assert.equal(GOOD_HTML, htmlBefore);
});

test('analyze 不触发网络：fetch 被禁用时也能跑完', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('测试期间禁止联网');
  };
  try {
    const result = analyze(GOOD_HTML, meta());
    assert.equal(result.checks.length, RULES.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('analyze 非字符串入参：抛 TypeError', () => {
  assert.throws(() => analyze(null, meta()), TypeError);
  assert.throws(() => analyze(undefined, meta()), TypeError);
});

test('parseArgs：默认值、--json、--no-fail、--timeout', () => {
  assert.deepEqual(parseArgs(['https://example.com']), {
    url: 'https://example.com',
    json: false,
    noFail: false,
    timeout: DEFAULT_TIMEOUT_MS,
    help: false
  });
  assert.equal(parseArgs(['https://example.com', '--json', '--no-fail']).json, true);
  assert.equal(parseArgs(['https://example.com', '--no-fail']).noFail, true);
  assert.equal(parseArgs(['--timeout', '3000', 'https://example.com']).timeout, 3000);
  assert.equal(parseArgs(['https://example.com', '--timeout=2500']).timeout, 2500);
});

test('parseArgs：非法参数抛错', () => {
  assert.throws(() => parseArgs(['--timeout']), /--timeout 缺少/);
  assert.throws(() => parseArgs(['https://example.com', '--timeout', 'abc']), /整数毫秒/);
  assert.throws(() => parseArgs(['https://example.com', '--timeout=10']), /整数毫秒/);
  assert.throws(() => parseArgs(['https://example.com', '--nope']), /未知参数/);
  assert.throws(() => parseArgs(['https://a.com', 'https://b.com']), /只接受一个 URL/);
});

test('CLI --help：退出码 0，说明里写明自动/人工比例与退出码', () => {
  const run = spawnSync(process.execPath, [CHECKER, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /用法/);
  assert.match(run.stdout, /退出码/);
  assert.match(run.stdout, /37 项中的 12 项/);
  assert.match(run.stdout, /其余 25 项必须人工判断/);
});

test('CLI 缺 URL：退出码 2，错误输出到 stderr，不发请求', () => {
  const run = spawnSync(process.execPath, [CHECKER, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /缺少要检查的 URL/);
});

test('CLI 非法 URL：退出码 2', () => {
  const run = spawnSync(process.execPath, [CHECKER, 'ftp://example.com/page'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /只支持 http:\/\/ 或 https:\/\//);
});
