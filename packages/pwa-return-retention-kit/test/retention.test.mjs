import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_RETENTION_POLICY,
  SIGNALS,
  STORAGE_KEYS,
  TRIGGER_MODES,
  appendAttribution,
  buildReturnViewModel,
  createBackInterceptor,
  createMemoryStorage,
  createRetentionStore,
  detectInstallStrategy,
  evaluateRetentionTrigger,
  filterAttribution,
  generatePwaManifest,
  generateServiceWorkerScript,
  shouldFireRetention,
  validateManifest
} from '../src/retention-engine.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const parseJson = (stdout) => JSON.parse(stdout);

/** 可控时钟 + 假 window/document/history，供 createBackInterceptor 测试。 */
function createFakeEnv() {
  const listeners = new Map();
  const historyStates = [];
  const env = {
    time: 0,
    now: () => env.time,
    win: {
      addEventListener(type, handler) {
        listeners.set(`win:${type}`, handler);
      },
      removeEventListener(type) {
        listeners.delete(`win:${type}`);
      }
    },
    doc: {
      visibilityState: 'visible',
      addEventListener(type, handler) {
        listeners.set(`doc:${type}`, handler);
      },
      removeEventListener(type) {
        listeners.delete(`doc:${type}`);
      }
    },
    history: {
      pushState(state) {
        historyStates.push(state);
      }
    },
    listeners,
    historyStates,
    sessionStorage: createMemoryStorage(),
    localStorage: createMemoryStorage()
  };
  return env;
}

function createInterceptor(env, overrides = {}) {
  return createBackInterceptor({
    now: env.now,
    window: env.win,
    document: env.doc,
    history: env.history,
    sessionStorage: env.sessionStorage,
    localStorage: env.localStorage,
    policy: { trigger: 'back', minDwellMs: 3000, minAwaySeconds: 5, ...overrides.policy },
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 触发条件
// ---------------------------------------------------------------------------

test('evaluateRetentionTrigger：back 模式接受 popstate，拒绝切后台', () => {
  const back = evaluateRetentionTrigger({
    signal: SIGNALS.BACK,
    trigger: TRIGGER_MODES.BACK,
    dwellMs: 5000
  });
  assert.equal(back.matched, true);
  assert.equal(back.reason, 'matched');

  const revisit = evaluateRetentionTrigger({
    signal: SIGNALS.REVISIT,
    trigger: TRIGGER_MODES.BACK,
    dwellMs: 5000,
    awayMs: 20000
  });
  assert.equal(revisit.matched, false);
  assert.equal(revisit.reason, 'trigger_mismatch');
});

test('evaluateRetentionTrigger：revisit 模式要求离开时间达到门槛', () => {
  const longAway = evaluateRetentionTrigger({
    signal: SIGNALS.REVISIT,
    trigger: TRIGGER_MODES.REVISIT,
    dwellMs: 8000,
    awayMs: 6000
  });
  assert.equal(longAway.matched, true);

  const shortAway = evaluateRetentionTrigger({
    signal: SIGNALS.REVISIT,
    trigger: TRIGGER_MODES.REVISIT,
    dwellMs: 8000,
    awayMs: 2000
  });
  assert.equal(shortAway.matched, false);
  assert.equal(shortAway.reason, 'away_too_short');
});

test('evaluateRetentionTrigger：both 模式接受返回键、切后台与鼠标移出顶部', () => {
  for (const signal of [SIGNALS.BACK, SIGNALS.REVISIT, SIGNALS.EXIT_INTENT]) {
    const result = evaluateRetentionTrigger({
      signal,
      trigger: TRIGGER_MODES.BOTH,
      dwellMs: 5000,
      awayMs: 10000
    });
    assert.equal(result.matched, true, `${signal} 应该触发`);
  }
});

test('evaluateRetentionTrigger：进站停留未达门槛不触发（防误伤秒退）', () => {
  const result = evaluateRetentionTrigger({
    signal: SIGNALS.BACK,
    trigger: TRIGGER_MODES.BACK,
    dwellMs: 1200,
    minDwellMs: 3000
  });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'dwell_below_minimum');
});

test('evaluateRetentionTrigger：自定义最低停留 0 时可以立即触发', () => {
  const result = evaluateRetentionTrigger({
    signal: SIGNALS.BACK,
    trigger: TRIGGER_MODES.BACK,
    dwellMs: 0,
    minDwellMs: 0
  });
  assert.equal(result.matched, true);
});

test('evaluateRetentionTrigger：未知信号与未知模式抛 TypeError', () => {
  assert.throws(() => evaluateRetentionTrigger({ signal: 'scroll', dwellMs: 5000 }), TypeError);
  assert.throws(
    () => evaluateRetentionTrigger({ signal: SIGNALS.BACK, trigger: 'exit', dwellMs: 5000 }),
    TypeError
  );
});

// ---------------------------------------------------------------------------
// 频次 / 冷却 / 已转化
// ---------------------------------------------------------------------------

test('shouldFireRetention：once_per_session 首次放行，二次拦截', () => {
  const first = shouldFireRetention({ frequency: 'once_per_session' });
  assert.deepEqual(first, { fire: true, reason: 'allowed' });

  const sessionFired = shouldFireRetention({ frequency: 'once_per_session', sessionFired: true });
  assert.equal(sessionFired.fire, false);
  assert.equal(sessionFired.reason, 'session_cap_reached');

  const impressions = shouldFireRetention({
    frequency: 'once_per_session',
    sessionImpressions: 1
  });
  assert.equal(impressions.fire, false);
  assert.equal(impressions.reason, 'session_cap_reached');
});

test('shouldFireRetention：cooldown_hours 冷却期内拦截并给出剩余毫秒', () => {
  const now = 100 * 60 * 60 * 1000;
  const blocked = shouldFireRetention({
    frequency: 'cooldown_hours',
    cooldownHours: 24,
    lastFiredAt: now - 60 * 60 * 1000,
    now
  });
  assert.equal(blocked.fire, false);
  assert.equal(blocked.reason, 'cooldown_active');
  assert.equal(blocked.remainingMs, 23 * 60 * 60 * 1000);

  const allowed = shouldFireRetention({
    frequency: 'cooldown_hours',
    cooldownHours: 24,
    lastFiredAt: now - 25 * 60 * 60 * 1000,
    now
  });
  assert.equal(allowed.fire, true);
});

test('shouldFireRetention：已转化用户自动静默，关掉开关后恢复', () => {
  const suppressed = shouldFireRetention({ converted: true });
  assert.equal(suppressed.fire, false);
  assert.equal(suppressed.reason, 'converted_suppressed');

  const notSuppressed = shouldFireRetention({ converted: true, suppressAfterConversion: false });
  assert.equal(notSuppressed.fire, true);
});

test('shouldFireRetention：always 模式不做频次限制', () => {
  const result = shouldFireRetention({
    frequency: 'always',
    sessionFired: true,
    sessionImpressions: 9
  });
  assert.equal(result.fire, true);
});

test('shouldFireRetention：非法策略抛错', () => {
  assert.throws(() => shouldFireRetention({ frequency: 'hourly' }), TypeError);
  assert.throws(
    () => shouldFireRetention({ frequency: 'cooldown_hours', cooldownHours: 0 }),
    TypeError
  );
});

test('默认策略：both + 3 秒停留 + 5 秒离开 + 同会话一次', () => {
  assert.equal(DEFAULT_RETENTION_POLICY.trigger, 'both');
  assert.equal(DEFAULT_RETENTION_POLICY.minDwellMs, 3000);
  assert.equal(DEFAULT_RETENTION_POLICY.minAwaySeconds, 5);
  assert.equal(DEFAULT_RETENTION_POLICY.frequency, 'once_per_session');
  assert.equal(DEFAULT_RETENTION_POLICY.suppressAfterConversion, true);
});

// ---------------------------------------------------------------------------
// 归因透传
// ---------------------------------------------------------------------------

test('filterAttribution：只保留 utm_* / fbclid / ttclid', () => {
  const filtered = filterAttribution({
    utm_source: 'facebook',
    utm_campaign: 'spring',
    fbclid: 'fb-1',
    ttclid: 'tt-1',
    email: 'user@example.com',
    order_id: '12345',
    referrer: 'https://example.com'
  });
  assert.deepEqual(filtered, {
    utm_source: 'facebook',
    utm_campaign: 'spring',
    fbclid: 'fb-1',
    ttclid: 'tt-1'
  });
});

test('appendAttribution：相对路径、已有参数与 hash 都保留', () => {
  const href = appendAttribution('/offer?ref=abc#top', { utm_source: 'fb', fbclid: 'x1' });
  assert.equal(href, '/offer?ref=abc&utm_source=fb&fbclid=x1#top');
});

test('appendAttribution：同名 utm 参数覆盖旧值，空值忽略', () => {
  const href = appendAttribution('/offer?utm_source=old', {
    utm_source: 'new',
    ttclid: '',
    utm_medium: null
  });
  assert.equal(href, '/offer?utm_source=new');
});

// ---------------------------------------------------------------------------
// Popup / Feed 视图模型
// ---------------------------------------------------------------------------

test('buildReturnViewModel：popup 默认模型字段完整', () => {
  const model = buildReturnViewModel({ format: 'popup' });
  assert.equal(model.format, 'popup');
  assert.equal(typeof model.title, 'string');
  assert.equal(typeof model.subtitle, 'string');
  assert.equal(model.hookCode, '');
  assert.equal(model.countdownSeconds, 0);
  assert.equal(typeof model.cta.label, 'string');
  assert.equal(model.cta.href, '/');
  assert.equal(typeof model.dismissLabel, 'string');
  assert.deepEqual(model.attribution, {});
});

test('buildReturnViewModel：popup 自定义文案、钩子码与倒计时', () => {
  const model = buildReturnViewModel({
    format: 'popup',
    campaign: {
      title: '别走，还有 3 集没看',
      subtitle: '限时解锁下一集',
      hookCode: 'COMEBACK',
      countdownSeconds: 900,
      ctaLabel: '继续观看',
      ctaHref: '/watch/next'
    }
  });
  assert.equal(model.title, '别走，还有 3 集没看');
  assert.equal(model.hookCode, 'COMEBACK');
  assert.equal(model.countdownSeconds, 900);
  assert.equal(model.cta.label, '继续观看');
  assert.equal(model.cta.href, '/watch/next');
});

test('buildReturnViewModel：popup CTA 透传 utm_* / fbclid / ttclid', () => {
  const model = buildReturnViewModel({
    format: 'popup',
    attribution: {
      utm_source: 'facebook',
      utm_campaign: 'spring',
      fbclid: 'fb-1',
      ttclid: 'tt-1',
      email: 'drop@example.com'
    }
  });
  const url = new URL(model.cta.href, 'https://example.com');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('utm_source'), 'facebook');
  assert.equal(url.searchParams.get('utm_campaign'), 'spring');
  assert.equal(url.searchParams.get('fbclid'), 'fb-1');
  assert.equal(url.searchParams.get('ttclid'), 'tt-1');
  assert.equal(url.searchParams.has('email'), false);
});

test('buildReturnViewModel：feed 3 张卡片，每张有独立 CTA 与归因参数', () => {
  const model = buildReturnViewModel({
    format: 'feed',
    attribution: { utm_source: 'tiktok', fbclid: 'fb-1', ttclid: 'tt-1' },
    cards: [
      { id: 'a', title: '精选推荐一', subtitle: '看完这一集', href: '/series/a', ctaLabel: '去看' },
      { title: '精选推荐二', href: '/series/b?ref=feed' },
      { title: '精选推荐三', href: '/series/c', tag: '热播' }
    ]
  });
  assert.equal(model.format, 'feed');
  assert.equal(model.cards.length, 3);
  assert.equal(model.cards[0].cta.label, '去看');
  assert.equal(model.cards[2].tag, '热播');
  for (const card of model.cards) {
    const url = new URL(card.cta.href, 'https://example.com');
    assert.equal(url.searchParams.get('utm_source'), 'tiktok');
    assert.equal(url.searchParams.get('fbclid'), 'fb-1');
    assert.equal(url.searchParams.get('ttclid'), 'tt-1');
  }
  const second = new URL(model.cards[1].cta.href, 'https://example.com');
  assert.equal(second.searchParams.get('ref'), 'feed');
});

test('buildReturnViewModel：feed 最多 6 张卡片', () => {
  const cards = Array.from({ length: 6 }, (_, index) => ({ title: `卡片 ${index + 1}` }));
  const model = buildReturnViewModel({ format: 'feed', cards });
  assert.equal(model.cards.length, 6);
});

test('buildReturnViewModel：feed 少于 3 张或多于 6 张都抛 RangeError', () => {
  assert.throws(
    () => buildReturnViewModel({ format: 'feed', cards: [{ title: 'a' }, { title: 'b' }] }),
    RangeError
  );
  assert.throws(
    () =>
      buildReturnViewModel({
        format: 'feed',
        cards: Array.from({ length: 7 }, (_, index) => ({ title: `卡片 ${index + 1}` }))
      }),
    RangeError
  );
});

test('buildReturnViewModel：feed 卡片缺标题抛 TypeError', () => {
  assert.throws(
    () =>
      buildReturnViewModel({
        format: 'feed',
        cards: [{ title: '正常' }, { title: '  ' }, { title: '正常' }]
      }),
    TypeError
  );
});

test('buildReturnViewModel：未知 format 抛 RangeError', () => {
  assert.throws(() => buildReturnViewModel({ format: 'banner' }), RangeError);
});

// ---------------------------------------------------------------------------
// PWA Manifest / Service Worker
// ---------------------------------------------------------------------------

test('generatePwaManifest：字段齐全，start_url 自动带 utm_source', () => {
  const manifest = generatePwaManifest({
    name: 'PulsePlay',
    shortName: 'Pulse',
    themeColor: '#0f172a',
    startUrl: '/offer'
  });
  assert.equal(manifest.name, 'PulsePlay');
  assert.equal(manifest.short_name, 'Pulse');
  assert.equal(manifest.start_url, '/offer?utm_source=pwa_homescreen');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#0f172a');
  assert.ok(manifest.icons.length >= 2);
  assert.equal(validateManifest(manifest).valid, true);
});

test('generatePwaManifest：已有查询参数的 start_url 不破坏原参数', () => {
  const manifest = generatePwaManifest({
    name: 'PulsePlay',
    shortName: 'Pulse',
    startUrl: '/offer?utm_campaign=spring&ref=poster',
    utmSource: 'pwa_homescreen'
  });
  const url = new URL(manifest.start_url, 'https://example.com');
  assert.equal(url.searchParams.get('utm_campaign'), 'spring');
  assert.equal(url.searchParams.get('ref'), 'poster');
  assert.equal(url.searchParams.get('utm_source'), 'pwa_homescreen');
});

test('generatePwaManifest：自定义图标与非法 display 校验', () => {
  const manifest = generatePwaManifest({
    name: 'Demo',
    shortName: 'Demo',
    display: 'minimal-ui',
    icons: [{ src: '/icon.png', sizes: '192x192' }]
  });
  assert.equal(manifest.display, 'minimal-ui');
  assert.equal(manifest.icons[0].type, 'image/png');

  assert.throws(
    () => generatePwaManifest({ name: 'Demo', shortName: 'Demo', display: 'popup' }),
    RangeError
  );
  assert.throws(() => generatePwaManifest({ name: '', shortName: 'Demo' }), TypeError);
});

test('validateManifest：缺字段、缺 192/512 图标时给出错误', () => {
  const result = validateManifest({
    name: 'Demo',
    short_name: '',
    start_url: 'offer',
    display: 'popup',
    icons: [{ src: '/only.png', sizes: '48x48' }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('short_name')));
  assert.ok(result.errors.some((error) => error.includes('start_url')));
  assert.ok(result.errors.some((error) => error.includes('192x192')));
  assert.ok(result.errors.some((error) => error.includes('512x512')));
});

test('validateManifest：start_url 缺归因参数只给 warning', () => {
  const manifest = generatePwaManifest({ name: 'Demo', shortName: 'Demo' });
  delete manifest.start_url;
  manifest.start_url = '/';
  const result = validateManifest(manifest);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.includes('utm_source')));
});

test('generateServiceWorkerScript：生成可解析的 Network-First SW', () => {
  const script = generateServiceWorkerScript({
    cacheName: 'pulse-cache',
    version: '2026-11',
    offlineUrl: '/offline.html'
  });
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const CACHE_NAME = "pulse-cache-2026-11"/);
  assert.match(script, /networkFirstStrategy/);
  assert.match(script, /cacheFirstStrategy/);
  assert.match(script, /skipWaiting/);
  assert.match(script, /OFFLINE_URL/);
  assert.match(script, /clients\.claim/);
});

test('generateServiceWorkerScript：版本变化体现在缓存名上', () => {
  const v1 = generateServiceWorkerScript({ cacheName: 'c', version: 'v1' });
  const v2 = generateServiceWorkerScript({ cacheName: 'c', version: 'v2' });
  assert.match(v1, /c-v1/);
  assert.match(v2, /c-v2/);
  assert.notEqual(v1, v2);
});

// ---------------------------------------------------------------------------
// 安装策略识别
// ---------------------------------------------------------------------------

const UA = {
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  webview:
    'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36',
  fbInApp:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.5615.136 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/430.0.0.0;]',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
};

test('detectInstallStrategy：iOS Safari 走分享 → 添加到主屏幕图文引导', () => {
  const result = detectInstallStrategy(UA.iosSafari);
  assert.equal(result.environment, 'ios-safari');
  assert.equal(result.strategy, 'ios-share-guide');
  assert.equal(result.canPrompt, false);
  assert.ok(result.steps.some((step) => step.includes('添加到主屏幕')));
});

test('detectInstallStrategy：iOS 第三方浏览器同样不能原生弹安装', () => {
  const result = detectInstallStrategy(UA.iosChrome);
  assert.equal(result.environment, 'ios-other-browser');
  assert.equal(result.canPrompt, false);
  assert.equal(result.strategy, 'ios-share-guide');
});

test('detectInstallStrategy：Android Chrome 走 beforeinstallprompt 原生安装', () => {
  const result = detectInstallStrategy(UA.androidChrome);
  assert.equal(result.environment, 'android-chrome');
  assert.equal(result.strategy, 'native-prompt');
  assert.equal(result.canPrompt, true);
  assert.ok(result.steps.some((step) => step.includes('beforeinstallprompt')));
});

test('detectInstallStrategy：Android 非 Chrome 浏览器走菜单手动安装', () => {
  const result = detectInstallStrategy(UA.androidSamsung);
  assert.equal(result.environment, 'android-other');
  assert.equal(result.strategy, 'manual-guide');
  assert.equal(result.canPrompt, false);
});

test('detectInstallStrategy：App 内置 WebView 与 Facebook IAB 都引导去外部浏览器', () => {
  for (const ua of [UA.webview, UA.fbInApp]) {
    const result = detectInstallStrategy(ua);
    assert.equal(result.environment, 'webview');
    assert.equal(result.strategy, 'open-external-browser');
    assert.ok(result.steps.some((step) => step.includes('在浏览器中打开')));
  }
});

test('detectInstallStrategy：standalone 已安装时不再引导', () => {
  const result = detectInstallStrategy(UA.androidChrome, true);
  assert.equal(result.environment, 'standalone');
  assert.equal(result.strategy, 'already-installed');
});

test('detectInstallStrategy：桌面浏览器走地址栏安装引导', () => {
  const result = detectInstallStrategy(UA.desktop);
  assert.equal(result.environment, 'desktop-browser');
  assert.equal(result.strategy, 'manual-guide');
});

// ---------------------------------------------------------------------------
// 存储与拦截器
// ---------------------------------------------------------------------------

test('createMemoryStorage：模拟 Web Storage 基本行为', () => {
  const storage = createMemoryStorage({ a: '1' });
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem('a'), '1');
  storage.setItem('b', 2);
  assert.equal(storage.getItem('b'), '2');
  assert.equal(storage.key(0), 'a');
  storage.removeItem('a');
  assert.equal(storage.getItem('a'), null);
  storage.clear();
  assert.equal(storage.length, 0);
});

test('createRetentionStore：记录展示次数、会话标记与已转化状态', () => {
  const session = createMemoryStorage();
  const local = createMemoryStorage();
  const store = createRetentionStore({
    sessionStorage: session,
    localStorage: local,
    now: () => 123456
  });

  assert.deepEqual(store.snapshot(), {
    sessionFired: false,
    sessionImpressions: 0,
    lastFiredAt: null,
    converted: false
  });

  store.recordFire();
  store.recordFire();
  assert.deepEqual(store.snapshot(), {
    sessionFired: true,
    sessionImpressions: 2,
    lastFiredAt: 123456,
    converted: false
  });
  assert.equal(session.getItem(STORAGE_KEYS.sessionFired), '1');

  store.markConverted();
  assert.equal(store.snapshot().converted, true);

  store.reset();
  assert.deepEqual(store.snapshot(), {
    sessionFired: false,
    sessionImpressions: 0,
    lastFiredAt: null,
    converted: false
  });
});

test('createBackInterceptor：返回键信号满足停留门槛后展示一次', () => {
  const env = createFakeEnv();
  const fired = [];
  const interceptor = createInterceptor(env, { onFire: (event) => fired.push(event) });

  env.time = 4000;
  const result = interceptor.handlePopState();
  assert.equal(result.fire, true);
  assert.equal(result.signal, SIGNALS.BACK);
  assert.equal(fired.length, 1);
  assert.equal(interceptor.getState().snapshot.sessionFired, true);
});

test('createBackInterceptor：同会话第二次返回键被频次锁拦截', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  env.time = 4000;
  assert.equal(interceptor.handlePopState().fire, true);

  env.time = 9000;
  const second = interceptor.handlePopState();
  assert.equal(second.fire, false);
  assert.equal(second.reason, 'session_cap_reached');
});

test('createBackInterceptor：进站没满 3 秒点返回不触发', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  env.time = 1200;
  const result = interceptor.handlePopState();
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'dwell_below_minimum');
});

test('createBackInterceptor：切后台满 5 秒回来触发（revisit 模式）', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env, { policy: { trigger: 'revisit' } });

  env.time = 4000;
  interceptor.handleVisibilityChange('hidden');
  env.time = 4000 + 6000;
  const result = interceptor.handleVisibilityChange('visible');
  assert.equal(result.fire, true);
  assert.equal(result.signal, SIGNALS.REVISIT);
});

test('createBackInterceptor：切后台不足 5 秒回来不触发', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env, { policy: { trigger: 'revisit' } });

  env.time = 4000;
  interceptor.handleVisibilityChange('hidden');
  env.time = 4000 + 2000;
  const result = interceptor.handleVisibilityChange('visible');
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'away_too_short');
});

test('createBackInterceptor：已转化用户返回也不打扰', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  interceptor.markConverted();
  env.time = 5000;
  const result = interceptor.handlePopState();
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'converted_suppressed');
});

test('createBackInterceptor：destroy 之后不再触发，监听器被移除', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  assert.ok(env.listeners.size >= 3);
  interceptor.destroy();
  assert.equal(env.listeners.size, 0);

  env.time = 5000;
  const result = interceptor.handlePopState();
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'disabled');
});

test('createBackInterceptor：back 模式忽略切后台信号', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  env.time = 4000;
  interceptor.handleVisibilityChange('hidden');
  env.time = 4000 + 20000;
  const result = interceptor.handleVisibilityChange('visible');
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'trigger_mismatch');
});

test('createBackInterceptor：鼠标移出顶部触发 exit_intent，移出不从顶部不触发', () => {
  const env = createFakeEnv();
  const interceptor = createInterceptor(env);
  env.time = 4000;

  const notTop = interceptor.handleMouseOut({ clientY: 240, relatedTarget: null });
  assert.equal(notTop.fire, undefined);

  const top = interceptor.handleMouseOut({ clientY: -4, relatedTarget: null });
  assert.equal(top.fire, true);
  assert.equal(top.signal, SIGNALS.EXIT_INTENT);
});

test('createBackInterceptor：cooldown_hours 策略跨会话生效', () => {
  const env = createFakeEnv();
  const first = createInterceptor(env, {
    policy: { frequency: 'cooldown_hours', cooldownHours: 1 }
  });
  env.time = 4000;
  assert.equal(first.handlePopState().fire, true);
  first.destroy();

  // 同一份 localStorage（模拟新会话）；sessionStorage 清空
  env.sessionStorage = createMemoryStorage();
  const second = createInterceptor(env, {
    policy: { frequency: 'cooldown_hours', cooldownHours: 1 }
  });
  env.time = 4000 + 10 * 60 * 1000;
  const result = second.handlePopState();
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'cooldown_active');
});

test('createBackInterceptor：autoArm 会压入哨兵，关闭后不压', () => {
  const env = createFakeEnv();
  const withArm = createInterceptor(env);
  assert.equal(env.historyStates.length, 1);
  assert.equal(withArm.getState().armed, true);

  const env2 = createFakeEnv();
  createInterceptor(env2, { autoArm: false });
  assert.equal(env2.historyStates.length, 0);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI --help：退出码 0，列出三个子命令', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /manifest/);
  assert.match(run.stdout, /simulate-trigger/);
  assert.match(run.stdout, /detect-pwa/);
  assert.match(run.stdout, /零依赖/);
});

test('CLI manifest：打印带 pwa_homescreen 归因的 manifest', () => {
  const run = runCli(['manifest', '--name', 'PulsePlay', '--short', 'Pulse', '--start-url', '/offer']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /PulsePlay/);
  assert.match(run.stdout, /utm_source=pwa_homescreen/);
  assert.match(run.stdout, /校验：通过/);
});

test('CLI manifest --json：返回 manifest 与校验结果', () => {
  const run = runCli([
    'manifest', '--name', 'PulsePlay', '--short', 'Pulse', '--color', '#0f172a', '--start-url', '/offer', '--json'
  ]);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.command, 'manifest');
  assert.equal(report.manifest.name, 'PulsePlay');
  assert.equal(report.manifest.theme_color, '#0f172a');
  assert.match(report.manifest.start_url, /utm_source=pwa_homescreen/);
  assert.equal(report.validation.valid, true);
});

test('CLI simulate-trigger：示例参数在终端跑通状态机', () => {
  const run = runCli([
    'simulate-trigger', '--trigger', 'both', '--dwell-ms', '4500', '--away-sec', '12', '--already-converted', 'false', '--json'
  ]);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.command, 'simulate-trigger');
  assert.equal(report.trigger.matched, true);
  assert.equal(report.gate.fire, true);
  assert.equal(report.decision.fire, true);
});

test('CLI simulate-trigger：已转化用户输出 converted_suppressed', () => {
  const run = runCli([
    'simulate-trigger', '--trigger', 'both', '--dwell-ms', '4500', '--away-sec', '12', '--already-converted', 'true', '--json'
  ]);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.decision.fire, false);
  assert.equal(report.decision.reason, 'converted_suppressed');
});

test('CLI simulate-trigger：back 模式遇到 revisit 信号输出 trigger_mismatch', () => {
  const run = runCli([
    'simulate-trigger', '--trigger', 'back', '--signal', 'revisit', '--dwell-ms', '5000', '--away-sec', '20', '--json'
  ]);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.trigger.matched, false);
  assert.equal(report.decision.reason, 'trigger_mismatch');
});

test('CLI simulate-trigger：--format popup 时附带回流视图模型与归因透传', () => {
  const run = runCli([
    'simulate-trigger', '--trigger', 'both', '--dwell-ms', '5000', '--away-sec', '20',
    '--format', 'popup', '--utm-source', 'facebook', '--fbclid', 'fb-1', '--json'
  ]);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.decision.showFormat, 'popup');
  assert.match(report.model.cta.href, /utm_source=facebook/);
  assert.match(report.model.cta.href, /fbclid=fb-1/);
});

test('CLI detect-pwa：iOS Safari 输出图文引导策略', () => {
  const run = runCli(['detect-pwa', '--ua', UA.iosSafari, '--json']);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.strategy.environment, 'ios-safari');
  assert.equal(report.strategy.canPrompt, false);
});

test('CLI detect-pwa：Android Chrome 输出原生安装策略', () => {
  const run = runCli(['detect-pwa', '--ua', UA.androidChrome, '--json']);
  assert.equal(run.status, 0);
  const report = parseJson(run.stdout);
  assert.equal(report.strategy.environment, 'android-chrome');
  assert.equal(report.strategy.canPrompt, true);
});

test('CLI 参数错误统一退出码 2', () => {
  assert.equal(runCli(['nope']).status, 2);
  assert.equal(runCli(['manifest', '--short', 'Pulse']).status, 2);
  assert.equal(runCli(['manifest', '--name', 'A', '--short', 'B', '--bogus', 'x']).status, 2);
  assert.equal(runCli(['detect-pwa']).status, 2);
  assert.equal(runCli(['simulate-trigger', '--trigger', 'scroll']).status, 2);
});

test('CLI 参数错误信息写到 stderr，不污染 stdout', () => {
  const run = runCli(['simulate-trigger', '--trigger', 'scroll']);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /参数错误/);
});
