<?php
/**
 * Plugin Name:       IpCloak Traffic Guard & Safe Page Fallback
 * Plugin URI:        https://github.com/ipcloak/cloak-integration-kit
 * Description:       Lightweight WordPress & WooCommerce integration for Visitor Access Rules, Bot/Crawler filtering, and fail-open Safe Page fallback via the IpCloak Decision API.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            IpCloak Engineering
 * License:           MIT
 * Text Domain:       ipcloak-traffic-guard
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

final class IpCloak_Traffic_Guard_Plugin
{
    private const OPTION_KEY = 'ipcloak_traffic_guard_settings';

    public static function init(): void
    {
        $instance = new self();
        add_action('admin_menu', [$instance, 'registerSettingsMenu']);
        add_action('admin_init', [$instance, 'registerSettingsFields']);
        add_action('template_redirect', [$instance, 'handleTemplateRedirect'], 1);
    }

    /**
     * Retrieve merged plugin settings with safe defaults.
     *
     * @return array<string, mixed>
     */
    public function getSettings(): array
    {
        $defaults = [
            'enabled'          => 1,
            'endpoint'         => 'http://127.0.0.1:8787/v1/decision',
            'store_token'      => 'demo_store_token_local',
            'timeout_ms'       => 800,
            'bypass_logged_in' => 1,
            'protect_posts'    => 1,
            'protect_pages'    => 1,
            'protect_products' => 1,
        ];

        $saved = get_option(self::OPTION_KEY, []);
        if (!is_array($saved)) {
            $saved = [];
        }

        return array_merge($defaults, $saved);
    }

    public function registerSettingsMenu(): void
    {
        add_options_page(
            'IpCloak Traffic Guard',
            'Traffic Guard',
            'manage_options',
            'ipcloak-traffic-guard',
            [$this, 'renderSettingsPage']
        );
    }

    public function registerSettingsFields(): void
    {
        register_setting(
            'ipcloak_traffic_guard_group',
            self::OPTION_KEY,
            [
                'sanitize_callback' => [$this, 'sanitizeSettings'],
            ]
        );
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function sanitizeSettings(array $input): array
    {
        return [
            'enabled'          => !empty($input['enabled']) ? 1 : 0,
            'endpoint'         => esc_url_raw(trim((string) ($input['endpoint'] ?? 'http://127.0.0.1:8787/v1/decision'))),
            'store_token'      => sanitize_text_field((string) ($input['store_token'] ?? 'demo_store_token_local')),
            'timeout_ms'       => max(100, min(5000, (int) ($input['timeout_ms'] ?? 800))),
            'bypass_logged_in' => !empty($input['bypass_logged_in']) ? 1 : 0,
            'protect_posts'    => !empty($input['protect_posts']) ? 1 : 0,
            'protect_pages'    => !empty($input['protect_pages']) ? 1 : 0,
            'protect_products' => !empty($input['protect_products']) ? 1 : 0,
        ];
    }

    /**
     * Main front-end hook attached to `template_redirect`.
     */
    public function handleTemplateRedirect(): void
    {
        if (is_admin() || wp_doing_ajax() || wp_doing_cron()) {
            return;
        }

        $settings = $this->getSettings();
        if (empty($settings['enabled'])) {
            return;
        }

        // Bypass administrators and authenticated users when configured
        if (!empty($settings['bypass_logged_in']) && (is_user_logged_in() || current_user_can('manage_options'))) {
            return;
        }

        if (!$this->isCurrentScopeProtected($settings)) {
            return;
        }

        $payload = $this->buildVisitorPayload($settings);
        $decision = $this->requestDecision($payload, $settings);

        // Fail-open or explicit allow: continue rendering normal WordPress template
        if (!empty($decision['allow']) || ($decision['action'] ?? 'pass') === 'pass') {
            if (!headers_sent()) {
                header('X-Traffic-Guard: pass');
            }
            return;
        }

        $action = (string) ($decision['action'] ?? 'render_safe');

        if ($action === 'redirect' && !empty($decision['target_url'])) {
            nocache_headers();
            wp_redirect(esc_url_raw((string) $decision['target_url']), 302);
            exit;
        }

        if ($action === 'not_found') {
            global $wp_query;
            if ($wp_query instanceof \WP_Query) {
                $wp_query->set_404();
            }
            status_header(404);
            nocache_headers();
            echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>';
            exit;
        }

        // Default action: render_safe (render clean compliant safe HTML keeping URL unchanged)
        status_header(200);
        nocache_headers();
        header('Content-Type: text/html; charset=utf-8');
        header('X-Traffic-Guard: render_safe');
        echo $this->getSafePageHtml();
        exit;
    }

    /**
     * Check whether the current singular view matches protected scopes (Post / Page / WooCommerce Product).
     *
     * @param array<string, mixed> $settings
     */
    private function isCurrentScopeProtected(array $settings): bool
    {
        if (function_exists('is_product') && is_product()) {
            return !empty($settings['protect_products']);
        }
        if (is_Singular('product')) {
            return !empty($settings['protect_products']);
        }
        if (is_single()) {
            return !empty($settings['protect_posts']);
        }
        if (is_page() || is_front_page()) {
            return !empty($settings['protect_pages']);
        }
        return true;
    }

    /**
     * Extract client IP and construct Decision API payload.
     *
     * @param array<string, mixed> $settings
     * @return array<string, mixed>
     */
    private function buildVisitorPayload(array $settings): array
    {
        $ip = '127.0.0.1';
        $headerKeys = ['HTTP_CF_CONNECTING_IP', 'HTTP_TRUE_CLIENT_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'];
        foreach ($headerKeys as $key) {
            if (!empty($_SERVER[$key]) && is_string($_SERVER[$key])) {
                $parts = explode(',', $_SERVER[$key]);
                $candidate = trim($parts[0]);
                if ($candidate !== '') {
                    $ip = $candidate;
                    break;
                }
            }
        }

        $clickIds = [];
        foreach (['gclid', 'fbclid', 'ttclid', 'msclkid', 'utm_source', 'utm_campaign'] as $param) {
            if (!empty($_GET[$param]) && is_scalar($_GET[$param])) {
                $clickIds[$param] = sanitize_text_field((string) $_GET[$param]);
            }
        }

        $scheme = is_ssl() ? 'https' : 'http';
        $host   = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
        $uri    = (string) ($_SERVER['REQUEST_URI'] ?? '/');

        return [
            'store_token' => (string) $settings['store_token'],
            'visitor'     => [
                'ip'              => $ip,
                'ua'              => (string) ($_SERVER['HTTP_USER_AGENT'] ?? ''),
                'accept_language' => (string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''),
                'referer'         => (string) ($_SERVER['HTTP_REFERER'] ?? ''),
                'sec_ch_ua'       => (string) ($_SERVER['HTTP_SEC_CH_UA'] ?? ''),
                'url'             => $scheme . '://' . $host . $uri,
                'click_ids'       => $clickIds,
            ],
        ];
    }

    /**
     * Send HTTP POST via wp_remote_post with fail-open fallback.
     *
     * @param array<string, mixed> $payload
     * @param array<string, mixed> $settings
     * @return array<string, mixed>
     */
    private function requestDecision(array $payload, array $settings): array
    {
        $timeoutSeconds = max(0.2, ((int) $settings['timeout_ms']) / 1000.0);

        $response = wp_remote_post((string) $settings['endpoint'], [
            'timeout' => $timeoutSeconds,
            'headers' => [
                'Content-Type'   => 'application/json',
                'Accept'         => 'application/json',
                'X-Cloak-Client' => 'wp-plugin/1.0.0',
            ],
            'body'    => wp_json_encode($payload),
        ]);

        if (is_wp_error($response)) {
            return ['allow' => true, 'action' => 'pass', 'fail_open' => true];
        }

        $statusCode = (int) wp_remote_retrieve_response_code($response);
        if ($statusCode < 200 || $statusCode >= 300) {
            return ['allow' => true, 'action' => 'pass', 'fail_open' => true];
        }

        $body = wp_remote_retrieve_body($response);
        $decoded = json_decode((string) $body, true);
        if (!is_array($decoded) || !array_key_exists('allow', $decoded)) {
            return ['allow' => true, 'action' => 'pass', 'fail_open' => true];
        }

        return $decoded;
    }

    private function getSafePageHtml(): string
    {
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Everyday Studio Essentials</title></head><body style="font-family:system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1.5rem;color:#0f172a;"><h1>Everyday Studio Essentials</h1><p>Curated minimalist workspace accessories with carbon-neutral delivery and 30-day returns.</p></body></html>';
    }

    /**
     * Render WordPress Admin Settings Page.
     */
    public function renderSettingsPage(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $s = $this->getSettings();
        $opt = self::OPTION_KEY;
        ?>
        <div class="wrap">
            <h1>IpCloak Traffic Guard Settings</h1>
            <p>Configure your Decision API Endpoint, Store Token, Fail-Open timeout, and protected content types.</p>
            <form method="post" action="options.php">
                <?php settings_fields('ipcloak_traffic_guard_group'); ?>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row">Enable Traffic Guard</th>
                        <td>
                            <label>
                                <input type="checkbox" name="<?php echo esc_attr($opt); ?>[enabled]" value="1" <?php checked(1, (int) $s['enabled']); ?> />
                                Enable visitor rule evaluation on front-end requests
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="ipcloak_endpoint">Decision API Endpoint</label></th>
                        <td>
                            <input type="url" id="ipcloak_endpoint" class="regular-text" name="<?php echo esc_attr($opt); ?>[endpoint]" value="<?php echo esc_attr((string) $s['endpoint']); ?>" />
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="ipcloak_token">Store Token</label></th>
                        <td>
                            <input type="text" id="ipcloak_token" class="regular-text" name="<?php echo esc_attr($opt); ?>[store_token]" value="<?php echo esc_attr((string) $s['store_token']); ?>" />
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="ipcloak_timeout">Fail-Open Timeout (ms)</label></th>
                        <td>
                            <input type="number" id="ipcloak_timeout" class="small-text" min="100" max="5000" name="<?php echo esc_attr($opt); ?>[timeout_ms]" value="<?php echo esc_attr((string) $s['timeout_ms']); ?>" />
                            <p class="description">Requests exceeding this latency automatically fail-open (allow visitor).</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Administrator &amp; Login Bypass</th>
                        <td>
                            <label>
                                <input type="checkbox" name="<?php echo esc_attr($opt); ?>[bypass_logged_in]" value="1" <?php checked(1, (int) $s['bypass_logged_in']); ?> />
                                Skip Traffic Guard checks for logged-in users and administrators
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Protected Content Scopes</th>
                        <td>
                            <label><input type="checkbox" name="<?php echo esc_attr($opt); ?>[protect_posts]" value="1" <?php checked(1, (int) $s['protect_posts']); ?> /> Posts</label><br/>
                            <label><input type="checkbox" name="<?php echo esc_attr($opt); ?>[protect_pages]" value="1" <?php checked(1, (int) $s['protect_pages']); ?> /> Pages</label><br/>
                            <label><input type="checkbox" name="<?php echo esc_attr($opt); ?>[protect_products]" value="1" <?php checked(1, (int) $s['protect_products']); ?> /> WooCommerce Products</label>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Traffic Guard Settings'); ?>
            </form>
        </div>
        <?php
    }
}

IpCloak_Traffic_Guard_Plugin::init();
