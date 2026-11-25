# WhatsApp / Telegram / LINE / Viber / Zalo 链接拼接规范与代码（Deeplink Cheatsheet）

在出海投放和分流短链里，投手经常需要把各平台的客服号码与预设首句（欢迎语）拼成一条点击即唤起聊天窗口的链接。手工拼最容易翻车在三个地方：① 号码里留了 `+` 号、空格或括号导致 `wa.me` 404；② 欢迎语里的换行和特殊字符没走 `encodeURIComponent`；③ 落地页入口的 `utm_source` 没塞进预设首句，客服不知道这个客户是从哪条广告来的。

完整可运行的拼接器与分流模拟器见 [`shortlink-rotator-demo`](https://github.com/{ORG}/shortlink-rotator-demo)。

## 1. 五大社交平台 Deeplink 格式对照表

| 平台 | 标准 Web 唤起格式 | 原生 Scheme（可选） | 账号/号码清洗规则 | 预填首句参数 |
|---|---|---|---|---|
| **WhatsApp** | `https://wa.me/<phone>?text=<encoded>` | `whatsapp://send?phone=<phone>&text=<encoded>` | **只保留纯数字**（含国际区号，去掉 `+`、`00`、空格、`-`） | `?text=`（UTF-8 URL 编码） |
| **Telegram** | `https://t.me/<username>?text=<encoded>` | `tg://resolve?domain=<username>&text=<encoded>` | 去掉开头的 `@`，只保留字母数字下划线 | `?text=` 或机器人 `?start=` |
| **LINE** | `https://line.me/R/oaMessage/@<id>/?<encoded>` | `line://ti/p/@<id>` | 官方账号带 `@`，个人链接走 `line.me/ti/p/~<id>` | 路径末尾直接跟编码后的文本 |
| **Viber** | `viber://chat?number=%2B<phone>` | `viber://pa?chatURI=<uri>` | 国际区号 + 纯数字，前面加 `%2B`（即 `+`） | 个人号不支持 URL 直填文本，公众账号走 `context` |
| **Zalo** | `https://zalo.me/<phone_or_id>` | `zalo://conversation?phone=<phone>` | 越南区号 `84` + 手机号（去掉开头 `0`）或 OA ID | 网页端直接跳会话页 |

## 2. 零依赖拼接纯函数（JavaScript / Node.js）

```js
/**
 * 清洗国际电话号码：去掉 +、空格、括号、短横线，并将 00 前缀规整为纯数字区号
 */
export function normalizePhoneDigits(rawPhone = '', countryCode = '') {
  const cc = String(countryCode || '').replace(/\D+/g, '');
  let num = String(rawPhone || '').trim().replace(/^00/, '').replace(/\D+/g, '');
  if (cc && !num.startsWith(cc)) {
    num = cc + num.replace(/^0+/, '');
  }
  return num;
}

/**
 * 构建 5 大平台客服唤起链接（支持把广告来源参数注入欢迎语模板）
 */
export function buildSocialDeeplink({ platform = 'whatsapp', account = '', countryCode = '', text = '' }) {
  const p = String(platform).toLowerCase().trim();
  const encodedText = text ? encodeURIComponent(String(text)) : '';

  if (p === 'whatsapp') {
    const phone = normalizePhoneDigits(account, countryCode);
    if (!phone) throw new Error('WhatsApp requires a valid phone number');
    return `https://wa.me/${phone}${encodedText ? `?text=${encodedText}` : ''}`;
  }

  if (p === 'telegram') {
    const user = String(account).trim().replace(/^@+/, '');
    if (!user) throw new Error('Telegram requires a username');
    return `https://t.me/${encodeURIComponent(user)}${encodedText ? `?text=${encodedText}` : ''}`;
  }

  if (p === 'line') {
    const id = String(account).trim().replace(/^@+/, '');
    return encodedText
      ? `https://line.me/R/oaMessage/@${encodeURIComponent(id)}/?${encodedText}`
      : `https://line.me/R/ti/p/@${encodeURIComponent(id)}`;
  }

  if (p === 'viber') {
    const phone = normalizePhoneDigits(account, countryCode);
    return `viber://chat?number=%2B${phone}`;
  }

  if (p === 'zalo') {
    const id = normalizePhoneDigits(account, countryCode) || String(account).trim();
    return `https://zalo.me/${encodeURIComponent(id)}`;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}
```

## 3. 把 UTM / 广告编号自动带进 WhatsApp 首句

如果不接复杂 API，想让客服一眼看出客户从哪个活动点进来，可以在欢迎语末尾加一个短标记：

```js
// 示例：Hello, I want to know more about the offer [ref:fb_spring_v2]
export function buildTaggedGreeting(baseGreeting, searchParams) {
  const params = new URLSearchParams(searchParams);
  const src = params.get('utm_source') || '';
  const camp = params.get('utm_campaign') || '';
  const tag = [src, camp].filter(Boolean).join('_');
  return tag ? `${baseGreeting} [ref:${tag}]` : baseGreeting;
}
```

## 4. 相关仓库

- 分流短链与多客服轮询/配额模拟器：[shortlink-rotator-demo](https://github.com/{ORG}/shortlink-rotator-demo)
- 离线 UTM 链接生成器：[utm-builder](https://github.com/{ORG}/utm-builder)
