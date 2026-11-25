# 访问规则契约、IP/CIDR 检查（ipcheck）与 UTM 白名单校验

这份文档汇总 `cloak-integration-kit` 仓库里公开的三个基础对接组件：**真实访客 IP 提取与 CIDR 匹配（`ipcheck`）**、**投放参数白名单校验（`utmcheck`）**、以及**毫秒级超时 Fail-Open 判定契约**。

> 边界说明：这里全部是运行在业务站点入口（PHP / WordPress / Cloudflare Worker）的**公开协议与确定性校验工具**；云端多维风险评分与托管安全页由服务端完成，不在客户端硬编码。

## 1. 真实访客 IP 提取优先级与 CIDR 匹配 (`ipcheck`)

站点挂在 Cloudflare 或反向代理后面时，直接读 `REMOTE_ADDR` 拿到的是 CDN 节点 IP。客户端必须按固定优先级提取，并剥离 IPv4-mapped IPv6 前缀（`::ffff:`）：

```text
优先级顺序：
1. CF-Connecting-IP   (Cloudflare 边缘注入的真实访客 IP)
2. True-Client-IP     (Akamai / Cloudflare Enterprise)
3. X-Real-IP          (Nginx 反代常用头)
4. X-Forwarded-For    (取逗号分隔的第一个 IP)
5. REMOTE_ADDR        (直连兜底)
```

32 位无符号整数 CIDR 子网匹配算法（零依赖 JS 与 PHP 通用）：

```js
export function ipv4ToUint32(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!/^\d{1,3}$/.test(p) || n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc >>> 0;
}

export function matchIpCidr(ip, cidr) {
  if (!cidr.includes('/')) return ip.trim() === cidr.trim();
  const [subnet, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipNum = ipv4ToUint32(ip);
  const netNum = ipv4ToUint32(subnet);
  if (ipNum === null || netNum === null || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}
```

CLI 一键自测：

```bash
node cli.mjs ipcheck --ip "203.0.113.45" --allow-cidrs "203.0.113.0/24" --json
```

## 2. UTM 参数与广告 Click-ID 白名单校验 (`utmcheck`)

如果一条落地页只服务于特定渠道的付费广告流量，可以在入口处先做一次零网络开销的参数白名单检查：

- **来源白名单（`allowedSources`）**：例如只允许 `utm_source` 为 `facebook` 或 `tiktok`；
- **媒介白名单（`allowedMediums`）**：例如只允许 `utm_medium` 为 `cpc` 或 `paid`；
- **强制要求广告点击 ID（`requireClickId`）**：URL 查询串里必须携带 `fbclid` / `ttclid` / `gclid` / `gbraid` / `wbraid` / `msclkid` 之一，无参数直接走安全兜底页。

CLI 一键自测：

```bash
node cli.mjs utmcheck \
  --url "https://shop.example.com/offer?utm_source=facebook&fbclid=IwAR123" \
  --allowed-sources "facebook,tiktok" \
  --require-click-id \
  --json
```

## 3. 三平台广告像素标准事件速查

| 业务动作 | Meta Pixel (`fbq`) | TikTok Pixel (`ttq`) | GA4 (`gtag`) | 去重键 |
|---|---|---|---|---|
| 页面浏览 | `PageView` | `PageView` | `page_view` | — |
| 咨询点击 | `Contact` | `Contact` | `generate_lead` | `eventID` / `event_id` |
| 表单提交 | `Lead` | `SubmitForm` | `generate_lead` | `eventID` / `event_id` |
| 发起结账 | `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` | `eventID` / `event_id` |
| 完成订单 | `Purchase` (`value`, `currency`) | `CompletePayment` (`value`, `currency`) | `purchase` (`transaction_id`) | `ord_<orderId>` |

## 4. 相关仓库

- PHP 安装脚本 / WordPress 插件 / Worker 网关 / 本地 Mock 服务：[cloak-integration-kit](https://github.com/{ORG}/cloak-integration-kit)
- 像素事件映射与离线调试沙盒：[pixel-event-debugger](https://github.com/{ORG}/pixel-event-debugger)
