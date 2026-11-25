# 贡献指南 · Contributing

这是一个**零第三方依赖**的静态模板仓库：3 套落地页骨架 + 1 个多语言构建/校验器。改动请小而具体。

## 环境

- Node.js **20 或更高**（CI 固定 Node 20）
- 任意现代浏览器；测 PWA 安装与离线缓存时需要 http(s)（`file://` 下不注册 Service Worker）
- 不需要 `npm install`：没有运行时与开发时依赖

## 本地开发

```bash
npm test                       # node:test 单测
npm run check                  # 多语言 key 对齐 / 缺词 / 按钮超长 / 货币数字格式
npm run list                   # 列出模板与语言包
node cli.mjs render --template cod-single-page --locale ar --out /tmp/cod-ar.html
```

渲染出的 HTML 是**独立文件**，直接用浏览器打开即可预览。

## 目录约定

| 路径 | 职责 | 可以改吗 |
|---|---|---|
| `templates/cod-single-page/index.html` | COD 单页微模板 | 可以，必须保留 `<!-- I18N:SWITCHER -->` |
| `templates/whatsapp-lead-page/index.html` | WhatsApp 私域引流微模板 | 同上 |
| `templates/pwa-app-landing/index.html` | PWA 安装落地页微模板 | 同上 |
| `templates/pwa-app-landing/manifest.json` / `sw.js` / `icons/` | PWA 静态资产 | 可以 |
| `locales/*.json` | 语言包（en / ar / es / pt） | 加语言或词条，必须保持 key 对齐 |
| `src/i18n-builder.mjs` | 渲染、校验、数字格式化、RTL 注入 | 可以，必须补测试 |
| `cli.mjs` | 命令行入口 | 可以，必须补测试 |
| `test/starter.test.mjs` | 单测 | 可以 |

## 新增一套语言

1. 复制 `locales/en.json`，改 `_meta`（`locale`、`label`、`direction`、`currency`、`numberFormat`）。
2. 逐条翻译 `messages`，**key 一个都不能多、不能少**；`ar` / `he` / `fa` / `ur` 请把 `direction` 设为 `rtl`。
3. `npm run check`：应报 0 错误、0 预警。
4. 按钮文案尽量简洁：比英语长 40% 以上会触发预警（西语/葡语尤其注意）。

## 新增一套模板

1. 在 `templates/<name>/index.html` 建模板，所有可见文案用 `{{t.section.key}}`，数字用 `{{n.key}}`。
2. 在模板合适位置放**恰好一个** `<!-- I18N:SWITCHER -->`。
3. 样式使用逻辑属性（`margin-inline`、`inset-inline`、`padding-block`），让 RTL 自动镜像，不要另写一套 `[dir=rtl]` 覆盖。
4. 不允许外部请求：不引 CDN、字体、图片外链、统计脚本；需要图标就本地 SVG。
5. 补语言词条（4 套语言都要）、补测试，然后 `npm test && npm run check`。

## 提交前检查

```bash
npm test && npm run check
```

要求：

1. 测试全绿，新增行为有对应测试。
2. `npm run check` 0 错误；预警要么修掉，要么在 PR 里说明原因。
3. 不新增第三方依赖。
4. 页面保持单文件、零外部请求；文案保持中文界面（词条本体除外）、参数名保持英文。
5. 不提交密钥、真实客户数据、真实订单或投放账户信息。
6. 不提交第三方商业模板源码或任何可视化编辑器的私有实现——本仓库只接受自己写的教学骨架。

## 审核红线

- 不加入受限类目（成人、博彩、荐股等）相关文案或示例。
- 不写价格、折扣金额或收益承诺。
- 不把演示电话/WhatsApp 号码换成真实可联系号码。
