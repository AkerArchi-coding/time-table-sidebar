// ============ 核心层：事项写操作（M0 解耦） ============
// 只做数据读写与归一化，返回足够信息；视图副作用（render / bumpProjectRevision / toast）
// 由平台层（桌面 app.js / 移动端）承接。无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const { eventStart, eventEnd, parseDateKey, addDaysKey, dateKey } = TTCore.dates;

  // 新建事项（写库并返回新对象；不触发渲染）
  function createEvent(fields) {
    fields = fields || {};
    const all = TTCore.storage.loadEvents();
    const ev = {
      id: TTCore.ids.mkEventId(),
      date: fields.startDate || '',     // 与 startDate 同步，兼容旧逻辑
      startDate: fields.startDate || '',
      endDate: fields.endDate || fields.startDate || '',
      time: fields.time || '',
      title: fields.title,
      done: false,
      category: fields.category || 'work',
      urgency: fields.urgency || 'normal',
      projectId: fields.projectId || null,
      description: fields.description || '',
      recur: fields.recur || null,    // 重复规则（P3.2）：null = 不重复
      tags: Array.isArray(fields.tags) ? fields.tags : [],  // 标签（P3.3）
      ...(Array.isArray(fields.checklist) && fields.checklist.length ? { checklist: fields.checklist } : {}),  // 子任务（P6.2）：空则不占字段
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    all.push(ev);
    TTCore.storage.saveEvents(all);
    return ev;
  }

  // 编辑事项（日期区间/分类/紧急程度/项目等）；返回 { ok, oldPid }，由平台层决定版本号递增
  function updateEvent(id, fields) {
    fields = fields || {};
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id);
    if (!ev) return { ok: false, oldPid: null };
    const oldPid = ev.projectId;
    if (fields.startDate !== undefined) {
      ev.startDate = fields.startDate;
      ev.endDate = fields.endDate || fields.startDate;
      ev.date = fields.startDate;
    }
    for (const k of ['time', 'title', 'category', 'urgency', 'projectId', 'phaseId', 'remindAhead', 'recur', 'tags', 'checklist']) {
      if (fields[k] !== undefined) ev[k] = fields[k];
    }
    ev.updatedAt = new Date().toISOString();
    TTCore.storage.saveEvents(all);
    return { ok: true, oldPid };
  }

  // 删除事项（虚拟投影 id 解析为模板；写库移除）；返回 { id, ev }（ev 为删除前对象，未找到为 null）
  function removeEvent(id) {
    if (id.includes('@')) id = id.slice(0, id.lastIndexOf('@'));
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id) || null;
    TTCore.storage.saveEvents(all.filter(e => e.id !== id));
    return { id, ev };
  }

  // 切换完成态；虚拟投影走按日 override。返回 { virtual, changed, projectId }
  function toggleDone(id) {
    if (id.includes('@')) {
      const i = id.lastIndexOf('@');
      const evId = id.slice(0, i), dKey = id.slice(i + 1);
      TTCore.storage.recurDoneSet(evId, dKey, !TTCore.storage.recurDoneGet(evId, dKey));
      return { virtual: true, changed: true, projectId: null };
    }
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id);
    if (!ev) return { virtual: false, changed: false, projectId: null };
    ev.done = !ev.done;
    ev.updatedAt = new Date().toISOString();
    ev.completedAt = ev.done ? new Date().toISOString() : '';   // V3：记录/清空完成时间
    TTCore.storage.saveEvents(all);
    return { virtual: false, changed: true, projectId: ev.projectId };
  }

  // 置顶/取消置顶（P10.1）：仅本机显示偏好，不递增 revision、不更新 updatedAt；返回是否命中事项
  function toggleEventPin(id) {
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id);
    if (!ev) return false;
    if (ev.pinned) { delete ev.pinned; delete ev.pinnedAt; }
    else { ev.pinned = true; ev.pinnedAt = new Date().toISOString(); }
    TTCore.storage.saveEvents(all);
    return true;
  }

  // 移到指定日期：多日事项整体平移（保持持续天数），单日直接改期；虚拟 id 解析为模板。返回 { ok, projectId }
  function moveEventToDate(id, newDateKey) {
    if (id.includes('@')) id = id.slice(0, id.lastIndexOf('@'));
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id);
    if (!ev) return { ok: false, projectId: null };
    const oldStart = eventStart(ev);
    const oldEnd = eventEnd(ev);
    if (oldStart && oldEnd && oldEnd !== oldStart) {
      const delta = Math.round((parseDateKey(newDateKey) - parseDateKey(oldStart)) / 86400000);
      ev.startDate = newDateKey;
      ev.endDate = addDaysKey(oldEnd, delta);
    } else {
      ev.startDate = newDateKey;
      ev.endDate = newDateKey;
    }
    ev.date = ev.startDate;
    ev.updatedAt = new Date().toISOString();
    TTCore.storage.saveEvents(all);
    return { ok: true, projectId: ev.projectId };
  }

  // 移到项目（pid 为空 = 未归类）；返回 { ok, oldPid, projectId }
  function moveEventToProject(id, pid) {
    const all = TTCore.storage.loadEvents();
    const ev = all.find(e => e.id === id);
    if (!ev) return { ok: false, oldPid: null, projectId: null };
    const oldPid = ev.projectId;
    ev.projectId = pid || null;
    ev.updatedAt = new Date().toISOString();
    TTCore.storage.saveEvents(all);
    return { ok: true, oldPid, projectId: ev.projectId };
  }

  TTCore.opsTasks = {
    createEvent, updateEvent, removeEvent, toggleDone, toggleEventPin,
    moveEventToDate, moveEventToProject
  };
})(typeof window !== 'undefined' ? window : globalThis);
