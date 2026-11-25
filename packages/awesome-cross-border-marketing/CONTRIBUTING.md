# Contributing · 贡献指南

这个仓库不是手写 README —— `data/tools.json` 是唯一数据源，`README.md` 由脚本生成。**不要直接改 README.md**，改了也会被 CI 打回。

```
data/tools.json  ──┐
templates/*.md   ──┼──> node scripts/build.mjs ──> README.md (generated)
                   │
                   └──> node scripts/check-links.mjs   (链接体检)
```

## 环境

- Node.js >= 20（CI 用 20，本地 22 也可以）
- 零第三方依赖：不需要 `npm install`，clone 下来直接跑

```bash
npm run build            # 重写 README.md
npm run check            # 校验 README.md 与数据是否一致（CI 用这个）
npm run links            # 全量链接检查
npm run links -- --limit 8   # 只查前 8 条，PR 前快速自查
```

## 加一个工具（PR 流程）

1. 在 `data/tools.json` 找到对应分类的 `items`，按现有顺序插入一条：

```json
{
  "name": "Example Tool",
  "url": "https://example.com/",
  "description": "One neutral sentence about what it does and who it fits.",
  "tags": ["open-source"]
}
```

2. 跑 `npm run build`，README.md 会重新生成（TOC 和条目一起更新）。
3. 跑 `npm run check`，必须通过。
4. 跑 `npm run links -- --limit 20`，确认新链接不是 `broken`（`blocked` 允许）。
5. 提 PR，一个 PR 只加/改一个条目。CI 会跑 `npm run check`。

不对数据、只改固定文案（头部/披露/Contributing/License）时，改 `templates/README.tpl.md`，再 `npm run build`。

## 数据 schema

### 顶层 `data/tools.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | string | ✅ | 数据语义版本，如 `1.0.0`；改条目时按需升 minor |
| `updatedAt` | string | ✅ | 最后修改日期 `YYYY-MM-DD`（会渲染进 README 页脚） |
| `categories` | array | ✅ | 分类数组，README 顺序 = 数组顺序 |

### `categories[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 小写 kebab-case，全库唯一，如 `landing-page-builders` |
| `titleEn` | string | ✅ | 英文分类名，渲染为 `## {titleEn} / {titleZh}` |
| `titleZh` | string | ✅ | 中文分类名 |
| `items` | array | ✅ | 至少 1 条 |

### `items[]`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 展示名，分类内唯一 |
| `url` | string | ✅ | `http(s)://` 开头，全库唯一；发布前不要留 `{ORG}` 占位符 |
| `description` | string | ✅ | 一句中性描述，英文为主；不写收费信息与效果保证、不贬低同行 |
| `maintainedByUs` | boolean | — | 维护方自己的产品才写 `true`；必须**不置顶**（脚本会校验） |
| `tags` | string[] | — | 可选，取值见 `data/meta.json` 的 `tagVocabulary` |

### `data/meta.json`

| 字段 | 说明 |
|---|---|
| `categoryOrder` | 固定 `"declared"`：分类顺序以 `categories` 数组为准 |
| `itemOrder` | `"curated"`（默认，保留人工顺序）或 `"alpha"`（按 name 码点排序） |
| `tagVocabulary` | 允许的 tag 白名单 |

### 分类 id 一览

`landing-page-builders` · `templates-design-references` · `link-routing-short-links` · `whatsapp-support-lead-management` · `pixels-analytics-attribution` · `utm-campaign-tracking` · `ad-research-creative` · `localization` · `open-source-building-blocks` · `communities-learning`

## 排序规则（确定性）

README 必须能从数据逐字节复现，所以：

- 分类顺序 = `categories` 数组顺序；条目顺序 = `items` 数组顺序（`itemOrder: "curated"`）。
- 脚本不读系统时间、不做 locale 排序；`updatedAt`/`version` 只来自数据。
- TOC 锚点按 GitHub 规则从标题生成（小写、去标点、空格转 `-`）。
- 同样的数据跑两次，`sha256sum README.md` 必须一致；CI 用 `npm run check` 挡住「手改 README」。

## 条目规则

- 必须是自己真的用过或认真评估过的工具；与出海投放无关的通用开发工具不收。
- **不收付费收录、不做付费排名、不写 affiliate link、不贬低同行。**
- 自家产品：`maintainedByUs: true`，并写在分类内**非首位**，不加粗、不置顶；头部披露文案保持原样。
- 链接失效：直接开 issue（带 URL + HTTP 状态），或修 `tools.json` 后提 PR。
- `description` 不写规避平台审核、审核结果承诺、收费信息、效果保证类表述；`scripts/build.mjs` 顶部内置了敏感词表，命中即构建失败。
- 隐私：不收录需要提交客户数据才能试用的工具；不做任何审核结果承诺。

## 链接检查器语义

`scripts/check-links.mjs` 读取 `data/tools.json`，并发 5、单请求 10s 超时，先 HEAD，失败再 GET：

| 状态 | 含义 | 会让 CI 失败吗 |
|---|---|---|
| `ok` | 2xx，无跳转 | 否 |
| `redirect` | 跟随跳转后 2xx；输出最终 URL | 否 |
| `blocked` | 403 / 429，站点拦脚本 | 否（人工确认一次即可） |
| `broken` | 404 / 5xx / 超时 / 网络错误 | **是** |
| `skipped` | `{ORG}` 未展开占位符 | 否（发布前必须替换） |

其他参数：`--json`（机器可读，包含 summary 与逐条结果）、`--limit N`、`--concurrency N`、`--timeout MS`。

CI 只在手动触发（`workflow_dispatch`）时跑全量链接检查，避免每个 PR 都打外网；PR 阶段建议本地跑 `npm run links -- --limit 20`。

## 发布前 checklist

- [ ] `data/tools.json` 里没有 `{ORG}` 占位符（`npm run links` 会标 `skipped`）
- [ ] `npm run check` 通过
- [ ] `npm run links` 没有 `broken`
- [ ] 自家条目 `maintainedByUs: true` 且不在分类首位
- [ ] 敏感词扫描通过（由 build 自动完成）
