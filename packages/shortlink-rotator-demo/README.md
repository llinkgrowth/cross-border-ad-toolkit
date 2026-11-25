# shortlink-rotator-demo —— Multi-Target Shortlink Rotator & Social Deeplink Engine

> 零外部依赖的多目标短链分流引擎：内置 4 种路由算法、粘性 Cookie 会话保持、5 大社交平台 Deeplink 拼接器、广告归因参数无损透传，附带 Cloudflare Worker 边缘 302 实现、CLI 压测器与单文件可视化模拟器。
> Zero-dependency multi-target shortlink rotator and social deeplink builder with `random`, `weighted` (FNV-1a hash), `round_robin`, and `quota` distribution modes, sticky visitor sessions, attribution pass-through, Cloudflare Worker edge 302 demo, CLI simulator, and offline HTML visualizer.

## 这是什么 · What it is

在跨区域客服接待（WhatsApp / Telegram / LINE 多坐席轮值）与多落地页 A/B 分流场景中，单一跳转短链往往面临**坐席负载不均、重复点击跳号、每日接待配额超载、广告归因参数丢失**四大工程痛点。

`shortlink-rotator-demo` 将多目标分流短链的核心路由决策层拆解为一套**纯函数、零外部依赖、可确定性复现**的参考实现：

- ✅ **适合**：自建边缘分流短链、研究多目标权重/配额分流算法、验证客服坐席粘性会话、批量生成标准社交 Deeplink、在上线前对分流比例做本地模拟验证的工程师与增长团队。
- ❌ **不是什么**：本仓库仅聚焦路由分流核心算法、边缘 302 最小闭环与本地模拟器，不包含多租户管理后台或托管基础设施。

---

## 快速开始 · Quick start

无需 `npm install`（零第三方依赖，仅使用 Node.js 20+ 标准库）：

```bash
# 1. 跑全量单元测试（27 个 node:test 用例）
npm test

# 2. 模拟 1000 次 WhatsApp 多坐席权重分流（查看实际占比 vs 理论权重占比）
node cli.mjs simulate wa-vip --clicks 1000

# 3. 模拟 1000 次每日配额分流（查看配额耗尽自动回退首个兜底目标统计）
node cli.mjs simulate promo-quota --clicks 1000

# 4. 单次路由决策演示（带访客 ID + 广告归因参数透传）
node cli.mjs route wa-vip --visitor v123 --query "utm_source=tiktok&ttclid=E.C.P.123"

# 5. 生成社交平台标准 Deeplink
node cli.mjs deeplink --type whatsapp --phone 8613800000000 --text "Hello, I want VIP info"

# 6. 打开离线可视化分流模拟器（支持拖动权重滑块实时绘制 500 次点击条形图）
open index.html
```

---

## 核心功能矩阵 · Features

| 模块 | 实现文件 | 工程细节说明 |
|---|---|---|
| **4 种分流模式** | `src/router.mjs` | 支持 `random`（纯随机）、`weighted`（权重比例 + 32-bit FNV-1a 确定性哈希桶）、`round_robin`（严格轮询计数）、`quota`（按 `daily_limit` 挑今日余量充足且点击最少的目标，全满自动回退首个兜底目标） |
| **粘性会话保持 (Sticky Cookie)** | `src/router.mjs` | 解析与签发 `lf_d_<slug>=<targetId>`（`Max-Age=31536000` 一年有效期），保证同一访客重复点击始终落到同一接待号；当原目标下线（`enabled: false`）时自动触发故障转移重算 |
| **5 大社交平台 Deeplink 拼接器** | `src/router.mjs` | `buildSocialDeeplink` 支持 `whatsapp` / `telegram` / `line` / `viber` / `zalo`，自动清洗国际区号与号码、渲染 `{{variable}}` 欢迎语模板并完成 RFC 3986 编码 |
| **广告归因参数无损透传** | `src/router.mjs` | `preserveAttributionParams` 自动提取入口 URL 上的 `utm_*`、`fbclid`、`ttclid`、`gclid`、`wbraid`、`msclkid` 等归因键，无损拼接至最终目标 URL，且自动过滤无关调试噪声参数 |
| **Cloudflare Worker 边缘 302 Demo** | `src/worker.mjs` | 约 85 行极简边缘路由脚本，毫秒级返回 `302 Found` 与 `Set-Cookie`，并通过 `ctx.waitUntil()` 异步执行点击遥测与配额递增，绝不阻塞主跳转链路 |
| **CLI 命令行模拟器** | `cli.mjs` | 支持 `route` 单次追踪、`simulate` 千次点击压测对比表、`deeplink` 拼接，全部命令支持 `--json` 结构化输出 |
| **离线可视化 HTML 模拟器** | `index.html` | 单文件内联 CSS/JS，零外部请求；可实时拖动 3 个坐席权重滑块、修改每日配额、点击「模拟 500 次点击」即时绘制分配条形图与 Deeplink 预览 |

---

## 系统架构 · Architecture

```text
Incoming Click: https://go.example.com/wa-vip?utm_source=tiktok&ttclid=E.C.P.123
  Headers: Cookie: lf_d_wa-vip=agent-alice | CF-Connecting-IP: 203.0.113.42
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Edge Router Core (src/router.mjs · Pure Functions · 0 Dependencies)     │
│                                                                         │
│  1. Active Pool Filter  ──► Filter out enabled=false / online=false     │
│  2. Sticky Cookie Check ──► Parse lf_d_<slug>; if target active -> HIT  │
│                             If target offline -> Sticky Failover Recalc │
│  3. Distribution Engine ──► [random] | [weighted FNV-1a]                │
│                             [round_robin] | [quota + fallback_first]    │
│  4. Attribution Merger  ──► Preserve utm_*, fbclid, ttclid, gclid       │
└─────────────────────────────────────────────────────────────────────────┘
        │
        ├──────────────────────────────┐
        ▼ (Synchronous <1ms)           ▼ (Asynchronous via ctx.waitUntil)
┌──────────────────────────────┐ ┌────────────────────────────────────────┐
│ HTTP 302 Found               │ │ Non-Blocking Telemetry & State Update  │
│ Location: https://wa.me/...  │ │ - Increment round_robin / quota usage  │
│ Set-Cookie: lf_d_wa-vip=...  │ │ - Optional webhook / KV persistence    │
└──────────────────────────────┘ └────────────────────────────────────────┘
```

---

## 4 种路由算法伪代码与复杂度对比 · Routing Algorithms

### 算法复杂度与适用场景对比表

| 分流模式 (`mode`) | 时间复杂度 | 空间/状态依赖 | 核心机制 | 典型适用场景 |
|---|---|---|---|---|
| `random` | $O(1)$ | 无状态 (`Stateless`) | `floor(rng() * N)` 均匀抽样 | 双版本落地页 A/B 测试、无差别均匀分流 |
| `weighted` | $O(N)$ | 无状态 (`Stateless`) | `FNV1a(slug:visitorId) % sum(W)` 线性扫描累积权重区间 | 按资深/初级坐席接待能力按比例（如 50:30:20）分流 |
| `round_robin` | $O(1)$ | 单计数器 (`counter`) | `counter % N` 严格循环递增 | 客服排班轮值、要求绝对均分的线索派单 |
| `quota` | $O(N \log N)$ | 目标当日计数 (`Map`) | 过滤 `used < daily_limit` 后按 `used` 升序挑最闲目标；全满回退 `active[0]` | 多地区促销页名额限制、新号每日接待安全上限保护 |

### 核心路由决策伪代码

```text
function resolveRoute(route, context):
  active = route.targets.filter(t => t.enabled !== false && t.online !== false)
  if active is empty: return Error("No active targets")

  # 1. 粘性会话优先（若原坐席仍在线则直接复用，下线则触发重算）
  if route.sticky:
    pinnedId = parseCookie(context.cookieHeader, "lf_d_" + route.slug)
    if pinnedId in active:
      return buildRedirect(active[pinnedId], reason="sticky_cookie_hit")

  # 2. 按模式执行分流策略
  switch route.mode:
    case "random":
      chosen = active[floor(rng() * active.length)]
    case "weighted":
      bucket = fnv1aHash(route.slug + ":" + context.visitorId) % sum(active.weights)
      chosen = findCumulativeBucket(active, bucket)
    case "round_robin":
      chosen = active[context.counter % active.length]
    case "quota":
      available = active.filter(t => usage[t.id] < t.daily_limit)
      if available is not empty:
        chosen = sortByLowestUsage(available)[0]
      else:
        chosen = active[0]  # 全部配额耗尽，回退至首个兜底目标

  # 3. 透传归因参数并签发 1 年期 Sticky Cookie
  finalUrl = preserveAttributionParams(chosen.url, context.incomingUrl)
  setCookie = "lf_d_" + route.slug + "=" + chosen.id + "; Max-Age=31536000; Path=/; SameSite=Lax"
  return { target: chosen, destinationUrl: finalUrl, setCookie }
```

---

## 粘性 Cookie 状态机 · Sticky Session State Machine

同一买家在活动期间多次点击短链时，如果每次都跳往不同客服号，会导致沟通上下文割裂与重复接待。`src/router.mjs` 通过 `lf_d_<slug>` Cookie 维护如下状态转换：

```text
                   ┌────────────────────────────┐
                   │   Incoming Click Request   │
                   └─────────────┬──────────────┘
                                 │
                    Has Cookie `lf_d_<slug>`?
                       ┌─────────┴─────────┐
                   No  │                   │ Yes
                       ▼                   ▼
        ┌──────────────────────┐   ┌───────────────────────────────┐
        │ Run Routing Mode     │   │ Lookup Target in Active Pool  │
        │ (weighted/quota/...) │   └───────┬───────────────┬───────┘
        └──────────┬───────────┘           │               │
                   │            Target Online?          Target Offline / Removed?
                   │                 (Yes)                 (No)
                   │                   │                   │
                   │                   ▼                   ▼
                   │        ┌────────────────────┐ ┌───────────────────────────┐
                   │        │ Sticky Session HIT │ │ Sticky Failover Recalc    │
                   │        │ Keep Same Agent ID │ │ Re-run Mode on Alive Pool │
                   │        └──────────┬─────────┘ └─────────────┬─────────────┘
                   │                   │                         │
                   └───────────────────┼─────────────────────────┘
                                       ▼
                   ┌────────────────────────────────────────┐
                   │ 302 Redirect + Refresh Set-Cookie      │
                   │ lf_d_<slug>=<targetId>; Max-Age=1 Year │
                   └────────────────────────────────────────┘
```

---

## CLI 1000 次压测输出示例 · Simulation Output

### 1. 权重分流模式（`weighted` · 50:30:20 比例验证）

运行 `node cli.mjs simulate wa-vip --clicks 1000`：

```text
==========================================================================================
Shortlink Simulation Report · slug="wa-vip" · mode="WEIGHTED"
Route Name : Southeast Asia WhatsApp Customer Service Desk (Weighted + Sticky)
Total Clicks: 1000 | Active Targets: 3 | Sticky Enabled: true
------------------------------------------------------------------------------------------
Target ID          | Weight | Daily Cap |   Hits | Actual % | Theory % |   Delta | Quota / Fallback Status
------------------------------------------------------------------------------------------
agent-alice        |     50 |       500 |    492 |   49.20% |   50.00% |  -0.80% | AVAILABLE             
agent-bryan        |     30 |       300 |    301 |   30.10% |   30.00% |  +0.10% | EXHAUSTED             
agent-chloe        |     20 |       200 |    207 |   20.70% |   20.00% |  +0.70% | EXHAUSTED             
------------------------------------------------------------------------------------------
Quota Fallback Summary: 0 / 1000 clicks triggered quota-exhausted fallback (Total Pool Daily Cap: 1000)
==========================================================================================
```

### 2. 每日配额耗尽回退模式（`quota` · 总配额 700，后 300 次自动回退主号）

运行 `node cli.mjs simulate promo-quota --clicks 1000`：

```text
==========================================================================================
Shortlink Simulation Report · slug="promo-quota" · mode="QUOTA"
Route Name : Regional Promo Landing Page Pool (Daily Quota Cap + Auto Fallback)
Total Clicks: 1000 | Active Targets: 3 | Sticky Enabled: false
------------------------------------------------------------------------------------------
Target ID          | Weight | Daily Cap |   Hits | Actual % | Theory % |   Delta | Quota / Fallback Status
------------------------------------------------------------------------------------------
lp-tier1-main      |     40 |       300 |    600 |   60.00% |   60.00% |  +0.00% | CAPPED + FALLBACK (+300 fb)
lp-tier2-flash     |     35 |       250 |    250 |   25.00% |   25.00% |  +0.00% | EXHAUSTED             
lp-tier3-vip       |     25 |       150 |    150 |   15.00% |   15.00% |  +0.00% | EXHAUSTED             
------------------------------------------------------------------------------------------
Quota Fallback Summary: 300 / 1000 clicks triggered quota-exhausted fallback (Total Pool Daily Cap: 700)
==========================================================================================
```

---

## Cloudflare Worker 边缘部署说明 · Edge Deployment

`src/worker.mjs` 遵循标准 Cloudflare Workers ES Module 语法，零外部依赖即可直接部署到全球边缘节点：

1. 将 `src/router.mjs` 与 `src/worker.mjs` 放入你的 Worker 项目目录。
2. 创建最小 `wrangler.toml`：

```toml
name = "shortlink-rotator-edge"
main = "src/worker.mjs"
compatibility_date = "2026-01-01"

# 可选：绑定 KV 命名空间动态读取路由配置
# [[kv_namespaces]]
# binding = "SHORTLINK_ROUTES"
# id = "<YOUR_KV_NAMESPACE_ID>"
```

3. 本地调试或一键发布：

```bash
npx wrangler dev
npx wrangler deploy
```

4. 核心特性：Worker 在返回 `302 Found` 时使用 `ctx.waitUntil(recordTelemetryAsync(...))` 异步更新计数与发送 Webhook，确保跳转响应耗时保持在 `<1ms` 级别。

---

## 常见问题 · FAQ

**Q1：为什么 `weighted` 模式默认支持基于 `visitorId` 的 FNV-1a 哈希，而不是每次都调 `Math.random()`？**
在边缘无状态节点或客户端禁用 Cookie 的 WebView 环境中，利用 `FNV-1a(slug + ":" + visitorId) % totalWeight` 可以实现**无状态会话亲和性（Stateless Affinity）**——即使请求没有携带 Cookie，只要传入相同的访客标识，依然能 100% 确定性地落入同一个权重桶；当未传入 `visitorId` 时则自动退化为标准随机数抽样。

**Q2：如果粘性 Cookie 绑定的客服坐席下班了（`enabled: false`），访客点击会报错吗？**
不会。`resolveRoute` 会先用 `getActiveTargets()` 过滤出当前在线的目标池。当发现 Cookie 中的 `targetId` 不在活跃池内时，会将 `stickyRecalculated` 标记为 `true`，立即在剩余在线坐席中重新计算新目标，并通过响应头 `Set-Cookie` 刷新客户端绑定。

**Q3：入口短链带的 `fbclid`、`ttclid`、`gclid` 和 `utm_*` 会覆盖目标链接已有的查询参数吗？**
默认**不覆盖**目标 URL 上显式写死的同名参数（保护预设渠道标识），只追加缺失的归因参数；若希望强制以入口参数为准，可在调用 `preserveAttributionParams(targetUrl, incomingUrl, { overrideExisting: true })` 时开启覆盖开关。

**Q4：如何在网页版模拟器里验证不同分流算法？**
直接用浏览器打开仓库根目录下的 `index.html`（支持完全断网环境），选择模式并拖动 3 个接待号的权重滑块或修改每日配额，点击「模拟 500 次点击」即可实时查看各目标命中数、理论占比与配额兜底回退统计。

---

## 相关工具与托管服务 · Related & Managed Service

- [utm-builder](https://github.com/ipcloak/utm-builder) —— 离线可用的 UTM 广告参数构建与规范校验器
- [landing-page-checklist](https://github.com/ipcloak/landing-page-checklist) —— 出海投放落地页上线前静态合规与性能自检清单
- [awesome-cross-border-marketing](https://github.com/ipcloak/awesome-cross-border-marketing) —— 跨境出海增长与投放工程工具导航

> **托管版说明**：本仓库提供轻量开源的单链分流算法与 Worker 示例。如果你在实际业务中需要 **150 目标/链、自定义域名自动 SSL、团队分权与可视化报表的托管服务**，见 [link.ipcloak.ai](https://link.ipcloak.ai?utm_source=github&utm_medium=repo&utm_campaign=shortlink-rotator-demo)。

---

## License

MIT © IpCloak
