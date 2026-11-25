# UTM Parameters 参数说明（完整表）

UTM 参数是加在链接末尾的 5+1 个查询参数，用来在分析工具里区分「这条流量从哪来、点了什么」。它们只影响报表，不影响页面内容。

## 六个参数

| 参数 | 中文 | 填什么 | 示例 | 必填 |
|---|---|---|---|---|
| `utm_source` | 来源 | 平台 / 渠道名，小写 | `facebook`、`tiktok`、`newsletter` | 是 |
| `utm_medium` | 媒介 | 流量类型 | `cpc`、`social`、`email`、`organic` | 是 |
| `utm_campaign` | 活动 | 活动名，带版本或时间 | `spring_sale_2026q1` | 是 |
| `utm_term` | 关键词 | 搜索词 / 定向标签 | `running_shoes` | 否 |
| `utm_content` | 内容 | 同一活动下的素材区分 | `video_a`、`carousel_2` | 否 |
| `utm_id` | 标识 | 内部工单 / 批次号 | `20261124_a1` | 否 |

## 命名规则（团队统一版）

1. **全小写 + 下划线**：`Facebook` 和 `facebook` 会被拆成两个来源。
2. **不含空格、中文、特殊字符**：虽然浏览器会编码，但后台报表不好读。
3. **source 是平台，medium 是类型**：别两个填一样。
4. **campaign 带时间/版本**：`spring_2026q1` 比 `spring` 可追溯。
5. **同一活动固定一套词**，写进团队文档，新人照抄。

## 三个平台的示例

Facebook 广告：

```
https://example.com/landing?utm_source=facebook&utm_medium=cpc&utm_campaign=spring_2026q1&utm_content=video_a
```

TikTok 广告：

```
https://example.com/landing?utm_source=tiktok&utm_medium=cpc&utm_campaign=spring_2026q1&utm_content=carousel_2
```

邮件 / 私域：

```
https://example.com/landing?utm_source=newsletter&utm_medium=email&utm_campaign=weekly_2026w47
```

## 上线前校验清单

- [ ] 广告后台里填的最终 URL 与落地页实际 URL 一致（含 `?` 之后的部分）
- [ ] 链接没有重复的 `utm_*`（重复会被后写的覆盖）
- [ ] 落地页跳转 / 语言切换后参数没丢
- [ ] 分析工具里能在「来源 / 媒介 / 活动」三个维度看到这次投放
- [ ] 短链或跳转服务没有吞掉查询参数
- [ ] 同一个活动只用一个 campaign 名

## 常见错误

- 链接里已有 `utm_*`，又粘了一层，导致 source 重复。
- `utm_source` 大小写混用，报表拆成两行。
- 用中文或空格做 campaign，导出 CSV 时乱码。
- 只加 source 不加 medium，渠道报表里全归到「(not set)」。

## 相关

- 工具：[utm-builder](https://github.com/{ORG}/utm-builder)（离线生成器，不收集数据）
- 产品：爱普落地页的 UTM 规范（站内文章）
