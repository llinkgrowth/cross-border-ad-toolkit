# Contributing

Thanks for taking a look. This repo is a **zero-dependency, demo-first** toolkit: everything must run with plain Node.js 20+ and a static file server. No build step, no package installation.

## 本地开发

```bash
# 需要 Node.js 20+
node --test                    # 61 个单测，零网络
node cli.mjs --help            # 看 CLI
open index.html                # 离线沙盒（或任意静态服务器）
```

不需要 `npm install`。仓库没有 dependencies / devDependencies，请保持这样。

## 提交前检查

```bash
npm run check     # 语法检查 + 全部单测
```

PR 里请说明：

1. 改了什么、为什么改；
2. 有没有新增触发信号 / 策略字段（要同步 `src/retention-engine.mjs`、`cli.mjs`、`test/`、`docs` 与 README）；
3. 是否仍然零依赖、零外部请求。

## 代码约定

- **纯函数优先**：决策逻辑（触发条件、频次、视图模型、Manifest、安装策略）不允许读全局、读时间、读网络；时间与存储一律依赖注入，便于单测。
- **浏览器副作用集中**：只在 `createBackInterceptor` / `createRetentionStore` 里碰 `window` / `document` / `history` / `storage`。
- **不引入第三方包**：包括测试框架、lint、格式化工具。用 `node:test` 与 `node --check`。
- **不联网**：单测和 CLI 都不发网络请求；`index.html` 必须 0 外部请求（CI 里有 grep 检查）。
- **不收集用户数据**：不读 Cookie / 剪贴板 / 表单内容；频次状态只写 `sessionStorage` / `localStorage`。

## 产品红线（重要）

这个工具会被用在真实投放页上，请守住这些边界：

1. **必须留出口**：捕获返回键后，用户最终仍然可以离开；不允许把历史记录塞满导致用户退不出去。
2. **不伪造紧迫感**：倒计时、库存、名额必须是真实数据，不能前端写死。
3. **默认不打扰**：同一会话最多一次；已转化用户静默；停留不足 3 秒不触发。提 PR 想放宽这些默认值，请先开 issue 讨论。
4. **不写结果承诺**：文档与示例不做效果承诺，也不编造效果数据。
5. **不包含商业后台**：这里只有通用前端运行时与生成器，不包含任何线上产品的后台代码、数据库模型或内部 API。

## Issue

用 `.github/ISSUE_TEMPLATE/bug.yml`，附上 Node 版本、复现步骤、期望与实际结果。**不要粘贴**真实用户数据、Cookie、广告账户信息。

## License

MIT，见 [LICENSE](./LICENSE)。
