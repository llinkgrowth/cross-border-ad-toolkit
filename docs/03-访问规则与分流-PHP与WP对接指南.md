---
title: "访问规则与异常流量分流：PHP / WordPress / Worker 对接指南（附安装脚本）"
description: "在不改动业务源码的前提下，通过边缘网关或 PHP 入口钩子对接远端访客判定接口，实现毫秒级超时兜底、本地安全页渲染与零泄漏同源接入。"
keyword: "访问规则对接"
slug: "traffic-guard-integration-guide"
date: 2026-11-25
lang: zh-CN
canonical: "https://guide.ipcloak.ai/traffic-guard-integration-guide/"
tags: ["访问规则", "流量分流", "PHP", "WordPress", "Cloudflare Workers"]
---

# 访问规则与异常流量分流：PHP / WordPress / Worker 对接指南（附安装脚本）

> 一句话结论：**访问规则对接的核心不是把庞大的 IP 库塞进你的业务服务器，而是做一个毫秒级超时、故障默认放行（Fail-open）的薄网关层**——判定交给云端 API，动作在本地入口完成。

很多团队在独立站或单页上接流量分流（Cloak / Traffic Guard）时，最常犯两个错误：

1. **在前端用纯 JS 跳转做拦截**：页面 HTML 已经完整下发，爬虫或自动化工具不执行 JS 就能拿走全部内容；真用户还要经历一次白屏闪烁。
2. **把判定调得太重、没有超时兜底**：一旦远端接口网络抖动，整个落地页直接 502 或卡死 5 秒，正常广告流量全军覆没。

正确的工程做法是**「薄客户端接入层 + 远端判定引擎」**：你的站点只装一个几十行的 PHP 入口脚本、WordPress 插件或 Cloudflare Worker，负责采集 6 个基础请求头、发一次带 800ms 硬超时的请求，然后根据返回的指令决定放行、302 跳转还是原域名直接渲染安全页（Safe Page）。

下面把整套对接架构、接口契约、PHP 安装脚本、WordPress 插件钩子和容灾伪代码完整拆开。

---

## 一、三层架构：哪些放开源客户端，哪些留云端

```text
访客请求 (GET /offer?fbclid=xxx)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ 1. 客户端接入层（运行在你的 PHP / WordPress / CF Worker） │
│    - 提取真实访客 IP（CF-Connecting-IP > X-Forwarded-For）│
│    - 采集 UA / Accept-Language / Referer / Sec-CH-UA     │
│    - 800ms 硬超时调用判定 API（超时或异常 → 默认放行）     │
└───────────────────────────┬──────────────────────────────┘
                            │ POST /v1/check (JSON, Store Token)
                            ▼
┌──────────────────────────────────────────────────────────┐
│ 2. 云端判定引擎（远端服务，不在业务站点本地运行）         │
│    - 5 层短路流水线：白名单 → 频次 → 离线 IP/ASN → 代理库 │
│    - 返回动作指令：pass / redirect / render_safe / 404    │
└───────────────────────────┬──────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   [action=pass]    [action=render_safe]  [action=redirect]
  继续渲染真实业务    本地读取 safe.html    HTTP 302 跳转到
   页面（URL 不变）    直接输出（URL 不变）   外部合规兜底地址
```

为什么要把接入层和判定层拆开？

- **零运维负担**：离线 IP 库、代理段、爬虫特征每周都在变，业务站只管发请求，不用每周更新几十 MB 的数据文件。
- **不暴露规则细节**：客户端只有 `store_token`，没有任何规则阈值代码，别人扒你前端源码也看不到判定逻辑。
- **支持原域名渲染安全页（`render_safe`）**：当判定需要展示安全页时，由本地 PHP 直接 `readfile('safe-page.html')` 输出 HTTP 200，浏览器地址栏不会发生任何 302 域名跳转。

---

## 二、标准判定契约（Request / Response Schema）

不管你用 PHP、WordPress 还是 Node.js 对接，客户端与判定接口之间只传这一个 JSON 结构：

### 1. 请求包（POST JSON）

```json
{
  "store_token": "st_live_9f8a7b6c5d4e",
  "visitor": {
    "ip": "203.0.113.42",
    "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)...",
    "accept_language": "en-US,en;q=0.9",
    "referer": "android-app://com.instagram.android/",
    "sec_ch_ua": "\"Chromium\";v=\"124\", \"Not-A.Brand\";v=\"99\"",
    "sec_ch_ua_mobile": "?1",
    "sec_ch_ua_platform": "\"iOS\"",
    "url": "/product/summer-sale?fbclid=IwAR123",
    "country_hint": "US",
    "click_ids": {
      "fbclid": "IwAR123"
    }
  }
}
```

### 2. 响应包（Response JSON）

```json
{
  "allow": false,
  "action": "render_safe",
  "target_url": "",
  "safe_template": "ecommerce",
  "reason_code": "bot_crawler",
  "ttl_seconds": 300
}
```

四个标准动作（`action`）：

| `action` 值 | 客户端行为 | 地址栏变化 | 适用场景 |
|---|---|---|---|
| `pass` | 什么都不做，继续加载你原本的落地页或商品页 | 不变 | 正常目标访客 |
| `render_safe` | 直接输出本地 `safe-page.html`（HTTP 200）并 `exit` | **不变** | 希望保持当前域名、展示常规内容页 |
| `redirect` | 发送 `Location: <target_url>`（HTTP 302）并 `exit` | 跳到新地址 | 引导去不发货地区说明页或独立站点 |
| `not_found` | 返回 HTTP 404 状态码与标准 404 页面并 `exit` | 不变 | 恶意扫描或无效路径请求 |

---

## 三、容灾铁律：Fail-Open 伪代码

任何接入代码都必须遵守一条铁律：**宁可放行，不可挂站**。当判定接口超时（>800ms）、DNS 解析失败、返回 5xx 或非预期 JSON 时，客户端必须静默降级为 `pass`。

```text
function handleIncomingRequest(req, config):
    # 1. 静态资源与后台路径直接跳过，避免无意义损耗
    if isStaticAsset(req.path) or isAdminPath(req.path):
        return PASS_THROUGH

    # 2. 提取真实 IP（优先取边缘 CDN 头，防伪造需确认站点已挂在 CDN 后）
    clientIp = firstNonEmpty(
        req.headers["CF-Connecting-IP"],
        firstIpIn(req.headers["X-Forwarded-For"]),
        req.remoteAddr
    )

    # 3. 组装最小判定特征包
    payload = {
        store_token: config.storeToken,
        visitor: {
            ip: clientIp,
            ua: req.headers["User-Agent"] ?? "",
            accept_language: req.headers["Accept-Language"] ?? "",
            referer: req.headers["Referer"] ?? "",
            url: req.originalUri
        }
    }

    # 4. 发起带硬超时的判定请求（connect_timeout=300ms, total_timeout=800ms）
    resp = httpPostJson(config.endpoint, payload, timeoutMs = 800)

    # 5. Fail-open：任何网络错误、超时、非 200、JSON 解析失败一律放行
    if resp.error or resp.status != 200 or not isValidDecision(resp.body):
        logDebug("traffic-guard fail-open", resp.error)
        return PASS_THROUGH

    # 6. 按指令执行动作
    switch resp.body.action:
        case "pass":
            return PASS_THROUGH
        case "render_safe":
            sendHtml(200, readLocalFile(config.safePagePath))
            halt()
        case "redirect":
            sendRedirect(302, resp.body.target_url)
            halt()
        case "not_found":
            sendHtml(404, "404 Not Found")
            halt()
```

---

## 四、PHP 独立站对接：单文件客户端 + 一键安装脚本

如果你的落地页是 PHP 站点或静态 HTML 改 `.php`，只需要把下面这个客户端类放到站点目录，并在首页 `index.php` 第一行引入。

### 1. 核心对接类 `CloakClient.php`（完整可运行 Demo）

```php
<?php
/**
 * 轻量访问规则对接客户端 Demo（零依赖，PHP 7.4+）
 * 仅负责采集访客特征并执行动作，核心判定在远端接口完成。
 */
class CloakClient
{
    private string $endpoint;
    private string $storeToken;
    private int $timeoutMs;
    private string $safePageFile;

    public function __construct(array $config)
    {
        $this->endpoint     = (string)($config['endpoint'] ?? '');
        $this->storeToken   = (string)($config['store_token'] ?? '');
        $this->timeoutMs    = (int)($config['timeout_ms'] ?? 800);
        $this->safePageFile = (string)($config['safe_page_file'] ?? __DIR__ . '/safe-page.html');
    }

    public function resolveClientIp(array $server): string
    {
        if (!empty($server['HTTP_CF_CONNECTING_IP'])) {
            return trim((string)$server['HTTP_CF_CONNECTING_IP']);
        }
        if (!empty($server['HTTP_X_FORWARDED_FOR'])) {
            $parts = explode(',', (string)$server['HTTP_X_FORWARDED_FOR']);
            return trim($parts[0]);
        }
        return (string)($server['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public function buildPayload(array $server, array $query): array
    {
        $clickIds = [];
        foreach (['fbclid', 'gclid', 'ttclid', 'gbraid', 'wbraid'] as $key) {
            if (!empty($query[$key]) && is_string($query[$key])) {
                $clickIds[$key] = substr($query[$key], 0, 256);
            }
        }

        return [
            'store_token' => $this->storeToken,
            'visitor' => [
                'ip'                  => $this->resolveClientIp($server),
                'ua'                  => (string)($server['HTTP_USER_AGENT'] ?? ''),
                'accept_language'     => (string)($server['HTTP_ACCEPT_LANGUAGE'] ?? ''),
                'referer'             => (string)($server['HTTP_REFERER'] ?? ''),
                'sec_ch_ua'           => (string)($server['HTTP_SEC_CH_UA'] ?? ''),
                'sec_ch_ua_mobile'    => (string)($server['HTTP_SEC_CH_UA_MOBILE'] ?? ''),
                'sec_ch_ua_platform'  => (string)($server['HTTP_SEC_CH_UA_PLATFORM'] ?? ''),
                'country_hint'        => (string)($server['HTTP_CF_IPCOUNTRY'] ?? ''),
                'url'                 => (string)($server['REQUEST_URI'] ?? '/'),
                'click_ids'           => $clickIds,
            ],
        ];
    }

    public function check(array $server, array $query): array
    {
        if ($this->endpoint === '' || $this->storeToken === '' || !function_exists('curl_init')) {
            return ['allow' => true, 'action' => 'pass', 'fallback' => 'unconfigured'];
        }

        $body = json_encode($this->buildPayload($server, $query), JSON_UNESCAPED_SLASHES);
        $ch = curl_init($this->endpoint);
        curl_setopt_array($ch, [
            CURLOPT_POST            => true,
            CURLOPT_POSTFIELDS      => $body,
            CURLOPT_HTTPHEADER      => ['Content-Type: application/json', 'Accept: application/json'],
            CURLOPT_RETURNTRANSFER  => true,
            CURLOPT_CONNECTTIMEOUT_MS => min(300, $this->timeoutMs),
            CURLOPT_TIMEOUT_MS      => $this->timeoutMs,
        ]);

        $raw  = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if (!is_string($raw) || $code !== 200) {
            return ['allow' => true, 'action' => 'pass', 'fallback' => 'network_or_http_' . $code];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded['action'])) {
            return ['allow' => true, 'action' => 'pass', 'fallback' => 'bad_json'];
        }
        return $decoded;
    }

    public function enforce(): void
    {
        $decision = $this->check($_SERVER, $_GET);
        $action   = (string)($decision['action'] ?? 'pass');

        if ($action === 'pass' || !empty($decision['allow'])) {
            return;
        }
        if ($action === 'redirect' && !empty($decision['target_url'])) {
            header('Location: ' . $decision['target_url'], true, 302);
            exit;
        }
        if ($action === 'not_found') {
            http_response_code(404);
            echo '<!doctype html><title>404 Not Found</title><h1>404 Not Found</h1>';
            exit;
        }
        // 默认兜底动作：render_safe，原域名直接渲染本地安全页
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        if (is_file($this->safePageFile)) {
            readfile($this->safePageFile);
        } else {
            echo '<!doctype html><title>Welcome</title><main><h1>Welcome to our store</h1></main>';
        }
        exit;
    }
}
```

### 2. 一键安装脚本 `install.php` 怎么工作

不懂代码的投手拿到服务器后，不想手写配置文件。安装脚本只做四步：

```bash
# CLI 一键生成配置与入口文件（endpoint 填写判定服务地址）
php install.php --token=st_demo_123456 --endpoint=127.0.0.1:8787/v1/check --mode=render_safe
```

1. **环境自检**：检查 `PHP_VERSION_ID >= 70400`、`extension_loaded('curl')`、当前目录是否可写。
2. **写配置**：把 `endpoint`、`store_token`、`timeout_ms` 写入同目录 `cloak-config.json`（权限 `0600`）。
3. **生成 `gate.php`**：生成一段 6 行的入口引导代码；你只需在原有的 `index.php` 顶部加一行 `<?php require_once __DIR__ . '/gate.php'; ?>`。
4. **连通性自测**：立刻用模拟爬虫 UA 发一次 ping，确认远端接口返回 200 JSON。

---

## 五、WordPress / WooCommerce 插件对接：`template_redirect` 钩子

WordPress 站点不需要改主题文件。标准做法是挂在 `template_redirect` 钩子上（此时 WP 已经解析完当前访问的是文章、页面还是 WooCommerce 商品，但还没开始输出任何 HTML）：

```php
add_action('template_redirect', function () {
    // 1. 后台、登录态管理员、AJAX、REST、Cron 一律跳过
    if (is_admin() || is_user_logged_in() || wp_doing_ajax() || wp_doing_cron()) {
        return;
    }

    // 2. 只在勾选的页面类型生效（如单页 Page 或 WooCommerce 商品页）
    $opts = get_option('ipcloak_traffic_guard_options', []);
    if (empty($opts['enabled']) || empty($opts['store_token']) || empty($opts['endpoint'])) {
        return;
    }

    $client = new CloakClient([
        'endpoint'       => $opts['endpoint'],
        'store_token'    => $opts['store_token'],
        'timeout_ms'     => (int)($opts['timeout_ms'] ?? 800),
        'safe_page_file' => __DIR__ . '/safe-page.html',
    ]);
    $client->enforce();
}, 1);
```

这样有三个好处：
- **你自己登录后台改文章时永远不会被拦**（`is_user_logged_in()` 直接放行）；
- 可以精确控制只保护投放落地的商品页，不影响全站首页与文章目录；
- 卸载或停用插件即可瞬间恢复原状，零主题侵入。

---

## 六、上线前自检清单

- [ ] **超时实测**：把 `endpoint` 临时改成一个不存在的端口，刷新页面——页面必须在 800ms 内正常打开（验证 Fail-open 生效）。
- [ ] **真实 IP 验证**：站点挂在 Cloudflare 后，`resolveClientIp` 取到的是访客真实 IP 而不是 Cloudflare 节点 IP。
- [ ] **查询参数保留**：正常访客放行后，URL 上的 `fbclid`、`ttclid`、`utm_*` 参数完整保留，不影响页面上的像素触发。
- [ ] **本地安全页无死链**：`render_safe` 模式下渲染的 `safe-page.html` 必须是独立完整的合规页面，不引用受限素材。
- [ ] **静态资源不重复请求**：图片、CSS、JS、字体请求不进判定钩子，避免一次页面加载消耗 20 次判定额度。

---

<sub>本文由爱普出海团队整理，配套的 PHP 安装脚本、WordPress 插件骨架、Cloudflare Worker 与本地 Mock 联调服务端已全部开源在 `cloak-integration-kit` 仓库，可直接在本地跑通测试。</sub>
