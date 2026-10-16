/**
 * 核心层：备份与导入（M0 解耦，自 renderer/backup.js 平移）
 *
 * 纯数据转换，无 DOM 依赖。对外契约保持不变：挂载到 window.Backup（同时暴露 TTCore.backup）。
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
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  const BACKUP_KIND = 'timetable-backup';
  const BACKUP_SCHEMA_VERSION = 1;

  // localStorage key 分类
  const SETTINGS_KEYS = ['appSettings', 'pomoCfg', 'daySort', 'uiTheme'];
  // eventTemplates（P5.3 事项模板）只进三档备份；不进局域网同步快照，避免为此改动 mergeSyncData 引入风险
  // calSubscriptions（P6.4 日历订阅定义）同样只进三档备份、不进同步快照；calSubCache_* 订阅缓存不进备份（刷新即重建）
  // calEventCfg（P9.3 外部事件单事件提醒配置）进三档备份；calRemindLedger 触发账本不进备份（运行时可重建）
  // trashEvents（P7.1 回收站）只进三档备份、不进同步快照：删除传播以墓碑为准，回收站是本地救济网
  const BUSINESS_KEYS = ['projects', 'events', 'syncBases', 'syncLog', 'notesDoneLines', 'quickNotes', 'pomoTaskLogs', 'pomoHistory', 'recurDone', 'deviceId', 'syncPairs', 'syncTombstones', 'eventTemplates', 'calSubscriptions', 'calEventCfg', 'trashEvents'];
  const STATE_KEYS = ['remindedKeys', 'weatherCity', 'pomoStats'];   // 运行时状态，可一并备份但导入时不强制覆盖
  // 以原始字符串（非 JSON）存储的业务键：恢复前校验时跳过 JSON.parse
  const RAW_BUSINESS_KEYS = ['deviceId'];
  // 业务档（合并式）导入允许整体覆盖的键：刻意不含 deviceId/syncPairs/syncTombstones，
  // 避免跨设备导入覆盖同步身份；full 整体恢复时恢复全部 BUSINESS_KEYS
  const MERGE_OVERWRITE_KEYS = ['syncBases', 'syncLog', 'notesDoneLines', 'quickNotes', 'pomoTaskLogs', 'pomoHistory', 'recurDone', 'eventTemplates', 'calSubscriptions', 'calEventCfg', 'trashEvents'];

  const SETTINGS_LABELS = {
    appSettings: '应用偏好（提醒/声音/侧边栏/同步模式等）',
    pomoCfg: '番茄钟设置',
    daySort: '日视图排序',
    uiTheme: '主题外观'
  };
  const BUSINESS_LABELS = {
    projects: '项目（含阶段 Phase）', events: '事项 Task', syncBases: '同步基准', syncLog: '同步日志',
    notesDoneLines: '便签完成记录', quickNotes: '快速便签', pomoTaskLogs: '番茄钟记录', pomoHistory: '番茄历史/DailyLog',
    recurDone: '重复事项按日完成', deviceId: '本机设备 ID', syncPairs: '同步配对', syncTombstones: '删除墓碑',
    eventTemplates: '事项模板', calSubscriptions: '外部日历订阅定义', calEventCfg: '外部事件提醒配置', trashEvents: '回收站'
  };
  // 任何备份都明确排除的内容（清单声明用）
  const BACKUP_EXCLUDED = [
    'sync-secrets.json（局域网同步配对密钥，任何备份均不包含）',
    '外部日历订阅缓存 calSubCache_*（可由订阅源重新拉取重建）',
    '外部事件提醒触发账本 calRemindLedger（本机运行时状态）',
    '登录会话 / 访问令牌 / API 密钥（当前不存在，预留：永不导出）',
    '窗口停靠位置、显示器 ID 等设备专属状态（不进设置档；仅完整备份含 sidebar-ui.json，跨机恢复需自行核对）'
  ];

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

  // 校验备份文件结构。P9.4 起 schema_version >= 1 放行：旧版本走缺省迁移，读取保持向后兼容
  function validateBackup(data) {
    if (!data || typeof data !== 'object') return { ok: false, error: '文件内容不是对象' };
    if (data.kind !== BACKUP_KIND) return { ok: false, error: '不是日程侧边栏备份文件（kind 不符）' };
    if (typeof data.schema_version !== 'number' || data.schema_version < 1) {
      return { ok: false, error: `不支持的备份版本（schema_version=${data.schema_version}）` };
    }
    if (data.schema_version > BACKUP_SCHEMA_VERSION) {
      return { ok: false, error: `备份来自更新版本应用（schema_version=${data.schema_version}），请先升级本应用` };
    }
    if (!['settings', 'business', 'full'].includes(data.type)) {
      return { ok: false, error: `未知备份类型：${data.type}` };
    }
    return { ok: true };
  }

  // 设置导入预览：逐项标记 added（本机没有）/changed（与本机不同）/same（无变化）
  function planSettingsImport(data) {
    const out = [];
    if (!data || !data.settings) return out;
    for (const k of SETTINGS_KEYS) {
      const incoming = data.settings[k];
      if (incoming === null || incoming === undefined) continue;
      const current = safeGet(k);
      let status = 'same';
      if (current === null) status = 'added';
      else if (!jsonEqualLoose(current, incoming)) status = 'changed';
      out.push({ key: k, label: SETTINGS_LABELS[k] || k, status });
    }
    return out;
  }
  // JSON 语义比较（忽略键序差异）；任一方非 JSON 时退化为原始串比较
  function jsonDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && jsonDeepEqual(a[k], b[k]));
    }
    return false;
  }
  function jsonEqualLoose(a, b) {
    if (String(a) === String(b)) return true;
    try { return jsonDeepEqual(JSON.parse(a), JSON.parse(b)); }
    catch { return false; }
  }
  // 按预览勾选结果写设置键（keys 为允许写入的键名数组）
  function applySettingsKeys(data, keys) {
    const allow = new Set(keys || []);
    const logs = [];
    if (!data || !data.settings) return { ok: true, logs };
    for (const k of SETTINGS_KEYS) {
      if (allow.has(k) && data.settings[k] !== null && data.settings[k] !== undefined) {
        safeSet(k, data.settings[k]);
        logs.push(k);
      }
    }
    return { ok: true, logs };
  }

  // 备份内容清单（UI 文案与写入说明用）：included/excluded 均为中文说明数组
  function backupManifest(type, hasMainFiles) {
    const included = [];
    if (type === 'settings' || type === 'full') {
      for (const k of SETTINGS_KEYS) included.push('设置 · ' + (SETTINGS_LABELS[k] || k));
    }
    if (type === 'business' || type === 'full') {
      for (const k of BUSINESS_KEYS) included.push('业务 · ' + (BUSINESS_LABELS[k] || k));
    }
    if (type === 'full' && hasMainFiles) {
      included.push('本机文件 · sidebar-ui.json（侧边栏布局）');
      included.push('本机文件 · clipboard-history.json（剪贴板历史）');
    }
    return { included, excluded: [...BACKUP_EXCLUDED] };
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
    // 其余整体覆盖型 key（业务档合并白名单；同步身份三键不在内）
    for (const k of MERGE_OVERWRITE_KEYS) {
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
      // 其余整体覆盖：业务档走合并白名单（不覆盖同步身份）；full 恢复写入全部业务键
      const overwriteKeys = opt.full ? BUSINESS_KEYS.filter(k => k !== 'projects' && k !== 'events')
                                     : MERGE_OVERWRITE_KEYS;
      for (const k of overwriteKeys) {
        try {
          if (data.business[k] !== null && data.business[k] !== undefined) {
            safeSet(k, data.business[k]);
            logs.push(`已恢复：${k}`);
          }
        } catch (e) { logs.push(`恢复失败：${k}（${e.message}）`); }
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

  // 整体替换（full 备份专用）：先暂存校验（结构 + 每个 JSON 键可解析），全部通过才清空写入；
  // 任何一步失败返回 {ok:false,error} 且不动现有数据（P9.4 恢复安全加固）
  function applyFullReplace(data) {
    const v = validateBackup(data);
    if (!v.ok) return { ok: false, error: v.error, logs: [] };
    const buckets = [];
    if (data.settings) buckets.push(['settings', SETTINGS_KEYS, data.settings]);
    if (data.business) buckets.push(['business', BUSINESS_KEYS, data.business]);
    for (const [bucket, keys, src] of buckets) {
      if (!src || typeof src !== 'object') return { ok: false, error: `${bucket} 数据块缺失或格式错误`, logs: [] };
      for (const k of keys) {
        const raw = src[k];
        if (raw === null || raw === undefined) continue;
        if (typeof raw !== 'string') return { ok: false, error: `${bucket}.${k} 不是字符串`, logs: [] };
        if (bucket === 'business' && RAW_BUSINESS_KEYS.includes(k)) continue;   // 原始字符串键（deviceId）
        try { JSON.parse(raw); }
        catch (e) { return { ok: false, error: `${bucket}.${k} JSON 解析失败：${e.message}`, logs: [] }; }
      }
    }
    // 校验通过：清空业务/运行态 key（设置键由 applyImport 直接覆盖，无需先删）
    for (const k of [...BUSINESS_KEYS, ...STATE_KEYS]) {
      try { localStorage.removeItem(k); } catch {}
    }
    const res = applyImport(data, { projectMode: 'overwrite', eventMode: 'overwrite', full: true });
    return { ok: true, logs: res.logs };
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

  // 暴露到全局（渲染层无模块系统，沿用 script 全局方式；契约与 renderer/backup.js 一致）
  const Backup = {
    BACKUP_KIND,
    BACKUP_SCHEMA_VERSION,
    SETTINGS_KEYS,
    BUSINESS_KEYS,
    RAW_BUSINESS_KEYS,
    MERGE_OVERWRITE_KEYS,
    SETTINGS_LABELS,
    BUSINESS_LABELS,
    BACKUP_EXCLUDED,
    buildBackup,
    validateBackup,
    planImportConflicts,
    planSettingsImport,
    applySettingsKeys,
    backupManifest,
    applyImport,
    applyFullReplace,
    buildLocalStorageBackup,
    restoreLocalStorageBackup
  };
  root.Backup = Backup;
  TTCore.backup = Backup;
})(typeof window !== 'undefined' ? window : globalThis);
