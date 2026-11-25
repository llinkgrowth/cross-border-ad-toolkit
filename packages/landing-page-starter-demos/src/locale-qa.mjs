/**
 * 多语言上线前的公开校验（零依赖）。
 * 不翻译页面，只回答「切到这个语言会不会撑破、丢参数、数字写错」。
 */

const RTL = new Set(['ar', 'he', 'fa', 'ur']);

/** 东阿拉伯数字 ٠-٩ → ASCII，避免阿拉伯语输入法导致手机号校验失败。 */
export function normalizeArabicIndicDigits(raw = '') {
  return String(raw).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function isRtlLocale(code = '') {
  return RTL.has(String(code).toLowerCase().split('-')[0]);
}

/**
 * 语言切换时保留全部查询参数，只改 lang。
 * @param {string} search 含或不含前导 ?
 * @param {string} nextLocale
 */
export function keepQueryOnLocaleSwitch(search = '', nextLocale = 'en') {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  params.set('lang', nextLocale);
  const q = params.toString();
  return q ? `?${q}` : '';
}

/**
 * 按钮文案相对英语基准是否可能撑破（默认 >40% 报警）。
 * @param {string} baseText
 * @param {string} translated
 * @param {number} [ratio]
 */
export function buttonOverflow(baseText = '', translated = '', ratio = 1.4) {
  const base = String(baseText).trim();
  const next = String(translated).trim();
  if (base.length < 4) return { warn: false, ratio: 1, reason: 'base_too_short' };
  const r = next.length / base.length;
  return {
    warn: r > ratio,
    ratio: Math.round(r * 100) / 100,
    reason: r > ratio ? 'button_may_overflow' : 'ok',
  };
}

/** 地址/日期书写方向提示，给表单布局用，不做机翻。 */
export function localeLayoutHints(code = 'en') {
  const rtl = isRtlLocale(code);
  return {
    code,
    dir: rtl ? 'rtl' : 'ltr',
    mirrorIcons: rtl,
    dateOrder: String(code).startsWith('en') ? 'MDY' : 'DMY',
    phoneHint: rtl
      ? '接受东阿拉伯数字，提交前归一化为 ASCII'
      : '只保留数字与可选前导 +',
  };
}
