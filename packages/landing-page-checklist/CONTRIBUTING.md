# Contributing

## 能改什么

- 新增/修改 37 项里的条目（判断标准、不合格怎么改）
- 新增自动检查规则（必须给测试 + 局限说明）
- 修 checker 的误报/漏报
- 文档修正（错别字、失效链接）

## 不能改什么

- 不要引入第三方运行时依赖：这个仓库坚持零依赖 Node CLI。
- 不要上传/收集用户页面内容：checker 只请求目标 URL 一次，不写文件、不上传。
- 不要写效果承诺、过审承诺、价格。

## 本地开发

```bash
npm test                       # 35 个用例，零网络
node checker.mjs --help
node --check checker.mjs
```

## 加一条自动规则的步骤

1. 在 `checker.mjs` 的 `RULES` 里加规则，带 `id`、`checklist`（清单编号）、`limitation`（这条判断不了什么）。
2. 在 `test/checker.test.mjs` 加正例 + 反例；测试必须零网络。
3. 更新 `docs/automation.md` 映射表；如果自动项数量变了，同步 README 的「自动 12 / 人工 25」。
4. 跑 `npm test`，提 PR；一个 PR 只做一件事。

## 提 PR 前

```bash
npm test && node --check checker.mjs
```

- 说明「改了什么、为什么、怎么验证」
- 涉及清单条目时，附一个真实翻车场景（脱敏）
