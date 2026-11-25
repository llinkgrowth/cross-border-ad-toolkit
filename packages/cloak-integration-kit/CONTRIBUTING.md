# Contributing to Cloak Integration Kit

Thank you for your interest in contributing to `@ipcloak/cloak-integration-kit`! This repository provides open-source client integration SDKs, PHP installers, WordPress plugins, Cloudflare Worker edge gateways, and a local contract mock server for visitor access control and safe-page fallback routing.

## Scope & Architecture Boundaries

To keep this kit lightweight, auditable, and strictly zero-dependency:
1. **Client-Side & Edge Adapters Only**: All modules in this repository implement the **Visitor Context Extraction -> Decision API Request -> Action Execution (Pass / 302 Redirect / Safe Page Render / 404) -> Fail-Open Fallback** lifecycle.
2. **Contract-Only Local Mock Server**: `mock-server/server.mjs` contains only 3 deterministic demo rules for local integration verification and CI testing. Production multi-dimensional risk evaluation is handled remotely via the Decision API contract.
3. **Zero Third-Party Dependencies**: Node.js scripts and tests must run strictly on built-in Node.js >= 18 modules (`node:http`, `node:test`, `node:assert`, `node:fs`, `node:path`). PHP integrations must run on standard PHP >= 7.4 (`ext-curl`, `ext-json`).

## Development Workflow

1. Clone the repository and verify your Node.js version (`node -v` >= 18).
2. Run the automated test suite:
   ```bash
   npm test
   ```
3. Test the CLI simulator:
   ```bash
   node cli.mjs simulate --ua "curl/8.0" --ip "203.0.113.5"
   ```
4. If modifying PHP files (`php-installer/*.php` or `wordpress-plugin/**/*.php`), ensure clean syntax (`php -l <file>`).

## Pull Request Checklist

- [ ] Zero external `dependencies` or `devDependencies` added to `package.json`.
- [ ] All unit and end-to-end mock tests pass via `node --test`.
- [ ] Fail-open behavior is preserved when the upstream Decision API times out or returns HTTP 5xx.
- [ ] Documentation in `README.md` is updated if the JSON request/response contract or CLI flags change.
