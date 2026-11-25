# Cloak Integration Kit & SDK Demos (`@ipcloak/cloak-integration-kit`)

[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](./LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-2563eb.svg)](./package.json)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18.0-339933.svg)](./package.json)
[![PHP >= 7.4](https://img.shields.io/badge/PHP-%3E%3D7.4-777bb4.svg)](./php-installer/)

Open-source client integration SDKs, single-file PHP bootstrap installer, WordPress/WooCommerce plugin, Cloudflare Worker edge gateway, and a zero-dependency local contract mock server for **Traffic Guard**, **Visitor Access Rules**, **Bot & Crawler Filtering**, and **Safe Page Fallback** routing.

> **Architectural Scope Notice**  
> This repository contains **client-side & edge integration adapters** and a **3-rule local contract mock server** (`mock-server/server.mjs`) so developers can verify end-to-end request/response contracts, timeout handling, and fail-open behavior locally with zero external dependencies or credentials. Multi-dimensional cloud risk evaluation and hosted safe-page generation are performed remotely via the Decision API contract.

---

## System Architecture

```text
                                 +----------------------------------------+
                                 |        Incoming Visitor Request        |
                                 | (IP, UA, Lang, Referer, ClickID, URL)  |
                                 +-------------------+--------------------+
                                                     |
                                                     v
                     +-------------------------------+-------------------------------+
                     |                Integration Gate / Edge Adapter                |
                     |  - PHP Gate (php-installer/CloakClient.php & install.php)     |
                     |  - WordPress Plugin (template_redirect hook)                  |
                     |  - Cloudflare Worker Edge Gateway (cloudflare-worker/)        |
                     |  - Browser JS App Proxy SDK (js-sdk/cloak-sdk.js)             |
                     +---------------+-------------------------------+---------------+
                                     |                               |
          POST /v1/decision          |                               | Timeout (e.g. >800ms)
      (Millisecond Timeout Guard)    v                               | or HTTP 5xx Error
                     +---------------+---------------+               |
                     |      Decision API Service     |               |
                     |  - Cloud Risk Engine OR       |               |
                     |  - Local Mock Server (:8787)  |               |
                     +---------------+---------------+               |
                                     |                               |
          JSON Decision Contract     |                               v
     {"allow", "action", "target"}   |                    +----------+-----------+
                                     |                    |  FAIL-OPEN FALLBACK  |
                                     +------------------->|  Default: allow=true |
                                     |                    |  (Zero Interruption) |
                                     v                    +----------+-----------+
             +-----------------------+-----------------------+       |
             |               |               |               |       |
             v               v               v               v       v
      +------+------+ +------+------+ +------+------+ +------+-------+------+
      | render_safe | |  redirect   | |  not_found  | |        pass         |
      | (HTTP 200   | | (HTTP 302   | | (HTTP 404   | | (Continue to Store  |
      |  Safe Page, | |  Target URL | |  Standard   | |  Origin / Template) |
      |  Same URL)  | |  Location)  | |  Not Found) | |                     |
      +-------------+ +-------------+ +-------------+ +---------------------+
```

---

## Repository Structure

```text
cloak-integration-kit/
├── php-installer/
│   ├── install.php          # Dual-mode (CLI + Web Wizard) PHP environment check & gate generator
│   ├── CloakClient.php      # Pure PHP SDK (IP priority extraction, cURL ms timeout, fail-open, 3 actions)
│   └── safe-page.html       # Clean compliant e-commerce/studio placeholder Safe Page template
├── wordpress-plugin/
│   └── ipcloak-traffic-guard/
│       └── ipcloak-traffic-guard.php  # WordPress & WooCommerce plugin (template_redirect + Settings UI)
├── js-sdk/
│   └── cloak-sdk.js         # Lightweight Browser SDK supporting same-origin App Proxy (/apps/traffic-guard/check)
├── cloudflare-worker/
│   └── worker.js            # Cloudflare Worker edge gateway with optional KV caching & fail-open pass-through
├── mock-server/
│   └── server.mjs           # Zero-dependency Node.js local Mock Decision Server (3 deterministic demo rules)
├── cli.mjs                  # CLI simulator (`node cli.mjs simulate --ua "curl/8.0" --ip "1.2.3.4"`)
├── test/
│   └── integration.test.mjs # 20+ automated unit & E2E tests using built-in `node:test`
└── package.json             # Zero external dependencies
```

---

## Decision API JSON Contract

### 1. Client -> Decision API (`POST /v1/decision` or `/apps/traffic-guard/check`)

```json
{
  "store_token": "demo_store_token_local",
  "visitor": {
    "ip": "203.0.113.10",
    "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
    "accept_language": "en-US,en;q=0.9",
    "referer": "https://www.google.com/",
    "sec_ch_ua": "\"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"",
    "url": "https://store.example.com/products/desk-mat?gclid=EAIaIQobChMI",
    "country_code": "US",
    "click_ids": {
      "gclid": "EAIaIQobChMI"
    }
  }
}
```

| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `store_token` | `string` | Yes | Store or site identifier token |
| `visitor.ip` | `string` | Yes | True visitor IP extracted via `CF-Connecting-IP` -> `True-Client-IP` -> `X-Real-IP` -> `X-Forwarded-For` -> `REMOTE_ADDR` |
| `visitor.ua` | `string` | Yes | Raw `User-Agent` HTTP header |
| `visitor.accept_language` | `string` | No | `Accept-Language` header or `navigator.language` |
| `visitor.referer` | `string` | No | HTTP `Referer` header or `document.referrer` |
| `visitor.sec_ch_ua` | `string` | No | Client Hints `Sec-CH-UA` brand header |
| `visitor.url` | `string` | Yes | Full landing page URL including query string |
| `visitor.click_ids` | `object` | No | Extracted marketing parameters (`gclid`, `fbclid`, `ttclid`, `msclkid`, `utm_source`, etc.) |

### 2. Decision API -> Client Gate Response (`200 OK`)

```json
{
  "allow": false,
  "action": "render_safe",
  "target_url": "",
  "safe_template": "ecommerce"
}
```

| Field | Type | Values | Description |
| :--- | :--- | :--- | :--- |
| `allow` | `boolean` | `true` \| `false` | Whether the visitor passes access rules (`true` = allow normal store access) |
| `action` | `string` | `"pass"` \| `"redirect"` \| `"render_safe"` \| `"not_found"` | Enforcement instruction when `allow` is `false` |
| `target_url` | `string` | URL string | Destination URL when `action === "redirect"` (HTTP 302) |
| `safe_template` | `string` | `"ecommerce"` \| `"saas"` | Safe page template identifier when `action === "render_safe"` |

---

## Fail-Open Disaster Recovery Pattern

Every integration adapter in this repository enforces a **strict millisecond timeout** (default `600ms–800ms`) and **Fail-Open fallback**. If the Decision API times out, encounters a DNS/TLS error, or returns a non-2xx HTTP status, the gate immediately defaults to `allow: true, action: "pass"` so genuine customer traffic is never disrupted:

```pseudo
function evaluateVisitorWithFailOpen(visitorPayload, timeoutMs = 800):
    try:
        response = httpPostJson(DECISION_ENDPOINT, visitorPayload, timeout = timeoutMs)
        if response.status != 200 or not isBoolean(response.body.allow):
            return { allow: true, action: "pass", fail_open: true }
        return response.body
    catch TimeoutError, NetworkError:
        // Fail-open guarantees 100% store availability even during upstream maintenance
        return { allow: true, action: "pass", fail_open: true }
```

---

## Quick Start: Local Mock Server & CLI Simulation

Clone this repository and run the contract simulator and test suite immediately—**no account, database, or npm install required** (Node.js >= 18):

### 1. Run CLI Contract Simulator

```bash
# Simulate a CLI crawler User-Agent (triggers Demo Rule 1 -> render_safe)
node cli.mjs simulate --ua "curl/8.0" --ip "1.2.3.4"

# Simulate an explicit query block flag with JSON output (triggers Demo Rule 2)
node cli.mjs simulate --url "https://shop.example.com/item?gclid=test123&mock_block=1" --json

# Simulate test country header XX (triggers Demo Rule 3 -> 302 redirect)
node cli.mjs simulate --country "XX" --ua "Mozilla/5.0"

# Public IP & CIDR Inspector (ipcheck: public vs RFC1918/bogon + CIDR allow/deny matching)
node cli.mjs ipcheck --ip "203.0.113.45" --allow-cidrs "203.0.113.0/24" --json

# Public UTM & Click-ID Whitelist Check (utmcheck: require allowed utm_source + ad click ID)
node cli.mjs utmcheck --url "https://shop.example.com/offer?utm_source=facebook&fbclid=IwAR123" --allowed-sources "facebook,tiktok" --require-click-id --json
```

### 2. Start the Local Mock Decision Server

```bash
npm run mock
# Listening on http://127.0.0.1:8787
# Decision Endpoint: POST http://127.0.0.1:8787/v1/decision
```

The local mock server implements **3 deterministic demo rules** for integration testing:
1. **Demo Rule 1 (`demo_rule_1_bot_ua`)**: `visitor.ua` contains `BotDemo`, `curl/`, `Wget/`, `HeadlessChrome`, or `python-requests` -> returns `allow: false, action: "render_safe"`.
2. **Demo Rule 2 (`demo_rule_2_query_trigger`)**: `visitor.url` query string contains `?mock_block=1` or `?mock_action=redirect|render_safe|not_found` -> returns `allow: false` with the requested action.
3. **Demo Rule 3 (`demo_rule_3_country_xx`)**: `visitor.country_code` or `CF-IPCountry` header equals `XX` -> returns `allow: false, action: "redirect"`.

### 3. Run the Automated Test Suite

```bash
npm test
# Runs 20+ unit & end-to-end integration tests via node --test
```

---

## Integration Guides

### 1. PHP One-File Installer & Standalone SDK (`php-installer/`)

Copy `php-installer/install.php`, `php-installer/CloakClient.php`, and `php-installer/safe-page.html` into your PHP project root.

**Option A: CLI Installation**
```bash
php php-installer/install.php \
  --token="demo_store_token_local" \
  --endpoint="http://127.0.0.1:8787/v1/decision" \
  --mode="render_safe" \
  --ping
```

**Option B: Web Setup Wizard**
Navigate to `https://your-site.example.com/install.php` in your browser to verify `PHP >= 7.4` & `ext-curl`, test endpoint latency, write `cloak-config.json`, and generate `gate.php`.

Then include `gate.php` at the top of your front controller (`index.php`):
```php
<?php
require_once __DIR__ . '/gate.php';
// Normal store execution continues below when visitor is allowed
```

### 2. WordPress & WooCommerce Plugin (`wordpress-plugin/`)

1. Copy `wordpress-plugin/ipcloak-traffic-guard` into your WordPress installation at `wp-content/plugins/ipcloak-traffic-guard/`.
2. Activate **IpCloak Traffic Guard & Safe Page Fallback** in the WordPress Plugins screen.
3. Open **Settings -> Traffic Guard** to configure:
   - **Decision API Endpoint** & **Store Token**
   - **Fail-Open Timeout (ms)** (default `800ms`)
   - **Administrator & Login Bypass** (skips checks for logged-in editors/admins)
   - **Protected Content Scopes** (Posts, Pages, WooCommerce Products)

### 3. Cloudflare Worker Edge Gateway (`cloudflare-worker/worker.js`)

Deploy `cloudflare-worker/worker.js` to your Cloudflare route to filter traffic at the CDN edge before hitting your origin server:

```toml
# wrangler.toml example
name = "ipcloak-edge-gateway"
main = "cloudflare-worker/worker.js"
compatibility_date = "2026-01-01"

[vars]
CLOAK_STORE_TOKEN = "demo_store_token_local"
CLOAK_API_ENDPOINT = "http://127.0.0.1:8787/v1/decision"
CLOAK_TIMEOUT_MS = "600"
```

### 4. Browser JS SDK & App Proxy (`js-sdk/cloak-sdk.js`)

For storefront themes using a same-origin App Proxy path (`/apps/traffic-guard/check`):

```html
<script type="module">
  import { runBrowserTrafficGuard } from './js-sdk/cloak-sdk.js';

  await runBrowserTrafficGuard({
    storeToken: 'demo_store_token_local',
    endpoint: '/apps/traffic-guard/check',
    timeoutMs: 800
  });
</script>
```

---

## Frequently Asked Questions (FAQ)

**Q: What happens if the Decision API is unreachable or slow?**  
A: Every SDK and gateway in this kit enforces a strict sub-second timeout (`600ms–800ms`) and immediately triggers **Fail-Open (`allow: true, action: "pass"`)**. Your primary store remains accessible without interruption.

**Q: How does `render_safe` differ from `redirect`?**  
A: When `action` is `"render_safe"`, the PHP gate, WordPress plugin, or Cloudflare Worker serves the compliant HTML template (`safe-page.html`) directly in the HTTP 200 response body **without changing the browser URL**. When `action` is `"redirect"`, an HTTP `302 Found` redirect is issued to `target_url`.

**Q: Does this repository include offline IP databases or cloud risk rules?**  
A: No. To keep client integrations lightweight, zero-dependency, and simple to maintain, all adapters use the stateless JSON HTTP contract. Local testing is powered by `mock-server/server.mjs` (3 demo rules). For the full cloud multi-dimensional rule engine and hosted safe-page builder, visit [`cloak.ipcloak.ai`](https://cloak.ipcloak.ai) and [`builder.ipcloak.ai`](https://builder.ipcloak.ai).

---

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026 IpCloak.
