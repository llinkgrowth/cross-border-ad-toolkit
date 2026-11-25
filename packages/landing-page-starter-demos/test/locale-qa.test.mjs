import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArabicIndicDigits,
  isRtlLocale,
  keepQueryOnLocaleSwitch,
  buttonOverflow,
  localeLayoutHints,
} from '../src/locale-qa.mjs';

test('东阿拉伯数字归一化', () => {
  assert.equal(normalizeArabicIndicDigits('٠٥٠١٢٣٤٥٦٧'), '0501234567');
});

test('阿语 RTL，英语 LTR', () => {
  assert.equal(isRtlLocale('ar'), true);
  assert.equal(isRtlLocale('en'), false);
  assert.equal(localeLayoutHints('ar').dir, 'rtl');
  assert.equal(localeLayoutHints('ar').mirrorIcons, true);
});

test('切语言保留 utm 与 fbclid', () => {
  const next = keepQueryOnLocaleSwitch('?utm_source=facebook&fbclid=IwAR1&lang=en', 'ar');
  const p = new URLSearchParams(next.slice(1));
  assert.equal(p.get('lang'), 'ar');
  assert.equal(p.get('utm_source'), 'facebook');
  assert.equal(p.get('fbclid'), 'IwAR1');
});

test('按钮超长报警，短按钮不误报', () => {
  assert.equal(buttonOverflow('Buy now', 'Jetzt sofort kaufen und sparen').warn, true);
  assert.equal(buttonOverflow('OK', 'Tamam').warn, false);
});
