# 自动检查说明：37 项里，只有 12 项能自动检查

`checker.mjs` 不是「一键通过全部检查」的工具，它是一个**只读 HTML 的规则检查器**。

先给结论，避免误用：

- 自动检查覆盖 **12 项**（16 条规则），剩 **25 项**必须人工判断。
- 自动检查全部 PASS **不代表页面可以上线**：信任内容、合规结论、翻译质量、真机走查都不在自动范围内。
- 检查器不收集任何用户数据，不上传页面内容，只请求目标 URL 一次；不执行页面脚本，所以 JS 动态注入的内容看不到。
- 测试零网络：`node --test` 只跑纯函数与本地参数解析，CI 里也不联网。

---

## 1. 37 项映射表

「自动（部分）」= 这一项只有一部分判断标准能交给机器，人工仍要复核；「人工」= 机器没有可靠信号，只能人看。

| 编号 | 清单项 | 方式 | 自动规则 | 怎么验 / 人工看什么 |
| --- | --- | --- | --- | --- |
| 1.1 | 三秒说清「给谁 + 解决什么」 | 人工 | — | 找 3 个不了解项目的人看首屏 5 秒，复述给你听 |
| 1.2 | 主标题只有一个主张 | 自动（部分） | `h1` | 只数 h1 个数；是否只有一个主张要人读 |
| 1.3 | 主按钮在首屏可见 | 人工 | — | 桌面与手机首屏截图，不滚动找主按钮 |
| 1.4 | 首屏视觉与业务相关 | 人工 | — | 看首图是否像目标客户的真实场景 |
| 1.5 | 手机首屏不被遮挡 | 自动（部分） | `viewport` | 只查 viewport；真机竖屏看是否遮挡、是否横向滚动 |
| 1.6 | 慢网下首屏不白屏 | 人工 | — | 开发者工具限速 Slow 3G 刷新看首屏 |
| 2.1 | 每一屏都有信息增量 | 人工 | — | 逐屏删掉，看是否有人丢失关键信息 |
| 2.2 | 卖点写成可验证的事实 | 人工 | — | 每个数字与结论找来源 |
| 2.3 | 展示真实的信任要素 | 人工 | — | 核对客户名、案例、团队是否可公开 |
| 2.4 | 常见疑问在页面上有答案 | 人工 | — | 费用、交付范围、售后、时效四类问题各找一个答案 |
| 2.5 | 没有夸大与绝对化表述 | 人工 | — | 通读全文，挑绝对化用词 |
| 2.6 | 段落短、可扫读 | 人工 | — | 手机上扫一遍，小标题能否单独读懂 |
| 3.1 | 表单字段只留必要项 | 自动（部分） | `form-fields` | 只数字段个数；每个字段「为什么必须现在填」要人判断 |
| 3.2 | 字段有输入提示与校验 | 自动（部分） | `form-labels` | 只查 label / aria-label；错误文案是否说清「怎么改」要人测 |
| 3.3 | 提交后有明确反馈 | 人工 | — | 真提交一次，看加载态与下一步说明 |
| 3.4 | 主 CTA 在页面中重复出现 | 人工 | — | 滚动数一遍同义按钮 |
| 3.5 | 联系方式真实可达 | 人工 | — | 发一条测试消息，确认有人收到 |
| 4.1 | 首屏最大内容 2.5 秒内出现 | 自动（部分） | `page-size` | 体积只是弱信号；真实 LCP 要测 |
| 4.2 | 图片已压缩且指定尺寸 | 自动（部分） | `image-dimensions` | 只查 width/height 或 srcset；格式与单张体积要人查 |
| 4.3 | 控制台无报错 | 人工 | — | DevTools Console / Network 看红色报错与 404 |
| 4.4 | 页面链接全部可用 | 自动（部分） | `https` | 只测入口 URL 的协议；页内链接与外链没有逐个请求 |
| 4.5 | 基础 SEO 标签齐全 | 自动（部分） | `title` `meta-description` `canonical` `meta-robots` `image-alt` | 只查标签存在与长度；内容是否与页面一致要人看 |
| 4.6 | 有兜底页 | 人工 | — | 访问一个不存在的路径，看 404 页 |
| 5.1 | 像素只加载一次 | 自动（部分） | `script-duplicates` | 只比较 `<script src>` 重复；动态注入的看不到 |
| 5.2 | 事件命名统一 | 人工 | — | 对照团队事件表逐条核 |
| 5.3 | 关键动作都有埋点 | 人工 | — | 从「用户完成目标」倒推，缺哪步补哪步 |
| 5.4 | 用调试工具验证过 | 人工 | — | 平台调试工具看事件是否真实上报 |
| 5.5 | 参数与投放链接对齐 | 人工 | — | 抽查 3 条投放链接的 utm 参数 |
| 6.1 | 语言与投放地区匹配 | 自动（部分） | `html-lang` | 只查 lang 属性；默认语言是否匹配地区要人看 |
| 6.2 | 翻译是人工校对过的 | 人工 | — | 目标语言母语者通读标题、按钮、错误提示 |
| 6.3 | 数字、日期、货币格式符合当地习惯 | 人工 | — | 切到目标语言看日期、货币、电话格式 |
| 6.4 | 长语言不撑破布局 | 人工 | — | 切德语 / 俄语看按钮与标题是否挤出容器 |
| 7.1 | 隐私说明与免责声明齐全 | 自动（部分） | `privacy-links` | 只找入口；内容是否齐全、是否符合地区要求要人审 |
| 7.2 | 没有任何结果承诺 | 人工 | — | 人工通读，承诺类表述只能人判断 |
| 7.3 | 不出现受限类目内容 | 人工 | — | 合规人审素材与截图，机器不能替代 |
| 7.4 | 上线前完整走一遍 | 自动（部分） | `http-status` | 只测入口能否打开；全流程真机走查要人做 |
| 7.5 | 有回滚与备份 | 人工 | — | 发布前打 tag，演练一次 10 分钟内回滚 |

**数一下**：自动（部分）12 项 = 1.2 / 1.5 / 3.1 / 3.2 / 4.1 / 4.2 / 4.4 / 4.5 / 5.1 / 6.1 / 7.1 / 7.4；其余 25 项全部人工。

---

## 2. 16 条自动规则与判断边界

| 规则 id | 清单编号 | 判断什么 | 判断不了什么（常见误报 / 漏报） |
| --- | --- | --- | --- |
| `https` | 4.4 | 入口 URL 是否 https | 页内链接与外链不逐个请求；证书有效期、混合内容看不到 |
| `http-status` | 7.4 | 入口是否返回 200 | 「广告链接 → 提交成功」全流程仍要真机走 |
| `title` | 4.5 | title 是否存在、10–60 字 | 标题内容是否说清给谁、是否只有一个主张；英文按字符数算会偏严 |
| `meta-description` | 4.5 | 是否存在、50–160 字 | 是否与页面内容一致；搜索引擎会自行改写摘要 |
| `canonical` | 4.5 | 是否声明且非空 | 指向页面能否打开、与当前 URL 是否一致（www / 大小写会误报） |
| `meta-robots` | 4.5 | 是否误写 noindex | X-Robots-Tag 响应头、robots.txt、JS 注入的 noindex 看不到 |
| `viewport` | 1.5 | 是否声明且含 width=device-width | 首屏是否被遮挡、是否横向滚动，要真机看 |
| `html-lang` | 6.1 | html lang 是否声明 | 语言与投放地区是否匹配、翻译质量 |
| `h1` | 1.2 | h1 数量是否为 1 | 标题是否只有一个主张；模板里隐藏的 h1 会误判 |
| `image-alt` | 4.5 | 缺 alt 的图片比例（alt="" 视为装饰图，不报） | 装饰性图标、CSS 背景图、内联 SVG 会误报；alt 是否贴切 |
| `image-dimensions` | 4.2 | 是否有 width+height 或 srcset | 实际格式（WebP/AVIF）与单张体积 |
| `form-labels` | 3.2 | 控件是否有 label / aria-label | 只有 placeholder 的输入框会误报；错误提示是否说清「怎么改」 |
| `form-fields` | 3.1 | 可见字段数量（≤5 通过） | 每个字段是否真的必要；多步骤表单只统计当前这一步 |
| `page-size` | 4.1 | HTML 响应体积是否 >1MB | 只算 HTML，不含图片与字体；不等于 LCP 一定超时 |
| `script-duplicates` | 5.1 | 同 `<script src>` 是否重复 | 内联初始化、动态注入的像素看不到 |
| `privacy-links` | 7.1 | 是否有隐私/条款类链接入口 | 图片按钮、非常见命名会漏判；内容是否齐全合规 |

严重级别约定：

- **FAIL** = 直接影响可访问或收录（http、非 200、无 title、无 description、无 viewport、noindex）。有 FAIL 时 CLI 退出码为 1。
- **WARN** = 可优化或需要人工确认（其余全部规则）。默认不拦发布。
- 本地地址（localhost / 127.0.0.1）的 http 不判 FAIL，只给 WARN，方便本地跑 fixture。

---

## 3. 规则引擎伪代码

```text
RULES = [ {id, checklist, title, limitation}, ... ]   // 规则表，16 条

# 纯函数：只吃字符串和元信息，不联网、不读文件、不用时间/随机数
function analyze(html, meta):
    clean = stripNoise(html)                  # 去掉 <!-- -->、<script>、<style>
    ctx = {
      title:      readTitle(clean),
      metas:      readMeta(clean),            # description / viewport / robots
      lang:       readHtmlLang(clean),
      h1Count:    countH1(clean),
      images:     readImages(clean),
      controls:   readFormControls(clean),
      labels:     readLabels(clean),
      scripts:    readScriptSources(html)     # 用原始 HTML，脚本标签本身不能被 strip 掉
    }

    raw = {}
    for rule in RULES:
        raw[rule.id] = evaluate(rule, ctx, meta)   # -> {status: PASS|WARN|FAIL, detail}

    checks  = RULES.map(rule => { ...rule, ...raw[rule.id] })
    summary = {
      total, pass, warn, fail,
      overall: fail > 0 ? "fail" : warn > 0 ? "warn" : "pass",
      autoChecklistItems: 12,
      manualChecklistItems: 25
    }
    return { url: meta.url, status: meta.status, checks, summary }

# 命令行：一次网络请求 + 渲染
function main(argv):
    options = parseArgs(argv)                  # <url> / --json / --timeout / --no-fail
    if options.help: 打印用法; return 0
    response = fetch(options.url, {
        headers: { "user-agent": UA, "accept": "text/html..." },
        redirect: "follow",
        timeout: options.timeout
    })
    html   = response.body
    meta   = { url, status: response.status, finalUrl: response.url, bytes: html.length }
    result = analyze(html, meta)
    打印表格 或 JSON
    return (result.summary.fail > 0 && !options.noFail) ? 1 : 0
```

`analyze` 的边界由函数签名保证：只接受 `(html, meta)` 两个参数，没有网络与文件句柄，所以可以用内联 HTML 单测（`test/checker.test.mjs`，35 个用例）。

---

## 4. 怎么加一条规则

1. 在 `checker.mjs` 的 `RULES` 里追加一条，写清 `id`、映射的清单编号、标题和**局限**：

   ```js
   {
     id: 'og-image',
     checklist: '4.5',
     title: 'og:image 已声明',
     limitation: '只检查 meta 标签是否存在；图片能不能打开、尺寸是否合适判断不了。'
   }
   ```

2. 在 `analyze` 里算出 `raw['og-image'] = { status: 'PASS' | 'WARN' | 'FAIL', detail: '...' }`。
   新增解析逻辑请写成 `stripNoise` 之后的纯函数，放在文件上半部分。

3. 在 `test/checker.test.mjs` 加两个用例：一个「满足时 PASS」，一个「触发时 WARN/FAIL」。测试只能用内联 HTML，**不能联网、不能读文件**。

4. 更新本文件的第 1、2 节表格，以及 README 里的「自动 12 项 / 人工 25 项」数字（如果覆盖项变了）。
   清单编号总数必须仍满足：自动清单项 + 人工清单项 = 37。

5. 跑 `npm test`，再跑一次 `node checker.mjs --help` 确认用法没变。

红线：新规则不得引入第三方依赖、不得请求目标页面以外的地址、不得读取 Cookie / localStorage / 用户数据、不得把页面内容上传到任何地方。

---

## 5. 为什么有些项不能自动检查

| 类型 | 涉及清单项 | 原因 |
| --- | --- | --- |
| 视觉与审美 | 1.1、1.3、1.4、1.6、6.4 | 首屏是否说清、按钮是否在首屏、图片是否相关、慢网是否白屏、长语言是否撑破布局，都是看出来的，HTML 里没有可靠信号 |
| 业务事实与信任 | 2.1、2.2、2.3、2.6、3.5 | 数字来源、客户真实性、联系渠道是否有人看，需要业务方举证，机器判断不了真假 |
| 交互与真机 | 3.3、3.4、4.3、4.6、5.2、5.3、5.4、5.5、7.4、7.5 | 涉及点击、提交、控制台、事件上报、投放链接参数、全流程走查、回滚演练，要真环境和真操作 |
| 翻译与本地化 | 6.2、6.3 | 机翻痕迹、同一名词两种译法、日期货币格式是否符合当地习惯，需要目标语言母语者判断 |
| 合规结论 | 7.2、7.3 | 有没有承诺、素材是否属于受限类目，必须由人做合规判断并签字，机器不能替代 |

另外两类「不能做」是刻意的产品约束，不是技术限制：

- **不执行页面 JS**：一旦执行脚本，就等于在别人的页面上跑代码，会带来安全与隐私问题；代价是动态注入的内容看不到。
- **不抓取站内链接、不扫全站**：只请求目标 URL 一次，避免变成爬虫、避免给目标站点制造流量；代价是页内死链检查仍要人工或专门的链接检查工具。

---

## 6. 已知误报与使用建议

最容易误报的是 **`image-alt`**：图标、装饰图、CSS 背景图、内联 SVG 都容易缺 `alt`。看到 WARN 先人工确认那张图是否承载信息——纯装饰图写 `alt=""` 就不会再报。

其余常见误报：

- `form-labels`：只用 placeholder 的输入框会被判缺标签，placeholder 不能替代 label。
- `title`：英文标题按字符数算，60 字符左右通常正常，别为了缩短而删掉关键信息。
- `canonical`：单页站点没有 canonical 不算错误，WARN 可以先放过。
- `privacy-links`：页脚用图片按钮、或叫「法律信息」之类非常见名字会漏判。
- `page-size`：只算 HTML 文本，加了大量内联脚本才会触发，图片体积不在其中。

使用建议：**把自动检查当「上线前 5 分钟的机器体检」，不当「合规审查」**。先修 FAIL，再逐条过 25 项人工项；两者都过，才算走完清单。

---

## 7. 隐私与数据

- 检查器只请求你指定的那一个 URL，携带固定的 User-Agent，不发送 Cookie、不发送页面来源信息。
- 不执行页面脚本，不写入本地存储，不产生缓存文件。
- 不把页面内容上传到任何服务器；`--json` 只输出到 stdout，重定向到文件由你自己控制。
- 测试不联网：`node --test` 只调用纯函数与本地参数解析。

MIT License，可自由复制与修改。
