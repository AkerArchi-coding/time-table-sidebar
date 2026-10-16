// ============ 核心层：事项检查清单 / 子任务（M0 解耦） ============
// ev.checklist = [{ id, text, done }]，缺省 = 无子任务（旧数据零迁移）；纯函数，无 DOM 依赖。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  // 进度：无子任务返回 null；否则 { done, total }（事项行角标与表单共用口径）
  function checklistProgress(ev) {
    const ck = ev && ev.checklist;
    if (!Array.isArray(ck) || !ck.length) return null;
    return { done: ck.filter(c => c && c.done).length, total: ck.length };
  }

  // 归一化清单项：补齐 id / text / done，非数组返回 []（表单载入与移动端共用）
  function normalizeChecklist(items) {
    if (!Array.isArray(items)) return [];
    return items.map(c => ({ id: c.id || TTCore.ids.mkCkId(), text: String(c.text || ''), done: !!c.done }));
  }

  TTCore.checklist = { checklistProgress, normalizeChecklist };
})(typeof window !== 'undefined' ? window : globalThis);
