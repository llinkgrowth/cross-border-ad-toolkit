#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

/**
 * 落地页自动检查器 · landing-page-checklist
 *
 * 零第三方依赖，Node >= 20。
 *
 * 设计约定：
 *  - analyze(html, meta) 是纯函数：输入 HTML 字符串 + 响应元信息，输出检查结果；
 *    不联网、不读写文件、不依赖时间/随机数，方便单测。
 *  - 只请求目标 URL 一次，不执行页面脚本、不发 Cookie、不写文件、不上传任何内容。
 *  - 16 条自动规则覆盖清单 37 项中的 12 项；其余 25 项必须人工判断（见 docs/automation.md）。
 */

export const MANUAL_ITEMS_COUNT = 25;
export const AUTO_CHECKLIST_ITEMS = 12;

/**
 * 规则表。每条规则对应 37 项清单里的一个编号（checklist），
 * limitation 写清"自动检查判断不了什么"，会原样出现在 --json 输出里。
 */
export const RULES = [
  {
    id: 'https',
    checklist: '4.4',
    title: 'HTTPS 可访问',
    limitation:
      '只检查入口 URL 的协议与可达性；页面里的站内链接、外链没有逐个请求，证书有效期与混合内容不判断。'
  },
  {
    id: 'http-status',
    checklist: '7.4',
    title: 'HTTP 状态 200',
    limitation:
      '只代表入口这一条 URL 能打开；「从广告链接点到提交成功全程无断点」仍然要人工真机走一遍。'
  },
  {
    id: 'title',
    checklist: '4.5',
    title: 'title 标签存在且长度合适',
    limitation:
      '只量字符数，判断不了标题是否说清「给谁 + 解决什么」，也判断不了是否只有一个主张；英文标题按字符计，60 字符的英文标题通常不算超。'
  },
  {
    id: 'meta-description',
    checklist: '4.5',
    title: 'meta description 存在且长度合适',
    limitation:
      '只量长度与是否存在，判断不了描述与页面内容是否一致；搜索引擎也可能自行改写摘要。'
  },
  {
    id: 'canonical',
    checklist: '4.5',
    title: 'canonical 链接',
    limitation:
      '只检查有没有声明及是否为空，不校验它指向的页面能不能打开、是否与当前 URL 一致（www / 大小写差异可能误报）。'
  },
  {
    id: 'meta-robots',
    checklist: '4.5',
    title: 'meta robots 没有误写 noindex',
    limitation:
      '只识别 meta 标签里的 noindex；X-Robots-Tag 响应头、robots.txt、JS 注入的 noindex 都看不到，上线后仍要用搜索引擎工具确认。'
  },
  {
    id: 'viewport',
    checklist: '1.5',
    title: 'viewport 已声明',
    limitation:
      '只保证手机不会按桌面宽度缩放；首屏内容是否被遮挡、是否横向滚动，要真机看。'
  },
  {
    id: 'html-lang',
    checklist: '6.1',
    title: 'html lang 已声明',
    limitation:
      '只检查 lang 属性有没有写；判断不了语言与投放地区是否真的匹配，也判断不了翻译质量。'
  },
  {
    id: 'h1',
    checklist: '1.2',
    title: 'h1 数量为 1',
    limitation:
      '只数 h1 标签个数，判断不了标题里是不是只有一个主张、是不是「既……又……还……」。'
  },
  {
    id: 'image-alt',
    checklist: '4.5',
    title: '图片 alt 缺失比例',
    limitation:
      '只数 alt 属性是否写了、是否为空；装饰性图标、CSS 背景图、内联 SVG 容易被误判，alt 是否贴切也判断不了。'
  },
  {
    id: 'image-dimensions',
    checklist: '4.2',
    title: '图片声明了尺寸或响应式来源',
    limitation:
      '只看 width/height 属性与 srcset，判断不了实际文件格式（WebP/AVIF）与单张体积，图片是否真的压缩过要另行检查。'
  },
  {
    id: 'form-labels',
    checklist: '3.2',
    title: '表单控件有 label 或 aria-label',
    limitation:
      '只检查可读标签是否存在，判断不了校验提示语是否说清「怎么改」；只有 placeholder 的输入框会被判缺标签（常见误报）。'
  },
  {
    id: 'form-fields',
    checklist: '3.1',
    title: '表单字段数量',
    limitation:
      '只数字段个数，判断不了每个字段是否「必须现在填」；多步骤表单只统计 HTML 里出现的那一步。'
  },
  {
    id: 'page-size',
    checklist: '4.1',
    title: 'HTML 体积不超过 1MB',
    limitation:
      '只量 HTML 文本体积，不含图片/字体/脚本；体积大通常更慢，但不等于 LCP 一定超过 2.5 秒，真实速度要测。'
  },
  {
    id: 'script-duplicates',
    checklist: '5.1',
    title: '同一脚本没有重复引入',
    limitation:
      '只比较 <script src> 重复；内联初始化代码、通过脚本动态注入的像素看不到，像素是否真的只触发一次要人工用调试工具确认。'
  },
  {
    id: 'privacy-links',
    checklist: '7.1',
    title: '页面有隐私/条款入口',
    limitation:
      '只按链接文字与 href 关键字找入口，判断不了内容是否齐全、是否符合投放地区要求；页脚用图片按钮的会漏判。'
  }
];

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

const UA =
  'landing-page-checklist/0.1 (+https://github.com/ipcloak/landing-page-checklist; checker only, no cookies)';

/** 本地地址：http 是正常的，不把 HTTPS 判成 FAIL。 */
const LOCAL_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

const MAX_HTML_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// 解析工具（全部纯字符串操作，不用 DOM）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

/** 只处理常见实体；不认识的原样保留。 */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 去掉注释、脚本、样式，避免把 JS/CSS 里的字符串当成结构。 */
export function stripNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** 把标签字符串解析成小写属性表（同名属性取第一个）。 */
export function parseAttrs(tag) {
  const body = String(tag)
    .replace(/^<\s*\/?\s*[a-zA-Z0-9:-]+/, '')
    .replace(/\/?\s*>$/, '');
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function textLength(text) {
  return Array.from(String(text)).length;
}

function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function readTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapse(decodeEntities(match[1])) : '';
}

function readMeta(html) {
  const map = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseAttrs(tag);
    const name = (attrs.name || attrs.property || '').toLowerCase();
    if (name && !map.has(name)) map.set(name, attrs.content || '');
  }
  return map;
}

function readHtmlLang(html) {
  const match = html.match(/<html\b[^>]*>/i);
  if (!match) return '';
  const attrs = parseAttrs(match[0]);
  return (attrs.lang || attrs['xml:lang'] || '').trim();
}

function countH1(html) {
  const tags = html.match(/<h1\b[^>]*>/gi) || [];
  return tags.length;
}

function readImages(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  return tags.map((tag) => {
    const attrs = parseAttrs(tag);
    return {
      hasAlt: Object.hasOwn(attrs, 'alt'),
      alt: attrs.alt || '',
      hasSize: Boolean(attrs.width && attrs.height),
      hasSrcset: Boolean(attrs.srcset),
      src: attrs.src || attrs['data-src'] || ''
    };
  });
}

const LABELABLE_SKIPPED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function readFormControls(html) {
  const controls = [];
  const re = /<(input|select|textarea)\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = parseAttrs(match[0]);
    const type = (attrs.type || '').toLowerCase();
    if (match[1].toLowerCase() === 'input' && LABELABLE_SKIPPED_TYPES.has(type)) continue;
    controls.push({ tag: match[1].toLowerCase(), attrs, index: match.index });
  }
  return controls;
}

function readLabels(html) {
  const labelFors = new Set();
  const ranges = [];
  const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = parseAttrs(`<label${match[1]}>`);
    if (attrs.for) labelFors.add(attrs.for.toLowerCase());
    ranges.push([match.index, match.index + match[0].length]);
  }
  return { labelFors, ranges };
}

function isControlLabeled(control, labels) {
  const attrs = control.attrs;
  if (attrs['aria-label'] || attrs['aria-labelledby']) return true;
  const id = (attrs.id || '').toLowerCase();
  if (id && labels.labelFors.has(id)) return true;
  return labels.ranges.some(([start, end]) => control.index > start && control.index < end);
}

function readScriptSources(html) {
  const sources = [];
  const re = /<script\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = parseAttrs(match[0]);
    const src = (attrs.src || '').trim();
    if (src) sources.push(src);
  }
  return sources;
}

function hasPrivacyLink(html) {
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = parseAttrs(`<a${match[1]}>`);
    const text = collapse(decodeEntities(match[2].replace(/<[^>]*>/g, ' ')));
    const haystack = `${attrs.href || ''} ${attrs.title || ''} ${text}`;
    if (/privacy|terms|legal|disclaimer|imprint|隐私|条款|免责/i.test(haystack)) return true;
  }
  return false;
}

function isLocalHost(hostname) {
  return LOCAL_HOST_RE.test(String(hostname || ''));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// 纯函数：analyze
// ---------------------------------------------------------------------------

/**
 * 分析一个页面的 HTML。
 *
 * @param {string} html 目标页面的 HTML 源码
 * @param {{url?: string, status?: number, finalUrl?: string, bytes?: number, contentType?: string}} meta
 *   响应元信息；status 是 HTTP 状态码，finalUrl 是跟随重定向后的地址，bytes 是响应体字节数。
 * @returns {{url: string, status: number|undefined, checks: Array<object>, summary: object}}
 */
export function analyze(html, meta = {}) {
  if (typeof html !== 'string') {
    throw new TypeError('analyze(html, meta) 的 html 必须是字符串');
  }
  const clean = stripNoise(html);
  const title = readTitle(clean);
  const metas = readMeta(clean);
  const lang = readHtmlLang(clean);
  const h1Count = countH1(clean);
  const images = readImages(clean);
  const controls = readFormControls(clean);
  const labels = readLabels(clean);
  const scriptSources = readScriptSources(html);
  const privacyLink = hasPrivacyLink(clean);

  let parsedUrl = null;
  try {
    parsedUrl = meta.url ? new URL(meta.url) : null;
  } catch {
    parsedUrl = null;
  }

  const raw = {};

  // 4.4 HTTPS
  if (!parsedUrl) {
    raw.https = { status: 'WARN', detail: '没有拿到有效的 URL，跳过协议检查' };
  } else if (parsedUrl.protocol === 'https:') {
    raw.https = { status: 'PASS', detail: `页面通过 HTTPS 加载（${parsedUrl.hostname}）` };
  } else if (isLocalHost(parsedUrl.hostname)) {
    raw.https = {
      status: 'WARN',
      detail: `本地地址 ${parsedUrl.hostname}，HTTPS 检查不适用；正式环境必须是 https://`
    };
  } else {
    raw.https = {
      status: 'FAIL',
      detail: `页面用 ${parsedUrl.protocol} 加载，正式投放请改用 https://（表单与浏览器权限都要求安全上下文）`
    };
  }

  // 7.4 HTTP 状态
  const httpStatus = meta.status;
  if (typeof httpStatus !== 'number' || !Number.isFinite(httpStatus)) {
    raw['http-status'] = { status: 'WARN', detail: '没有拿到 HTTP 状态码（analyze 调用未传 meta.status）' };
  } else if (httpStatus === 200) {
    const redirectNote =
      meta.finalUrl && meta.url && meta.finalUrl !== meta.url ? `，已重定向到 ${meta.finalUrl}` : '';
    raw['http-status'] = { status: 'PASS', detail: `HTTP 200${redirectNote}` };
  } else {
    raw['http-status'] = {
      status: 'FAIL',
      detail: `HTTP ${httpStatus}，页面不可访问或返回了错误页；广告点进来会看到断点`
    };
  }

  // 4.5 title
  if (!title) {
    raw.title = { status: 'FAIL', detail: '没有找到 <title>，浏览器标签与搜索结果都会是空白' };
  } else {
    const len = textLength(title);
    const detail = `长度 ${len} 字（建议 10–60）：「${title}」`;
    raw.title =
      len >= 10 && len <= 60 ? { status: 'PASS', detail } : { status: 'WARN', detail: `${detail}，长度超出建议范围` };
  }

  // 4.5 description
  const description = collapse(metas.get('description') || '');
  if (!description) {
    raw['meta-description'] = {
      status: 'FAIL',
      detail: '没有 meta description，搜索结果里会由搜索引擎随机截取正文'
    };
  } else {
    const len = textLength(description);
    const detail = `长度 ${len} 字（建议 50–160）`;
    raw['meta-description'] =
      len >= 50 && len <= 160
        ? { status: 'PASS', detail }
        : { status: 'WARN', detail: `${detail}，超出建议范围` };
  }

  // 4.5 canonical
  const linkTags = clean.match(/<link\b[^>]*>/gi) || [];
  const canonicalTag = linkTags.map((tag) => parseAttrs(tag)).find((attrs) => /(^|\s)canonical(\s|$)/i.test(attrs.rel || ''));
  const canonicalHref = (canonicalTag && canonicalTag.href ? canonicalTag.href : '').trim();
  raw.canonical = canonicalHref
    ? { status: 'PASS', detail: canonicalHref }
    : { status: 'WARN', detail: '没有 canonical 链接（缺失不致命，但建议指定，避免重复内容）' };

  // 4.5 robots
  const robots = (metas.get('robots') || '').toLowerCase();
  raw['meta-robots'] = /\bnoindex\b/.test(robots)
    ? { status: 'FAIL', detail: `meta robots = "${robots}"，搜索引擎不会收录；上线前确认是否故意` }
    : { status: 'PASS', detail: robots ? `meta robots = "${robots}"` : '没有 noindex 声明' };

  // 1.5 viewport
  const viewport = (metas.get('viewport') || '').trim();
  if (!viewport) {
    raw.viewport = { status: 'FAIL', detail: '没有 viewport，手机上会按桌面宽度缩放，首屏大概率错位' };
  } else if (!/width\s*=\s*device-width/i.test(viewport)) {
    raw.viewport = { status: 'WARN', detail: `viewport 里没有 width=device-width：「${viewport}」` };
  } else {
    raw.viewport = { status: 'PASS', detail: viewport };
  }

  // 6.1 html lang
  raw['html-lang'] = lang
    ? { status: 'PASS', detail: `lang="${lang}"` }
    : { status: 'WARN', detail: '没有 html lang，多语言站点无法按语言正确标注' };

  // 1.2 h1
  if (h1Count === 1) {
    raw.h1 = { status: 'PASS', detail: '页面有且只有 1 个 h1' };
  } else if (h1Count === 0) {
    raw.h1 = { status: 'WARN', detail: '没有 h1，主标题语义缺失' };
  } else {
    raw.h1 = { status: 'WARN', detail: `有 ${h1Count} 个 h1，主标题不唯一（是否只有一个主张仍需人工判断）` };
  }

  // 4.5 image alt
  if (images.length === 0) {
    raw['image-alt'] = { status: 'PASS', detail: '页面没有 <img> 标签（背景图/内联 SVG 不在自动检查范围内）' };
  } else {
    const missing = images.filter((img) => !img.hasAlt).length;
    raw['image-alt'] =
      missing === 0
        ? { status: 'PASS', detail: `${images.length} 张图片都写了 alt` }
        : {
            status: 'WARN',
            detail: `${missing}/${images.length} 张图片没有 alt 属性（装饰性图片请写 alt=""）`
          };
  }

  // 4.2 图片尺寸
  if (images.length === 0) {
    raw['image-dimensions'] = { status: 'PASS', detail: '页面没有 <img> 标签' };
  } else {
    const noSize = images.filter((img) => !img.hasSize && !img.hasSrcset).length;
    raw['image-dimensions'] =
      noSize === 0
        ? { status: 'PASS', detail: `${images.length} 张图片都声明了宽高或 srcset` }
        : {
            status: 'WARN',
            detail: `${noSize}/${images.length} 张图片既没有 width/height，也没有 srcset，加载时会撑动布局`
          };
  }

  // 3.2 form labels
  if (controls.length === 0) {
    raw['form-labels'] = { status: 'PASS', detail: '页面没有表单控件' };
  } else {
    const unlabeled = controls.filter((control) => !isControlLabeled(control, labels)).length;
    raw['form-labels'] =
      unlabeled === 0
        ? { status: 'PASS', detail: `${controls.length} 个控件都有 label 或 aria-label` }
        : {
            status: 'WARN',
            detail: `${unlabeled}/${controls.length} 个控件没有 label / aria-label（只有 placeholder 算缺失）`
          };
  }

  // 3.1 表单字段数量
  if (controls.length === 0) {
    raw['form-fields'] = { status: 'PASS', detail: '页面没有表单控件' };
  } else if (controls.length > 5) {
    raw['form-fields'] = {
      status: 'WARN',
      detail: `${controls.length} 个可见字段（建议 ≤5，先只留联系方式和需求）`
    };
  } else {
    raw['form-fields'] = { status: 'PASS', detail: `${controls.length} 个可见字段，数量克制` };
  }

  // 4.1 页面体积
  const bytes = meta.bytes;
  if (!Number.isFinite(bytes)) {
    raw['page-size'] = { status: 'WARN', detail: '没有拿到响应体积（analyze 调用未传 meta.bytes）' };
  } else if (bytes > MAX_HTML_BYTES) {
    raw['page-size'] = {
      status: 'WARN',
      detail: `HTML ${formatBytes(bytes)}，超过 1 MB；首屏速度风险高（不含图片与字体）`
    };
  } else {
    raw['page-size'] = { status: 'PASS', detail: `HTML ${formatBytes(bytes)}（不含图片与字体）` };
  }

  // 5.1 脚本重复
  const srcCounts = new Map();
  for (const src of scriptSources) srcCounts.set(src, (srcCounts.get(src) || 0) + 1);
  const duplicated = [...srcCounts.entries()].filter(([, count]) => count > 1);
  raw['script-duplicates'] =
    duplicated.length === 0
      ? {
          status: 'PASS',
          detail: scriptSources.length
            ? `${scriptSources.length} 个外部脚本，没有重复引用`
            : '没有外部脚本'
        }
      : {
          status: 'WARN',
          detail: duplicated
            .map(([src, count]) => `${src} ×${count}`)
            .join('；')
        };

  // 7.1 隐私/条款入口
  raw['privacy-links'] = privacyLink
    ? { status: 'PASS', detail: '找到隐私/条款类链接入口' }
    : { status: 'WARN', detail: '没有找到隐私/条款链接入口（可能叫别的名字，也可能是图片按钮）' };

  const checks = RULES.map((rule) => {
    const result = raw[rule.id];
    return {
      id: rule.id,
      checklist: rule.checklist,
      title: rule.title,
      status: result.status,
      detail: result.detail,
      limitation: rule.limitation
    };
  });

  const summary = {
    total: checks.length,
    pass: checks.filter((check) => check.status === 'PASS').length,
    warn: checks.filter((check) => check.status === 'WARN').length,
    fail: checks.filter((check) => check.status === 'FAIL').length,
    overall: checks.some((check) => check.status === 'FAIL')
      ? 'fail'
      : checks.some((check) => check.status === 'WARN')
        ? 'warn'
        : 'pass',
    autoChecklistItems: AUTO_CHECKLIST_ITEMS,
    manualChecklistItems: MANUAL_ITEMS_COUNT
  };

  return {
    url: meta.url || '',
    status: meta.status,
    checks,
    summary
  };
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

const USAGE = `落地页自动检查器 · landing-page-checklist

用法：
  node checker.mjs <url> [选项]

参数：
  <url>              要检查的页面地址，必须 http:// 或 https:// 开头
  --json             输出 JSON（给脚本/CI 用），不打印表格
  --timeout <毫秒>   请求超时，默认 10000（1000–120000）
  --no-fail          即使有 FAIL 也返回退出码 0（只报告，不拦截发布）
  --help             显示这份说明

例子：
  node checker.mjs https://example.com
  node checker.mjs https://example.com --json > report.json
  node checker.mjs http://127.0.0.1:8000/demo.html --no-fail

退出码：
  0  没有 FAIL（可能有 WARN）
  1  有 FAIL
  2  用法错误 / 网络错误 / 超时

说明：
  只请求目标页面一次，不执行页面脚本、不发 Cookie、不写文件、不上传任何内容。
  自动检查只覆盖清单 37 项中的 ${AUTO_CHECKLIST_ITEMS} 项（${RULES.length} 条规则），
  其余 ${MANUAL_ITEMS_COUNT} 项必须人工判断，见 docs/automation.md。
  这份结果不代表页面可以直接上线。
`;

/**
 * 解析命令行参数。导出是为了让测试不联网也能覆盖参数边界。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    url: '',
    json: false,
    noFail: false,
    timeout: DEFAULT_TIMEOUT_MS,
    help: false
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--no-fail') options.noFail = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--timeout') {
      const next = args.shift();
      if (next === undefined) throw new Error('--timeout 缺少毫秒数');
      const value = Number(next);
      if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
        throw new Error(`--timeout 必须是 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数毫秒`);
      }
      options.timeout = value;
    } else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length));
      if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
        throw new Error(`--timeout 必须是 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数毫秒`);
      }
      options.timeout = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    } else if (!options.url) {
      options.url = arg;
    } else {
      throw new Error(`只接受一个 URL，多出来的：${arg}`);
    }
  }
  return options;
}

function pad(text, width) {
  return String(text).padEnd(width, ' ');
}

/** 人类可读报告；非工程用户先看汇总，再看红项。 */
export function formatReport(result, meta = {}) {
  const lines = [];
  lines.push('落地页自动检查器 · landing-page-checklist');
  lines.push(`目标：${result.url || meta.url || '（未提供）'}`);
  const httpStatus = typeof result.status === 'number' ? result.status : '未知';
  lines.push(
    `HTTP ${httpStatus} · HTML ${formatBytes(meta.bytes)} · 用时 ${meta.elapsedMs ?? 0}ms · ${new Date().toISOString()}`
  );
  lines.push('');
  for (const check of result.checks) {
    lines.push(
      `[${check.status}] ${pad(check.id, 18)}${check.title}（清单 ${check.checklist}）— ${check.detail}`
    );
  }
  lines.push('');
  lines.push('—— 汇总 ——');
  lines.push(
    `PASS ${result.summary.pass} · WARN ${result.summary.warn} · FAIL ${result.summary.fail}（共 ${result.summary.total} 条自动规则）`
  );
  lines.push(
    `自动检查只覆盖清单 37 项中的 ${result.summary.autoChecklistItems} 项；其余 ${result.summary.manualChecklistItems} 项必须人工判断（docs/automation.md）。`
  );
  if (result.summary.fail > 0) {
    lines.push('有 FAIL 项：先修 FAIL，再跑一遍；退出码 1（加 --no-fail 可只报告不拦截）。');
  } else {
    lines.push('没有 FAIL 项。WARN 项按需处理；这不代表页面可以直接上线。');
  }
  return lines.join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误：${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.url) {
    process.stderr.write(`缺少要检查的 URL。\n\n${USAGE}`);
    return 2;
  }

  let target;
  try {
    target = new URL(options.url);
  } catch {
    process.stderr.write(`URL 格式不对：${options.url}\n例子：node checker.mjs https://example.com\n`);
    return 2;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    process.stderr.write(`只支持 http:// 或 https:// 地址，收到：${options.url}\n`);
    return 2;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(options.timeout)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const html = buffer.toString('utf8');
    const meta = {
      url: target.href,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type') || '',
      bytes: buffer.length
    };
    const result = analyze(html, meta);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ...result, elapsedMs: Date.now() - startedAt }, null, 2)}\n`
      );
    } else {
      process.stdout.write(`${formatReport(result, { ...meta, elapsedMs: Date.now() - startedAt })}\n`);
    }
    return result.summary.fail > 0 && !options.noFail ? 1 : 0;
  } catch (error) {
    const reason =
      error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? `请求超时（>${options.timeout}ms）`
        : (error && error.message) || String(error);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ url: target.href, status: 0, checks: [], summary: { total: 0, pass: 0, warn: 0, fail: 0, overall: 'error', autoChecklistItems: AUTO_CHECKLIST_ITEMS, manualChecklistItems: MANUAL_ITEMS_COUNT }, error: reason }, null, 2)}\n`
      );
    }
    process.stderr.write(
      `抓取失败：${reason}\n` +
        '可能原因：地址写错、站点拒绝访问、需要登录、网络不通或超时。\n' +
        '可以先用浏览器确认页面能打开，再加 --timeout 30000 重试。\n'
    );
    return 2;
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
