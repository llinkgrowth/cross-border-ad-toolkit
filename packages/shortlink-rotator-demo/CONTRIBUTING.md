# 贡献指南 · Contributing

感谢你关注并参与 `shortlink-rotator-demo`。本项目是一个**零第三方依赖**的多目标分流短链核心算法与边缘 302 路由参考实现。

## 环境要求

- Node.js **20 或更高版本**（使用内置 `node:test` 运行测试）
- 无需运行 `npm install`，仓库不包含任何运行时或开发时第三方依赖

## 本地开发与验证

```bash
# 1. 运行全部单元测试（25+ 用例）
npm test

# 2. 运行 CLI 1000 次权重分流模拟
npm run simulate

# 3. 运行配额耗尽回退模拟与全量校验
npm run check

# 4. 本地直接打开可视化分流模拟器
open index.html
```

## 目录职责约定

| 路径 | 职责 | 修改要求 |
|---|---|---|
| `src/router.mjs` | 纯函数路由核心（4 种分流模式、粘性 Cookie、5 种社交 Deeplink、归因参数透传） | 保持零依赖纯函数，修改必须补充对应单测 |
| `src/worker.mjs` | Cloudflare Workers 边缘 302 路由 Demo（含 `ctx.waitUntil` 异步打点） | 保持轻量（<120 行）与标准 Web Fetch API 兼容 |
| `data/demo-routes.json` | 示例多客服 WhatsApp 分流与多地区落地页配额分流配置 | 不要提交真实客户号码或生产密钥 |
| `cli.mjs` | 命令行单次决策、1000 次压测模拟器与 Deeplink 生成器 | 新增参数需同步更新 `--help` 与测试 |
| `index.html` | 单文件离线可视化分流模拟器 + Deeplink 生成面板 | 严禁引入外部 CDN、字体、统计脚本或外链请求 |
| `test/router.test.mjs` | `node:test` 单元测试套件 | 确保所有新增逻辑有断言覆盖 |

## 提交 PR 前自检

1. `npm run check` 全部通过，0 失败用例。
2. 未引入任何 `dependencies` 或 `devDependencies`。
3. `index.html` 在断网环境下可直接双击打开并正常交互。
4. 不包含真实业务号码、域名密钥或敏感数据。
