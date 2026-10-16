// ============ 核心层：本地存储与业务数据读写（M0 解耦） ============
// 平台无关：仅依赖全局 localStorage（浏览器/WebView 均提供）。不依赖 DOM / Electron。
// 平台边界通过 configure / registerDerivedCache 注入：
//   toast          —— 存储写入失败的可见化提示（桌面为 showToast）
//   derivedCache   —— 视图派生缓存（桌面为按日索引 dayIndex）的失效回调
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  // ---------- 通用 localStorage 读写 ----------
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); return null; } catch (e) { return e; }
  }
  function readJSON(key, fallback) {
    try {
      const raw = safeGet(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }
  function writeJSON(key, val) {
    return safeSet(key, JSON.stringify(val));
  }

  // ---------- 模块级缓存（写穿式；读多写少） ----------
  let eventsCache = null;
  let projectsCache = null;
  let recurDoneCache = null;
  let storageWarnedAt = 0;

  let toastFn = null;
  let derivedCacheFn = null;

  function configure(opts) {
    if (opts && typeof opts.toast === 'function') toastFn = opts.toast;
  }
  function registerDerivedCache(fn) {
    derivedCacheFn = typeof fn === 'function' ? fn : null;
  }
  // 视图派生缓存失效（与业务缓存同生共死）
  function notifyDerivedInvalid() {
    if (derivedCacheFn) derivedCacheFn();
  }
  // 清空全部业务缓存（直写 localStorage 后调用）
  function invalidate() {
    eventsCache = null;
    projectsCache = null;
    recurDoneCache = null;
    notifyDerivedInvalid();
  }

  // localStorage 写入失败可见化（P6.3）：10s 节流，避免连续弹
  function notifyStorageFail(err) {
    const now = Date.now();
    if (now - storageWarnedAt < 10000) return;
    storageWarnedAt = now;
    if (toastFn) toastFn('本地存储写入失败：' + (err && err.message || '配额可能已满') + '，本次修改可能不会被保存', 'error');
  }

  // ---------- 事项（Task） ----------
  function loadEvents() {
    if (eventsCache) return eventsCache;
    try {
      const list = JSON.parse(localStorage.getItem('events') || '[]');
      const migrate = TTCore.models.migrateEvent;
      for (const ev of list) migrate(ev);
      eventsCache = list;
      return list;
    } catch { eventsCache = []; return eventsCache; }
  }
  function saveEvents(list) {
    eventsCache = Array.isArray(list) ? list : [];
    notifyDerivedInvalid();               // 派生索引随写失效
    const err = safeSet('events', JSON.stringify(eventsCache));
    if (err) notifyStorageFail(err);
  }

  // ---------- 项目（Project） ----------
  function loadProjects() {
    if (projectsCache) return projectsCache;
    try {
      const list = JSON.parse(localStorage.getItem('projects') || '[]');
      const migrate = TTCore.models.migrateProject;
      for (const p of list) migrate(p);
      projectsCache = list;
      return list;
    } catch { projectsCache = []; return projectsCache; }
  }
  function saveProjects(list) {
    projectsCache = Array.isArray(list) ? list : [];
    const err = safeSet('projects', JSON.stringify(projectsCache));
    if (err) notifyStorageFail(err);
  }

  // ---------- 重复事项完成态（按日 override，key = 模板id|日期） ----------
  function loadRecurDone() {
    if (recurDoneCache) return recurDoneCache;
    recurDoneCache = readJSON('recurDone', {}) || {};
    return recurDoneCache;
  }
  function recurDoneGet(evId, key) {
    return !!loadRecurDone()[evId + '|' + key];
  }
  function recurDoneSet(evId, key, val) {
    const map = loadRecurDone();
    if (val) map[evId + '|' + key] = true;
    else delete map[evId + '|' + key];
    recurDoneCache = map;
    notifyDerivedInvalid();               // 投影完成态变化 → 派生索引失效（P6.3）
    const err = safeSet('recurDone', JSON.stringify(map));
    if (err) notifyStorageFail(err);
  }

  TTCore.storage = {
    safeGet, safeSet, readJSON, writeJSON,
    configure, registerDerivedCache, invalidate, notifyStorageFail,
    loadEvents, saveEvents,
    loadProjects, saveProjects,
    loadRecurDone, recurDoneGet, recurDoneSet
  };
})(typeof window !== 'undefined' ? window : globalThis);
