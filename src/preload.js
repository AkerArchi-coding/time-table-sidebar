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
  // 剪贴板历史：查询 / 回填 / 清空 / 变化订阅
  clipboardList: () => ipcRenderer.invoke('clipboard-list'),
  clipboardCopy: (text) => ipcRenderer.send('clipboard-copy', text),
  clipboardClear: () => ipcRenderer.send('clipboard-clear'),
  onClipboardUpdate: (cb) => {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('clipboard-update', handler);
    return () => ipcRenderer.removeListener('clipboard-update', handler);
  }
});
