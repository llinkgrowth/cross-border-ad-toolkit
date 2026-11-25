<?php
/**
 * IpCloak Traffic Guard — Pure PHP Client SDK (CloakClient.php)
 *
 * Lightweight, zero-dependency PHP client that collects visitor context,
 * queries the remote Decision API with millisecond cURL timeouts, and enforces
 * fail-open fallback to guarantee zero interruption to store traffic.
 *
 * Requirements: PHP >= 7.4, ext-curl, ext-json
 * License: MIT
 */

declare(strict_types=1);

namespace IpCloak\IntegrationKit;

class CloakClient
{
    private string $storeToken;
    private string $endpoint;
    private int $timeoutMs;
    private string $safePagePath;
    private string $defaultMode;

    /**
     * @var array<int, string> Supported click tracking query parameters
     */
    private const CLICK_ID_KEYS = [
        'gclid',
        'fbclid',
        'ttclid',
        'msclkid',
        'twclid',
        'wbraid',
        'gbraid',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content',
        'utm_id',
    ];

    /**
     * Check whether an IPv4 address matches an exact IP or CIDR subnet (e.g. "203.0.113.0/24").
     */
    public function matchIpCidr(string $ip, string $cidrOrIp): bool
    {
        $cleanIp   = (string) preg_replace('/^::ffff:/i', '', trim($ip));
        $cleanRule = (string) preg_replace('/^::ffff:/i', '', trim($cidrOrIp));
        if ($cleanIp === '' || $cleanRule === '') {
            return false;
        }
        if (strpos($cleanRule, '/') === false) {
            return strcasecmp($cleanIp, $cleanRule) === 0;
        }
        [$subnet, $bitsStr] = explode('/', $cleanRule, 2);
        $bits = (int) $bitsStr;
        $ipLong = ip2long($cleanIp);
        $netLong = ip2long($subnet);
        if ($ipLong === false || $netLong === false || $bits < 0 || $bits > 32) {
            return false;
        }
        if ($bits === 0) {
            return true;
        }
        $mask = -1 << (32 - $bits);
        return (($ipLong & $mask) === ($netLong & $mask));
    }

    /**
     * Public UTM & Click-ID whitelist check (can be evaluated locally before calling remote API).
     *
     * @param array<int, string> $allowedSources
     * @param bool $requireClickId
     * @param array<string, mixed>|null $query
     */
    public function checkUtmGuard(array $allowedSources = [], bool $requireClickId = false, ?array $query = null): bool
    {
        $clickIds = $this->extractClickIds($query);
        if (!empty($allowedSources)) {
            $src = strtolower(trim((string) ($clickIds['utm_source'] ?? '')));
            $normalizedAllowed = array_map(static fn(string $s): string => strtolower(trim($s)), $allowedSources);
            if ($src === '' || !in_array($src, $normalizedAllowed, true)) {
                return false;
            }
        }
        if ($requireClickId) {
            $adKeys = ['gclid', 'fbclid', 'ttclid', 'msclkid', 'twclid', 'wbraid', 'gbraid'];
            $hasClickId = false;
            foreach ($adKeys as $k) {
                if (!empty($clickIds[$k])) {
                    $hasClickId = true;
                    break;
                }
            }
            if (!$hasClickId) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param array<string, mixed> $config
     */
    public function __construct(array $config = [])
    {
        $this->storeToken   = (string) ($config['store_token'] ?? 'demo_store_token_local');
        $this->endpoint     = (string) ($config['endpoint'] ?? 'http://127.0.0.1:8787/v1/decision');
        $this->timeoutMs    = max(100, (int) ($config['timeout_ms'] ?? 800));
        $this->safePagePath = (string) ($config['safe_page_path'] ?? (__DIR__ . '/safe-page.html'));
        $this->defaultMode  = (string) ($config['default_mode'] ?? 'render_safe');
    }

    /**
     * Extract true visitor IP respecting reverse-proxy / CDN priority:
     * CF-Connecting-IP -> True-Client-IP -> X-Real-IP -> X-Forwarded-For -> REMOTE_ADDR
     *
     * @param array<string, mixed>|null $server
     */
    public function extractVisitorIp(?array $server = null): string
    {
        $srv = $server ?? $_SERVER;
        $priorityHeaders = [
            'HTTP_CF_CONNECTING_IP',
            'HTTP_TRUE_CLIENT_IP',
            'HTTP_X_REAL_IP',
            'HTTP_X_FORWARDED_FOR',
            'REMOTE_ADDR',
        ];

        foreach ($priorityHeaders as $key) {
            if (!empty($srv[$key]) && is_string($srv[$key])) {
                $parts = explode(',', $srv[$key]);
                $candidate = trim($parts[0]);
                if ($candidate !== '') {
                    return (string) preg_replace('/^::ffff:/i', '', $candidate);
                }
            }
        }

        return '127.0.0.1';
    }

    /**
     * Collect marketing click IDs from query array or URL.
     *
     * @param array<string, mixed>|null $query
     * @return array<string, string>
     */
    public function extractClickIds(?array $query = null): array
    {
        $get = $query ?? $_GET;
        $clickIds = [];

        foreach (self::CLICK_ID_KEYS as $key) {
            if (isset($get[$key]) && is_scalar($get[$key])) {
                $val = trim((string) $get[$key]);
                if ($val !== '') {
                    $clickIds[$key] = $val;
                }
            }
        }

        return $clickIds;
    }

    /**
     * Build the standardized JSON request payload for the Decision API.
     *
     * @param array<string, mixed>|null $server
     * @param array<string, mixed>|null $query
     * @return array<string, mixed>
     */
    public function buildPayload(?array $server = null, ?array $query = null): array
    {
        $srv = $server ?? $_SERVER;
        $scheme = (!empty($srv['HTTPS']) && $srv['HTTPS'] !== 'off') ? 'https' : 'http';
        $host = (string) ($srv['HTTP_HOST'] ?? 'localhost');
        $uri = (string) ($srv['REQUEST_URI'] ?? '/');

        $visitor = [
            'ip'              => $this->extractVisitorIp($srv),
            'ua'              => (string) ($srv['HTTP_USER_AGENT'] ?? ''),
            'accept_language' => (string) ($srv['HTTP_ACCEPT_LANGUAGE'] ?? ''),
            'referer'         => (string) ($srv['HTTP_REFERER'] ?? ''),
            'sec_ch_ua'       => (string) ($srv['HTTP_SEC_CH_UA'] ?? ''),
            'url'             => $scheme . '://' . $host . $uri,
            'click_ids'       => $this->extractClickIds($query),
        ];

        if (!empty($srv['HTTP_CF_IPCOUNTRY'])) {
            $visitor['country_code'] = strtoupper(trim((string) $srv['HTTP_CF_IPCOUNTRY']));
        }

        return [
            'store_token' => $this->storeToken,
            'visitor'     => $visitor,
        ];
    }

    /**
     * Query the remote Decision API with strict millisecond timeout and Fail-Open fallback.
     *
     * @param array<string, mixed>|null $payload
     * @return array<string, mixed>
     */
    public function verifyVisitor(?array $payload = null): array
    {
        $bodyPayload = $payload ?? $this->buildPayload();

        if (!function_exists('curl_init')) {
            return $this->failOpenDecision('EXT_CURL_MISSING');
        }

        $jsonBody = json_encode($bodyPayload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($jsonBody === false) {
            return $this->failOpenDecision('JSON_ENCODE_ERROR');
        }

        $ch = curl_init($this->endpoint);
        if ($ch === false) {
            return $this->failOpenDecision('CURL_INIT_FAILED');
        }

        curl_setopt_array($ch, [
            CURLOPT_POST              => true,
            CURLOPT_POSTFIELDS        => $jsonBody,
            CURLOPT_RETURNTRANSFER    => true,
            CURLOPT_HTTPHEADER        => [
                'Content-Type: application/json',
                'Accept: application/json',
                'X-Cloak-Client: php-sdk/1.0.0',
            ],
            CURLOPT_TIMEOUT_MS        => $this->timeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => min(400, $this->timeoutMs),
            CURLOPT_NOSIGNAL          => 1,
        ]);

        $rawResponse = curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($rawResponse === false || $httpCode < 200 || $httpCode >= 300) {
            return $this->failOpenDecision($curlErr !== '' ? $curlErr : ('HTTP_' . $httpCode));
        }

        $decoded = json_decode((string) $rawResponse, true);
        if (!is_array($decoded) || !array_key_exists('allow', $decoded)) {
            return $this->failOpenDecision('INVALID_RESPONSE_CONTRACT');
        }

        return [
            'allow'         => (bool) $decoded['allow'],
            'action'        => (string) ($decoded['action'] ?? ($decoded['allow'] ? 'pass' : $this->defaultMode)),
            'target_url'    => (string) ($decoded['target_url'] ?? ''),
            'safe_template' => (string) ($decoded['safe_template'] ?? 'ecommerce'),
            'fail_open'     => false,
        ];
    }

    /**
     * Execute the decision action in the current PHP lifecycle:
     * - pass        -> return true and allow normal application execution
     * - redirect    -> send 302 Location header and exit
     * - render_safe -> output local safe-page.html (keeping URL unchanged) and exit
     * - not_found   -> send HTTP 404 Not Found and exit
     *
     * @param array<string, mixed>|null $decision
     * @param bool $exitOnBlock Set false during dry-run tests
     */
    public function enforce(?array $decision = null, bool $exitOnBlock = true): bool
    {
        $result = $decision ?? $this->verifyVisitor();
        $allow = (bool) ($result['allow'] ?? true);
        $action = (string) ($result['action'] ?? 'pass');

        if ($allow || $action === 'pass') {
            if (!headers_sent()) {
                header('X-Traffic-Guard: pass');
            }
            return true;
        }

        if ($action === 'redirect' && !empty($result['target_url'])) {
            if (!headers_sent()) {
                header('Cache-Control: no-store, no-cache, must-revalidate');
                header('X-Traffic-Guard: redirect');
                header('Location: ' . (string) $result['target_url'], true, 302);
            }
            if ($exitOnBlock) {
                exit;
            }
            return false;
        }

        if ($action === 'not_found') {
            if (!headers_sent()) {
                http_response_code(404);
                header('Content-Type: text/html; charset=utf-8');
                header('Cache-Control: no-store, no-cache, must-revalidate');
                header('X-Traffic-Guard: not_found');
            }
            echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>The requested page is unavailable.</p></body></html>";
            if ($exitOnBlock) {
                exit;
            }
            return false;
        }

        // Default fallback action: render_safe (serve local safe-page.html while preserving domain & path)
        if (!headers_sent()) {
            http_response_code(200);
            header('Content-Type: text/html; charset=utf-8');
            header('Cache-Control: no-store, no-cache, must-revalidate');
            header('X-Traffic-Guard: render_safe');
        }

        if (is_file($this->safePagePath) && is_readable($this->safePagePath)) {
            readfile($this->safePagePath);
        } else {
            echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Welcome</title></head><body><h1>Store Maintenance &amp; Catalog Preview</h1></body></html>";
        }

        if ($exitOnBlock) {
            exit;
        }
        return false;
    }

    /**
     * Fail-open fallback response to ensure real visitors are never blocked on network errors.
     *
     * @return array<string, mixed>
     */
    private function failOpenDecision(string $reason): array
    {
        return [
            'allow'         => true,
            'action'        => 'pass',
            'target_url'    => '',
            'safe_template' => 'ecommerce',
            'fail_open'     => true,
            'error'         => $reason,
        ];
    }
}
