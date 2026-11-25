#!/usr/bin/env node
/**
 * Link checker for awesome-cross-border-marketing.
 *
 * - 读取 data/tools.json（唯一数据源）
 * - 并发 5，每个请求 10s 超时
 * - HEAD 失败（网络错误 / 4xx / 5xx）时回退 GET
 * - 403 / 429 标记 blocked，不算 broken（很多站会拦脚本）
 * - `{ORG}` 这类未展开占位符标记 skipped，不算 broken
 * - 有 broken 时 exit 1
 *
 * Usage:
 *   node scripts/check-links.mjs                 # 全量检查
 *   node scripts/check-links.mjs --limit 8       # 只查前 8 条
 *   node scripts/check-links.mjs --json          # 机器可读输出
 *   node scripts/check-links.mjs --concurrency 5 --timeout 10000
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data/tools.json');

const DEFAULTS = { limit: null, concurrency: 5, timeoutMs: 10_000 };
const BLOCKED_STATUSES = new Set([403, 429]);
const PLACEHOLDER_RE = /\{[A-Za-z_]+\}/;
const USER_AGENT =
  'awesome-cross-border-marketing-link-checker/1.0 (+https://github.com/; link audit bot)';

function usage() {
  console.log(`usage: node scripts/check-links.mjs [options]

  --limit <n>         只检查前 n 条（默认全部）
  --concurrency <n>   并发数（默认 5）
  --timeout <ms>      单请求超时（默认 10000）
  --json              输出 JSON
  -h, --help          显示帮助`);
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`check-links: ${flag} expects a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);

    const nextValue = (name) => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) {
        console.error(`check-links: ${name} requires a value`);
        process.exit(2);
      }
      return argv[index];
    };

    if (flag === '--json') options.json = true;
    else if (flag === '--limit') options.limit = parsePositiveInt(nextValue('--limit'), '--limit');
    else if (flag === '--concurrency') {
      options.concurrency = parsePositiveInt(nextValue('--concurrency'), '--concurrency');
    } else if (flag === '--timeout') {
      options.timeoutMs = parsePositiveInt(nextValue('--timeout'), '--timeout');
    } else if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`check-links: unknown argument "${arg}"`);
      usage();
      process.exit(2);
    }
  }
  return options;
}

function readData() {
  let raw;
  try {
    raw = readFileSync(DATA_PATH, 'utf8');
  } catch (error) {
    console.error(`check-links: cannot read data/tools.json: ${error.message}`);
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error(`check-links: invalid JSON in data/tools.json: ${error.message}`);
    process.exit(2);
  }
  if (!Array.isArray(data.categories)) {
    console.error('check-links: data/tools.json has no "categories" array');
    process.exit(2);
  }
  return data;
}

function describeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return error?.cause?.code ?? error?.code ?? error?.message ?? 'network error';
}

async function request(url, method, timeoutMs) {
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    // 只需要状态码，主动丢弃 body，避免占着连接。
    if (method === 'GET' && response.body) {
      await response.body.cancel().catch(() => {});
    }
    return { ok: true, status: response.status, finalUrl: response.url, redirected: response.redirected };
  } catch (error) {
    return { ok: false, status: null, error: describeError(error) };
  }
}

async function checkOne(item, timeoutMs) {
  const url = item.url ?? '';
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'skipped', httpStatus: null, method: null, reason: 'invalid or non-http url' };
  }
  if (PLACEHOLDER_RE.test(url)) {
    return {
      status: 'skipped',
      httpStatus: null,
      method: null,
      reason: 'placeholder URL (unexpanded {ORG}); replace before release',
    };
  }

  let result = await request(url, 'HEAD', timeoutMs);
  let method = 'HEAD';

  // HEAD 失败（网络错误 / 4xx / 5xx）回退 GET；不少站点对 HEAD 返回 405/403。
  if (!result.ok || result.status >= 400) {
    method = 'GET';
    result = await request(url, 'GET', timeoutMs);
  }

  if (!result.ok) {
    return { status: 'broken', httpStatus: null, method, reason: result.error };
  }

  const status = result.status;
  if (status >= 200 && status < 300) {
    return {
      status: result.redirected ? 'redirect' : 'ok',
      httpStatus: status,
      method,
      finalUrl: result.redirected ? result.finalUrl : undefined,
      reason: result.redirected ? 'followed redirect' : undefined,
    };
  }
  if (BLOCKED_STATUSES.has(status)) {
    return {
      status: 'blocked',
      httpStatus: status,
      method,
      reason: `HTTP ${status} (bot protection; not counted as broken)`,
    };
  }
  return { status: 'broken', httpStatus: status, method, reason: `HTTP ${status}` };
}

async function runPool(tasks, worker, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await worker(tasks[index], index);
    }
  }
  const lanes = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

function flattenItems(data) {
  const tasks = [];
  data.categories.forEach((category) => {
    if (!Array.isArray(category.items)) return;
    category.items.forEach((item, index) => {
      tasks.push({ categoryId: category.id, index, ...item });
    });
  });
  return tasks;
}

function formatResult(result) {
  const status = `[${result.status}]`.padEnd(11);
  const code = result.httpStatus === null ? '---' : String(result.httpStatus);
  const target = result.finalUrl ? `${result.url} -> ${result.finalUrl}` : result.url;
  const reason = result.reason ? ` (${result.reason})` : '';
  return `${status} ${code}  ${target}${reason}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = readData();
  const allTasks = flattenItems(data);
  const selected = options.limit === null ? allTasks : allTasks.slice(0, options.limit);

  const results = await runPool(
    selected,
    async (task) => ({
      category: task.categoryId,
      name: task.name,
      url: task.url,
      ...(await checkOne(task, options.timeoutMs)),
    }),
    options.concurrency,
  );

  const summary = {
    total: allTasks.length,
    selected: selected.length,
    checked: results.filter((result) => result.status !== 'skipped').length,
    ok: results.filter((result) => result.status === 'ok').length,
    redirect: results.filter((result) => result.status === 'redirect').length,
    broken: results.filter((result) => result.status === 'broken').length,
    blocked: results.filter((result) => result.status === 'blocked').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dataVersion: data.version,
          dataUpdatedAt: data.updatedAt,
          options: {
            limit: options.limit,
            concurrency: options.concurrency,
            timeoutMs: options.timeoutMs,
          },
          summary,
          results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Link check: ${summary.selected} of ${summary.total} selected (concurrency ${options.concurrency}, timeout ${options.timeoutMs}ms)\n`,
    );
    for (const result of results) console.log(formatResult(result));
    console.log(
      `\nSummary: ${summary.checked} checked · ok ${summary.ok} · redirect ${summary.redirect} · blocked ${summary.blocked} · broken ${summary.broken} · skipped ${summary.skipped}`,
    );
    if (summary.broken > 0) {
      console.log(`\n${summary.broken} broken link${summary.broken === 1 ? '' : 's'} found. Fix data/tools.json before release.`);
    }
  }

  if (summary.broken > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`check-links: unexpected error: ${error?.stack ?? error}`);
  process.exit(2);
});
