// ============ 核心层：事项模板（P5.3 / M0 解耦） ============
// localStorage: eventTemplates = [{id, title, time, category, urgency, recur, tags, description, createdAt}]
// 日期不入模板（应用时默认今天）；仅进三档备份（BUSINESS_KEYS），不进局域网同步快照。
// 纯数据操作，无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  function loadEventTemplates() {
    try {
      const arr = JSON.parse(localStorage.getItem('eventTemplates') || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveEventTemplates(arr) {
    localStorage.setItem('eventTemplates', JSON.stringify(arr));
  }
  // 事项存为模板：同 title+time 视为重复（跳过）；返回 'saved' | 'dup'
  function saveEventAsTemplate(ev) {
    const list = loadEventTemplates();
    const t = String(ev.title || '');
    const tm = String(ev.time || '');
    if (list.some(x => x.title === t && String(x.time || '') === tm)) return 'dup';
    list.unshift({
      id: TTCore.ids.mkTplId(),
      title: t, time: tm,
      category: ev.category || 'work',
      urgency: ev.urgency || 'normal',
      recur: ev.recur || null,
      tags: Array.isArray(ev.tags) ? ev.tags.slice() : [],
      description: String(ev.description || ''),
      createdAt: new Date().toISOString()
    });
    saveEventTemplates(list);
    return 'saved';
  }
  function deleteEventTemplate(id) {
    saveEventTemplates(loadEventTemplates().filter(t => t.id !== id));
  }

  TTCore.templates = { loadEventTemplates, saveEventTemplates, saveEventAsTemplate, deleteEventTemplate };
})(typeof window !== 'undefined' ? window : globalThis);
