/**
 * test/starter.test.mjs — 模板结构、多语言渲染、RTL、校验器与 CLI 的回归测试。
 *
 * 运行：node --test
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUTTON_OVERFLOW_RATIO,
  DEFAULT_LOCALES_DIR,
  DEFAULT_TEMPLATES_DIR,
  ERROR_CODES,
  SWITCHER_MARKER,
  WARNING_CODES,
  applyHtmlLocale,
  checkI18n,
  checkLocales,
  checkTemplates,
  collectPlaceholders,
  flattenMessages,
  formatCurrency,
  formatNumber,
  listLocales,
  listTemplates,
  loadLocales,
  loadTemplate,
  renderPage,
  renderTemplate,
  validateButtonLengths,
  validateCurrencyAndNumbers,
  withLocaleParam,
} from '../src/i18n-builder.mjs';
import { parseCliArgs } from '../cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli.mjs');
const TEMPLATES = listTemplates();
const LOCALES = listLocales();
const LOCALE_MAP = loadLocales();

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function withTempDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'starter-demos-test-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('模板结构', () => {
  it('恰好提供 3 套模板，每套都有 index.html', () => {
    assert.deepEqual(TEMPLATES, ['cod-single-page', 'pwa-app-landing', 'whatsapp-lead-page']);
    for (const name of TEMPLATES) {
      const html = loadTemplate(name);
      assert.match(html, /^<!DOCTYPE html>/i, `${name} 缺少 doctype`);
      assert.match(html, /<\/html>\s*$/i, `${name} 缺少闭合 html`);
      assert.ok(html.length > 3000, `${name} 内容过短`);
    }
  });

  it('每套模板恰好有一个语言切换器标记', () => {
    for (const name of TEMPLATES) {
      const count = loadTemplate(name).split(SWITCHER_MARKER).length - 1;
      assert.equal(count, 1, `${name} 的切换器标记数量不正确`);
    }
  });

  it('COD 模板包含卖点、规格选择、地址表单、倒计时与订单预览弹窗', () => {
    const html = loadTemplate('cod-single-page');
    assert.match(html, /<form id="cod-form"/);
    assert.match(html, /<dialog id="order-dialog"/);
    assert.match(html, /id="countdown"/);
    assert.match(html, /name="color"/);
    assert.match(html, /name="size"/);
    assert.match(html, /name="phone"/);
    assert.match(html, /required/);
    assert.match(html, /\{\{t\.cod\.hero\.badge\}\}/);
  });

  it('WhatsApp 模板包含对比卡、FAQ 折叠、悬浮 CTA 与 wa.me 链接预览', () => {
    const html = loadTemplate('whatsapp-lead-page');
    assert.match(html, /class="compare"/);
    assert.ok((html.match(/<details/g) ?? []).length >= 3);
    assert.match(html, /class="sticky-cta"/);
    assert.match(html, /id="wa-url"/);
    assert.match(html, /https:\/\/wa\.me\//);
    assert.match(html, /data-wa-phone=/);
    assert.match(html, /utm_/i);
  });

  it('PWA 模板包含 manifest、截图栏、安装按钮与 Service Worker 注册', () => {
    const html = loadTemplate('pwa-app-landing');
    assert.match(html, /<link rel="manifest" href="manifest.json">/);
    assert.ok((html.match(/class="shot"/g) ?? []).length >= 3);
    assert.match(html, /id="install-button"/);
    assert.match(html, /beforeinstallprompt/);
    assert.match(html, /serviceWorker\.register\('sw\.js'\)/);
    assert.match(html, /id="net-status"/);
  });

  it('三套模板都不引用外部脚本、样式、图片或字体', () => {
    for (const name of TEMPLATES) {
      const html = loadTemplate(name);
      assert.equal(
        /<(script|link|img|iframe|source)[^>]+(src|href)=["']https?:/i.test(html),
        false,
        `${name} 引用了外部资源`
      );
      assert.equal(/@import\s+url\(\s*["']?https?:/i.test(html), false, `${name} 引入了外部 CSS`);
      assert.equal(/font-face[\s\S]*?https?:/i.test(html), false, `${name} 引入了外部字体`);
      assert.equal(/XMLHttpRequest|fetch\s*\(/i.test(html), false, `${name} 发起了网络请求`);
    }
  });

  it('三套模板都不出现货币价格或受限类目词', () => {
    const forbidden = /adult|casino|gambling|betting|forex|stock\s*tips/i;
    for (const name of TEMPLATES) {
      const html = loadTemplate(name);
      assert.equal(/[$€£¥]\s?\d/.test(html), false, `${name} 出现了货币价格`);
      assert.equal(/\b(?:USD|EUR|GBP)\b\s?\d/.test(html), false, `${name} 出现了货币代码 + 数字`);
      assert.equal(forbidden.test(html), false, `${name} 出现了受限类目词`);
    }
  });
});

describe('PWA 静态资产', () => {
  it('manifest.json 可解析且字段完整', () => {
    const file = path.join(DEFAULT_TEMPLATES_DIR, 'pwa-app-landing', 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './index.html');
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
    assert.ok(manifest.icons.length >= 2);
    for (const icon of manifest.icons) {
      const iconPath = path.join(DEFAULT_TEMPLATES_DIR, 'pwa-app-landing', icon.src);
      assert.ok(existsSync(iconPath), `图标不存在：${icon.src}`);
    }
  });

  it('sw.js 预缓存的应用外壳文件都存在', () => {
    const swPath = path.join(DEFAULT_TEMPLATES_DIR, 'pwa-app-landing', 'sw.js');
    const source = readFileSync(swPath, 'utf8');
    assert.match(source, /CACHE_NAME/);
    for (const event of ['install', 'activate', 'fetch']) {
      assert.match(source, new RegExp(`addEventListener\\('${event}'`), `缺少 ${event} 事件`);
    }
    const shellMatch = source.match(/const APP_SHELL = \[([\s\S]*?)\];/);
    assert.ok(shellMatch, '缺少 APP_SHELL 列表');
    const entries = [...shellMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(entries.length >= 5);
    const baseDir = path.join(DEFAULT_TEMPLATES_DIR, 'pwa-app-landing');
    for (const entry of entries) {
      const relative = entry === './' ? 'index.html' : entry.replace(/^\.\//, '');
      assert.ok(existsSync(path.join(baseDir, relative)), `预缓存路径不存在：${entry}`);
    }
  });

  it('本地 SVG 图标存在且可被解析为 SVG', () => {
    const iconDir = path.join(DEFAULT_TEMPLATES_DIR, 'pwa-app-landing', 'icons');
    const files = readdirSync(iconDir).filter((file) => file.endsWith('.svg'));
    assert.deepEqual(files.sort(), ['icon-192.svg', 'icon-512.svg']);
    for (const file of files) {
      assert.match(readFileSync(path.join(iconDir, file), 'utf8'), /^<svg[\s\S]*<\/svg>\s*$/);
    }
  });
});

describe('语言包契约', () => {
  it('提供 en / ar / es / pt 四套语言', () => {
    assert.deepEqual(LOCALES, ['ar', 'en', 'es', 'pt']);
  });

  it('阿语声明 rtl，其余声明 ltr', () => {
    assert.equal(LOCALE_MAP.ar._meta.direction, 'rtl');
    for (const code of ['en', 'es', 'pt']) {
      assert.equal(LOCALE_MAP[code]._meta.direction, 'ltr');
    }
  });

  it('四套语言包的词条 key 完全对齐', () => {
    const baseKeys = [...flattenMessages(LOCALE_MAP.en).keys()].sort();
    assert.equal(baseKeys.length, 148);
    for (const code of LOCALES) {
      assert.deepEqual([...flattenMessages(LOCALE_MAP[code]).keys()].sort(), baseKeys, `${code} key 不对齐`);
    }
  });

  it('货币代码、货币位置与数字格式合法', () => {
    for (const code of LOCALES) {
      const report = validateCurrencyAndNumbers(code, LOCALE_MAP[code]);
      assert.deepEqual(report.errors, [], `${code} 元数据有错误`);
    }
  });

  it('仓库内置语言包通过 checkLocales', () => {
    const report = checkLocales();
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    assert.equal(report.keyCount, 148);
  });
});

describe('RTL 与多语言渲染', () => {
  it('阿语渲染自动注入 dir="rtl" 与 lang="ar"', () => {
    const rendered = renderPage({ templateName: 'cod-single-page', localeName: 'ar' });
    assert.equal(rendered.direction, 'rtl');
    assert.match(rendered.html, /<html lang="ar" dir="rtl">/);
    assert.ok(rendered.html.includes(LOCALE_MAP.ar.messages.cod.hero.title));
  });

  it('英语渲染保持 dir="ltr"', () => {
    const rendered = renderPage({ templateName: 'pwa-app-landing', localeName: 'en' });
    assert.equal(rendered.direction, 'ltr');
    assert.match(rendered.html, /<html lang="en" dir="ltr">/);
  });

  it('西语与葡语使用各自词条', () => {
    const es = renderPage({ templateName: 'whatsapp-lead-page', localeName: 'es' });
    const pt = renderPage({ templateName: 'whatsapp-lead-page', localeName: 'pt' });
    assert.ok(es.html.includes(LOCALE_MAP.es.messages.whatsapp.hero.title));
    assert.ok(pt.html.includes(LOCALE_MAP.pt.messages.whatsapp.hero.title));
    assert.match(es.html, /<html lang="es" dir="ltr">/);
  });

  it('3 套模板 × 4 套语言共 12 次渲染无残留占位符、无缺失词条', () => {
    for (const templateName of TEMPLATES) {
      for (const localeName of LOCALES) {
        const rendered = renderPage({ templateName, localeName });
        assert.equal(rendered.missing.length, 0, `${templateName}/${localeName} 缺词`);
        assert.equal(rendered.html.includes('{{'), false, `${templateName}/${localeName} 残留占位符`);
        assert.equal(rendered.html.includes(SWITCHER_MARKER), false, `${templateName}/${localeName} 标记未替换`);
      }
    }
  });

  it('渲染结果注入四种语言切换链接，并保留 UTM 查询参数', () => {
    const rendered = renderPage({ templateName: 'cod-single-page', localeName: 'ar' });
    assert.equal((rendered.html.match(/data-locale-switch="/g) ?? []).length, 4);
    assert.match(rendered.html, /class="i18n-switcher"/);
    assert.match(rendered.html, /URLSearchParams/);
    assert.match(rendered.html, /location\.search/);
    assert.match(rendered.html, /withLocaleParam/);
  });

  it('RTL 直接用 CSS 逻辑属性实现镜像，而不是另写一套样式', () => {
    for (const name of TEMPLATES) {
      const html = loadTemplate(name);
      assert.match(html, /(?:margin|padding|inset|border)-(?:inline|block)/, `${name} 未使用逻辑属性`);
    }
  });

  it('渲染结果不再引用任何外部资源', () => {
    for (const templateName of TEMPLATES) {
      const { html } = renderPage({ templateName, localeName: 'ar' });
      assert.equal(
        /<(script|link|img|iframe|source)[^>]+(src|href)=["']https?:/i.test(html),
        false,
        `${templateName} 渲染后出现外部资源`
      );
      assert.equal(/<script[^>]+src=/i.test(html), false, `${templateName} 有外链脚本`);
    }
  });
});

describe('占位符、转义与方向注入', () => {
  it('collectPlaceholders 提取文本与数字占位符并去重', () => {
    const result = collectPlaceholders('{{t.a.b}} {{t.a.b}} {{ n.orders }} {{t.c}}');
    assert.deepEqual(result.messages, ['a.b', 'c']);
    assert.deepEqual(result.numbers, ['orders']);
  });

  it('词条中的 HTML 会被转义，避免注入', () => {
    const html = '<html><body>{{t.hero.title}}<!-- I18N:SWITCHER --></body></html>';
    const rendered = renderTemplate({
      templateHtml: html,
      localeName: 'en',
      localeData: { messages: { hero: { title: '<img src=x onerror=alert(1)>' } }, numbers: {} },
      fallbackLocaleData: { messages: {}, numbers: {} },
      locales: [{ code: 'en', label: 'English' }],
      commonLabels: { language: 'Language' },
    });
    assert.equal(rendered.html.includes('<img'), false);
    assert.ok(rendered.html.includes('&lt;img'));
  });

  it('缺词时回退到英语并给出预警，而不是渲染空白', () => {
    const templateHtml = '<html><body>{{t.hero.title}}</body><!-- I18N:SWITCHER --></html>';
    const rendered = renderTemplate({
      templateHtml,
      localeName: 'es',
      localeData: { _meta: {}, messages: { hero: {} }, numbers: {} },
      fallbackLocaleData: { _meta: {}, messages: { hero: { title: 'Fallback title' } }, numbers: {} },
      locales: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Español' }],
      commonLabels: { language: 'Language' },
    });
    assert.ok(rendered.html.includes('Fallback title'));
    assert.equal(rendered.html.includes('{{'), false);
    assert.ok(rendered.warnings.some((warning) => warning.code === WARNING_CODES.MISSING_TRANSLATION));
  });

  it('applyHtmlLocale 替换已有 lang/dir，不重复属性', () => {
    const html = applyHtmlLocale('<html lang="fr" dir="ltr" class="x"><body></body></html>', 'ar', 'rtl');
    assert.match(html, /<html class="x" lang="ar" dir="rtl">/);
    assert.equal((html.match(/lang=/g) ?? []).length, 1);
    assert.equal((html.match(/dir=/g) ?? []).length, 1);
  });

  it('切换语言时保留全部 UTM 参数与 hash', () => {
    assert.equal(
      withLocaleParam('/p', '?utm_source=facebook&utm_campaign=spring&a=1', 'ar', '#top'),
      '/p?utm_source=facebook&utm_campaign=spring&a=1&lang=ar#top'
    );
    assert.equal(withLocaleParam('/p', '', 'es'), '/p?lang=es');
    assert.equal(
      withLocaleParam('/p', '?lang=en&utm_medium=cpc', 'pt'),
      '/p?lang=pt&utm_medium=cpc'
    );
  });
});

describe('数字 / 货币格式', () => {
  it('按语言格式化千分位与小数', () => {
    assert.equal(formatNumber(1234567.89, { decimal: '.', thousands: ',', digits: 'latn' }), '1,234,567.89');
    assert.equal(formatNumber(1234567.89, { decimal: ',', thousands: '.', digits: 'latn' }), '1.234.567,89');
    assert.equal(formatNumber(1234567.89, { decimal: '٫', thousands: '٬', digits: 'arab' }), '١٬٢٣٤٬٥٦٧٫٨٩');
    assert.equal(formatNumber(12000, { decimal: '.', thousands: ',' }), '12,000');
  });

  it('货币符号按前后位置拼装', () => {
    assert.equal(formatCurrency(1234.5, LOCALE_MAP.en), '$ 1,234.5');
    assert.equal(formatCurrency(1234.5, LOCALE_MAP.ar), '١٬٢٣٤٫٥ ر.س');
  });

  it('非数字输入返回占位符而不是 NaN', () => {
    assert.equal(formatNumber('abc'), '—');
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), '—');
  });

  it('错误的货币/数字元数据会被校验器报错', () => {
    const broken = {
      _meta: {
        currency: { code: 'usd', symbol: '', position: 'middle' },
        numberFormat: { decimal: '.', thousands: '.', digits: 'roman' },
      },
      messages: { common: { language: 'X' } },
      numbers: {},
    };
    const { errors } = validateCurrencyAndNumbers('xx', broken);
    const codes = errors.map((error) => error.code);
    assert.ok(codes.includes(ERROR_CODES.CURRENCY_CODE));
    assert.ok(codes.includes(ERROR_CODES.CURRENCY_SYMBOL));
    assert.ok(codes.includes(ERROR_CODES.CURRENCY_POSITION));
    assert.ok(codes.includes(ERROR_CODES.NUMBER_SEPARATORS));
    assert.ok(codes.includes(ERROR_CODES.NUMBER_DIGITS));
  });
});

describe('按钮文案防撑破', () => {
  const base = {
    messages: {
      cod: { hero: { cta: 'Chat now' }, form: { title: 'A very long normal sentence that is not a button' } },
    },
  };
  const makeLocale = (cta, title = 'A very long normal sentence that is not a button') => ({
    messages: { cod: { hero: { cta }, form: { title } } },
  });

  it('超过 40% 触发预警，并给出比例', () => {
    const long = makeLocale('Chat now please wait'); // 20 / 8 = 150%
    const warnings = validateButtonLengths({ en: base, es: long });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, WARNING_CODES.BUTTON_TOO_LONG);
    assert.equal(warnings[0].key, 'cod.hero.cta');
    assert.equal(warnings[0].locale, 'es');
    assert.ok(warnings[0].percent > 40);
  });

  it('未超过 40% 不预警，超过才预警', () => {
    // 基准 "Chat now" 长度 8；40% 阈值对应 11.2 字符。
    assert.equal(BUTTON_OVERFLOW_RATIO, 1.4);
    assert.equal(validateButtonLengths({ en: base, es: makeLocale('12345678901') }).length, 0);
    assert.equal(validateButtonLengths({ en: base, es: makeLocale('123456789012') }).length, 1);
  });

  it('非按钮 key 文案再长也不预警', () => {
    const longTitle = makeLocale('Short', 'x'.repeat(200));
    assert.deepEqual(validateButtonLengths({ en: base, es: longTitle }), []);
  });

  it('基准文案过短（< 4 字符）时跳过比例对比', () => {
    const shortBase = { messages: { cod: { hero: { cta: 'OK' } } } };
    const long = { messages: { cod: { hero: { cta: 'Okay then, sure thing' } } } };
    assert.deepEqual(validateButtonLengths({ en: shortBase, es: long }), []);
  });
});

describe('语言包对齐检查器', () => {
  it('临时语言包缺 key 时报 KEY_MISSING', () => {
    withTempDir((dir) => {
      const meta = { _meta: LOCALE_MAP.en._meta, numbers: { orders: 1 } };
      writeFileSync(
        path.join(dir, 'en.json'),
        JSON.stringify({ ...meta, messages: { common: { language: 'Language', demo: { badge: 'Demo' } } } })
      );
      writeFileSync(
        path.join(dir, 'es.json'),
        JSON.stringify({ ...meta, messages: { common: { language: 'Idioma' } } })
      );
      const report = checkLocales(dir);
      assert.equal(report.ok, false);
      assert.ok(report.errors.some((error) => error.code === ERROR_CODES.KEY_MISSING));
    });
  });

  it('临时语言包多 key 时报 KEY_EXTRA', () => {
    withTempDir((dir) => {
      const meta = { _meta: LOCALE_MAP.en._meta, numbers: {} };
      writeFileSync(
        path.join(dir, 'en.json'),
        JSON.stringify({ ...meta, messages: { common: { language: 'Language' } } })
      );
      writeFileSync(
        path.join(dir, 'es.json'),
        JSON.stringify({ ...meta, messages: { common: { language: 'Idioma', extra: 'Extra' } } })
      );
      const report = checkLocales(dir);
      assert.ok(report.errors.some((error) => error.code === ERROR_CODES.KEY_EXTRA));
    });
  });

  it('损坏的 JSON 被捕获为 BAD_JSON', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'en.json'), '{ not json');
      writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ messages: {} }));
      const report = checkLocales(dir);
      assert.ok(report.errors.some((error) => error.code === ERROR_CODES.BAD_JSON));
      assert.equal(report.ok, false);
    });
  });

  it('仓库全量检查通过：0 错误、3 模板、4 语言', () => {
    const report = checkI18n();
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    assert.equal(report.templates.length, 3);
    assert.equal(report.locales.length, 4);
    assert.equal(report.keyCount, 148);
  });

  it('checkTemplates 通过且每套模板占位符都能在基准语言找到', () => {
    const report = checkTemplates();
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    for (const detail of report.details) {
      assert.ok(detail.placeholders.messages.length > 0);
    }
  });
});

describe('CLI', () => {
  it('parseCliArgs 解析 render 参数（含 = 写法）', () => {
    const parsed = parseCliArgs([
      'render',
      '--template=cod-single-page',
      '--locale',
      'ar',
      '--out',
      '/tmp/x.html',
    ]);
    assert.equal(parsed.command, 'render');
    assert.deepEqual(parsed.flags, {
      '--template': 'cod-single-page',
      '--locale': 'ar',
      '--out': '/tmp/x.html',
    });
    assert.deepEqual(parsed.errors, []);
  });

  it('parseCliArgs 记录缺失值与多余位置参数', () => {
    const parsed = parseCliArgs(['render', '--template', '--locale', 'ar', 'extra']);
    assert.ok(parsed.errors.some((message) => message.includes('--template')));
    assert.ok(parsed.errors.some((message) => message.includes('多余参数')));
  });

  it('list 列出 3 套模板与 4 套语言', () => {
    const result = runCli(['list']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Templates \(3\)/);
    assert.match(result.stdout, /Locales \(4\)/);
    for (const name of TEMPLATES) assert.ok(result.stdout.includes(name));
    for (const code of LOCALES) assert.ok(result.stdout.includes(code));
  });

  it('check-i18n 退出码 0 且报告 0 错误', () => {
    const result = runCli(['check-i18n']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 个错误/);
    assert.match(result.stdout, /148 个词条/);
  });

  it('render 生成阿语 RTL 页面到指定文件', () => {
    withTempDir((dir) => {
      const out = path.join(dir, 'cod-ar.html');
      const result = runCli(['render', '--template', 'cod-single-page', '--locale', 'ar', '--out', out]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(out));
      const html = readFileSync(out, 'utf8');
      assert.match(html, /<html lang="ar" dir="rtl">/);
      assert.equal(html.includes('{{'), false);
      assert.ok(html.includes(LOCALE_MAP.ar.messages.cod.hero.title));
    });
  });

  it('render 无 --out 时输出到 stdout', () => {
    const result = runCli(['render', '--template', 'pwa-app-landing', '--locale', 'en']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^<!DOCTYPE html>/i);
    assert.match(result.stdout, /<html lang="en" dir="ltr">/);
    assert.match(result.stdout, /href="manifest\.json"/);
  });

  it('render 未知模板 / 未知语言退出码 2', () => {
    withTempDir((dir) => {
      const out = path.join(dir, 'x.html');
      assert.equal(runCli(['render', '--template', 'nope', '--locale', 'en', '--out', out]).status, 2);
      assert.equal(runCli(['render', '--template', 'cod-single-page', '--locale', 'xx', '--out', out]).status, 2);
      assert.equal(runCli(['render', '--locale', 'en']).status, 2);
    });
  });

  it('未知命令退出码 2', () => {
    const result = runCli(['unknown-command']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /未知命令/);
  });
});
