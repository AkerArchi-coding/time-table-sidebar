// ============ 核心层：事项标签（M0 解耦） ============
// 纯逻辑 + 只读 storage 汇总；无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  const TAG_MAX = 6;        // 单个事项最多标签数
  const TAG_LEN_MAX = 12;   // 单个标签最长字符

  // "工作, 重要，加班" → ['工作','重要','加班']（中英文逗号均支持，去空去重截断）
  function parseTags(str) {
    const seen = new Set();
    const out = [];
    for (let t of String(str || '').split(/[,，]/)) {
      t = t.trim().slice(0, TAG_LEN_MAX);
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      if (out.length >= TAG_MAX) break;
    }
    return out;
  }
  // 汇总所有事项出现过的标签（去重，中文排序）→ 供筛选 chips
  function collectTags() {
    const seen = new Set();
    for (const ev of TTCore.storage.loadEvents()) {
      for (const t of (ev.tags || [])) seen.add(t);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, 'zh'));
  }
  // 按标签筛选事项列表（tag 为空原样返回）
  function filterByTag(list, tag) {
    if (!tag) return list;
    return list.filter(ev => Array.isArray(ev.tags) && ev.tags.includes(tag));
  }

  TTCore.tags = { TAG_MAX, TAG_LEN_MAX, parseTags, collectTags, filterByTag };
})(typeof window !== 'undefined' ? window : globalThis);
