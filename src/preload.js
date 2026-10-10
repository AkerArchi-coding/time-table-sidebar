const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timetable', {
  onStateChange: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('state-change', handler);
    return () => ipcRenderer.removeListener('state-change', handler);
  },
  // 通知主进程：正在编辑（表单打开时调用），阻止自动收回
  setEditing: (editing) => {
    ipcRenderer.send('editing-state', { editing });
  },
  // 查询当前编辑状态
  isEditing: () => {
    return ipcRenderer.sendSync('editing-state-query');
  },
  // 点击窄条时请求主进程立即展开（绕过边缘停留判定）
  requestExpand: () => {
    ipcRenderer.send('manual-expand');
  },
  // 导出项目文件：弹出保存对话框并写入 .prj 文件
  exportProjectFile: (defaultName, content) => {
    return ipcRenderer.invoke('project-export', { defaultName, content });
  },
  // 导入项目文件：弹出打开对话框并读取 .prj 文件内容
  importProjectFile: () => {
    return ipcRenderer.invoke('project-import');
  },
  // 天气：IP 定位 / 按坐标查询 / 城市搜索（主进程发 HTTPS）
  weatherIpLocation: () => ipcRenderer.invoke('weather-ip-location'),
  weatherQuery: (lat, lon) => ipcRenderer.invoke('weather-query', { lat, lon }),
  weatherSearch: (q) => ipcRenderer.invoke('weather-search', q),
  // 系统资源：CPU/内存/运行时长快照
  sysStats: () => ipcRenderer.invoke('sys-stats'),
  // 剪贴板历史：查询 / 回填 / 清空 / 删除单条 / 变化订阅 / 开关同步
  clipboardList: () => ipcRenderer.invoke('clipboard-list'),
  clipboardCopy: (text) => ipcRenderer.send('clipboard-copy', text),
  clipboardClear: () => ipcRenderer.send('clipboard-clear'),
  clipboardDelete: (text) => ipcRenderer.send('clipboard-delete', text),
  clipboardEnabled: (on) => ipcRenderer.send('clipboard-enabled', on),
  onClipboardUpdate: (cb) => {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('clipboard-update', handler);
    return () => ipcRenderer.removeListener('clipboard-update', handler);
  },
  // 开机自动启动：查询 / 设置（平台细节在主进程，UI 与实现解耦）
  appVersion: () => ipcRenderer.invoke('app-version'),
  autostartGet: () => ipcRenderer.invoke('autostart-get'),
  autostartSet: (on) => ipcRenderer.send('autostart-set', on),
  // 托盘动作：主进程 → 渲染层（如托盘菜单"设置"）
  onTrayAction: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('tray-action', handler);
    return () => ipcRenderer.removeListener('tray-action', handler);
  },
  // 窗口可见性：主进程在 show/hide 时广播（隐藏进托盘时渲染层暂停非必要刷新）
  onWindowVisible: (cb) => {
    const handler = (_e, visible) => cb(visible);
    ipcRenderer.on('window-visible', handler);
    return () => ipcRenderer.removeListener('window-visible', handler);
  },
  // 侧边栏 UI 配置：停靠侧 / 显示模式（主进程持有并持久化）
  uiConfigGet: () => ipcRenderer.invoke('ui-config-get'),
  uiConfigSet: (partial) => ipcRenderer.send('ui-config-set', partial),
  // 备份：导出/导入对话框 + 主进程数据文件存取
  backupGetMainFiles: () => ipcRenderer.invoke('backup-get-main-files'),
  backupSetMainFiles: (payload) => ipcRenderer.invoke('backup-set-main-files', payload),
  backupExportDialog: (defaultName, content) => ipcRenderer.invoke('backup-export-dialog', { defaultName, content }),
  backupImportDialog: () => ipcRenderer.invoke('backup-import-dialog'),
  // 数据目录：查询当前路径 / 迁移到新目录（需重启）
  dataDirGet: () => ipcRenderer.invoke('data-dir-get'),
  dataDirMigrate: (backup) => ipcRenderer.invoke('data-dir-migrate', backup),
  onDataMigrateRestore: (cb) => {
    const handler = (_e, backup) => cb(backup);
    ipcRenderer.on('data-migrate-restore', handler);
    return () => ipcRenderer.removeListener('data-migrate-restore', handler);
  },
  // 扫码配对 / 局域网同步（预留接口，主进程返回 not_implemented）
  syncPairStart: () => ipcRenderer.invoke('sync-pair-start'),
  syncPairScan: () => ipcRenderer.invoke('sync-pair-scan'),
  syncSend: (payload) => ipcRenderer.invoke('sync-send', payload),
  onSyncReceive: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('sync-receive', handler);
    return () => ipcRenderer.removeListener('sync-receive', handler);
  },
  // 语音输入（Windows SAPI 5 本机识别；非 Windows 平台返回 platform_unsupported）
  voiceGetStatus: () => ipcRenderer.invoke('voice-status'),
  voiceStart: (options) => ipcRenderer.send('voice-start', options || {}),
  voiceStop: () => ipcRenderer.send('voice-stop'),
  onVoiceResult: (cb) => {
    const handler = (_e, result) => cb(result);
    ipcRenderer.on('voice-result', handler);
    return () => ipcRenderer.removeListener('voice-result', handler);
  },
  onVoiceState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('voice-state', handler);
    return () => ipcRenderer.removeListener('voice-state', handler);
  },
  onVoiceError: (cb) => {
    const handler = (_e, err) => cb(err);
    ipcRenderer.on('voice-error', handler);
    return () => ipcRenderer.removeListener('voice-error', handler);
  }
});
