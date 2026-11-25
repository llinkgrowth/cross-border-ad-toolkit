/**
 * test/core.test.mjs — 纯函数核心与 CLI 参数解析的回归测试。
 *
 * 运行：node --test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ERROR_CODES,
  UTM_KEYS,
  WARNING_CODES,
  buildUtmUrl,
  collectParams,
  normalizeBaseUrl,
  parseQuery,
  stripUtmParams,
  validateFields,
} from '../src/core.mjs';
import { canonicalFields, parseCliArgs } from '../cli.mjs';

describe('normalizeBaseUrl', () => {
  it('没写协议时补 https://', () => {
    const result = normalizeBaseUrl('example.com/landing');
    assert.equal(result.ok, true);
    assert.equal(result.url.href, 'https://example.com/landing');
  });

  it('已写 http:// 时原样保留', () => {
    const result = normalizeBaseUrl('http://example.com/landing');
    assert.equal(result.ok, true);
    assert.equal(result.url.protocol, 'http:');
    assert.equal(result.url.hostname, 'example.com');
  });

  it('允许 localhost', () => {
    const result = normalizeBaseUrl('localhost:3000/app');
    assert.equal(result.ok, true);
    assert.equal(result.url.hostname, 'localhost');
    assert.equal(result.url.port, '3000');
  });

  it('允许 127.0.0.1 与内网 IPv4', () => {
    assert.equal(normalizeBaseUrl('127.0.0.1:8080').ok, true);
    assert.equal(normalizeBaseUrl('192.168.1.5:8080/landing').ok, true);
  });

  it('允许 IPv6 回环 [::1]', () => {
    const result = normalizeBaseUrl('[::1]:8080/app');
    assert.equal(result.ok, true);
    assert.equal(result.url.hostname, '[::1]');
  });

  it('拒绝没有点的域名', () => {
    const result = normalizeBaseUrl('example');
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.INCOMPLETE_HOST);
    assert.match(result.error, /完整域名/);
  });

  it('非法 URL 返回 INVALID_URL', () => {
    assert.equal(normalizeBaseUrl('http://').code, ERROR_CODES.INVALID_URL);
    assert.equal(normalizeBaseUrl('not a url').code, ERROR_CODES.INVALID_URL);
  });

  it('空输入返回 EMPTY_BASE（UI 据此静默）', () => {
    const result = normalizeBaseUrl('   ');
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.EMPTY_BASE);
  });

  it('非 http(s) 输入会被补上 https://，与旧实现一致', () => {
    // ftp://example.com -> https://ftp://example.com，hostname 为 ftp，缺小数点。
    const result = normalizeBaseUrl('ftp://example.com');
    assert.equal(result.code, ERROR_CODES.INCOMPLETE_HOST);
  });

  it('大小写不影响协议判定', () => {
    const result = normalizeBaseUrl('HTTPS://EXAMPLE.COM/Path');
    assert.equal(result.ok, true);
    assert.equal(result.url.protocol, 'https:');
    assert.equal(result.url.hostname, 'example.com');
    assert.equal(result.url.pathname, '/Path');
  });
});

describe('parseQuery / collectParams', () => {
  it('拆出 key、value 与原始 pair', () => {
    const entries = parseQuery('?a=1&utm_source=x&flag');
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['a', 'utm_source', 'flag']
    );
    assert.deepEqual(
      entries.map((entry) => entry.hasValue),
      [true, true, false]
    );
    assert.deepEqual(
      entries.map((entry) => entry.raw),
      ['a=1', 'utm_source=x', 'flag']
    );
  });

  it('解码中文与 +（按空格处理）', () => {
    const [entry] = parseQuery('?%E4%B8%AD=a+b');
    assert.equal(entry.key, '中');
    assert.equal(entry.value, 'a b');
  });

  it('非法百分号编码时回退原文，不抛错', () => {
    const [entry] = parseQuery('?a=%E4');
    assert.equal(entry.value, '%E4');
  });

  it('空查询串返回空数组', () => {
    assert.deepEqual(parseQuery(''), []);
    assert.deepEqual(parseQuery('?'), []);
    assert.deepEqual(parseQuery(null), []);
  });

  it('collectParams 把重复 key 合并成数组', () => {
    const collected = collectParams('?a=1&a=2&b=3');
    assert.deepEqual(collected.get('a'), ['1', '2']);
    assert.deepEqual(collected.get('b'), ['3']);
    assert.equal(collected.size, 2);
  });
});

describe('stripUtmParams', () => {
  it('移除 utm_*（大小写不敏感），非 utm 参数原样保留', () => {
    const result = stripUtmParams('?a=1&utm_source=old&UTM_Medium=x&b=2');
    assert.deepEqual(result.kept, ['a=1', 'b=2']);
    assert.equal(result.removed.length, 2);
  });

  it('保留无等号的 flag 参数', () => {
    const result = stripUtmParams('?flag&utm_id=1');
    assert.deepEqual(result.kept, ['flag']);
  });

  it('保留编码后的非 utm pair 原文', () => {
    const result = stripUtmParams('?a=%E4%B8%AD&utm_source=x');
    assert.deepEqual(result.kept, ['a=%E4%B8%AD']);
  });
});

describe('validateFields', () => {
  it('trim 后收集非空值', () => {
    const result = validateFields({ utm_source: '  facebook  ', utm_medium: 'social' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.values, [
      { key: 'utm_source', value: 'facebook' },
      { key: 'utm_medium', value: 'social' },
    ]);
    assert.deepEqual(result.warnings, []);
  });

  it('空值只记警告并跳过', () => {
    const result = validateFields({ utm_source: 'facebook', utm_medium: '   ' });
    assert.equal(result.ok, true);
    assert.equal(result.values.length, 1);
    assert.equal(result.warnings[0].code, WARNING_CODES.EMPTY_FIELD);
  });

  it('未知参数记为错误', () => {
    const result = validateFields({ utm_foo: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, ERROR_CODES.UNKNOWN_FIELD);
    assert.equal(result.errors[0].field, 'utm_foo');
  });

  it('非对象入参直接报错', () => {
    for (const value of [null, 'x', 42, []]) {
      const result = validateFields(value);
      assert.equal(result.ok, false, `应拒绝：${String(value)}`);
      assert.equal(result.errors[0].code, ERROR_CODES.INVALID_FIELDS);
    }
  });

  it('对象/数组值报 INVALID_VALUE', () => {
    const result = validateFields({ utm_source: { nested: true } });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, ERROR_CODES.INVALID_VALUE);
  });
});

describe('buildUtmUrl', () => {
  it('补协议并追加多个参数（顺序与传入一致）', () => {
    const result = buildUtmUrl('example.com/landing', {
      utm_source: 'facebook',
      utm_medium: 'social',
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.url,
      'https://example.com/landing?utm_source=facebook&utm_medium=social'
    );
    assert.equal(result.fieldCount, 2);
    assert.deepEqual(result.warnings, []);
  });

  it('先清除原有 utm_*，再写入新值', () => {
    const result = buildUtmUrl('https://example.com/path?a=1&utm_source=old&b=2#frag', {
      utm_source: 'new',
      utm_campaign: 'spring sale',
    });
    assert.equal(
      result.url,
      'https://example.com/path?a=1&b=2&utm_source=new&utm_campaign=spring%20sale#frag'
    );
    assert.equal(result.removedUtmCount, 1);
    assert.ok(result.warnings.some((warning) => warning.code === WARNING_CODES.UTM_OVERRIDDEN));
  });

  it('保留 hash 与非 utm 参数（含无等号 flag）', () => {
    assert.equal(
      buildUtmUrl('https://example.com/cb?x=1&flag', { utm_id: '007' }).url,
      'https://example.com/cb?x=1&flag&utm_id=007'
    );
    assert.equal(
      buildUtmUrl('https://example.com/p#top', { utm_source: 'a' }).url,
      'https://example.com/p?utm_source=a#top'
    );
  });

  it('中文与空格按 encodeURIComponent 编码（空格为 %20）', () => {
    assert.equal(
      buildUtmUrl('https://例子.cn/路径', { utm_campaign: '春季 大促' }).url,
      'https://xn--fsqu00a.cn/%E8%B7%AF%E5%BE%84?utm_campaign=%E6%98%A5%E5%AD%A3%20%E5%A4%A7%E4%BF%83'
    );
    assert.equal(
      buildUtmUrl('example.com', { utm_content: '视频 A' }).url,
      'https://example.com/?utm_content=%E8%A7%86%E9%A2%91%20A'
    );
  });

  it('空值跳过，不生成 utm_medium=', () => {
    const result = buildUtmUrl('example.com', {
      utm_source: 'facebook',
      utm_medium: '   ',
    });
    assert.equal(result.url, 'https://example.com/?utm_source=facebook');
    assert.equal(result.fieldCount, 1);
    assert.equal(result.warnings[0].code, WARNING_CODES.EMPTY_FIELD);
  });

  it('没有任何参数时仍返回清理后的 URL，并给 NO_FIELDS 警告', () => {
    const result = buildUtmUrl('example.com');
    assert.equal(result.url, 'https://example.com/');
    assert.equal(result.fieldCount, 0);
    assert.ok(result.warnings.some((warning) => warning.code === WARNING_CODES.NO_FIELDS));
  });

  it('http 链接保持 http', () => {
    assert.equal(
      buildUtmUrl('http://localhost:3000', { utm_source: 'fb' }).url,
      'http://localhost:3000/?utm_source=fb'
    );
  });

  it('大小写 utm_ 参数同样被清除', () => {
    assert.equal(
      buildUtmUrl('HTTPS://EXAMPLE.COM/Path?UTM_Source=old#Frag', { utm_source: 'up' }).url,
      'https://example.com/Path?utm_source=up#Frag'
    );
  });

  it('非法 base 返回空 URL 与错误信息', () => {
    const result = buildUtmUrl('not a url', { utm_source: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.url, '');
    assert.equal(result.error, '链接格式不正确，请检查一下。');
  });

  it('空 base 标记 empty=true 供 UI 静默', () => {
    const result = buildUtmUrl('   ', { utm_source: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.empty, true);
    assert.equal(result.url, '');
  });

  it('未知参数让构建失败，而不是静默丢弃', () => {
    const result = buildUtmUrl('example.com', { utm_foo: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, '不支持的参数：utm_foo');
  });
});

describe('CLI 参数解析 parseCliArgs', () => {
  it('解析 URL 与六个参数', () => {
    const parsed = parseCliArgs([
      'example.com/landing',
      '--source',
      'facebook',
      '--medium',
      'cpc',
      '--campaign',
      'spring',
    ]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.base, 'example.com/landing');
    assert.deepEqual(parsed.fields, {
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'spring',
    });
  });

  it('支持 --source=facebook 与 --utm_source 两种写法', () => {
    const parsed = parseCliArgs(['example.com', '--source=facebook', '--utm_medium=social']);
    assert.deepEqual(parsed.fields, { utm_source: 'facebook', utm_medium: 'social' });
  });

  it('识别 --json 与 --help', () => {
    assert.equal(parseCliArgs(['--json']).json, true);
    assert.equal(parseCliArgs(['-h']).help, true);
    assert.equal(parseCliArgs(['--help']).help, true);
  });

  it('缺少参数值时报错，但继续解析后续参数', () => {
    const parsed = parseCliArgs(['example.com', '--source', '--medium', 'cpc']);
    assert.deepEqual(parsed.errors, ['参数 --source 缺少值']);
    assert.deepEqual(parsed.fields, { utm_medium: 'cpc' });
  });

  it('未知参数报错', () => {
    assert.deepEqual(parseCliArgs(['example.com', '--nope']).errors, ['未知参数：--nope']);
    assert.deepEqual(parseCliArgs(['example.com', '-x']).errors, ['未知参数：-x']);
  });

  it('多个位置参数报错', () => {
    const parsed = parseCliArgs(['a.com', 'b.com']);
    assert.deepEqual(parsed.errors, ['只支持一个落地页 URL。']);
    assert.equal(parsed.base, 'a.com');
  });

  it('canonicalFields 按 UTM_KEYS 顺序输出', () => {
    const ordered = canonicalFields({ utm_id: '1', utm_source: 'x', utm_medium: 'y' });
    assert.deepEqual(Object.keys(ordered), ['utm_source', 'utm_medium', 'utm_id']);
  });

  it('UTM_KEYS 是冻结的六个标准参数', () => {
    assert.equal(UTM_KEYS.length, 6);
    assert.equal(Object.isFrozen(UTM_KEYS), true);
  });
});
