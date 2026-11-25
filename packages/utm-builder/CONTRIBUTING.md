# 贡献指南 · Contributing

感谢你愿意改进这个工具。这是一个**零第三方依赖**的小项目，改动请尽量小而具体。

## 环境

- Node.js **20 或更高**（CI 固定跑 Node 20）
- 任意现代浏览器；需要跑浏览器行为对比时准备 Chrome（可选）
- 不需要 `npm install`：项目没有运行时与开发时依赖

## 本地开发

```bash
# 1. 校验产物与源码是否一致（提交前必跑）
npm run check

# 2. 跑单元测试（核心逻辑 + 构建管线）
npm test

# 3. 改完 src/ 后重建根目录 index.html
npm run build

# 4. 直接双击 index.html，或起静态服务器
python3 -m http.server 8080
```

`index.html` 是**生成产物**，不要手改。它顶部的注释写着来源文件与内容 hash，`npm run check` 会发现手工改动。

## 目录约定

| 路径 | 职责 | 可以改吗 |
|---|---|---|
| `src/core.mjs` | 纯函数核心：归一化 URL、解析查询串、生成链接、校验参数 | 可以，必须补测试 |
| `src/app.js` | DOM 层：表单、复制、最近记录、预设渠道 | 可以，不要写 URL 生成规则 |
| `src/styles.css` | 全部样式 | 可以 |
| `src/template.html` | HTML 壳，含两个内联标记 | 可以，不要删标记 |
| `scripts/build.mjs` | 内联构建与 `--check` | 谨慎 |
| `cli.mjs` | 命令行入口与参数解析 | 可以，必须补测试 |
| `test/*.test.mjs` | `node:test` 测试 | 可以 |
| `index.html` | 构建产物（GitHub Pages 入口） | 只由 `npm run build` 生成 |

## 提交前检查

```bash
npm test && npm run build && npm run check
```

要求：

1. 测试全绿，新增行为有对应测试。
2. 产物已重建并一并提交，`npm run check` 通过。
3. 不新增第三方依赖；不引入任何 CDN、字体、图片或统计脚本——产物必须保持单文件、离线可用、页面零外部请求。
4. 界面文案保持中文，UTM 参数名保持英文。
5. 页面在 375px 宽度下不被撑破；键盘可操作；`aria-live` / `aria-pressed` 语义不被破坏。
6. 不提交密钥、真实投放链接或客户数据。
7. PR 描述写清：改了什么、为什么改、如何验证。

## 新增一个 UTM 参数

1. `src/core.mjs` 的 `UTM_KEYS` 中加 key。
2. 在 `src/template.html` 的表单网格里加一个 `data-key` 输入框。
3. 在 `cli.mjs` 的 `FLAG_TO_FIELD` 中加一个命令行长参数。
4. 补 `test/core.test.mjs` 用例。
5. `npm test && npm run build && npm run check`。

`src/app.js` 的读取逻辑会自动收集所有带 `data-key` 的输入框，不需要改。

## 设计原则

- **纯函数优先**：核心逻辑不碰 DOM，才能在 Node 里测试、被 CLI 复用。
- **确定性构建**：不写时间戳、不压缩、不随机。同样的 `src/` 必须得到同样的 `index.html`。
- **错误处理显式**：核心返回 `{ ok, errors, warnings }`，调用方决定展示还是以非零退出码结束。
- **不静默丢数据**：未知参数、非法值都会报错，而不是悄悄忽略。
