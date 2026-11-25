/**
 * src/i18n-builder.mjs — 零依赖的多语言静态页面构建与校验器。
 *
 * 能力：
 * 1. 渲染模板里的 `{{t.section.key}}`（文本）与 `{{n.key}}`（数字，按语言格式化）；
 * 2. 阿语/希伯来语等 RTL 语言自动给 <html> 注入 dir="rtl"；
 * 3. 校验语言包 key 对齐、缺词、按钮文案超长（相对英语 >40%）、货币与数字格式；
 * 4. 注入语言切换器，并用 `withLocaleParam()` 在切换时保留全部 URL 查询参数（UTM 不丢）。
 *
 * 说明：本文件只依赖 Node 内置模块；核心逻辑（渲染、校验、格式化）都是可单测的纯函数。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
export const DEFAULT_LOCALES_DIR = path.join(REPO_ROOT, 'locales');
export const BASE_LOCALE = 'en';

/** 语言切换时使用的查询参数名。 */
const LOCALE_PARAM = 'lang';
/** 模板中语言切换器的占位标记。 */
export const SWITCHER_MARKER = '<!-- I18N:SWITCHER -->';
/** 按钮文案长度预警阈值：比英语长 40% 以上就提示可能撑破按钮。 */
export const BUTTON_OVERFLOW_RATIO = 1.4;
/** 太短的按钮（如 OK）不做比例对比，避免误报。 */
const MIN_BUTTON_BASE_LENGTH = 4;
/** 从右到左书写的语言。 */
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);
/** 以这些片段结尾的 key 被视为按钮文案。 */
export const BUTTON_KEY_SEGMENTS = new Set([
  'cta',
  'button',
  'btn',
  'submit',
  'close',
  'open',
  'send',
]);

/** {{t.foo.bar}} / {{n.orders}} */
const PLACEHOLDER_RE = /\{\{\s*([tn])\.([A-Za-z0-9_.-]+)\s*\}\}/g;
const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export const ERROR_CODES = Object.freeze({
  BAD_JSON: 'BAD_JSON',
  NO_BASE_LOCALE: 'NO_BASE_LOCALE',
  META_MISSING: 'META_MISSING',
  CURRENCY_CODE: 'CURRENCY_CODE',
  CURRENCY_SYMBOL: 'CURRENCY_SYMBOL',
  CURRENCY_POSITION: 'CURRENCY_POSITION',
  NUMBER_FORMAT: 'NUMBER_FORMAT',
  NUMBER_SEPARATORS: 'NUMBER_SEPARATORS',
  NUMBER_DIGITS: 'NUMBER_DIGITS',
  KEY_MISSING: 'KEY_MISSING',
  KEY_EXTRA: 'KEY_EXTRA',
  TEMPLATE_MARKER: 'TEMPLATE_MARKER',
  TEMPLATE_PLACEHOLDER: 'TEMPLATE_PLACEHOLDER',
  NO_TEMPLATES: 'NO_TEMPLATES',
});

export const WARNING_CODES = Object.freeze({
  BUTTON_TOO_LONG: 'BUTTON_TOO_LONG',
  MISSING_TRANSLATION: 'MISSING_TRANSLATION',
  MISSING_NUMBER: 'MISSING_NUMBER',
  SYMBOL_LONG: 'SYMBOL_LONG',
});

/** HTML 转义：文本节点与属性值共用，避免模板注入。 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** 读取点分路径，例如 getPath(data, 'cod.hero.title')。 */
export function getPath(source, dottedPath) {
  let cursor = source;
  for (const segment of String(dottedPath).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** 是否 RTL：语言代码兜底 + `_meta.direction` 显式声明。 */
export function isRtl(localeName, localeData) {
  const declared = getPath(localeData, '_meta.direction');
  if (declared === 'rtl') return true;
  if (declared === 'ltr') return false;
  return RTL_LOCALES.has(String(localeName).toLowerCase().split('-')[0]);
}

/** 数字格式化：千分位 + 小数位 + 可选阿拉伯-印度数字。 */
export function formatNumber(value, numberFormat = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';

  const decimal = numberFormat.decimal ?? '.';
  const thousands = numberFormat.thousands ?? ',';
  const digits = numberFormat.digits ?? 'latn';
  const sign = numeric < 0 ? '-' : '';
  const [whole, fraction = ''] = String(Math.abs(numeric)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  const plain = fraction ? `${grouped}${decimal}${fraction}` : grouped;

  if (digits !== 'arab') return sign + plain;
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return sign + plain.replace(/[0-9]/g, (digit) => arabicDigits[Number(digit)]);
}

/** 货币格式化：symbol + position 由语言包 `_meta.currency` 决定。 */
export function formatCurrency(amount, localeData) {
  const numberFormat = getPath(localeData, '_meta.numberFormat') ?? {};
  const currency = getPath(localeData, '_meta.currency') ?? {};
  const formatted = formatNumber(amount, numberFormat);
  const symbol = currency.symbol ?? currency.code ?? '';
  return currency.position === 'after' ? `${formatted} ${symbol}` : `${symbol} ${formatted}`;
}

/**
 * 生成切换语言后的 URL，同时保留现有查询参数（UTM 不丢失）。
 * 该函数会被序列化进页面脚本，因此保持无外部依赖、可直接在浏览器运行。
 */
export function withLocaleParam(pathname, search, localeName, hash = '') {
  const params = new URLSearchParams(search || '');
  params.set('lang', localeName);
  const query = params.toString();
  return `${pathname || ''}${query ? '?' + query : ''}${hash || ''}`;
}

/** 收集模板里的占位符，去重并按出现顺序返回。 */
export function collectPlaceholders(templateHtml) {
  const messages = [];
  const numbers = [];
  for (const match of String(templateHtml).matchAll(PLACEHOLDER_RE)) {
    const [, kind, key] = match;
    const bucket = kind === 't' ? messages : numbers;
    if (!bucket.includes(key)) bucket.push(key);
  }
  return { messages, numbers };
}

/** 按钮文案 key 判定：只看最后一段，避免把 pwa.install.step1 误判成按钮。 */
export function isButtonKey(key) {
  const segments = String(key).split('.');
  return BUTTON_KEY_SEGMENTS.has(segments[segments.length - 1]);
}

/** 把嵌套语言包拍平成 `section.key` 映射，便于比较 key 集合。 */
export function flattenMessages(localeData) {
  const flat = new Map();
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object') {
      flat.set(prefix, node);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(getPath(localeData, 'messages') ?? {}, '');
  return flat;
}

/** 给 <html> 写入 lang 与 dir，替换模板里可能已有的旧值。 */
export function applyHtmlLocale(templateHtml, localeName, direction) {
  const htmlTag = /<html\b([^>]*)>/i;
  if (!htmlTag.test(templateHtml)) {
    throw new Error('模板缺少 <html> 标签，无法注入语言方向');
  }
  return templateHtml.replace(htmlTag, (_whole, attrs) => {
    const cleaned = attrs
      .replace(/\s(?:lang|dir)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .trimEnd();
    return `<html${cleaned} lang="${escapeHtml(localeName)}" dir="${direction}">`;
  });
}

/**
 * 语言切换器：静态链接 + 运行时补全 UTM 查询参数。
 * 运行时逻辑直接复用上面已测试的 withLocaleParam()。
 */
export function buildLocaleSwitcher(currentLocale, locales, labelText) {
  const links = locales
    .map(({ code, label }) => {
      const current = code === currentLocale;
      const aria = current ? ' aria-current="true"' : '';
      return (
        `<a class="i18n-switcher__link" data-locale-switch="${escapeHtml(code)}"` +
        ` hreflang="${escapeHtml(code)}" lang="${escapeHtml(code)}"` +
        ` href="?${LOCALE_PARAM}=${encodeURIComponent(code)}"${aria}>${escapeHtml(label)}</a>`
      );
    })
    .join('\n      ');

  return `<nav class="i18n-switcher" aria-label="${escapeHtml(labelText)}">
      <span class="i18n-switcher__label">${escapeHtml(labelText)}</span>
      ${links}
    </nav>
    <script>
    (function () {
      'use strict';
      var withLocaleParam = ${withLocaleParam.toString()};
      var links = document.querySelectorAll('[data-locale-switch]');
      Array.prototype.forEach.call(links, function (link) {
        link.href = withLocaleParam(
          location.pathname,
          location.search,
          link.getAttribute('data-locale-switch'),
          location.hash
        );
      });
    })();
    </script>`;
}

/**
 * 渲染一个模板（纯函数，不读文件）。
 *
 * @param {object} options
 * @param {string} options.templateHtml 含占位符的模板源码。
 * @param {string} options.localeName 语言代码，如 ar。
 * @param {object} options.localeData 当前语言包。
 * @param {object} [options.fallbackLocaleData] 缺词时回退的语言包（通常是 en）。
 * @param {Array<{code: string, label: string}>} options.locales 全部语言，用于切换器。
 * @param {object} [options.commonLabels] 额外文案（如 common.language）。
 * @returns {{html: string, direction: string, missing: string[], warnings: object[]}}
 */
export function renderTemplate(options) {
  const {
    templateHtml,
    localeName,
    localeData,
    fallbackLocaleData,
    locales,
    commonLabels,
  } = options;

  if (typeof templateHtml !== 'string' || !templateHtml) {
    throw new Error('renderTemplate 需要 templateHtml');
  }
  const markerCount = templateHtml.split(SWITCHER_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(`模板中 ${SWITCHER_MARKER} 应出现 1 次，实际 ${markerCount} 次`);
  }

  const placeholders = collectPlaceholders(templateHtml);
  const missing = [];
  const warnings = [];
  let html = templateHtml;

  const languageLabel = getPath(commonLabels, 'language') ?? 'Language';
  const switcher = buildLocaleSwitcher(localeName, locales, languageLabel);
  html = html.replace(SWITCHER_MARKER, switcher);

  for (const key of placeholders.messages) {
    const value = getPath(localeData, `messages.${key}`);
    if (typeof value === 'string') {
      html = html.split(`{{t.${key}}}`).join(escapeHtml(value));
      continue;
    }
    const fallback = getPath(fallbackLocaleData, `messages.${key}`);
    missing.push(`t.${key}`);
    warnings.push({
      code: WARNING_CODES.MISSING_TRANSLATION,
      locale: localeName,
      key,
      message: `${localeName} 缺少词条 ${key}，已回退到 ${BASE_LOCALE}`,
    });
    if (typeof fallback === 'string') {
      html = html.split(`{{t.${key}}}`).join(escapeHtml(fallback));
    }
  }

  const numberFormat = getPath(localeData, '_meta.numberFormat');
  const fallbackNumberFormat = getPath(fallbackLocaleData, '_meta.numberFormat');
  for (const key of placeholders.numbers) {
    const value = getPath(localeData, `numbers.${key}`);
    const fallbackValue = getPath(fallbackLocaleData, `numbers.${key}`);
    const resolved = value ?? fallbackValue;
    if (resolved === undefined) missing.push(`n.${key}`);
    else if (value === undefined) {
      missing.push(`n.${key}`);
      warnings.push({
        code: WARNING_CODES.MISSING_NUMBER,
        locale: localeName,
        key,
        message: `${localeName} 缺少数字 ${key}，已回退到 ${BASE_LOCALE}`,
      });
    }
    const formatted = formatNumber(resolved ?? 0, numberFormat ?? fallbackNumberFormat);
    html = html.split(`{{n.${key}}}`).join(formatted);
  }

  const direction = isRtl(localeName, localeData) ? 'rtl' : 'ltr';
  html = applyHtmlLocale(html, localeName, direction);

  return { html, direction, missing, warnings };
}

/**
 * 按钮文案长度校验：以英语为基线，超过 40% 触发预警。
 * @returns {Array<object>} 预警列表。
 */
export function validateButtonLengths(localeMap, options = {}) {
  const baseLocale = options.baseLocale ?? BASE_LOCALE;
  const ratioLimit = options.ratio ?? BUTTON_OVERFLOW_RATIO;
  const baseMessages = flattenMessages(localeMap[baseLocale]);
  if (baseMessages.size === 0) return [];

  const warnings = [];
  for (const [localeName, localeData] of Object.entries(localeMap)) {
    if (localeName === baseLocale) continue;
    for (const [key, value] of flattenMessages(localeData)) {
      if (!isButtonKey(key) || typeof value !== 'string') continue;
      const baseValue = baseMessages.get(key);
      if (typeof baseValue !== 'string') continue;
      const baseLength = Array.from(baseValue).length;
      const length = Array.from(value).length;
      if (baseLength < MIN_BUTTON_BASE_LENGTH) continue;
      const ratio = length / baseLength;
      if (ratio > ratioLimit) {
        warnings.push({
          code: WARNING_CODES.BUTTON_TOO_LONG,
          locale: localeName,
          key,
          baseLength,
          length,
          percent: Math.round((ratio - 1) * 100),
          message:
            `${localeName} 的按钮文案 ${key} 比 ${baseLocale} 长 ` +
            `${Math.round((ratio - 1) * 100)}%（阈值 ${Math.round((ratioLimit - 1) * 100)}%），可能撑破按钮`,
        });
      }
    }
  }
  return warnings;
}

/** 货币与数字格式校验。 */
export function validateCurrencyAndNumbers(localeName, localeData) {
  const errors = [];
  const warnings = [];
  const pushError = (code, message) =>
    errors.push({ code, locale: localeName, message });

  const meta = getPath(localeData, '_meta');
  if (!meta || typeof meta !== 'object') {
    pushError(ERROR_CODES.META_MISSING, `${localeName} 缺少 _meta 元数据`);
    return { errors, warnings };
  }

  const currency = meta.currency;
  if (!currency || typeof currency !== 'object') {
    pushError(ERROR_CODES.META_MISSING, `${localeName} 缺少 _meta.currency`);
  } else {
    if (!/^[A-Z]{3}$/.test(String(currency.code ?? ''))) {
      pushError(ERROR_CODES.CURRENCY_CODE, `${localeName} 的货币代码必须是 3 位大写字母`);
    }
    if (typeof currency.symbol !== 'string' || !currency.symbol.trim()) {
      pushError(ERROR_CODES.CURRENCY_SYMBOL, `${localeName} 缺少货币符号`);
    } else if (Array.from(currency.symbol).length > 4) {
      warnings.push({
        code: WARNING_CODES.SYMBOL_LONG,
        locale: localeName,
        message: `${localeName} 的货币符号偏长（${currency.symbol}），窄按钮里可能显示不全`,
      });
    }
    if (!['before', 'after'].includes(currency.position)) {
      pushError(ERROR_CODES.CURRENCY_POSITION, `${localeName} 的货币位置只能是 before / after`);
    }
  }

  const numberFormat = meta.numberFormat;
  if (!numberFormat || typeof numberFormat !== 'object') {
    pushError(ERROR_CODES.NUMBER_FORMAT, `${localeName} 缺少 _meta.numberFormat`);
    return { errors, warnings };
  }
  const decimal = String(numberFormat.decimal ?? '');
  const thousands = String(numberFormat.thousands ?? '');
  if (decimal.length !== 1 || thousands.length !== 1 || decimal === thousands) {
    pushError(
      ERROR_CODES.NUMBER_SEPARATORS,
      `${localeName} 的小数点与千分位必须是两个不同的单字符`
    );
  }
  if (!['latn', 'arab'].includes(numberFormat.digits ?? 'latn')) {
    pushError(ERROR_CODES.NUMBER_DIGITS, `${localeName} 的 digits 只能是 latn / arab`);
  }
  if (errors.length === 0) {
    const sample = formatNumber(1234567.89, numberFormat);
    if (!sample.includes(thousands) || !sample.includes(decimal)) {
      pushError(ERROR_CODES.NUMBER_FORMAT, `${localeName} 的数字格式化结果不符合声明的分隔符`);
    }
  }

  return { errors, warnings };
}

/** 安全读取语言包列表（只读 *.json，按文件名排序，保证确定性）。 */
export function listLocales(localesDir = DEFAULT_LOCALES_DIR) {
  return readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function loadLocale(localeName, localesDir = DEFAULT_LOCALES_DIR) {
  const filePath = path.join(localesDir, `${localeName}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** 读取全部语言包，返回 { locale名: 数据 }。 */
export function loadLocales(localesDir = DEFAULT_LOCALES_DIR) {
  const localeMap = {};
  for (const name of listLocales(localesDir)) {
    localeMap[name] = loadLocale(name, localesDir);
  }
  return localeMap;
}

/** 模板列表：只认包含 index.html 的子目录。 */
export function listTemplates(templatesDir = DEFAULT_TEMPLATES_DIR) {
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(path.join(templatesDir, name, 'index.html'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

export function loadTemplate(templateName, templatesDir = DEFAULT_TEMPLATES_DIR) {
  return readFileSync(path.join(templatesDir, templateName, 'index.html'), 'utf8');
}

/** 语言包的展示信息，用于切换器。 */
export function localeLabels(localeMap) {
  return Object.entries(localeMap)
    .map(([code, data]) => ({
      code,
      label: getPath(data, '_meta.label') ?? code.toUpperCase(),
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

/** 校验语言包：JSON、元数据、key 对齐、按钮长度、数字/货币。 */
export function checkLocales(localesDir = DEFAULT_LOCALES_DIR) {
  const errors = [];
  const warnings = [];
  const localeMap = {};
  const names = listLocales(localesDir);

  for (const name of names) {
    try {
      localeMap[name] = loadLocale(name, localesDir);
    } catch (error) {
      errors.push({
        code: ERROR_CODES.BAD_JSON,
        locale: name,
        message: `${name}.json 解析失败：${error.message}`,
      });
    }
  }

  if (!localeMap[BASE_LOCALE]) {
    errors.push({
      code: ERROR_CODES.NO_BASE_LOCALE,
      message: `缺少基准语言包 ${BASE_LOCALE}.json`,
    });
    return { ok: false, errors, warnings, locales: names, keyCount: 0 };
  }

  const baseKeys = flattenMessages(localeMap[BASE_LOCALE]);
  for (const [name, data] of Object.entries(localeMap)) {
    const format = validateCurrencyAndNumbers(name, data);
    errors.push(...format.errors);
    warnings.push(...format.warnings);

    if (name === BASE_LOCALE) continue;
    const keys = flattenMessages(data);
    for (const key of baseKeys.keys()) {
      if (!keys.has(key)) {
        errors.push({
          code: ERROR_CODES.KEY_MISSING,
          locale: name,
          key,
          message: `${name} 缺少 key：${key}`,
        });
      }
    }
    for (const key of keys.keys()) {
      if (!baseKeys.has(key)) {
        errors.push({
          code: ERROR_CODES.KEY_EXTRA,
          locale: name,
          key,
          message: `${name} 多出未知 key：${key}`,
        });
      }
    }
  }

  warnings.push(...validateButtonLengths(localeMap));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    locales: names,
    keyCount: baseKeys.size,
  };
}

/** 校验模板：切换器标记存在、占位符在基准语言里都有词条。 */
export function checkTemplates(templatesDir = DEFAULT_TEMPLATES_DIR, localesDir = DEFAULT_LOCALES_DIR) {
  const errors = [];
  const details = [];
  const baseMessages = flattenMessages(loadLocale(BASE_LOCALE, localesDir));
  const templates = listTemplates(templatesDir);

  if (templates.length === 0) {
    errors.push({ code: ERROR_CODES.NO_TEMPLATES, message: '没有找到任何模板' });
  }

  for (const name of templates) {
    const html = loadTemplate(name, templatesDir);
    const markerCount = html.split(SWITCHER_MARKER).length - 1;
    if (markerCount !== 1) {
      errors.push({
        code: ERROR_CODES.TEMPLATE_MARKER,
        template: name,
        message: `${name} 的 ${SWITCHER_MARKER} 应出现 1 次，实际 ${markerCount} 次`,
      });
    }
    const placeholders = collectPlaceholders(html);
    for (const key of placeholders.messages) {
      if (!baseMessages.has(key)) {
        errors.push({
          code: ERROR_CODES.TEMPLATE_PLACEHOLDER,
          template: name,
          key,
          message: `${name} 使用了基准语言里不存在的词条：${key}`,
        });
      }
    }
    details.push({ template: name, placeholders });
  }

  return { ok: errors.length === 0, errors, warnings: [], templates, details };
}

/** 全量检查：语言包 + 模板 + 每个模板 × 每个语言的实际渲染。 */
export function checkI18n(options = {}) {
  const localesDir = options.localesDir ?? DEFAULT_LOCALES_DIR;
  const templatesDir = options.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const localeReport = checkLocales(localesDir);
  const templateReport = checkTemplates(templatesDir, localesDir);
  const errors = [...localeReport.errors, ...templateReport.errors];
  const warnings = [...localeReport.warnings];
  const localeMap = localeReport.locales.length > 0 ? loadLocales(localesDir) : {};
  const locales = localeLabels(localeMap);
  const commonLabel = getPath(localeMap[BASE_LOCALE], `messages.common.language`);

  for (const templateName of templateReport.templates) {
    const templateHtml = loadTemplate(templateName, templatesDir);
    for (const localeName of Object.keys(localeMap)) {
      const rendered = renderTemplate({
        templateHtml,
        localeName,
        localeData: localeMap[localeName],
        fallbackLocaleData: localeMap[BASE_LOCALE],
        locales,
        commonLabels: { language: commonLabel },
      });
      for (const key of rendered.missing) {
        errors.push({
          code: key.startsWith('n.') ? ERROR_CODES.TEMPLATE_PLACEHOLDER : ERROR_CODES.KEY_MISSING,
          locale: localeName,
          template: templateName,
          key,
          message: `${templateName} 渲染 ${localeName} 时缺少 ${key}`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    locales: localeReport.locales,
    templates: templateReport.templates,
    keyCount: localeReport.keyCount,
  };
}

/**
 * 读取文件并渲染一页，供 CLI / 测试使用。
 * @returns {{html: string, direction: string, missing: string[], warnings: object[]}}
 */
export function renderPage(options) {
  const {
    templateName,
    localeName,
    localesDir = DEFAULT_LOCALES_DIR,
    templatesDir = DEFAULT_TEMPLATES_DIR,
  } = options;

  const localeMap = loadLocales(localesDir);
  const localeData = localeMap[localeName];
  if (!localeData) {
    throw new Error(`未知语言：${localeName}（可选：${Object.keys(localeMap).join(', ')}）`);
  }
  const templateHtml = loadTemplate(templateName, templatesDir);
  if (!templateHtml) {
    throw new Error(`未知模板：${templateName}`);
  }

  return renderTemplate({
    templateHtml,
    localeName,
    localeData,
    fallbackLocaleData: localeMap[BASE_LOCALE],
    locales: localeLabels(localeMap),
    commonLabels: { language: getPath(localeMap[BASE_LOCALE], 'messages.common.language') },
  });
}
