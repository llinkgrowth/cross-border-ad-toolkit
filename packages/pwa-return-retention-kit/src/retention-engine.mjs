/**
 * pwa-return-retention-kit · 纯函数与前端运行时核心
 *
 * 设计原则：
 *  - 零第三方依赖，浏览器与 Node 都可直接 import。
 *  - 决策函数（evaluateRetentionTrigger / shouldFireRetention / buildReturnViewModel /
 *    generatePwaManifest / detectInstallStrategy）都是纯函数：入参决定一切，不读全局、
 *    不发起网络请求、不写存储，方便单测。
 *  - 浏览器副作用只在 createBackInterceptor 与 createRetentionStore 里，且都通过
 *    依赖注入拿 window / document / history / storage，方便在 Node 里用假对象测试。
 *
 * 边界：这是一个通用 Demo 库，不包含任何商业后台代码、不发请求、不收集用户数据。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 回流触发模式：back = 返回键/退出手势；revisit = 切后台再回来；both = 两者都算。 */
export const TRIGGER_MODES = Object.freeze({
  BACK: 'back',
  REVISIT: 'revisit',
  BOTH: 'both'
});

/** 底层信号。exit_intent 是桌面端鼠标移出页面顶部的等价信号，归入 back 模式。 */
export const SIGNALS = Object.freeze({
  BACK: 'back',
  REVISIT: 'revisit',
  EXIT_INTENT: 'exit_intent'
});

const SIGNAL_MODE = Object.freeze({
  [SIGNALS.BACK]: TRIGGER_MODES.BACK,
  [SIGNALS.EXIT_INTENT]: TRIGGER_MODES.BACK,
  [SIGNALS.REVISIT]: TRIGGER_MODES.REVISIT
});

/** 默认策略：能不改就不改；改策略请显式传 policy。 */
export const DEFAULT_RETENTION_POLICY = Object.freeze({
  trigger: TRIGGER_MODES.BOTH,
  minDwellMs: 3000,
  minAwaySeconds: 5,
  frequency: 'once_per_session',
  cooldownHours: 24,
  maxImpressionsPerSession: 1,
  suppressAfterConversion: true
});

/** 会被透传到回流页 CTA 的归因参数：所有 utm_*，以及三个广告点击 ID。 */
const ATTRIBUTION_KEY_RE = /^(utm_[a-z0-9_]+|fbclid|ttclid)$/i;
const ATTRIBUTION_KEYS = Object.freeze(['fbclid', 'ttclid']);

export const STORAGE_KEYS = Object.freeze({
  sessionFired: 'rrk:session_fired',
  sessionImpressions: 'rrk:session_impressions',
  lastFiredAt: 'rrk:last_fired_at',
  converted: 'rrk:converted'
});

// ---------------------------------------------------------------------------
// 归因参数
// ---------------------------------------------------------------------------

/**
 * 只保留 utm_* 与 fbclid / ttclid，避免把邮箱、订单号之类敏感参数带到回流页。
 * @param {Record<string, string|number|null|undefined>} params
 * @returns {Record<string, string>}
 */
export function filterAttribution(params = {}) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (!ATTRIBUTION_KEY_RE.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * 把归因参数追加到链接上（已有同名参数会覆盖，保留其他参数与 hash）。
 * 纯字符串实现，支持相对路径（/offer、./next），不依赖 URL 构造函数。
 * @param {string} href
 * @param {Record<string, string>} attribution
 */
export function appendAttribution(href, attribution = {}) {
  const params = filterAttribution(attribution);
  const source = typeof href === 'string' && href.length > 0 ? href : '/';
  const hashIndex = source.indexOf('#');
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  const query = search.toString();
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

// ---------------------------------------------------------------------------
// 1) 触发条件判定
// ---------------------------------------------------------------------------

/**
 * 判断某个信号是否应该触发回流承接（只做「条件是否成立」，不做频次/已转化判断）。
 *
 * @param {{
 *   signal: 'back'|'revisit'|'exit_intent',
 *   trigger?: 'back'|'revisit'|'both',
 *   dwellMs?: number,
 *   minDwellMs?: number,
 *   awayMs?: number,
 *   minAwaySeconds?: number
 * }} input
 * @returns {{matched: boolean, reason: string, signal: string, trigger: string, dwellMs: number, awayMs: number}}
 */
export function evaluateRetentionTrigger(input = {}) {
  const { signal } = input;
  const trigger = input.trigger ?? DEFAULT_RETENTION_POLICY.trigger;
  const dwellMs = Number(input.dwellMs ?? 0);
  const minDwellMs = Number(input.minDwellMs ?? DEFAULT_RETENTION_POLICY.minDwellMs);
  const awayMs = Number(input.awayMs ?? 0);
  const minAwaySeconds = Number(input.minAwaySeconds ?? DEFAULT_RETENTION_POLICY.minAwaySeconds);

  if (!Object.prototype.hasOwnProperty.call(SIGNAL_MODE, signal)) {
    throw new TypeError(`未知 signal：${String(signal)}（可选 back / revisit / exit_intent）`);
  }
  if (!Object.values(TRIGGER_MODES).includes(trigger)) {
    throw new TypeError(`未知 trigger：${String(trigger)}（可选 back / revisit / both）`);
  }

  const signalMode = SIGNAL_MODE[signal];
  const base = { signal, trigger, dwellMs, awayMs };

  if (trigger !== TRIGGER_MODES.BOTH && trigger !== signalMode) {
    return { ...base, matched: false, reason: 'trigger_mismatch' };
  }
  if (!Number.isFinite(dwellMs) || dwellMs < minDwellMs) {
    return { ...base, matched: false, reason: 'dwell_below_minimum' };
  }
  if (signalMode === TRIGGER_MODES.REVISIT) {
    if (!Number.isFinite(awayMs) || awayMs < minAwaySeconds * 1000) {
      return { ...base, matched: false, reason: 'away_too_short' };
    }
  }
  return { ...base, matched: true, reason: 'matched' };
}

// ---------------------------------------------------------------------------
// 2) 频次 / 冷却 / 已转化 判断
// ---------------------------------------------------------------------------

/**
 * 判断此刻是否真的可以展示回流承接（频次闸门）。
 *
 * - `once_per_session`：同一会话只展示一次（sessionStorage 记录）
 * - `cooldown_hours`：距离上次展示不足 N 小时则不再展示（localStorage 记录）
 * - `always`：不做频次限制（仅供调试/内部演示）
 * - `suppressAfterConversion`：用户已点过主 CTA / 提交过表单则永久静默
 *
 * @param {{
 *   frequency?: 'once_per_session'|'cooldown_hours'|'always',
 *   cooldownHours?: number,
 *   suppressAfterConversion?: boolean,
 *   converted?: boolean,
 *   sessionFired?: boolean,
 *   sessionImpressions?: number,
 *   maxImpressionsPerSession?: number,
 *   lastFiredAt?: number|null,
 *   now?: number
 * }} input
 * @returns {{fire: boolean, reason: string, remainingMs?: number}}
 */
export function shouldFireRetention(input = {}) {
  const frequency = input.frequency ?? DEFAULT_RETENTION_POLICY.frequency;
  const cooldownHours = Number(input.cooldownHours ?? DEFAULT_RETENTION_POLICY.cooldownHours);
  const suppressAfterConversion =
    input.suppressAfterConversion ?? DEFAULT_RETENTION_POLICY.suppressAfterConversion;
  const converted = Boolean(input.converted);
  const sessionFired = Boolean(input.sessionFired);
  const sessionImpressions = Number(input.sessionImpressions ?? 0);
  const maxImpressionsPerSession = Number(
    input.maxImpressionsPerSession ?? DEFAULT_RETENTION_POLICY.maxImpressionsPerSession
  );
  const lastFiredAt = input.lastFiredAt ?? null;
  const now = Number(input.now ?? 0);

  if (suppressAfterConversion && converted) {
    return { fire: false, reason: 'converted_suppressed' };
  }

  if (frequency === 'once_per_session') {
    if (sessionFired || sessionImpressions >= maxImpressionsPerSession) {
      return { fire: false, reason: 'session_cap_reached' };
    }
    return { fire: true, reason: 'allowed' };
  }

  if (frequency === 'cooldown_hours') {
    if (!Number.isFinite(cooldownHours) || cooldownHours <= 0) {
      throw new TypeError('cooldown_hours 模式下 cooldownHours 必须是正数');
    }
    if (Number.isFinite(lastFiredAt) && lastFiredAt > 0) {
      const elapsed = now - lastFiredAt;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      if (elapsed >= 0 && elapsed < cooldownMs) {
        return { fire: false, reason: 'cooldown_active', remainingMs: cooldownMs - elapsed };
      }
    }
    return { fire: true, reason: 'allowed' };
  }

  if (frequency === 'always') {
    return { fire: true, reason: 'allowed' };
  }

  throw new TypeError(`未知 frequency：${String(frequency)}（可选 once_per_session / cooldown_hours / always）`);
}

// ---------------------------------------------------------------------------
// 3) 回流承接页模型（Popup / Feed）
// ---------------------------------------------------------------------------

function requireCardTitle(card, index) {
  if (!card || typeof card.title !== 'string' || card.title.trim() === '') {
    throw new TypeError(`feed 第 ${index + 1} 张卡片缺少 title`);
  }
}

/**
 * 构造回流承接页的视图模型，交给渲染层（Vue/React/原生 DOM 都行）。
 *
 * - `popup`：页面级回流弹窗（标题 / 副标题 / 福利钩子码 / 主 CTA / 倒计时）
 * - `feed`：整屏信息流回流页（3–6 张卡片，每张带独立 CTA，全部透传归因参数）
 *
 * @param {{
 *   format?: 'popup'|'feed',
 *   campaign?: {title?: string, subtitle?: string, hookCode?: string, ctaLabel?: string, ctaHref?: string, countdownSeconds?: number, dismissLabel?: string},
 *   cards?: Array<{id?: string, title: string, subtitle?: string, tag?: string, ctaLabel?: string, href?: string}>,
 *   attribution?: Record<string, string>,
 *   countdownSeconds?: number
 * }} input
 */
export function buildReturnViewModel(input = {}) {
  const format = input.format ?? 'popup';
  const campaign = input.campaign ?? {};
  const attribution = filterAttribution(input.attribution ?? {});
  const countdownSeconds = Number(
    campaign.countdownSeconds ?? input.countdownSeconds ?? 0
  );

  if (format === 'popup') {
    return {
      format,
      title: campaign.title || '先别走，这些内容你还没看完',
      subtitle: campaign.subtitle || '留下来继续看，本期精选已经准备好了',
      hookCode: campaign.hookCode ?? '',
      countdownSeconds: Number.isFinite(countdownSeconds) ? Math.max(0, countdownSeconds) : 0,
      cta: {
        label: campaign.ctaLabel || '继续看本期精选',
        href: appendAttribution(campaign.ctaHref || '/', attribution)
      },
      dismissLabel: campaign.dismissLabel || '先不用，继续浏览',
      attribution
    };
  }

  if (format === 'feed') {
    const cards = Array.isArray(input.cards) ? input.cards : [];
    if (cards.length < 3 || cards.length > 6) {
      throw new RangeError(`feed 需要 3–6 张卡片，收到 ${cards.length} 张`);
    }
    return {
      format,
      title: campaign.title || '换个方向继续看',
      subtitle: campaign.subtitle || '这些是根据你刚才的浏览挑出来的',
      cards: cards.map((card, index) => {
        requireCardTitle(card, index);
        return {
          id: card.id || `card-${index + 1}`,
          title: card.title,
          subtitle: card.subtitle || '',
          tag: card.tag || '',
          cta: {
            label: card.ctaLabel || '查看',
            href: appendAttribution(card.href || '/', attribution)
          }
        };
      }),
      dismissLabel: campaign.dismissLabel || '回到刚才的页面',
      attribution
    };
  }

  throw new RangeError(`未知 format：${String(format)}（可选 popup / feed）`);
}

// ---------------------------------------------------------------------------
// 4) PWA Manifest / Service Worker 生成
// ---------------------------------------------------------------------------

export const DEFAULT_PWA_ICONS = Object.freeze([
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
]);

const DISPLAY_MODES = new Set(['standalone', 'fullscreen', 'minimal-ui', 'browser', 'window-controls-overlay']);
const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * 生成 manifest.webmanifest 对象。start_url 自动追加 utm_source=pwa_homescreen，
 * 这样从桌面图标启动的会话能和浏览器会话分开归因。
 *
 * @param {{
 *   name: string, shortName?: string, description?: string,
 *   themeColor?: string, backgroundColor?: string, display?: string,
 *   startUrl?: string, scope?: string, lang?: string, orientation?: string,
 *   icons?: Array<{src: string, sizes: string, type?: string, purpose?: string}>,
 *   utmSource?: string
 * }} input
 */
export function generatePwaManifest(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const shortName = typeof input.shortName === 'string' ? input.shortName.trim() : '';
  if (!name) throw new TypeError('generatePwaManifest 需要 name');
  if (!shortName) throw new TypeError('generatePwaManifest 需要 shortName（桌面图标下的简称）');

  const display = input.display ?? 'standalone';
  if (!DISPLAY_MODES.has(display)) {
    throw new RangeError(`未知 display：${String(display)}`);
  }

  const icons = Array.isArray(input.icons) && input.icons.length > 0 ? input.icons : DEFAULT_PWA_ICONS;
  for (const icon of icons) {
    if (!icon || typeof icon.src !== 'string' || typeof icon.sizes !== 'string') {
      throw new TypeError('每个 icon 都需要 src 与 sizes');
    }
  }

  const startUrl = input.startUrl || '/';
  const utmSource = input.utmSource || 'pwa_homescreen';
  const startUrlWithAttribution = appendAttribution(startUrl, { utm_source: utmSource });

  return {
    name,
    short_name: shortName,
    description: input.description || '',
    lang: input.lang || 'zh-CN',
    start_url: startUrlWithAttribution,
    scope: input.scope || '/',
    display,
    orientation: input.orientation || 'portrait',
    theme_color: input.themeColor || '#0f172a',
    background_color: input.backgroundColor || '#0f172a',
    icons: icons.map((icon) => ({
      src: icon.src,
      sizes: icon.sizes,
      type: icon.type || 'image/png',
      purpose: icon.purpose || 'any'
    }))
  };
}

/**
 * 校验 manifest 是否满足「能装到桌面」的最低要求。
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest 必须是对象'], warnings };
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') errors.push('缺少 name');
  if (typeof manifest.short_name !== 'string' || manifest.short_name.trim() === '') {
    errors.push('缺少 short_name（桌面图标下的简称）');
  }
  if (typeof manifest.start_url !== 'string' || !manifest.start_url.startsWith('/')) {
    errors.push('start_url 必须是以 / 开头的站内路径');
  }
  if (!DISPLAY_MODES.has(manifest.display)) errors.push('display 取值不合法');

  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    errors.push('icons 不能为空');
  } else {
    const sizes = manifest.icons.map((icon) => String(icon && icon.sizes));
    if (!sizes.includes('192x192')) errors.push('icons 里缺少 192x192（Android 桌面图标要求）');
    if (!sizes.includes('512x512')) errors.push('icons 里缺少 512x512（安装横幅与商店要求）');
    for (const icon of manifest.icons) {
      if (!icon || typeof icon.src !== 'string' || !icon.src) errors.push('存在没有 src 的 icon');
    }
  }

  if (!manifest.theme_color || !HEX_COLOR_RE.test(String(manifest.theme_color))) {
    warnings.push('theme_color 建议写成 #RRGGBB');
  }
  if (!manifest.background_color || !HEX_COLOR_RE.test(String(manifest.background_color))) {
    warnings.push('background_color 建议写成 #RRGGBB');
  }
  if (typeof manifest.start_url === 'string' && !/[?&]utm_source=/.test(manifest.start_url)) {
    warnings.push('start_url 没有 utm_source，桌面图标的会话无法单独归因');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 生成 Network-First 的 Service Worker 源码（零依赖、可直接落到 sw.js）。
 * Network-First：先请求网络，成功就回填缓存；断网时回退缓存，导航请求再回退离线页。
 *
 * @param {{cacheName?: string, version?: string, offlineUrl?: string, networkFirst?: boolean}} input
 * @returns {string}
 */
export function generateServiceWorkerScript(input = {}) {
  const cacheName = String(input.cacheName || 'pwa-retention-cache');
  const version = String(input.version || 'v1');
  const offlineUrl = String(input.offlineUrl || '/offline.html');
  const networkFirst = input.networkFirst !== false;
  const fullCacheName = `${cacheName}-${version}`;

  return `/* Generated by pwa-return-retention-kit — Network-First Service Worker (zero dependencies). */
const CACHE_NAME = ${JSON.stringify(fullCacheName)};
const OFFLINE_URL = ${JSON.stringify(offlineUrl)};
const PRECACHE_URLS = [OFFLINE_URL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // 只缓存同源请求；跨域资源交给浏览器自身缓存策略
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' || ${networkFirst ? 'true' : 'false'}) {
    event.respondWith(networkFirstStrategy(request));
  } else {
    event.respondWith(cacheFirstStrategy(request));
  }
});

async function networkFirstStrategy(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw error;
  }
}

async function cacheFirstStrategy(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}
`;
}

// ---------------------------------------------------------------------------
// 5) PWA 安装策略识别
// ---------------------------------------------------------------------------

const WEBVIEW_RE = /(FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|TikTok|musical_ly|Snapchat|Twitter|; wv\)|WebView)/i;
const IOS_RE = /(iPhone|iPad|iPod)/i;
const IOS_NON_SAFARI_RE = /(CriOS|FxiOS|EdgiOS|OPiOS)/i;
const ANDROID_RE = /Android/i;
const ANDROID_CHROME_RE = /(Chrome\/|Chromium\/)/i;
const ANDROID_OTHER_BROWSER_RE = /(SamsungBrowser|EdgA|OPR\/|Firefox)/i;

/**
 * 判断当前环境该走哪种 PWA 安装引导。
 *
 * 返回 environment：
 *  - `standalone`        已经从桌面图标启动，无需安装引导
 *  - `webview`           App 内置 WebView（广告/社交 App 里打开），无法安装，需引导去外部浏览器
 *  - `ios-safari`        iOS Safari：无 beforeinstallprompt，走「分享 → 添加到主屏幕」图文引导
 *  - `ios-other-browser` iOS 上的第三方浏览器：同样走分享菜单引导
 *  - `android-chrome`    Android Chrome：监听 beforeinstallprompt，可原生弹安装
 *  - `android-other`     Android 其他浏览器：走菜单手动安装
 *  - `desktop-browser`   桌面浏览器：地址栏安装图标或原生 prompt
 *
 * @param {string} userAgent
 * @param {boolean} standalone
 */
export function detectInstallStrategy(userAgent = '', standalone = false) {
  const ua = String(userAgent || '');

  if (standalone) {
    return {
      environment: 'standalone',
      strategy: 'already-installed',
      canPrompt: false,
      requiresUserGesture: false,
      title: '已从桌面图标启动',
      steps: ['直接进入应用，不需要安装引导']
    };
  }

  if (WEBVIEW_RE.test(ua)) {
    return {
      environment: 'webview',
      strategy: 'open-external-browser',
      canPrompt: false,
      requiresUserGesture: true,
      title: '当前是 App 内置浏览器',
      steps: ['点右上角「…」打开菜单', '选择「在浏览器中打开」', '在外部浏览器里按安装引导操作']
    };
  }

  if (IOS_RE.test(ua)) {
    const safari = !IOS_NON_SAFARI_RE.test(ua);
    return {
      environment: safari ? 'ios-safari' : 'ios-other-browser',
      strategy: 'ios-share-guide',
      canPrompt: false,
      requiresUserGesture: false,
      title: 'iOS 添加到主屏幕',
      steps: ['点击 Safari 底部的分享按钮', '向下选择「添加到主屏幕」', '确认名称后点「添加」']
    };
  }

  if (ANDROID_RE.test(ua)) {
    if (ANDROID_CHROME_RE.test(ua) && !ANDROID_OTHER_BROWSER_RE.test(ua)) {
      return {
        environment: 'android-chrome',
        strategy: 'native-prompt',
        canPrompt: true,
        requiresUserGesture: true,
        title: '安装到桌面',
        steps: ['监听 beforeinstallprompt 并缓存事件', '用户点击按钮时调用 prompt()', '监听 userChoice 记录安装结果']
      };
    }
    return {
      environment: 'android-other',
      strategy: 'manual-guide',
      canPrompt: false,
      requiresUserGesture: false,
      title: '通过浏览器菜单安装',
      steps: ['点浏览器右上角菜单', '选择「安装应用」或「添加到主屏幕」', '确认添加']
    };
  }

  return {
    environment: 'desktop-browser',
    strategy: 'manual-guide',
    canPrompt: true,
    requiresUserGesture: true,
    title: '安装到桌面',
    steps: ['支持时监听 beforeinstallprompt', '不支持时点地址栏右侧的安装图标', '在应用菜单里选择「安装」']
  };
}

// ---------------------------------------------------------------------------
// 6) 存储与运行时
// ---------------------------------------------------------------------------

/** 内存版 Web Storage，用于 Node 测试、SSR 或隐私模式兜底。 */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    _dump() {
      return Object.fromEntries(map);
    }
  };
}

function readStorage(storage, key) {
  try {
    return storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    if (storage && typeof storage.setItem === 'function') storage.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：静默降级，不阻塞展示 */
  }
}

function removeStorage(storage, key) {
  try {
    if (storage && typeof storage.removeItem === 'function') storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * 会话级与跨会话的频次状态读写。依赖注入 storage，浏览器传 sessionStorage/localStorage，
 * Node 测试传 createMemoryStorage()。
 */
export function createRetentionStore({
  sessionStorage = null,
  localStorage = null,
  now = () => Date.now(),
  keyPrefix = 'rrk'
} = {}) {
  const keys = {
    sessionFired: `${keyPrefix}:session_fired`,
    sessionImpressions: `${keyPrefix}:session_impressions`,
    lastFiredAt: `${keyPrefix}:last_fired_at`,
    converted: `${keyPrefix}:converted`
  };

  function snapshot() {
    const rawLast = Number(readStorage(localStorage, keys.lastFiredAt));
    const rawImpressions = Number(readStorage(sessionStorage, keys.sessionImpressions));
    return {
      sessionFired: readStorage(sessionStorage, keys.sessionFired) === '1',
      sessionImpressions: Number.isFinite(rawImpressions) ? rawImpressions : 0,
      lastFiredAt: Number.isFinite(rawLast) && rawLast > 0 ? rawLast : null,
      converted:
        readStorage(localStorage, keys.converted) === '1' ||
        readStorage(sessionStorage, keys.converted) === '1'
    };
  }

  return {
    keys,
    snapshot,
    recordFire() {
      writeStorage(sessionStorage, keys.sessionFired, '1');
      const next = snapshot().sessionImpressions + 1;
      writeStorage(sessionStorage, keys.sessionImpressions, String(next));
      writeStorage(localStorage, keys.lastFiredAt, String(now()));
    },
    markConverted() {
      writeStorage(localStorage, keys.converted, '1');
      writeStorage(sessionStorage, keys.converted, '1');
    },
    reset() {
      for (const key of Object.values(keys)) {
        removeStorage(sessionStorage, key);
        removeStorage(localStorage, key);
      }
    }
  };
}

/**
 * 浏览器端返回键 / 切后台 / 鼠标移出 三种信号的回流拦截器。
 *
 * 用法（浏览器）：
 *   const interceptor = createBackInterceptor({
 *     window, document, history,
 *     sessionStorage, localStorage,
 *     policy: { trigger: 'both', minDwellMs: 3000, minAwaySeconds: 5 },
 *     buildModel: ({ attribution }) => buildReturnViewModel({ format: 'popup', attribution }),
 *     onFire: ({ model }) => renderReturnView(model)
 *   });
 *
 * 注意：pushState 接管返回键的做法必须给用户留「关闭/继续浏览」出口，
 * 且同一会话最多打扰一次（默认策略），不允许劫持后退到无法离开。
 *
 * 返回控制器的方法都是幂等的，destroy() 之后再触发不会展示。
 */
export function createBackInterceptor(options = {}) {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...(options.policy || {}) };
  const now = options.now || (() => Date.now());
  const win = options.window ?? globalThis.window;
  const doc = options.document ?? globalThis.document;
  const history = options.history ?? globalThis.history;
  const sessionStorage = options.sessionStorage ?? null;
  const localStorage = options.localStorage ?? null;
  const onFire = options.onFire || (() => {});
  const onSkip = options.onSkip || (() => {});
  const buildModel = options.buildModel || null;
  const attribution = filterAttribution(options.attribution || {});
  const autoArm = options.autoArm !== false;

  const store = createRetentionStore({ sessionStorage, localStorage, now });
  const startedAt = now();
  const listeners = [];
  const log = [];
  let enabled = true;
  let armed = false;
  let destroyed = false;
  let hiddenAt = null;

  function record(entry) {
    log.push({ at: now(), ...entry });
    return log[log.length - 1];
  }

  function bind(target, type, handler, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, opts);
    listeners.push(() => {
      if (typeof target.removeEventListener === 'function') target.removeEventListener(type, handler, opts);
    });
  }

  function arm() {
    if (destroyed || !enabled) return false;
    if (history && typeof history.pushState === 'function') {
      try {
        history.pushState({ __rrk: true, at: now() }, '');
      } catch {
        /* 跨域 iframe 等场景可能抛错，忽略 */
      }
    }
    armed = true;
    return true;
  }

  function decide(signal, extra = {}) {
    if (destroyed || !enabled) return record({ type: 'skip', fire: false, signal, reason: 'disabled' });

    const snapshot = store.snapshot();
    const triggerResult = evaluateRetentionTrigger({
      signal,
      trigger: policy.trigger,
      dwellMs: now() - startedAt,
      minDwellMs: policy.minDwellMs,
      awayMs: extra.awayMs ?? 0,
      minAwaySeconds: policy.minAwaySeconds
    });

    if (!triggerResult.matched) {
      const result = record({ type: 'skip', fire: false, signal, reason: triggerResult.reason, trigger: policy.trigger });
      onSkip(result);
      return result;
    }

    const gate = shouldFireRetention({
      frequency: policy.frequency,
      cooldownHours: policy.cooldownHours,
      suppressAfterConversion: policy.suppressAfterConversion,
      converted: snapshot.converted,
      sessionFired: snapshot.sessionFired,
      sessionImpressions: snapshot.sessionImpressions,
      maxImpressionsPerSession: policy.maxImpressionsPerSession,
      lastFiredAt: snapshot.lastFiredAt,
      now: now()
    });

    if (!gate.fire) {
      const result = record({ type: 'skip', fire: false, signal, reason: gate.reason, trigger: policy.trigger });
      onSkip(result);
      return result;
    }

    store.recordFire();
    const model = buildModel
      ? buildModel({ signal, trigger: policy.trigger, attribution, now: now() })
      : null;
    const result = record({
      type: 'fire',
      fire: true,
      signal,
      trigger: policy.trigger,
      reason: gate.reason,
      model
    });
    onFire(result);
    return result;
  }

  function handlePopState() {
    // 先重新压入哨兵（用户还在页面上），再判定是否展示回流承接。
    const reArmed = arm();
    return { ...decide(SIGNALS.BACK), reArmed };
  }

  function handleVisibilityChange(state) {
    const visibility = state ?? (doc ? doc.visibilityState : undefined);
    if (visibility === 'hidden') {
      hiddenAt = now();
      return record({ type: 'signal', signal: 'hidden', at: now() });
    }
    if (visibility === 'visible' && hiddenAt !== null) {
      const awayMs = now() - hiddenAt;
      hiddenAt = null;
      return decide(SIGNALS.REVISIT, { awayMs });
    }
    return record({ type: 'noop', signal: 'visibilitychange' });
  }

  function handleMouseOut(event = {}) {
    const related = event.relatedTarget ?? null;
    const clientY = Number(event.clientY ?? 0);
    const leftFromTop = related === null && clientY <= 0;
    if (!leftFromTop) return record({ type: 'noop', signal: SIGNALS.EXIT_INTENT });
    return decide(SIGNALS.EXIT_INTENT);
  }

  function getState() {
    return {
      enabled,
      armed,
      destroyed,
      startedAt,
      hiddenAwayMs: hiddenAt === null ? null : now() - hiddenAt,
      policy: { ...policy },
      snapshot: store.snapshot(),
      log: [...log]
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    while (listeners.length > 0) {
      const unbind = listeners.pop();
      try {
        unbind();
      } catch {
        /* ignore */
      }
    }
    record({ type: 'destroy' });
  }

  bind(win, 'popstate', () => handlePopState());
  bind(doc, 'visibilitychange', () => handleVisibilityChange());
  bind(doc, 'mouseout', (event) => handleMouseOut(event));

  if (autoArm) arm();

  return {
    arm,
    destroy,
    getState,
    getLog: () => [...log],
    store,
    markConverted: () => store.markConverted(),
    handlePopState,
    handleVisibilityChange,
    handleMouseOut,
    /** 手动触发某个信号，便于调试与沙盒演示。 */
    trigger: (signal, extra) => decide(signal, extra),
    get policy() {
      return { ...policy };
    }
  };
}
