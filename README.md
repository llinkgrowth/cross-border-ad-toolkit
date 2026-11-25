# Cross-border ad toolkit

一个仓库，十条公开工具线。不要拆成十个仓库——star、更新和搜索权重都堆在这一页上。

One repo. Ten public tools. Stars, commits, and search authority stay on this page instead of being split across thin repositories.

## 这个仓库是什么

给自己投 Facebook / TikTok / Google 的人用的离线小工具：UTM、落地页自检、短链分流、像素对照、多语言校验、PWA / 回流页、问答漏斗、进粉归因。

全部零第三方依赖，`node --test` 能跑。判定引擎、成品模板源码、桌面客户端不在这里。

## 工具

| 目录 | 干什么 | 怎么试 |
|---|---|---|
| [packages/utm-builder](packages/utm-builder/) | 离线 UTM 链接 | `node packages/utm-builder/cli.mjs --help` |
| [packages/landing-page-checklist](packages/landing-page-checklist/) | 37 项上线自检 + HTML 检查器 | `node packages/landing-page-checklist/checker.mjs --help` |
| [packages/awesome-cross-border-marketing](packages/awesome-cross-border-marketing/) | 出海工具清单（数据生成 README） | `node packages/awesome-cross-border-marketing/scripts/build.mjs --check` |
| [packages/cloak-integration-kit](packages/cloak-integration-kit/) | 访问规则对接：PHP 安装脚本、WP 插件、`ipcheck`、`utmcheck` | `node packages/cloak-integration-kit/cli.mjs --help` |
| [packages/shortlink-rotator-demo](packages/shortlink-rotator-demo/) | 4 种分流 + WhatsApp / Telegram 链接拼接 | `node packages/shortlink-rotator-demo/cli.mjs --help` |
| [packages/pixel-event-debugger](packages/pixel-event-debugger/) | Meta / TikTok / GA4 事件对照与去重 | `node packages/pixel-event-debugger/cli.mjs --help` |
| [packages/landing-page-starter-demos](packages/landing-page-starter-demos/) | COD / 私域 / PWA 三套骨架 + 多语言校验 | `node packages/landing-page-starter-demos/cli.mjs list` |
| [packages/pwa-return-retention-kit](packages/pwa-return-retention-kit/) | 回流页（弹窗 / 信息流）+ PWA manifest | `node packages/pwa-return-retention-kit/cli.mjs --help` |
| [packages/quiz-wheel-funnel-demos](packages/quiz-wheel-funnel-demos/) | 问答分流 + 本地转盘 + 内置浏览器跳出 | `node packages/quiz-wheel-funnel-demos/cli.mjs --help` |
| [packages/scrm-webhook-attribution-kit](packages/scrm-webhook-attribution-kit/) | 进粉短码归因 + Webhook 验签 + 防重发 | `node packages/scrm-webhook-attribution-kit/cli.mjs --help` |

长文在 [docs/](docs/)。Wiki 原稿在 [wiki-src/](wiki-src/)，发布时贴进**本仓库**的 Wiki，不要另开仓库。

## 一次跑完测试

```bash
npm test
```

Node 20+。不需要 `npm install`。

## 这个仓库讲什么、不讲什么

GitHub 可以讲斗篷（cloak）和分流。讲的是**知识、对接和公开工具**，不是把线上判定引擎贴出来。

| 可以写进这个仓库 | 不写 |
|---|---|
| 斗篷是什么：同一入口，不同访客看到不同页；超时必须放行，不能把站挂死 | 离线 IP 库解析、真实审核节点名单、指纹阈值、线上规则表 |
| 分流是什么：一条链分给多个接待；随机、权重、轮询、配额；同一人回到同一接待 | 计费、钱包、子账号、证书签发后台 |
| 怎么接：PHP 安装脚本、WordPress 钩子、Worker 网关、请求/响应字段 | 内部 API 域名、生产 token、客户数据 |
| `ipcheck`、`utmcheck`、WhatsApp 链接拼接、像素事件名、UTM | 承诺过审、承诺效果、价格 |

抖音和视频号仍然不讲斗篷。那是账号寿命问题，和 GitHub 不是同一层。

## 为什么只有一个仓库

搜索引擎按页面和站点算权重，不按「你建了几个空仓库」加分。十个薄仓库会把 star 和提交拆散，每一个都更难排上去。一个有目录、有测试、有更新的仓库，比十个 README 更像真项目，也更符合平台对垃圾仓库的限制。

## 维护方

[IpCloak](https://builder.ipcloak.ai) · [落地页超市](https://culolo.online) · [分流短链](https://link.ipcloak.ai)

本仓库工具免费、独立、不收集数据。完整后台不在这个仓库里。

## License

各子目录自带 LICENSE（MIT 或 CC0）。未单独声明的代码按 MIT。
