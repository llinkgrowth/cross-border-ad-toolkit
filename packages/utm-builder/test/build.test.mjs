/**
 * test/build.test.mjs — 构建管线的确定性与内联安全检查。
 *
 * 运行：node --test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPage } from '../scripts/build.mjs';

describe('scripts/build.mjs', () => {
  it('同样输入两次构建结果完全一致（确定性）', () => {
    const first = buildPage();
    const second = buildPage();
    assert.equal(first.html, second.html);
    assert.equal(first.hash, second.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
  });

  it('顶部带生成注释与内容 hash，产物以 HTML 注释开头', () => {
    const { html, hash } = buildPage();
    assert.ok(html.startsWith('<!--\n  AUTO-GENERATED FILE'));
    assert.ok(html.includes(`SHA-256: ${hash}`));
    assert.ok(html.includes('<!DOCTYPE html>'));
  });

  it('所有 INLINE 标记都被替换', () => {
    const { html } = buildPage();
    assert.equal(html.includes('INLINE:styles.css'), false);
    assert.equal(html.includes('INLINE:core+app'), false);
  });

  it('内联了 <style> 且 CSS 变量存在', () => {
    const { html } = buildPage();
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('--accent: #2563eb;'));
  });

  it('内联了 window.UTMCore 且 ESM export 已剥离', () => {
    const { html } = buildPage();
    assert.ok(html.includes('window.UTMCore = Object.freeze({'));
    assert.ok(html.includes('buildUtmUrl: buildUtmUrl'));
    assert.equal(/^export\s/m.test(html), false);
  });

  it('产物不含任何外部资源引用', () => {
    const { html } = buildPage();
    assert.equal(/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html), false);
  });
});
