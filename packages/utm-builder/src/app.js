/**
 * src/app.js — DOM 层。
 *
 * 本文件只负责「读表单、写结果、绑定事件」，不含 URL 生成规则：
 * 所有 UTM 逻辑都来自构建时注入的 window.UTMCore（见 src/core.mjs）。
 *
 * 构建时它会被内联进 index.html 的 <script>；单独打开本文件不会执行。
 */
(function (global) {
  'use strict';

  var core = global.UTMCore;
  if (!core) {
    throw new Error('UTMCore 未加载：请通过 index.html 或构建产物运行。');
  }

  /** localStorage key；改名会让用户已有历史失效。 */
  const STORAGE_KEY = 'utm-builder:recent';
  /** 历史记录上限。 */
  const MAX_RECENT = 5;
  /** 结果区空状态文案，与初始 HTML 保持一致。 */
  const EMPTY_OUTPUT_TEXT = '填写上面的落地页 URL 和至少一个参数，这里会实时生成链接。';
  const NO_FIELDS_STATUS = '还没有填写参数，加一个 utm_source 就能生成。';

  /** 预设渠道：只填 source + medium，其它参数留给用户。 */
  const PRESETS = Object.freeze([
    { name: 'Facebook', source: 'facebook', medium: 'social' },
    { name: 'TikTok', source: 'tiktok', medium: 'social' },
    { name: 'Google', source: 'google', medium: 'cpc' },
    { name: 'WhatsApp', source: 'whatsapp', medium: 'social' },
    { name: 'Email', source: 'newsletter', medium: 'email' },
  ]);

  const els = {
    baseUrl: document.getElementById('baseUrl'),
    presets: document.getElementById('presets'),
    out: document.getElementById('out'),
    status: document.getElementById('status'),
    copy: document.getElementById('copy'),
    reset: document.getElementById('reset'),
    recent: document.getElementById('recent'),
    recentEmpty: document.getElementById('recentEmpty'),
    clearRecent: document.getElementById('clearRecent'),
  };

  /** 表单里所有 utm_* 输入框，按 DOM 顺序（即 UTM_KEYS 顺序）。 */
  function paramInputs() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-key]'));
  }

  /** 读表单，空值不进入结果，保证不会生成 `utm_source=`。 */
  function readFields() {
    const fields = {};
    paramInputs().forEach(function (input) {
      const value = input.value.trim();
      if (value) fields[input.getAttribute('data-key')] = value;
    });
    return fields;
  }

  function fillFields(fields) {
    paramInputs().forEach(function (input) {
      input.value = fields[input.getAttribute('data-key')] || '';
    });
  }

  /**
   * 调核心生成 URL，并翻译成 UI 需要的 {url, status, tone}。
   * tone: '' 普通 / 'ok' 成功 / 'err' 错误。
   */
  function build() {
    const result = core.buildUtmUrl(els.baseUrl.value, readFields());

    if (result.empty) {
      return { url: '', status: '', tone: '' };
    }
    if (!result.ok) {
      return { url: '', status: result.error, tone: 'err' };
    }

    let status = '';
    let tone = '';
    if (!result.fieldCount) {
      status = NO_FIELDS_STATUS;
    } else {
      status = '已生成 · ' + result.fieldCount + ' 个参数';
      tone = 'ok';
      if (result.removedUtmCount) {
        status += ' · 已覆盖原有 ' + result.removedUtmCount + ' 个 utm_* 参数';
      }
    }

    return { url: result.url, status: status, tone: tone };
  }

  function render() {
    const result = build();
    const hasUrl = Boolean(result.url);

    els.out.textContent = hasUrl ? result.url : EMPTY_OUTPUT_TEXT;
    els.out.classList.toggle('empty', !hasUrl);
    els.copy.disabled = !hasUrl;

    els.status.textContent = result.status;
    els.status.className = 'status' + (result.tone ? ' ' + result.tone : '');

    els.baseUrl.classList.toggle('invalid', result.tone === 'err');
  }

  /** 优先用异步剪贴板 API；file:// 等非安全上下文降级到 execCommand。 */
  function copyText(text) {
    if (navigator.clipboard && global.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(area);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  /* ---------- 最近记录 ---------- */

  function loadRecent() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* 隐私模式下写入失败时静默忽略 */
    }
  }

  function remember(url) {
    const fields = readFields();
    const base = els.baseUrl.value.trim();
    const list = loadRecent().filter(function (item) {
      return item.url !== url;
    });
    list.unshift({ url: url, base: base, fields: fields });
    saveRecent(list.slice(0, MAX_RECENT));
    renderRecent();
  }

  function renderRecent() {
    const list = loadRecent();
    els.recent.textContent = '';

    list.forEach(function (item) {
      const li = document.createElement('li');

      const span = document.createElement('span');
      span.className = 'url';
      span.textContent = item.url;
      span.title = item.url;

      const fill = document.createElement('button');
      fill.className = 'btn ghost sm';
      fill.type = 'button';
      fill.textContent = '填入';
      fill.addEventListener('click', function () {
        els.baseUrl.value = item.base || item.url.split('?')[0];
        fillFields(item.fields || {});
        render();
      });

      const copy = document.createElement('button');
      copy.className = 'btn ghost sm';
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', function () {
        copyText(item.url).then(function () {
          els.status.textContent = '已复制最近记录';
          els.status.className = 'status ok';
        });
      });

      li.appendChild(span);
      li.appendChild(fill);
      li.appendChild(copy);
      els.recent.appendChild(li);
    });

    els.recentEmpty.hidden = list.length > 0;
  }

  /* ---------- 预设渠道 ---------- */

  function renderPresets() {
    PRESETS.forEach(function (preset) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.type = 'button';
      btn.textContent = preset.name;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function () {
        document.getElementById('f-utm_source').value = preset.source;
        document.getElementById('f-utm_medium').value = preset.medium;
        Array.prototype.forEach.call(
          els.presets.querySelectorAll('.chip'),
          function (chip) {
            chip.setAttribute('aria-pressed', 'false');
          }
        );
        btn.setAttribute('aria-pressed', 'true');
        render();
      });
      els.presets.appendChild(btn);
    });
  }

  /* ---------- 事件绑定 ---------- */

  els.baseUrl.addEventListener('input', render);
  paramInputs().forEach(function (input) {
    input.addEventListener('input', render);
  });

  els.copy.addEventListener('click', function () {
    const url = build().url;
    if (!url) return;
    copyText(url)
      .then(function () {
        els.status.textContent = '已复制到剪贴板';
        els.status.className = 'status ok';
        remember(url);
      })
      .catch(function () {
        els.status.textContent = '复制失败，请手动选中链接复制。';
        els.status.className = 'status err';
      });
  });

  els.reset.addEventListener('click', function () {
    els.baseUrl.value = '';
    fillFields({});
    Array.prototype.forEach.call(
      els.presets.querySelectorAll('.chip'),
      function (chip) {
        chip.setAttribute('aria-pressed', 'false');
      }
    );
    render();
    els.baseUrl.focus();
  });

  els.clearRecent.addEventListener('click', function () {
    saveRecent([]);
    renderRecent();
  });

  renderPresets();
  renderRecent();
  render();
})(window);
