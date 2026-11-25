/**
 * src/core.mjs — UTM 纯函数核心。
 *
 * 设计约束：
 * - 不依赖 DOM、Node API 或任何第三方库，浏览器与 Node 都能直接使用。
 * - 所有函数都是纯函数：同样的入参永远得到同样的返回值，不读写全局状态。
 * - 与重构前 index.html 的内联逻辑逐条对齐（见 README「算法伪代码」）。
 *
 * 数据流：
 *   normalizeBaseUrl(base) ──┐
 *   validateFields(fields) ──┼──> buildUtmUrl() ──> { url, warnings, ... }
 *   stripUtmParams(search) ──┘
 */

/** 六个标准 UTM 参数，顺序即表单顺序、也是 CLI 输出顺序。 */
export const UTM_KEYS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
]);

/** 错误码：调用方据此判断该静默、提示还是以退出码 2 结束。 */
export const ERROR_CODES = Object.freeze({
  EMPTY_BASE: 'EMPTY_BASE',
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  INCOMPLETE_HOST: 'INCOMPLETE_HOST',
  INVALID_FIELDS: 'INVALID_FIELDS',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  INVALID_VALUE: 'INVALID_VALUE',
});

/** 警告码：不影响生成结果，只用于 CLI 提示与测试断言。 */
export const WARNING_CODES = Object.freeze({
  EMPTY_FIELD: 'EMPTY_FIELD',
  UTM_OVERRIDDEN: 'UTM_OVERRIDDEN',
  NO_FIELDS: 'NO_FIELDS',
});

/** 只认 utm_ 前缀（大小写不敏感），与旧实现一致。 */
const UTM_PREFIX_RE = /^utm_/i;
/** 用户没写协议时补这个；也用于拼接 http/https。 */
const DEFAULT_PROTOCOL = 'https:';
const HTTP_PROTOCOL_RE = /^https?:\/\//i;
const SUPPORTED_PROTOCOLS = Object.freeze(['http:', 'https:']);
/** 本机/内网调试常用主机名，本身不带点，需要放行。 */
const LOOPBACK_HOSTNAMES = Object.freeze(['localhost', '[::1]']);
/** 四位点分 IPv4；与旧实现一致，不额外校验每段 0-255。 */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 主机的可接受规则：loopback、IPv4 或至少带一个点的域名。 */
function isSupportedHostname(hostname) {
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return true;
  if (IPV4_RE.test(hostname)) return true;
  return hostname.includes('.');
}

/**
 * 安全解码查询串里的 key/value。
 * 非法百分号编码（如 `%E4`）直接返回原文，避免整个生成流程抛错。
 */
function decodeComponent(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * 校验并归一化落地页 URL。
 *
 * @param {unknown} raw 用户输入，允许带前导/尾随空白。
 * @returns {{ok: true, url: URL} | {ok: false, code: string, error: string}}
 */
export function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return {
      ok: false,
      code: ERROR_CODES.EMPTY_BASE,
      error: '请填写落地页 URL。',
    };
  }

  // 只有明确写了 http(s):// 才原样解析；其余一律补 https://。
  const candidate = HTTP_PROTOCOL_RE.test(value) ? value : DEFAULT_PROTOCOL + '//' + value;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_URL,
      error: '链接格式不正确，请检查一下。',
    };
  }

  if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) {
    return {
      ok: false,
      code: ERROR_CODES.UNSUPPORTED_PROTOCOL,
      error: '只支持 http / https 链接。',
    };
  }

  if (!isSupportedHostname(url.hostname)) {
    return {
      ok: false,
      code: ERROR_CODES.INCOMPLETE_HOST,
      error: '请填写完整域名，例如 example.com/landing。',
    };
  }

  return { ok: true, url };
}

/**
 * 把查询串拆成条目，保留原始 pair 以便无损拼回。
 *
 * @param {string} search 可带或不带前导 `?`。
 * @returns {Array<{raw: string, key: string, value: string, hasValue: boolean}>}
 */
export function parseQuery(search) {
  const raw = String(search ?? '').replace(/^\?/, '');
  if (!raw) return [];

  return raw
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf('=');
      const rawKey = separator === -1 ? pair : pair.slice(0, separator);
      const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
      return {
        raw: pair,
        key: decodeComponent(rawKey),
        value: decodeComponent(rawValue),
        hasValue: separator !== -1,
      };
    });
}

/**
 * 按 key 收集查询参数，重复 key 会合并成数组（分析、去重场景用）。
 *
 * @param {string} search
 * @returns {Map<string, string[]>} 插入顺序与原始查询串一致。
 */
export function collectParams(search) {
  const collected = new Map();
  for (const { key, value } of parseQuery(search)) {
    const values = collected.get(key);
    if (values) {
      values.push(value);
    } else {
      collected.set(key, [value]);
    }
  }
  return collected;
}

/**
 * 剔除查询串里所有 utm_* 参数（大小写不敏感）。
 *
 * @param {string} search
 * @returns {{kept: string[], removed: Array<{raw: string, key: string, value: string, hasValue: boolean}>}}
 *   kept 是原始 pair 字符串，保证非 utm 参数一个字节都不变。
 */
export function stripUtmParams(search) {
  const kept = [];
  const removed = [];

  for (const entry of parseQuery(search)) {
    if (UTM_PREFIX_RE.test(entry.key)) {
      removed.push(entry);
    } else {
      kept.push(entry.raw);
    }
  }

  return { kept, removed };
}

/**
 * 校验表单/CLI 传入的参数集合。
 *
 * 规则：
 * - 只接受 UTM_KEYS 里的 key，其它 key 记为错误（避免静默丢弃用户输入）。
 * - 值统一转字符串并 trim；空值只记警告并跳过。
 * - 非原始类型的值（对象、数组、函数等）记为错误。
 *
 * @param {unknown} fields
 * @returns {{ok: boolean, errors: Array<object>, warnings: Array<object>, values: Array<{key: string, value: string}>}}
 */
export function validateFields(fields = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return {
      ok: false,
      errors: [
        {
          code: ERROR_CODES.INVALID_FIELDS,
          message: '参数必须是一个对象。',
        },
      ],
      warnings: [],
      values: [],
    };
  }

  const errors = [];
  const warnings = [];
  const values = [];

  for (const key of Object.keys(fields)) {
    if (!UTM_KEYS.includes(key)) {
      errors.push({
        code: ERROR_CODES.UNKNOWN_FIELD,
        field: key,
        message: `不支持的参数：${key}`,
      });
      continue;
    }

    const rawValue = fields[key];
    const isPrimitive =
      rawValue === null ||
      rawValue === undefined ||
      ['string', 'number', 'boolean', 'bigint'].includes(typeof rawValue);

    if (!isPrimitive) {
      errors.push({
        code: ERROR_CODES.INVALID_VALUE,
        field: key,
        message: `${key} 的值必须是字符串或数字。`,
      });
      continue;
    }

    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
    if (!value) {
      warnings.push({
        code: WARNING_CODES.EMPTY_FIELD,
        field: key,
        message: `${key} 的值为空，已跳过。`,
      });
      continue;
    }

    values.push({ key, value });
  }

  return { ok: errors.length === 0, errors, warnings, values };
}

/**
 * 生成最终 UTM 链接。
 *
 * 行为（与重构前 index.html 一致）：
 * 1. 归一化 base；空/非法时返回 ok:false，url 为空串。
 * 2. 先剔除 base 里已有的 utm_* 参数，非 utm 参数与 hash 原样保留。
 * 3. 按传入顺序追加参数，key/value 都走 encodeURIComponent。
 * 4. 空值跳过；没有任何参数时仍返回只清理过 utm 的 URL，并带 NO_FIELDS 警告。
 *
 * @param {unknown} base 落地页 URL（可省略协议）。
 * @param {Record<string, unknown>} [fields] 参数集合。
 * @returns {{
 *   ok: boolean, empty: boolean, url: string,
 *   warnings: Array<object>, errors: Array<object>, error: string,
 *   removedUtmCount: number, fields: Record<string, string>, fieldCount: number
 * }}
 */
export function buildUtmUrl(base, fields = {}) {
  const normalized = normalizeBaseUrl(base);

  if (!normalized.ok) {
    return {
      ok: false,
      empty: normalized.code === ERROR_CODES.EMPTY_BASE,
      url: '',
      warnings: [],
      errors: [{ code: normalized.code, message: normalized.error }],
      error: normalized.error,
      removedUtmCount: 0,
      fields: {},
      fieldCount: 0,
    };
  }

  const url = normalized.url;
  const { kept, removed } = stripUtmParams(url.search);
  const validation = validateFields(fields);

  if (!validation.ok) {
    return {
      ok: false,
      empty: false,
      url: '',
      warnings: validation.warnings,
      errors: validation.errors,
      error: validation.errors[0].message,
      removedUtmCount: removed.length,
      fields: {},
      fieldCount: 0,
    };
  }

  const search = kept.slice();
  const appliedFields = {};

  for (const { key, value } of validation.values) {
    appliedFields[key] = value;
    search.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  const query = search.length ? `?${search.join('&')}` : '';
  const result = `${url.protocol}//${url.host}${url.pathname}${query}${url.hash}`;

  const warnings = validation.warnings.slice();
  if (removed.length > 0) {
    warnings.push({
      code: WARNING_CODES.UTM_OVERRIDDEN,
      count: removed.length,
      message: `已覆盖原有 ${removed.length} 个 utm_* 参数`,
    });
  }
  if (validation.values.length === 0) {
    warnings.push({
      code: WARNING_CODES.NO_FIELDS,
      message: '还没有填写参数，加一个 utm_source 就能生成。',
    });
  }

  return {
    ok: true,
    empty: false,
    url: result,
    warnings,
    errors: [],
    error: '',
    removedUtmCount: removed.length,
    fields: appliedFields,
    fieldCount: validation.values.length,
  };
}
