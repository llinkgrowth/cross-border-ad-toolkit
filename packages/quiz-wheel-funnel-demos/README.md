# quiz-wheel-funnel-demos —— Interactive Quiz / StepFlow & PrizeWheel Funnel Suite

> 广告落地页互动漏斗开源参考套件：多步问答分支路由（Quiz / StepFlow）、浏览器本地加权转盘（PrizeWheel + `localStorage` 防刷锁）、FB/IG/TikTok 内置浏览器跳出辅助，附带 Node.js CLI 与单文件双 Tab 离线沙盒。
> Zero-dependency interactive landing page funnel engine featuring multi-step Quiz scoring & WhatsApp audience routing (`evaluateQuizFunnel`), deterministic/weighted PrizeWheel with `localStorage` idempotency lock (`spinPrizeWheel`), In-App WebView external browser handoff (`buildExternalBrowserHandoff`), CLI simulator, and offline HTML sandbox.

## 这是什么 · What it is

在出海私域引流（WhatsApp / LINE 咨询）与独立站促销落地页中，直接放一个冷冰冰的长表单或无筛选的客服按钮，往往面临两大问题：**访客跳出率高**，以及**高低意向线索混杂在一起冲垮人工坐席**。

`quiz-wheel-funnel-demos` 将高转化互动落地页背后的三个核心工程模块抽离为**零外部依赖、纯函数、前后端与 CLI 通用**的开源参考套件：

1. **多步问答分支路由引擎 (`evaluateQuizFunnel`)**：用 3–5 步轻量点选问答替代长表单，实时计算意向分（`score`）与人群标签（`high_intent` / `urgent` / `budget_sensitive`），将高意向访客自动分流至 VIP WhatsApp 专线、普通访客分流至自助领券页，并把问答摘要（如 `[Quiz: SkinType=Dry | Goal=AntiAging]`）自动编码进 WhatsApp 预填开场白，同时无损透传 `utm_*`、`fbclid`、`ttclid`。
2. **本地加权幸运转盘与防刷门禁 (`spinPrizeWheel` + `validateWheelConfig`)**：支持 6–8 扇区加权抽取、精确旋转角度计算（`360 * minSpins + sectorCenterAngle`）、优惠码绑定，并通过 `localStorage` 幂等锁保证**同一访客刷新页面后结果恒定不变**；上线前由 `validateWheelConfig` 强制校验权重和与有效 CTA 链接。
3. **移动端内置浏览器跳出辅助 (`buildExternalBrowserHandoff`)**：精准识别 Facebook (`FBAN`/`FBAV`)、Instagram、TikTok (`BytedanceWebview`) 内置 WebView，自动生成 Android `intent://` 唤起系统浏览器链接或 iOS 右上角 Safari 引导状态，解决 App 内置浏览器无法顺畅拉起 WhatsApp 的顽疾。

---

## 为什么「先互动再留资」比冷冰冰的长表单转化更高？ · Why Interactive Funnels Work

| 对比维度 | 传统静态长表单落地页 | 互动问答 / 转盘漏斗 (Quiz / PrizeWheel) |
|---|---|---|
| **首屏心理阻力** | 上来就要填姓名、邮箱、电话与长文本，移动端输入摩擦力极高 | 首屏仅需点击大号卡片（「你的肤质是？」或「点击抽取新人券」），遵循微小承诺递进（Micro-Commitments）原则 |
| **线索分层与坐席效率** | 所有点击无差别涌入同一个客服号，人工坐席需反复追问基础背景 | 在跳转前完成评分与打标：高意向（`score >= 80`）进 VIP 1 对 1 专线，预算敏感进自助资料页 |
| **客服首句沟通效率** | 访客打开 WhatsApp 只发一句空白或 `"Hi"`，客服还要重头问需求 | 预填话术自动携带结构化摘要 `[Quiz: SkinType=Dry \| Goal=AntiAging]`，坐席一眼看懂客户画像 |
| **广告归因完整性** | 多步跳转容易丢失入口 URL 上的 `utm_*`、`fbclid`、`ttclid` | 状态机全程保留并在最终生成的 `wa.me` 或领券 URL 上无损合并全部归因参数 |

---

## 快速开始 · Quick start

无需 `npm install`（零第三方依赖，仅依赖 Node.js 20+ 内置模块）：

```bash
# 1. 运行全部单元测试（26 个 node:test 用例）
npm test

# 2. 模拟 1000 次转盘旋转（对比各扇区理论权重占比 vs 实际命中率与旋转停止角度）
node cli.mjs simulate-wheel --spins 1000

# 3. 测试多步问答计分、人群分层与 WhatsApp 预填话术生成
node cli.mjs route-quiz --answers "q1:b,q2:a,q3:c" --url "https://example.com/lp?utm_source=tiktok&ttclid=TT99" --json

# 4. 检测 Facebook / TikTok 内置浏览器并生成跳出辅助方案
node cli.mjs check-webview --ua "Mozilla/5.0 (Linux; Android 14; Pixel 8) [FBAN/FB4A;FBAV/440.0]" --target "https://wa.me/123456" --json

# 5. 打开单文件双 Tab 离线交互沙盒
open index.html
```

---

## Quiz 分支路由状态机图 · Quiz Routing State Machine

```text
Incoming Ad Click: https://lp.example.com/quiz?utm_source=tiktok&ttclid=TT99
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ StepFlow Quiz Collector (3–5 Steps)                                       │
│   Step 1 (SkinType) ──► Option "Dry"       (+30 pts, tags: [high_intent]) │
│   Step 2 (Goal)     ──► Option "AntiAging" (+40 pts, tags: [high_intent]) │
│   Step 3 (Timeline) ──► Option "Immediate" (+40 pts, tags: [urgent])      │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ evaluateQuizFunnel() Scoring & Tag Router                                 │
│   totalScore = 110 | primaryTag = "high_intent"                           │
│   summaryTag = "[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=Immediate]"│
└───────┬─────────────────────────────┬─────────────────────────────┬───────┘
        │                             │                             │
  score >= 80 &                 score >= 60 &                 Default / Budget
  has "high_intent"             has "urgent"                  Sensitive Tier
        │                             │                             │
        ▼                             ▼                             ▼
┌───────────────────────┐     ┌───────────────────────┐     ┌───────────────────────┐
│ VIP Concierge Desk    │     │ Priority Fast-Track   │     │ Self-Serve Coupon LP  │
│ wa.me/6581009001      │     │ wa.me/6581009002      │     │ shop.example.com/...  │
│ + Pre-filled Summary  │     │ + Pre-filled Summary  │     │ + quiz_summary param  │
│ + utm_* / ttclid      │     │ + utm_* / ttclid      │     │ + utm_* / ttclid      │
└───────────────────────┘     └───────────────────────┘     └───────────────────────┘
```

---

## 本地转盘加权算法与防刷锁伪代码 · PrizeWheel & Idempotency Lock

为了防止访客发现抽中普通档位后通过**反复刷新浏览器页面（F5 / 下拉刷新）无限重刷大奖**，`spinPrizeWheel` 在本地状态机中内置了 `localStorage` 幂等锁与上线前门禁校验 `validateWheelConfig`：

```text
function validateWheelConfig(config):
  assert config.sectors.length >= 2
  assert sum(sector.weight) > 0
  for each sector in config.sectors:
    if sector.isWin !== false:
      assert isValidHttpUrl(sector.ctaUrl)
      assert isNonEmpty(sector.couponCode)
  return { ok: true }

function spinPrizeWheel(config, options):
  validateWheelConfig(config)
  storageKey = "ipcloak_wheel_lock_" + config.wheelId

  # 1. 幂等锁检查：同一设备刷新页面直接返回首次锁定结果，防止无限刷转盘
  if options.storage.getItem(storageKey) and not options.forceRespin:
    lockedRecord = JSON.parse(options.storage.getItem(storageKey))
    return restoreLockedResult(lockedRecord, options.incomingUrl)

  # 2. 按权重比例抽取扇区（支持基于访客 Seed 的 FNV-1a 确定性抽取或 RNG）
  point = (seed ? fnv1a(seed) / MAX_UINT32 : rng()) * totalWeight
  chosenIndex = findCumulativeSector(config.sectors, point)

  # 3. 计算精确停止角度（至少旋转 minSpins 整圈 + 扇区中心角）
  sectorAngleDeg = 360 / config.sectors.length
  sectorCenterAngle = chosenIndex * sectorAngleDeg + (sectorAngleDeg / 2)
  rotationDeg = 360 * config.minSpins + sectorCenterAngle

  # 4. 写入 localStorage 幂等锁并透传入口 UTM 参数
  options.storage.setItem(storageKey, JSON.stringify({ sectorIndex: chosenIndex, rotationDeg, ... }))
  finalCtaUrl = preserveFunnelAttribution(chosenSector.ctaUrl, options.incomingUrl)
  return { locked: false, sectorIndex: chosenIndex, rotationDeg, ctaUrl: finalCtaUrl }
```

### CLI 1000 次转盘模拟输出示例

运行 `node cli.mjs simulate-wheel --spins 1000`：

```text
====================================================================================================
PrizeWheel Simulation Report · wheelId="summer-promo-wheel-v1" · totalSpins=1000
Sectors: 6 | Total Weight: 100 | Base Full Spins: 5 (1800°)
----------------------------------------------------------------------------------------------------
Sector ID      | Coupon     | Weight |   Hits | Actual % | Theory % |   Delta | Sector Angle / Stop Deg 
----------------------------------------------------------------------------------------------------
sec-10off      | WELCOME10  |     35 |    352 |   35.20% |   35.00% |  +0.20% | 0°–60° (1830°)          
sec-15off      | BUNDLE15   |     25 |    251 |   25.10% |   25.00% |  +0.10% | 60°–120° (1890°)        
sec-freeship   | FREESHIP   |     20 |    207 |   20.70% |   20.00% |  +0.70% | 120°–180° (1950°)       
sec-gift       | GIFTWA     |     12 |    115 |   11.50% |   12.00% |  -0.50% | 180°–240° (2010°)       
sec-vip25      | VIP25      |      5 |     46 |    4.60% |    5.00% |  -0.40% | 240°–300° (2070°)       
sec-bonus5     | CREDIT5    |      3 |     29 |    2.90% |    3.00% |  -0.10% | 300°–360° (2130°)       
====================================================================================================
```

---

## App 内置浏览器唤起外部浏览器原理 · In-App WebView Handoff

当用户从 Facebook、Instagram 或 TikTok 广告点击进入落地页时，页面运行在社交 App 的内置 WebView 容器中（User-Agent 包含 `FBAN`/`FBAV`、`Instagram` 或 `BytedanceWebview`）。在这些容器内直接跳转 `https://wa.me/...` 常会遇到白屏、无法唤起客户端或会话丢失。

`buildExternalBrowserHandoff(userAgent, targetUrl)` 根据操作系统采取两套策略：

1. **Android 端 (`action: "android_intent_wakeup"`)**：
   构造标准 Android Intent URI：
   `intent://wa.me/6581009001?text=...#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=<encoded_fallback>;end`
   直接触发系统级 Intent 解析，跳出内置 WebView 并拉起外部默认浏览器或 WhatsApp 原生客户端。
2. **iOS 端 (`action: "show_ios_safari_guide"`)**：
   由于 iOS WKWebView 封锁了非白名单 Scheme 自动跳出，函数返回 `show_ios_safari_guide` 状态与引导文案，驱动前端展示右上角 `•••` 指向浮层，提示用户点击「在默认浏览器 Safari 中打开」。

---

## 常见问题 · FAQ

**Q1：问答摘要是怎么拼进 WhatsApp 预填消息的？**
`evaluateQuizFunnel` 会将每一步的 `key` 和选中项 `value` 格式化为 `[Quiz: SkinType=Dry | Goal=AntiAging | Timeline=Immediate]`，追加在路由配置的 `greetingPrefix` 之后，并通过 `URLSearchParams.set('text', prefilledMessage)` 进行标准 UTF-8 百分号编码，确保任何语言与符号都不会截断。

**Q2：如果营销人员配置转盘时忘了填某个奖项的跳转链接，会发生什么？**
`validateWheelConfig` 会在转盘初始化阶段直接拦截并返回结构化错误列表（如 `Sector[0]: non-empty prize sector must bind a valid "ctaUrl"`），避免用户抽中奖品后点击按钮无反应。

**Q3：单文件沙盒 `index.html` 需要启动本地服务器吗？**
不需要。`index.html` 采用零外部请求设计，所有样式、SVG 转盘渲染与状态机逻辑全部内联，直接双击文件或在完全断网环境下即可流畅交互。

---

## 相关工具与在线平台 · Related & Ecosystem

- [shortlink-rotator-demo](https://github.com/ipcloak/shortlink-rotator-demo) —— 多目标分流短链与社交 Deeplink 路由引擎（支持权重/配额/轮询/粘性会话）
- [utm-builder](https://github.com/ipcloak/utm-builder) —— 离线可用的广告 UTM 归因链接生成器
- [landing-page-checklist](https://github.com/ipcloak/landing-page-checklist) —— 出海广告落地页上线前静态自检清单

> **在线可视化构建与出海工具导航**：如果你希望免代码通过拖拽组件直接搭建带 Quiz 问答漏斗、幸运转盘与像素追踪的高转化落地页，可访问 [builder.ipcloak.ai](https://builder.ipcloak.ai?utm_source=github&utm_medium=repo&utm_campaign=quiz-wheel-funnel-demos)；更多跨境投放与增长实用工具合集见 [culolo.online](https://culolo.online?utm_source=github&utm_medium=repo&utm_campaign=quiz-wheel-funnel-demos)。

---

## License

MIT © IpCloak
