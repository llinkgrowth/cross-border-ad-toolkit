# Contributing to pixel-event-debugger

Thank you for helping improve cross-platform ad pixel event standardization and local debugging!

## Core Principles

1. **Zero Runtime Dependencies**: Keep `src/pixel-bridge.mjs`, `cli.mjs`, and `index.html` 100% dependency-free using standard Node.js (`>=18`) and browser Web APIs.
2. **Deterministic & Testable**: Every new event mapping, click attribution parser rule, or payload lint rule must include unit tests in `test/pixel.test.mjs`.
3. **Offline First**: `index.html` must work out-of-the-box via `file://` without external CDNs or network calls.

## Development Workflow

```bash
# Run the test suite (25+ assertions)
npm test

# Run CLI smoke checks
npm run check
```

## Submitting Pull Requests

- Ensure `node --test` passes with 0 failures.
- If adding a new platform standard event or parameter rule, cite the official platform documentation (Meta Pixel, TikTok Pixel, or Google Analytics 4).
