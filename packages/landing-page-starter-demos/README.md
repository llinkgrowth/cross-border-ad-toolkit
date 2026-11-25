# High-Conversion Landing Page Starter Demos · 出海投放落地页骨架与多语言构建器

> Three zero-dependency, self-contained HTML5 landing page starter skeletons (**COD Single-Page**, **WhatsApp Lead Page**, and **PWA App Landing Page**) paired with an offline multi-language (`i18n` + `RTL`) static builder and validator.
> 三套面向出海广告投放的轻量纯静态落地页教学骨架（**COD 货到付款单页**、**WhatsApp 私域引流页**、**PWA 桌面应用安装页**），配套零依赖的多语言（含阿拉伯语 RTL 镜像）静态渲染与防撑破校验 CLI。

- **零外部依赖**：Node.js 20+ 原生 ESM，无任何第三方 npm 包；模板内联 CSS/JS，**0 外部网络请求**。
- **多语言与 RTL 自动化**：`src/i18n-builder.mjs` 支持将 `{{t.section.key}}` 渲染为目标语言（内置 `en`、`ar`、`es`、`pt` 四套词条），遇到 `ar`/`he` 自动注入 `<html lang="ar" dir="rtl">` 与逻辑属性镜像。
- **防撑破与参数保留**：`check-i18n` 自动检测缺词、按钮文案超长（比英语基准长 >40% 预警）、货币与数字格式；内置语言切换器通过 `withLocaleParam()` 保证切换语言时 **100% 保留 `utm_*` / `fbclid` / `ttclid` 等投放参数**。
- **MIT License**：骨架代码可自由修改、用于团队内部培训或上线前原型自测。

---

## 目录 · Contents

1. [三套落地页骨架总览](#1-三套落地页骨架总览)
2. [高转化落地页「首屏黄金 5 区块」公式](#2-高转化落地页首屏黄金-5-区块公式)
3. [多语言 RTL 注入与防撑破算法（伪代码）](#3-多语言-rtl-注入与防撑破算法伪代码)
4. [快速开始与 CLI 用法](#4-快速开始与-cli-用法)
5. [目录结构](#5-目录结构)
6. [常见问题 · FAQ](#6-常见问题--faq)
7. [边界说明与配套生产工具](#7-边界说明与配套生产工具)

---

## 1. 三套落地页骨架总览

```text
templates/
├── cod-single-page/index.html      # 1) 东南亚/中东/拉美 COD 货到付款单页骨架
├── whatsapp-lead-page/index.html   # 2) WhatsApp 私域咨询引流页骨架（带 UTM 透传与 wa.me 拼接）
└── pwa-app-landing/                # 3) PWA 应用桌面安装页骨架（manifest.json + sw.js + 安装拦截）
```

| 模板 ID | 适用场景 | 核心内置组件 | 关键技术细节 |
|---|---|---|---|
| `cod-single-page` | 东南亚 / 中东 / 拉美单品货到付款 | 首屏核心利益点、3 档套餐规格选择、倒计时/库存条、COD 收货地址表单、本地订单预览弹窗 | 纯前端表单校验、规格切换实时算总价、无后端依赖预览 |
| `whatsapp-lead-page` | 高客单服务 / B2B 询盘 / 社群加粉 | 痛点与方案对比卡、真实流程说明、可折叠 FAQ、底部悬浮 CTA 栏 | 自动读取当前页 URL 的 `utm_*` / `fbclid` 并拼入 `https://wa.me/<phone>?text=...` 预填首句 |
| `pwa-app-landing` | 工具 / 短剧 / 高复访站点桌面留存 | 应用信息头、截图画廊、`beforeinstallprompt` 安装按钮、离线缓存状态面板 | 含标准 `manifest.json` 与 `sw.js` Service Worker 骨架，支持未触发原生提示时的手动添加到主屏引导 |

---

## 2. 高转化落地页「首屏黄金 5 区块」公式

冷流量从广告点进来，前 3 秒决定留存，前 30 秒决定行动。三套骨架全部遵循同一套「5 区块推进结构」：

```text
┌─────────────────────────────────────────────────────────────┐
│ 区块 1 · 首屏价值主张 (Above the Fold)                      │
│   一句主标题（给谁 + 解决什么）+ 3 条可核验要点 + 首屏主按钮│
├─────────────────────────────────────────────────────────────┤
│ 区块 2 · 痛点与方案对比 (Before vs. After)                  │
│   传统做法的 3 个摩擦点 vs. 当前方案的 3 步确定性路径       │
├─────────────────────────────────────────────────────────────┤
│ 区块 3 · 机制拆解与社会证明 (How It Works & Proof)          │
│   真实界面/实拍结构图 + 交付边界说明（做什么、不做什么）    │
├─────────────────────────────────────────────────────────────┤
│ 区块 4 · 互动转化区 (Offer / Form / WhatsApp / Install)     │
│   COD 极简收货表单 / 预填上下文的 WhatsApp 按钮 / PWA 安装  │
├─────────────────────────────────────────────────────────────┤
│ 区块 5 · 疑虑消除与合规页脚 (FAQ & Compliance Footer)       │
│   4 条高频问询折叠卡 + 隐私条款/免责声明 + 移动端悬浮底栏   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 多语言 RTL 注入与防撑破算法（伪代码）

做多语言落地页最怕三件事：① 切到阿语版面没镜像；② 切到西语/德语按钮文字长出 50% 把布局撑破；③ 切完语言把 URL 上的 `utm_source` 弄丢了。`src/i18n-builder.mjs` 用下面三个纯函数解决：

### 3.1 静态渲染与 RTL 自动注入 (`renderPage`)

```text
function renderPage(templateHtml, localeData):
    direction = "rtl" if localeData.meta.code in {"ar", "he", "fa", "ur"} else "ltr"

    # 1. 注入 <html lang="..." dir="...">
    html = setHtmlAttributes(templateHtml, lang = localeData.meta.code, dir = direction)

    # 2. 注入保留全部查询参数的语言切换器
    html = replace(html, "<!-- I18N:SWITCHER -->", buildLanguageSwitcher(localeData.meta.code))

    # 3. 替换 {{t.section.key}} 文本（自动 HTML 转义）与 {{n.key}} 本地化数字
    for each match {{kind.path}} in html:
        if kind == "t":
            val = escapeHtml(getPath(localeData, path))
        else if kind == "n":
            val = formatLocaleNumber(getPath(localeData.numbers, path), localeData.meta)
        replace match with val

    return html
```

### 3.2 按钮防撑破与词条完整性检查 (`checkI18n`)

```text
function checkI18n(baseLocaleEn, targetLocale):
    errors = []
    warnings = []

    for each key in flattenKeys(baseLocaleEn):
        if key not in targetLocale:
            errors.push(KEY_MISSING(key))
            continue

        # 针对按钮类词条（*.cta / *.button / *.submit），检查译文长度比例
        if isButtonKey(key) and length(baseLocaleEn[key]) >= 4:
            ratio = length(targetLocale[key]) / length(baseLocaleEn[key])
            if ratio > 1.40:
                warnings.push(BUTTON_TOO_LONG(key, ratio))

    return { ok: errors.length == 0, errors, warnings }
```

### 3.3 语言切换保留全部 UTM 与点击 ID (`withLocaleParam`)

```js
export function withLocaleParam(currentSearch, nextLocale) {
  const params = new URLSearchParams(currentSearch.replace(/^\?/, ''));
  params.set('lang', nextLocale);
  // 原有的 utm_source / utm_campaign / fbclid / ttclid 全部原样保留
  return '?' + params.toString();
}
```

---

## 4. 快速开始与 CLI 用法

```bash
# 1. 查看内置的 3 套模板与 4 套语言包
node cli.mjs list

# 2. 运行多语言词条对齐、按钮防撑破与数字/货币格式检查
node cli.mjs check-i18n

# 3. 将 COD 模板渲染为阿拉伯语（自动注入 dir="rtl" 与本地数字格式）
node cli.mjs render --template cod-single-page --locale ar --out /tmp/cod-ar.html

# 4. 将 WhatsApp 私域模板渲染为英语或西班牙语
node cli.mjs render --template whatsapp-lead-page --locale es --out /tmp/wa-es.html

# 5. 运行全量单元测试（48 个用例，零网络依赖）
npm test
```

---

## 5. 目录结构

| 路径 | 说明 |
|---|---|
| `templates/cod-single-page/index.html` | COD 货到付款单页模板骨架（内联样式与交互脚本） |
| `templates/whatsapp-lead-page/index.html` | WhatsApp 私域咨询引流页骨架（带 UTM 参数捕获与 `wa.me` 拼接预览） |
| `templates/pwa-app-landing/` | PWA 应用安装页骨架（含 `index.html`、`manifest.json`、`sw.js`） |
| `locales/{en,ar,es,pt}.json` | 英 / 阿（RTL）/ 西 / 葡 四语词条与货币数字配置 |
| `src/i18n-builder.mjs` | 零依赖多语言构建器、RTL 注入器、按钮长度预警与查询参数保留核心 |
| `cli.mjs` | `list` / `check-i18n` / `render` 命令行工具 |
| `test/starter.test.mjs` | 48 个 `node:test` 单测（覆盖模板离线约束、RTL、缺词、超长按钮、CLI 渲染） |

---

## 6. 常见问题 · FAQ

**这三套模板可以直接打开预览吗？**
可以。直接用浏览器打开 `templates/*/index.html`，或者用 `node cli.mjs render --template cod-single-page --locale en --out /tmp/preview.html` 生成注入完词条的完整单文件 HTML，双击就能离线运行，不发任何外部网络请求。

**阿拉伯语（`ar`）版本是怎么处理排版的？**
渲染器检测到 `ar` 时会自动在根节点写入 `lang="ar" dir="rtl"`，模板 CSS 全部使用 `margin-inline`、`padding-inline`、`text-align: start` 等 CSS 逻辑属性，无需写两套样式即可完成左右镜像。

**为什么 `check-i18n` 会对超过 40% 长度的按钮报警？**
西班牙语、葡萄牙语、德语的动词短语通常比英语长 30%–50%。移动端首屏按钮或底部悬浮栏一旦换行或溢出，会直接破坏首屏点击体验，因此在构建阶段提前报警。

---

## 7. 边界说明与配套生产工具

本仓库提供的是 **3 套基础教学与原型验证骨架（Starter Demos）**，不包含在线可视化拖拽编辑器、云端订单数据库或成品行业站后台。

- 如果需要**不用写代码的可视化拖拽建站、69 种语言一键翻译、像素事件绑定、COD 订单与 PWA 统一后台**，请使用 [爱普落地页 (builder.ipcloak.ai)](https://builder.ipcloak.ai)。
- 如果需要**直接挑选现成行业落地页（291 套在架，每套有可点的演示站）**，请访问 [落地页超市 (culolo.online)](https://culolo.online)。

## License

MIT License · Copyright (c) 2026 IpCloak
