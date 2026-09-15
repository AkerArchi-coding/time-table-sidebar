const { app, BrowserWindow, screen, ipcMain, dialog, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const koffi = require('koffi');

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
  } catch { /* 首次运行或文件损坏 → 保持默认 */ }
}
function saveUiConfig() {
  try { fs.writeFileSync(uiConfigPath(), JSON.stringify(uiConfig), 'utf8'); } catch { /* 写盘失败下次再试 */ }
}

// 收起态几何：rail = 全高窄条；mini = 半高窄条（垂直居中，Dock 感）
function collapsedRect() {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = uiConfig.side === 'left' ? wa.x : wa.x + wa.width - NARROW_W;
  if (uiConfig.mode === 'mini') {
    const h = Math.floor(wa.height / 2);
    return { x, y: wa.y + Math.floor((wa.height - h) / 2), width: NARROW_W, height: h };
  }
  return { x, y: wa.y, width: NARROW_W, height: wa.height };
}
// 展开态几何：全高面板，贴靠当前停靠侧
function expandedRect() {
  const wa = screen.getPrimaryDisplay().workArea;
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
ipcMain.handle('autostart-get', () => {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
});
ipcMain.on('autostart-set', (_e, on) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      openAsHidden: !!on,          // 仅 macOS 生效，Windows 自动忽略
      path: process.execPath,
      args: []
    });
  } catch { /* 个别环境（便携目录权限等）设置失败时静默 */ }
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
app.whenReady().then(() => {
  electronPid = process.pid;
  // macOS：这是贴边小部件而非普通应用，不占用 Dock 图标（对应 Windows 的 skipTaskbar）
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  loadUiConfig();               // 恢复侧边栏停靠侧/显示模式（建窗前读取，避免启动跳动）
  loadClipHistory();            // 恢复上次剪贴板历史
  setInterval(pollClipboard, 1000);
  createSidebar();
  createTray();
  startFullscreenCheck();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSidebar();
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
