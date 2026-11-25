# 贡献指南 · Contributing

感谢你参与改进 `quiz-wheel-funnel-demos`。本仓库是一个**零第三方依赖**的广告落地页互动漏斗（Quiz / StepFlow 与 PrizeWheel）核心状态机与离线沙盒参考实现。

## 环境要求

- Node.js **20 或更高版本**（使用内置 `node:test` 运行单元测试）
- 无需运行 `npm install`，项目不包含任何运行时或开发时第三方依赖

## 本地开发与验证

```bash
# 1. 运行全部单元测试（26 个 node:test 用例）
npm test

# 2. 运行全量检查（单测 + 1000 次转盘模拟 + Quiz 问答路由校验）
npm run check

# 3. 本地双击或打开双 Tab 离线交互沙盒
open index.html
```

## 目录职责约定

| 路径 | 职责 | 修改要求 |
|---|---|---|
| `src/funnel-engine.mjs` | 纯函数核心：问答评分与标签路由 `evaluateQuizFunnel`、本地加权转盘 `spinPrizeWheel`、门禁校验 `validateWheelConfig`、内置浏览器跳出辅助 `buildExternalBrowserHandoff` | 保持零依赖纯函数，修改必须补充单测 |
| `cli.mjs` | 命令行工具（`simulate-wheel` / `route-quiz` / `check-webview`） | 保持 `--json` 与 `--help` 兼容 |
| `index.html` | 单文件离线双 Tab 演示沙盒（Quiz 分流 + SVG 转盘 + 实时 JSON 检查器） | 严禁引入任何外部 CDN、字体、图片或统计请求 |
| `test/funnel.test.mjs` | `node:test` 单元测试套件 | 确保所有新增逻辑有断言覆盖 |

## 提交 PR 前自检

1. `npm run check` 全绿，0 失败用例。
2. 未引入任何 `dependencies` 或 `devDependencies`。
3. `index.html` 在断网环境下可正常点击完成 3 步问答与转盘旋转。
4. 不包含真实生产号码、密钥或客户隐私数据。
