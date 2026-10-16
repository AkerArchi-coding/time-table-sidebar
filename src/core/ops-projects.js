// ============ 核心层：项目 / 阶段写操作（M0 解耦） ============
// 只做数据读写，返回足够信息；视图副作用（render / toast / 视图态清理）由平台层承接。
// 无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  // 新建项目（写库并返回新对象；不触发渲染）
  function createProject(fields) {
    fields = fields || {};
    const list = TTCore.storage.loadProjects();
    const p = {
      id: TTCore.ids.mkProjectId(),
      name: fields.name,
      description: fields.description || '',
      startDate: fields.startDate || '',
      endDate: fields.endDate || fields.startDate || '',
      category: fields.category || 'work',
      priority: fields.priority || 'medium',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    list.push(p);
    TTCore.storage.saveProjects(list);
    return p;
  }

  // 编辑项目（整体合并字段 + revision 递增）；返回是否命中
  function updateProject(id, fields) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === id);
    if (!p) return false;
    Object.assign(p, fields, { revision: (p.revision || 1) + 1, updatedAt: new Date().toISOString() });
    TTCore.storage.saveProjects(list);
    return true;
  }

  // 删除项目：移除项目 + 其下事项 projectId 置空（未归类）；返回是否命中
  function removeProject(id) {
    const found = TTCore.storage.loadProjects().some(p => p.id === id);
    TTCore.storage.saveProjects(TTCore.storage.loadProjects().filter(p => p.id !== id));
    const all = TTCore.storage.loadEvents();
    let changed = false;
    for (const ev of all) {
      if (ev.projectId === id) { ev.projectId = null; changed = true; }
    }
    if (changed) TTCore.storage.saveEvents(all);
    return found;
  }

  // 项目 revision 自增（本地内容变化时调用；导入/合并直接写值，不经此函数）
  function bumpProjectRevision(pid) {
    if (!pid) return;
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === pid);
    if (!p) return;
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
  }

  // 纯函数：生成阶段 id
  function genPhaseId() {
    return TTCore.ids.mkPhaseId();
  }

  // 新增阶段（返回新阶段对象）；V3：fields 支持对象 {name, description, startDate, endDate}，兼容旧字符串调用
  function addPhase(projectId, fields) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p) return null;
    const opts = typeof fields === 'string' ? { name: fields } : (fields || {});
    const name = String(opts.name || '').trim() || '新阶段';
    let s = String(opts.startDate || '');
    let e = String(opts.endDate || '');
    if (s && e && e < s) { const t = s; s = e; e = t; }
    p.phases = p.phases || [];                 // 先初始化再取 length（新建项目无 phases 字段时防崩）
    const phase = {
      id: genPhaseId(),
      name,
      description: String(opts.description || ''),
      order: p.phases.length,
      startDate: s,
      endDate: e,
      isCompleted: false,
      completedAt: ''
    };
    p.phases.push(phase);
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    return phase;
  }

  // 重命名阶段
  function renamePhase(projectId, phaseId, name) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p) return false;
    const ph = (p.phases || []).find(x => x.id === phaseId);
    if (!ph) return false;
    ph.name = String(name || '').trim() || ph.name;
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    return true;
  }

  // 移动阶段顺序（dir: -1 上移 / 1 下移）
  function movePhase(projectId, phaseId, dir) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p || !p.phases) return false;
    const i = p.phases.findIndex(x => x.id === phaseId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.phases.length) return false;
    const tmp = p.phases[i]; p.phases[i] = p.phases[j]; p.phases[j] = tmp;
    p.phases.forEach((ph, k) => { ph.order = k; });
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    return true;
  }

  // 删除阶段：该阶段下所有事项 phaseId 置空（归为未分阶段）
  function deletePhase(projectId, phaseId) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p || !p.phases) return false;
    p.phases = p.phases.filter(x => x.id !== phaseId);
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    // 清空该阶段事项的 phaseId
    const all = TTCore.storage.loadEvents();
    let changed = false;
    for (const ev of all) {
      if (ev.phaseId === phaseId) { ev.phaseId = ''; changed = true; }
    }
    if (changed) TTCore.storage.saveEvents(all);
    return true;
  }

  // 设置阶段起止日期（P9.1）：仅改阶段自身，绝不自动改动事项日期；倒挂自动交换
  function setPhaseDates(projectId, phaseId, startDate, endDate) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p || !Array.isArray(p.phases)) return false;
    const ph = p.phases.find(x => x.id === phaseId);
    if (!ph) return false;
    let s = String(startDate || '');
    let e = String(endDate || '');
    if (s && e && e < s) { const t = s; s = e; e = t; }
    if (ph.startDate === s && ph.endDate === e) return true;
    ph.startDate = s; ph.endDate = e;
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    return true;
  }

  // V3：项目完成切换——仅改项目自身状态，不擅自改动其下阶段和事项；返回是否命中
  // 未完成事项的确认提示由平台层负责（core 不做交互）
  function toggleProjectComplete(pid) {
    const all = TTCore.storage.loadProjects();
    const p = all.find(x => x.id === pid);
    if (!p) return false;
    p.isCompleted = !p.isCompleted;
    p.completedAt = p.isCompleted ? new Date().toISOString() : '';
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(all);
    return true;
  }

  // V3：阶段完成切换——仅改阶段自身状态，不擅自改动其下事项；返回是否命中
  function togglePhaseComplete(projectId, phaseId) {
    const list = TTCore.storage.loadProjects();
    const p = list.find(x => x.id === projectId);
    if (!p || !Array.isArray(p.phases)) return false;
    const ph = p.phases.find(x => x.id === phaseId);
    if (!ph) return false;
    ph.isCompleted = !ph.isCompleted;
    ph.completedAt = ph.isCompleted ? new Date().toISOString() : '';
    p.revision = (p.revision || 1) + 1;
    p.updatedAt = new Date().toISOString();
    TTCore.storage.saveProjects(list);
    return true;
  }

  // 置顶/取消置顶（P10.1）：仅本机显示偏好，不递增 revision、不更新 updatedAt；返回是否命中
  function toggleProjectPin(pid) {
    const all = TTCore.storage.loadProjects();
    const p = all.find(x => x.id === pid);
    if (!p) return false;
    if (p.pinned) { delete p.pinned; delete p.pinnedAt; }
    else { p.pinned = true; p.pinnedAt = new Date().toISOString(); }
    TTCore.storage.saveProjects(all);
    return true;
  }

  TTCore.opsProjects = {
    createProject, updateProject, removeProject, bumpProjectRevision, genPhaseId,
    addPhase, renamePhase, movePhase, deletePhase, setPhaseDates,
    toggleProjectComplete, togglePhaseComplete, toggleProjectPin
  };
})(typeof window !== 'undefined' ? window : globalThis);
