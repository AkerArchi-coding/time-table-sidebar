const { app, BrowserWindow, screen, ipcMain, dialog, clipboard, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const koffi = require('koffi');
const { resolveLaunchExe } = require('./main/launch-path');
const { spawn } = require('child_process');

let sidebar = null;            // 侧边栏主窗口
let expanded = false;          // 当前是否展开
let leaveTimer = null;         // 收回延迟计时器
let edgeDwellTimer = null;     // 收起态：鼠标在边缘条带的停留计时器（防误触）
let fullscreenHidden = false;  // 是否因前台全屏而隐藏
let editing = false;           // 渲染层正在编辑表单（阻止自动收回）
let tray = null;               // 系统托盘
let uiConfig = { side: 'right', mode: 'rail' };  // 侧边栏 UI 配置：停靠侧 + 显示模式（持久化）

const NARROW_W = 64;           // 收起时宽度
const EXPANDED_W = 360;        // 展开时宽度
const TRIGGER_MARGIN = 6;      // 自动展开触发条带：屏幕最右 6px
const EDGE_DWELL_MS = 260;     // 鼠标需在触发条带停留多久才展开（防误触）
const COLLAPSE_DELAY = 450;    // 鼠标离开后多久收回（毫秒）
const POLL_INTERVAL = 80;      // 鼠标位置轮询间隔（毫秒）：窗口可见 / hidden 贴边唤出时
const POLL_IDLE_INTERVAL = 500;// 鼠标轮询空闲间隔：非 hidden 模式窗口隐藏进托盘时（靠托盘唤起，无需灵敏）
const FS_CHECK_INTERVAL = 500; // 全屏检测间隔（毫秒）：窗口可见时
const FS_IDLE_INTERVAL = 1500; // 全屏检测空闲间隔：窗口隐藏时（降低后台 FFI 轮询频率）

// ============ 全屏/最大化前台窗口检测 ============
// Windows：通过 koffi 直接调用 user32.dll；macOS/Linux 暂不检测（安全返回 false，
// 贴边展开等核心功能不受影响），未来可在此处补 macOS 原生实现。
const IS_WIN = process.platform === 'win32';
let user32 = null;
let GetForegroundWindow = null;
let GetShellWindow = null;
let GetSystemMetrics = null;
let IsZoomed = null;
let GetWindowThreadProcessId = null;
let GetWindowRect = null;
if (IS_WIN) {
  user32 = koffi.load('user32.dll');
  GetForegroundWindow = user32.func('void *GetForegroundWindow()');
  GetShellWindow = user32.func('void *GetShellWindow()');
  GetSystemMetrics = user32.func('int GetSystemMetrics(int)');
  IsZoomed = user32.func('bool IsZoomed(void *hWnd)');
  GetWindowThreadProcessId = user32.func('uint GetWindowThreadProcessId(void *hWnd, uint *lpdwProcessId)');
  // 用 void * 接收 RECT，配合 Buffer 读取（比 koffi.struct 更可靠）
  GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, void *lpRect)');
}

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const FULLSCREEN_TOL = 8;

// 预分配 Buffer，避免每次检测都创建新对象
const rectBuf = Buffer.alloc(16);  // RECT = 4 × int32 = 16 字节
const pidBuf = Buffer.alloc(4);    // DWORD = uint32 = 4 字节

let electronPid = 0;

// 检测前台窗口是否全屏或最大化
function isForegroundFullscreen() {
  if (!IS_WIN) return false;   // macOS/Linux：暂不检测，保留贴边展开/收回核心行为
  const hwnd = GetForegroundWindow();
  if (!hwnd) return false;

  // 排除桌面 Shell 窗口
  const shellHwnd = GetShellWindow();
  if (hwnd === shellHwnd) return false;

  // 排除自身 Electron 进程
  pidBuf.fill(0);
  GetWindowThreadProcessId(hwnd, pidBuf);
  const procId = pidBuf.readUInt32LE(0);
  if (procId === 0 || procId === electronPid) return false;

  // 获取窗口矩形
  rectBuf.fill(0);
  const ok = GetWindowRect(hwnd, rectBuf);
  if (!ok) return false;

  const left = rectBuf.readInt32LE(0);
  const top = rectBuf.readInt32LE(4);
  const right = rectBuf.readInt32LE(8);
  const bottom = rectBuf.readInt32LE(12);

  const sw = GetSystemMetrics(SM_CXSCREEN);
  const sh = GetSystemMetrics(SM_CYSCREEN);

  // 判断是否覆盖整个屏幕（含容差）
  const coversScreen =
    left <= FULLSCREEN_TOL &&
    top <= FULLSCREEN_TOL &&
    right >= (sw - FULLSCREEN_TOL) &&
    bottom >= (sh - FULLSCREEN_TOL);

  // 最大化窗口也视为需要隐藏
  const maximized = IsZoomed(hwnd);

  return coversScreen || maximized;
}

// 全屏检测定时器（自适应间隔：可见 500ms / 隐藏 1500ms，降低后台 FFI 轮询）
function startFullscreenCheck() {
  const tick = () => {
    if (!sidebar || sidebar.isDestroyed()) return;

    const isFs = isForegroundFullscreen();

    if (isFs && !fullscreenHidden) {
      // 进入全屏/最大化 → 隐藏
      fullscreenHidden = true;
      expanded = false;
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      sidebar.hide();
    } else if (!isFs && fullscreenHidden) {
      // 退出全屏 → 恢复（hidden 模式下保持隐藏，不强制显示）
      fullscreenHidden = false;
      collapseSidebar(true);
      if (uiConfig.mode !== 'hidden' && !sidebar.isVisible()) sidebar.showInactive();
    }
  };
  const schedule = () => {
    if (!sidebar || sidebar.isDestroyed()) return;
    const idle = !sidebar.isVisible();
    setTimeout(() => {
      try { tick(); } catch { /* 单次检测异常不中断轮询链 */ }
      schedule();
    }, idle ? FS_IDLE_INTERVAL : FS_CHECK_INTERVAL);
  };
  schedule();
}

// ============ 侧边栏 UI 配置（停靠侧 / 显示模式；持久化于 userData） ============
function uiConfigPath() {
  return path.join(app.getPath('userData'), 'sidebar-ui.json');
}
function loadUiConfig() {
  try {
    const o = JSON.parse(fs.readFileSync(uiConfigPath(), 'utf8'));
    if (o.side === 'left' || o.side === 'right') uiConfig.side = o.side;
    if (o.mode === 'rail' || o.mode === 'mini' || o.mode === 'hidden') uiConfig.mode = o.mode;
    if (typeof o.displayId === 'number') uiConfig.displayId = o.displayId;
  } catch { /* 首次运行或文件损坏 → 保持默认 */ }
}
function saveUiConfig() {
  try { fs.writeFileSync(uiConfigPath(), JSON.stringify(uiConfig), 'utf8'); } catch { /* 写盘失败下次再试 */ }
}

// 多显示器：选择目标显示器
// 优先级：已保存的 displayId（若仍存在）→ 光标所在显示器 → 主屏
function getTargetDisplay() {
  const all = screen.getAllDisplays();
  if (typeof uiConfig.displayId === 'number') {
    const found = all.find(d => d.id === uiConfig.displayId);
    if (found) return found;
  }
  try {
    const pt = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
  } catch {
    return screen.getPrimaryDisplay();
  }
}

// 收起态几何：rail = 全高窄条；mini = 半高窄条（垂直居中，Dock 感）
function collapsedRect() {
  const wa = getTargetDisplay().workArea;
  const x = uiConfig.side === 'left' ? wa.x : wa.x + wa.width - NARROW_W;
  if (uiConfig.mode === 'mini') {
    const h = Math.floor(wa.height / 2);
    return { x, y: wa.y + Math.floor((wa.height - h) / 2), width: NARROW_W, height: h };
  }
  return { x, y: wa.y, width: NARROW_W, height: wa.height };
}
// 展开态几何：全高面板，贴靠当前停靠侧
function expandedRect() {
  const wa = getTargetDisplay().workArea;
  const x = uiConfig.side === 'left' ? wa.x : wa.x + wa.width - EXPANDED_W;
  return { x, y: wa.y, width: EXPANDED_W, height: wa.height };
}

function sendStateChange() {
  if (sidebar && !sidebar.isDestroyed()) {
    sidebar.webContents.send('state-change', {
      expanded,
      side: uiConfig.side,
      mode: uiConfig.mode
    });
  }
}

// 配置变更后重排几何与可见性（设置面板 / 启动恢复共用）
function applyUiConfig() {
  if (!sidebar || sidebar.isDestroyed()) return;
  if (expanded) {
    expandSidebar();          // 展开中仅换边/换模式，保持展开
  } else {
    collapseSidebar(true);
    if (uiConfig.mode !== 'hidden' && !sidebar.isVisible()) sidebar.showInactive();
  }
  sendStateChange();
}

ipcMain.handle('ui-config-get', () => Object.assign({}, uiConfig));
ipcMain.on('ui-config-set', (_e, partial) => {
  if (!partial || typeof partial !== 'object') return;
  if (partial.side === 'left' || partial.side === 'right') uiConfig.side = partial.side;
  if (partial.mode === 'rail' || partial.mode === 'mini' || partial.mode === 'hidden') uiConfig.mode = partial.mode;
  saveUiConfig();
  applyUiConfig();
});

// ============ 侧边栏窗口 ============
function createSidebar() {
  const start = collapsedRect();

  sidebar = new BrowserWindow({
    width: start.width,
    height: start.height,
    x: start.x,
    y: start.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true   // 窗口隐藏进托盘时节流渲染器定时器/动画，降低后台开销
    }
  });

  sidebar.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发模式自动打开 DevTools
  if (process.argv.includes('--dev')) {
    sidebar.webContents.openDevTools({ mode: 'detach' });
  }

  // 鼠标位置轮询：自适应间隔。窗口可见、或 hidden 模式贴边唤出时需灵敏(80ms)；
  // 其余模式（rail/dock）窗口隐藏进托盘时降频到 500ms，减少后台唤醒与 CPU。
  const scheduleCursorPoll = () => {
    if (sidebar.isDestroyed()) return;
    const needFast = sidebar.isVisible() || uiConfig.mode === 'hidden';
    setTimeout(() => {
      try { checkCursor(); } catch { /* 单次采样异常不中断轮询链 */ }
      scheduleCursorPoll();
    }, needFast ? POLL_INTERVAL : POLL_IDLE_INTERVAL);
  };
  scheduleCursorPoll();

  // 向渲染层广播窗口可见性：隐藏时暂停 60s 全量重绘 / 系统采样 / 天气，显示时补刷
  sidebar.on('show', () => {
    if (!sidebar.isDestroyed()) sidebar.webContents.send('window-visible', true);
  });
  sidebar.on('hide', () => {
    if (!sidebar.isDestroyed()) sidebar.webContents.send('window-visible', false);
  });
  sidebar.webContents.on('did-finish-load', () => {
    if (!sidebar.isDestroyed()) {
      sidebar.webContents.send('window-visible', sidebar.isVisible());
    }
  });

  // 关闭窗口 → 隐藏进托盘（托盘左键/菜单可再次唤起；真正退出走托盘"退出"）
  sidebar.on('close', (e) => {
    if (app.isQuiting) return;
    e.preventDefault();
    sidebar.hide();
  });
}

// 判断点是否位于停靠侧屏幕边缘的触发条带（工作区内）
function pointNearEdge(pt) {
  const display = screen.getDisplayNearestPoint(pt);
  const wa = display.workArea;
  if (pt.y < wa.y || pt.y > wa.y + wa.height) return false;
  if (uiConfig.side === 'left') {
    return pt.x >= wa.x && pt.x <= wa.x + TRIGGER_MARGIN;
  }
  const rightEdge = wa.x + wa.width;
  return pt.x >= rightEdge - TRIGGER_MARGIN && pt.x <= rightEdge;
}

// 轮询鼠标位置，判断是否需要展开/收回
function checkCursor() {
  if (!sidebar || sidebar.isDestroyed()) return;
  if (fullscreenHidden) return;       // 全屏隐藏期间不响应鼠标
  // hidden 模式下窗口不可见也继续轮询（贴边停留唤出）；其余模式不可见即跳过
  if (!sidebar.isVisible() && uiConfig.mode !== 'hidden') return;

  const pt = screen.getCursorScreenPoint();

  if (expanded) {
    // 展开态：鼠标在窗口范围内（含边缘）保持，离开后延迟收回（原行为不变）
    const b = sidebar.getBounds();
    const inWindow =
      pt.x >= b.x && pt.x <= b.x + b.width &&
      pt.y >= b.y && pt.y <= b.y + b.height;

    if (pointNearEdge(pt) || inWindow) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    } else if (!leaveTimer && !editing) {
      // editing 为 true 时，即使鼠标离开也不收回
      leaveTimer = setTimeout(() => {
        const p = screen.getCursorScreenPoint();
        const bb = sidebar.getBounds();
        const stillIn =
          p.x >= bb.x && p.x <= bb.x + bb.width &&
          p.y >= bb.y && p.y <= bb.y + bb.height;
        if (!stillIn && !editing) collapseSidebar(false);
        leaveTimer = null;
      }, COLLAPSE_DELAY);
    }
  } else {
    // 收起态：只在停靠侧边缘 6px 条带内停留 EDGE_DWELL_MS 才展开（防误触）。
    // hidden 模式窗口不可见时同样生效：先 showInactive（不抢焦点）再展开。
    if (pointNearEdge(pt)) {
      if (!edgeDwellTimer) {
        edgeDwellTimer = setTimeout(() => {
          edgeDwellTimer = null;
          const p = screen.getCursorScreenPoint();
          if (!expanded && pointNearEdge(p)) {
            // 多显示器：跟随触发边缘所在的显示器，记录并持久化
            const d = screen.getDisplayNearestPoint(p);
            if (d && d.id !== uiConfig.displayId) {
              uiConfig.displayId = d.id;
              saveUiConfig();
            }
            if (!sidebar.isVisible()) sidebar.showInactive();
            expandSidebar();
          }
        }, EDGE_DWELL_MS);
      }
    } else if (edgeDwellTimer) {
      clearTimeout(edgeDwellTimer);
      edgeDwellTimer = null;
    }
  }
}

// IPC：渲染层点击窄条（图标/空白）时立即展开，绕过边缘停留判定
ipcMain.on('manual-expand', () => {
  if (edgeDwellTimer) { clearTimeout(edgeDwellTimer); edgeDwellTimer = null; }
  if (!expanded) expandSidebar();
});

// IPC：接收编辑状态
ipcMain.on('editing-state', (_e, data) => {
  editing = !!data.editing;
  // 如果退出编辑状态，且鼠标不在窗口内，延迟后收回
  if (!editing && expanded && leaveTimer === null) {
    const pt = screen.getCursorScreenPoint();
    const b = sidebar.getBounds();
    const inWindow =
      pt.x >= b.x && pt.x <= b.x + b.width &&
      pt.y >= b.y && pt.y <= b.y + b.height;
    if (!inWindow) {
      leaveTimer = setTimeout(() => {
        const p = screen.getCursorScreenPoint();
        const bb = sidebar.getBounds();
        const stillIn =
          p.x >= bb.x && p.x <= bb.x + bb.width &&
          p.y >= bb.y && p.y <= bb.y + bb.height;
        if (!stillIn) collapseSidebar(false);
        leaveTimer = null;
      }, COLLAPSE_DELAY);
    }
  }
});

ipcMain.on('editing-state-query', (e) => {
  e.returnValue = editing;
});

// IPC：导出项目文件（保存对话框 + 写入 .prj）
ipcMain.handle('project-export', async (e, { defaultName, content }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出项目文件',
    defaultPath: defaultName,
    filters: [{ name: '项目文件', extensions: ['prj'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// IPC：导入项目文件（打开对话框 + 读取 .prj）
ipcMain.handle('project-import', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入项目文件',
    filters: [{ name: '项目文件', extensions: ['prj'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  try {
    const content = await fs.promises.readFile(filePaths[0], 'utf8');
    return { ok: true, path: filePaths[0], content };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ============ 备份与数据目录 ============
// 读取主进程侧的 JSON 数据文件（sidebar-ui / clipboard-history），纳入完整备份
ipcMain.handle('backup-get-main-files', () => {
  const result = {};
  const files = { sidebarUi: 'sidebar-ui.json', clipboardHistory: 'clipboard-history.json' };
  for (const [key, fname] of Object.entries(files)) {
    try {
      result[key] = fs.readFileSync(path.join(app.getPath('userData'), fname), 'utf8');
    } catch { result[key] = null; }
  }
  return result;
});
// 写回主进程侧 JSON 数据文件（完整备份恢复时调用）
ipcMain.handle('backup-set-main-files', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid' };
  const files = { sidebarUi: 'sidebar-ui.json', clipboardHistory: 'clipboard-history.json' };
  for (const [key, fname] of Object.entries(files)) {
    if (typeof payload[key] === 'string') {
      try { fs.writeFileSync(path.join(app.getPath('userData'), fname), payload[key], 'utf8'); }
      catch { /* 单文件失败不阻塞其余 */ }
    }
  }
  return { ok: true };
});
// 备份文件保存对话框（.ttbk = Timetable Backup）
ipcMain.handle('backup-export-dialog', async (e, { defaultName, content }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: defaultName || 'timetable-backup.ttbk',
    filters: [{ name: '日程备份文件', extensions: ['ttbk'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
// 备份文件打开对话框
ipcMain.handle('backup-import-dialog', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入备份',
    filters: [{ name: '日程备份文件', extensions: ['ttbk'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  try {
    const content = await fs.promises.readFile(filePaths[0], 'utf8');
    return { ok: true, path: filePaths[0], content };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ============ 自动备份（P7.2）：userData/auto-backups/ 下滚动保留最近 7 份全量备份 ============
// 目录在每次调用时经 app.getPath('userData') 解析，自动跟随数据目录迁移
const { AUTO_BACKUP_KEEP, autoBackupName, parseAutoBackupName, pickTrim } = require('./main/auto-backup');
function autoBackupDir() {
  return path.join(app.getPath('userData'), 'auto-backups');
}
// 写入一份自动备份（content 为完整备份 JSON 字符串），超出保留数删除最旧
ipcMain.handle('backup-auto-write', (_e, content) => {
  try {
    if (typeof content !== 'string' || !content) return { ok: false, error: 'invalid' };
    const dir = autoBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = autoBackupName(new Date());
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
    // 滚动裁剪：只保留最近 AUTO_BACKUP_KEEP 份
    const names = fs.readdirSync(dir);
    for (const stale of pickTrim(names, AUTO_BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(dir, stale)); } catch { /* 单文件删除失败不阻塞 */ }
    }
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
// 列出自动备份文件（按时间倒序：文件名 + 修改时间毫秒 + 字节数；目录不存在视为空）
ipcMain.handle('backup-auto-list', () => {
  try {
    const dir = autoBackupDir();
    const list = fs.readdirSync(dir)
      .map(n => ({ name: n, t: parseAutoBackupName(n) }))
      .filter(x => x.t !== null)
      .sort((a, b) => b.t - a.t)
      .map(x => {
        let mtime = 0, size = 0;
        try { const st = fs.statSync(path.join(dir, x.name)); mtime = st.mtimeMs; size = st.size; } catch { /* 文件刚被删等 */ }
        return { name: x.name, mtime, size };
      });
    return { ok: true, list };
  } catch { return { ok: true, list: [] }; }
});
// 读取一份自动备份内容（文件名校验防目录穿越；恢复走渲染层现有导入校验流程）
ipcMain.handle('backup-auto-read', (_e, name) => {
  try {
    if (!/^tt-auto-\d{8}-\d{6}\.json$/.test(String(name || ''))) return { ok: false, error: 'invalid' };
    const content = fs.readFileSync(path.join(autoBackupDir(), String(name)), 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
// 在系统文件管理器中打开自动备份文件夹
ipcMain.handle('backup-auto-open-dir', async () => {
  const dir = autoBackupDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 打开时兜底创建失败也无妨 */ }
  await require('electron').shell.openPath(dir);
  return { ok: true };
});
// iCal 日历文件保存对话框（.ics，P4.3）
ipcMain.handle('ical-export-dialog', async (e, { defaultName, content }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出日历',
    defaultPath: defaultName || 'calendar.ics',
    filters: [{ name: 'iCal 日历文件', extensions: ['ics'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
// iCal 日历文件打开对话框
ipcMain.handle('ical-import-dialog', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入日历',
    filters: [{ name: 'iCal 日历文件', extensions: ['ics'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  try {
    const content = await fs.promises.readFile(filePaths[0], 'utf8');
    return { ok: true, path: filePaths[0], content };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 查询 / 设置数据目录（userData）
ipcMain.handle('data-dir-get', () => ({
  current: app.getPath('userData'),
  default: app.getPath('userData')   // 默认值由 Electron 决定，迁移后 current 会改变
}));
// 选择新数据目录：渲染层需先传入完整备份（localStorage 数据在渲染层），
// 主进程将备份写入迁移标记，重启后 setPath 到新目录并恢复备份。
ipcMain.handle('data-dir-migrate', async (e, backup) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择新的数据保存目录',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  const newDir = filePaths[0];
  // 校验目录可写
  const probe = path.join(newDir, '.timetable-write-test');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    return { ok: false, error: '目标目录不可写：' + String((err && err.message) || err) };
  }
  // 写迁移标记（含备份数据）到当前 userData
  try {
    const markerDir = app.getPath('userData');
    fs.writeFileSync(
      path.join(markerDir, 'data-dir-marker.json'),
      JSON.stringify({ target: newDir, backup: backup || null }),
      'utf8'
    );
  } catch (err) {
    return { ok: false, error: '无法写入迁移标记：' + String((err && err.message) || err) };
  }
  return { ok: true, newDir, needRestart: true };
});

// ============ 局域网同步（P3.4）：配对 + 快照交换 ============
// 加密/墓碑合并在独立模块；本文件只做 IPC 桥接与生命周期管理。
// secret 存 userData/sync-secrets.json（不进 localStorage/备份）。
const syncServer = require('./main/sync-server');
syncServer.init(() => path.join(app.getPath('userData'), 'sync-secrets.json'));

// 本机设备信息（渲染层 deviceId 经 sync-hello 上报后主进程缓存，配对/同步握手复用）
let myDeviceInfo = { deviceId: '', name: os.hostname(), platform: process.platform };
ipcMain.on('sync-hello', (_e, deviceId) => {
  if (typeof deviceId === 'string' && deviceId) myDeviceInfo.deviceId = deviceId;
});

// A 侧「等待配对」：起临时服务 + 6 位码 + UDP 应答；成功配对后回推事件给渲染层
ipcMain.handle('sync-pair-start', async () => {
  try {
    const r = await syncServer.startPairWait(myDeviceInfo, (info) => {
      if (sidebar && !sidebar.isDestroyed()) sidebar.webContents.send('sync-paired', info);
    });
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
// B 侧发现等待中的设备（UDP 广播）
ipcMain.handle('sync-pair-scan', () => syncServer.scanPairingDevices());
// B 侧握手：输入配对码连接指定设备
ipcMain.handle('sync-pair-connect', (_e, o) => {
  const { ip, port, code } = o || {};
  return syncServer.pairConnect(ip, port, code, myDeviceInfo);
});
// 取消等待/关停服务
ipcMain.handle('sync-pair-stop', () => { syncServer.stopServer(); return { ok: true }; });
ipcMain.handle('sync-server-status', () => syncServer.serverStatus());

// 同步会话：发起方调 sync-send（渲染层组装好快照对象），返回对端快照
ipcMain.handle('sync-send', async (_e, payload) => {
  const { ip, port, peerDeviceId, snapshot } = payload || {};
  if (!ip || !port || !peerDeviceId) return { ok: false, error: 'params_missing' };
  // 先 hello 握手确认对端在线且密钥有效，再交换快照
  const hello = await syncServer.postEncrypted(ip, port, '/hello', peerDeviceId, { device: myDeviceInfo });
  if (!hello.ok) return { ok: false, error: 'hello_failed:' + hello.error };
  const ex = await syncServer.postEncrypted(ip, port, '/sync/exchange', peerDeviceId, snapshot || {});
  return ex;   // { ok:true, data: 对端快照 } 或 { ok:false, error }
});

// 服务侧：被对端连接时触发（渲染层提供合并后的本地快照回包）
// 渲染层通过 onSyncExchangeRequest 收到请求 → 处理后用 syncExchangeRespond 回包
let pendingExchange = null;   // { peerId, resolve }
ipcMain.handle('sync-listen', async () => {
  try {
    const r = await syncServer.startSyncServer(
      myDeviceInfo,
      null,   // hello 无需渲染层介入
      (peerId, remoteSnapshot) => new Promise((resolve) => {
        if (!sidebar || sidebar.isDestroyed()) { resolve({}); return; }
        pendingExchange = { peerId, resolve };
        sidebar.webContents.send('sync-exchange-request', { peerDeviceId: peerId, snapshot: remoteSnapshot });
        // 渲染层 20 秒内未响应 → 空快照兜底（不挂死对端）
        setTimeout(() => {
          if (pendingExchange && pendingExchange.peerId === peerId) {
            pendingExchange = null;
            resolve({});
          }
        }, 20000);
      })
    );
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.on('sync-exchange-respond', (_e, mySnapshot) => {
  if (pendingExchange) {
    const p = pendingExchange;
    pendingExchange = null;
    p.resolve(mySnapshot || {});
  }
});

// 查询/解绑：渲染层设备列表需要本机端口信息；解绑只删 secret（记录由渲染层删）
ipcMain.handle('sync-unpair', (_e, deviceId) => {
  syncServer.deleteSecret(deviceId);
  return { ok: true };
});

// ============ 全局快捷键（P3.3）：Ctrl+Alt+T 唤出/收起，Ctrl+Alt+N 快速添加 ============
// 注册失败（被其他程序占用）自动降级为关，返回实际生效状态；不做自由录制。
let hotkeyState = { toggle: true, quickadd: false };   // 默认：唤出开、快速添加关
function applyHotkeys() {
  globalShortcut.unregisterAll();
  if (hotkeyState.toggle) {
    const ok = globalShortcut.register('Control+Alt+T', () => {
      if (sidebar && !sidebar.isDestroyed()) toggleSidebarFromTray();
    });
    if (!ok) hotkeyState.toggle = false;   // 优雅降级
  }
  if (hotkeyState.quickadd) {
    const ok = globalShortcut.register('Control+Alt+N', () => {
      if (!sidebar || sidebar.isDestroyed()) return;
      fullscreenHidden = false;
      sidebar.show();
      expandSidebar();
      sidebar.webContents.send('shortcut-action', { action: 'quickadd' });
    });
    if (!ok) hotkeyState.quickadd = false;
  }
}
ipcMain.handle('hotkey-set', (_e, partial) => {
  hotkeyState = Object.assign(hotkeyState, partial || {});
  applyHotkeys();
  return { ok: true, active: Object.assign({}, hotkeyState) };   // 回传实际生效状态
});

// ============ 天气（主进程发起 HTTPS，绕开渲染层 CSP；免 Key 服务） ============
function requestJson(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'timetable-desktop/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        requestJson(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// ============ 外部日历订阅（P6.4/P9.2）：拉取 .ics 文本（条件请求 ETag/Last-Modified） ============
// 返回 { content, etag, lastModified }；304 时返回 { notModified:true, etag, lastModified }
function requestText(url, timeoutMs = 10000, redirects = 0, condHeaders = null) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const headers = Object.assign({ 'User-Agent': 'timetable-desktop/1.0' }, condHeaders || {});
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) { reject(new Error('重定向次数过多')); return; }
        // 跟随重定向时不带条件头（跨主机重定向回源更稳）
        requestText(res.headers.location, timeoutMs, redirects + 1, null).then(resolve, reject);
        return;
      }
      const etag = res.headers.etag || '';
      const lastModified = res.headers['last-modified'] || '';
      if (res.statusCode === 304) {
        res.resume();
        resolve({ notModified: true, etag, lastModified });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let raw = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) { req.destroy(new Error('日历文件过大（>5MB）')); return; }   // 防御异常大响应
        raw += c;
      });
      res.on('end', () => resolve({ content: raw, etag, lastModified }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}
// 拉取订阅 URL 的 .ics 原文；协议白名单 + 条件请求 + 错误文案化（渲染层只负责解析）
// opts: { etag, lastModified } → 带 If-None-Match / If-Modified-Since；源未变更返回 notModified
ipcMain.handle('cal-sub-fetch', async (_e, url, opts) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '订阅地址需以 http(s):// 开头' };
  const cond = {};
  if (opts && opts.etag) cond['If-None-Match'] = String(opts.etag);
  if (opts && opts.lastModified) cond['If-Modified-Since'] = String(opts.lastModified);
  try {
    const r = await requestText(u, 10000, 0, Object.keys(cond).length ? cond : null);
    if (r.notModified) return { ok: true, notModified: true, etag: r.etag || (opts && opts.etag) || '', lastModified: r.lastModified || (opts && opts.lastModified) || '' };
    return { ok: true, content: r.content, etag: r.etag || '', lastModified: r.lastModified || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// IP 粗略定位（多源 fallback，全部免 Key）
ipcMain.handle('weather-ip-location', async () => {
  // 源 1：ipwho.is（HTTPS）
  try {
    const j = await requestJson('https://ipwho.is/');
    if (j && j.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      return { ok: true, lat: j.latitude, lon: j.longitude, name: j.city || '当前位置' };
    }
  } catch { /* 尝试下一源 */ }
  // 源 2：ip-api.com（HTTP，中文城市名）
  try {
    const j = await requestJson('http://ip-api.com/json/?lang=zh-CN');
    if (j && j.status === 'ok' && typeof j.lat === 'number' && typeof j.lon === 'number') {
      return { ok: true, lat: j.lat, lon: j.lon, name: j.city || '当前位置' };
    }
  } catch { /* 尝试下一源 */ }
  // 源 3：ipapi.co（HTTPS）
  try {
    const j = await requestJson('https://ipapi.co/json/');
    if (j && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      return { ok: true, lat: j.latitude, lon: j.longitude, name: j.city || j.region || '当前位置' };
    }
  } catch { /* 全部失败 */ }
  return { ok: false, error: '定位服务暂不可用，可手动搜索城市' };
});

// 按坐标查询实时天气（open-meteo，无需 Key）
ipcMain.handle('weather-query', async (_e, { lat, lon }) => {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&wind_speed_unit=kmh&timezone=auto';
    const j = await requestJson(url);
    if (!j || !j.current) return { ok: false, error: '天气数据不可用' };
    return { ok: true, current: j.current };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 城市名搜索（open-meteo geocoding）
ipcMain.handle('weather-search', async (_e, q) => {
  try {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=zh&name=' + encodeURIComponent(q);
    const j = await requestJson(url);
    const results = (j.results || []).map(r => ({
      name: [r.name, r.admin1, r.country].filter(Boolean).join(' · '),
      lat: r.latitude, lon: r.longitude
    }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ============ 系统资源（CPU 两次采样差值 + 内存 + 运行时长） ============
function cpuTimesSnapshot() {
  return os.cpus().map(c => {
    const t = c.times;
    return t.user + t.nice + t.sys + t.irq + t.idle;
  });
}
ipcMain.handle('sys-stats', async () => {
  const before = cpuTimesSnapshot();
  const idleBefore = os.cpus().map(c => c.times.idle);
  await new Promise(r => setTimeout(r, 220));
  const after = cpuTimesSnapshot();
  const idleAfter = os.cpus().map(c => c.times.idle);
  let busySum = 0, totalSum = 0;
  for (let i = 0; i < after.length; i++) {
    const total = after[i] - before[i];
    const idle = idleAfter[i] - idleBefore[i];
    totalSum += total;
    busySum += Math.max(0, total - idle);
  }
  const cpuPct = totalSum > 0 ? Math.round(busySum / totalSum * 100) : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    ok: true,
    cpu: cpuPct,
    memPct: Math.round((1 - freeMem / totalMem) * 100),
    memUsedGB: ((totalMem - freeMem) / 1073741824).toFixed(1),
    memTotalGB: (totalMem / 1073741824).toFixed(1),
    cores: os.cpus().length,
    uptimeSec: os.uptime(),
    hostname: os.hostname()
  };
});

// ============ 剪贴板历史（主进程轮询，去重，推送给渲染层；本地持久化） ============
const CLIP_MAX = 30;
const clipHistory = [];
let clipEnabled = true;        // 渲染层"剪贴板历史"开关（关闭 = 暂停记录，不清空历史）
let clipSaveTimer = null;

function clipStorePath() {
  return path.join(app.getPath('userData'), 'clipboard-history.json');
}

// 启动时从磁盘恢复历史（仅文本；坏文件静默忽略）
function loadClipHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(clipStorePath(), 'utf8'));
    if (Array.isArray(arr)) {
      for (const t of arr) {
        if (typeof t === 'string' && t.trim()) clipHistory.push(t);
      }
      if (clipHistory.length > CLIP_MAX) clipHistory.length = CLIP_MAX;
    }
  } catch { /* 首次运行或文件损坏 → 从空开始 */ }
}

// 防抖写盘：剪贴板内容仅保存在本机，不写任何日志
function persistClip() {
  if (clipSaveTimer) clearTimeout(clipSaveTimer);
  clipSaveTimer = setTimeout(() => {
    clipSaveTimer = null;
    try {
      fs.writeFileSync(clipStorePath(), JSON.stringify(clipHistory), 'utf8');
    } catch { /* 写盘失败不影响运行，下次变更再试 */ }
  }, 800);
}

function broadcastClipboard() {
  if (sidebar && !sidebar.isDestroyed()) {
    sidebar.webContents.send('clipboard-update', clipHistory.slice());
  }
}

// Electron 44 起 clipboard 模块改为 W3C 风格异步 API：readText()/writeText() 返回 Promise，
// 且移除了同步版本。旧版 Electron 的 readText() 同步返回字符串（await 字符串结果幂等），
// 故统一用 async/await，一套代码兼容新旧版本。
async function readClipboardText() {
  return await clipboard.readText();
}

let clipReading = false;   // 异步读取串行化：上一次未返回时跳过本轮，避免并发乱序
async function pollClipboard() {
  if (!clipEnabled) return;                     // 开关关闭 → 暂停记录
  if (clipReading) return;
  clipReading = true;
  try {
    let text;
    try { text = await readClipboardText(); } catch { return; }
    if (typeof text !== 'string') return;       // 非文本剪贴板内容（如复制文件）→ 忽略
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) return;
    if (clipHistory[0] === text) return;        // 与最新一条相同（含自己回填）→ 忽略
    const idx = clipHistory.indexOf(text);      // 重复项提到最前
    if (idx >= 0) clipHistory.splice(idx, 1);
    clipHistory.unshift(text);
    if (clipHistory.length > CLIP_MAX) clipHistory.length = CLIP_MAX;
    broadcastClipboard();
    persistClip();
  } finally {
    clipReading = false;
  }
}

ipcMain.handle('clipboard-list', () => clipHistory.slice());
ipcMain.on('clipboard-copy', (_e, text) => {
  // Electron 44 起 writeText 返回 Promise；Promise.resolve 同时兼容旧版同步实现
  Promise.resolve(clipboard.writeText(String(text))).catch(() => { /* 写入失败忽略 */ });
});
ipcMain.on('clipboard-clear', () => {
  clipHistory.length = 0;
  broadcastClipboard();
  persistClip();
});
// 删除单条（历史内文本唯一，按文本定位）
ipcMain.on('clipboard-delete', (_e, text) => {
  const i = clipHistory.indexOf(String(text));
  if (i >= 0) {
    clipHistory.splice(i, 1);
    broadcastClipboard();
    persistClip();
  }
});
// 开关同步（渲染层设置面板）
ipcMain.on('clipboard-enabled', (_e, on) => {
  clipEnabled = !!on;
});

// ============ 开机自动启动（Windows: Run 注册表 / macOS: 登录项；UI 与平台解耦） ============
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('autostart-get', () => {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
});
ipcMain.on('autostart-set', (_e, on) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      openAsHidden: !!on,          // 仅 macOS 生效，Windows 自动忽略
      path: resolveLaunchExe(process.execPath, process.env),   // 便携版用真实 exe 路径（见 launch-path.js）
      args: []
    });
  } catch { /* 个别环境（便携目录权限等）设置失败时静默 */ }
});

// ============ 语音输入（Windows SAPI 5，System.Speech） ============
// 通过 PowerShell 子进程调用 SAPI，stdin 发指令、stdout 收 JSON 结果。
// 隐私：SAPI 在本机识别，音频不出本机；PS 子进程退出即释放资源。
const VOICE_PS_PATH = path.join(__dirname, 'services', 'voice', 'sapi-recognizer.ps1');
let voiceProc = null;            // 当前 PS 子进程（启动后保留，复用多次识别）
let voiceState = 'idle';         // 当前状态：idle / recording / processing / error
let voiceLang = 'zh-CN';

function voiceSend(channel, payload) {
  if (sidebar && !sidebar.isDestroyed()) {
    sidebar.webContents.send(channel, payload);
  }
}
function voiceSetState(state) {
  voiceState = state;
  voiceSend('voice-state', state);
}
function voiceKillProc() {
  if (voiceProc) {
    try { voiceProc.stdin && voiceProc.stdin.end(); } catch {}
    try { voiceProc.kill(); } catch {}
    voiceProc = null;
  }
}

ipcMain.handle('voice-status', async () => {
  // Windows：脚本存在即视为可用；非 Windows 不支持
  const available = process.platform === 'win32' && fs.existsSync(VOICE_PS_PATH);
  return {
    state: voiceState,
    available,
    message: available ? '' : (process.platform === 'win32' ? '语音识别脚本缺失' : '当前平台不支持语音输入（仅 Windows）')
  };
});

ipcMain.on('voice-start', (_e, options) => {
  if (process.platform !== 'win32') {
    voiceSend('voice-error', { code: 'platform_unsupported', message: '当前平台不支持语音输入（仅 Windows）' });
    return;
  }
  if (!fs.existsSync(VOICE_PS_PATH)) {
    voiceSend('voice-error', { code: 'not_installed', message: '语音识别脚本缺失' });
    return;
  }
  voiceLang = (options && options.language) || 'zh-CN';

  // 已有进程：复用，发送 start 指令触发单次识别
  if (voiceProc && !voiceProc.killed && voiceProc.stdin && !voiceProc.stdin.destroyed) {
    try {
      voiceProc.stdin.write('start\n');
      voiceSetState('processing');
    } catch {
      voiceKillProc();
      // 下方会重启
    }
    if (voiceProc) return;
  }

  // 启动新 PS 子进程
  try {
    voiceProc = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive',
      '-File', VOICE_PS_PATH,
      '-Lang', voiceLang
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    voiceSend('voice-error', { code: 'spawn_failed', message: String(e && e.message || e) });
    voiceSetState('error');
    return;
  }

  let buf = '';
  voiceProc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'ready') {
          // 进程就绪：发送 start 触发首次识别
          try { voiceProc.stdin.write('start\n'); } catch {}
          voiceSetState('processing');
        } else if (msg.event === 'recognized') {
          voiceSend('voice-result', { text: msg.text, isFinal: true, confidence: msg.confidence || 0 });
          voiceSetState('idle');
        } else if (msg.event === 'no_speech') {
          voiceSend('voice-error', { code: 'no_speech', message: '未识别到语音' });
          voiceSetState('idle');
        } else if (msg.event === 'error') {
          voiceSend('voice-error', { code: 'recognize_failed', message: msg.error || '识别失败' });
          voiceSetState('idle');   // 单次识别失败不致命，保留进程待下次
        } else if (msg.event === 'fatal') {
          voiceSend('voice-error', { code: 'recognize_failed', message: msg.error || '引擎初始化失败' });
          voiceSetState('error');
          voiceKillProc();
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  voiceProc.stderr.on('data', () => { /* PS 诊断信息，不暴露给渲染层 */ });
  voiceProc.on('exit', () => {
    if (voiceState !== 'error') voiceSetState('idle');
    voiceProc = null;
  });
  voiceProc.on('error', (err) => {
    voiceSend('voice-error', { code: 'proc_error', message: String(err && err.message || err) });
    voiceSetState('error');
    voiceProc = null;
  });
});

ipcMain.on('voice-stop', () => {
  // 同步识别模式无法中断单次识别；kill 子进程以强制结束，下次 start 会重启
  voiceKillProc();
  voiceSetState('idle');
});

// ============ 系统托盘 ============
function createTray() {
  let icon = nativeImage.createEmpty();
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  try {
    if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath);
  } catch { /* 图标缺失时用空图，托盘仍可用 */ }

  tray = new Tray(icon);
  tray.setToolTip('日程侧边栏');

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 收起侧边栏', click: toggleSidebarFromTray },
    { label: '设置', click: openSettingsFromTray },
    { type: 'separator' },
    { label: '退出', click: quitApp }
  ]);
  tray.setContextMenu(menu);

  // Windows：左键 = 唤起/收起；macOS 设置了右键菜单后左键即弹菜单（平台差异，菜单项可用）
  tray.on('click', toggleSidebarFromTray);
}

// 托盘左键 / 菜单"显示"：隐藏时唤起（hidden 模式直接展开），可见时展开/收起切换（编辑态不收回，保护表单）
function toggleSidebarFromTray() {
  if (!sidebar || sidebar.isDestroyed()) return;
  if (fullscreenHidden) {
    fullscreenHidden = false;
    collapseSidebar(true);
    if (uiConfig.mode !== 'hidden') sidebar.showInactive();
    return;
  }
  if (!sidebar.isVisible()) {
    if (uiConfig.mode === 'hidden') { sidebar.show(); expandSidebar(); return; }
    sidebar.show();
    return;
  }
  if (expanded) {
    if (editing) return;
    collapseSidebar(false);
  } else {
    expandSidebar();
  }
}

// 托盘菜单"设置"：展开侧栏并打开设置工具
function openSettingsFromTray() {
  if (!sidebar || sidebar.isDestroyed()) return;
  fullscreenHidden = false;
  sidebar.show();
  expandSidebar();
  sidebar.webContents.send('tray-action', { action: 'settings' });
}

// 通知点击直达（P4.1）：唤起窗口并展开侧栏，渲染层随后定位具体事项
ipcMain.on('show-window', () => {
  if (!sidebar || sidebar.isDestroyed()) return;
  fullscreenHidden = false;
  if (!sidebar.isVisible()) sidebar.show();
  expandSidebar();
});

// 托盘菜单"退出"：真正结束进程（close 钩子对 isQuiting 放行）
function quitApp() {
  app.isQuiting = true;
  app.quit();
}

function expandSidebar() {
  expanded = true;
  if (edgeDwellTimer) { clearTimeout(edgeDwellTimer); edgeDwellTimer = null; }
  sidebar.setBounds(expandedRect());
  sendStateChange();
}

// silent=true 表示仅复位几何/状态，不发送 IPC
function collapseSidebar(silent) {
  expanded = false;
  sidebar.setBounds(collapsedRect());
  if (!silent) sendStateChange();
  // hidden 模式：收起即整体隐藏，靠贴边停留或托盘再次唤出
  if (uiConfig.mode === 'hidden' && sidebar.isVisible()) sidebar.hide();
}

// ============ App 生命周期 ============
// 数据目录迁移标记：启动时若存在则 setPath 到目标目录，并把备份数据发给渲染层恢复
let pendingMigrateBackup = null;
function processDataDirMarker() {
  const defaultData = app.getPath('userData');
  const markerPath = path.join(defaultData, 'data-dir-marker.json');
  if (!fs.existsSync(markerPath)) return;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (marker && typeof marker.target === 'string' && fs.existsSync(marker.target)) {
      app.setPath('userData', marker.target);
      pendingMigrateBackup = marker.backup || null;
      fs.unlinkSync(markerPath);   // 消费掉标记，避免重复迁移
    }
  } catch { /* 标记损坏则忽略，保持默认目录 */ }
}

// 沙箱双实例：--user-data-dir=<目录> 隔离数据目录（dev:sync-a/b 用），必须在 ready 前 setPath
{
  const udArg = process.argv.find(a => a.startsWith('--user-data-dir='));
  if (udArg) {
    const dir = udArg.slice('--user-data-dir='.length);
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); app.setPath('userData', dir); } catch { /* 失败用默认 */ } }
  }
  // 沙箱设备名：--device-name=<名字> 覆盖主机名（区分同机双实例）
  const dnArg = process.argv.find(a => a.startsWith('--device-name='));
  if (dnArg) { const n = dnArg.slice('--device-name='.length); if (n) myDeviceInfo.name = n; }
}

app.whenReady().then(() => {
  processDataDirMarker();      // 必须在所有读取 userData 的操作之前
  electronPid = process.pid;
  // macOS：这是贴边小部件而非普通应用，不占用 Dock 图标（对应 Windows 的 skipTaskbar）
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  loadUiConfig();               // 恢复侧边栏停靠侧/显示模式（建窗前读取，避免启动跳动）
  loadClipHistory();            // 恢复上次剪贴板历史
  setInterval(pollClipboard, 1000);
  createSidebar();
  createTray();
  applyHotkeys();               // 全局快捷键：默认注册唤出键（渲染层加载后同步设置覆盖）
  startFullscreenCheck();

  // 多显示器：显示器增删/分辨率变化时重新定位侧边栏
  screen.on('display-added', () => { applyUiConfig(); });
  screen.on('display-metrics-changed', () => { applyUiConfig(); });
  screen.on('display-removed', () => {
    const ids = new Set(screen.getAllDisplays().map(d => d.id));
    if (typeof uiConfig.displayId === 'number' && !ids.has(uiConfig.displayId)) {
      // 当前显示器已断开，回退到主屏
      uiConfig.displayId = screen.getPrimaryDisplay().id;
      saveUiConfig();
    }
    applyUiConfig();
  });

  // 数据目录迁移后：把备份数据发给渲染层恢复 localStorage
  if (pendingMigrateBackup && sidebar && !sidebar.isDestroyed()) {
    sidebar.webContents.once('did-finish-load', () => {
      sidebar.webContents.send('data-migrate-restore', pendingMigrateBackup);
      pendingMigrateBackup = null;
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSidebar();
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
  try { globalShortcut.unregisterAll(); } catch { /* 退出阶段反注册失败可忽略 */ }
  try { syncServer.stopServer(); } catch { /* 同步服务关停失败可忽略 */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
