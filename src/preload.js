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
  // 通知点击直达：唤起窗口并展开侧栏（主进程处理显示与几何）
  showWindow: () => ipcRenderer.send('show-window'),
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
  // 侧边栏 UI 配置：停靠侧 / 显示模式 / 宽度倍率 / 目标显示器（主进程持有并持久化）
  uiConfigGet: () => ipcRenderer.invoke('ui-config-get'),
  uiConfigSet: (partial) => ipcRenderer.send('ui-config-set', partial),
  // 多显示器列表（设置页选择吸附目标）
  displaysList: () => ipcRenderer.invoke('displays-list'),
  // 展开态点击三角主动收起
  requestCollapse: () => ipcRenderer.send('request-collapse'),
  // 备份：导出/导入对话框 + 主进程数据文件存取
  backupGetMainFiles: () => ipcRenderer.invoke('backup-get-main-files'),
  backupSetMainFiles: (payload) => ipcRenderer.invoke('backup-set-main-files', payload),
  backupExportDialog: (defaultName, content) => ipcRenderer.invoke('backup-export-dialog', { defaultName, content }),
  backupImportDialog: () => ipcRenderer.invoke('backup-import-dialog'),
  // 自动备份（P7.2）：写入 / 列表 / 读取 / 打开文件夹（文件保存在主进程数据目录 auto-backups/）
  backupAutoWrite: (content) => ipcRenderer.invoke('backup-auto-write', content),
  backupAutoList: () => ipcRenderer.invoke('backup-auto-list'),
  backupAutoRead: (name) => ipcRenderer.invoke('backup-auto-read', name),
  backupAutoOpenDir: () => ipcRenderer.invoke('backup-auto-open-dir'),
  // iCal 互通（P4.3）：导出/导入 .ics 文件对话框
  icalExportDialog: (defaultName, content) => ipcRenderer.invoke('ical-export-dialog', { defaultName, content }),
  icalImportDialog: () => ipcRenderer.invoke('ical-import-dialog'),
  // 外部日历订阅（P6.4/P9.2）：主进程代拉 .ics 文本（渲染层不直接联网），支持条件请求
  calSubFetch: (url, opts) => ipcRenderer.invoke('cal-sub-fetch', url, opts),
  // 数据目录：查询当前路径 / 迁移到新目录（需重启）
  dataDirGet: () => ipcRenderer.invoke('data-dir-get'),
  dataDirMigrate: (backup) => ipcRenderer.invoke('data-dir-migrate', backup),
  onDataMigrateRestore: (cb) => {
    const handler = (_e, backup) => cb(backup);
    ipcRenderer.on('data-migrate-restore', handler);
    return () => ipcRenderer.removeListener('data-migrate-restore', handler);
  },
  // 局域网同步（P3.4）：配对 + 快照交换（secret 由主进程保管，不进 localStorage/备份）
  // 设备上报：渲染层启动时把 deviceId 发给主进程（配对/同步握手用）
  syncHello: (deviceId) => ipcRenderer.send('sync-hello', deviceId),
  // A 侧「等待配对」：返回 { ok, port, code, ips, expiresAt }；配对成功经 onSyncPaired 推送
  syncPairStart: () => ipcRenderer.invoke('sync-pair-start'),
  syncPairStop: () => ipcRenderer.invoke('sync-pair-stop'),
  onSyncPaired: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('sync-paired', handler);
    return () => ipcRenderer.removeListener('sync-paired', handler);
  },
  // B 侧：UDP 发现等待中的设备 → [{device, ip, port}]
  syncPairScan: () => ipcRenderer.invoke('sync-pair-scan'),
  // B 侧：输入配对码握手 → { ok, peerDevice } | { ok:false, error }
  syncPairConnect: (ip, port, code) => ipcRenderer.invoke('sync-pair-connect', { ip, port, code }),
  // 同步服务：被对端连接时渲染层会收到 onSyncExchangeRequest，处理后调 syncExchangeRespond 回包
  syncListen: () => ipcRenderer.invoke('sync-listen'),
  syncExchangeRespond: (snapshot) => ipcRenderer.send('sync-exchange-respond', snapshot || {}),
  onSyncExchangeRequest: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('sync-exchange-request', handler);
    return () => ipcRenderer.removeListener('sync-exchange-request', handler);
  },
  // 发起同步：{ ip, port, peerDeviceId, snapshot } → { ok, data: 对端快照 } | { ok:false, error }
  syncSend: (payload) => ipcRenderer.invoke('sync-send', payload || {}),
  // 解绑设备（主进程删 secret；渲染层自行删设备记录）
  syncUnpair: (deviceId) => ipcRenderer.invoke('sync-unpair', deviceId),
  syncServerStatus: () => ipcRenderer.invoke('sync-server-status'),
  // 全局快捷键：设置开关（主进程注册/反注册，注册失败返回降级后的实际生效状态）
  hotkeySet: (partial) => ipcRenderer.invoke('hotkey-set', partial || {}),
  // 快捷键动作：主进程 → 渲染层（如 Ctrl+Alt+N 打开快速添加）
  onShortcutAction: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('shortcut-action', handler);
    return () => ipcRenderer.removeListener('shortcut-action', handler);
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
