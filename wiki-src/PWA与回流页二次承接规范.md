# PWA 桌面图标与回流页（Return Page）二次承接规范

这份规范汇总 `pwa-return-retention-kit` 与 `landing-page-starter-demos` 两个仓库中关于**落地页二次触达与桌面留存**的公开实现标准。

## 1. 为什么把「回流页」和「PWA」放在一条链路里

| 机制 | 触发时刻 | 解决的流失点 | 形态 |
|---|---|---|---|
| **页面级回流弹窗 (`Popup`)** | 访客点返回键 (`popstate`) 或切后台 ≥8 秒再切回 (`visibilitychange`) | 主页面卖点太重、用户准备离开时的当次挽留 | 半透明卡片（短视频/福利钩子/轻量咨询入口） |
| **整屏信息流回流页 (`Feed`)** | 同上 | 用户对单一商品无感，但对同类推荐/短剧合集/热门问答有浏览意愿 | 整屏切换为 3–6 张可点击内容卡片流，每张卡片继承原页 UTM |
| **PWA 桌面图标 (`Manifest + SW`)** | 用户在主页面或回流层点击「添加到主屏幕」 | 关掉浏览器后找不到入口、二次触达还要再花广告费 | 手机主屏幕生成独立图标，全屏 `standalone` 打开，启动 URL 带 `utm_source=pwa_homescreen` |

## 2. 回流触发与防打扰 4 条硬规则

1. **单次哨兵历史栈**：只在用户发生首次交互（`pointerdown` / `scroll`）后调用一次 `history.pushState`，触发一次 `popstate` 后立即消耗，绝不二次重压锁死返回键。
2. **最短停留时间门槛（`minDwellMs >= 3000`）**：进站未满 3 秒秒退的访客不触发拦截。
3. **同会话只弹一次（`oncePerSession`）**：写入 `sessionStorage`，刷新页面也不会反复弹窗。
4. **已转化自动静默（`suppressAfterConversion`）**：一旦用户点击过主页面 CTA 或提交过表单，回流状态机立即标记 `converted = true`，后续返回或切后台不再弹出。

## 3. PWA 三端安装引导策略 (`detectInstallStrategy`)

```js
export function detectInstallStrategy(userAgent = '', isStandalone = false) {
  if (isStandalone) {
    return { mode: 'already_installed', action: 'open_app_view' };
  }
  const ua = String(userAgent);
  // 1. Facebook / Instagram / TikTok / Line 等内置浏览器：先提示跳系统浏览器
  if (/(FBAN|FBAV|Instagram|BytedanceWebview|TikTok|Line\/|MicroMessenger)/i.test(ua)) {
    return { mode: 'in_app_webview', action: 'prompt_open_system_browser' };
  }
  // 2. iOS Safari：不支持 beforeinstallprompt，展示「点底部 [↑] 分享 -> 添加到主屏幕」图文浮层
  if (/(iPhone|iPad|iPod)/i.test(ua) && /Safari/i.test(ua) && !/(CriOS|FxiOS|EdgiOS)/i.test(ua)) {
    return { mode: 'ios_safari_manual', action: 'show_ios_share_sheet_guide' };
  }
  // 3. Android Chrome / Edge：拦截 beforeinstallprompt 弹出系统原生安装卡
  return { mode: 'chromium_native_prompt', action: 'trigger_deferred_prompt' };
}
```

## 4. 相关仓库

- PWA 动态生成 + 回流页（Popup & Feed）状态机与离线交互沙盒：[pwa-return-retention-kit](https://github.com/{ORG}/pwa-return-retention-kit)
- 3 套微模板骨架（含 PWA 落地页模板）：[landing-page-starter-demos](https://github.com/{ORG}/landing-page-starter-demos)
