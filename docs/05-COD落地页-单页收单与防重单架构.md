---
title: "COD 货到付款单页架构：6 个转化区块、阶梯定价算式与防重单伪代码"
description: "拆解东南亚、中东与拉美 COD 单页落地页的 6 个标准区块、多件阶梯计价实时计算、极简地址表单校验与前端 60 秒幂等防重单机制。"
keyword: "COD落地页"
slug: "cod-landing-page-architecture"
date: 2026-11-25
lang: zh-CN
canonical: "https://guide.ipcloak.ai/cod-landing-page-architecture/"
tags: ["COD落地页", "货到付款", "单页电商", "出海投放"]
---

# COD 货到付款单页架构：6 个转化区块、阶梯定价算式与防重单伪代码

> 一句话结论：东南亚、中东和拉美的 **COD落地页**（货到付款单页）不适合跳进复杂的多页商城。**把「痛点展示 → 阶梯规格选择 → 4 字段收货表单 → 60 秒防重单校验」收拢在同一个单页里**，每少一次页面跳转，就少流失一批冷流量。

很多习惯做欧美标品独立站的团队，第一次跑东南亚或中东 COD 时，直接拿标准商城的多步结账（Product → Cart → Customer Info → Shipping → Payment）去接广告流量，结果加购不少、完单极低。

原因很直接：COD 用户没有在线绑卡习惯，且大量流量来自移动端弱网环境。每多跳一个页面，就要多等 2 秒加载、多填 4 个非必填框。COD 单页落地页（Single-Page COD Funnel）的目标就是**在一个页面内完成说服与收单，把非必要字段全部砍掉**。

下面按工程实现拆开：6 个核心区块、阶梯套餐计算、4 字段收货表单校验，以及最关键的**前端 + 接口幂等防重单伪代码**。

---

## 一、COD 单页的 6 个标准区块（从上到下）

```text
┌────────────────────────────────────────────────────────────┐
│ 1. 首屏结果锚点 (Hero & Core Promise)                      │
│    痛点场景图 + 一句明确主标题 + COD 标识（货到付款/免预付）│
├────────────────────────────────────────────────────────────┤
│ 2. 前后对比与机制拆解 (Before/After & Mechanism)           │
│    为什么老办法不管用 → 产品工作的 3 个可视步骤            │
├────────────────────────────────────────────────────────────┤
│ 3. 规格与阶梯套餐区 (Tiered Bundle Selector)  ★提升客单核心│
│    1 件尝鲜 / 2 件推荐（省 X%）/ 3 件家庭装（单件最低）    │
├────────────────────────────────────────────────────────────┤
│ 4. 极简收货表单 (4-Field COD Checkout Form)   ★转化核心    │
│    姓名 + 手机号（带当地格式校验）+ 城市/区县 + 详细地址    │
├────────────────────────────────────────────────────────────┤
│ 5. 履约与售后信任条 (Fulfillment & Trust Guarantee)        │
│    发货时效说明 + 签收验货流程 + 常见尺码/用法问答          │
├────────────────────────────────────────────────────────────┤
│ 6. 移动端底部悬浮栏 (Sticky Bottom Bar)                    │
│    左侧当前选中套餐总价，右侧「立即定位到表单提交」按钮      │
└────────────────────────────────────────────────────────────┘
```

为什么第 3 块（阶梯套餐）和第 4 块（收货表单）必须挨在一起？

因为 COD 的物流履约成本是刚性的——发 1 件和发 2 件的头程与派送费相差不大。不在表单上方放「2 件主推档（默认选中）」，单均毛利很难算过广告费。

---

## 二、阶梯定价与套餐状态机（纯函数实现）

很多外包落地页把套餐金额写死在 DOM 字符串里，一换多语言或改货币符号就全乱。标准做法是把套餐定义成结构化配置，由纯函数实时计算总价、单件均价和差额减免：

```js
// 阶梯套餐配置示例（以沙特 SAR 或通用货币为单位）
export const BUNDLE_TIERS = [
  { id: 'tier_1', qty: 1, label: '1 件标准装', unitPrice: 149, shippingFee: 19, badge: '' },
  { id: 'tier_2', qty: 2, label: '2 件组合装', unitPrice: 119, shippingFee: 0,  badge: '最受欢迎 · 免运费', default: true },
  { id: 'tier_3', qty: 3, label: '3 件家庭装', unitPrice: 99,  shippingFee: 0,  badge: '单件更省 · 免运费' }
];

/**
 * 计算当前选中套餐的账单明细
 * @param {string} tierId
 * @param {Array} tiers
 */
export function calculateCodOrderSummary(tierId, tiers = BUNDLE_TIERS) {
  const baseUnit = tiers[0].unitPrice;
  const selected = tiers.find(t => t.id === tierId) || tiers.find(t => t.default) || tiers[0];

  const merchandiseSubtotal = selected.qty * selected.unitPrice;
  const originalMerchandise = selected.qty * baseUnit;
  const bundleSaving = Math.max(0, originalMerchandise - merchandiseSubtotal);
  const grandTotal = merchandiseSubtotal + selected.shippingFee;

  return {
    tierId: selected.id,
    qty: selected.qty,
    unitPrice: selected.unitPrice,
    shippingFee: selected.shippingFee,
    bundleSaving,
    grandTotal
  };
}
```

---

## 三、COD 表单的 4 个字段与本地化校验规则

COD 订单最大的损耗不在页面，而在**审单与派送失败（号码空号、少填位数、地址只有城市没有街道）**。但字段一旦超过 5 个，移动端放弃率又会飙升。

平衡点是**只留 4 个必填项，但在前端做轻量、明确的格式兜底**：

| 字段 | 校验规则 | 错误提示写法（说清怎么改） |
|---|---|---|
| 收货人姓名 (`name`) | 去首尾空格后长度 `>= 2`，不含纯数字 | 「请填写收货人真实姓名，方便派送员联系」 |
| 手机号码 (`phone`) | 剥离空格与短横线后，按目标市场校验长度与前缀（如沙特 `05xxxxxxxx` 或 `5xxxxxxxx`；东南亚 8–11 位数字） | 「请输入完整的 9–10 位当地手机号（仅数字）」 |
| 省/市/区 (`region`) | 下拉选择或非空文本，避免手输拼错一级行政区 | 「请选择所在城市或行政区」 |
| 详细地址 (`address`) | 去空格后长度 `>= 8`，必须包含街道/门牌/地标特征 | 「请补充街道、楼栋号或附近明显地标，避免派送失败」 |

手机号归一化函数示例：

```js
export function normalizeLocalPhone(rawPhone, countryCode = 'GENERIC') {
  // 1. 将阿拉伯-印地数字 (٠-٩) 自动转成标准 ASCII 数字 (0-9)
  const ascii = String(rawPhone || '').replace(/[\u0660-\u0669]/g, (d) =>
    String(d.charCodeAt(0) - 0x0660)
  );
  // 2. 去掉空格、括号、短横线
  const digits = ascii.replace(/[\s()-]/g, '');

  if (countryCode === 'SA') {
    const valid = /^(\+?9665\d{8}|05\d{8}|5\d{8})$/.test(digits);
    return { valid, normalized: digits, hint: valid ? '' : '沙特手机号需以 05 或 5 开头（共 9-10 位）' };
  }
  const valid = /^\+?\d{8,14}$/.test(digits);
  return { valid, normalized: digits, hint: valid ? '' : '请输入 8-14 位有效联系电话' };
}
```

> 细节：**阿拉伯语用户输入手机号时，输入法可能默认打出 `٠٥٠١٢٣٤٥٦٧`（东阿拉伯数字）**。如果正则只写 `/^\d+$/`，这批真实客户会全部因为「格式错误」无法提交订单！上面的第一步转换能直接救回这部分转化。

---

## 四、防重单与防连点：60 秒幂等锁（伪代码）

COD 没有支付网关拦截，用户在弱网下觉得没反应，连点 4 下提交按钮，后台就会进 4 条一模一样的订单，同时触发 4 次 `Purchase` 像素事件，把广告回传数据彻底污染。

必须在前端和接口层同时做**基于「手机号 + 套餐 ID」的 60 秒幂等指纹锁**：

```text
function submitCodOrder(formState, selectedTier):
    # 1. 归一化手机号并计算本次提交指纹
    phoneInfo = normalizeLocalPhone(formState.phone)
    if not phoneInfo.valid:
        return showFieldError("phone", phoneInfo.hint)

    fingerprint = sha256_or_fnv1a(
        pageSlug + ":" + phoneInfo.normalized + ":" + selectedTier.id
    )

    # 2. 检查本机 60 秒内是否已成功提交过相同指纹
    lastRecord = localStorage.get("cod_last_submit:" + fingerprint)
    if lastRecord and (nowMs() - lastRecord.timestampMs < 60000):
        # 直接展示上一次成功的订单确认弹窗，但不再发网络请求、不再触发 Purchase 像素！
        return showOrderSuccessModal(lastRecord.orderId, deduplicated = true)

    # 3. 锁定按钮状态，发起订单提交请求（携带 Idempotency-Key 头）
    setSubmitButtonLoading(true)
    resp = httpPost("/api/cod-orders", body = {
        idempotency_key: fingerprint,
        tier_id: selectedTier.id,
        customer: formState,
        attribution: readPersistedClickIds()
    })
    setSubmitButtonLoading(false)

    if resp.ok:
        # 4. 记录本机幂等锁，并用订单号作为确定性 event_id 触发一次像素
        localStorage.set("cod_last_submit:" + fingerprint, {
            orderId: resp.orderId,
            timestampMs: nowMs()
        })
        firePixelOnce(action = "purchase", eventId = "ord_" + resp.orderId, value = selectedTier.grandTotal)
        showOrderSuccessModal(resp.orderId, deduplicated = false)
```

---

## 五、COD 落地页上线前自检

- [ ] **东阿拉伯数字兼容**：在手机号框粘贴 `٠٥٠١٢٣٤٥٦٧`，确认能自动转为 `0501234567` 并通过校验。
- [ ] **默认选中主推档**：打开页面无需点击，默认已选中「2 件装」且底部悬浮栏显示对应总价。
- [ ] **弱网连点不重单**：把浏览器网络调成 Slow 3G，连续快速点击提交按钮 3 次，确认只生成 1 条订单、只触发 1 次 `Purchase` 事件。
- [ ] **UTM 与点击 ID 入库**：提交的订单数据里完整带上 `utm_source`、`utm_campaign` 与 `fbclid`/`ttclid`，方便审单后反推哪条广告素材回款最好。

---

<sub>本文由爱普出海团队整理。配套的 COD 单页静态微模板骨架、阿拉伯语 RTL 词条包与构建校验器已开源在 `landing-page-starter-demos` 仓库。</sub>
