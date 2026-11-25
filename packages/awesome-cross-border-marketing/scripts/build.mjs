#!/usr/bin/env node
/**
 * README generator for awesome-cross-border-marketing.
 *
 * data/tools.json 是唯一数据源，templates/README.tpl.md 是固定文案模板。
 * 输出逐字节确定：不读时间、不依赖 locale、不重排条目（顺序由 data 决定）。
 *
 * Usage:
 *   node scripts/build.mjs            # 写 README.md
 *   node scripts/build.mjs --check    # 只对比，不一致 exit 1
 *   node scripts/build.mjs --stdout   # 打印到 stdout，不落盘
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = path.join(ROOT, 'data/tools.json');
const META_PATH = path.join(ROOT, 'data/meta.json');
const TPL_PATH = path.join(ROOT, 'templates/README.tpl.md');
const OUT_PATH = path.join(ROOT, 'README.md');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// 红线词表：数据里出现即构建失败。允许 ipcloak.ai 这类产品域名（前面有字母，不算独立词）。
const RED_LINES = [
  ['斗篷', /斗篷/],
  ['cloak', /(?<![a-z])cloak(?![a-z])/i],
  ['访问规则', /访问规则/],
  ['CAPI', /(?<![a-z])capi(?![a-z])/i],
  ['开口', /开口/],
  ['防封', /防封/],
  ['包过', /包过/],
  ['效果承诺', /效果承诺/],
  ['价格', /价格/],
];

function parseArgs(argv) {
  const modes = [];
  for (const arg of argv) {
    if (arg === '--check') modes.push('check');
    else if (arg === '--stdout') modes.push('stdout');
    else if (arg === '--help' || arg === '-h') modes.push('help');
    else {
      console.error(`build: unknown argument "${arg}"`);
      console.error('usage: node scripts/build.mjs [--check | --stdout]');
      process.exit(2);
    }
  }
  const unique = [...new Set(modes)];
  if (unique.includes('help')) {
    console.log('usage: node scripts/build.mjs [--check | --stdout]');
    process.exit(0);
  }
  if (unique.length > 1) {
    console.error(`build: --check and --stdout are mutually exclusive`);
    process.exit(2);
  }
  return unique[0] ?? 'write';
}

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} (${path.relative(ROOT, file)}): ${error.message}`);
  }
  try {
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validate(data, meta) {
  const errors = [];

  if (!isNonEmptyString(data.version) || !VERSION_RE.test(data.version)) {
    errors.push('data/tools.json: "version" must look like 1.0.0');
  }
  if (!isNonEmptyString(data.updatedAt) || !DATE_RE.test(data.updatedAt)) {
    errors.push('data/tools.json: "updatedAt" must be YYYY-MM-DD');
  } else if (Number.isNaN(Date.parse(`${data.updatedAt}T00:00:00Z`))) {
    errors.push(`data/tools.json: "updatedAt" is not a real date: ${data.updatedAt}`);
  }
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    errors.push('data/tools.json: "categories" must be a non-empty array');
    return errors;
  }

  if (meta.categoryOrder !== 'declared') {
    errors.push('data/meta.json: "categoryOrder" must be "declared" (README 分类顺序以 data 为准)');
  }
  if (meta.itemOrder !== 'curated' && meta.itemOrder !== 'alpha') {
    errors.push('data/meta.json: "itemOrder" must be "curated" or "alpha"');
  }
  const tagVocabulary = Array.isArray(meta.tagVocabulary) ? meta.tagVocabulary : [];
  if (!Array.isArray(meta.tagVocabulary)) {
    errors.push('data/meta.json: "tagVocabulary" must be an array of strings');
  }

  const seenIds = new Set();
  const seenUrls = new Map();
  let itemCount = 0;

  data.categories.forEach((category, categoryIndex) => {
    const where = `categories[${categoryIndex}]`;
    if (!isNonEmptyString(category.id) || !SLUG_RE.test(category.id)) {
      errors.push(`${where}: "id" must be a lower-kebab-case slug`);
    } else if (seenIds.has(category.id)) {
      errors.push(`${where}: duplicate category id "${category.id}"`);
    } else {
      seenIds.add(category.id);
    }
    if (!isNonEmptyString(category.titleEn)) errors.push(`${where}: "titleEn" is required`);
    if (!isNonEmptyString(category.titleZh)) errors.push(`${where}: "titleZh" is required`);

    if (!Array.isArray(category.items) || category.items.length === 0) {
      errors.push(`${where}: "items" must be a non-empty array`);
      return;
    }

    const items = [...category.items];
    if (meta.itemOrder === 'alpha') {
      // 按 name 的 Unicode 码点排序，避免 localeCompare 的跨环境差异。
      items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    items.forEach((item, itemIndex) => {
      itemCount += 1;
      const itemWhere = `${where}.items[${itemIndex}] (${item.name ?? '?'})`;
      if (!isNonEmptyString(item.name)) errors.push(`${itemWhere}: "name" is required`);
      if (!isNonEmptyString(item.url) || !/^https?:\/\/\S+$/.test(item.url)) {
        errors.push(`${itemWhere}: "url" must start with http:// or https://`);
      } else {
        const previous = seenUrls.get(item.url);
        if (previous) errors.push(`${itemWhere}: duplicate url ${item.url} (also ${previous})`);
        else seenUrls.set(item.url, item.name);
      }
      if (!isNonEmptyString(item.description)) errors.push(`${itemWhere}: "description" is required`);
      if ('maintainedByUs' in item && typeof item.maintainedByUs !== 'boolean') {
        errors.push(`${itemWhere}: "maintainedByUs" must be a boolean`);
      }
      if (item.maintainedByUs === true && itemIndex === 0) {
        errors.push(`${itemWhere}: maintainedByUs item must not be pinned first in its category`);
      }
      if ('tags' in item) {
        if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string')) {
          errors.push(`${itemWhere}: "tags" must be an array of strings`);
        } else {
          for (const tag of item.tags) {
            if (!tagVocabulary.includes(tag)) {
              errors.push(`${itemWhere}: tag "${tag}" is not in data/meta.json tagVocabulary`);
            }
          }
          if (new Set(item.tags).size !== item.tags.length) {
            errors.push(`${itemWhere}: "tags" contains duplicates`);
          }
        }
      }
    });

    // 同一分类内 name 唯一，避免 TOC/检索混淆。
    const names = new Set();
    for (const item of items) {
      if (names.has(item.name)) errors.push(`${where}: duplicate item name "${item.name}"`);
      names.add(item.name);
    }
  });

  if (itemCount === 0) errors.push('data/tools.json: no items found');
  return errors;
}

/** GitHub heading anchor: lowercase, drop punctuation, each space -> "-". */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

function renderItem(item) {
  const suffix = item.maintainedByUs === true ? ' *(maintained by us)*' : '';
  return `- [${item.name}](${item.url}) — ${item.description}${suffix}`;
}

function render(data, meta, template) {
  for (const placeholder of ['<!--TOC-->', '<!--CATEGORIES-->']) {
    const count = template.split(placeholder).length - 1;
    if (count !== 1) {
      throw new Error(`templates/README.tpl.md must contain ${placeholder} exactly once (found ${count})`);
    }
  }
  for (const heading of ['## Contributing', '## License']) {
    if (!template.includes(heading)) {
      throw new Error(`templates/README.tpl.md is missing required heading "${heading}"`);
    }
  }

  const categories = data.categories.map((category) => ({ ...category }));
  if (meta.itemOrder === 'alpha') {
    for (const category of categories) {
      category.items = [...category.items].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      if (category.items[0]?.maintainedByUs === true) {
        throw new Error(
          `category "${category.id}": alpha sorting would pin a maintainedByUs item first; rename or switch itemOrder to "curated"`,
        );
      }
    }
  }

  const tocLines = categories.map(
    (category) =>
      `- [${category.titleEn} / ${category.titleZh}](#${slugify(`${category.titleEn} / ${category.titleZh}`)})`,
  );
  tocLines.push('- [Contributing](#contributing)', '- [License](#license)');

  const blocks = categories.map(
    (category) =>
      `## ${category.titleEn} / ${category.titleZh}\n\n${category.items.map(renderItem).join('\n')}`,
  );

  const rendered = template
    .replace('<!--TOC-->', tocLines.join('\n'))
    .replace('<!--CATEGORIES-->', blocks.join('\n\n'))
    .replaceAll('{{VERSION}}', data.version)
    .replaceAll('{{UPDATED_AT}}', data.updatedAt)
    .replace(/\r\n/g, '\n');

  const output = `${rendered.replace(/\n+$/, '')}\n`;

  for (const [label, pattern] of RED_LINES) {
    const lines = output.split('\n');
    const hitIndex = lines.findIndex((line) => pattern.test(line));
    if (hitIndex !== -1) {
      throw new Error(`red-line term "${label}" found in generated README line ${hitIndex + 1}: ${lines[hitIndex]}`);
    }
  }

  return output;
}

function firstDiff(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < max; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? '<end of file>',
        actual: actualLines[index] ?? '<end of file>',
      };
    }
  }
  return { line: max, expected: '<unknown>', actual: '<unknown>' };
}

function short(text, limit = 120) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function main() {
  const mode = parseArgs(process.argv.slice(2));

  let data;
  let meta;
  let template;
  try {
    data = readJson(DATA_PATH, 'data/tools.json').value;
    meta = readJson(META_PATH, 'data/meta.json').value;
    template = readFileSync(TPL_PATH, 'utf8').replace(/\r\n/g, '\n');
  } catch (error) {
    console.error(`build: ${error.message}`);
    process.exit(1);
  }

  const errors = validate(data, meta);
  if (errors.length > 0) {
    console.error(`build: data validation failed (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  let output;
  try {
    output = render(data, meta, template);
  } catch (error) {
    console.error(`build: ${error.message}`);
    process.exit(1);
  }

  const itemCount = data.categories.reduce((total, category) => total + category.items.length, 0);
  const summary = `${data.categories.length} categories, ${itemCount} items, data v${data.version} (${data.updatedAt})`;

  if (mode === 'stdout') {
    process.stdout.write(output);
    return;
  }

  if (mode === 'check') {
    let actual;
    try {
      actual = readFileSync(OUT_PATH, 'utf8');
    } catch {
      console.error('build: README.md is missing; run "npm run build"');
      process.exit(1);
    }
    if (actual === output) {
      console.log(`build: README.md is up to date (${summary})`);
      return;
    }
    const diff = firstDiff(output, actual);
    console.error('build: README.md is out of date; run "npm run build"');
    console.error(`  first difference at line ${diff.line}`);
    console.error(`  expected: ${short(diff.expected)}`);
    console.error(`  actual:   ${short(diff.actual)}`);
    process.exit(1);
  }

  writeFileSync(OUT_PATH, output);
  console.log(`build: wrote README.md (${summary})`);
}

main();
