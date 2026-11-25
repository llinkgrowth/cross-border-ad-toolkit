# Contributing to scrm-webhook-attribution-kit

Thank you for contributing to open-source chat lead attribution and human-in-the-loop broadcast queue safety!

## Core Engineering Rules

1. **Zero External Dependencies**: All runtime logic in `src/attribution-kit.mjs`, `cli.mjs`, and `index.html` must rely exclusively on built-in Node.js (`>=18`, `node:crypto`) and standard browser APIs.
2. **Never Auto-Retry Unknown Delivery States**: Any changes to `SafeBroadcastQueue` must preserve the core safety invariant—when a message send attempt returns `status = "unknown"`, it must transition to `PENDING_MANUAL_REVIEW` and disallow automatic retries.
3. **Test Coverage**: Add unit tests in `test/scrm-kit.test.mjs` for new RefCode formats, webhook headers, or queue transitions.

## Running Checks Locally

```bash
npm test
npm run check
```
