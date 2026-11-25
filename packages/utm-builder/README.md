# UTM 链接生成器 · UTM Builder

一个离线可用的 UTM 链接生成器：**中文界面 + 英文参数名**，打开就能用，不联网、不登录、不收集数据。

面向自己投广告、自己改落地页的人。填一个落地页地址，勾渠道、填参数，实时生成一条可以贴进广告后台的链接。

- 产物仍是单文件：根目录 `index.html`，双击即可用
- 离线可用：CSS 与 JS 全部内联，页面不发任何外部请求
- 可直接丢 GitHub Pages
- 源码已工程化：纯函数核心 + DOM 层分离 + CLI 复用 + `node:test` 测试 + GitHub Actions
- 零第三方依赖（运行时与开发时都没有），构建只做文本内联
- MIT License

> 页面里的 `index.html` 是**构建产物**，请改 `src/` 后运行 `npm run build` 生成，不要手改。

---

## 功能

| 功能 | 说明 |
|---|---|
| 链接输入 | 支持 http / https；没写协议时自动补 `https://`；域名不完整会提示 |
| 六个参数 | `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` / `utm_id` |
| 预设渠道 | Facebook / TikTok / Google / WhatsApp / Email，一键填 source + medium |
| 实时生成 | 输入即生成，空格、中文、特殊字符都经 `encodeURIComponent` 编码 |
| 空值不写入 | 没填的参数不会出现在链接里，不会生成 `utm_source=` 这种空值 |
| 不重复污染 | 链接里原有的 `utm_*` 参数会先被清除，再写入你填的 |
| 一键复制 | `navigator.clipboard`，不支持时自动降级到 `execCommand` |
| 最近 5 条 | 复制成功后存本机 `localStorage`，可「填入」回表单或单独「复制」 |
| 重置 | 清空所有输入 |
| CLI | 同一套核心逻辑可在终端批量生成链接，支持 `--json` 结构化输出 |

## 架构

页面是「一个 HTML 文件」，但**源码不是一坨**。核心逻辑与 DOM 解耦，网页端和 CLI 共用同一份实现：

```
                        ┌──────────────────────────────┐
                        │        src/core.mjs          │
                        │  纯函数核心，无 DOM / Node API │
                        │                              │
                        │  normalizeBaseUrl(base)      │
                        │  parseQuery / collectParams  │
                        │  stripUtmParams(search)      │
                        │  validateFields(fields)      │
                        │  buildUtmUrl(base, fields)   │
                        └──────────┬───────────┬───────┘
                                   │           │
                     import（原生 ESM）│           │ 构建时剥掉 export，注入 window.UTMCore
                                   │           │
                     ┌─────────────▼──┐   ┌────▼──────────────────────┐
                     │    cli.mjs     │   │        src/app.js         │
                     │  参数解析       │   │  DOM 层：表单 / 复制 /     │
                     │  stdout / JSON │   │  最近记录 / 预设渠道        │
                     │  退出码 0/1/2  │   └────┬──────────────────────┘
                     └────────────────┘        │
                                               │
                              ┌────────────────┴────────────────┐
                              │ src/template.html + src/styles.css│
                              └────────────────┬────────────────┘
                                               │  scripts/build.mjs
                                               │  （文本内联 + 确定性 hash）
                                               ▼
                              ┌─────────────────────────────────┐
                              │  index.html（产物）              │
                              │  单文件 / 离线 / 零外部请求       │
                              │  GitHub Pages 直接托管            │
                              └─────────────────────────────────┘
```

目录结构：

| 路径 | 职责 |
|---|---|
| `src/core.mjs` | 纯函数核心：URL 归一化、查询串解析、UTM 生成、参数校验 |
| `src/app.js` | DOM 层：读表单、渲染结果、复制、最近记录、预设渠道 |
| `src/styles.css` | 全部样式 |
| `src/template.html` | HTML 壳，含 `<!-- INLINE:styles.css -->` 与 `<!-- INLINE:core+app -->` 两个标记 |
| `scripts/build.mjs` | 读 `src/` 内联生成根目录 `index.html`；`--check` 校验产物是否最新 |
| `src/verify-browser.mjs` | 可选的 headless Chrome 行为校验：浏览器结果 vs Node 核心结果 |
| `cli.mjs` | 命令行入口与参数解析 |
| `test/core.test.mjs` | 核心逻辑 + CLI 参数解析测试 |
| `test/build.test.mjs` | 构建确定性与内联安全测试 |
| `index.html` | 构建产物（GitHub Pages 入口） |

## 算法伪代码

### normalizeBaseUrl(raw)

```
function normalizeBaseUrl(raw):
    value ← trim(String(raw ?? ""))
    if value == "":
        return { ok: false, code: "EMPTY_BASE", error: "请填写落地页 URL。" }

    # 只有明确写了 http(s):// 才原样解析，其余一律补 https://
    candidate ← value                       if value matches /^https?:\/\//i
              ← "https://" + value          otherwise

    url ← URL(candidate)                    # 解析失败 → INVALID_URL
    if url.protocol not in { "http:", "https:" }:
        return INCOMPLETE/UNSUPPORTED_PROTOCOL 错误
    if url.hostname 不是 loopback / IPv4 / 含 "." 的域名:
        return { ok: false, code: "INCOMPLETE_HOST" }
    return { ok: true, url }
```

### buildUtmUrl(base, fields)

```
function buildUtmUrl(base, fields):
    normalized ← normalizeBaseUrl(base)
    if not normalized.ok:
        return { ok: false, url: "", error: normalized.error, warnings: [] }

    url ← normalized.url
    { kept, removed } ← stripUtmParams(url.search)
        # 遍历查询串：key 大小写不敏感地匹配 /^utm_/ 的移除，其余 pair 原文进 kept
    validation ← validateFields(fields)
        # 只认 6 个标准 key；值 trim；空值只记 warning 并跳过；未知 key / 非原始值报错
    if not validation.ok:
        return { ok: false, url: "", errors: validation.errors }

    search ← copy(kept)
    for { key, value } in validation.values:        # 保持传入顺序
        search.append(encodeURIComponent(key) + "=" + encodeURIComponent(value))

    result ← url.protocol + "//" + url.host + url.pathname
           + ( "?" + join(search, "&")  if search 非空 else "" )
           + url.hash

    return {
        ok: true,
        url: result,
        warnings: validation.warnings + (removed 非空时的 UTM_OVERRIDDEN),
        removedUtmCount: removed.length,
    }
```

关键性质：

- **纯函数**：不读全局、不写存储、不抛异常；非法输入以返回值的 `ok/code` 表达。
- **无损保留**：非 utm 参数保留原始 `pair` 字符串，不重新编码；hash 原样拼回。
- **编码统一**：key/value 都走 `encodeURIComponent`，空格是 `%20` 而不是 `+`。
- **幂等**：对同一个输出再执行一次，结果不变（已有 utm_* 会被先清掉）。

## 本地使用

```bash
git clone https://github.com/<your-name>/utm-builder.git
cd utm-builder
# 方式一：直接双击 index.html
# 方式二：起一个本地静态服务（可选）
python3 -m http.server 8080
# 打开 http://localhost:8080
```

因为没有任何外部依赖，`file://` 直接打开也能完整使用。

## CLI

网页版的功能在终端同样可用，复用同一份 `src/core.mjs`：

```bash
# 生成链接（stdout 只有 URL，方便管道）
node cli.mjs example.com/landing --source facebook --medium cpc --campaign spring
# https://example.com/landing?utm_source=facebook&utm_medium=cpc&utm_campaign=spring

# 保留原链接参数与 hash，并清除旧 utm_*
node cli.mjs "https://example.com/p?a=1&utm_source=old#top" --source tiktok
# https://example.com/p?a=1&utm_source=tiktok#top
# stderr: 提示：已覆盖原有 1 个 utm_* 参数

# 结构化输出
node cli.mjs example.com/landing --source google --medium cpc --json

# 帮助
node cli.mjs --help
```

参数选项：

| 选项 | 对应参数 |
|---|---|
| `--source` | `utm_source` |
| `--medium` | `utm_medium` |
| `--campaign` | `utm_campaign` |
| `--term` | `utm_term` |
| `--content` | `utm_content` |
| `--id` | `utm_id` |

也支持完整写法 `--utm_source facebook` 与等号写法 `--source=facebook`。输出顺序固定按 `utm_source → utm_medium → utm_campaign → utm_term → utm_content → utm_id`，与参数书写顺序无关。

退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 内部错误 |
| `2` | 输入不合法（URL 无法解析、参数缺失或未知、不支持的参数名） |

`--json` 模式下，失败也会输出 `{ "ok": false, "errors": [...] }`，便于脚本判断。

## 部署到 GitHub Pages

1. 新建仓库，把根目录（含 `index.html`）推到 `main` 分支。
2. 仓库 **Settings → Pages**，Source 选 `Deploy from a branch`，分支选 `main`、目录选 `/ (root)`。
3. 保存后等 1 分钟左右，访问 `https://<your-name>.github.io/<repo>/`。

仓库名取 `<your-name>.github.io` 时，页面会直接挂在根路径。页面本身不依赖任何外部资源，Pages 只是静态托管。

## 本地开发与构建

环境：Node.js **20+**（CI 固定 Node 20），无需 `npm install`。

```bash
npm test              # node --test：核心逻辑 + 构建管线
npm run build         # 由 src/ 生成根目录 index.html
npm run check         # 校验 index.html 是否与 src/ 一致，过期则 exit 1
node cli.mjs --help   # 命令行工具
```

构建做了什么：

1. 读 `src/template.html`，把 `<!-- INLINE:styles.css -->` 换成 `<style>…</style>`；
2. 把 `<!-- INLINE:core+app -->` 换成 `<script>`：`core.mjs` 剥离顶层 `export` 后注入 `window.UTMCore`，随后执行 `app.js`；
3. 顶部写入生成注释与**内容 SHA-256**。

为什么构建是确定性的：

- 不写时间戳、不写随机数、不压缩、不排序；
- 统一 `\r\n` 为 `\n`，macOS / Linux / Windows 产物一致；
- `npm run check` 直接做字节级比较，CI 里能发现「改了 src/ 忘了重建」。

提交前请跑：

```bash
npm test && npm run build && npm run check
```

`index.html` 顶部的 `AUTO-GENERATED FILE — DO NOT EDIT` 是认真的：手改会在下次构建时被覆盖，也会被 `--check` 拦下。

## 测试

```bash
npm test
```

- 使用 Node 内置 `node:test` + `node:assert/strict`，零测试框架依赖。
- `test/core.test.mjs` 覆盖：补协议、http 保留、localhost / IPv4 / IPv6 回环、无点域名拒绝、非法 URL、已有 `utm_*` 清除、大小写混写、非 utm 参数与 hash 保留、中文/空格编码、空值跳过、未知参数报错、CLI 参数解析与输出顺序。
- `test/build.test.mjs` 覆盖：两次构建字节一致、生成注释与 hash、标记全部替换、ESM export 已剥离、产物无外部资源引用。

可选：在有 Chrome 的机器上做一次真实浏览器校验（不依赖网络）：

```bash
node src/verify-browser.mjs
```

它用同一组输入分别调用 Node 核心与 headless Chrome 里的页面，逐条对比生成结果，防止 DOM 层与核心逻辑脱节。

CI（`.github/workflows/ci.yml`）在 Node 20 上依次执行：`npm test` → `npm run check` → `npm run build` → `npm run check`，确保测试通过、提交的产物最新、重建后仍然一致。

## 参数说明

| 参数 | 中文 | 填什么 | 示例 |
|---|---|---|---|
| `utm_source` | 来源 | 流量从哪来，平台或渠道名 | `facebook`、`tiktok`、`newsletter` |
| `utm_medium` | 媒介 | 流量类型 | `social`、`cpc`、`email`、`organic` |
| `utm_campaign` | 活动 | 这次投放的活动名，建议带时间或版本 | `spring_sale_2026q1` |
| `utm_term` | 关键词 | 搜索词或定向标签 | `running_shoes` |
| `utm_content` | 内容 | 同一活动下的素材区分 | `video_a`、`carousel_2` |
| `utm_id` | 标识 | 自定义编号，用来跟内部工单对齐 | `20261124_a1` |

几条经验：

- **统一小写 + 下划线**，别一边 `Facebook` 一边 `facebook`，否则后台会拆成两个来源。
- **同一活动固定一套命名**，写进团队文档，新人照着填。
- `utm_campaign` 不要写中文和空格，虽然会被编码，但后台报表里不好读。
- 两个参数别填同一个值，`source` 是平台、`medium` 是类型。

## 边界情况

| 输入 / 场景 | 行为 |
|---|---|
| `example.com/landing`（没写协议） | 自动补成 `https://example.com/landing` |
| `http://localhost:3000`（明确 http） | 保持 `http://`，不升级 |
| `localhost` / `127.0.0.1` / `[::1]` | 放行，方便本地调试 |
| `example`（没有点的域名） | 拒绝，提示「请填写完整域名，例如 example.com/landing。」 |
| `ftp://example.com` | 不含 http(s):// 前缀，会先补 `https://`；随后因主机不完整被拒绝（与重构前一致） |
| 原链接已有 `utm_*`（含 `UTM_Source` 这类大小写混写） | 全部清除后再写入新值，并在状态里提示覆盖了几个 |
| 原链接有非 utm 参数 | 原样保留，包括 `?flag` 这种没有等号的参数 |
| 原链接带 hash | 无条件保留，拼在查询串之后 |
| 中文、空格、`&`、`=` 等特殊字符 | key 与 value 都 `encodeURIComponent`，空格为 `%20` |
| 参数值是空串或纯空格 | 跳过，不生成 `utm_source=` |
| 只填 URL、一个参数都不填 | 仍输出清理过 utm_* 的 URL，并提示「还没有填写参数」 |
| 重复点击/重复生成 | 幂等，同一输入得到同一输出 |
| `localStorage` 不可用（隐私模式） | 静默降级，生成与复制不受影响 |
| `navigator.clipboard` 不可用（如 `file://`） | 自动降级到 `document.execCommand('copy')` |

## 常见问题 · FAQ

**UTM 参数有哪些？**
六个：`utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` / `utm_id`，前三个通常必填。

**为什么链接里会出现两层 `utm_source`？**
原链接已经带了旧参数。本工具会先清除原有 `utm_*` 再写入；手工拼链接时也要先检查一遍。

**中文和空格会被怎么处理？**
统一 `encodeURIComponent`，空格编码成 `%20` 而不是 `+`，粘进广告后台不会乱。

**需要登录或联网吗？**
不需要。纯前端、离线可用，不收集任何数据。

**仓库里有 `src/`，为什么页面还是单文件？**
源码拆开是为了可测试、可复用；`scripts/build.mjs` 在提交前把 CSS 与 JS 内联回根目录 `index.html`，所以 Pages 上仍然只有一个文件，页面也不会请求任何外部资源。

**改了页面为什么没生效？**
直接改 `index.html` 会被下一次构建覆盖。改 `src/`，然后 `npm run build`。

**能在 CI 里自动检查产物过期吗？**
可以，`npm run check` 在产物与 `src/` 不一致时以退出码 1 结束，仓库自带 workflow 已经这么做了。

## 和替代方案的区别 · How it compares

| 方案 | 优点 | 不适合谁 |
|---|---|---|
| 手拼 / 电子表格 | 零成本 | 参数多、活动多时容易错，交接就乱 |
| 在线 UTM 服务 | 团队管理、历史记录 | 要登录、可能收费、链接过第三方 |
| 本项目 | 离线、无追踪、单文件、核心可用 CLI 复用、有测试与 CI | 不做团队协作和权限 |

## 隐私

- 所有计算在浏览器本地完成，生成过程不发出任何网络请求。
- 最近 5 条记录只存在你自己浏览器的 `localStorage`，点「清空」即可删除，不会上传到任何地方。
- 页面没有埋点、没有第三方脚本、没有 Cookie。
- CLI 只在本机运行，不联网、不写日志文件。

## 免责声明

本工具仅用于给链接添加标准的 UTM 参数，便于你在自己的分析工具里区分流量来源。

- 不保证任何投放结果、流量表现或转化效果。
- 不构成对任何平台政策、审核结果或账号状态的说明或承诺。
- 各平台对链接参数的处理方式不同，请以其官方文档与实际后台为准。
- 使用本工具即表示你自行承担使用后果，并遵守所在平台的政策与当地法律。

Meta、TikTok、Google、WhatsApp 等名称均为其各自所有者的商标，本项目与其无隶属或代理关系。

## 维护说明

- **改动范围**：逻辑改 `src/core.mjs`，界面交互改 `src/app.js`，样式改 `src/styles.css`，HTML 结构改 `src/template.html`；改完必须 `npm run build` 并提交 `index.html`。
- **新增参数**：`src/core.mjs` 的 `UTM_KEYS` 加 key → `src/template.html` 加带 `data-key` 的输入框 → `cli.mjs` 的 `FLAG_TO_FIELD` 加长参数 → 补测试 → 构建。
- **浏览器兼容**：目标为近两年的 Chrome / Safari / Edge / Firefox 移动端与桌面端；`localStorage` 写入失败时静默降级，不影响生成与复制。
- **提交 PR**：请说明改了什么、为什么改，并确认页面在手机宽度下没有被撑破；详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- **不建议做**：加 CDN、加统计脚本、加账号体系——这些都和「不收集数据、零外部请求」的承诺冲突。

## License

MIT License：可自由使用、修改、分发与商用，保留版权声明即可。完整条文见 [LICENSE](LICENSE)。

---

由 [builder.ipcloak.ai](https://builder.ipcloak.ai) 提供。
