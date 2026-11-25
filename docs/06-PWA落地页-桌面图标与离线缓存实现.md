---
title: "把落地页变成桌面图标：PWA 安装拦截、Service Worker 与离线缓存实现"
description: "在不开发原生安装包的前提下，用 Web App Manifest、Service Worker 与 beforeinstallprompt 事件把广告落地页安装到用户手机桌面，提升复访留存。"
keyword: "PWA落地页"
slug: "pwa-landing-page-implementation"
date: 2026-11-25
lang: zh-CN
canonical: "https://guide.ipcloak.ai/pwa-landing-page-implementation/"
tags: ["PWA落地页", "桌面图标", "Service Worker", "出海投放"]
---

# 把落地页变成桌面图标：PWA 安装拦截、Service Worker 与离线缓存实现

> 一句话结论：买量越来越贵，冷流量看一眼关掉就等于白烧广告费。**PWA落地页（渐进式 Web 应用落地页）能用 3 个纯前端文件把网页变成手机主屏幕上的独立图标**，点开全屏运行、无浏览器地址栏，适合短剧、内容站、工具和复购电商做二次触达。

很多投手听说过 PWA，但以为要找客户端开发写原生壳。实际上，标准 PWA 落地页只需要三样东西，全部是纯静态文件：

1. **`manifest.json`**：声明桌面图标名字、尺寸、全屏模式（`display: "standalone"`）和启动 URL。
2. **`sw.js`（Service Worker）**：在后台拦截网络请求，做静态骨架缓存，满足浏览器的可安装（Installable）条件。
3. **`beforeinstallprompt` 安装接管脚本**：把浏览器原本藏在菜单里的「添加到主屏幕」，变成页面首屏按钮的一键弹窗。

下面给出最小可运行的完整代码与 iOS / Android 双端兼容方案。

---

## 一、双端安装机制差异（为什么不能只写一套按钮）

Android Chrome 和 iOS Safari 对 PWA 安装的支持完全不同，代码必须做分支处理：

```text
用户点击页面上的「安装到桌面 / Add to Home Screen」按钮
        │
        ├──► [分支 A：Android Chrome / Edge（已触发 beforeinstallprompt）]
        │       调用 deferredPrompt.prompt()
        │       弹出系统原生底部安装确认卡 → 用户点确认 → 桌面生成图标
        │       监听 appinstalled 事件 → 上报一次 pwa_install 转化埋点
        │
        ├──► [分支 B：iOS Safari（不支持 beforeinstallprompt）]
        │       检测 /iPhone|iPad|iPod/ 且 !navigator.standalone
        │       弹出图文指引浮层：「点底部 Safari 分享图标 [↑] → 选『添加到主屏幕』」
        │
        └──► [分支 C：已经在桌面独立模式打开（display-mode: standalone）]
                隐藏安装按钮，直接展示「立即进入主功能 / 继续观看」
```

---

## 二、最小 `manifest.json` 规范（缺一不可的字段）

要让 Chrome 触发安装事件，`manifest.json` 必须包含 `name`、`short_name`、`start_url`、`display`（设为 `standalone`），以及至少两张尺寸为 `192x192` 和 `512x512` 的图标：

```json
{
  "name": "PulsePlay Drama & Short Series",
  "short_name": "PulsePlay",
  "description": "Watch bite-sized series with instant resume from your home screen.",
  "start_url": "./index.html?utm_source=pwa_homescreen",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    {
      "src": "./icon-192.svg",
      "sizes": "192x192",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    },
    {
      "src": "./icon-512.svg",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ]
}
```

> 实战技巧：把 `start_url` 带上 `?utm_source=pwa_homescreen`。这样用户每次从手机桌面点图标回来时，你的统计后台都能清晰区分「哪部分流量是广告刚买来的，哪部分是桌面图标免费复访的」。

---

## 三、Service Worker 离线骨架（`sw.js`）

落地页的 Service Worker **千万不要无脑缓存所有接口请求**，否则你改了落地页价格或换了活动文案，老用户看到的还是三天前的旧缓存。

最稳妥的策略是：**HTML 页面走「网络优先，断网才读缓存（Network First）」，纯静态图标走「缓存优先（Cache First）」**：

```js
// sw.js —— 网络优先的轻量落地页 Service Worker
const CACHE_NAME = 'lp-pwa-shell-v1';
const PRECACHE_URLS = ['./index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 页面导航请求：永远优先读线上最新版，只有断网时才用本地缓存兜底
  event.respondWith(
    fetch(event.request)
      .then((networkRes) => {
        const clone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return networkRes;
      })
      .catch(() => caches.match(event.request))
  );
});
```

---

## 四、前端安装拦截与状态控制器（完整代码）

把下面这段控制器放进落地页底部，就能同时处理 Android 原生安装弹窗、iOS 手动指引弹窗和已安装状态识别：

```js
(function initPwaController() {
  let deferredPrompt = null;
  const installBtn = document.getElementById('pwa-install-btn');
  const iosModal = document.getElementById('pwa-ios-guide-modal');

  // 1. 判断是否已经处于桌面独立应用模式
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone && installBtn) {
    installBtn.textContent = '已添加到主屏幕 · 立即开始';
  }

  // 2. 注册 Service Worker（必须在 HTTPS 或 localhost 下运行）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // 3. 拦截 Android Chrome 的原生安装事件
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.setAttribute('data-ready', 'native');
  });

  // 4. 监听安装完成事件，上报一次转化
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (installBtn) installBtn.textContent = '安装完成';
    // 这里可触发自定义事件或像素：pwa_install_success
  });

  // 5. 点击安装按钮时的三分支路由
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        return;
      }
      // iOS 或内置浏览器：展示手动「分享 -> 添加到主屏幕」图文浮层
      if (iosModal) iosModal.hidden = false;
    });
  }
})();
```

---

## 五、PWA 落地页的 4 个常见坑

1. **在 Facebook / TikTok 内置浏览器里点安装没反应**：App 内置 WebView 不支持 `beforeinstallprompt`。必须在页面里检测内置浏览器 UA，提示用户「点右上角在 Chrome / Safari 中打开」，或者配合系统浏览器唤起方案。
2. **没配安全传输协议（TLS/HTTPS）**：除了本地 `localhost` 调试环境，Service Worker 在明文非加密协议下会被浏览器直接拒绝注册。
3. **缓存把 UTM 参数吃掉了**：预缓存列表只放 `./index.html` 骨架，安装前先把首次进站的 `fbclid` / `utm_*` 存进 `localStorage`，这样用户装完从桌面打开时还能把线索归因回最初那条广告。
4. **把所有品都做成 PWA**：一次性冲动消费的标品没必要让用户装桌面图标；高频复访的短剧、小说、工具、本地生活服务或会员复购站，PWA 的二次打开率才真正划算。

---

<sub>本文由爱普出海团队整理。配套的可运行 PWA 落地页骨架（`index.html` + `manifest.json` + `sw.js`）已开源在 `landing-page-starter-demos/templates/pwa-app-landing/` 目录。</sub>
