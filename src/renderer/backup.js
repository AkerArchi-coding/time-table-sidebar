/**
 * 备份与导入模块（Shared Core 倾向：纯数据转换，无 DOM 依赖）
 *
 * 三档备份：
 *   settings  — 设备本地偏好（appSettings / pomoCfg / daySort）
 *   business  — 可跨设备同步的业务数据（projects / events / syncBases / syncLog / notesDoneLines / quickNotes）
 *   full      — 上述全部 + 主进程文件（sidebar-ui / clipboard-history）
 *
 * 导入策略：
 *   settings  → 合并覆盖已存在的 key
 *   business  → 逐记录冲突检测，交用户选择（覆盖 / 跳过 / 保留两者）
 *   full      → 需用户二次确认后整体替换
 */

const BACKUP_KIND = 'timetable-backup';
const BACKUP_SCHEMA_VERSION = 1;

// localStorage key 分类
const SETTINGS_KEYS = ['appSettings', 'pomoCfg', 'daySort'];
const BUSINESS_KEYS = ['projects', 'events', 'syncBases', 'syncLog', 'notesDoneLines', 'quickNotes'];
const STATE_KEYS = ['remindedKeys', 'weatherCity', 'pomoStats'];   // 运行时状态，可一并备份但导入时不强制覆盖

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* 配额超限等静默 */ }
}

// 收集指定 key 列表的原始值（字符串），缺失为 null
function collectKeys(keys) {
  const out = {};
  for (const k of keys) {
    const v = safeGet(k);
    out[k] = v === null ? null : v;
  }
  return out;
}

// 构建备份对象（type: settings | business | full，mainFiles 由调用方从主进程获取后传入，appVersion 可选）
function buildBackup(type, mainFiles, appVersion) {
  const data = {
    kind: BACKUP_KIND,
    schema_version: BACKUP_SCHEMA_VERSION,
    type,
    app_version: appVersion || 'unknown',
    exported_at: new Date().toISOString()
  };
  if (type === 'settings' || type === 'full') {
    data.settings = collectKeys(SETTINGS_KEYS);
  }
  if (type === 'business' || type === 'full') {
    data.business = collectKeys(BUSINESS_KEYS);
    data.state = collectKeys(STATE_KEYS);
  }
  if (type === 'full' && mainFiles) {
    data.mainFiles = mainFiles;
  }
  return data;
}

// 校验备份文件结构
function validateBackup(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: '文件内容不是对象' };
  if (data.kind !== BACKUP_KIND) return { ok: false, error: '不是日程侧边栏备份文件（kind 不符）' };
  if (data.schema_version !== BACKUP_SCHEMA_VERSION) {
    return { ok: false, error: `不支持的备份版本（schema_version=${data.schema_version}）` };
  }
  if (!['settings', 'business', 'full'].includes(data.type)) {
    return { ok: false, error: `未知备份类型：${data.type}` };
  }
  return { ok: true };
}

// 冲突检测：返回各业务 key 的冲突统计
// projects/events 按 id 去重；其余 key 为整体覆盖
function planImportConflicts(data) {
  const result = {};
  if (!data.business) return result;

  // projects
  if (data.business.projects) {
    try {
      const incoming = JSON.parse(data.business.projects);
      const current = JSON.parse(safeGet('projects') || '[]');
      const curIds = new Set(current.map(p => p.id));
      const conflicts = incoming.filter(p => curIds.has(p.id)).length;
      result.projects = { total: incoming.length, conflicts, newOnly: incoming.length - conflicts };
    } catch { result.projects = { error: 'projects 数据损坏' }; }
  }
  // events
  if (data.business.events) {
    try {
      const incoming = JSON.parse(data.business.events);
      const current = JSON.parse(safeGet('events') || '[]');
      const curIds = new Set(current.map(e => e.id));
      const conflicts = incoming.filter(e => curIds.has(e.id)).length;
      result.events = { total: incoming.length, conflicts, newOnly: incoming.length - conflicts };
    } catch { result.events = { error: 'events 数据损坏' }; }
  }
  // 其余整体覆盖型 key
  for (const k of ['syncBases', 'syncLog', 'notesDoneLines', 'quickNotes']) {
    if (data.business[k] !== undefined && data.business[k] !== null) {
      result[k] = { overwrite: true };
    }
  }
  return result;
}

// 应用导入：settings/business 合并，full 整体替换
// options: { projectMode: 'overwrite'|'skip'|'keep', eventMode: 'overwrite'|'skip'|'keep', fullReplace: bool }
function applyImport(data, options) {
  const opt = options || {};
  const logs = [];

  // ---- settings：合并覆盖 ----
  if (data.settings) {
    for (const k of SETTINGS_KEYS) {
      if (data.settings[k] !== null && data.settings[k] !== undefined) {
        safeSet(k, data.settings[k]);
        logs.push(`已恢复设置：${k}`);
      }
    }
  }

  // ---- business ----
  if (data.business) {
    // projects
    if (data.business.projects) {
      try {
        const incoming = JSON.parse(data.business.projects);
        const current = JSON.parse(safeGet('projects') || '[]');
        const curMap = new Map(current.map(p => [p.id, p]));
        for (const p of incoming) {
          if (curMap.has(p.id)) {
            if (opt.projectMode === 'skip') continue;
            if (opt.projectMode === 'keep') {
              p.id = p.id + '_imp_' + Date.now().toString(36);
              curMap.set(p.id, p);
            } else { // overwrite
              curMap.set(p.id, p);
            }
          } else {
            curMap.set(p.id, p);
          }
        }
        safeSet('projects', JSON.stringify([...curMap.values()]));
        logs.push(`项目：共 ${incoming.length} 条，模式=${opt.projectMode || 'overwrite'}`);
      } catch (e) { logs.push(`项目导入失败：${e.message}`); }
    }
    // events
    if (data.business.events) {
      try {
        const incoming = JSON.parse(data.business.events);
        const current = JSON.parse(safeGet('events') || '[]');
        const curMap = new Map(current.map(e => [e.id, e]));
        for (const ev of incoming) {
          if (curMap.has(ev.id)) {
            if (opt.eventMode === 'skip') continue;
            if (opt.eventMode === 'keep') {
              ev.id = ev.id + '_imp_' + Date.now().toString(36);
              curMap.set(ev.id, ev);
            } else {
              curMap.set(ev.id, ev);
            }
          } else {
            curMap.set(ev.id, ev);
          }
        }
        safeSet('events', JSON.stringify([...curMap.values()]));
        logs.push(`事项：共 ${incoming.length} 条，模式=${opt.eventMode || 'overwrite'}`);
      } catch (e) { logs.push(`事项导入失败：${e.message}`); }
    }
    // 其余整体覆盖
    for (const k of ['syncBases', 'syncLog', 'notesDoneLines', 'quickNotes']) {
      if (data.business[k] !== null && data.business[k] !== undefined) {
        safeSet(k, data.business[k]);
        logs.push(`已恢复：${k}`);
      }
    }
    // state：可选恢复
    if (data.state) {
      for (const k of STATE_KEYS) {
        if (data.state[k] !== null && data.state[k] !== undefined) {
          safeSet(k, data.state[k]);
        }
      }
    }
  }

  return { ok: true, logs };
}

// 整体替换（full 备份专用）：先清空业务数据再写入
function applyFullReplace(data) {
  // 清空业务 key
  for (const k of [...BUSINESS_KEYS, ...STATE_KEYS]) {
    try { localStorage.removeItem(k); } catch {}
  }
  const res = applyImport(data, { projectMode: 'overwrite', eventMode: 'overwrite' });
  return res;
}

// 供数据目录迁移使用：把所有 localStorage 原始值打包成备份对象
function buildLocalStorageBackup() {
  const all = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    all[k] = localStorage.getItem(k);
  }
  return all;
}
// 数据目录迁移后恢复：把备份对象写回 localStorage
function restoreLocalStorageBackup(backup) {
  if (!backup || typeof backup !== 'object') return;
  for (const [k, v] of Object.entries(backup)) {
    if (v === null || v === undefined) continue;
    safeSet(k, v);
  }
}

// 暴露到全局（渲染层无模块系统，沿用 script 全局方式）
window.Backup = {
  BACKUP_KIND,
  BACKUP_SCHEMA_VERSION,
  SETTINGS_KEYS,
  BUSINESS_KEYS,
  buildBackup,
  validateBackup,
  planImportConflicts,
  applyImport,
  applyFullReplace,
  buildLocalStorageBackup,
  restoreLocalStorageBackup
};
