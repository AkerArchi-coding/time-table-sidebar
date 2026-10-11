const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ============ 分类 & 紧急程度配置 ============
const CATEGORIES = {
  work:    { label: '工作',     color: '#4a90d9' },   // 蓝色
  personal:{ label: '个人事务', color: '#9b59b6' },   // 紫色
  family:  { label: '家庭事务', color: '#8b6914' }    // 棕色
};
const URGENCIES = {
  urgent: { label: '紧急', color: '#e74c3c' },   // 红色
  normal: { label: '一般', color: '#f1c40f' },   // 黄色
  loose:  { label: '松散', color: '#2ecc71' }    // 绿色
};
// 项目优先级（三档枚举，默认中）
const PRIORITIES = {
  high:   { label: '高优先', color: '#e74c3c' },
  medium: { label: '中优先', color: '#f1c40f' },
  low:    { label: '低优先', color: '#2ecc71' }
};
function projectPriority(p) { return PRIORITIES[p && p.priority] || PRIORITIES.medium; }

const $ = (id) => document.getElementById(id);
const sidebar = $('sidebar');
const railEl = $('rail');
const railTime = $('railTime'), railDate = $('railDate');
const bigDate = $('bigDate'), bigWeekday = $('bigWeekday');
const headerActions = $('headerActions');
const viewTabs = $('viewTabs');
const weekList = $('weekList');
const ctxMenu = $('ctxMenu');

// 显示范围起始日：今天前1天（即昨天）
// 共显示 8 天：起始日 + 7 天（即下周同一天）
// 翻页时整体前后移动 7 天（滚动轮换）
let rangeStart = addDays(stripTime(new Date()), -1);
const RANGE_DAYS = 8;          // 显示天数：起始日 + 7
const PAGE_STEP = 7;           // 翻页步长

// ============ 视图状态 ============
let currentView = 'today';         // today | projects | tasks | calendar
let expandedProjectId = null;      // 项目页同层展开的项目 id（手风琴，同时只展开一个）
const projectDetailModes = {};     // 各项目内联面板的子模式：list | gantt（默认 list）
let calendarMode = 'calendar';     // 日历页显示模式：calendar（日历）| gantt（总览甘特）| month（月历，P4.2）
let monthAnchor = new Date();      // 月历当前锚点（仅年月有效，P4.2）
let syncState = null;              // 项目文件同步预览状态（导入/合并进行中，switchView 时清除）
let currentTool = null;            // 当前打开的侧边栏工具（内容区覆盖层），null=显示视图

// ============ 日期工具 ============
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function stripTime(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}
function today() { return new Date(); }

// ============ 日期区间工具 ============
// 'YYYY-MM-DD' → 本地零点 Date（避免 new Date(str) 的 UTC 偏移）
function parseDateKey(key) {
  if (!key) return null;
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// 日期 key 加减天数
function addDaysKey(key, n) {
  return dateKey(addDays(parseDateKey(key), n));
}
// 持续天数：首尾都计入，9/15～9/15 = 1，9/15～9/20 = 6
function durationDays(startKey, endKey) {
  if (!startKey && !endKey) return 0;
  const s = startKey || endKey, e = endKey || startKey;
  return Math.round((parseDateKey(e) - parseDateKey(s)) / 86400000) + 1;
}
// 事项的开始/结束日（兼容老数据）
function eventStart(ev) { return ev.startDate || ev.date || ''; }
function eventEnd(ev) { return ev.endDate || ev.date || ''; }
// 事项在某一天是否处于执行区间内
function eventSpansDate(ev, key) {
  const s = eventStart(ev);
  if (!s) return false;
  const e = eventEnd(ev) || s;
  return s <= key && key <= e;
}
// 'YYYY-MM-DD' → 'M/D'
function fmtShort(key) {
  return `${+key.slice(5, 7)}/${+key.slice(8, 10)}`;
}

// ============ 数据存取 ============
// 事项（Task）：projectId 为空表示未归类
// 缓存策略：首次读盘后常驻内存，saveEvents 写穿更新缓存（读多写少，消除每次 JSON.parse）
let eventsCache = null;
function loadEvents() {
  if (eventsCache) return eventsCache;
  try {
    const list = JSON.parse(localStorage.getItem('events') || '[]');
    // 数据迁移兜底：补齐新字段
    for (const ev of list) {
      if (ev.projectId === undefined) ev.projectId = null;
      if (ev.description === undefined) ev.description = '';
      // 老数据只有单日期 date → 起止日期相同
      if (ev.startDate === undefined) ev.startDate = ev.date || '';
      if (ev.endDate === undefined) ev.endDate = ev.date || '';
      // 纠正异常区间（结束早于开始 → 交换）
      if (ev.startDate && ev.endDate && ev.endDate < ev.startDate) {
        const t = ev.startDate; ev.startDate = ev.endDate; ev.endDate = t;
      }
      // 番茄钟累计完成数（绑定事项后，每完成一个专注 +1）
      if (ev.pomoCount === undefined) ev.pomoCount = 0;
      // 提醒：提前分钟数 / 贪睡截止时间戳
      if (ev.remindAhead === undefined) ev.remindAhead = 0;
      if (ev.snoozeUntil === undefined) ev.snoozeUntil = 0;
      // 同步预留：最后同步时间
      if (ev.lastSyncAt === undefined) ev.lastSyncAt = '';
      // 重复规则（P3.2）：null = 不重复；命中日由虚拟投影动态生成
      if (ev.recur === undefined) ev.recur = null;
      // 标签（P3.3）：字符串数组，用于今日/事项视图筛选
      if (!Array.isArray(ev.tags)) ev.tags = [];
    }
    eventsCache = list;
    return list;
  } catch { eventsCache = []; return eventsCache; }
}
function saveEvents(list) {
  eventsCache = Array.isArray(list) ? list : [];
  localStorage.setItem('events', JSON.stringify(eventsCache));
}
// ---- 重复事项（P3.2）：不物理展开副本，按日虚拟投影 ----
const RECUR_FREQS = ['daily', 'weekdays', 'weekly', 'monthly'];
const RECUR_FREQ_LABELS = { none: '不重复', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' };

// 事项是否启用了有效重复规则
function isRecurOn(ev) {
  return !!(ev && ev.recur && RECUR_FREQS.includes(ev.recur.freq));
}

// 判断重复规则是否命中目标日期（startKey/targetKey 均为 YYYY-MM-DD）
// 规则：起始日必命中（保证锚点日可见）；目标早于起始不命中；until 截止（含当天）；无开始日不投影
function recurMatchesDate(recur, startKey, targetKey) {
  if (!recur || !RECUR_FREQS.includes(recur.freq)) return false;
  if (!startKey || !targetKey) return false;
  if (targetKey < startKey) return false;
  if (recur.until && targetKey > recur.until) return false;
  if (targetKey === startKey) return true;   // 起始日恒命中（weekdays 规则起始日为周末时也可见）
  const s = parseDateKey(startKey), t = parseDateKey(targetKey);
  const freq = recur.freq;
  if (freq === 'daily') {
    const iv = Math.max(1, Number(recur.interval) || 1);
    return Math.round((t - s) / 86400000) % iv === 0;
  }
  if (freq === 'weekdays') {
    const wd = t.getDay();
    return wd >= 1 && wd <= 5;
  }
  if (freq === 'weekly') {
    const iv = Math.max(1, Number(recur.interval) || 1);
    if (t.getDay() !== s.getDay()) return false;
    return Math.round((t - s) / 86400000) % (7 * iv) === 0;
  }
  if (freq === 'monthly') {
    // 月中同日号；目标月没有该日号自然不命中（如 1/31 在 2 月）
    return t.getDate() === s.getDate();
  }
  return false;
}

// 重复事项完成态（按日 override，key = 模板id|日期；勾选虚拟事项只写这里，不改模板 done）
let recurDoneCache = null;
function loadRecurDone() {
  if (recurDoneCache) return recurDoneCache;
  try { recurDoneCache = JSON.parse(localStorage.getItem('recurDone') || '{}'); }
  catch { recurDoneCache = {}; }
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
  localStorage.setItem('recurDone', JSON.stringify(map));
}

// 生成某日虚拟事项视图：复制模板字段 + 复合 id + 覆盖完成态（纯视图对象，不改模板数据）
function makeVirtualEvent(ev, key) {
  return {
    ...ev,
    id: ev.id + '@' + key,        // 复合键：模板id@日期
    _templateId: ev.id,
    _recurDate: key,
    date: key, startDate: key, endDate: key,
    done: recurDoneGet(ev.id, key)
  };
}

function getEventsByDate(key) {
  const list = [];
  for (const ev of loadEvents()) {
    if (isRecurOn(ev)) {
      // 重复事项：起始日及后续命中日统一走虚拟投影（完成态按日记录，三处口径一致）
      if (recurMatchesDate(ev.recur, eventStart(ev), key)) list.push(makeVirtualEvent(ev, key));
    } else if (eventSpansDate(ev, key)) {
      list.push(ev);              // 多日事项在覆盖的每一天都显示
    }
  }
  return sortDayEvents(list);
}
// 按开始日期排序（无日期排最后），再按时间
function sortEvents(list) {
  return [...list].sort((a, b) => {
    const da = eventStart(a), db = eventStart(b);
    if (!!da !== !!db) return da ? -1 : 1;
    if (da !== db) return (da || '').localeCompare(db || '');
    return (a.time || '').localeCompare(b.time || '');
  });
}

// ---- 单日事项排序（仅显示层，不改任何任务数据；甘特图走 sortEvents 不受影响） ----
// by: 'start' 开始时间(time) / 'end' 结束日期(endDate，本项目无结束时刻字段) / 'urgency' 重要程度
function loadDaySort() {
  try {
    const s = JSON.parse(localStorage.getItem('daySort') || '{}');
    return { by: ['start', 'end', 'urgency'].includes(s.by) ? s.by : 'start', dir: s.dir === 'desc' ? 'desc' : 'asc' };
  } catch { return { by: 'start', dir: 'asc' }; }
}
function saveDaySort() {
  localStorage.setItem('daySort', JSON.stringify(daySort));
}
let daySort = loadDaySort();   // 默认：开始时间正序；Array.prototype.sort 为稳定排序，同键保持原顺序

function sortDayEvents(list) {
  const dirMul = daySort.dir === 'desc' ? -1 : 1;
  const timeOf = e => (e.time || '').trim();
  const URGE_W = { urgent: 0, normal: 1, loose: 2 };
  const cmp = {
    start: (a, b) => {
      const ta = timeOf(a), tb = timeOf(b);
      if (!ta && !tb) return 0;
      if (!ta) return 1;                        // 无开始时间固定末尾（不随方向翻转）
      if (!tb) return -1;
      return ta.localeCompare(tb) * dirMul;
    },
    end: (a, b) => {
      const ea = eventEnd(a), eb = eventEnd(b);
      if (!ea && !eb) return 0;
      if (!ea) return 1;                        // 无结束日期固定末尾
      if (!eb) return -1;
      return ea.localeCompare(eb) * dirMul;
    },
    urgency: (a, b) => {
      const ua = URGE_W[a.urgency] === undefined ? 1 : URGE_W[a.urgency];
      const ub = URGE_W[b.urgency] === undefined ? 1 : URGE_W[b.urgency];
      if (ua !== ub) return (ua - ub) * dirMul; // 正序 = 紧急→一般→松散
      const ta = timeOf(a), tb = timeOf(b);     // 同级第二规则：开始时间正序
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta.localeCompare(tb);
    }
  };
  return [...list].sort(cmp[daySort.by] || cmp.start);
}

// 项目（Project）：1 → N 事项（缓存策略同 loadEvents）
let projectsCache = null;
function loadProjects() {
  if (projectsCache) return projectsCache;
  try {
    const list = JSON.parse(localStorage.getItem('projects') || '[]');
    // 数据迁移兜底：补齐起止时间与分类
    for (const p of list) {
      if (p.startDate === undefined) p.startDate = '';
      if (p.endDate === undefined) p.endDate = '';
      if (p.category === undefined) p.category = 'work';
      if (p.revision === undefined) p.revision = 1;                 // 同步版本号（导出/修改递增）
      if (p.updatedAt === undefined) p.updatedAt = p.createdAt || '';
      if (p.startDate && p.endDate && p.endDate < p.startDate) {
        const t = p.startDate; p.startDate = p.endDate; p.endDate = t;
      }
    }
    projectsCache = list;
    return list;
  }
  catch { projectsCache = []; return projectsCache; }
}
function saveProjects(list) {
  projectsCache = Array.isArray(list) ? list : [];
  localStorage.setItem('projects', JSON.stringify(projectsCache));
}
function getProject(id) {
  return loadProjects().find(p => p.id === id) || null;
}
function getProjectTasks(pid) {
  return sortEvents(loadEvents().filter(e => e.projectId === pid));
}
function projectProgress(pid) {
  const tasks = loadEvents().filter(e => e.projectId === pid);
  return { done: tasks.filter(t => t.done).length, total: tasks.length };
}

// 项目起止时间文本：'9/15~9/20' / '9/15' / '未设时间'
function projectRangeText(p) {
  const s = p.startDate, e = p.endDate;
  if (!s && !e) return '未设时间';
  if (s && e && e !== s) return `${fmtShort(s)}~${fmtShort(e)}`;
  return fmtShort(s || e);
}
// 项目分类配置（沿用事项分类颜色）
function projectCategory(p) {
  return CATEGORIES[p.category] || CATEGORIES.work;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 项目下拉选项 HTML（value="" 表示未归类）
function projectOptionsHtml(selectedId) {
  let html = `<option value="" ${!selectedId ? 'selected' : ''}>未归类</option>`;
  for (const p of loadProjects()) {
    html += `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`;
  }
  return html;
}

// ============ 时钟 ============
function renderClock() {
  const d = new Date();
  railTime.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  railDate.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
}

// ============ 视图路由 ============
function switchView(v) {
  // 手动切换视图时放弃进行中的同步预览（面板只挂在项目视图顶部）
  discardSyncPreview();
  closeTool();                       // 切回视图 = 退出工具覆盖层
  if (batchMode) { batchMode = false; batchSel.clear(); }   // 离开事项视图即退出批量模式
  currentView = v;
  render();
}

// 设置面板头部：标题/副标题/是否显示翻页按钮
function setHeader(title, sub, showNav) {
  bigDate.textContent = title;
  bigWeekday.textContent = sub;
  headerActions.style.display = showNav ? 'flex' : 'none';
}

function render() {
  ensureDateRollover();   // 跨天驻留后先校正日期锚点，再重画

  // tab 高亮
  viewTabs.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
  });
  // rail 图标选中态（工具打开时导航不高亮，工具图标高亮）
  railEl.querySelectorAll('.rail-icon[data-view]').forEach(btn => {
    btn.classList.toggle('active', !currentTool && btn.dataset.view === currentView);
  });
  railEl.querySelectorAll('.rail-icon[data-tool]').forEach(btn => {
    btn.classList.toggle('active', currentTool === btn.dataset.tool);
  });
  document.querySelectorAll('.strip-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', currentTool === btn.dataset.tool);
  });

  // 工具覆盖层优先（不改动 currentView，返回即回原视图）
  if (currentTool) { renderTool(); return; }

  // 重建列表前记住滚动位置，重建后恢复（避免 60s 自动刷新等触发时跳顶）
  const scrollPos = weekList.scrollTop;

  switch (currentView) {
    case 'today': renderToday(); break;
    case 'projects': renderProjects(); break;
    case 'tasks': renderTasks(); break;
    case 'calendar': renderWeek(); break;
  }

  weekList.scrollTop = scrollPos;
}

// ============ 事项标签（P3.3）：逗号分隔输入，仅本机筛选用 ============
const TAG_MAX = 6;        // 单个事项最多标签数
const TAG_LEN_MAX = 12;   // 单个标签最长字符
// "工作, 重要，加班" → ['工作','重要','加班']（中英文逗号均支持，去空去重截断）
function parseTags(str) {
  const seen = new Set();
  const out = [];
  for (let t of String(str || '').split(/[,，]/)) {
    t = t.trim().slice(0, TAG_LEN_MAX);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    if (out.length >= TAG_MAX) break;
  }
  return out;
}
// 汇总所有事项出现过的标签（去重，中文排序）→ 供筛选 chips
function collectTags() {
  const seen = new Set();
  for (const ev of loadEvents()) {
    for (const t of (ev.tags || [])) seen.add(t);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, 'zh'));
}
// 按标签筛选事项列表（tag 为空原样返回）
function filterByTag(list, tag) {
  if (!tag) return list;
  return list.filter(ev => Array.isArray(ev.tags) && ev.tags.includes(tag));
}

// ============ 事项检查清单（P6.2）：子任务 ============
// ev.checklist 为可选字段：[{ id, text, done }]，缺省 = 无子任务（旧数据零迁移）；
// 子任务不级联完成主事项、不进统计、不支持嵌套；随事项 updatedAt 走 LWW 同步（不动 normTaskSnap 白名单）
// 进度：无子任务返回 null；否则 { done, total }（事项行角标与表单共用口径）
function checklistProgress(ev) {
  const ck = ev && ev.checklist;
  if (!Array.isArray(ck) || !ck.length) return null;
  return { done: ck.filter(c => c && c.done).length, total: ck.length };
}
// 子任务 id：时间戳 + 随机（与事项 id 同风格）
function mkCkId() {
  return 'ck' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============ 公共构建器 ============
// 事项条目（opts.showDate: 显示日期徽标 / opts.showProject: 显示项目徽标）
function buildEventItem(ev, opts = {}) {
  const cat = CATEGORIES[ev.category] || CATEGORIES.work;
  const urg = URGENCIES[ev.urgency] || URGENCIES.normal;

  const item = document.createElement('div');
  item.className = 'event-item' + (ev.done ? ' done' : '');
  item.dataset.id = ev.id;
  item.style.borderLeftColor = cat.color;   // 分类竖条颜色

  let badges = '';
  if (isRecurOn(ev)) {
    const r = ev.recur;
    const rl = RECUR_FREQ_LABELS[r.freq] || '重复';
    badges += `<span class="event-recur-badge" title="${rl}重复${r.until ? '，至 ' + r.until : ''}">🔁</span>`;
  }
  // 标签徽标（P3.3）：最多显示 2 个，超出折叠为 +N（悬停看全量）
  if (Array.isArray(ev.tags) && ev.tags.length) {
    const shown = ev.tags.slice(0, 2);
    badges += shown.map(t => `<span class="event-tag-badge">${escapeHtml(t)}</span>`).join('');
    if (ev.tags.length > shown.length) {
      const rest = ev.tags.slice(shown.length).join(', ');
      badges += `<span class="event-tag-badge tag-more" title="${escapeHtml(rest)}">+${ev.tags.length - shown.length}</span>`;
    }
  }
  if (opts.showDate) {
    const s = eventStart(ev), e = eventEnd(ev);
    let d = '—';
    if (s) d = (e && e !== s) ? `${fmtShort(s)}~${fmtShort(e)}` : fmtShort(s);
    badges += `<span class="event-date-badge">${d}</span>`;
  }
  if (opts.showProject) {
    const p = ev.projectId ? getProject(ev.projectId) : null;
    if (p) badges += `<span class="event-project-badge">${escapeHtml(p.name)}</span>`;
    else badges += `<span class="event-project-badge project-none">未归类</span>`;
  }
  // 子任务进度角标（P6.2）：全部完成时绿色；点击打开编辑器定位子任务区
  const ckProg = checklistProgress(ev);
  if (ckProg) {
    badges += `<span class="event-ck-badge${ckProg.done === ckProg.total ? ' all' : ''}" data-ck-id="${ev.id}" title="子任务 ${ckProg.done}/${ckProg.total}">▸${ckProg.done}/${ckProg.total}</span>`;
  }

  item.innerHTML = `
    <span class="urgency-dot" style="background:${urg.color}" title="${urg.label}"></span>
    <span class="event-check" data-id="${ev.id}" title="${ev.done ? '取消完成' : '标记完成'}"></span>
    <span class="event-time">${escapeHtml(ev.time || '')}</span>
    ${badges}
    <span class="event-title">${escapeHtml(ev.title)}</span>
    ${ev._templateId ? '' : `<span class="event-del" data-id="${ev.id}" title="删除">×</span>`}
  `;
  return item;
}

// 新建/编辑事项表单
// opts.fixedDate: 日历卡片内新建时预填的日期（仍可修改/延长为区间）
// opts.fixedProject: 固定项目（项目详情内），无则显示项目下拉
// opts.event: 传入事项对象 = 编辑模式，预填全部字段
function buildTaskForm(opts = {}) {
  const ev = opts.event || null;
  const preStart = ev ? eventStart(ev) : (opts.fixedDate || '');
  const preEnd = ev ? eventEnd(ev) : (opts.fixedDate || '');
  const preDur = (preStart || preEnd) ? durationDays(preStart, preEnd) : '';
  const preCategory = ev ? (ev.category || 'work') : 'work';
  const preUrgency = ev ? (ev.urgency || 'normal') : 'normal';
  const preProject = ev ? (ev.projectId || '') : '';
  const preRemind = ev ? (ev.remindAhead || 0) : 0;
  const preRecurFreq = ev && ev.recur && RECUR_FREQ_LABELS[ev.recur.freq] ? ev.recur.freq : 'none';
  const preRecurUntil = ev && ev.recur ? (ev.recur.until || '') : '';
  const preTags = ev && Array.isArray(ev.tags) ? ev.tags.join(',') : '';

  const sel = (val, cur) => val === cur ? ' selected' : '';
  const form = document.createElement('div');
  form.className = 'add-form hidden';
  form.dataset.fixedDate = opts.fixedDate || '';
  form.dataset.fixedProject = opts.fixedProject || '';
  if (ev) form.dataset.editId = ev.id;
  form.innerHTML = `
    <div class="add-form-row1">
      <input type="time" class="ev-time" value="${ev ? (ev.time || '') : ''}" />
      <input type="text" class="ev-title" placeholder="事项标题..." maxlength="40" value="${ev ? escapeHtml(ev.title) : ''}" />
      <button type="button" class="ev-voice-btn" title="语音输入" aria-label="语音输入" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 0 0-4 0v4a2 2 0 0 0 2 2z"/><path d="M11 5v3a3 3 0 0 1-6 0V5H4v3a4 4 0 0 0 3 3.9V14H5v1h6v-1H9v-2.1A4 4 0 0 0 12 8V5h-1z"/></svg>
      </button>
    </div>
    <div class="add-form-row2">
      <select class="ev-category" title="分类">
        <option value="work"${sel('work', preCategory)}>工作</option>
        <option value="personal"${sel('personal', preCategory)}>个人事务</option>
        <option value="family"${sel('family', preCategory)}>家庭事务</option>
      </select>
      <select class="ev-urgency" title="紧急程度">
        <option value="urgent"${sel('urgent', preUrgency)}>紧急</option>
        <option value="normal"${sel('normal', preUrgency)}>一般</option>
        <option value="loose"${sel('loose', preUrgency)}>松散</option>
      </select>
      ${opts.fixedProject ? '' : `<select class="ev-project" title="所属项目">${projectOptionsHtml(preProject)}</select>`}
    </div>
    <div class="add-form-row-date">
      <input type="date" class="ev-start" title="开始日期（可留空=无日期）" value="${preStart}" />
      <span class="date-sep">~</span>
      <input type="date" class="ev-end" title="结束日期" value="${preEnd}" />
    </div>
    <div class="add-form-row-dur">持续
      <input type="number" class="ev-dur" min="1" step="1" value="${preDur}" title="修改持续天数自动调整结束日期" /> 天
    </div>
    <div class="add-form-row-remind">提前提醒
      <select class="ev-remind" title="到达前多少分钟提醒（仅当设置了时间）">
        ${[0, 5, 10, 15, 30].map(m => `<option value="${m}"${sel(String(m), String(preRemind))}>${m === 0 ? '不提前' : m + ' 分钟前'}</option>`).join('')}
      </select>
    </div>
    <div class="add-form-row-recur">重复
      <select class="ev-recur" title="重复规则（按开始日期起算）">
        ${Object.keys(RECUR_FREQ_LABELS).map(f => `<option value="${f}"${sel(f, preRecurFreq)}>${RECUR_FREQ_LABELS[f]}</option>`).join('')}
      </select>
      <input type="date" class="ev-recur-until" title="重复截止日期（可留空=一直重复）" value="${preRecurUntil}" />
    </div>
    <div class="add-form-row-tags">标签
      <input type="text" class="ev-tags" title="标签，逗号分隔，最多 ${TAG_MAX} 个" placeholder="如：工作, 重要" value="${escapeHtml(preTags)}" />
    </div>
    <div class="add-form-row-checklist">
      <div class="ck-head">子任务</div>
      <div class="ck-list"></div>
      <input type="text" class="ck-input" placeholder="添加子任务，回车确认" maxlength="40" />
    </div>
    <div class="add-form-row3">
      <button class="cancel">取消</button>
      <button class="save">${ev ? '完成编辑' : '保存'}</button>
    </div>
  `;
  bindDateRangeSync(form);
  return form;
}

// 开始日 / 结束日 / 持续天数 三方联动
function bindDateRangeSync(form) {
  const startEl = form.querySelector('.ev-start');
  const endEl = form.querySelector('.ev-end');
  const durEl = form.querySelector('.ev-dur');

  const refreshDur = () => {
    const n = durationDays(startEl.value, endEl.value);
    durEl.value = n || '';
  };
  startEl.addEventListener('change', () => {
    if (startEl.value) {
      if (!endEl.value || endEl.value < startEl.value) endEl.value = startEl.value;
    }
    refreshDur();
  });
  endEl.addEventListener('change', () => {
    if (endEl.value) {
      if (!startEl.value) startEl.value = endEl.value;
      else if (endEl.value < startEl.value) endEl.value = startEl.value;
    }
    refreshDur();
  });
  // 直接改天数 → 结束日 = 开始日 + 天数 - 1（无开始日时取固定日期/今天）
  durEl.addEventListener('change', () => {
    let n = parseInt(durEl.value, 10);
    if (!n || n < 1) { refreshDur(); return; }
    let s = startEl.value || form.dataset.fixedDate || dateKey(today());
    startEl.value = s;
    endEl.value = addDaysKey(s, n - 1);
  });
}

// 绑定单个表单的保存/取消/回车
function bindFormEvents(form) {
  // ---- 子任务（P6.2）：表单闭包内维护 ckItems，保存时随 fields 写回 ----
  const evForCk = form.dataset.editId ? loadEvents().find(x => x.id === form.dataset.editId) : null;
  let ckItems = evForCk && Array.isArray(evForCk.checklist)
    ? evForCk.checklist.map(c => ({ id: c.id || mkCkId(), text: String(c.text || ''), done: !!c.done }))
    : [];
  const ckListEl = form.querySelector('.ck-list');
  const ckInputEl = form.querySelector('.ck-input');
  const paintCk = () => {
    if (!ckListEl) return;
    ckListEl.innerHTML = ckItems.map(c => `
      <div class="ck-item${c.done ? ' done' : ''}" data-id="${c.id}">
        <span class="ck-check" title="${c.done ? '取消完成' : '标记完成'}"></span>
        <span class="ck-text">${escapeHtml(c.text)}</span>
        <span class="ck-del" title="删除子任务">×</span>
      </div>`).join('');
    ckListEl.querySelectorAll('.ck-item').forEach(row => {
      const item = ckItems.find(c => c.id === row.dataset.id);
      if (!item) return;
      row.querySelector('.ck-check').addEventListener('click', (e) => {
        e.stopPropagation();
        item.done = !item.done;
        paintCk();
      });
      row.querySelector('.ck-del').addEventListener('click', (e) => {
        e.stopPropagation();
        ckItems = ckItems.filter(c => c.id !== row.dataset.id);
        paintCk();
      });
    });
  };
  if (ckInputEl) {
    ckInputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();   // 不触发标题行的回车保存
      e.stopPropagation();
      const text = ckInputEl.value.trim();
      if (!text) return;
      ckItems.push({ id: mkCkId(), text, done: false });
      ckInputEl.value = '';
      paintCk();
    });
  }
  paintCk();

  // 语音输入订阅（关闭表单时统一取消，避免泄漏到下次创建的表单）
  let voiceUnsub = null, voiceStateUnsub = null, voiceErrUnsub = null;
  const cleanupVoice = () => {
    if (voiceUnsub) { try { voiceUnsub(); } catch {} voiceUnsub = null; }
    if (voiceStateUnsub) { try { voiceStateUnsub(); } catch {} voiceStateUnsub = null; }
    if (voiceErrUnsub) { try { voiceErrUnsub(); } catch {} voiceErrUnsub = null; }
  };

  const save = () => {
    const title = form.querySelector('.ev-title').value.trim();
    if (!title) return;
    const time = form.querySelector('.ev-time').value;
    const category = form.querySelector('.ev-category').value;
    const urgency = form.querySelector('.ev-urgency').value;
    // 日期区间：可整体留空（无日期事项）；只填一个时补成同一天
    let start = form.querySelector('.ev-start').value;
    let end = form.querySelector('.ev-end').value;
    if (start && !end) end = start;
    if (end && !start) start = end;
    if (start && end && end < start) end = start;
    // 项目：优先固定项目，否则读下拉
    const projectId = form.dataset.fixedProject || (form.querySelector('.ev-project') ? form.querySelector('.ev-project').value : '') || null;
    const fields = {
      date: start,                 // date 始终与 startDate 同步，兼容旧逻辑
      startDate: start,
      endDate: end,
      time, title,
      category: category || 'work',
      urgency: urgency || 'normal',
      projectId,
      remindAhead: Number(form.querySelector('.ev-remind').value) || 0
    };
    // 重复规则：不重复存 null；有规则时必须以开始日期为锚（无开始日期的规则不投影）
    const recurFreq = form.querySelector('.ev-recur').value;
    fields.recur = (recurFreq === 'none')
      ? null
      : { freq: recurFreq, interval: 1, until: form.querySelector('.ev-recur-until').value || '' };
    // 标签（P3.3）：逗号分隔解析为去重数组；空串存 []
    fields.tags = parseTags(form.querySelector('.ev-tags').value);
    // 子任务（P6.2）：新建表单为空时不写字段（保持"缺省=无子任务"）；编辑表单总是写回（支持删空）
    if (ckItems.length || form.dataset.editId) fields.checklist = ckItems;
    if (form.dataset.editId) updateEvent(form.dataset.editId, fields);
    else addEvent(fields);
    closeForm(form);
  };
  const closeForm = (f) => {
    cleanupVoice();   // 关闭即取消语音订阅 + 停止录音
    if (window.timetable && window.timetable.voiceStop) {
      try { window.timetable.voiceStop(); } catch {}
    }
    // 编辑表单是独立插入的编辑器块：关闭时整块移除
    if (f.dataset.editId) {
      const block = f.closest('.editor-block');
      if (block) block.remove();
      if (window.timetable) window.timetable.setEditing(false);
      return;
    }
    f.classList.add('hidden');
    f.querySelector('.ev-time').value = '';
    f.querySelector('.ev-title').value = '';
    const fixedD = f.dataset.fixedDate;
    f.querySelector('.ev-start').value = fixedD;
    f.querySelector('.ev-end').value = fixedD;
    f.querySelector('.ev-dur').value = fixedD ? '1' : '';
    f.querySelectorAll('select').forEach(s => {
      if (s.classList.contains('ev-category')) s.value = 'work';
      else if (s.classList.contains('ev-urgency')) s.value = 'normal';
      else if (s.classList.contains('ev-project')) s.value = '';
      else if (s.classList.contains('ev-remind')) s.value = '0';
      else if (s.classList.contains('ev-recur')) s.value = 'none';
    });
    const recurUntil = f.querySelector('.ev-recur-until');
    if (recurUntil) recurUntil.value = '';
    const tagsEl = f.querySelector('.ev-tags');
    if (tagsEl) tagsEl.value = '';
    ckItems = [];                 // 子任务一并重置（新建表单复用）
    if (ckInputEl) ckInputEl.value = '';
    paintCk();
    if (window.timetable) window.timetable.setEditing(false);
  };

  // ---- 语音输入按钮（仅当设置开关开启时显示并启用） ----
  const voiceBtn = form.querySelector('.ev-voice-btn');
  const titleEl = form.querySelector('.ev-title');
  if (voiceBtn && titleEl && window.timetable && window.timetable.onVoiceResult) {
    const st = loadAppSettings();
    if (st.voiceInputEnabled) voiceBtn.hidden = false;

    voiceBtn.addEventListener('click', async () => {
      if (!window.timetable.voiceGetStatus || !window.timetable.voiceStart) return;
      // 正在录音：点击即停止
      if (voiceBtn.classList.contains('recording')) {
        window.timetable.voiceStop();
        return;
      }
      // 检查可用性
      let status;
      try { status = await window.timetable.voiceGetStatus(); }
      catch { status = { available: false, message: '语音输入不可用' }; }
      if (!status.available) { showToast(status.message || '语音输入不可用'); return; }
      // 启动识别
      voiceBtn.classList.add('recording');
      window.timetable.voiceStart({ language: st.voiceLanguage || 'zh-CN' });
    });

    // 识别结果 → 填入标题（仅当前可见表单接收）
    voiceUnsub = window.timetable.onVoiceResult((result) => {
      if (form.classList.contains('hidden')) return;
      if (!result || !result.text) return;
      titleEl.value = result.text;
      titleEl.focus();
      voiceBtn.classList.remove('recording');
    });
    // 状态变化 → 按钮态
    voiceStateUnsub = window.timetable.onVoiceState((state) => {
      if (state === 'idle' || state === 'error') voiceBtn.classList.remove('recording');
      else if (state === 'processing' || state === 'recording') voiceBtn.classList.add('recording');
    });
    // 错误提示
    voiceErrUnsub = window.timetable.onVoiceError((err) => {
      voiceBtn.classList.remove('recording');
      if (err && err.message) showToast(err.message);
    });
  }


  form.querySelector('.save').addEventListener('click', (e) => {
    e.stopPropagation();
    save();
  });
  form.querySelector('.cancel').addEventListener('click', () => closeForm(form));
  form.querySelector('.ev-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') closeForm(form);
  });
}

// 渲染后统一绑定视图内事件
function bindViewEvents() {
  // 日卡片的 + 按钮
  weekList.querySelectorAll('.day-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.day-card');
      const form = card.querySelector('.add-form');
      weekList.querySelectorAll('.add-form').forEach(f => { if (f !== form) f.classList.add('hidden'); });
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        if (window.timetable) window.timetable.setEditing(true);
        form.querySelector('.ev-title').focus();
      } else {
        if (window.timetable) window.timetable.setEditing(false);
      }
    });
  });

  // 今日视图：点击日期卡头部切换聚焦日期（+ 按钮已 stopPropagation，双保险排除）
  weekList.querySelectorAll('.day-card[data-clickable="1"]').forEach(card => {
    card.querySelector('.day-header').addEventListener('click', (e) => {
      if (currentView !== 'today' || e.target.closest('.day-add')) return;
      setTodayAnchor(card.dataset.date);
    });
  });

  // 顶部新建按钮（项目详情/事项视图）
  weekList.querySelectorAll('.top-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const block = btn.closest('.add-block');
      const form = block.querySelector('.add-form');
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        if (window.timetable) window.timetable.setEditing(true);
        form.querySelector('.ev-title').focus();
      } else {
        if (window.timetable) window.timetable.setEditing(false);
      }
    });
  });

  // 所有表单
  weekList.querySelectorAll('.add-form').forEach(bindFormEvents);

  // 勾选完成
  weekList.querySelectorAll('.event-check').forEach(check => {
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDone(check.dataset.id);
    });
  });

  // 删除
  weekList.querySelectorAll('.event-del').forEach(del => {
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEvent(del.dataset.id);
    });
  });

  // 子任务进度角标（P6.2）→ 打开编辑器并聚焦子任务输入框
  weekList.querySelectorAll('.event-ck-badge').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const real = loadEvents().find(x => x.id === badge.dataset.ckId);
      if (!real) return;
      openTaskEditor(real);
      const ckInput = weekList.querySelector('.editor-block .ck-input');
      if (ckInput) ckInput.focus();
    });
  });

  // 项目卡片 → 同层展开/收起该项目的事项面板（手风琴）
  weekList.querySelectorAll('.project-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      expandedProjectId = (expandedProjectId === id) ? null : id;
      render();
      if (expandedProjectId === id) {
        const fresh = weekList.querySelector(`.project-card[data-id="${id}"]`);
        if (fresh) fresh.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // 项目内联面板：列表 / 甘特图 子切换（按项目分别记忆）
  weekList.querySelectorAll('.sub-tabs button[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      projectDetailModes[btn.dataset.pid] = btn.dataset.mode;
      render();
    });
  });

  // 日历页：日历 / 总览甘特 显示模式切换
  weekList.querySelectorAll('.sub-tabs button[data-cal-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      calendarMode = btn.dataset.calMode;
      render();
    });
  });

  // 项目信息卡 ✎ 编辑按钮（项目详情页）
  weekList.querySelectorAll('.info-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const info = btn.closest('.project-info');
      if (info) openProjectForm(info.dataset.id, info.querySelector('.project-form'));
    });
  });

  // 新建项目按钮/表单
  weekList.querySelectorAll('.project-create-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const block = btn.closest('.add-block');
      const form = block.querySelector('.project-form');
      if (form.classList.contains('hidden')) openProjectForm(null, form);
      else closeProjectForm(form);
    });
  });
  weekList.querySelectorAll('.project-form').forEach(form => {
    const doSave = () => {
      const name = form.querySelector('.pj-name').value.trim();
      if (!name) return;
      const desc = form.querySelector('.pj-desc').value.trim();
      // 起止日期可留空；只填一个时补成同一天；结束早于开始时钳制
      let start = form.querySelector('.pj-start').value;
      let end = form.querySelector('.pj-end').value;
      if (start && !end) end = start;
      if (end && !start) start = end;
      if (start && end && end < start) end = start;
      const category = form.querySelector('.pj-category').value || 'work';
      const priority = form.querySelector('.pj-priority').value || 'medium';
      const fields = { name, description: desc, startDate: start, endDate: end, category, priority };
      if (form.dataset.editId) updateProject(form.dataset.editId, fields);
      else addProject(fields);
      closeProjectForm(form);
    };
    form.querySelector('.save').addEventListener('click', (e) => { e.stopPropagation(); doSave(); });
    form.querySelector('.cancel').addEventListener('click', () => closeProjectForm(form));
    form.querySelector('.pj-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') closeProjectForm(form);
    });
  });
}

// 构建项目新建/编辑表单（标题、简介、起止时间、分类）
function buildProjectForm() {
  const form = document.createElement('div');
  form.className = 'project-form hidden';
  form.innerHTML = `
    <input type="text" class="pj-name" placeholder="项目标题" maxlength="30" />
    <input type="text" class="pj-desc" placeholder="项目简介" maxlength="100" />
    <div class="add-form-row-date">
      <input type="date" class="pj-start" title="开始日期（可留空）" />
      <span class="date-sep">~</span>
      <input type="date" class="pj-end" title="结束日期" />
    </div>
    <div class="add-form-row2 pj-select-row">
      <select class="pj-category" title="分类">
        <option value="work">工作</option>
        <option value="personal">个人事务</option>
        <option value="family">家庭事务</option>
      </select>
      <select class="pj-priority" title="优先级">
        <option value="high">高优先</option>
        <option value="medium">中优先</option>
        <option value="low">低优先</option>
      </select>
    </div>
    <div class="add-form-row3">
      <button class="cancel">取消</button>
      <button class="save">保存</button>
    </div>
  `;
  // 起止日期互相钳制
  const startEl = form.querySelector('.pj-start');
  const endEl = form.querySelector('.pj-end');
  startEl.addEventListener('change', () => {
    if (startEl.value && (!endEl.value || endEl.value < startEl.value)) endEl.value = startEl.value;
  });
  endEl.addEventListener('change', () => {
    if (endEl.value) {
      if (!startEl.value) startEl.value = endEl.value;
      else if (endEl.value < startEl.value) endEl.value = startEl.value;
    }
  });
  return form;
}

// 打开项目表单：传 projectId = 编辑并预填，否则新建（清除残留编辑态）
// form 可选：默认查找当前视图内的 .project-form
function openProjectForm(projectId, form) {
  const f = form || weekList.querySelector('.project-form');
  if (!f) return;
  const p = projectId ? getProject(projectId) : null;
  if (p) {
    f.dataset.editId = p.id;
    f.querySelector('.pj-name').value = p.name;
    f.querySelector('.pj-desc').value = p.description || '';
    f.querySelector('.pj-start').value = p.startDate || '';
    f.querySelector('.pj-end').value = p.endDate || '';
    f.querySelector('.pj-category').value = p.category || 'work';
    f.querySelector('.pj-priority').value = p.priority || 'medium';
  } else {
    delete f.dataset.editId;
    f.querySelector('.pj-name').value = '';
    f.querySelector('.pj-desc').value = '';
    f.querySelector('.pj-start').value = '';
    f.querySelector('.pj-end').value = '';
    f.querySelector('.pj-category').value = 'work';
    f.querySelector('.pj-priority').value = 'medium';
  }
  f.classList.remove('hidden');
  if (window.timetable) window.timetable.setEditing(true);
  f.querySelector('.pj-name').focus();
}

function closeProjectForm(f) {
  f.classList.add('hidden');
  delete f.dataset.editId;
  f.querySelectorAll('input').forEach(i => i.value = '');
  const cat = f.querySelector('.pj-category');
  if (cat) cat.value = 'work';
  const pri = f.querySelector('.pj-priority');
  if (pri) pri.value = 'medium';
  if (window.timetable) window.timetable.setEditing(false);
}

// 右键"编辑项目"：项目未同层展开时先展开，再打开其信息卡内的编辑表单
function editProjectViaForm(pid) {
  if (expandedProjectId !== pid) {
    expandedProjectId = pid;
    render();
  }
  const box = weekList.querySelector(`.project-inline[data-pid="${pid}"]`);
  const form = box ? box.querySelector('.project-form') : null;
  if (form) openProjectForm(pid, form);
}

// 进度条 HTML（完成数/总数 + 百分比）
function progressBarHtml(done, total) {
  const pct = total === 0 ? 0 : Math.round(done / total * 100);
  return `
    <div class="progress-row">
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-text">${pct}%（${done}/${total}）</span>
    </div>
  `;
}

// ============ 今日视图 ============
// 聚焦日期（可点击日期卡切换，默认真实今天）；窗口 = anchor 前1天 ~ 后2天
let todayAnchor = dateKey(today());
let anchorFollowsToday = true;   // anchor 是否处于"跟随真实今天"状态（手动选其他日期后解除）
function setTodayAnchor(key) {
  if (todayAnchor === key) return;
  todayAnchor = key;
  anchorFollowsToday = key === dateKey(today());   // 点"回到今天"/选当天 → 恢复跟随
  render();
}

// 跨日滚动：应用驻留过午夜时自动跟随真实日期（手动选中的历史/未来日不被打断）
let lastSeenDay = dateKey(today());
function ensureDateRollover() {
  const tk = dateKey(today());
  if (tk === lastSeenDay) return;
  lastSeenDay = tk;
  rangeStart = addDays(stripTime(new Date()), -1);   // 日历周窗口同步平移
  if (anchorFollowsToday) todayAnchor = tk;          // 仅跟随态才滚动聚焦日
}

function renderToday() {
  const d = parseDateKey(todayAnchor);
  const tk = dateKey(today());
  const viewingToday = todayAnchor === tk;
  setHeader(`${d.getMonth() + 1}月${d.getDate()}日`, WEEKDAYS[d.getDay()], false);
  // 查看非今天时，副标题提供「回到今天」入口
  bigWeekday.innerHTML = viewingToday
    ? WEEKDAYS[d.getDay()]
    : `${WEEKDAYS[d.getDay()]} · <span class="back-today" title="回到今天">回到今天</span>`;
  const backBtn = bigWeekday.querySelector('.back-today');
  if (backBtn) backBtn.addEventListener('click', () => setTodayAnchor(tk));

  weekList.innerHTML = '';
  // 标签筛选 chips（P3.3）：存在标签或筛选进行中（后者保证可退出筛选）时显示
  if (collectTags().length || tagFilter) weekList.appendChild(buildTagChips());
  // 昨日、聚焦日、明日、后日 共 4 张日期卡（点击卡片头部可切换；排序控件只挂在聚焦卡）
  for (let off = -1; off <= 2; off++) {
    weekList.appendChild(buildDayCard(addDays(d, off), {
      showSort: off === 0, anchorCard: off === 0, clickable: true, tagFilter
    }));
  }
  bindViewEvents();
}

// ============ 日历视图（周视图 / 总览甘特 / 月历） ============
function renderWeek() {
  const todayD = today();
  const todayKey = dateKey(todayD);
  const isGantt = calendarMode === 'gantt';
  const isMonth = calendarMode === 'month';

  if (isGantt) {
    setHeader('总览甘特', '全部项目与事项', false);
  } else if (isMonth) {
    setHeader(`${monthAnchor.getFullYear()}年${monthAnchor.getMonth() + 1}月`, '月历', true);
  } else {
    const rangeEnd = addDays(rangeStart, RANGE_DAYS - 1);
    const sameMonth = rangeStart.getMonth() === rangeEnd.getMonth();
    if (sameMonth) {
      setHeader(`${rangeStart.getMonth() + 1}月${rangeStart.getDate()}–${rangeEnd.getDate()}日`,
        dateKey(rangeStart) <= todayKey && todayKey <= dateKey(rangeEnd) ? '本周' : '历史/未来', true);
    } else {
      setHeader(`${rangeStart.getMonth() + 1}/${rangeStart.getDate()} – ${rangeEnd.getMonth() + 1}/${rangeEnd.getDate()}`,
        dateKey(rangeStart) <= todayKey && todayKey <= dateKey(rangeEnd) ? '本周' : '历史/未来', true);
    }
  }

  weekList.innerHTML = '';

  // 日历 / 总览甘特 / 月历 显示模式切换
  const modeTabs = document.createElement('div');
  modeTabs.className = 'sub-tabs';
  modeTabs.innerHTML = `
    <button data-cal-mode="calendar" class="${!isGantt && !isMonth ? 'active' : ''}">日历</button>
    <button data-cal-mode="gantt" class="${isGantt ? 'active' : ''}">总览甘特</button>
    <button data-cal-mode="month" class="${isMonth ? 'active' : ''}">月历</button>
  `;
  weekList.appendChild(modeTabs);

  if (isGantt) {
    weekList.appendChild(buildOverviewGantt());
  } else if (isMonth) {
    weekList.appendChild(buildMonthView());
  } else {
    for (let i = 0; i < RANGE_DAYS; i++) {
      weekList.appendChild(buildDayCard(addDays(rangeStart, i)));
    }
    enableWeekDrag();   // 周视图拖拽改期（P4.2）
  }
  bindViewEvents();
}

// ============ 月历视图（P4.2）：6×7 网格 + 热力底色 + 项目工期条 ============
// P6.1 交互补齐：格子右键菜单 / +N 手风琴展开 / 事项条拖拽改期
let monthExpandKey = '';      // +N 展开的格子日期（同时只允许一格展开，'' = 全部收起）
let monthDragSuppress = false; // 拖拽刚结束时抑制随后的 click（避免误开编辑器）

// +N 展开/收起切换（只改状态，调用方负责 render）
function monthToggleExpand(key) {
  monthExpandKey = (monthExpandKey === key) ? '' : key;
}

// 月历定位到某日：切周视图并让该日落在第二张卡（与点格子/gotoSearchResult 同口径）
function monthGotoDate(key) {
  rangeStart = addDays(parseDateKey(key), -1);
  calendarMode = 'calendar';
}

// 纯函数：构建 6×7 月历网格（周一开头，复用 startOfWeek），42 格固定（跨月尾首衔接）
function buildMonthGrid(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const out = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    out.push({
      date: d, key: dateKey(d), day: d.getDate(),
      inMonth: d.getMonth() === anchor.getMonth(),
      isToday: isSameDay(d, today())
    });
  }
  return out;
}

// 月历面板：格子显示当日事项小条（≤3 条超出 +N，完成划线保留）+ 底部项目工期细条；
// 点格子 → 周视图定位该日；点事项条 → 打开编辑（重复投影按模板，与右键语义一致）
function buildMonthView() {
  const wrap = document.createElement('div');
  wrap.className = 'month-view';
  const grid = buildMonthGrid(monthAnchor);
  const projects = loadProjects();

  // 工具行：回到本月（跨月浏览后快速归位）
  const bar = document.createElement('div');
  bar.className = 'month-toolbar';
  const todayBtn = document.createElement('button');
  todayBtn.className = 'month-today-btn';
  todayBtn.textContent = '回到本月';
  todayBtn.addEventListener('click', () => { monthAnchor = new Date(); render(); });
  bar.appendChild(todayBtn);
  wrap.appendChild(bar);

  const gridEl = document.createElement('div');
  gridEl.className = 'month-grid';
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
    const wk = document.createElement('div');
    wk.className = 'month-wk';
    wk.textContent = w;
    gridEl.appendChild(wk);
  }
  for (const cell of grid) {
    const evs = getEventsByDate(cell.key);
    const expanded = cell.key === monthExpandKey;   // P6.1：该格 +N 手风琴展开态
    const cellEl = document.createElement('div');
    cellEl.className = 'month-cell' + (cell.inMonth ? '' : ' out') + (cell.isToday ? ' today' : '') + (expanded ? ' expanded' : '');
    cellEl.dataset.key = cell.key;
    cellEl.dataset.heat = String(Math.min(evs.length, 5));   // 热力分档 0~5
    cellEl.title = evs.length ? `${cell.key}（${evs.length} 项）` : cell.key;

    const dayEl = document.createElement('div');
    dayEl.className = 'month-day';
    dayEl.textContent = String(cell.day);
    cellEl.appendChild(dayEl);

    // 展开态显示全部事项条，收起态最多 3 条
    for (const ev of evs.slice(0, expanded ? evs.length : 3)) {
      const cat = CATEGORIES[ev.category] || CATEGORIES.work;
      const chip = document.createElement('div');
      chip.className = 'month-ev' + (ev.done ? ' done' : '');
      chip.style.borderLeftColor = cat.color;
      chip.textContent = (ev.time ? ev.time + ' ' : '') + ev.title;
      chip.title = ev.title;
      chip.dataset.id = ev.id;   // 右键菜单 / 拖拽改期用（虚拟投影为复合 id）
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (monthDragSuppress) return;   // 拖拽刚结束的 click 不打开编辑
        // 虚拟事项（模板id@日期）→ 编辑作用于模板（与右键菜单语义一致）
        const id = ev.id.includes('@') ? ev.id.slice(0, ev.id.lastIndexOf('@')) : ev.id;
        const real = loadEvents().find(x => x.id === id);
        if (real) openTaskEditor(real);
      });
      cellEl.appendChild(chip);
    }
    if (expanded || evs.length > 3) {
      const more = document.createElement('div');
      more.className = 'month-ev-more';
      more.textContent = expanded ? '收起' : `+${evs.length - 3}`;
      more.title = expanded ? '收起当日清单' : '展开当日全部事项';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        monthToggleExpand(cell.key);
        render();
      });
      cellEl.appendChild(more);
    }

    // 项目工期：起止覆盖该日的项目画细条（颜色随分类）
    const pjs = projects.filter(p => p.startDate && p.endDate && p.startDate <= cell.key && cell.key <= p.endDate);
    if (pjs.length) {
      const pjWrap = document.createElement('div');
      pjWrap.className = 'month-pjs';
      for (const p of pjs.slice(0, 2)) {
        const bar = document.createElement('i');
        bar.className = 'month-pj';
        bar.style.background = (CATEGORIES[p.category] || CATEGORIES.work).color;
        bar.title = p.name;
        pjWrap.appendChild(bar);
      }
      if (pjs.length > 2) {
        const morePj = document.createElement('i');
        morePj.className = 'month-pj more';
        morePj.title = `还有 ${pjs.length - 2} 个项目`;
        pjWrap.appendChild(morePj);
      }
      cellEl.appendChild(pjWrap);
    }

    // 点格子空白区 → 切周视图定位该日（事项条已 stopPropagation）
    cellEl.addEventListener('click', () => {
      monthGotoDate(cell.key);   // 该日落在第二张卡，与 gotoSearchResult 一致
      render();
    });
    gridEl.appendChild(cellEl);
  }
  wrap.appendChild(gridEl);
  enableMonthDrag(gridEl);   // P6.1：事项条拖拽改期
  return wrap;
}

// ============ 月历拖拽改期（P6.1）：与周视图同一套 mousedown 自实现 ============
// 阈值 6px 防误触；Esc 取消；落点格子高亮；虚拟投影按模板改期（与右键语义一致）
function enableMonthDrag(rootEl) {
  if (batchMode) return;
  let ghost = null, dragId = '', started = false, sx = 0, sy = 0, canceled = false;
  const clearHover = () => rootEl.querySelectorAll('.month-cell.drag-over').forEach(c => c.classList.remove('drag-over'));

  rootEl.querySelectorAll('.month-ev').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || currentTool || editing) return;
      dragId = item.dataset.id || '';
      if (!dragId) return;
      sx = e.clientX; sy = e.clientY; started = false; canceled = false;

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('keydown', onKey, true);
        if (ghost) { ghost.remove(); ghost = null; }
        item.classList.remove('dragging');
        clearHover();
      };
      const onMove = (me) => {
        if (!started && Math.hypot(me.clientX - sx, me.clientY - sy) < 6) return;   // 位移阈值，普通点击不受扰
        if (!started) {
          started = true;
          ghost = document.createElement('div');
          ghost.className = 'drag-ghost';
          ghost.textContent = item.textContent;
          document.body.appendChild(ghost);
          item.classList.add('dragging');
        }
        ghost.style.left = (me.clientX + 12) + 'px';
        ghost.style.top = (me.clientY + 8) + 'px';
        clearHover();
        const el = document.elementFromPoint(me.clientX, me.clientY);
        const cell = el && el.closest ? el.closest('.month-cell[data-key]') : null;
        if (cell) cell.classList.add('drag-over');
      };
      const onUp = (ue) => {
        const wasStarted = started;
        cleanup();
        if (!wasStarted || canceled) return;
        // 抑制随后的 click（避免松手后误开编辑器）；click 在 mouseup 后同步派发
        monthDragSuppress = true;
        setTimeout(() => { monthDragSuppress = false; }, 0);
        const el = document.elementFromPoint(ue.clientX, ue.clientY);
        const cell = el && el.closest ? el.closest('.month-cell[data-key]') : null;
        if (!cell) return;
        const targetKey = cell.dataset.key;
        const srcKey = item.closest('.month-cell') ? item.closest('.month-cell').dataset.key : '';
        if (targetKey && targetKey !== srcKey) {
          // 虚拟投影 id（模板id@日期）→ 作用于模板
          const id = dragId.includes('@') ? dragId.slice(0, dragId.lastIndexOf('@')) : dragId;
          moveEventToDate(id, targetKey);
        }
      };
      const onKey = (ke) => {
        if (ke.key !== 'Escape') return;
        canceled = true;   // 仅清理，不改期
        cleanup();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('keydown', onKey, true);
    });
  });
}

// ============ 周视图拖拽改期（P4.2）：mousedown 自实现（HTML5 DnD 在无边框透明窗口表现不稳） ============
// 拖起半透明浮层跟随鼠标，落点日卡片高亮，松手 moveEventToDate（多日事项整体平移）；
// 重复事项虚拟投影按模板改期（与右键「调整到哪一天」语义一致）；批量模式/工具层不启用
function enableWeekDrag() {
  if (batchMode) return;
  let ghost = null, dragId = '', started = false, sx = 0, sy = 0;
  const clearHover = () => weekList.querySelectorAll('.day-card.drag-over').forEach(c => c.classList.remove('drag-over'));

  weekList.querySelectorAll('.event-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || currentTool || editing) return;
      if (e.target.closest('.event-check,.event-del,.ev-voice-btn')) return;   // 控件不触发拖拽
      dragId = item.dataset.id || '';
      if (!dragId) return;
      sx = e.clientX; sy = e.clientY; started = false;

      const onMove = (me) => {
        if (!started && Math.hypot(me.clientX - sx, me.clientY - sy) < 6) return;   // 位移阈值，普通点击不受扰
        if (!started) {
          started = true;
          ghost = document.createElement('div');
          ghost.className = 'drag-ghost';
          ghost.textContent = item.querySelector('.event-title').textContent;
          document.body.appendChild(ghost);
          item.classList.add('dragging');
        }
        ghost.style.left = (me.clientX + 12) + 'px';
        ghost.style.top = (me.clientY + 8) + 'px';
        clearHover();
        const el = document.elementFromPoint(me.clientX, me.clientY);
        const card = el && el.closest ? el.closest('.day-card[data-date]') : null;
        if (card) card.classList.add('drag-over');
      };
      const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!started) return;
        if (ghost) { ghost.remove(); ghost = null; }
        item.classList.remove('dragging');
        clearHover();
        const el = document.elementFromPoint(ue.clientX, ue.clientY);
        const card = el && el.closest ? el.closest('.day-card[data-date]') : null;
        if (!card) return;
        const targetKey = card.dataset.date;
        const srcKey = item.closest('.day-card') ? item.closest('.day-card').dataset.date : '';
        if (targetKey && targetKey !== srcKey) {
          // 虚拟投影 id（模板id@日期）→ 作用于模板
          const id = dragId.includes('@') ? dragId.slice(0, dragId.lastIndexOf('@')) : dragId;
          moveEventToDate(id, targetKey);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// 单日排序控件（仅今日视图显示；选择持久化到 localStorage，甘特/其他视图不受影响）
const DAY_SORT_LABELS = { start: '开始时间', end: '结束时间', urgency: '重要程度' };
let daySortPanelOpen = false;

function buildDaySortBar() {
  const wrap = document.createElement('div');
  wrap.className = 'day-sort';

  const btn = document.createElement('button');
  btn.className = 'day-sort-toggle';
  const dirMark = daySort.dir === 'desc' ? '↓' : '↑';
  btn.innerHTML = `<span>排序：${DAY_SORT_LABELS[daySort.by]} ${dirMark}</span><span class="ds-arrow">${daySortPanelOpen ? '▾' : '▸'}</span>`;
  btn.addEventListener('click', () => { daySortPanelOpen = !daySortPanelOpen; render(); });
  wrap.appendChild(btn);

  if (daySortPanelOpen) {
    const panel = document.createElement('div');
    panel.className = 'day-sort-panel';
    panel.innerHTML = `
      <div class="day-sort-row">
        <span class="day-sort-cap">方式</span>
        ${Object.keys(DAY_SORT_LABELS).map(k =>
          `<button class="day-sort-opt${daySort.by === k ? ' active' : ''}" data-by="${k}">${DAY_SORT_LABELS[k]}</button>`).join('')}
      </div>
      <div class="day-sort-row">
        <span class="day-sort-cap">方向</span>
        <button class="day-sort-opt${daySort.dir === 'asc' ? ' active' : ''}" data-dir="asc">正序</button>
        <button class="day-sort-opt${daySort.dir === 'desc' ? ' active' : ''}" data-dir="desc">倒序</button>
      </div>
    `;
    panel.querySelectorAll('.day-sort-opt').forEach(o => o.addEventListener('click', () => {
      if (o.dataset.by) daySort.by = o.dataset.by;
      if (o.dataset.dir) daySort.dir = o.dataset.dir;
      saveDaySort();
      render();
    }));
    wrap.appendChild(panel);
  }
  return wrap;
}

// 构建单日卡片（今日视图与日历视图共用）
function buildDayCard(d, opts = {}) {
  const key = dateKey(d);
  const isToday = isSameDay(d, today());
  // 标签筛选（P3.3）：仅过滤显示，不影响排序控件/投影数据本身
  const projEvents = getEventsByDate(key);
  const events = opts.tagFilter ? filterByTag(projEvents, opts.tagFilter) : projEvents;

  const card = document.createElement('div');
  card.className = 'day-card' + (isToday ? ' today' : '') + (opts.anchorCard ? ' selected' : '');
  card.dataset.date = key;
  if (opts.clickable) card.dataset.clickable = '1';

  const header = document.createElement('div');
  header.className = 'day-header';
  if (opts.clickable) header.title = '点击切换到该日期';
  header.innerHTML = `
    <span class="day-label">${WEEKDAYS[d.getDay()]}
      <span class="day-num">${d.getMonth() + 1}/${d.getDate()}</span>
    </span>
    <button class="day-add" data-date="${key}" title="添加事项">+</button>
  `;
  card.appendChild(header);

  // 排序控件（仅今日视图且有事项时显示）
  if (opts.showSort && events.length) card.appendChild(buildDaySortBar());

  const list = document.createElement('div');
  list.className = 'event-list';
  if (events.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '— 无 —';
    list.appendChild(hint);
  } else {
    // 显示所属项目徽标（未归类同样标注，与事项视图行为一致）
    for (const ev of events) list.appendChild(buildEventItem(ev, { showProject: true }));
  }
  card.appendChild(list);

  const form = buildTaskForm({ fixedDate: key });
  card.appendChild(form);

  return card;
}

// ============ 项目列表视图（同层手风琴展开） ============
function renderProjects() {
  setHeader('项目', `共 ${loadProjects().length} 个`, false);
  weekList.innerHTML = '';

  // 同步预览 / 冲突处理面板（导入进行中时置顶显示）
  if (syncState) weekList.appendChild(buildSyncPanel());

  // 新建项目入口
  const block = document.createElement('div');
  block.className = 'add-block';
  const createBtn = document.createElement('button');
  createBtn.className = 'project-create-btn';
  createBtn.textContent = '+ 新建项目';
  const form = buildProjectForm();
  block.appendChild(createBtn);
  block.appendChild(form);
  weekList.appendChild(block);

  const projects = loadProjects();
  if (projects.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '— 暂无项目 —';
    weekList.appendChild(hint);
  }
  for (const p of projects) {
    const { done, total } = projectProgress(p.id);
    const cat = projectCategory(p);
    const pri = projectPriority(p);
    const expanded = expandedProjectId === p.id;
    const card = document.createElement('div');
    card.className = 'project-card' + (expanded ? ' expanded' : '');
    card.style.borderLeft = `3px solid ${cat.color}`;
    card.dataset.id = p.id;
    card.title = expanded ? '点击收起' : '点击展开事项';
    card.innerHTML = `
      <div class="pj-head">
        <span class="pj-arrow">▸</span>
        <div class="project-name">${escapeHtml(p.name)}</div>
      </div>
      ${p.description ? `<div class="project-desc">${escapeHtml(p.description)}</div>` : ''}
      ${progressBarHtml(done, total)}
      <div class="project-meta">
        <span class="pj-meta-cat" style="color:${cat.color}">● ${cat.label}</span>
        <span class="pj-meta-pri" style="color:${pri.color}">◆ ${pri.label}</span>
        <span>${projectRangeText(p)}</span>
        <span>${total} 个事项</span>
      </div>
    `;
    weekList.appendChild(card);
    // 同层展开的项目事项面板（再次点击卡片收起）
    if (expanded) weekList.appendChild(buildProjectInline(p));
  }

  // 同步操作日志（导出/导入/合并记录）
  weekList.appendChild(buildSyncLogBlock());
  bindViewEvents();
}

// 项目内联面板：项目信息卡 + 列表/甘特子切换 + 新建事项（同层展开，不再进入二级页面）
function buildProjectInline(p) {
  const { done, total } = projectProgress(p.id);
  const pct = total === 0 ? 0 : Math.round(done / total * 100);
  const mode = projectDetailModes[p.id] || 'list';

  const box = document.createElement('div');
  box.className = 'project-inline';
  box.dataset.pid = p.id;

  // 项目信息卡（✎ 按钮或右键可编辑基本信息）
  const cat = projectCategory(p);
  const pri = projectPriority(p);
  const info = document.createElement('div');
  info.className = 'project-info';
  info.dataset.id = p.id;
  info.style.borderLeft = `3px solid ${cat.color}`;
  info.innerHTML = `
    <div class="project-name-row">
      <div class="project-name">${escapeHtml(p.name)}</div>
      <button class="info-edit-btn" title="编辑项目信息">✎</button>
    </div>
    ${p.description ? `<div class="project-desc">${escapeHtml(p.description)}</div>` : '<div class="project-desc muted">暂无简介</div>'}
    ${progressBarHtml(done, total)}
    <div class="project-meta">
      <span class="pj-meta-cat" style="color:${cat.color}">● ${cat.label}</span>
      <span class="pj-meta-pri" style="color:${pri.color}">◆ ${pri.label}</span>
      <span>${projectRangeText(p)}</span>
      <span>项目进度 ${pct}% · ${total} 个事项 · ${done} 已完成</span>
    </div>
  `;
  info.appendChild(buildProjectForm());
  box.appendChild(info);

  // 列表 / 甘特图 子切换（每个项目各自记忆模式）
  const subTabs = document.createElement('div');
  subTabs.className = 'sub-tabs';
  subTabs.innerHTML = `
    <button data-mode="list" data-pid="${p.id}" class="${mode === 'list' ? 'active' : ''}">列表</button>
    <button data-mode="gantt" data-pid="${p.id}" class="${mode === 'gantt' ? 'active' : ''}">甘特图</button>
  `;
  box.appendChild(subTabs);

  // 新建事项（自动归属当前项目）
  const addBlock = document.createElement('div');
  addBlock.className = 'add-block';
  const addBtn = document.createElement('button');
  addBtn.className = 'top-add';
  addBtn.textContent = '+ 新建事项';
  addBlock.appendChild(addBtn);
  addBlock.appendChild(buildTaskForm({ fixedProject: p.id }));
  box.appendChild(addBlock);

  if (mode === 'gantt') {
    box.appendChild(buildGantt(p));
  } else {
    // 事项列表
    const tasks = getProjectTasks(p.id);
    const list = document.createElement('div');
    list.className = 'event-list';
    if (tasks.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '— 暂无事项 —';
      list.appendChild(hint);
    } else {
      for (const t of tasks) list.appendChild(buildEventItem(t, { showDate: true }));
    }
    box.appendChild(list);
  }

  return box;
}

// ============ 甘特图（项目内联 & 日历总览共用） ============
const GANTT_STATE = { dayW: 28 };   // 甘特图单日列宽 px（可变：缩放 16~56）
const GANTT_DAY_W_MIN = 16, GANTT_DAY_W_MAX = 56, GANTT_DAY_W_STEP = 4;
// 缩放边界收敛（工具栏按钮与 Ctrl+滚轮共用；独立成纯函数便于单元测试）
function ganttClampDayW(w) {
  return Math.min(GANTT_DAY_W_MAX, Math.max(GANTT_DAY_W_MIN, w));
}
const GANTT_ROW_H = 30;    // 甘特图事项行高 px
const GANTT_GROUP_H = 24;  // 甘特图项目分组行高 px（总览）
const GANTT_HEAD_H = 30;   // 甘特图表头高 px

// 由若干 [startKey, endKey] 计算甘特时间轴范围：纳入今天、两侧各留 1 天、至少 7 天
function calcGanttRange(ranges) {
  const tk = dateKey(today());
  let minK = tk, maxK = tk;
  for (const [s, e] of ranges) {
    if (!s) continue;
    const ee = e || s;
    if (s < minK) minK = s;
    if (ee > maxK) maxK = ee;
  }
  minK = addDaysKey(minK, -1);
  maxK = addDaysKey(maxK, 1);
  if (durationDays(minK, maxK) < 7) maxK = addDaysKey(minK, 6);
  return { minK, maxK, totalDays: durationDays(minK, maxK) };
}
// 单项目甘特图（内联在项目面板中）
function buildGantt(project) {
  const allTasks = getProjectTasks(project.id);
  const tasks = allTasks.filter(t => eventStart(t));    // 有日期的上时间轴
  const undated = allTasks.filter(t => !eventStart(t)); // 无日期事项下方单列

  // 时间轴范围：所有事项 + 今天，两侧各留 1 天，至少 7 天
  const tk = dateKey(today());
  const { minK, totalDays } = calcGanttRange(tasks.map(t => [eventStart(t), eventEnd(t)]));
  const todayOffset = Math.round((parseDateKey(tk) - parseDateKey(minK)) / 86400000);
  const innerW = totalDays * GANTT_STATE.dayW;
  const WEEK_CH = '日一二三四五六';

  const wrap = document.createElement('div');
  wrap.className = 'gantt-wrap';
  wrap.dataset.minKey = minK;

  // 左侧固定事项名列
  let leftHtml = `<div class="gantt-corner" style="height:${GANTT_HEAD_H}px">事项</div>`;
  if (tasks.length === 0) {
    leftHtml += `<div class="gantt-empty-name" style="height:${GANTT_ROW_H}px">—</div>`;
  } else {
    for (const t of tasks) {
      const recurNote = isRecurOn(t) ? `（${RECUR_FREQ_LABELS[t.recur.freq] || '重复'}重复）` : '';
      leftHtml += `<div class="gantt-name${t.done ? ' done' : ''}" style="height:${GANTT_ROW_H}px" data-gantt-id="${t.id}" title="${escapeHtml(t.title + recurNote)}">${escapeHtml(t.title)}${isRecurOn(t) ? ' 🔁' : ''}</div>`;
    }
  }

  // 右侧日期表头
  let headHtml = '';
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(parseDateKey(minK), i);
    const key = dateKey(d);
    headHtml += `<div class="gh-day${key === tk ? ' today' : ''}" style="width:${GANTT_STATE.dayW}px;flex:0 0 ${GANTT_STATE.dayW}px">
      ${d.getMonth() + 1}/${d.getDate()}<span class="gh-wk">${WEEK_CH[d.getDay()]}</span>
    </div>`;
  }

  // 右侧时间条行
  let rowsHtml = '';
  if (tasks.length === 0) {
    rowsHtml = `<div class="gantt-row" style="height:${GANTT_ROW_H}px"></div>`;
  } else {
    for (const t of tasks) {
      const cat = CATEGORIES[t.category] || CATEGORIES.work;
      const off = Math.round((parseDateKey(eventStart(t)) - parseDateKey(minK)) / 86400000);
      const dur = durationDays(eventStart(t), eventEnd(t));
      rowsHtml += `
        <div class="gantt-row" style="height:${GANTT_ROW_H}px">
          <div class="gantt-bar${t.done ? ' done' : ''}" data-gantt-id="${t.id}"
               style="left:${off * GANTT_STATE.dayW + 1}px;width:${dur * GANTT_STATE.dayW - 3}px;background:${cat.color}55;border-left-color:${cat.color}"
               title="${escapeHtml(t.title)}（${fmtShort(eventStart(t))}~${fmtShort(eventEnd(t))}，${dur}天）">
            <span class="bar-title">${escapeHtml(t.title)}</span>
            <span class="bar-resize"></span>
          </div>
        </div>`;
    }
  }

  wrap.innerHTML = `
    <div class="gantt">
      <div class="gantt-left">${leftHtml}</div>
      <div class="gantt-right">
        <div class="gantt-inner" style="width:${innerW}px">
          <div class="gantt-head" style="height:${GANTT_HEAD_H}px">${headHtml}</div>
          <div class="gantt-body">
            ${todayOffset >= 0 && todayOffset < totalDays
              ? `<div class="gantt-today-line" style="left:${todayOffset * GANTT_STATE.dayW + GANTT_STATE.dayW / 2}px"></div>` : ''}
            ${rowsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  // 无日期事项
  if (undated.length) {
    const sub = document.createElement('div');
    sub.className = 'gantt-undated';
    sub.innerHTML = `<div class="gantt-undated-label">无日期事项</div>`;
    const ulist = document.createElement('div');
    ulist.className = 'event-list';
    for (const t of undated) ulist.appendChild(buildEventItem(t, { showDate: true }));
    sub.appendChild(ulist);
    wrap.appendChild(sub);
  }

  bindGanttDrag(wrap);
  setupGanttControls(wrap);
  return wrap;
}

// ============ 全项目总览甘特图（日历页"总览甘特"模式） ============
// 按项目分组：组标题行显示项目名与项目起止区间条，其下逐行显示该项目有日期事项；
// 无项目的事项归入末尾"未归类"组；所有无日期事项在时间轴下方单列。
function buildOverviewGantt() {
  const projects = loadProjects();
  const all = loadEvents();

  // 分组：每个项目一组；"未归类"为虚拟组，仅当存在有日期的未归类事项时成组
  // （纯无日期事项只进下方"无日期事项"区，不产生空分组）
  const groups = projects.map(p => ({ p, tasks: sortEvents(all.filter(e => e.projectId === p.id)) }));
  const loose = sortEvents(all.filter(e => !e.projectId));
  if (loose.some(t => eventStart(t))) groups.push({ p: null, tasks: loose });

  const wrap = document.createElement('div');
  wrap.className = 'gantt-wrap overview';

  // 无日期事项区（跨所有分组全局收集，含未归类）
  const undatedAll = sortEvents(all.filter(t => !eventStart(t)));
  const appendUndated = () => {
    if (!undatedAll.length) return;
    const sub = document.createElement('div');
    sub.className = 'gantt-undated';
    sub.innerHTML = `<div class="gantt-undated-label">无日期事项</div>`;
    const ulist = document.createElement('div');
    ulist.className = 'event-list';
    for (const t of undatedAll) ulist.appendChild(buildEventItem(t, { showDate: true, showProject: true }));
    sub.appendChild(ulist);
    wrap.appendChild(sub);
  };

  // 无项目且无任何有日期事项：不渲染时间轴，仅提示 + 无日期事项
  if (groups.length === 0) {
    if (all.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '— 暂无项目与事项 —';
      wrap.appendChild(hint);
    } else {
      appendUndated();
    }
    return wrap;
  }

  groups.forEach(g => {
    g.dated = g.tasks.filter(t => eventStart(t));
  });

  // 时间轴范围：项目起止区间 + 全部有日期事项 + 今天
  const ranges = [];
  for (const g of groups) {
    if (g.p && g.p.startDate) ranges.push([g.p.startDate, g.p.endDate || g.p.startDate]);
    for (const t of g.dated) ranges.push([eventStart(t), eventEnd(t)]);
  }
  const tk = dateKey(today());
  const { minK, totalDays } = calcGanttRange(ranges);
  const todayOffset = Math.round((parseDateKey(tk) - parseDateKey(minK)) / 86400000);
  const innerW = totalDays * GANTT_STATE.dayW;
  const WEEK_CH = '日一二三四五六';
  wrap.dataset.minKey = minK;

  let leftHtml = `<div class="gantt-corner" style="height:${GANTT_HEAD_H}px">项目 / 事项</div>`;
  let rowsHtml = '';

  for (const g of groups) {
    const cat = g.p ? projectCategory(g.p) : { label: '未归类', color: 'rgba(255,255,255,0.55)' };
    const gname = g.p ? g.p.name : '未归类';

    // 分组标题行：左侧项目名 + 分类色点；右侧时间轴为项目起止区间条
    leftHtml += `<div class="gantt-group-name" style="height:${GANTT_GROUP_H}px" title="${escapeHtml(gname)}">
      <span class="gg-dot" style="background:${cat.color}"></span>
      <span class="gg-text">${escapeHtml(gname)}</span>
    </div>`;
    rowsHtml += `<div class="gantt-row gantt-group-row" style="height:${GANTT_GROUP_H}px">`;
    if (g.p && g.p.startDate) {
      const s = g.p.startDate, e = g.p.endDate || s;
      const off = Math.round((parseDateKey(s) - parseDateKey(minK)) / 86400000);
      const dur = durationDays(s, e);
      rowsHtml += `<div class="gantt-pj-range"
        style="left:${off * GANTT_STATE.dayW + 1}px;width:${dur * GANTT_STATE.dayW - 3}px;background:${cat.color}26;border-left-color:${cat.color}"
        title="${escapeHtml(gname)}（${fmtShort(s)}~${fmtShort(e)}，${dur}天）"></div>`;
    }
    rowsHtml += `</div>`;

    // 事项行（该组无有日期事项时占位一行）
    if (g.dated.length === 0) {
      leftHtml += `<div class="gantt-empty-name" style="height:${GANTT_ROW_H}px">—</div>`;
      rowsHtml += `<div class="gantt-row" style="height:${GANTT_ROW_H}px"></div>`;
    } else {
      for (const t of g.dated) {
        const tcat = CATEGORIES[t.category] || CATEGORIES.work;
        const off = Math.round((parseDateKey(eventStart(t)) - parseDateKey(minK)) / 86400000);
        const dur = durationDays(eventStart(t), eventEnd(t));
        const pjPrefix = g.p ? `${escapeHtml(gname)} · ` : '';
        const recurNote = isRecurOn(t) ? `（${RECUR_FREQ_LABELS[t.recur.freq] || '重复'}重复）` : '';
        leftHtml += `<div class="gantt-name${t.done ? ' done' : ''}" style="height:${GANTT_ROW_H}px" data-gantt-id="${t.id}" title="${escapeHtml(t.title + recurNote)}">${escapeHtml(t.title)}${isRecurOn(t) ? ' 🔁' : ''}</div>`;
        rowsHtml += `
          <div class="gantt-row" style="height:${GANTT_ROW_H}px">
            <div class="gantt-bar${t.done ? ' done' : ''}" data-gantt-id="${t.id}"
                 style="left:${off * GANTT_STATE.dayW + 1}px;width:${dur * GANTT_STATE.dayW - 3}px;background:${tcat.color}55;border-left-color:${tcat.color}"
                 title="${escapeHtml(t.title)}（${pjPrefix}${fmtShort(eventStart(t))}~${fmtShort(eventEnd(t))}，${dur}天）">
              <span class="bar-title">${escapeHtml(t.title)}</span>
              <span class="bar-resize"></span>
            </div>
          </div>`;
      }
    }
  }

  // 日期表头
  let headHtml = '';
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(parseDateKey(minK), i);
    const key = dateKey(d);
    headHtml += `<div class="gh-day${key === tk ? ' today' : ''}" style="width:${GANTT_STATE.dayW}px;flex:0 0 ${GANTT_STATE.dayW}px">
      ${d.getMonth() + 1}/${d.getDate()}<span class="gh-wk">${WEEK_CH[d.getDay()]}</span>
    </div>`;
  }

  wrap.innerHTML = `
    <div class="gantt">
      <div class="gantt-left">${leftHtml}</div>
      <div class="gantt-right">
        <div class="gantt-inner" style="width:${innerW}px">
          <div class="gantt-head" style="height:${GANTT_HEAD_H}px">${headHtml}</div>
          <div class="gantt-body">
            ${todayOffset >= 0 && todayOffset < totalDays
              ? `<div class="gantt-today-line" style="left:${todayOffset * GANTT_STATE.dayW + GANTT_STATE.dayW / 2}px"></div>` : ''}
            ${rowsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  // 全部无日期事项（各项目 + 未归类）在时间轴下方单列
  appendUndated();

  bindGanttDrag(wrap);
  setupGanttControls(wrap);
  return wrap;
}

// 甘特图拖动：条身整体平移 / 右边缘改结束日；未发生移动的抬手 = 点击进编辑
function bindGanttDrag(wrap) {
  wrap.querySelectorAll('.gantt-bar').forEach(bar => {
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const id = bar.dataset.ganttId;
      const ev = loadEvents().find(x => x.id === id);
      if (!ev) return;
      const resize = e.target.classList.contains('bar-resize');
      const origStart = eventStart(ev), origEnd = eventEnd(ev);
      const startX = e.clientX;
      let moved = false;

      const onMove = (ev2) => {
        const deltaDays = Math.round((ev2.clientX - startX) / GANTT_STATE.dayW);
        if (deltaDays === 0) return;
        moved = true;
        bar.classList.add('dragging');
        if (resize) {
          const newEnd = addDaysKey(origEnd, deltaDays);
          if (newEnd < origStart) return;
          bar.style.width = (durationDays(origStart, newEnd) * GANTT_STATE.dayW - 3) + 'px';
          bar.dataset.dragEnd = newEnd;
        } else {
          const newStart = addDaysKey(origStart, deltaDays);
          const newEnd = addDaysKey(origEnd, deltaDays);
          const baseStart = wrap.dataset.minKey;
          const off = Math.round((parseDateKey(newStart) - parseDateKey(baseStart)) / 86400000);
          bar.style.left = (off * GANTT_STATE.dayW + 1) + 'px';
          bar.dataset.dragStart = newStart;
          bar.dataset.dragEnd = newEnd;
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        bar.classList.remove('dragging');
        if (moved) {
          const fields = {};
          if (resize) {
            fields.startDate = origStart;
            fields.endDate = bar.dataset.dragEnd || origEnd;
          } else {
            fields.startDate = bar.dataset.dragStart || origStart;
            fields.endDate = bar.dataset.dragEnd || origEnd;
          }
          delete bar.dataset.dragStart;
          delete bar.dataset.dragEnd;
          updateEvent(id, fields);   // 内部会 render 刷新时间轴范围
        } else {
          const cur = loadEvents().find(x => x.id === id);
          if (cur) openTaskEditor(cur);
        }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });

  // 左侧事项名点击也进入编辑
  wrap.querySelectorAll('.gantt-name').forEach(name => {
    name.addEventListener('click', () => {
      const ev = loadEvents().find(x => x.id === name.dataset.ganttId);
      if (ev) openTaskEditor(ev);
    });
  });
}

// 甘特图交互增强：缩放工具栏 + 滚轮横向滚动 + Ctrl+滚轮缩放 + 回到今天
function setupGanttControls(wrap) {
  const gantt = wrap.querySelector('.gantt');
  if (!gantt) return;
  const right = wrap.querySelector('.gantt-right');
  const minK = wrap.dataset.minKey;

  // 工具栏
  const toolbar = document.createElement('div');
  toolbar.className = 'gantt-toolbar';
  toolbar.innerHTML = `
    <button type="button" class="gantt-zoom-btn" data-act="out" title="缩小">－</button>
    <span class="gantt-zoom-label">${GANTT_STATE.dayW}px</span>
    <button type="button" class="gantt-zoom-btn" data-act="in" title="放大">＋</button>
    <button type="button" class="gantt-today-btn" title="回到今天">今天</button>
  `;
  wrap.insertBefore(toolbar, gantt);

  const label = toolbar.querySelector('.gantt-zoom-label');
  const rebuild = () => { render(); };   // 缩放后整体重渲染以重算列宽
  toolbar.querySelector('[data-act="in"]').addEventListener('click', () => {
    GANTT_STATE.dayW = ganttClampDayW(GANTT_STATE.dayW + GANTT_DAY_W_STEP);
    label.textContent = GANTT_STATE.dayW + 'px';
    rebuild();
  });
  toolbar.querySelector('[data-act="out"]').addEventListener('click', () => {
    GANTT_STATE.dayW = ganttClampDayW(GANTT_STATE.dayW - GANTT_DAY_W_STEP);
    label.textContent = GANTT_STATE.dayW + 'px';
    rebuild();
  });
  toolbar.querySelector('.gantt-today-btn').addEventListener('click', () => {
    if (!right || !minK) return;
    const tk = dateKey(today());
    const off = Math.round((parseDateKey(tk) - parseDateKey(minK)) / 86400000);
    right.scrollLeft = off * GANTT_STATE.dayW - right.clientWidth / 2;
  });

  // 滚轮：横向滚动；Ctrl+滚轮缩放
  if (right) {
    right.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const dir = e.deltaY > 0 ? -1 : 1;
        const newW = GANTT_STATE.dayW + dir * GANTT_DAY_W_STEP;
        if (ganttClampDayW(newW) === newW) {   // 步进后仍在 16~56 边界内才生效
          GANTT_STATE.dayW = newW;
          label.textContent = GANTT_STATE.dayW + 'px';
          rebuild();
        }
      } else {
        right.scrollLeft += e.deltaY || e.deltaX || 0;
      }
    }, { passive: false });
  }
}

// 事项编辑器：在当前视图顶部插入编辑表单块
function openTaskEditor(ev) {
  weekList.querySelectorAll('.editor-block').forEach(b => b.remove());
  const block = document.createElement('div');
  block.className = 'add-block editor-block';
  const form = buildTaskForm({ event: ev });
  block.appendChild(form);
  weekList.insertBefore(block, weekList.firstChild);
  form.classList.remove('hidden');
  bindFormEvents(form);
  if (window.timetable) window.timetable.setEditing(true);
  form.querySelector('.ev-title').focus();
}

// ============ 全部事项视图 ============
// 批量操作状态（仅事项视图内有效；切换视图/工具时重置）
let batchMode = false;
const batchSel = new Set();
// 标签筛选（P3.3）：'' = 全部；今日视图与事项视图共用，仅影响显示不影响数据
let tagFilter = '';

// 标签筛选 chips 条（点击切换筛选，再次点击已选项取消）
function buildTagChips() {
  const bar = document.createElement('div');
  bar.className = 'tag-chips';
  const mk = (label, val, active) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip' + (active ? ' active' : '');
    chip.textContent = label;
    chip.title = active ? '取消筛选' : `筛选「${label}」相关事项`;
    chip.addEventListener('click', () => {
      tagFilter = (tagFilter === val) ? '' : val;
      render();
    });
    return chip;
  };
  bar.appendChild(mk('全部', '', !tagFilter));
  for (const t of collectTags()) bar.appendChild(mk(t, t, tagFilter === t));
  return bar;
}

// 批量写公共字段（改分类/改项目/标记完成）；涉及项目变动统一 bump 版本号
function batchPatchFields(ids, patch) {
  const all = loadEvents();
  const pids = new Set();
  for (const ev of all) {
    if (!ids.includes(ev.id)) continue;
    Object.assign(ev, patch);
    ev.updatedAt = new Date().toISOString();
    if (ev.projectId) pids.add(ev.projectId);
  }
  saveEvents(all);
  pids.forEach(p => bumpProjectRevision(p));
  render();
}

// 批量删除（一次确认，列出数量；不改单条删除的无确认行为）
function batchDeleteEvents(ids) {
  const all = loadEvents();
  const pids = new Set();
  for (const id of ids) {
    const ev = all.find(e => e.id === id);
    if (ev && ev.projectId) pids.add(ev.projectId);
  }
  saveEvents(all.filter(e => !ids.includes(e.id)));
  // 同步墓碑（P3.4）：批量删除同样写墓碑，保证删除传播
  for (const id of ids) addTombstone(id, 'event');
  pids.forEach(p => bumpProjectRevision(p));
  render();
}

// 批量操作条（事项视图顶部；分类选择复用右键菜单面板）
function buildBatchBar(all) {
  const bar = document.createElement('div');
  bar.className = 'batch-bar';
  const n = batchSel.size;
  const dis = n ? '' : 'disabled';
  bar.innerHTML = `
    <button class="batch-btn" data-act="all">${n === all.length && all.length ? '全不选' : '全选'}</button>
    <button class="batch-btn" data-act="cat" ${dis}>改分类</button>
    <button class="batch-btn" data-act="proj" ${dis}>改项目</button>
    <button class="batch-btn" data-act="done" ${dis}>标记完成</button>
    <button class="batch-btn danger" data-act="del" ${dis}>删除</button>
    <span class="batch-count">${n ? `已选 ${n} 项` : '点击事项行选择'}</span>
    <button class="batch-btn exit" data-act="exit">完成批量</button>
  `;
  bar.querySelectorAll('.batch-btn').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = btn.dataset.act;
    const ids = [...batchSel];
    if (act === 'all') {
      if (batchSel.size === all.length && all.length) batchSel.clear();
      else all.forEach(ev => batchSel.add(ev.id));
      render();
    } else if (act === 'exit') {
      batchMode = false; batchSel.clear(); render();
    } else if (!n) {
      return;   // 未选中任何项时其余操作禁用
    } else if (act === 'cat') {
      // 借用右键菜单容器展示三个分类项（定位到按钮下方）
      const r = btn.getBoundingClientRect();
      showItems(r.left, r.bottom + 4);
      ctxItems.innerHTML = Object.keys(CATEGORIES)
        .map(c => `<div class="ctx-item" data-action="${c}">${CATEGORIES[c].label}</div>`).join('');
      bindItemHandlers({
        work: () => { batchPatchFields(ids, { category: 'work' }); batchMode = false; batchSel.clear(); },
        personal: () => { batchPatchFields(ids, { category: 'personal' }); batchMode = false; batchSel.clear(); },
        family: () => { batchPatchFields(ids, { category: 'family' }); batchMode = false; batchSel.clear(); }
      });
    } else if (act === 'proj') {
      openProjectPicker('调整到哪个项目', null, (pid) => {
        batchPatchFields(ids, { projectId: pid || null });
        batchMode = false; batchSel.clear();
      });
    } else if (act === 'done') {
      batchPatchFields(ids, { done: true });
      batchMode = false; batchSel.clear();
    } else if (act === 'del') {
      if (confirm(`删除选中的 ${n} 项？此操作不可撤销。`)) {
        batchDeleteEvents(ids);
        batchMode = false; batchSel.clear();
      }
    }
  }));
  return bar;
}

function renderTasks() {
  const all = sortEvents(loadEvents());
  // 标签筛选（P3.3）：筛选态只改显示集合，批量计数/标题仍基于全量
  const shown = tagFilter ? filterByTag(all, tagFilter) : all;
  setHeader('全部事项', batchMode ? `已选 ${batchSel.size} 项` : (tagFilter ? `筛选 ${shown.length}/${all.length} 项` : `共 ${all.length} 项`), false);
  weekList.innerHTML = '';

  // 批量模式：置顶操作条，隐藏新建入口避免干扰
  if (batchMode) weekList.appendChild(buildBatchBar(all));

  if (!batchMode) {
    // 标签筛选 chips：存在标签或筛选进行中（后者保证可退出筛选）时显示
    if (collectTags().length || tagFilter) weekList.appendChild(buildTagChips());
    // 新建事项入口（未固定日期/项目）
    const block = document.createElement('div');
    block.className = 'add-block';
    const btnRow = document.createElement('div');
    btnRow.className = 'top-add-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'top-add';
    addBtn.textContent = '+ 新建事项';
    const batchBtn = document.createElement('button');
    batchBtn.className = 'top-add batch-enter';
    batchBtn.textContent = '批量管理';
    batchBtn.addEventListener('click', () => { batchMode = true; batchSel.clear(); render(); });
    btnRow.appendChild(addBtn);
    btnRow.appendChild(batchBtn);
    const form = buildTaskForm({});
    block.appendChild(btnRow);
    block.appendChild(form);
    weekList.appendChild(block);
  }

  const list = document.createElement('div');
  list.className = 'event-list';
  if (shown.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = tagFilter ? `— 无「${tagFilter}」标签事项 —` : '— 暂无事项 —';
    list.appendChild(hint);
  } else {
    for (const ev of shown) {
      const item = buildEventItem(ev, { showDate: true, showProject: true });
      if (batchMode) {
        // 多选模式：整行点击切换选中；去掉单点控件避免与 bindViewEvents 的绑定冲突
        const chk = item.querySelector('.event-check'); if (chk) chk.remove();
        const del = item.querySelector('.event-del'); if (del) del.remove();
        item.classList.toggle('batch-selected', batchSel.has(ev.id));
        item.addEventListener('click', () => {
          if (batchSel.has(ev.id)) batchSel.delete(ev.id); else batchSel.add(ev.id);
          render();
        });
      }
      list.appendChild(item);
    }
  }
  weekList.appendChild(list);

  bindViewEvents();
}

// ============ 数据操作 ============
function addEvent(fields, skipRender) {
  const all = loadEvents();
  all.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
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
  });
  saveEvents(all);
  bumpProjectRevision(fields.projectId);   // 项目内容变化 → 版本号递增
  if (!skipRender) render();               // 批量场景由调用方最后统一 render
}

// 编辑事项（日期区间/分类/紧急程度/项目等）
function updateEvent(id, fields) {
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  if (ev) {
    const oldPid = ev.projectId;
    if (fields.startDate !== undefined) {
      ev.startDate = fields.startDate;
      ev.endDate = fields.endDate || fields.startDate;
      ev.date = fields.startDate;
    }
    for (const k of ['time', 'title', 'category', 'urgency', 'projectId', 'recur', 'tags', 'checklist']) {
      if (fields[k] !== undefined) ev[k] = fields[k];
    }
    ev.updatedAt = new Date().toISOString();
    saveEvents(all);
    if (oldPid) bumpProjectRevision(oldPid);
    if (fields.projectId && fields.projectId !== oldPid) bumpProjectRevision(fields.projectId);
    render();
  }
}

function deleteEvent(id) {
  // 虚拟事项（模板id@日期）：删除作用于整个重复系列（模板）
  if (id.includes('@')) id = id.slice(0, id.lastIndexOf('@'));
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  saveEvents(all.filter(e => e.id !== id));
  addTombstone(id, 'event');   // 同步墓碑（P3.4）：删除传播
  if (ev && ev.projectId) bumpProjectRevision(ev.projectId);
  render();
}

function toggleDone(id) {
  // 虚拟事项（重复投影）：完成态按日 override，不改模板 done
  if (id.includes('@')) {
    const i = id.lastIndexOf('@');
    const evId = id.slice(0, i), dKey = id.slice(i + 1);
    recurDoneSet(evId, dKey, !recurDoneGet(evId, dKey));
    render();
    return;
  }
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  if (ev) {
    ev.done = !ev.done;
    ev.updatedAt = new Date().toISOString();
    saveEvents(all);
    bumpProjectRevision(ev.projectId);
    render();
  }
}

// 将事项移动到指定日期：多日事项整体平移（保持持续天数），单日事项直接改期；
// 虚拟投影 id（模板id@日期）解析为模板（拖拽/右键改期共用，语义：重复系列整体改起始日）
function moveEventToDate(id, newDateKey) {
  if (id.includes('@')) id = id.slice(0, id.lastIndexOf('@'));
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  if (ev) {
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
    saveEvents(all);
    bumpProjectRevision(ev.projectId);
    render();
  }
}

// 将事项调整到项目（pid 为空 = 未归类）
function moveEventToProject(id, pid) {
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  if (ev) {
    const oldPid = ev.projectId;
    ev.projectId = pid || null;
    ev.updatedAt = new Date().toISOString();
    saveEvents(all);
    if (oldPid) bumpProjectRevision(oldPid);
    if (ev.projectId && ev.projectId !== oldPid) bumpProjectRevision(ev.projectId);
    render();
  }
}

// 完成指定日期的全部事项（含重复事项该日投影 → 写按日 override）
function markDateDone(dateKeyStr) {
  let changed = false;
  for (const view of getEventsByDate(dateKeyStr)) {
    if (view._templateId) {
      if (!recurDoneGet(view._templateId, dateKeyStr)) { recurDoneSet(view._templateId, dateKeyStr, true); changed = true; }
    } else if (!view.done) { view.done = true; changed = true; }
  }
  if (changed) { saveEvents(loadEvents()); render(); }
}

// 完成日历当前可见范围的全部事项（逐日投影，重复事项按日记 override）
function markAllDone() {
  let changed = false;
  for (let i = 0; i < RANGE_DAYS; i++) {
    const key = dateKey(addDays(rangeStart, i));
    for (const view of getEventsByDate(key)) {
      if (view._templateId) {
        if (!recurDoneGet(view._templateId, key)) { recurDoneSet(view._templateId, key, true); changed = true; }
      } else if (!view.done) { view.done = true; changed = true; }
    }
  }
  if (changed) { saveEvents(loadEvents()); render(); }
}

// ============ 项目操作 ============
function addProject(fields) {
  const list = loadProjects();
  list.push({
    id: 'p' + String(Date.now()) + Math.random().toString(36).slice(2, 6),
    name: fields.name,
    description: fields.description || '',
    startDate: fields.startDate || '',
    endDate: fields.endDate || fields.startDate || '',
    category: fields.category || 'work',
    priority: fields.priority || 'medium',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveProjects(list);
  render();
}

function updateProject(id, fields) {
  const list = loadProjects();
  const p = list.find(x => x.id === id);
  if (p) {
    Object.assign(p, fields, { revision: (p.revision || 1) + 1, updatedAt: new Date().toISOString() });
    saveProjects(list);
    render();
  }
}

function deleteProject(id) {
  saveProjects(loadProjects().filter(p => p.id !== id));
  addTombstone(id, 'project');   // 同步墓碑（P3.4）：删除传播
  // 项目下事项 → 未归类
  const all = loadEvents();
  let changed = false;
  for (const ev of all) {
    if (ev.projectId === id) { ev.projectId = null; changed = true; }
  }
  if (changed) saveEvents(all);
  if (expandedProjectId === id) expandedProjectId = null;
  delete projectDetailModes[id];
  // 清理该项目的同步基准
  const bases = loadSyncBases();
  if (bases[id]) { delete bases[id]; saveSyncBases(bases); }
  render();
}

// ============ 项目文件导出 / 导入 / 三方合并（非实时协作） ============
// 模型：Base（上次双方共同版本 = 同步基准）/ Local（本地当前）/ Incoming（导入文件），
// 逐字段三方比较：只一方改 → 自动采纳；双方改同一字段 → 冲突交用户选择。
// 基准在「导出成功」「导入为新项目」「合并完成」时更新为交换点快照。

// ---- 同步基准存取（localStorage: syncBases） ----
function loadSyncBases() {
  try { return JSON.parse(localStorage.getItem('syncBases') || '{}'); } catch { return {}; }
}
function saveSyncBases(bases) {
  localStorage.setItem('syncBases', JSON.stringify(bases));
}

// ---- 设备标识与配对列表（局域网同步预留） ----
// deviceId：本机唯一标识（UUID v4），首次启动生成后持久化
function getDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = 'dev-' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem('deviceId', id);
  }
  return id;
}
// 已配对设备列表：[{deviceId, name, platform, pairedAt, status}]
function loadSyncPairs() {
  try { return JSON.parse(localStorage.getItem('syncPairs') || '[]'); } catch { return []; }
}
function saveSyncPairs(pairs) {
  localStorage.setItem('syncPairs', JSON.stringify(pairs));
}

// ---- 同步墓碑（P3.4）：删除传播用，localStorage: syncTombstones，上限 500 条滚动 ----
// 结构：[{ id, kind:'event'|'project', deletedAt, deviceId }]
const TOMBSTONE_MAX = 500;
function loadTombstones() {
  try {
    const list = JSON.parse(localStorage.getItem('syncTombstones') || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function saveTombstones(list) {
  // 滚动截断：超出上限只留最新（deletedAt 大的在前）
  const sorted = (Array.isArray(list) ? list : []).slice().sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  localStorage.setItem('syncTombstones', JSON.stringify(sorted.slice(0, TOMBSTONE_MAX)));
}
function addTombstone(id, kind) {
  const list = loadTombstones();
  // 幂等：同 id+kind 只保留最新一条
  const rest = list.filter(t => !(t.id === id && t.kind === kind));
  rest.push({ id, kind, deletedAt: new Date().toISOString(), deviceId: getDeviceId() });
  saveTombstones(rest);
}

// ---- 同步快照组装/合并（P3.4） ----
// 快照 = { deviceId, at, projects, events, tombstones, pomoHistory }（整条记录传输，recur/tags 随记录走）
function buildSyncSnapshot() {
  return {
    deviceId: getDeviceId(),
    at: new Date().toISOString(),
    projects: loadProjects(),
    events: loadEvents(),
    tombstones: loadTombstones(),
    pomoHistory: (() => { try { return JSON.parse(localStorage.getItem('pomoHistory') || '[]'); } catch { return []; } })()
  };
}

// LWW 决胜：updatedAt 新者胜；完全相同按 deviceId 字典序兜底（确定性不抖动）
// 返回 true = a 胜（采用 a）
function lwwWin(aUpd, aDev, bUpd, bDev) {
  const au = aUpd || '', bu = bUpd || '';
  if (au !== bu) return au > bu;
  return String(aDev || '') >= String(bDev || '');
}

// 合并本地与对端快照（纯函数，不写存储；返回合并后的数据与统计）
// local/remote 形态同 buildSyncSnapshot；墓碑：删除时间晚于记录 updatedAt → 删除
function mergeSyncData(local, remote) {
  const stats = { projects: { added: 0, updated: 0, deleted: 0 }, events: { added: 0, updated: 0, deleted: 0 } };
  const myDev = (local && local.deviceId) || '';
  const peerDev = (remote && remote.deviceId) || '';

  // 墓碑合并（去重：同 id+kind 保留 deletedAt 最新）
  const tombMap = new Map();
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    if (!t || !t.id || !t.kind) continue;
    const k = t.kind + '|' + t.id;
    const old = tombMap.get(k);
    if (!old || (t.deletedAt || '') > (old.deletedAt || '')) tombMap.set(k, t);
  }
  const tombs = Array.from(tombMap.values());
  const tombOf = (kind, id) => tombMap.get(kind + '|' + id);

  // 项目/事项共用合并器
  const mergeList = (localList, remoteList, kind) => {
    const out = new Map();   // id → 记录
    const st = kind === 'project' ? stats.projects : stats.events;
    // 先放本地
    for (const r of localList || []) {
      const t = tombOf(kind, r.id);
      if (t && (t.deletedAt || '') > (r.updatedAt || '')) { st.deleted++; continue; }   // 本侧墓碑删本地
      out.set(r.id, r);
    }
    // 再合对端
    for (const r of remoteList || []) {
      const t = tombOf(kind, r.id);
      if (t && (t.deletedAt || '') > (r.updatedAt || '')) {
        // 对端记录被墓碑删除：若本地有则一并删
        if (out.delete(r.id)) st.deleted++;
        continue;
      }
      const cur = out.get(r.id);
      if (!cur) { out.set(r.id, r); st.added++; continue; }
      // 双方都有 → LWW（updatedAt 完全相同按 deviceId 兜底）
      if (lwwWin(r.updatedAt, peerDev, cur.updatedAt, myDev)) {
        out.set(r.id, r);
        st.updated++;
      }
    }
    return Array.from(out.values());
  };

  const projects = mergeList(local.projects, remote.projects, 'project');
  const events = mergeList(local.events, remote.events, 'event');

  // 番茄钟历史：按 date 合并取 count/minutes 较大值（同一日双端各自累计，取大避免回退）
  const pomoMap = new Map();
  for (const h of [...(local.pomoHistory || []), ...(remote.pomoHistory || [])]) {
    if (!h || !h.date) continue;
    const cur = pomoMap.get(h.date);
    if (!cur) { pomoMap.set(h.date, { date: h.date, count: h.count || 0, minutes: h.minutes || 0 }); }
    else {
      cur.count = Math.max(cur.count, h.count || 0);
      cur.minutes = Math.max(cur.minutes, h.minutes || 0);
    }
  }
  const pomoHistory = Array.from(pomoMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return { projects, events, tombstones: tombs, pomoHistory, stats };
}

// 把合并结果应用到本地存储 + render（syncAt 写入每条记录的 lastSyncAt 便于追溯）
function applyMergedData(merged, peerName) {
  const syncAt = new Date().toISOString();
  for (const p of merged.projects) p.lastSyncAt = syncAt;
  for (const ev of merged.events) ev.lastSyncAt = syncAt;
  saveProjects(merged.projects);
  saveEvents(merged.events);
  saveTombstones(merged.tombstones);
  localStorage.setItem('pomoHistory', JSON.stringify(merged.pomoHistory));
  addSyncLog('lan-sync', {
    detail: `与「${peerName || '对端设备'}」同步完成：项目 +${merged.stats.projects.added}/~${merged.stats.projects.updated}/-${merged.stats.projects.deleted}，事项 +${merged.stats.events.added}/~${merged.stats.events.updated}/-${merged.stats.events.deleted}`
  });
  render();
}

// ---- 同步操作日志（localStorage: syncLog，最新在前，上限 200 条） ----
// 记录项目导出/导入/合并全过程，用于离线协作追溯
function loadSyncLog() {
  try { return JSON.parse(localStorage.getItem('syncLog') || '[]'); } catch { return []; }
}
// action: export / export-cancel / export-fail / import-file / import-invalid / import-cancel / merge / import-new
function addSyncLog(action, opts = {}) {
  const log = loadSyncLog();
  log.unshift({
    time: new Date().toISOString(),
    action,
    pid: opts.pid || '',
    pname: opts.pname || '',
    revision: opts.revision === undefined ? '' : opts.revision,
    detail: opts.detail || ''
  });
  if (log.length > 200) log.length = 200;
  localStorage.setItem('syncLog', JSON.stringify(log));
}

// 项目 revision 自增（本地内容变化时调用；导入/合并直接写值，不经此函数）
function bumpProjectRevision(pid) {
  if (!pid) return;
  const list = loadProjects();
  const p = list.find(x => x.id === pid);
  if (!p) return;
  p.revision = (p.revision || 1) + 1;
  p.updatedAt = new Date().toISOString();
  saveProjects(list);
}

// 事项规范化快照（比较/导出用；date 由 startDate 派生，不参与比较）
function normTaskSnap(t) {
  return {
    id: t.id,
    title: t.title || '',
    time: t.time || '',
    startDate: eventStart(t),
    endDate: eventEnd(t),
    done: !!t.done,
    category: t.category || 'work',
    urgency: t.urgency || 'normal',
    description: t.description || '',
    createdAt: t.createdAt || '',
    updatedAt: t.updatedAt || ''
  };
}

// 当前本地项目的同步快照
function snapshotProject(pid) {
  const p = getProject(pid);
  if (!p) return null;
  return {
    revision: p.revision || 1,
    exportedAt: new Date().toISOString(),
    project: {
      id: p.id, name: p.name || '',
      description: p.description || '',
      startDate: p.startDate || '', endDate: p.endDate || '',
      category: p.category || 'work', priority: p.priority || 'medium',
      status: p.status || 'active',
      createdAt: p.createdAt || '', updatedAt: p.updatedAt || '',
      revision: p.revision || 1
    },
    tasks: loadEvents().filter(e => e.projectId === pid).map(normTaskSnap)
  };
}

// 写入同步基准（snap = {revision, project, tasks} 的快照）
function setSyncBase(pid, snap) {
  const bases = loadSyncBases();
  bases[pid] = {
    revision: snap.revision || 1,
    exportedAt: snap.exportedAt || new Date().toISOString(),
    project: JSON.parse(JSON.stringify(snap.project)),
    tasks: JSON.parse(JSON.stringify(snap.tasks || []))
  };
  saveSyncBases(bases);
}

// ---- 导出 .prj ----
async function exportProjectFile(pid) {
  const p = getProject(pid);
  if (!p) return;
  const snap = snapshotProject(pid);
  const payload = {
    schema_version: 1,
    kind: 'timetable-project',
    project_id: snap.project.id,
    revision: snap.revision,
    exported_at: snap.exportedAt,
    project: snap.project,
    tasks: snap.tasks
  };
  const content = JSON.stringify(payload, null, 2);
  const safeName = (p.name || 'project').replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
  const fname = `${safeName}-rev${snap.revision}.prj`;
  let res = null;
  if (window.timetable && window.timetable.exportProjectFile) {
    res = await window.timetable.exportProjectFile(fname, content);
  } else {
    // 浏览器环境回退：Blob 下载
    try {
      const blob = new Blob([content], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      res = { ok: true };
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
  }
  if (res && res.ok) {
    setSyncBase(pid, snap);   // 导出成功 → 本次导出内容成为同步基准
    addSyncLog('export', { pid, pname: p.name, revision: snap.revision, detail: res.path || fname });
    showToast(`已导出：${res.path || fname}`);
  } else if (res && !res.canceled) {
    addSyncLog('export-fail', { pid, pname: p.name, revision: snap.revision, detail: res.error || '未知错误' });
    showToast('导出失败：' + (res.error || '未知错误'));
  } else if (res && res.canceled) {
    addSyncLog('export-cancel', { pid, pname: p.name, revision: snap.revision, detail: fname });
  }
}

// ---- 导入 .prj ----
async function importProjectFileFlow() {
  let content = null;
  let filePath = '';
  if (window.timetable && window.timetable.importProjectFile) {
    const res = await window.timetable.importProjectFile();
    if (!res || !res.ok) return;   // 用户取消或读取失败
    content = res.content;
    filePath = res.path || '';
  } else {
    content = await pickFileViaInput();
    if (content === null) return;
  }
  const fname = filePath ? filePath.split(/[\\/]/).pop() : '';
  let data;
  try { data = JSON.parse(content); }
  catch {
    addSyncLog('import-invalid', { detail: fname ? `${fname}：不是有效的 JSON` : '不是有效的 JSON' });
    showToast('导入失败：文件不是有效的 JSON'); return;
  }
  const err = validatePrjPayload(data);
  if (err) {
    addSyncLog('import-invalid', { pname: (data.project && data.project.name) || '', revision: data.revision, detail: fname ? `${fname}：${err}` : err });
    showToast('导入失败：' + err); return;
  }
  addSyncLog('import-file', { pid: data.project_id, pname: data.project.name, revision: data.revision, detail: fname });
  openSyncPreview(data);
}

// 浏览器环境回退：动态 file input 读取文本
function pickFileViaInput() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.prj,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { input.remove(); resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => { input.remove(); resolve(String(reader.result)); };
      reader.onerror = () => { input.remove(); resolve(null); };
      reader.readAsText(file);
    });
    input.click();
  });
}

function validatePrjPayload(data) {
  if (!data || typeof data !== 'object') return '文件内容不是对象';
  if (data.kind !== 'timetable-project') return '不是本项目导出的项目文件（kind 不符）';
  if (data.schema_version !== 1) return `不支持的文件版本（schema_version=${data.schema_version}）`;
  if (!data.project_id || typeof data.project_id !== 'string') return '缺少 project_id';
  if (!data.project || typeof data.project !== 'object' || typeof data.project.name !== 'string') return 'project 数据缺失';
  if (!Array.isArray(data.tasks)) return 'tasks 必须是数组';
  for (const t of data.tasks) {
    if (!t || typeof t.id !== 'string' || typeof t.title !== 'string') return '存在缺少 id/title 的事项';
  }
  return null;
}

// ---- 三方合并引擎 ----
const SYNC_PROJECT_FIELDS = [
  { key: 'name',        label: '项目名称', type: 'text' },
  { key: 'description', label: '项目简介', type: 'text' },
  { key: 'startDate',   label: '开始日期', type: 'date' },
  { key: 'endDate',     label: '结束日期', type: 'date' },
  { key: 'category',    label: '分类',     type: 'category' },
  { key: 'priority',    label: '优先级',   type: 'text' },
  { key: 'status',      label: '状态',     type: 'text' }
];
const SYNC_TASK_FIELDS = [
  { key: 'title',       label: '标题',     type: 'text' },
  { key: 'time',        label: '时间',     type: 'text' },
  { key: 'startDate',   label: '开始日期', type: 'date' },
  { key: 'endDate',     label: '结束日期', type: 'date' },
  { key: 'category',    label: '分类',     type: 'category' },
  { key: 'urgency',     label: '紧急程度', type: 'urgency' },
  { key: 'done',        label: '完成状态', type: 'done' },
  { key: 'description', label: '备注',     type: 'text' }
];
const TASK_FIELD_DEFAULTS = {
  title: '', time: '', startDate: '', endDate: '',
  category: 'work', urgency: 'normal', done: false, description: ''
};

function sameVal(a, b) { return String(a) === String(b); }

// 单字段三方比较：same=一致 / incoming=仅导入改 / local=仅本地改 / conflict=双方都改
function merge3(b, l, i) {
  if (sameVal(l, i)) return { state: 'same', value: l };
  if (sameVal(l, b)) return { state: 'incoming', value: i };
  if (sameVal(i, b)) return { state: 'local', value: l };
  return { state: 'conflict' };
}

// 生成一条字段比较记录（含冲突时的默认选择 = 保留本地）
function fieldRow(f, b, l, i) {
  const m = merge3(b, l, i);
  return Object.assign({}, f, {
    base: b, local: l, incoming: i,
    state: m.state, value: m.value,
    resolution: m.state === 'conflict' ? 'local' : null
  });
}

function fv(t, key) {
  return (t === undefined || t[key] === undefined) ? TASK_FIELD_DEFAULTS[key] : t[key];
}

// 构建合并计划（纯比较，不改数据）
function buildMergePlan(localProject, base, incoming) {
  const pid = incoming.project_id;
  const localTasks = loadEvents().filter(e => e.projectId === pid).map(normTaskSnap);
  const baseP = (base && base.project) || {};
  const baseT = (base && base.tasks) || [];

  // 项目字段比较
  const projectFields = SYNC_PROJECT_FIELDS.map(f => fieldRow(
    f,
    baseP[f.key] === undefined ? '' : baseP[f.key],
    localProject[f.key] === undefined ? '' : localProject[f.key],
    incoming.project[f.key] === undefined ? '' : incoming.project[f.key]
  ));

  // 事项三方比较
  const B = new Map(baseT.map(t => [t.id, t]));
  const L = new Map(localTasks.map(t => [t.id, t]));
  const I = new Map(incoming.tasks.map(t => [t.id, t]));
  const ids = [...new Set([...B.keys(), ...L.keys(), ...I.keys()])].sort();
  const taskPlans = [];

  for (const id of ids) {
    const b = B.get(id), l = L.get(id), i = I.get(id);
    if (l && i) {
      const fields = SYNC_TASK_FIELDS.map(f => fieldRow(f, fv(b, f.key), fv(l, f.key), fv(i, f.key)));
      const conflicts = fields.filter(x => x.state === 'conflict');
      if (b) {
        if (conflicts.length) {
          taskPlans.push({ id, kind: 'conflict-update', fields, displayTitle: l.title });
        } else if (fields.some(x => x.state === 'incoming')) {
          taskPlans.push({ id, kind: 'update', fields, displayTitle: l.title });
        }
        // 其余：无变化或仅本地修改 → 不列出（本地已是最终值）
      } else if (conflicts.length) {
        // 双方各自新增了同 id 事项且内容不同：逐字段冲突，绝不静默覆盖
        taskPlans.push({ id, kind: 'conflict-update', fields, displayTitle: l.title });
      }
      // 无 base 且内容完全一致 → 两端生成了相同内容，视为同一事项，无需处理
    } else if (l && !i) {
      if (!b) {
        taskPlans.push({ id, kind: 'add-local', displayTitle: l.title });
      } else {
        const changed = SYNC_TASK_FIELDS.filter(f => !sameVal(fv(l, f.key), fv(b, f.key)));
        taskPlans.push(changed.length
          ? { id, kind: 'conflict-del-remote', displayTitle: l.title, changeLabels: changed.map(f => f.label), resolution: 'keepLocal' }
          : { id, kind: 'delete-auto', displayTitle: l.title, deleteSide: 'remote' });
      }
    } else if (!l && i) {
      if (!b) {
        taskPlans.push({ id, kind: 'add-incoming', displayTitle: i.title });
      } else {
        const changed = SYNC_TASK_FIELDS.filter(f => !sameVal(fv(i, f.key), fv(b, f.key)));
        taskPlans.push(changed.length
          ? { id, kind: 'conflict-del-local', displayTitle: i.title, changeLabels: changed.map(f => f.label), resolution: 'keepDeleted' }
          : { id, kind: 'delete-auto', displayTitle: i.title, deleteSide: 'local' });
      }
    }
    // base 有而双方都没有 → 两端都已删除，忽略
  }

  const counts = {
    addLocal: taskPlans.filter(t => t.kind === 'add-local').length,
    addIncoming: taskPlans.filter(t => t.kind === 'add-incoming').length,
    updated: taskPlans.filter(t => t.kind === 'update').length,
    deletedAuto: taskPlans.filter(t => t.kind === 'delete-auto').length,
    conflictTasks: taskPlans.filter(t => t.kind === 'conflict-update').length,
    delConflicts: taskPlans.filter(t => t.kind === 'conflict-del-local' || t.kind === 'conflict-del-remote').length,
    projectConflicts: projectFields.filter(f => f.state === 'conflict').length
  };
  return {
    hasBase: !!base,
    baseRevision: base ? base.revision : 0,
    projectFields,
    tasks: taskPlans,
    counts
  };
}

// 冲突总数（字段级冲突 + 删除冲突）
function planConflictCount(plan) {
  let n = plan.counts.projectConflicts + plan.counts.delConflicts;
  for (const t of plan.tasks) {
    if (t.kind === 'conflict-update') n += t.fields.filter(f => f.state === 'conflict').length;
  }
  return n;
}

// 需要展示/执行的变更总数
function planChangeCount(plan) {
  let n = plan.counts.addLocal + plan.counts.addIncoming + plan.counts.updated +
          plan.counts.deletedAuto + plan.counts.conflictTasks + plan.counts.delConflicts;
  n += plan.projectFields.filter(f => f.state === 'incoming').length;
  return n;
}

function resolveFieldValue(f) {
  if (f.resolution === 'incoming') return f.incoming;
  if (f.resolution && typeof f.resolution === 'object') return f.resolution.value;
  return f.local;   // 'local' 或未选择（兜底保留本地）
}

// 导入事项 → 本地事项对象（date 与 startDate 同步）
function eventFromIncoming(t, pid, createdAtFallback) {
  const s = t.startDate || '';
  return {
    id: t.id,
    date: s,
    startDate: s,
    endDate: t.endDate || s,
    time: t.time || '',
    title: t.title,
    done: !!t.done,
    category: t.category || 'work',
    urgency: t.urgency || 'normal',
    projectId: pid,
    description: t.description || '',
    createdAt: t.createdAt || createdAtFallback || new Date().toISOString(),
    updatedAt: t.updatedAt || ''
  };
}

// 应用合并结果（三方合并的写回）
function applySyncPlan() {
  const plan = syncState.plan;
  const incoming = syncState.incoming;
  const pid = incoming.project_id;

  // 项目字段
  const projects = loadProjects();
  const p = projects.find(x => x.id === pid);
  if (!p) { showToast('本地项目不存在，无法合并'); return; }
  for (const f of plan.projectFields) {
    if (f.state === 'conflict') p[f.key] = resolveFieldValue(f);
    else if (f.state === 'incoming') p[f.key] = f.value;
  }
  p.revision = Math.max(p.revision || 1, incoming.revision || 0, plan.baseRevision || 0) + 1;
  p.updatedAt = new Date().toISOString();
  saveProjects(projects);

  // 事项
  const itemById = new Map(plan.tasks.map(t => [t.id, t]));
  const result = [];
  for (const ev of loadEvents()) {
    if (ev.projectId !== pid) { result.push(ev); continue; }
    const item = itemById.get(ev.id);
    if (!item) { result.push(ev); continue; }             // 无变化/仅本地修改 → 原样保留
    if (item.kind === 'delete-auto') continue;            // 自动删除
    if (item.kind === 'conflict-del-remote') {            // 导入删除 vs 本地修改
      if (item.resolution === 'applyDelete') continue;
      result.push(ev);
      continue;
    }
    if (item.kind === 'update' || item.kind === 'conflict-update') {
      for (const f of item.fields) {
        if (f.state === 'conflict') ev[f.key] = resolveFieldValue(f);
        else if (f.state === 'incoming') ev[f.key] = f.value;
      }
      ev.date = ev.startDate || '';                       // date 与 startDate 保持同步
      ev.updatedAt = new Date().toISOString();
    }
    result.push(ev);                                      // add-local 等 → 原样保留
  }
  // 本地已删除、用户选择恢复导入版本的事项（本地已不存在，须在此补回）
  for (const item of plan.tasks) {
    if (item.kind === 'conflict-del-local' && item.resolution === 'restoreIncoming') {
      const it = incoming.tasks.find(t => t.id === item.id);
      if (it) result.push(eventFromIncoming(it, pid, ''));
    }
  }
  // 导入新增
  for (const item of plan.tasks) {
    if (item.kind !== 'add-incoming') continue;
    const it = incoming.tasks.find(t => t.id === item.id);
    if (it) result.push(eventFromIncoming(it, pid, ''));
  }
  saveEvents(result);

  // 关键：合并后的基准 = 导入文件快照（对方家系的上游），而非本地合并结果。
  // 这样对方下次导出的文件仍以同一祖先比较，本地独有内容不会被误判为"对方已删除"。
  setSyncBase(pid, { revision: incoming.revision, exportedAt: incoming.exported_at, project: incoming.project, tasks: incoming.tasks });

  const cfN = planConflictCount(plan);
  addSyncLog('merge', {
    pid, pname: p.name, revision: p.revision,
    detail: `导入 rev ${incoming.revision}：＋${plan.counts.addIncoming} ✎${plan.counts.updated} ✂${plan.counts.deletedAuto}${cfN ? `，冲突 ${cfN} 处` : ''}`
  });

  syncState = null;
  if (window.timetable) window.timetable.setEditing(false);
  render();
  showToast('合并完成，已更新同步基准');
}

// 导入为新项目（本地不存在该 project_id）
function applyImportNew() {
  const incoming = syncState.incoming;
  const pid = incoming.project_id;
  const projects = loadProjects();
  if (projects.some(x => x.id === pid)) { showToast('本地已存在该项目，已转为合并模式'); openSyncPreview(incoming); return; }
  const ip = incoming.project;
  projects.push({
    id: pid,
    name: ip.name || '',
    description: ip.description || '',
    startDate: ip.startDate || '', endDate: ip.endDate || '',
    category: ip.category || 'work',
    priority: ip.priority || 'medium',
    status: ip.status || 'active',
    revision: incoming.revision || 1,
    createdAt: ip.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  saveProjects(projects);

  // 事项：id 与本地任何事项冲突时重新编号，绝不静默覆盖
  const all = loadEvents();
  const existingIds = new Set(all.map(e => e.id));
  let remapCount = 0;
  for (const t of incoming.tasks) {
    const ev = eventFromIncoming(t, pid, '');
    if (existingIds.has(ev.id)) {
      ev.id = 't' + Date.now() + Math.random().toString(36).slice(2, 6);
      remapCount++;
      existingIds.add(ev.id);
    }
    existingIds.add(ev.id);
    all.push(ev);
  }
  saveEvents(all);

  setSyncBase(pid, { revision: incoming.revision, exportedAt: incoming.exported_at, project: incoming.project, tasks: incoming.tasks });
  expandedProjectId = pid;   // 导入后展开方便查看
  addSyncLog('import-new', { pid, pname: ip.name, revision: incoming.revision, detail: `${incoming.tasks.length} 个事项${remapCount ? `，${remapCount} 个 ID 冲突重编号` : ''}` });
  syncState = null;
  if (window.timetable) window.timetable.setEditing(false);
  render();
  showToast(remapCount ? `项目导入完成（${remapCount} 个事项 ID 冲突已重新编号）` : '项目导入完成');
}

// 检查导入任务 id 与本地事项的跨项目重复（导入新项目时提示）
function findIdCollisions(inTasks) {
  const local = loadEvents();
  return inTasks.filter(t => local.some(e => e.id === t.id)).map(t => t.id);
}

// ---- 同步预览入口 ----
function openSyncPreview(incoming) {
  const pid = incoming.project_id;
  const localProject = getProject(pid);
  const base = loadSyncBases()[pid] || null;
  if (!localProject) {
    syncState = { mode: 'import-new', incoming, collisions: findIdCollisions(incoming.tasks) };
  } else {
    syncState = { mode: 'merge', view: 'summary', incoming, plan: buildMergePlan(localProject, base, incoming) };
  }
  if (currentView !== 'projects') { currentView = 'projects'; }
  render();
  if (window.timetable) window.timetable.setEditing(true);
}

// 放弃进行中的同步预览（取消按钮 / 切换视图），记录日志
function discardSyncPreview() {
  if (!syncState) return;
  const inc = syncState.incoming;
  addSyncLog('import-cancel', { pid: inc.project_id, pname: inc.project.name, revision: inc.revision });
  syncState = null;
  if (window.timetable) window.timetable.setEditing(false);
}

function closeSyncPanel() {
  discardSyncPreview();
  render();
}

function refreshSyncPanel() {
  const old = weekList.querySelector('.sync-block');
  if (old) old.replaceWith(buildSyncPanel());
  else render();
}

// ---- 同步预览 / 冲突处理界面 ----
function fmtSyncValue(type, v) {
  if (type === 'done') return v ? '已完成' : '未完成';
  if (type === 'category') return (v === '' || v === undefined) ? '（空）' : ((CATEGORIES[v] || {}).label || v);
  if (type === 'urgency') return (v === '' || v === undefined) ? '（空）' : ((URGENCIES[v] || {}).label || v);
  if (type === 'date') return v ? fmtShort(v) : '（无）';
  return (v === '' || v === undefined) ? '（空）' : String(v);
}

function fmtTimeShort(iso) {
  const d = iso ? new Date(iso) : null;
  return (d && !isNaN(d)) ? `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '—';
}

function buildSyncPanel() {
  const panel = document.createElement('div');
  panel.className = 'add-block editor-block sync-block';
  if (syncState.mode === 'import-new') buildImportNewPanel(panel);
  else if (syncState.view === 'conflicts') buildConflictsPanel(panel);
  else buildSummaryPanel(panel);
  return panel;
}

// 摘要视图：变更统计 + [取消][自动合并][查看冲突]
function buildSummaryPanel(panel) {
  const plan = syncState.plan;
  const incoming = syncState.incoming;
  const c = plan.counts;
  const conflictCount = planConflictCount(plan);
  const localRev = (getProject(incoming.project_id) || {}).revision || 1;

  const head = document.createElement('div');
  head.className = 'sync-head';
  head.innerHTML = `
    <div class="sync-title">同步预览 · ${escapeHtml(incoming.project.name || '未命名项目')}</div>
    <div class="sync-meta">本地 rev ${localRev} · 导入 rev ${incoming.revision || 1} · 基准 ${plan.hasBase ? 'rev ' + plan.baseRevision : '无（首次同步）'}</div>
  `;
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sync-body';
  if (planChangeCount(plan) === 0) {
    body.innerHTML = `<div class="sync-line">导入内容与本地及同步基准一致，没有需要合并的变更。</div>`;
  } else {
    if (plan.hasBase && incoming.revision < plan.baseRevision) {
      body.innerHTML += `<div class="sync-line warn">⚠ 导入文件版本（rev ${incoming.revision}）低于同步基准（rev ${plan.baseRevision}），请确认不是旧文件</div>`;
    }
    const lines = [];
    const addIn = plan.tasks.filter(t => t.kind === 'add-incoming').map(t => t.displayTitle);
    const addLo = plan.tasks.filter(t => t.kind === 'add-local').map(t => t.displayTitle);
    const upd = plan.tasks.filter(t => t.kind === 'update').map(t =>
      `${t.displayTitle}（${t.fields.filter(f => f.state === 'incoming').map(f => f.label).join('、')}）`);
    const del = plan.tasks.filter(t => t.kind === 'delete-auto').map(t => t.displayTitle);
    const cf = plan.tasks.filter(t => t.kind === 'conflict-update' || t.kind === 'conflict-del-local' || t.kind === 'conflict-del-remote')
      .map(t => t.displayTitle);
    if (addIn.length) lines.push(['add', '＋ 导入新增', addIn]);
    if (addLo.length) lines.push(['add', '＋ 本地新增（保留）', addLo]);
    if (upd.length) lines.push(['upd', '✎ 自动合并修改', upd]);
    if (del.length) lines.push(['del', '✂ 自动删除', del]);
    if (c.projectConflicts) lines.push(['warn', '⚠ 项目信息冲突', [`${c.projectConflicts} 处`]]);
    if (cf.length) lines.push(['warn', '⚠ 冲突事项', cf]);
    for (const [cls, label, arr] of lines) {
      const shown = arr.slice(0, 4).map(escapeHtml).join('、');
      const more = arr.length > 4 ? `<span class="sync-more"> 等 ${arr.length} 项</span>` : '';
      body.innerHTML += `<div class="sync-line ${cls}">${label}：${shown}${more}</div>`;
    }
  }
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'add-form-row3';
  foot.innerHTML = `
    <button class="cancel">取消</button>
    ${conflictCount ? '<button class="sync-view-cf">查看冲突</button>' : ''}
    <button class="sync-merge">自动合并${conflictCount ? `（${conflictCount} 处冲突保留本地）` : ''}</button>
  `;
  panel.appendChild(foot);
  foot.querySelector('.cancel').addEventListener('click', closeSyncPanel);
  foot.querySelector('.sync-merge').addEventListener('click', () => {
    if (conflictCount && !confirm(`存在 ${conflictCount} 处冲突，自动合并将保留本地版本。是否继续？`)) return;
    applySyncPlan();
  });
  const cfBtn = foot.querySelector('.sync-view-cf');
  if (cfBtn) cfBtn.addEventListener('click', () => { syncState.view = 'conflicts'; refreshSyncPanel(); });
}

// 冲突处理视图：逐字段选择，默认保留本地
function buildConflictsPanel(panel) {
  const plan = syncState.plan;
  const head = document.createElement('div');
  head.className = 'sync-head';
  head.innerHTML = `
    <div class="sync-title">冲突处理</div>
    <div class="sync-meta">逐项选择保留哪个版本（默认保留本地）；日期留空 = 未设置</div>
  `;
  panel.appendChild(head);

  const listEl = document.createElement('div');
  listEl.className = 'sync-cf-list';

  const pfConf = plan.projectFields.filter(f => f.state === 'conflict');
  if (pfConf.length) {
    const group = document.createElement('div');
    group.className = 'sync-cf-group';
    group.innerHTML = `<div class="sync-cf-group-title">项目信息</div>`;
    for (const f of pfConf) group.appendChild(buildFieldConflictRow(f));
    listEl.appendChild(group);
  }
  for (const item of plan.tasks) {
    if (item.kind === 'conflict-update') {
      const fields = item.fields.filter(f => f.state === 'conflict');
      const group = document.createElement('div');
      group.className = 'sync-cf-group';
      group.innerHTML = `<div class="sync-cf-group-title">事项「${escapeHtml(item.displayTitle)}」</div>`;
      for (const f of fields) group.appendChild(buildFieldConflictRow(f));
      listEl.appendChild(group);
    } else if (item.kind === 'conflict-del-local' || item.kind === 'conflict-del-remote') {
      listEl.appendChild(buildDeleteConflictRow(item));
    }
  }
  panel.appendChild(listEl);

  const foot = document.createElement('div');
  foot.className = 'add-form-row3';
  foot.innerHTML = `<button class="cancel">返回预览</button><button class="sync-apply">应用合并</button>`;
  panel.appendChild(foot);
  foot.querySelector('.cancel').addEventListener('click', () => { syncState.view = 'summary'; refreshSyncPanel(); });
  foot.querySelector('.sync-apply').addEventListener('click', applySyncPlan);
}

// 字段冲突行：[保留本地][使用导入][手动]
function buildFieldConflictRow(f) {
  const row = document.createElement('div');
  row.className = 'sync-cf';
  row.innerHTML = `
    <div class="sync-cf-head">${f.label}</div>
    <div class="sync-cf-vals">
      <span class="cf-loc">本地：${escapeHtml(fmtSyncValue(f.type, f.local))}</span>
      <span class="cf-inc">导入：${escapeHtml(fmtSyncValue(f.type, f.incoming))}</span>
    </div>
    <div class="sync-cf-btns">
      <button class="cf-btn" data-r="local">保留本地</button>
      <button class="cf-btn" data-r="incoming">使用导入</button>
      <button class="cf-btn" data-r="manual">手动</button>
    </div>
    <div class="sync-cf-manual hidden"></div>
  `;
  const btns = row.querySelectorAll('.cf-btn');
  const manualBox = row.querySelector('.sync-cf-manual');

  const paintButtons = () => {
    btns.forEach(btn => {
      const r = btn.dataset.r;
      const active = (f.resolution && typeof f.resolution === 'object') ? r === 'manual' : f.resolution === r;
      btn.classList.toggle('active', active);
    });
  };

  const showManualValue = () => {
    manualBox.classList.remove('hidden');
    manualBox.innerHTML = `<span class="cf-manual-val">手动：${escapeHtml(fmtSyncValue(f.type, f.resolution.value))}</span><button class="cf-btn cf-edit">修改</button>`;
    manualBox.querySelector('.cf-edit').addEventListener('click', () => openManual());
    paintButtons();
  };

  const openManual = () => {
    manualBox.classList.remove('hidden');
    let editor;
    if (f.type === 'date') {
      editor = `<input type="date" class="cf-manual-input" value="${escapeHtml(f.local || '')}" />`;
    } else if (f.type === 'category') {
      editor = `<select class="cf-manual-input">${['work', 'personal', 'family'].map(k =>
        `<option value="${k}"${f.local === k ? ' selected' : ''}>${CATEGORIES[k].label}</option>`).join('')}</select>`;
    } else if (f.type === 'urgency') {
      editor = `<select class="cf-manual-input">${['urgent', 'normal', 'loose'].map(k =>
        `<option value="${k}"${f.local === k ? ' selected' : ''}>${URGENCIES[k].label}</option>`).join('')}</select>`;
    } else if (f.type === 'done') {
      editor = `<select class="cf-manual-input">
        <option value="no"${!f.local ? ' selected' : ''}>未完成</option>
        <option value="yes"${f.local ? ' selected' : ''}>已完成</option></select>`;
    } else {
      editor = `<input type="text" class="cf-manual-input" maxlength="40" value="${escapeHtml(f.local === undefined ? '' : f.local)}" />`;
    }
    manualBox.innerHTML = `${editor}<button class="cf-btn cf-manual-ok">确定</button>`;
    const input = manualBox.querySelector('.cf-manual-input');
    if (input.tagName === 'INPUT' && input.type === 'text') input.focus();
    manualBox.querySelector('.cf-manual-ok').addEventListener('click', () => {
      const v = (f.type === 'done') ? (input.value === 'yes') : input.value;
      f.resolution = { value: v };
      showManualValue();
    });
  };

  btns.forEach(btn => btn.addEventListener('click', () => {
    const r = btn.dataset.r;
    if (r === 'manual') { openManual(); return; }   // 确认后才写入 resolution
    f.resolution = r;
    manualBox.classList.add('hidden');
    paintButtons();
  }));

  // 重建面板时恢复已确认的手动值
  if (f.resolution && typeof f.resolution === 'object') showManualValue();
  paintButtons();
  return row;
}

// 删除冲突行
function buildDeleteConflictRow(item) {
  const row = document.createElement('div');
  row.className = 'sync-cf';
  const isLocalDeleted = item.kind === 'conflict-del-local';
  const changed = (item.changeLabels || []).join('、') || '—';
  row.innerHTML = `
    <div class="sync-cf-head">事项「${escapeHtml(item.displayTitle)}」· 删除冲突</div>
    <div class="sync-cf-vals">${isLocalDeleted
      ? `<span class="cf-loc">本地：已删除</span><span class="cf-inc">导入：已修改（${escapeHtml(changed)}）</span>`
      : `<span class="cf-loc">本地：已修改（${escapeHtml(changed)}）</span><span class="cf-inc">导入：已删除</span>`}
    </div>
    <div class="sync-cf-btns">${isLocalDeleted
      ? `<button class="cf-btn" data-r="keepDeleted">保留删除</button><button class="cf-btn" data-r="restoreIncoming">恢复并使用导入版本</button>`
      : `<button class="cf-btn" data-r="keepLocal">保留本地任务</button><button class="cf-btn" data-r="applyDelete">确认删除</button>`}
    </div>
  `;
  row.querySelectorAll('.cf-btn').forEach(btn => {
    btn.classList.toggle('active', item.resolution === btn.dataset.r);
    btn.addEventListener('click', () => {
      item.resolution = btn.dataset.r;
      row.querySelectorAll('.cf-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  return row;
}

// 导入新项目预览
function buildImportNewPanel(panel) {
  const incoming = syncState.incoming;
  const collisions = syncState.collisions || [];
  const titles = incoming.tasks.map(t => t.title || '（无标题）');
  const head = document.createElement('div');
  head.className = 'sync-head';
  head.innerHTML = `
    <div class="sync-title">导入新项目 · ${escapeHtml(incoming.project.name || '未命名项目')}</div>
    <div class="sync-meta">rev ${incoming.revision || 1} · ${incoming.tasks.length} 个事项 · 导出于 ${fmtTimeShort(incoming.exported_at)}</div>
  `;
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sync-body';
  body.innerHTML = `
    <div class="sync-line add">＋ 将创建项目并导入其全部事项</div>
    <div class="sync-line sub">${titles.length ? titles.map(escapeHtml).join('、') : '（无事项）'}</div>
    ${collisions.length ? `<div class="sync-line warn">⚠ ${collisions.length} 个事项 ID 与本地现有事项重复，导入时将重新编号，不会覆盖本地数据</div>` : ''}
  `;
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'add-form-row3';
  foot.innerHTML = `<button class="cancel">取消</button><button class="sync-apply-new">导入</button>`;
  panel.appendChild(foot);
  foot.querySelector('.cancel').addEventListener('click', closeSyncPanel);
  foot.querySelector('.sync-apply-new').addEventListener('click', applyImportNew);
}

// ---- 同步操作日志展示（项目视图底部） ----
const SYNC_LOG_LABELS = {
  'export': '导出项目',
  'export-cancel': '取消导出',
  'export-fail': '导出失败',
  'import-file': '读取项目文件',
  'import-invalid': '文件无效',
  'import-cancel': '放弃合并',
  'merge': '合并完成',
  'import-new': '导入新项目',
  'auto-sync': '自动同步',
  'auto-sync-fail': '自动同步失败'
};
let syncLogExpanded = false;

function fmtLogTime(iso) {
  const d = iso ? new Date(iso) : null;
  return (d && !isNaN(d)) ? `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '—';
}

function buildSyncLogBlock() {
  const log = loadSyncLog();
  const box = document.createElement('div');
  box.className = 'sync-log';

  const head = document.createElement('div');
  head.className = 'sync-log-head';
  head.title = syncLogExpanded ? '点击收起' : '点击展开';
  head.innerHTML = `
    <span class="sync-log-arrow">${syncLogExpanded ? '▾' : '▸'}</span>
    <span class="sync-log-title">同步日志</span>
    <span class="sync-log-count">${log.length} 条</span>
    <button class="sync-log-clear" title="清空全部日志">清空</button>
  `;
  head.addEventListener('click', (e) => {
    if (e.target.closest('.sync-log-clear')) return;
    syncLogExpanded = !syncLogExpanded;
    box.replaceWith(buildSyncLogBlock());
  });
  head.querySelector('.sync-log-clear').addEventListener('click', () => {
    if (!confirm('确定清空全部同步日志？')) return;
    localStorage.removeItem('syncLog');
    syncLogExpanded = false;
    box.replaceWith(buildSyncLogBlock());
  });
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'sync-log-list';
  if (!log.length) {
    const empty = document.createElement('div');
    empty.className = 'sync-log-row muted';
    empty.textContent = '暂无导出/导入记录';
    list.appendChild(empty);
  } else {
    const shown = syncLogExpanded ? log.slice(0, 60) : log.slice(0, 3);
    for (const it of shown) {
      const row = document.createElement('div');
      row.className = 'sync-log-row';
      const text = `${it.pname ? it.pname + ' ' : ''}${it.revision !== '' ? 'rev' + it.revision + ' ' : ''}${it.detail || ''}`;
      row.innerHTML = `
        <span class="sync-log-time">${fmtLogTime(it.time)}</span>
        <span class="sync-log-action">${SYNC_LOG_LABELS[it.action] || escapeHtml(it.action)}</span>
        <span class="sync-log-text">${escapeHtml(text)}</span>
      `;
      row.title = `${fmtLogTime(it.time)} ${SYNC_LOG_LABELS[it.action] || it.action} ${text}`;
      list.appendChild(row);
    }
    if (!syncLogExpanded && log.length > 3) {
      const more = document.createElement('div');
      more.className = 'sync-log-row muted sync-log-more';
      more.textContent = `… 还有 ${log.length - 3} 条，点击展开`;
      more.addEventListener('click', () => { syncLogExpanded = true; box.replaceWith(buildSyncLogBlock()); });
      list.appendChild(more);
    }
  }
  box.appendChild(list);
  return box;
}

// 非阻塞提示条
let toastTimer = null;
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// 事项提醒 toast（P4.4 增强）：含「完成」「稍后 5 分钟」按钮与设置开关
function showReminderToast(ev, aheadMin) {
  // 应用内提醒条开关（P4.4）：关闭后到点仅保留系统通知与响铃
  if (loadAppSettings().reminderToastEnabled === false) return;
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  const prefix = aheadMin > 0 ? `提前 ${aheadMin} 分钟提醒：` : '到点提醒：';
  t.innerHTML = `<span class="toast-msg">${prefix}${escapeHtml(ev.title)}</span><span class="toast-acts"><button class="toast-done" type="button">完成</button><button class="toast-snooze" type="button">稍后 5 分钟</button></span>`;
  t.classList.add('show', 'toast-remind');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
  // 完成：直接置完成态（重复事项虚拟投影按日 override 由 toggleDone 内处理）
  const doneBtn = t.querySelector('.toast-done');
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      t.classList.remove('show');
      toggleDone(ev.id);
    });
  }
  const btn = t.querySelector('.toast-snooze');
  if (btn) {
    btn.addEventListener('click', () => {
      const list = loadEvents();
      const e = list.find(x => x.id === ev.id);
      if (e) { e.snoozeUntil = Date.now() + 5 * 60 * 1000; saveEvents(list); }
      // 移除已提醒标记，使贪睡到期后可再次触发
      const key = ev.id + '|' + dateKey(today());
      remindedKeys.delete(key);
      saveRemindedKeys();
      t.classList.remove('show');
      showToast('已贪睡 5 分钟后再次提醒');
    });
  }
}

// ============ 系统合成音（Web Audio 振荡器，无音频文件依赖，失败静默） ============
let audioCtx = null;
// pattern: [频率Hz, 起始偏移s, 持续s] 数组
const CHIME = {
  ding:   [[880, 0, 0.4], [1318.5, 0.18, 0.55]],                   // 番茄钟阶段切换（两音上行）
  remind: [[880, 0, 0.3], [880, 0.24, 0.3], [1174.7, 0.48, 0.7]]   // 事项到点（三连音）
};
function playChime(pattern) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    for (const [freq, at, dur] of pattern) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const t = t0 + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    }
  } catch { /* 无音频设备时静默 */ }
}

// ============ 事项到点提醒 ============
// 触发条件：开始日=今天 且 time=当前 HH:MM，仅到点那一分钟内提醒一次（错过不补）。
// 已提醒标记按日持久化（localStorage: remindedKeys），重启后当天不重复提醒。
let remindedDate = '';
let remindedKeys = new Set();
(function loadRemindedKeys() {
  try {
    const o = JSON.parse(localStorage.getItem('remindedKeys') || '{}');
    const tk = dateKey(today());
    if (o.date === tk && Array.isArray(o.ids)) { remindedKeys = new Set(o.ids); remindedDate = tk; }
  } catch { /* 损坏则当空 */ }
})();
function saveRemindedKeys() {
  localStorage.setItem('remindedKeys', JSON.stringify({ date: remindedDate, ids: [...remindedKeys] }));
}
function checkReminders() {
  const now = new Date();
  const tk = dateKey(now);
  if (tk !== remindedDate) { remindedDate = tk; remindedKeys.clear(); }   // 跨日重置
  for (const ev of loadEvents()) {
    if (!ev.time) continue;
    // 当日有效性：重复事项按命中日判断 + 完成态查按日 override；普通事项按开始日期
    if (isRecurOn(ev)) {
      if (!recurMatchesDate(ev.recur, eventStart(ev), tk)) continue;
      if (recurDoneGet(ev.id, tk)) continue;
    } else if (ev.done || eventStart(ev) !== tk) {
      continue;
    }
    const key = ev.id + '|' + tk;
    if (remindedKeys.has(key)) continue;
    // 触发时间 = 到点时间 - 提前提醒分钟数
    const [h, m] = ev.time.split(':').map(Number);
    const trigger = new Date(now);
    trigger.setHours(h, m, 0, 0);
    const aheadMin = ev.remindAhead || 0;
    trigger.setMinutes(trigger.getMinutes() - aheadMin);
    // 贪睡中：未到 snoozeUntil 则跳过
    if (ev.snoozeUntil && now.getTime() < ev.snoozeUntil) continue;
    if (now.getTime() < trigger.getTime()) continue;   // 未到触发时间
    // 触发提醒
    remindedKeys.add(key);
    saveRemindedKeys();
    // 清除已消费的贪睡标记
    if (ev.snoozeUntil) {
      const list = loadEvents();
      const e = list.find(x => x.id === ev.id);
      if (e) { e.snoozeUntil = 0; saveEvents(list); }
    }
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // 点击通知：唤起窗口并直达该事项（定位所在周 + 打开编辑）
        const n = new Notification('日程提醒', { body: `${ev.time} ${ev.title}${aheadMin > 0 ? `（提前 ${aheadMin} 分钟）` : ''}` });
        n.onclick = () => { try { n.close(); } catch { /* 已关 */ } focusWindow(); gotoSearchResult(ev); };
      }
    } catch { /* 通知不可用时仅响铃 */ }
    playChime(CHIME.remind);
    showReminderToast(ev, aheadMin);
  }
}

// ============ iCal 互通（P4.3）：导出 .ics / 导入 .ics ============
// 约定：本机浮点时间，不写 TZID/VTIMEZONE（与 app 内"时间即本地墙钟"语义一致，不做时区换算）；
// 输出按 RFC 5545 用 CRLF 换行；导出不折叠长行（多数日历软件可读），导入支持行折叠展开。
const ICAL_BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];  // getDay() → RFC 5545 星期码

// ics 文本转义（SUMMARY/DESCRIPTION/CATEGORIES 值；反斜杠最先处理防二次转义）
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}
// ics 文本反转义：单趟替换，避免「\\n（字面反斜杠+n）」被误展开为换行
function icsUnescape(s) {
  return String(s || '').replace(/\\n|\\,|\\;|\\\\/g, (m) => {
    if (m === '\\n') return '\n';
    if (m === '\\,') return ',';
    if (m === '\\;') return ';';
    return '\\';
  });
}
// 'YYYY-MM-DD' → 'YYYYMMDD'
function icsDate(key) { return String(key || '').replace(/-/g, ''); }
// 'HH:MM' → 'HHMMSS'（异常格式兜底 000000）
function icsTime(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  if (!m) return '000000';
  return pad2(+m[1]) + m[2] + '00';
}
// 重复规则 → RRULE 值（不重复/未知返回 ''；weekly 的 BYDAY 取开始日星期码）
function recurToRrule(recur, startKey) {
  if (!recur || !recur.freq || recur.freq === 'none') return '';
  const n = Math.max(1, parseInt(recur.interval, 10) || 1);
  let rule = '';
  if (recur.freq === 'daily') rule = 'FREQ=DAILY;INTERVAL=' + n;
  else if (recur.freq === 'weekdays') rule = 'FREQ=WEEKLY;INTERVAL=' + n + ';BYDAY=MO,TU,WE,TH,FR';
  else if (recur.freq === 'weekly') {
    const d = parseDateKey(startKey) || new Date();
    rule = 'FREQ=WEEKLY;INTERVAL=' + n + ';BYDAY=' + ICAL_BYDAY[d.getDay()];
  } else if (recur.freq === 'monthly') rule = 'FREQ=MONTHLY;INTERVAL=' + n;
  else return '';
  if (recur.until) rule += ';UNTIL=' + icsDate(recur.until) + 'T235959';
  return rule;
}
// RRULE 值 → 重复规则（无法映射返回 null；调用方需落"不重复 + 备注说明"）
function rruleToRecur(rule, startKey) {
  if (!rule) return null;
  const parts = {};
  for (const seg of String(rule).split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const freq = (parts.FREQ || '').toUpperCase();
  const n = Math.max(1, parseInt(parts.INTERVAL, 10) || 1);
  let freqKey = null;
  if (freq === 'DAILY') freqKey = 'daily';
  else if (freq === 'WEEKLY') {
    const days = (parts.BYDAY || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    if (days.join(',') === 'MO,TU,WE,TH,FR') freqKey = 'weekdays';
    else if (days.length === 1) freqKey = 'weekly';
    // 其它 BYDAY 组合（如 MO,WE,FR）无法映射 → 落不重复
  } else if (freq === 'MONTHLY') freqKey = 'monthly';
  if (!freqKey) return null;
  const recur = { freq: freqKey, interval: n, until: '' };
  if (parts.UNTIL && /^\d{8}/.test(parts.UNTIL)) {
    recur.until = parts.UNTIL.slice(0, 4) + '-' + parts.UNTIL.slice(4, 6) + '-' + parts.UNTIL.slice(6, 8);
  }
  return recur;   // weekly 的 BYDAY 由开始日星期码决定，导入时以 startKey 为准（与导出一致）
}

// 事项列表 → iCalendar 文本（每事项一个 VEVENT；now 参数仅供测试注入 DTSTAMP）
function eventsToIcs(list, now) {
  const stamp = now || new Date();
  const dtStamp = stamp.getUTCFullYear() + pad2(stamp.getUTCMonth() + 1) + pad2(stamp.getUTCDate()) +
    'T' + pad2(stamp.getUTCHours()) + pad2(stamp.getUTCMinutes()) + pad2(stamp.getUTCSeconds()) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Timetable001//日程侧边栏//CN'];
  for (const ev of (list || [])) {
    const sKey = eventStart(ev);
    if (!sKey) continue;                        // 无开始日期的异常数据跳过
    const eKey = eventEnd(ev) || sKey;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + icsEscape(ev.id || String(stamp.getTime())) + '@timetable.local');
    lines.push('DTSTAMP:' + dtStamp);
    if (!ev.time) {
      // 全天：DTSTART 含首日，DTEND 为结束日 +1（RFC 5545 全天区间非包含）
      lines.push('DTSTART;VALUE=DATE:' + icsDate(sKey));
      lines.push('DTEND;VALUE=DATE:' + icsDate(addDaysKey(eKey, 1)));
    } else {
      // 有时间：DTEND 与结束时刻相同（app 内结束时刻为包含语义，导出按同时刻落盘）
      const t = icsTime(ev.time);
      lines.push('DTSTART:' + icsDate(sKey) + 'T' + t);
      lines.push('DTEND:' + icsDate(eKey) + 'T' + t);
    }
    lines.push('SUMMARY:' + icsEscape(ev.title || '（无标题）'));
    // 分类与标签：中文分类标签放首位，tags 并入 CATEGORIES（导入时反向解析，备注不重复携带 tags）
    const cat = CATEGORIES[ev.category];
    const cats = [cat ? cat.label : ''].concat(Array.isArray(ev.tags) ? ev.tags : []).filter(Boolean);
    if (cats.length) lines.push('CATEGORIES:' + icsEscape(cats.join(',')));
    if (ev.description) lines.push('DESCRIPTION:' + icsEscape(ev.description));
    if (ev.done) lines.push('STATUS:COMPLETED');
    const rrule = recurToRrule(ev.recur, sKey);
    if (rrule) lines.push('RRULE:' + rrule);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// 解析 ics 日期值 → { date: 'YYYY-MM-DD', time: 'HH:MM' | '', allDay }
// VALUE=DATE 或纯 8 位日期为全天；含 Z 后缀的 UTC 时间按本机墙钟直接采用（轻量化约定）
function parseIcsDateVal(val, params) {
  const v = String(val || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '', allDay: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/.exec(v);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: pad2(+m[4]) + ':' + pad2(+m[5]), allDay: false };
  if (/VALUE=DATE/i.test(params || '') && /^\d{8}/.test(v)) {
    return { date: v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8), time: '', allDay: true };
  }
  return null;
}

// 解析出的 VEVENT 块 → 本地事项字段（缺 DTSTART 的块返回 null 丢弃）
function normalizeIcsEvent(raw) {
  const ds = raw._dtStart;
  if (!ds) return null;
  const de = raw._dtEnd;
  let sKey = ds.date;
  let eKey = (de && de.date) || ds.date;
  if (ds.allDay && de && de.allDay && de.date > ds.date) {
    eKey = addDaysKey(de.date, -1);             // 全天 DTEND 非包含 → 反推回包含式末日
  } else if (!ds.allDay) {
    eKey = (de && de.date) || ds.date;          // 有时间：DTEND 同结束时刻（跨天取结束日）
  }
  // 分类：CATEGORIES 中首个匹配中文标签的项 → category，其余项进 tags
  let category = '';
  const tags = [];
  for (const t of raw.tags || []) {
    const hit = Object.keys(CATEGORIES).find(k => CATEGORIES[k].label === t);
    if (hit && !category) category = hit;
    else if (!tags.includes(t)) tags.push(t);
  }
  let description = raw.description || '';
  let recur = rruleToRecur(raw._rrule, sKey);
  if (raw._rrule && !recur) {
    // 不支持的重复规则：落不重复，规则原文追加进备注说明
    recur = null;
    description += (description ? '\n' : '') + `（原重复规则未支持导入：${raw._rrule}）`;
  }
  return {
    title: raw.title || '（无标题）',
    startDate: sKey,
    endDate: eKey || sKey,
    time: ds.allDay ? '' : (ds.time || ''),
    category: category || 'work',
    tags,
    description,
    done: !!raw.done,
    recur
  };
}

// .ics 文本 → 事项字段列表（CRLF/LF 归一 + RFC 5545 行折叠展开 + VEVENT 块扫描）
function parseIcs(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const folded = [];
  for (const line of raw.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && folded.length) {
      folded[folded.length - 1] += line.slice(1);   // 续行：去掉首个空白拼接
    } else {
      folded.push(line);
    }
  }
  const blocks = [];
  let cur = null;
  for (const line of folded) {
    if (line === 'BEGIN:VEVENT') { cur = { tags: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur || !line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const val = line.slice(colon + 1);
    const semi = head.indexOf(';');
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? '' : head.slice(semi + 1);
    if (name === 'SUMMARY') cur.title = icsUnescape(val).trim();
    else if (name === 'DESCRIPTION') cur.description = icsUnescape(val).trim();
    else if (name === 'CATEGORIES') {
      for (const c of icsUnescape(val).split(',')) {
        const t = c.trim();
        if (t) cur.tags.push(t);
      }
    } else if (name === 'STATUS' && val.trim().toUpperCase() === 'COMPLETED') cur.done = true;
    else if (name === 'DTSTART') cur._dtStart = parseIcsDateVal(val, params);
    else if (name === 'DTEND') cur._dtEnd = parseIcsDateVal(val, params);
    else if (name === 'RRULE') cur._rrule = val.trim();
  }
  return blocks.map(normalizeIcsEvent).filter(Boolean);
}

// iCal 导入预览状态：[{ ev, checked, dup }]；dup = 与现有事项疑似重复（同标题/日期/时间）
let icalImportItems = null;

// ---- 工具：iCal 导入（选文件 → 预览勾选 → 选目标项目 → 导入） ----
function buildIcalImport(panel) {
  if (!icalImportItems) {
    panel.innerHTML = `
      <div class="tool-hint">从 .ics 日历文件导入事项：先选择文件预览，勾选后确认。</div>
      <button type="button" class="set-btn ical-pick-btn">选择 .ics 文件…</button>
      <div class="tool-hint ical-pick-err"></div>
    `;
    const pickBtn = panel.querySelector('.ical-pick-btn');
    pickBtn.addEventListener('click', async () => {
      if (!window.timetable || !window.timetable.icalImportDialog) return;
      pickBtn.disabled = true;
      try {
        const res = await window.timetable.icalImportDialog();
        if (!res || !res.ok) {
          if (res && res.error) panel.querySelector('.ical-pick-err').textContent = '读取失败：' + res.error;
          return;
        }
        const parsed = parseIcs(res.content);
        if (!parsed.length) {
          panel.querySelector('.ical-pick-err').textContent = '未在文件中找到可导入的事项';
          return;
        }
        const existing = loadEvents();
        icalImportItems = parsed.map(ev => ({
          ev,
          checked: true,
          dup: existing.some(e => (e.title || '') === ev.title && eventStart(e) === ev.startDate && (e.time || '') === ev.time)
        }));
        render();   // currentTool 仍为 ical，重渲染出预览列表
      } finally {
        pickBtn.disabled = false;
      }
    });
    return;
  }

  panel.innerHTML = `
    <div class="tool-hint">共 ${icalImportItems.length} 条；标红的与现有事项疑似重复（同标题/日期/时间），导入时同项目下自动跳过。</div>
    <div class="ical-list">
      ${icalImportItems.map((it, i) => `
        <label class="ical-item">
          <input type="checkbox" data-idx="${i}" ${it.checked ? 'checked' : ''} />
          <span class="ical-item-main">
            <span class="ical-item-title">${escapeHtml(it.ev.title)}</span>
            <span class="ical-item-sub">${it.ev.startDate}${it.ev.endDate && it.ev.endDate !== it.ev.startDate ? ' ~ ' + it.ev.endDate : ''}${it.ev.time ? ' ' + it.ev.time : ''}${it.ev.recur ? ' · ' + (RECUR_FREQ_LABELS[it.ev.recur.freq] || '重复') : ''}${it.ev.tags.length ? ' · #' + it.ev.tags.map(escapeHtml).join(' #') : ''}${it.dup ? ' · 疑似重复' : ''}</span>
          </span>
        </label>`).join('')}
    </div>
    <div class="qa-row">
      <select class="ical-project" title="导入到项目">${projectOptionsHtml('')}</select>
      <button type="button" class="set-btn ical-do-btn">导入</button>
    </div>
    <button type="button" class="set-btn ical-again">重新选择文件</button>
  `;
  panel.querySelectorAll('.ical-item input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const it = icalImportItems[+cb.dataset.idx];
      if (it) it.checked = cb.checked;
    });
  });
  panel.querySelector('.ical-again').addEventListener('click', () => {
    icalImportItems = null;
    render();
  });
  panel.querySelector('.ical-do-btn').addEventListener('click', () => {
    const pid = panel.querySelector('.ical-project').value || null;
    const existing = loadEvents();
    let added = 0, skipped = 0;
    for (const it of icalImportItems) {
      if (!it.checked) continue;
      const ev = it.ev;
      // 去重：同项目 + 同标题 + 同开始日 + 同时间（与预览标注口径一致，另加项目维度）
      const dup = existing.some(e =>
        (e.title || '') === ev.title && eventStart(e) === ev.startDate &&
        (e.time || '') === ev.time && (e.projectId || null) === pid);
      if (dup) { skipped++; continue; }
      addEvent({
        title: ev.title,
        startDate: ev.startDate,
        endDate: ev.endDate,
        time: ev.time,
        category: ev.category,
        urgency: 'normal',
        projectId: pid,
        recur: ev.recur,
        tags: ev.tags,
        description: ev.description
      }, true);   // 批量导入，最后统一渲染
      added++;
    }
    icalImportItems = null;
    closeTool();
    render();
    showToast(`已导入 ${added} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`);
  });
}

// ============ 侧边栏工具（快速添加 / 番茄钟 / 今日进度 / 快速便签） ============
// 工具以「内容区覆盖层」呈现，不改 currentView，返回即回原视图；均为本地功能，不涉及网络。
const TOOL_DEFS = {
  quickadd:  { title: '快速添加', pinEditing: true },
  pomodoro:  { title: '番茄钟',   pinEditing: false },
  progress:  { title: '今日进度', pinEditing: false },
  stats:     { title: '统计',     pinEditing: false },
  search:    { title: '搜索',     pinEditing: false },
  notes:     { title: '快速便签', pinEditing: true },
  weather:   { title: '天气',     pinEditing: false },
  sys:       { title: '系统资源', pinEditing: false },
  clipboard: { title: '剪贴板',   pinEditing: false },
  sync:      { title: '设备同步', pinEditing: false },
  settings:  { title: '设置',     pinEditing: false },
  ical:      { title: 'iCal 导入', pinEditing: true }
};

function openTool(name) {
  if (!TOOL_DEFS[name]) return;
  currentTool = name;
  if (window.timetable) window.timetable.setEditing(!!TOOL_DEFS[name].pinEditing);
  render();
}
function closeTool() {
  if (!currentTool) return;
  if (sysPanelTimer) { clearInterval(sysPanelTimer); sysPanelTimer = null; }
  weatherPanelUpdater = null;
  currentTool = null;
  if (window.timetable) window.timetable.setEditing(false);
}

function renderTool() {
  const def = TOOL_DEFS[currentTool];
  if (!def) { closeTool(); render(); return; }
  setHeader(def.title, '', false);
  bigWeekday.innerHTML = '<span class="tool-back" title="返回">‹ 返回</span>';
  bigWeekday.querySelector('.tool-back').addEventListener('click', () => { closeTool(); render(); });
  weekList.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'tool-panel';
  if (currentTool === 'quickadd') buildQuickAdd(panel);
  else if (currentTool === 'pomodoro') buildPomodoro(panel);
  else if (currentTool === 'progress') buildProgress(panel);
  else if (currentTool === 'stats') buildStatsPanel(panel);
  else if (currentTool === 'search') buildSearchPanel(panel);
  else if (currentTool === 'notes') buildNotes(panel);
  else if (currentTool === 'weather') buildWeather(panel);
  else if (currentTool === 'sys') buildSys(panel);
  else if (currentTool === 'clipboard') buildClipboard(panel);
  else if (currentTool === 'sync') buildSyncTool(panel);
  else if (currentTool === 'settings') buildSettings(panel);
  else if (currentTool === 'ical') buildIcalImport(panel);
  weekList.appendChild(panel);
}

// ---- 工具一：快速添加（默认今天、未归类，回车连续录入） ----
// 便签「发到快速添加」预填的标题（buildQuickAdd 消费后清空；一次性传递）
let pendingQuickAddText = '';

// ============ 自然语言解析（P5.2 纯函数） ============
// 从标题剥离日期/时间短语 → { title, date, time, hits }
// date: 'YYYY-MM-DD'，time: 'HH:MM'，未命中为 ''；hits 为命中的原始片段
// 规则：先绝对后相对、先长词后短词；剥离后标题为空则整体不解析（避免"周五"这类词被误清空）
const CN_DIG = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
// 中文/阿拉伯数字串 → 整数（0~99，支持"二十三"）；无法解析返回 NaN
function parseCnNum(s) {
  if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
  if (!s) return NaN;
  const ten = s.indexOf('十');
  if (ten === -1) return CN_DIG[s] !== undefined ? CN_DIG[s] : NaN;
  const b = s.slice(0, ten), a = s.slice(ten + 1);
  const tens = b ? CN_DIG[b] : 1, ones = a ? CN_DIG[a] : 0;
  if (tens === undefined || ones === undefined) return NaN;
  return tens * 10 + ones;
}
// 时段前缀映射小时数：中午12点→12、下午X点(+12)、晚上X点(≤11+12，12→0)、上午/早上/凌晨原值
function mapDaypart(part, h) {
  if (!part) return h;
  if (part === '中午') return 12;
  if (part === '下午') return h === 12 ? 12 : (h >= 1 && h <= 11 ? h + 12 : h);
  if (part === '晚上') return h === 12 ? 0 : (h <= 11 ? h + 12 : h);
  return h;
}
function parseQuickInput(text, now) {
  now = now || today();
  const original = String(text || '').trim();
  let work = original;
  let dateK = '', timeS = '';
  const hits = [];
  // 命中片段从工作串剥离（以空格占位，最终压缩空白）
  const take = (m) => {
    hits.push(m[0]);
    work = work.slice(0, m.index) + ' ' + work.slice(m.index + m[0].length);
  };
  const t0 = stripTime(now);
  const setDate = (d) => { if (!dateK) dateK = dateKey(d); };
  // 相对时长（分钟）→ date（未设时取计算日）+ time
  const applyRelTime = (mins) => {
    const d = new Date(now.getTime() + mins * 60000);
    if (!dateK) dateK = dateKey(d);
    timeS = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  // —— 日期词表（先绝对后相对）——
  // YYYY-MM-DD
  let m = work.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) { setDate(new Date(+m[1], +m[2] - 1, +m[3])); take(m); }
  // X月X号/日（年份取未来最近：已过 → 明年）
  if (!dateK && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[号日]/))) {
    const mo = parseCnNum(m[1]), da = parseCnNum(m[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let cand = new Date(t0.getFullYear(), mo - 1, da);
      if (cand < t0) cand = new Date(t0.getFullYear() + 1, mo - 1, da);
      if (cand.getDate() === da) { setDate(cand); take(m); }
    }
  }
  // MM-DD（未来最近：已过 → 明年）
  if (!dateK && (m = work.match(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/))) {
    const mo = +m[1], da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let cand = new Date(t0.getFullYear(), mo - 1, da);
      if (cand < t0) cand = new Date(t0.getFullYear() + 1, mo - 1, da);
      if (cand.getDate() === da) { setDate(cand); take(m); }
    }
  }
  // X号/X日（本月；已过 → 下月）
  if (!dateK && (m = work.match(/(?<![\d月])(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[号日](?!内)/))) {
    const da = parseCnNum(m[1]);
    if (da >= 1 && da <= 31) {
      let cand = new Date(t0.getFullYear(), t0.getMonth(), da);
      if (cand < t0) cand = new Date(t0.getFullYear(), t0.getMonth() + 1, da);
      if (cand.getDate() === da) { setDate(cand); take(m); }
    }
  }
  // 大后天/后天/明天/今晚/今天（今晚额外默认 19:00，纯"今晚"才有别于"今天"）
  if (!dateK && (m = work.match(/大后天|后天|明天|今晚|今天/))) {
    setDate(addDays(t0, { 大后天: 3, 后天: 2, 明天: 1, 今晚: 0, 今天: 0 }[m[0]]));
    if (m[0] === '今晚' && !timeS) timeS = '19:00';
    take(m);
  }
  // N天后（阿拉伯或中文数字 1~99）
  if (!dateK && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天\s*之?后/))) {
    const n = parseCnNum(m[1]);
    if (n >= 1 && n <= 99) { setDate(addDays(t0, n)); take(m); }
  }
  // 下周X（强制下一自然周，周一起算）
  if (!dateK && (m = work.match(/下(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
    const tgt = CN_WEEK[m[1]];
    if (tgt !== undefined) {
      const wd = (t0.getDay() + 6) % 7;              // 周一=0 … 周日=6
      setDate(addDays(t0, (7 - wd) + ((tgt + 6) % 7)));
      take(m);
    }
  }
  // 周X/星期X（未来最近该日，含今天）
  if (!dateK && (m = work.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
    const tgt = CN_WEEK[m[1]];
    if (tgt !== undefined) {
      setDate(addDays(t0, (tgt - t0.getDay() + 7) % 7));
      take(m);
    }
  }

  // —— 时间词表（先绝对后相对、先带时段后裸写）——
  // 时段 + HH:MM（下午3:30 → 15:30）
  m = work.match(/(上午|早上|凌晨|中午|下午|晚上)?\s*(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  if (m) {
    const h = mapDaypart(m[1], +m[2]);
    if (h >= 0 && h <= 23) { timeS = pad2(h) + ':' + m[3]; take(m); }
  }
  // 时段 + X点[半/Y分/整]
  if (!timeS && (m = work.match(/(上午|早上|凌晨|中午|下午|晚上)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点(?:\s*(半|整|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分))?/))) {
    const h = mapDaypart(m[1], parseCnNum(m[2]));
    const min = m[3] === '半' ? 30 : (m[4] !== undefined ? parseCnNum(m[4]) : 0);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) { timeS = pad2(h) + ':' + pad2(min); take(m); }
  }
  // 裸 HH:MM
  if (!timeS && (m = work.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/))) {
    timeS = pad2(+m[1]) + ':' + m[2]; take(m);
  }
  // 裸 X点[半/Y分/整]（前一位不能是数字/点，避免命中已剥离内容的残段）
  if (!timeS && (m = work.match(/(?<![\d点])(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点(?:\s*(半|整|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分))?/))) {
    const h = parseCnNum(m[1]);
    const min = m[2] === '半' ? 30 : (m[3] !== undefined ? parseCnNum(m[3]) : 0);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) { timeS = pad2(h) + ':' + pad2(min); take(m); }
  }
  // 半小时后 / N小时后 / N分钟后（相对 now，产生 date+time；date 已设则仅回填时间）
  if (!timeS && (m = work.match(/半\s*个?\s*小时后/))) { applyRelTime(30); take(m); }
  if (!timeS && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*个?\s*小时后/))) {
    const n = parseCnNum(m[1]);
    if (n >= 1 && n <= 23) { applyRelTime(n * 60); take(m); }
  }
  if (!timeS && (m = work.match(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*个?\s*分钟后/))) {
    const n = parseCnNum(m[1]);
    if (n >= 1 && n <= 720) { applyRelTime(n); take(m); }
  }

  const title = work.replace(/\s+/g, ' ').trim();
  // 剥离后标题为空（或无任何命中）→ 整体不解析
  if (!title || !hits.length) return { title: original, date: '', time: '', hits: [] };
  return { title, date: dateK, time: timeS, hits };
}
// 解析预览文案（P5.2）：「→ 10/13(周二) 15:00」；无命中返回 ''
function quickInputPreview(parsed) {
  if (!parsed || (!parsed.date && !parsed.time)) return '';
  const parts = [];
  if (parsed.date) {
    const d = parseDateKey(parsed.date);
    parts.push(`${d.getMonth() + 1}/${d.getDate()}(周${'日一二三四五六'[d.getDay()]})`);
  }
  if (parsed.time) parts.push(parsed.time);
  return '→ ' + parts.join(' ');
}

// ============ 事项模板（P5.3） ============
// localStorage: eventTemplates = [{id, title, time, category, urgency, recur, tags, description, createdAt}]
// 日期不入模板（应用时默认今天）；仅进三档备份（backup.js BUSINESS_KEYS），不进局域网同步快照
function loadEventTemplates() {
  try {
    const arr = JSON.parse(localStorage.getItem('eventTemplates') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveEventTemplates(arr) {
  localStorage.setItem('eventTemplates', JSON.stringify(arr));
}
// 事项存为模板：同 title+time 视为重复（跳过）；返回 'saved' | 'dup'
function saveEventAsTemplate(ev) {
  const list = loadEventTemplates();
  const t = String(ev.title || '');
  const tm = String(ev.time || '');
  if (list.some(x => x.title === t && String(x.time || '') === tm)) return 'dup';
  list.unshift({
    id: 'tpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: t, time: tm,
    category: ev.category || 'work',
    urgency: ev.urgency || 'normal',
    recur: ev.recur || null,
    tags: Array.isArray(ev.tags) ? ev.tags.slice() : [],
    description: String(ev.description || ''),
    createdAt: new Date().toISOString()
  });
  saveEventTemplates(list);
  return 'saved';
}
function deleteEventTemplate(id) {
  saveEventTemplates(loadEventTemplates().filter(t => t.id !== id));
}
// 快速添加面板的模板 chips 行 HTML：空模板返回 ''（整行隐藏）；默认最多 8 个 + 「…」展开
let qaTplExpanded = false;   // chips 是否已展开（面板重绘间保持）
function tplChipsHtml() {
  const list = loadEventTemplates();
  if (!list.length) return '';
  const shown = qaTplExpanded ? list : list.slice(0, 8);
  const chips = shown.map(t =>
    `<button type="button" class="qa-chip" data-tpl="${t.id}" title="${escapeHtml(t.title)}${t.time ? ' ' + t.time : ''}">${escapeHtml(t.title)}</button>`
  ).join('');
  const more = (list.length > 8 && !qaTplExpanded) ? '<button type="button" class="qa-chip" data-tpl-more="1">…</button>' : '';
  return `<div class="qa-tpl-row">${chips}${more}</div>`;
}

function buildQuickAdd(panel) {
  const tk = dateKey(today());
  panel.innerHTML = `
    <div class="tool-hint">回车快速保存，可连续添加；默认归属今天</div>
    <div class="qa-tpl-holder"></div>
    <input type="text" class="qa-input" maxlength="60" placeholder="要做点什么？（支持「明天下午3点半」等写法）" />
    <div class="qa-hint" hidden></div>
    <div class="qa-row">
      <input type="time" class="qa-time" title="时间（可选）" />
      <input type="date" class="qa-date" value="${tk}" />
    </div>
    <div class="qa-row">
      <select class="qa-cat" title="分类">
        ${Object.keys(CATEGORIES).map(k => `<option value="${k}">${CATEGORIES[k].label}</option>`).join('')}
      </select>
      <select class="qa-urg" title="紧急程度">
        ${Object.keys(URGENCIES).map(k => `<option value="${k}"${k === 'normal' ? ' selected' : ''}>${URGENCIES[k].label}</option>`).join('')}
      </select>
    </div>
    <div class="qa-actions"><button class="qa-save">保存（Enter）</button></div>
  `;
  const titleEl = panel.querySelector('.qa-input');
  const timeEl = panel.querySelector('.qa-time');
  const dateEl = panel.querySelector('.qa-date');
  const catEl = panel.querySelector('.qa-cat');
  const urgEl = panel.querySelector('.qa-urg');
  const hintEl = panel.querySelector('.qa-hint');

  // 实时解析回填（P5.2）：解析结果变化时才回填控件（手动改过的控件不被同结果覆盖），所见即所得
  let lastApplied = '';
  const applyParse = () => {
    const p = parseQuickInput(titleEl.value, today());
    if (p.hits.length) {
      hintEl.textContent = quickInputPreview(p);
      hintEl.hidden = false;
      const sig = p.date + '|' + p.time;
      if (sig !== lastApplied) {
        if (p.date) dateEl.value = p.date;
        if (p.time) timeEl.value = p.time;
        lastApplied = sig;
      }
    } else {
      hintEl.textContent = '';
      hintEl.hidden = true;
      lastApplied = '';
    }
  };
  titleEl.addEventListener('input', applyParse);

  // 模板 chips（P5.3）：点击预填整表单（标题/时间/分类/紧急度），右键删除该模板；
  // 只重绘 holder 容器，不重建面板（避免清掉正在输入的标题）
  const tplHolder = panel.querySelector('.qa-tpl-holder');
  const bindChips = () => {
    tplHolder.querySelectorAll('.qa-chip[data-tpl]').forEach(chip => {
      chip.addEventListener('click', () => {
        const t = loadEventTemplates().find(x => x.id === chip.dataset.tpl);
        if (!t) return;
        titleEl.value = t.title;
        timeEl.value = t.time || '';
        catEl.value = t.category || 'work';
        urgEl.value = t.urgency || 'normal';
        lastApplied = '';          // 模板应用视为手动状态，后续输入按解析差异回填
        titleEl.focus();
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const t = loadEventTemplates().find(x => x.id === chip.dataset.tpl);
        if (!t) return;
        if (confirm(`删除模板「${t.title}」？`)) {
          deleteEventTemplate(t.id);
          paintChips();
        }
      });
    });
    const moreBtn = tplHolder.querySelector('[data-tpl-more]');
    if (moreBtn) moreBtn.addEventListener('click', () => { qaTplExpanded = true; paintChips(); });
  };
  const paintChips = () => { tplHolder.innerHTML = tplChipsHtml(); bindChips(); };
  paintChips();

  const doSave = () => {
    const t = titleEl.value.trim();
    if (!t) { titleEl.focus(); return; }
    const d = dateEl.value || tk;
    addEvent({
      title: t, time: timeEl.value || '',
      startDate: d, endDate: d,
      category: catEl.value, urgency: urgEl.value,
      projectId: null
    });
    // addEvent 内部已 render（工具面板重建），重新聚焦输入框支持连续录入
    showToast('已添加：' + t);
    const ni = document.querySelector('.qa-input');
    if (ni) { ni.focus(); ni.parentElement.querySelector('.qa-time').value = timeEl.value; }
  };
  panel.querySelector('.qa-save').addEventListener('click', doSave);
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  // 便签联动（P3.3）：消费预填标题后清空，仅本次生效（P5.2：预填内容同样走实时解析）
  if (pendingQuickAddText) {
    titleEl.value = pendingQuickAddText;
    pendingQuickAddText = '';
    applyParse();
  }
  titleEl.focus();
}

// ---- 工具二：番茄钟（与系统时钟完全独立；折叠/切走后继续计时，图标红点提示） ----
const POMO = {
  workMin: 25, breakMin: 5,
  longMin: 15, cycle: 4,  // 连续完成 cycle 个专注后进入长休息
  session: 0,             // 当前周期内已完成的专注数
  isLong: false,          // 当前休息是否为长休息
  started: false,         // 本次应用启动后是否开始过（用于"准备专注/继续"文案）
  mode: 'work',           // work | break
  running: false,
  endAt: 0,               // 运行中：倒计时结束时间戳
  remainMs: 25 * 60000,   // 暂停时：剩余毫秒
  timerId: null,
  doneToday: 0,
  doneDate: '',
  taskId: null,           // 绑定的事项 ID（null 表示未绑定）
  taskTitle: ''           // 绑定事项标题（仅显示用）
};
// 时长/周期配置持久化（今日完成数已有 pomoStats，这里只存偏好）
function loadPomoCfg() {
  try {
    const c = JSON.parse(localStorage.getItem('pomoCfg') || '{}');
    if ([15, 25, 45].includes(c.workMin)) POMO.workMin = c.workMin;
    if ([5, 10].includes(c.breakMin)) POMO.breakMin = c.breakMin;
    if ([10, 15, 20, 30].includes(c.longMin)) POMO.longMin = c.longMin;
    if ([2, 3, 4, 6].includes(c.cycle)) POMO.cycle = c.cycle;
  } catch { /* 首次运行 */ }
}
function savePomoCfg() {
  localStorage.setItem('pomoCfg', JSON.stringify({
    workMin: POMO.workMin, breakMin: POMO.breakMin, longMin: POMO.longMin, cycle: POMO.cycle
  }));
}
loadPomoCfg();
POMO.remainMs = POMO.workMin * 60000;   // 按持久化配置重设初始剩余
function loadPomoStats() {
  try {
    const s = JSON.parse(localStorage.getItem('pomoStats') || '{}');
    if (s.date === dateKey(today())) { POMO.doneToday = s.count || 0; POMO.doneDate = s.date; }
    else { POMO.doneToday = 0; POMO.doneDate = dateKey(today()); }
  } catch { /* 无统计 */ }
}
function savePomoStats() {
  localStorage.setItem('pomoStats', JSON.stringify({ date: dateKey(today()), count: POMO.doneToday }));
}
loadPomoStats();

// 番茄钟事项日志：按日记录每个绑定事项的专注次数（key: pomoTaskLogs）
function loadPomoTaskLogs() {
  try {
    const o = JSON.parse(localStorage.getItem('pomoTaskLogs') || '{}');
    if (o.date === dateKey(today()) && Array.isArray(o.logs)) return o.logs;
  } catch { /* 无日志 */ }
  return [];
}
function savePomoTaskLogs(logs) {
  localStorage.setItem('pomoTaskLogs', JSON.stringify({ date: dateKey(today()), logs }));
}
function appendPomoTaskLog(taskId, taskTitle, minutes) {
  const logs = loadPomoTaskLogs();
  logs.push({ taskId, taskTitle, minutes, ts: new Date().toISOString() });
  savePomoTaskLogs(logs);
  // 同步累积跨天专注历史（统计趋势的数据源）
  savePomoHistory(pomoHistoryUpsert(loadPomoHistory(), dateKey(today()), minutes));
}

// 番茄钟历史聚合：跨天累积，供统计趋势（key: pomoHistory，[{date, count, minutes}]，按日期升序）
function loadPomoHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem('pomoHistory') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePomoHistory(arr) {
  localStorage.setItem('pomoHistory', JSON.stringify(arr));
}
// 纯函数：某日专注聚合 upsert（同日累加次数与分钟），返回新数组（不改原数组；便于单元测试）
function pomoHistoryUpsert(history, date, minutes) {
  const out = Array.isArray(history) ? history.slice() : [];
  const row = out.find(r => r.date === date);
  if (row) { row.count += 1; row.minutes += minutes; }
  else out.push({ date, count: 1, minutes });
  return out;
}

// 专注自然完成时同步绑定事项：pomoCount 累计 + 写入当日事项日志（pomoTick 调用；独立成函数便于单元测试）
function pomoBindComplete() {
  if (!POMO.taskId) return;
  const list = loadEvents();
  const ev = list.find(x => x.id === POMO.taskId);
  if (!ev) return;
  ev.pomoCount = (ev.pomoCount || 0) + 1;
  saveEvents(list);
  appendPomoTaskLog(POMO.taskId, POMO.taskTitle || ev.title, POMO.workMin);
}

function pomoFmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function pomoPhaseMs() {
  if (POMO.mode === 'work') return POMO.workMin * 60000;
  return (POMO.isLong ? POMO.longMin : POMO.breakMin) * 60000;
}
// 进入休息：自然完成一个专注后调用（跳过不计入周期）
function pomoEnterBreak() {
  POMO.session += 1;
  POMO.isLong = POMO.session % POMO.cycle === 0;
  POMO.mode = 'break';
  POMO.remainMs = pomoPhaseMs();
}
function pomoNotify(title, body) {
  try {
    if (Notification.permission === 'granted') {
      // 点击通知仅唤起窗口（番茄钟完成无具体事项定位语义）
      const n = new Notification(title, { body });
      n.onclick = () => { try { n.close(); } catch { /* 已关 */ } focusWindow(); };
    }
    else showToast(title + '：' + body);
  } catch { showToast(title + '：' + body); }
}
function pomoTick() {
  if (!POMO.running) return;
  const remain = POMO.endAt - Date.now();
  if (remain > 0) {
    POMO.remainMs = remain;
    pomoPaint(false);
    return;
  }
  // 一个阶段结束
  if (POMO.mode === 'work') {
    POMO.doneToday += 1;
    if (POMO.doneDate !== dateKey(today())) { POMO.doneToday = 1; POMO.doneDate = dateKey(today()); }
    savePomoStats();
    pomoBindComplete();   // 绑定事项：累计 pomoCount 并写入当日事项日志
    pomoEnterBreak();
    POMO.endAt = Date.now() + POMO.remainMs;   // 自动进入休息
    playChime(CHIME.ding);
    pomoNotify('番茄钟', POMO.isLong
      ? `连续 ${POMO.session} 个专注完成，进入长休息`
      : '工作结束，休息一下吧');
  } else {
    POMO.mode = 'work';
    if (POMO.isLong) { POMO.session = 0; POMO.isLong = false; }   // 长休息结束 → 开启新一轮周期
    POMO.remainMs = pomoPhaseMs();
    POMO.running = false;
    POMO.endAt = 0;
    clearInterval(POMO.timerId); POMO.timerId = null;
    playChime(CHIME.ding);
    pomoNotify('番茄钟', '休息结束，开始下一个专注');
  }
  pomoPaint(true);
}
function pomoStart() {
  if (POMO.running) return;
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch { /* 忽略 */ }
  }
  POMO.running = true;
  POMO.started = true;
  POMO.endAt = Date.now() + POMO.remainMs;
  if (POMO.timerId) clearInterval(POMO.timerId);
  POMO.timerId = setInterval(pomoTick, 1000);
  pomoPaint(true);
}
function pomoPause() {
  if (!POMO.running) return;
  POMO.running = false;
  POMO.remainMs = Math.max(0, POMO.endAt - Date.now());
  POMO.endAt = 0;
  if (POMO.timerId) { clearInterval(POMO.timerId); POMO.timerId = null; }
  pomoPaint(true);
}
function pomoReset() {
  POMO.running = false; POMO.endAt = 0;
  POMO.mode = 'work';
  POMO.session = 0; POMO.isLong = false;   // 重置回全新周期
  POMO.remainMs = pomoPhaseMs();
  POMO.taskId = null; POMO.taskTitle = '';  // 重置同时解除事项绑定
  if (POMO.timerId) { clearInterval(POMO.timerId); POMO.timerId = null; }
  pomoPaint(true);
}
function pomoSkip() {
  if (POMO.mode === 'work') {
    // 跳过专注：不计入周期/统计，进入普通短休息
    POMO.isLong = false;
    POMO.mode = 'break';
  } else {
    // 跳过休息：长休息同样开启新一轮周期
    if (POMO.isLong) { POMO.session = 0; POMO.isLong = false; }
    POMO.mode = 'work';
  }
  POMO.remainMs = pomoPhaseMs();
  if (POMO.running) POMO.endAt = Date.now() + POMO.remainMs;
  pomoPaint(true);
}
// 只更新番茄钟自己的显示节点，绝不触碰 railTime/railDate
function pomoPaint(full) {
  const dot = railEl.querySelector('[data-tool="pomodoro"] .rail-dot');
  if (dot) dot.classList.toggle('hidden', !POMO.running);
  const pico = railEl.querySelector('[data-tool="pomodoro"]');
  if (pico) {
    const phase = POMO.mode === 'work' ? '专注' : (POMO.isLong ? '长休息' : '休息');
    pico.title = `番茄钟（${phase}${POMO.running ? '' : '·已暂停'} ${pomoFmt(POMO.remainMs)}）`;
  }
  const tEl = document.querySelector('.pomo-time');
  if (tEl) tEl.textContent = pomoFmt(POMO.remainMs);
  if (full) render();
}

function pomoStatusLabel() {
  if (POMO.mode === 'work') {
    if (POMO.running) return '🍅 专注中';
    return POMO.started ? '⏸ 已暂停' : '🍅 准备专注';
  }
  const rest = POMO.isLong ? '🛏 长休息' : '☕ 短休息';
  return POMO.running ? rest + '中' : '⏸ 已暂停';
}
function pomoCycleDots() {
  let html = '';
  for (let i = 0; i < POMO.cycle; i++) {
    html += `<span class="pc-dot${i < POMO.session ? ' on' : ''}"></span>`;
  }
  return html;
}

function buildPomodoro(panel) {
  const nextPos = Math.min(POMO.session + 1, POMO.cycle);
  // 事项绑定下拉：未完成事项
  const pendingTasks = loadEvents().filter(e => !e.done);
  const taskOpts = pendingTasks.map(t =>
    `<option value="${t.id}"${POMO.taskId === t.id ? ' selected' : ''}>${escapeHtml(t.title)}${t.startDate ? `（${fmtShort(t.startDate)}）` : ''}</option>`
  ).join('');
  panel.innerHTML = `
    <div class="pomo-bind">
      <label class="pomo-bind-label">绑定事项
        <select class="pomo-task">
          <option value="">— 不绑定 —</option>
          ${taskOpts}
        </select>
      </label>
      ${POMO.taskId ? `<span class="pomo-bind-tag" title="已绑定：${escapeHtml(POMO.taskTitle)}">🍅 ${escapeHtml(POMO.taskTitle)}</span>` : ''}
    </div>
    <div class="pomo-stage">
      <div class="pomo-mode">${pomoStatusLabel()}</div>
      <div class="pomo-time">${pomoFmt(POMO.remainMs)}</div>
      <div class="pomo-cycles" title="每 ${POMO.cycle} 个专注后进入长休息">${pomoCycleDots()}</div>
      <div class="pomo-cyc-hint">第 ${nextPos}/${POMO.cycle} 个专注${POMO.mode === 'break' ? `（休息中，已完成 ${POMO.session} 个）` : ''}</div>
      <div class="pomo-actions">
        <button class="pomo-toggle">${POMO.running ? '暂停' : (POMO.started ? '继续' : '开始')}</button>
        <button class="pomo-reset">重置</button>
        <button class="pomo-skip">跳过本阶段</button>
      </div>
    </div>
    <div class="pomo-row">
      <label>专注
        <select class="pomo-work">
          ${[15, 25, 45].map(m => `<option value="${m}"${POMO.workMin === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
        </select>
      </label>
      <label>休息
        <select class="pomo-break">
          ${[5, 10].map(m => `<option value="${m}"${POMO.breakMin === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="pomo-row">
      <label>长休息
        <select class="pomo-long">
          ${[10, 15, 20, 30].map(m => `<option value="${m}"${POMO.longMin === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
        </select>
      </label>
      <label>长休息周期
        <select class="pomo-cycle">
          ${[2, 3, 4, 6].map(n => `<option value="${n}"${POMO.cycle === n ? ' selected' : ''}>每 ${n} 个</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="tool-hint">今日已完成 ${POMO.doneToday} 个专注；连续 ${POMO.cycle} 个专注后自动长休息；计时与系统时钟互不影响</div>
  `;
  panel.querySelector('.pomo-toggle').addEventListener('click', () => POMO.running ? pomoPause() : pomoStart());
  panel.querySelector('.pomo-reset').addEventListener('click', pomoReset);
  panel.querySelector('.pomo-skip').addEventListener('click', pomoSkip);
  // 事项绑定：切换下拉即更新 POMO.taskId
  panel.querySelector('.pomo-task').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!id) { POMO.taskId = null; POMO.taskTitle = ''; }
    else {
      const t = loadEvents().find(x => x.id === id);
      POMO.taskId = id;
      POMO.taskTitle = t ? t.title : '';
    }
    pomoPaint(true);
  });
  panel.querySelector('.pomo-work').addEventListener('change', (e) => {
    POMO.workMin = Number(e.target.value);
    if (!POMO.running && POMO.mode === 'work') POMO.remainMs = pomoPhaseMs();
    savePomoCfg();
    pomoPaint(true);
  });
  panel.querySelector('.pomo-break').addEventListener('change', (e) => {
    POMO.breakMin = Number(e.target.value);
    if (!POMO.running && POMO.mode === 'break' && !POMO.isLong) POMO.remainMs = pomoPhaseMs();
    savePomoCfg();
    pomoPaint(true);
  });
  panel.querySelector('.pomo-long').addEventListener('change', (e) => {
    POMO.longMin = Number(e.target.value);
    if (!POMO.running && POMO.mode === 'break' && POMO.isLong) POMO.remainMs = pomoPhaseMs();
    savePomoCfg();
    pomoPaint(true);
  });
  panel.querySelector('.pomo-cycle').addEventListener('change', (e) => {
    POMO.cycle = Number(e.target.value);
    if (POMO.session >= POMO.cycle) POMO.session = 0;   // 周期缩短时回到起点
    savePomoCfg();
    pomoPaint(true);
  });
}

// ---- 工具三：今日进度 / 统计 ----
// ============ 数据统计与周报（P3.1；纯函数 + DOM 柱状图，不引图表库） ============
// ISO 时间 → 本地日期 key（toISOString 为 UTC，直接 slice 会有时区偏差，统一转本地）
function isoDateKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : dateKey(d);
}
// 周一为一周起始
function startOfWeek(d) {
  const r = stripTime(d);
  const wd = (r.getDay() + 6) % 7;   // 周一=0 … 周日=6
  return addDays(r, -wd);
}
// 生成连续日期 key 数组（从 startKey 起共 days 天）
function dateKeyRange(startKey, days) {
  const start = parseDateKey(startKey);
  const out = [];
  for (let i = 0; i < days; i++) out.push(dateKey(addDays(start, i)));
  return out;
}
// 区间统计：每日新增/完成/专注 + 汇总 + 分类分布 + 项目排行
// 口径：新增按 createdAt 日期；完成按 updatedAt 日期（仅 done 项）；未来日期不计入
function buildStats(events, history, rangeDays, now) {
  now = now || new Date();
  const days = Math.max(1, rangeDays | 0);
  const keys = dateKeyRange(dateKey(addDays(stripTime(now), -(days - 1))), days);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const daily = keys.map(k => ({ date: k, created: 0, done: 0, focusCount: 0, focusMinutes: 0 }));
  const focusMap = new Map((history || []).map(h => [h.date, h]));

  let createdTotal = 0, doneTotal = 0;
  const catCount = {};
  const projDone = new Map();
  for (const ev of events || []) {
    const ci = idx.get(isoDateKey(ev.createdAt));
    if (ci !== undefined) { daily[ci].created++; createdTotal++; }
    if (ev.done) {
      const di = idx.get(isoDateKey(ev.updatedAt || ev.createdAt));
      if (di !== undefined) {
        daily[di].done++; doneTotal++;
        catCount[ev.category] = (catCount[ev.category] || 0) + 1;
        if (ev.projectId) projDone.set(ev.projectId, (projDone.get(ev.projectId) || 0) + 1);
      }
    }
  }
  let focusCount = 0, focusMinutes = 0;
  for (const d of daily) {
    const h = focusMap.get(d.date);
    if (h) { d.focusCount = h.count || 0; d.focusMinutes = h.minutes || 0; }
    focusCount += d.focusCount; focusMinutes += d.focusMinutes;
  }
  const categories = Object.keys(CATEGORIES).map(k => ({
    key: k, label: CATEGORIES[k].label, color: CATEGORIES[k].color, count: catCount[k] || 0
  }));
  // 项目排行：只列有事项的项目，按区间完成数降序（平局按项目名），最多 5 个
  const projects = loadProjects().map(p => {
    const total = (events || []).filter(e => e.projectId === p.id).length;
    return { id: p.id, name: p.name, done: projDone.get(p.id) || 0, total };
  }).filter(p => p.total > 0).sort((a, b) => (b.done - a.done) || a.name.localeCompare(b.name)).slice(0, 5);

  // 连续专注 streak（P5.1）：从今天往前数连续有专注的天数；
  // 今天尚无记录则从昨天起算（避免"当天还没专注"清零连续记录）
  const focusMinMap = new Map((history || []).map(h => [h.date, h.minutes || 0]));
  let streak = 0;
  {
    let cursor = stripTime(now);
    if ((focusMinMap.get(dateKey(cursor)) || 0) <= 0) cursor = addDays(cursor, -1);
    while ((focusMinMap.get(dateKey(cursor)) || 0) > 0) { streak++; cursor = addDays(cursor, -1); }
  }

  // 上一周期对照（P5.1）：区间整体前移同长度，口径与主区间一致
  const pKeys = dateKeyRange(dateKey(addDays(stripTime(now), -(days * 2 - 1))), days);
  const pIdx = new Map(pKeys.map((k, i) => [k, i]));
  let prevCreated = 0, prevDone = 0, prevFocusMinutes = 0;
  for (const ev of events || []) {
    if (pIdx.has(isoDateKey(ev.createdAt))) prevCreated++;
    if (ev.done && pIdx.has(isoDateKey(ev.updatedAt || ev.createdAt))) prevDone++;
  }
  for (const h of history || []) {
    if (pIdx.has(h.date)) prevFocusMinutes += h.minutes || 0;
  }

  // 未完成积压（P5.1）：一次性事项按截止日分档；重复事项执行区间语义复杂，不计入
  const tkNow = dateKey(now);
  const backlog = { overdue: 0, today: 0, future: 0, undated: 0, urgent: 0 };
  for (const ev of events || []) {
    if (ev.done || isRecurOn(ev)) continue;
    const s = eventStart(ev), e = eventEnd(ev) || s;
    if (ev.urgency === 'urgent') backlog.urgent++;
    if (!s) { backlog.undated++; continue; }
    if (e < tkNow) backlog.overdue++;
    else if (s <= tkNow) backlog.today++;
    else backlog.future++;
  }

  return {
    startKey: keys[0], endKey: keys[keys.length - 1], daily,
    totals: {
      createdTotal, doneTotal,
      rate: createdTotal ? Math.round(doneTotal / createdTotal * 100) : 0,
      focusCount, focusMinutes
    },
    categories, projects,
    streak,
    prev: { createdTotal: prevCreated, doneTotal: prevDone, focusMinutes: prevFocusMinutes },
    backlog
  };
}

// 本周 vs 上周对照（P5.1 纯函数）：完成/新增/专注分钟 三指标，固定按自然周（周一~周日）
function weekCompare(events, history, now) {
  now = now || new Date();
  const wk = new Set(dateKeyRange(dateKey(startOfWeek(now)), 7));
  const pw = new Set(dateKeyRange(dateKey(addDays(startOfWeek(now), -7)), 7));
  let done = 0, created = 0, pDone = 0, pCreated = 0;
  for (const ev of events || []) {
    const ck = isoDateKey(ev.createdAt), dk = isoDateKey(ev.updatedAt || ev.createdAt);
    if (wk.has(ck)) created++;
    if (pw.has(ck)) pCreated++;
    if (ev.done) {
      if (wk.has(dk)) done++;
      if (pw.has(dk)) pDone++;
    }
  }
  let fm = 0, pfm = 0;
  for (const h of history || []) {
    if (wk.has(h.date)) fm += h.minutes || 0;
    if (pw.has(h.date)) pfm += h.minutes || 0;
  }
  return { done, created, focusMinutes: fm, prev: { done: pDone, created: pCreated, focusMinutes: pfm } };
}
// 周报 Markdown：本周（周一~周日）完成事项按项目分组 + 专注汇总 + 每日完成条形
function buildWeeklyReport(events, projects, history, now) {
  now = now || new Date();
  const ws = startOfWeek(now), we = addDays(ws, 6);
  const wsK = dateKey(ws), weK = dateKey(we);
  const keys = dateKeyRange(wsK, 7);
  const inWeek = (k) => keys.includes(k);

  let focusCount = 0, focusMinutes = 0;
  for (const h of history || []) {
    if (inWeek(h.date)) { focusCount += h.count || 0; focusMinutes += h.minutes || 0; }
  }
  const doneEvents = (events || []).filter(e => e.done && inWeek(isoDateKey(e.updatedAt || e.createdAt)));
  const dayCount = keys.map(k => doneEvents.filter(e => isoDateKey(e.updatedAt || e.createdAt) === k).length);
  const maxCount = Math.max(1, ...dayCount);
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  const barOf = (n) => '█'.repeat(Math.round(n / maxCount * 8)) + '░'.repeat(8 - Math.round(n / maxCount * 8));

  const lines = [];
  lines.push(`# 周报（${wsK} ~ ${weK}）`, '');
  lines.push('## 专注概览', '');
  lines.push(`- 完成专注：${focusCount} 个，共 ${focusMinutes} 分钟（约 ${(focusMinutes / 60).toFixed(1)} 小时）`);
  lines.push(`- 完成事项：${doneEvents.length} 项`, '');
  lines.push('## 每日完成', '');
  keys.forEach((k, i) => {
    const md = k.slice(5).replace('-', '/');
    lines.push(`- ${md} 周${WD[i]}  ${dayCount[i]} ${barOf(dayCount[i])}`);
  });
  lines.push('', '## 完成事项', '');
  if (!doneEvents.length) {
    lines.push('本周暂无完成事项。', '');
  } else {
    // 按项目分组：项目按 projects 现有顺序，未归类放最后
    const groups = [];
    const pushGroup = (name, list) => { if (list.length) groups.push({ name, list }); };
    for (const p of projects) {
      pushGroup(p.name, doneEvents.filter(e => e.projectId === p.id));
    }
    pushGroup('未归类', doneEvents.filter(e => !e.projectId));
    for (const g of groups) {
      lines.push(`### ${g.name}（${g.list.length}）`, '');
      for (const ev of g.list) lines.push(`- [x] ${ev.time ? ev.time + ' ' : ''}${ev.title}`);
      lines.push('');
    }
  }
  lines.push('> 由日程侧边栏自动生成');
  return lines.join('\n');
}

// ---- 统计工具面板 ----
let statsRangeDays = 7;   // 统计区间：7 | 30
let statsTrendMode = 'focus';   // 趋势卡数据列：focus（专注分钟）| done（完成事项）（P5.1）
function buildStatsPanel(panel) {
  const now = today();
  const st = buildStats(loadEvents(), loadPomoHistory(), statsRangeDays, now);
  const t = st.totals;
  // 趋势卡双指标（P5.1）：专注分钟 / 完成事项，同一柱状图切数据列
  const trendDone = statsTrendMode === 'done';
  const maxCol = Math.max(1, ...st.daily.map(d => trendDone ? d.done : d.focusMinutes));
  const maxCat = Math.max(1, ...st.categories.map(c => c.count));
  const WD_CH = ['日', '一', '二', '三', '四', '五', '六'];
  const barCols = st.daily.map(d => {
    const v = trendDone ? d.done : d.focusMinutes;
    const h = Math.round(v / maxCol * 100);
    const wd = statsRangeDays === 7 ? '<em>' + WD_CH[parseDateKey(d.date).getDay()] + '</em>' : '';
    return `<div class="stat-bar-col" title="${d.date}：专注 ${d.focusCount} 次/${d.focusMinutes} 分钟，完成 ${d.done} 项">
      <div class="stat-bar-track"><div class="stat-bar" style="height:${h}%"></div></div>
      <div class="stat-bar-x">${d.date.slice(8)}${wd}</div>
    </div>`;
  }).join('');
  const wsK = dateKey(startOfWeek(now)), weK = dateKey(addDays(startOfWeek(now), 6));
  // 专注报表（P5.1）：区间天数/日均/峰值/连续 + 今日任务 top（按 taskId 聚合当日番茄钟日志）
  const focusDays = st.daily.filter(d => d.focusMinutes > 0).length;
  const peakMin = st.daily.reduce((m, d) => Math.max(m, d.focusMinutes), 0);
  const avgMin = focusDays ? Math.round(t.focusMinutes / focusDays) : 0;
  const taskAgg = new Map();
  for (const l of loadPomoTaskLogs()) {
    const k = l.taskId || '_';
    const cur = taskAgg.get(k) || { title: l.taskTitle || '未绑定事项', count: 0, minutes: 0 };
    cur.count++; cur.minutes += l.minutes || 0;
    taskAgg.set(k, cur);
  }
  const todayTasks = [...taskAgg.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 3);
  // 本周 vs 上周（P5.1）
  const wc = weekCompare(loadEvents(), loadPomoHistory(), now);
  const cmpRow = (label, cur, pv, unit) => {
    const diff = cur - pv;
    const arrow = pv <= 0
      ? '<span class="stat-cmp-na">—</span>'
      : diff > 0 ? `<span class="stat-cmp up">↑ ${diff}</span>`
      : diff < 0 ? `<span class="stat-cmp down">↓ ${-diff}</span>`
      : '<span class="stat-cmp-na">持平</span>';
    return `<div class="stat-cmp-row"><span class="stat-cmp-label">${label}</span><b>${cur}</b><span class="stat-cmp-unit">${unit}</span>${arrow}</div>`;
  };

  panel.innerHTML = `
    <div class="stat-toolbar">
      <div class="stat-range">
        <button type="button" class="stat-range-btn" data-r="7">近7天</button>
        <button type="button" class="stat-range-btn" data-r="30">近30天</button>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">趋势<span class="stat-card-sub">${st.startKey} ~ ${st.endKey}</span></div>
      <div class="stat-toolbar">
        <div class="stat-range">
          <button type="button" class="stat-range-btn" data-trend="focus">专注分钟</button>
          <button type="button" class="stat-range-btn" data-trend="done">完成事项</button>
        </div>
      </div>
      <div class="stat-bars">${barCols}</div>
      <div class="stat-card-foot">${trendDone ? `共完成 ${t.doneTotal} 项` : `共 ${t.focusCount} 次专注 · ${t.focusMinutes} 分钟`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">事项概览<span class="stat-card-sub">${st.startKey} ~ ${st.endKey}</span></div>
      <div class="stat-overview">
        <div class="stat-num"><b>${t.doneTotal}</b><span>已完成</span></div>
        <div class="stat-num"><b>${t.createdTotal}</b><span>新增</span></div>
        <div class="stat-num"><b>${t.rate}%</b><span>完成率</span></div>
      </div>
      ${progressBarHtml(Math.min(t.doneTotal, t.createdTotal), t.createdTotal)}
      <div class="stat-card-hint">完成率＝区间完成数/新增数；补做历史事项时可超过 100%</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">待办积压<span class="stat-card-sub">未完成事项</span></div>
      <div class="stat-overview">
        <div class="stat-num${st.backlog.overdue ? ' warn' : ''}"><b>${st.backlog.overdue}</b><span>已逾期</span></div>
        <div class="stat-num"><b>${st.backlog.today}</b><span>今日</span></div>
        <div class="stat-num"><b>${st.backlog.future}</b><span>未来</span></div>
        <div class="stat-num"><b>${st.backlog.undated}</b><span>无日期</span></div>
      </div>
      <div class="stat-card-hint">${st.backlog.overdue + st.backlog.today + st.backlog.future + st.backlog.undated === 0 ? '当前没有待办事项' : `紧急未完成 ${st.backlog.urgent} 项${st.backlog.overdue ? '；存在逾期，建议优先处理' : ''}`}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">专注报表<span class="stat-card-sub">近 ${statsRangeDays} 天</span></div>
      <div class="stat-overview">
        <div class="stat-num"><b>${focusDays}</b><span>专注天数</span></div>
        <div class="stat-num"><b>${avgMin}</b><span>日均分钟</span></div>
        <div class="stat-num"><b>${peakMin}</b><span>单日最高</span></div>
        <div class="stat-num"><b>${st.streak}</b><span>连续天数</span></div>
      </div>
      ${todayTasks.length ? `<div class="stat-rows">
        ${todayTasks.map(x => `
          <div class="stat-row">
            <span class="stat-row-name" title="${escapeHtml(x.title)}">${escapeHtml(x.title)}</span>
            <span class="stat-row-bar"><i style="width:${Math.min(100, Math.round(x.minutes / Math.max(1, todayTasks[0].minutes) * 100))}%"></i></span>
            <span class="stat-row-num">${x.minutes}′</span>
          </div>`).join('')}
      </div>
      <div class="stat-card-hint">今日专注任务（按分钟排序）</div>` : ''}
    </div>
    <div class="stat-card">
      <div class="stat-card-title">本周 vs 上周<span class="stat-card-sub">${wsK} ~ ${weK}</span></div>
      <div class="stat-rows">
        ${cmpRow('完成事项', wc.done, wc.prev.done, '项')}
        ${cmpRow('新增事项', wc.created, wc.prev.created, '项')}
        ${cmpRow('专注时长', wc.focusMinutes, wc.prev.focusMinutes, '分')}
      </div>
      <div class="stat-card-hint">箭头为与上周的差值；上周基数为 0 时显示 —</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">分类分布<span class="stat-card-sub">按完成数</span></div>
      <div class="stat-rows">
        ${st.categories.map(c => `
          <div class="stat-row">
            <span class="stat-row-name">${c.label}</span>
            <span class="stat-row-bar"><i style="width:${Math.round(c.count / maxCat * 100)}%;background:${c.color}"></i></span>
            <span class="stat-row-num">${c.count}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">项目排行<span class="stat-card-sub">区间完成/总事项</span></div>
      <div class="stat-rows">
        ${st.projects.length ? st.projects.map(p => `
          <div class="stat-row">
            <span class="stat-row-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
            <span class="stat-row-bar"><i style="width:${p.total ? Math.round(p.done / p.total * 100) : 0}%"></i></span>
            <span class="stat-row-num">${p.done}/${p.total}</span>
          </div>`).join('') : '<div class="empty-hint">— 暂无项目事项 —</div>'}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-title">本周周报<span class="stat-card-sub">${wsK} ~ ${weK}</span></div>
      <div class="stat-card-hint">汇总本周完成事项与专注时长，Markdown 纯文本，可粘贴到便签/文档</div>
      <div class="stat-week-actions">
        <button type="button" class="notes-btn stat-copy-week">复制周报</button>
        <button type="button" class="notes-btn stat-export-week">导出 .md</button>
      </div>
    </div>
  `;

  // 区间切换：重绘本面板（按 data-r 作用域，避免误绑趋势切换按钮）
  panel.querySelectorAll('[data-r]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.r) === statsRangeDays);
    btn.addEventListener('click', () => {
      statsRangeDays = Number(btn.dataset.r);
      panel.innerHTML = '';
      buildStatsPanel(panel);
    });
  });

  // 趋势卡切换（P5.1）：专注分钟 / 完成事项，同一柱状图切数据列
  panel.querySelectorAll('[data-trend]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.trend === statsTrendMode);
    btn.addEventListener('click', () => {
      if (statsTrendMode === btn.dataset.trend) return;
      statsTrendMode = btn.dataset.trend;
      panel.innerHTML = '';
      buildStatsPanel(panel);
    });
  });

  const getReport = () => buildWeeklyReport(loadEvents(), loadProjects(), loadPomoHistory(), now);
  panel.querySelector('.stat-copy-week').addEventListener('click', () => {
    const text = getReport();
    if (window.timetable && window.timetable.clipboardCopy) {
      window.timetable.clipboardCopy(text);
      showToast('周报已复制到剪贴板');
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('周报已复制到剪贴板'));
    } else {
      showToast('当前环境不支持复制剪贴板');
    }
  });
  panel.querySelector('.stat-export-week').addEventListener('click', async () => {
    const btn = panel.querySelector('.stat-export-week');
    btn.disabled = true;
    try {
      const res = await window.timetable.backupExportDialog(`周报-${wsK}.md`, getReport());
      if (res && res.ok) showToast('周报已导出');
      else if (res && res.error) showToast('导出失败：' + res.error);
    } catch (e) {
      showToast('导出失败：' + (e && e.message || e));
    } finally {
      btn.disabled = false;
    }
  });
}

// ---- 工具六：全局搜索（跨全部日期，匹配标题/备注） ----
// 搜索纯函数：不区分大小写，按开始日期升序、无日期排最后
function searchEvents(events, q) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return [];
  const hit = (s) => String(s || '').toLowerCase().includes(kw);
  return events
    .filter(ev => hit(ev.title) || hit(ev.description))
    .sort((a, b) => {
      const da = eventStart(a), db = eventStart(b);
      if (!!da !== !!db) return da ? -1 : 1;
      return (da || '').localeCompare(db || '');
    });
}

// 点击搜索结果：关闭工具，翻页定位到事项所在周（无日期 → 事项视图），再打开编辑
function gotoSearchResult(ev) {
  closeTool();
  const startKey = eventStart(ev);
  if (startKey) {
    rangeStart = addDays(parseDateKey(startKey), -1);   // 事项落在第二张卡，与初始布局一致
    switchView('calendar');
  } else {
    switchView('tasks');
  }
  openTaskEditor(ev);
}

// 通知点击直达（P4.1）：唤起窗口并展开侧栏（主进程负责显示，失败静默——通知本身已可见）
function focusWindow() {
  try {
    if (window.timetable && window.timetable.showWindow) { window.timetable.showWindow(); return true; }
  } catch { /* 主进程不支持时忽略 */ }
  return false;
}

function buildSearchPanel(panel) {
  panel.innerHTML = `
    <div class="search-box">
      <input type="text" class="search-input" placeholder="搜索事项标题或备注..." />
    </div>
    <div class="search-results"></div>
  `;
  const input = panel.querySelector('.search-input');
  const results = panel.querySelector('.search-results');

  const paint = () => {
    results.innerHTML = '';
    const q = input.value;
    if (!q.trim()) {
      results.innerHTML = '<div class="empty-hint">输入关键字，跨日期搜索全部事项</div>';
      return;
    }
    const list = searchEvents(loadEvents(), q);
    if (!list.length) {
      results.innerHTML = '<div class="empty-hint">— 无匹配结果 —</div>';
      return;
    }
    for (const ev of list) {
      const item = buildEventItem(ev, { showDate: true, showProject: true });
      // 结果条目整条可点击跳转；去掉勾选/删除控件避免误导（勾选框在结果里无事件绑定）
      const chk = item.querySelector('.event-check'); if (chk) chk.remove();
      const del = item.querySelector('.event-del'); if (del) del.remove();
      item.classList.add('search-hit');
      item.addEventListener('click', () => gotoSearchResult(ev));
      results.appendChild(item);
    }
  };

  input.addEventListener('input', paint);
  paint();
  input.focus();
}

function buildProgress(panel) {
  const tk = dateKey(today());
  const todays = loadEvents().filter(e => eventSpansDate(e, tk));
  const done = todays.filter(e => e.done);
  const undone = todays.filter(e => !e.done);

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="prog-summary">
      <div class="prog-big">${todays.length === 0 ? 0 : Math.round(done.length / todays.length * 100)}%</div>
      <div class="prog-sub">${done.length}/${todays.length} 已完成</div>
    </div>
    ${progressBarHtml(done.length, todays.length)}
    <div class="prog-section-title">待完成（${undone.length}）</div>
  `;
  const list = document.createElement('div');
  list.className = 'prog-list';
  if (!undone.length) {
    list.innerHTML = '<div class="empty-hint">今日事项已全部完成 🎉</div>';
  } else {
    for (const ev of undone) {
      const row = document.createElement('div');
      row.className = 'prog-item';
      row.innerHTML = `<span class="event-check" data-id="${ev.id}"></span><span class="prog-item-time">${escapeHtml(ev.time || '全天')}</span><span class="prog-item-title">${escapeHtml(ev.title)}</span>`;
      row.querySelector('.event-check').addEventListener('click', () => toggleDone(ev.id));
      list.appendChild(row);
    }
  }
  box.appendChild(list);
  if (done.length) {
    // 用节点追加，避免 innerHTML += 重建上面列表而丢失复选框监听
    const title2 = document.createElement('div');
    title2.className = 'prog-section-title';
    title2.textContent = `已完成（${done.length}）`;
    box.appendChild(title2);
    const dl = document.createElement('div');
    dl.className = 'prog-list done-list';
    for (const ev of done) {
      const row = document.createElement('div');
      row.className = 'prog-item';
      row.innerHTML = `<span class="event-check checked" data-id="${ev.id}"></span><span class="prog-item-time">${escapeHtml(ev.time || '全天')}</span><span class="prog-item-title">${escapeHtml(ev.title)}</span>`;
      row.querySelector('.event-check').addEventListener('click', () => toggleDone(ev.id));
      dl.appendChild(row);
    }
    box.appendChild(dl);
  }
  panel.appendChild(box);
}

// ---- 工具四：快速便签（localStorage 自动保存；行内容可快速转为事项） ----
let notesSaveTimer = null;
let notesMode = 'edit';             // 'edit' 编辑态 | 'list' 事项列表态（render 重建后保持）
function loadNotesDone() {
  try { return JSON.parse(localStorage.getItem('notesDoneLines') || '{}'); } catch { return {}; }
}
let notesDoneMap = loadNotesDone();   // { 已转行的 trim 文本: true }
function saveNotesDone() { localStorage.setItem('notesDoneLines', JSON.stringify(notesDoneMap)); }

// 单行 → 一条今日事项（默认工作类、一般紧急度、未归类）；已转行跳过
function notesConvertLine(title, silent, skipRender) {
  title = String(title || '').trim();
  if (!title || notesDoneMap[title]) return false;
  const tk = dateKey(today());
  notesDoneMap[title] = true;
  saveNotesDone();
  addEvent({ title, startDate: tk, endDate: tk, time: '', category: 'work', urgency: 'normal', projectId: null }, skipRender);
  if (!skipRender) render();
  if (!silent) showToast('已转为事项：' + title);
  return true;
}

// 便签全部非空未转行 → 批量事项（只 render 一次）
function notesConvertAll() {
  const lines = (localStorage.getItem('quickNotes') || '')
    .split('\n').map(s => s.trim()).filter(s => s && !notesDoneMap[s]);
  if (!lines.length) { showToast('没有可转换的新内容'); return; }
  lines.forEach(l => notesConvertLine(l, true, true));
  render();
  showToast(`已将 ${lines.length} 行转为今日事项`);
}

// textarea 选区 → 单条事项（多行选区合并为一条标题）
function notesSelectionToEvent(ta) {
  const raw = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  if (!raw) return;
  const title = raw.replace(/\s*\n[\s]*/g, ' ').slice(0, 60);
  const tk = dateKey(today());
  addEvent({ title, startDate: tk, endDate: tk, time: '', category: 'work', urgency: 'normal', projectId: null });
  showToast('已转为事项：' + title);
}

function buildNotes(panel) {
  if (notesMode === 'list') { buildNotesList(panel); return; }
  panel.innerHTML = `
    <textarea class="notes-area" maxlength="5000" placeholder="随手记点什么…（每行一条，自动保存；可逐行或批量转为事项）"></textarea>
    <div class="notes-toolbar">
      <button type="button" class="notes-btn notes-sel" disabled title="先在便签中选中文字">选区转事项</button>
      <button type="button" class="notes-btn notes-all">全部转事项</button>
      <button type="button" class="notes-btn notes-to-qa" title="取第一行非空文字，预填到快速添加（原便签保留）">发到快速添加</button>
      <button type="button" class="notes-btn notes-list-btn">事项列表</button>
    </div>
    <div class="notes-foot">
      <span class="notes-status muted">自动保存</span>
      <span class="notes-count muted"></span>
    </div>
  `;
  const ta = panel.querySelector('.notes-area');
  const status = panel.querySelector('.notes-status');
  const count = panel.querySelector('.notes-count');
  const selBtn = panel.querySelector('.notes-sel');
  ta.value = localStorage.getItem('quickNotes') || '';
  const updateCount = () => { count.textContent = `${ta.value.length}/5000`; };
  const updateSelBtn = () => {
    selBtn.disabled = !ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  };
  updateCount();
  updateSelBtn();
  ta.addEventListener('input', () => {
    updateCount();
    updateSelBtn();
    status.textContent = '保存中…';
    status.classList.remove('muted');
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
      localStorage.setItem('quickNotes', ta.value);
      const d = new Date();
      status.textContent = `已保存 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      status.classList.add('muted');
    }, 400);
  });
  ta.addEventListener('select', updateSelBtn);
  ta.addEventListener('mouseup', updateSelBtn);
  ta.addEventListener('keyup', updateSelBtn);
  selBtn.addEventListener('click', () => notesSelectionToEvent(ta));
  panel.querySelector('.notes-all').addEventListener('click', () => {
    clearTimeout(notesSaveTimer);
    localStorage.setItem('quickNotes', ta.value);   // 先落盘，避免 400ms 防抖丢最新行
    notesConvertAll();
  });
  // 便签联动（P3.3）：第一行非空文字预填快速添加，原便签内容保留
  panel.querySelector('.notes-to-qa').addEventListener('click', () => {
    clearTimeout(notesSaveTimer);
    localStorage.setItem('quickNotes', ta.value);   // 先落盘
    const line = ta.value.split('\n').map(s => s.trim()).find(Boolean);
    if (!line) { showToast('便签是空的，先写点什么'); return; }
    pendingQuickAddText = line.slice(0, 60);        // 快速添加输入框上限 60 字
    openTool('quickadd');
  });
  panel.querySelector('.notes-list-btn').addEventListener('click', () => { notesMode = 'list'; render(); });
  ta.focus();
}

// 便签事项列表态：逐行 ＋ 转换；已转行粗删除线 + 半透明保留可见
function buildNotesList(panel) {
  panel.innerHTML = `
    <div class="notes-toolbar">
      <button type="button" class="notes-btn notes-edit-back">‹ 继续编辑</button>
      <button type="button" class="notes-btn notes-all">全部转事项</button>
    </div>
    <div class="tool-hint">每行一条事项；已转行保留在便签中并标记</div>
    <div class="notes-lines"></div>
  `;
  const box = panel.querySelector('.notes-lines');
  const lines = (localStorage.getItem('quickNotes') || '').split('\n');
  if (!lines.some(l => l.trim())) {
    box.innerHTML = '<div class="empty-hint">便签是空的<br>先在编辑模式写几行内容</div>';
  }
  lines.forEach((raw) => {
    const title = raw.trim();
    if (!title) return;
    const done = !!notesDoneMap[title];
    const row = document.createElement('div');
    row.className = 'notes-line' + (done ? ' done' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notes-line-add';
    btn.textContent = done ? '✓' : '＋';
    btn.title = done ? '已转为事项' : '将此行转为今日事项';
    if (done) btn.disabled = true;
    else btn.addEventListener('click', () => notesConvertLine(title));
    const txt = document.createElement('span');
    txt.className = 'notes-line-text';
    txt.textContent = title;
    row.appendChild(btn);
    row.appendChild(txt);
    if (done) {
      const tag = document.createElement('em');
      tag.className = 'notes-line-tag';
      tag.textContent = '已转事项';
      row.appendChild(tag);
    }
    box.appendChild(row);
  });
  panel.querySelector('.notes-edit-back').addEventListener('click', () => { notesMode = 'edit'; render(); });
  panel.querySelector('.notes-all').addEventListener('click', notesConvertAll);
}

// ============ 桌面工具：天气 / 系统资源 / 剪贴板 ============
// ---- 天气（主进程请求；IP 定位可手改城市；窄条图标直显温度） ----
const WMO = {
  0: ['晴', '☀️'], 1: ['大致晴朗', '🌤️'], 2: ['局部多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['冻雾', '🌫️'],
  51: ['小毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['大毛毛雨', '🌧️'],
  56: ['冻毛毛雨', '🌧️'], 57: ['强冻毛毛雨', '🌧️'],
  61: ['小雨', '🌦️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'], 67: ['强冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['雪粒', '🌨️'],
  80: ['小阵雨', '🌦️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '⛈️'],
  85: ['小阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
  95: ['雷阵雨', '⛈️'], 96: ['雷阵雨伴冰雹', '⛈️'], 99: ['强雷阵雨伴冰雹', '⛈️']
};
let weatherCache = null;             // { name, temp, code, apparent, humidity, wind, at }
let weatherInflight = false;
let weatherPanelUpdater = null;      // 天气面板打开时注册的局部刷新函数（避免全量 render 冲掉输入焦点）

function loadWeatherCity() {
  try { return JSON.parse(localStorage.getItem('weatherCity') || 'null'); } catch { return null; }
}
function saveWeatherCity(c) { localStorage.setItem('weatherCity', JSON.stringify(c)); }

function paintWeatherRail() {
  const sub = $('railWeatherSub');
  const ico = railEl.querySelector('[data-tool="weather"] .ri-ico');
  if (!sub) return;
  if (weatherCache) {
    sub.textContent = Math.round(weatherCache.temp) + '°';
    if (ico) ico.textContent = (WMO[weatherCache.code] || WMO[3])[1];
  } else {
    sub.textContent = '--°';
  }
}

async function refreshWeather() {
  if (!window.timetable || weatherInflight) return;
  weatherInflight = true;
  try {
    let city = loadWeatherCity();
    if (!city) {
      const loc = await window.timetable.weatherIpLocation();
      if (!loc.ok) throw new Error(loc.error || '定位失败');
      city = { name: loc.name, lat: loc.lat, lon: loc.lon, ip: true };
    }
    const w = await window.timetable.weatherQuery(city.lat, city.lon);
    if (!w.ok) throw new Error(w.error || '查询失败');
    const c = w.current;
    weatherCache = {
      name: city.name,
      temp: c.temperature_2m,
      code: c.weather_code,
      apparent: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      at: Date.now()
    };
    paintWeatherRail();
    if (currentTool === 'weather' && weatherPanelUpdater) weatherPanelUpdater();
  } catch (err) {
    const sub = $('railWeatherSub');
    if (sub && !weatherCache) sub.textContent = 'N/A';
    if (currentTool === 'weather') {
      const box = document.querySelector('.weather-body');
      if (box) box.innerHTML = `<div class="empty-hint">天气获取失败：${escapeHtml(String(err.message || err))}<br>可检查网络后点重试，或手动搜索城市</div>`;
    }
  } finally {
    weatherInflight = false;
  }
}

function buildWeather(panel) {
  panel.innerHTML = `
    <div class="weather-body"></div>
    <div class="weather-change">
      <input type="text" class="weather-search-input" maxlength="30" placeholder="输入城市名切换，如：北京" />
      <div class="weather-results"></div>
    </div>
  `;
  const body = panel.querySelector('.weather-body');
  const input = panel.querySelector('.weather-search-input');
  const results = panel.querySelector('.weather-results');

  const renderBody = () => {
    const city = loadWeatherCity();
    if (!weatherCache) {
      body.innerHTML = '<div class="empty-hint">正在获取天气…</div>';
      return;
    }
    const w = weatherCache;
    const [label, emoji] = WMO[w.code] || ['未知', '🌡️'];
    body.innerHTML = `
      <div class="wt-main">
        <span class="wt-emoji">${emoji}</span>
        <span class="wt-temp">${Math.round(w.temp)}°</span>
      </div>
      <div class="wt-desc">${escapeHtml(label)}　体感 ${Math.round(w.apparent)}°</div>
      <div class="wt-city">${escapeHtml(w.name)}${city && city.ip ? '（IP 定位）' : ''}</div>
      <div class="wt-grid">
        <div><span>湿度</span><b>${w.humidity}%</b></div>
        <div><span>风速</span><b>${Math.round(w.wind)} km/h</b></div>
      </div>
      <button class="wt-refresh">刷新</button>
    `;
    body.querySelector('.wt-refresh').addEventListener('click', () => {
      body.innerHTML = '<div class="empty-hint">正在刷新…</div>';
      refreshWeather();
    });
  };
  renderBody();

  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div class="wt-searching">搜索中…</div>';
    searchTimer = setTimeout(async () => {
      if (!window.timetable) return;
      const r = await window.timetable.weatherSearch(q);
      if (!r.ok || !r.results.length) {
        results.innerHTML = '<div class="wt-searching">未找到城市</div>';
        return;
      }
      results.innerHTML = '';
      for (const item of r.results) {
        const b = document.createElement('button');
        b.className = 'wt-city-opt';
        b.textContent = item.name;
        b.addEventListener('click', () => {
          saveWeatherCity({ name: item.name, lat: item.lat, lon: item.lon });
          results.innerHTML = '';
          input.value = '';
          weatherCache = null;
          renderBody();
          refreshWeather();
        });
        results.appendChild(b);
      }
    }, 450);
  });

  // 缓存超过 10 分钟或没有数据时拉取
  if (!weatherCache || Date.now() - weatherCache.at > 10 * 60000) refreshWeather();
  weatherPanelUpdater = renderBody;
}

// ---- 系统资源（窄条直显 CPU；面板实时 2s 刷新） ----
let sysPanelTimer = null;
function paintSysRail(s) {
  const sub = $('railSysSub');
  if (sub && s) sub.textContent = s.cpu + '%';
}
async function pollSysOnce() {
  if (!window.timetable) return;
  try {
    const s = await window.timetable.sysStats();
    if (s.ok) {
      paintSysRail(s);
      if (currentTool === 'sys') renderSysPanel(s);
    }
  } catch { /* 忽略单轮失败 */ }
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor(sec % 86400 / 3600);
  const m = Math.floor(sec % 3600 / 60);
  return (d ? d + '天 ' : '') + (h ? h + '小时 ' : '') + m + '分钟';
}
function sysBar(pct) {
  const cls = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : '';
  return `<div class="sys-bar"><div class="sys-fill ${cls}" style="width:${pct}%"></div></div>`;
}
function renderSysPanel(s) {
  const el = document.querySelector('.sys-body');
  if (!el || !s) return;
  el.innerHTML = `
    <div class="sys-block">
      <div class="sys-row"><span>CPU 使用率（${s.cores} 核）</span><b>${s.cpu}%</b></div>
      ${sysBar(s.cpu)}
    </div>
    <div class="sys-block">
      <div class="sys-row"><span>内存</span><b>${s.memPct}%</b></div>
      ${sysBar(s.memPct)}
      <div class="sys-sub">${s.memUsedGB} / ${s.memTotalGB} GB</div>
    </div>
    <div class="sys-meta">
      <div>开机时长：${fmtUptime(s.uptimeSec)}</div>
      <div>设备：${escapeHtml(s.hostname)}</div>
    </div>
  `;
}
function buildSys(panel) {
  panel.innerHTML = '<div class="sys-body"><div class="empty-hint">正在采样系统资源…</div></div>';
  pollSysOnce();
  if (sysPanelTimer) clearInterval(sysPanelTimer);
  sysPanelTimer = setInterval(pollSysOnce, 2000);
}

// ---- 剪贴板（主进程轮询文本变化并推送；点击条目回填；支持关键词过滤） ----
let clipHistoryCache = [];
let clipFilter = '';

// 统一匹配：大小写不敏感子串（计数与取数共用，避免错位）
function clipMatches(text, q) {
  return !q || text.toLowerCase().includes(q);
}

// 关键词高亮：先按原文切片再逐段转义（避免在转义后的实体上切分）
function clipHighlightHtml(shown, q) {
  if (!q) return escapeHtml(shown);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(shown))) {
    out += escapeHtml(shown.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(shown.slice(last));
}

function renderClipboardPanel() {
  const list = document.querySelector('.clip-list');
  if (!list) return;
  const headCount = document.querySelector('.clip-head .muted');
  const rawQ = clipFilter.trim();
  const q = rawQ.toLowerCase();
  list.innerHTML = '';
  if (!clipHistoryCache.length) {
    if (headCount) headCount.textContent = '最近 0 条文本记录';
    list.innerHTML = '<div class="empty-hint">暂无记录<br>复制任意文本后会自动出现在这里（仅保留最近 30 条）</div>';
    return;
  }
  // 过滤同时保留原始索引（toast 提示真实条目序号）
  const matched = [];
  clipHistoryCache.forEach((text, i) => {
    if (clipMatches(text, q)) matched.push({ text, i });
  });
  if (headCount) {
    headCount.textContent = q
      ? `匹配 ${matched.length} / ${clipHistoryCache.length} 条`
      : `最近 ${clipHistoryCache.length} 条文本记录`;
  }
  if (!matched.length) {
    list.innerHTML = `<div class="empty-hint">没有匹配「${escapeHtml(rawQ)}」的记录</div>`;
    return;
  }
  matched.forEach(({ text, i }) => {
    const item = document.createElement('div');
    item.className = 'clip-item';
    const pre = document.createElement('pre');
    pre.className = 'clip-text';
    const shown = text.length > 300 ? text.slice(0, 300) + '…' : text;
    pre.innerHTML = clipHighlightHtml(shown, q);
    const hint = document.createElement('div');
    hint.className = 'clip-hint';
    hint.textContent = '点击复制回剪贴板';
    const del = document.createElement('button');
    del.className = 'clip-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除该条';
    del.addEventListener('click', (e) => {
      e.stopPropagation();                       // 不触发复制
      if (window.timetable) window.timetable.clipboardDelete(text);
      showToast('已删除第 ' + (i + 1) + ' 条');
    });
    item.appendChild(pre);
    item.appendChild(hint);
    item.appendChild(del);
    item.addEventListener('click', () => {
      if (window.timetable) window.timetable.clipboardCopy(text);
      showToast(`已复制第 ${i + 1} 条`);
    });
    list.appendChild(item);
  });
}
function buildClipboard(panel) {
  clipFilter = '';                 // 每次打开重置过滤（输入框会重建）
  panel.innerHTML = `
    <div class="clip-head">
      <span class="muted">最近 ${clipHistoryCache.length} 条文本记录</span>
      <button class="clip-clear">清空</button>
    </div>
    <div class="clip-search-row">
      <input type="text" class="clip-search" maxlength="40" placeholder="搜索历史记录…" />
      <button type="button" class="clip-search-x" title="清除搜索（Esc）">×</button>
    </div>
    <div class="clip-list"></div>
  `;
  const searchInput = panel.querySelector('.clip-search');
  const searchX = panel.querySelector('.clip-search-x');
  searchX.style.display = 'none';
  searchInput.addEventListener('input', () => {
    clipFilter = searchInput.value;
    searchX.style.display = searchInput.value ? 'block' : 'none';
    renderClipboardPanel();        // 只重建 .clip-list，搜索框焦点不受影响
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      clipFilter = '';
      searchX.style.display = 'none';
      renderClipboardPanel();
      e.preventDefault();
    }
  });
  searchX.addEventListener('click', () => {
    searchInput.value = '';
    clipFilter = '';
    searchX.style.display = 'none';
    renderClipboardPanel();
    searchInput.focus();
  });
  panel.querySelector('.clip-clear').addEventListener('click', () => {
    if (!clipHistoryCache.length) return;
    if (window.timetable) window.timetable.clipboardClear();
    showToast('剪贴板历史已清空');
  });
  if (window.timetable) {
    window.timetable.clipboardList().then((l) => {
      clipHistoryCache = l || [];
      renderClipboardPanel();
    });
  } else {
    renderClipboardPanel();
  }
}
if (window.timetable) {
  window.timetable.onClipboardUpdate((list) => {
    clipHistoryCache = list || [];
    if (currentTool === 'clipboard') renderClipboardPanel();
  });
  // 启动时把本地保存的剪贴板开关同步给主进程（主进程默认开启，需纠正为上次保存的值）
  window.timetable.clipboardEnabled(loadAppSettings().clipboardEnabled !== false);
}

// ---- 设置（应用级配置；appSettings 为唯一存储 key，后续阶段在此追加字段） ----
function loadAppSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('appSettings') || '{}');
    // 语音输入默认配置（预留，默认关闭；实际功能由 voice service 提供）
    return {
      voiceInputEnabled: false,    // 默认关闭语音输入
      speechProvider: 'system',   // 默认使用系统内置识别（隐私优先）
      voiceLanguage: 'zh-CN',      // 默认中文
      hotkeyToggleEnabled: true,   // 全局快捷键：Ctrl+Alt+T 唤出/收起（默认开）
      hotkeyQuickAddEnabled: false, // 全局快捷键：Ctrl+Alt+N 快速添加（默认关，避免打扰）
      reminderToastEnabled: true,  // 应用内提醒条（P4.4，默认开；关闭后到点仅系统通知+响铃）
      autoSyncEnabled: false,      // 定时自动同步（P4.4，默认关；10 分钟间隔，需配合对端在线）
      ...saved                     // 已有设置覆盖默认
    };
  } catch { return {}; }
}
function saveAppSettings(s) {
  localStorage.setItem('appSettings', JSON.stringify(s));
}

// ---- 工具：设备同步（P3.4 局域网同步） ----
// 面板状态（工具页内会话级；关闭工具页即放弃进行中的配对等待）
let syncToolState = { pairing: null, scanning: false, found: [] };
// 会话内同步面板是否打开过（P4.4 自动同步的前提：用户已知晓并启动过同步功能）
let syncToolOpened = false;

function buildSyncTool(panel) {
  syncToolOpened = true;   // P4.4：打开过同步面板，本会话自动同步才生效
  const pairs = loadSyncPairs();
  const myId = getDeviceId();
  // 打开本页即开启同步服务监听（对端可发现并连接；空闲 5 分钟主进程自动关停）
  if (window.timetable && window.timetable.syncListen) {
    window.timetable.syncListen().catch(() => { /* 端口被占等失败不阻塞页面 */ });
  }
  panel.innerHTML = `
    <div class="tool-hint">同一局域网（Wi-Fi）内的两台设备点对点同步；数据全程加密，仅经本机与对端，不上传任何服务器</div>
    <div class="sync-block">
      <div class="sync-block-title">本机设备</div>
      <div class="sync-device-id">${escapeHtml(myId)}</div>
    </div>
    <div class="sync-block">
      <div class="sync-block-title">配对</div>
      <div class="sync-row">
        <button type="button" class="sync-btn sync-wait-btn">等待配对（显示配对码）</button>
        <button type="button" class="sync-btn sync-scan-btn">搜索等待中的设备</button>
      </div>
      <div class="sync-pair-area"></div>
    </div>
    <div class="sync-block">
      <div class="sync-block-title">已配对设备（${pairs.length}）</div>
      <div class="sync-devices"></div>
    </div>
    <div class="sync-block">
      <div class="sync-block-title">同步日志</div>
      <div class="sync-log-slot"></div>
    </div>
  `;
  const pairArea = panel.querySelector('.sync-pair-area');
  const devicesBox = panel.querySelector('.sync-devices');
  const logSlot = panel.querySelector('.sync-log-slot');

  // 日志块复用现有 buildSyncLogBlock
  if (typeof buildSyncLogBlock === 'function') logSlot.appendChild(buildSyncLogBlock());

  // ---- 配对码等待态渲染 ----
  const renderPairArea = () => {
    pairArea.innerHTML = '';
    const st = syncToolState;
    if (st.pairing && st.pairing.waiting) {
      const box = document.createElement('div');
      box.className = 'sync-pair-waiting';
      const left = Math.max(0, Math.round((st.pairing.expiresAt - Date.now()) / 60000));
      box.innerHTML = `
        <div class="sync-code-label">把下面的 6 位配对码输入到另一台设备（约 ${left} 分钟内有效）</div>
        <div class="sync-code">${escapeHtml(st.pairing.code)}</div>
        <div class="sync-code-sub">本机地址：${st.pairing.ips.map(ip => escapeHtml(ip) + ':' + st.pairing.port).join('　') || '—'}</div>
        <button type="button" class="sync-btn sync-cancel-wait">取消等待</button>
      `;
      box.querySelector('.sync-cancel-wait').addEventListener('click', async () => {
        if (window.timetable && window.timetable.syncPairStop) await window.timetable.syncPairStop();
        syncToolState.pairing = null;
        renderPairArea();
        showToast('已取消配对等待');
      });
      pairArea.appendChild(box);
    } else if (st.found && st.found.length) {
      // 发现设备列表：选中后输入配对码
      const box = document.createElement('div');
      box.className = 'sync-found';
      for (const f of st.found) {
        const row = document.createElement('div');
        row.className = 'sync-found-row';
        row.innerHTML = `
          <span class="sync-found-name">${escapeHtml(f.device.name || f.device.deviceId)}</span>
          <span class="sync-found-ip">${escapeHtml(f.ip)}:${f.port}</span>
          <input type="text" class="sync-code-input" maxlength="6" inputmode="numeric" placeholder="6位配对码" title="输入对端屏幕上显示的 6 位配对码" />
          <button type="button" class="sync-btn sync-connect-btn">配对</button>
        `;
        row.querySelector('.sync-connect-btn').addEventListener('click', async () => {
          const code = row.querySelector('.sync-code-input').value.trim();
          if (!/^\d{6}$/.test(code)) { showToast('请输入 6 位数字配对码'); return; }
          const res = await window.timetable.syncPairConnect(f.ip, f.port, code);
          if (res && res.ok) {
            upsertPair(res.peerDevice);
            showToast('配对成功：' + (res.peerDevice.name || res.peerDevice.deviceId));
            syncToolState.found = [];
            render();
          } else {
            showToast('配对失败：' + syncErrText(res && res.error));
          }
        });
        box.appendChild(row);
      }
      pairArea.appendChild(box);
    }
  };

  // ---- 设备列表渲染 ----
  const renderDevices = () => {
    devicesBox.innerHTML = '';
    const list = loadSyncPairs();
    if (!list.length) {
      devicesBox.innerHTML = '<div class="empty-hint">— 暂无已配对设备 —</div>';
      return;
    }
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'sync-device-row';
      row.innerHTML = `
        <span class="sync-device-name" title="${escapeHtml(p.deviceId)}">${escapeHtml(p.name || p.deviceId)}</span>
        <span class="sync-device-meta">${escapeHtml(p.platform || '')}</span>
        <input type="text" class="sync-ip-input" placeholder="IP（留空自动）" title="对端 IP；留空则用上次地址或同网段搜索" value="${escapeHtml(p.lastIp || '')}" />
        <button type="button" class="sync-btn sync-now-btn">立即同步</button>
        <button type="button" class="sync-btn danger sync-unpair-btn" title="解除配对（删除双方密钥）">解绑</button>
      `;
      row.querySelector('.sync-now-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '同步中…';
        try {
          const ipInput = row.querySelector('.sync-ip-input').value.trim();
          await doSyncNow(p, ipInput);
        } finally {
          btn.disabled = false;
          btn.textContent = '立即同步';
        }
      });
      row.querySelector('.sync-unpair-btn').addEventListener('click', () => {
        if (!confirm(`解除与「${p.name || p.deviceId}」的配对？\n双方密钥将被删除，需重新配对才能再同步。`)) return;
        if (window.timetable && window.timetable.syncUnpair) window.timetable.syncUnpair(p.deviceId);
        saveSyncPairs(loadSyncPairs().filter(x => x.deviceId !== p.deviceId));
        addSyncLog('unpair', { detail: `解绑设备「${p.name || p.deviceId}」` });
        render();
      });
      devicesBox.appendChild(row);
    }
  };

  // ---- 配对等待（A 侧） ----
  panel.querySelector('.sync-wait-btn').addEventListener('click', async () => {
    if (!window.timetable || !window.timetable.syncPairStart) return;
    const res = await window.timetable.syncPairStart();
    if (res && res.ok) {
      syncToolState.pairing = { waiting: true, code: res.code, port: res.port, ips: res.ips || [], expiresAt: res.expiresAt };
      renderPairArea();
      showToast('等待配对中，请在另一台设备输入配对码');
    } else {
      showToast('无法启动配对服务：' + syncErrText(res && res.error));
    }
  });
  // A 侧配对成功推送：主进程 → 渲染层
  if (window.timetable && window.timetable.onSyncPaired && !buildSyncTool._pairedBound) {
    buildSyncTool._pairedBound = true;
    window.timetable.onSyncPaired((info) => {
      if (!info || !info.peerDevice) return;
      upsertPair(info.peerDevice);
      syncToolState.pairing = null;
      addSyncLog('paired', { detail: `与「${info.peerDevice.name || info.peerDevice.deviceId}」完成配对` });
      showToast('配对成功：' + (info.peerDevice.name || info.peerDevice.deviceId));
      render();
    });
  }

  // ---- 搜索等待中的设备（B 侧） ----
  panel.querySelector('.sync-scan-btn').addEventListener('click', async () => {
    if (!window.timetable || !window.timetable.syncPairScan) return;
    syncToolState.found = [];
    renderPairArea();
    showToast('正在搜索同网段等待配对的设备…');
    const found = await window.timetable.syncPairScan();
    if (found && found.length) {
      syncToolState.found = found;
      renderPairArea();
    } else {
      showToast('未发现等待中的设备；可在对端点「等待配对」，本机再搜索，或手动输入 IP');
      // 手动输入兜底
      const box = document.createElement('div');
      box.className = 'sync-found';
      const row = document.createElement('div');
      row.className = 'sync-found-row';
      row.innerHTML = `
        <input type="text" class="sync-manual-ip" placeholder="对端IP:端口" title="如 192.168.1.5:47812" />
        <input type="text" class="sync-code-input" maxlength="6" inputmode="numeric" placeholder="6位配对码" />
        <button type="button" class="sync-btn sync-manual-btn">配对</button>
      `;
      row.querySelector('.sync-manual-btn').addEventListener('click', async () => {
        const addr = row.querySelector('.sync-manual-ip').value.trim();
        const m = addr.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);
        const code = row.querySelector('.sync-code-input').value.trim();
        if (!m) { showToast('地址格式应为 IP:端口'); return; }
        if (!/^\d{6}$/.test(code)) { showToast('请输入 6 位数字配对码'); return; }
        const res = await window.timetable.syncPairConnect(m[1], Number(m[2]), code);
        if (res && res.ok) {
          upsertPair(res.peerDevice, m[1]);
          showToast('配对成功：' + (res.peerDevice.name || res.peerDevice.deviceId));
          render();
        } else {
          showToast('配对失败：' + syncErrText(res && res.error));
        }
      });
      pairArea.innerHTML = '';
      pairArea.appendChild(box).appendChild(row);
    }
  });

  renderPairArea();
  renderDevices();
}

// 配对成功/地址学习后写入或更新设备记录
function upsertPair(peerDevice, ip) {
  if (!peerDevice || !peerDevice.deviceId) return;
  const list = loadSyncPairs();
  const cur = list.find(x => x.deviceId === peerDevice.deviceId);
  if (cur) {
    cur.name = peerDevice.name || cur.name;
    cur.platform = peerDevice.platform || cur.platform;
    if (ip) cur.lastIp = ip;
  } else {
    list.push({
      deviceId: peerDevice.deviceId,
      name: peerDevice.name || peerDevice.deviceId,
      platform: peerDevice.platform || '',
      pairedAt: new Date().toISOString(),
      lastIp: ip || '',
      status: 'active'
    });
  }
  saveSyncPairs(list);
}

// 同步错误码 → 用户可读文案
function syncErrText(err) {
  const s = String(err || '未知错误');
  if (s.includes('pair_code_wrong')) return '配对码错误';
  if (s.includes('pair_code_expired')) return '配对码已过期，请在对端重新点「等待配对」';
  if (s.includes('connect_timeout') || s.includes('connect_failed')) return '连不上对端（不在线/不在同一网络/防火墙拦截）';
  if (s.includes('unknown_peer') || s.includes('no_secret')) return '对端未配对或密钥已失效，请重新配对';
  if (s.includes('decrypt')) return '数据校验失败（密钥不匹配）';
  return s;
}

// 发起一次完整同步：hello → 发本机快照 → 收对端快照 → 合并应用
async function doSyncNow(pair, ipInput) {
  if (!window.timetable || !window.timetable.syncSend) { showToast('同步接口不可用'); return; }
  // 1) 确定对端地址：UDP 发现（配对/同步服务均有应答）→ 手动输入 > 上次地址
  let ip = ipInput || '';
  let port = 0;
  if (!ip) {
    const found = await window.timetable.syncPairScan();
    const hit = (found || []).find(f => f.device && f.device.deviceId === pair.deviceId);
    if (hit) { ip = hit.ip; port = hit.port; }
    else if (pair.lastIp) { ip = pair.lastIp; }   // 发现不到再试上次地址（端口仍需发现）
  }
  if (!ip || !port) {
    showToast('找不到对端：请让对端打开「设备同步」页，或手动输入其 IP 后重试');
    return;
  }
  // 2) 组装本机快照 → 发送 → 收回对端（已合并的）快照
  const mySnap = buildSyncSnapshot();
  const res = await window.timetable.syncSend({ ip, port, peerDeviceId: pair.deviceId, snapshot: mySnap });
  if (!res || !res.ok) { showToast('同步失败：' + syncErrText(res && res.error)); return; }
  // 3) 合并并应用（两端各自执行同一规则，结果收敛）
  const merged = mergeSyncData(buildSyncSnapshot(), res.data || {});
  applyMergedData(merged, pair.name);
  // 地址学习：本次成功的地址写回设备记录，下次免搜索
  if (ip && ip !== pair.lastIp) {
    const list = loadSyncPairs();
    const cur = list.find(x => x.deviceId === pair.deviceId);
    if (cur) { cur.lastIp = ip; saveSyncPairs(list); }
  }
  showToast(`同步完成：事项 +${merged.stats.events.added}/更新 ${merged.stats.events.updated}/删除 ${merged.stats.events.deleted}`);
}

// ---- 定时自动同步（P4.4）：默认关；10 分钟固定间隔；全程静默（不弹 toast） ----
// 生效前提 autoSyncEligible：开关开 + 会话内打开过同步面板（或在设置中开启）+ 窗口可见 + 有已配对设备
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
function autoSyncEligible(settings, ctx) {
  if (!settings || settings.autoSyncEnabled !== true) return false;
  if (!ctx || !ctx.opened || ctx.paused) return false;
  return Array.isArray(ctx.pairs) && ctx.pairs.length > 0;
}
let autoSyncRunning = false;    // 防重入：上一轮未完成时跳过本轮
const autoSyncFailCount = {};   // deviceId → 连续失败次数（每满 3 次写一条日志后清零）
// 单设备静默同步：复用 doSyncNow 的发现/合并/地址学习逻辑，去掉 UI 交互
async function autoSyncDevice(pair) {
  if (!window.timetable || !window.timetable.syncSend) return;
  // 发现对端：UDP 扫描 → lastIp 兜底（端口需发现获得，兜底通常失败，静默跳过）
  let ip = '', port = 0;
  try {
    const found = await window.timetable.syncPairScan();
    const hit = (found || []).find(f => f.device && f.device.deviceId === pair.deviceId);
    if (hit) { ip = hit.ip; port = hit.port; }
    else if (pair.lastIp) { ip = pair.lastIp; }
  } catch { return; }
  if (!ip || !port) return;
  try {
    const res = await window.timetable.syncSend({ ip, port, peerDeviceId: pair.deviceId, snapshot: buildSyncSnapshot() });
    if (!res || !res.ok) throw new Error(syncErrText(res && res.error));
    const merged = mergeSyncData(buildSyncSnapshot(), res.data || {});
    applyMergedData(merged, pair.name);
    // 地址学习：成功地址写回设备记录，下次免搜索
    if (ip !== pair.lastIp) {
      const list = loadSyncPairs();
      const cur = list.find(x => x.deviceId === pair.deviceId);
      if (cur) { cur.lastIp = ip; saveSyncPairs(list); }
    }
    autoSyncFailCount[pair.deviceId] = 0;
    // 有实际变更才写日志（无变化不记，避免 10 分钟一条刷掉导入导出记录）
    if (merged.stats && merged.stats.events && (merged.stats.events.added + merged.stats.events.updated + merged.stats.events.deleted) > 0) {
      addSyncLog('auto-sync', { pname: pair.name || '', detail: `事项 +${merged.stats.events.added}/更新 ${merged.stats.events.updated}/删除 ${merged.stats.events.deleted}` });
    }
  } catch (e) {
    // 失败静默：连续满 3 次写一条日志提示，随后清零重新计数
    const n = (autoSyncFailCount[pair.deviceId] || 0) + 1;
    if (n >= 3) {
      autoSyncFailCount[pair.deviceId] = 0;
      addSyncLog('auto-sync-fail', { pname: pair.name || '', detail: String((e && e.message) || e) });
    } else {
      autoSyncFailCount[pair.deviceId] = n;
    }
  }
}
// 调度 tick：窗口隐藏时暂停（windowVisible 由 onWindowVisible 维护），防止后台空转
async function autoSyncTick() {
  if (autoSyncRunning) return;
  const pairs = loadSyncPairs();
  if (!autoSyncEligible(loadAppSettings(), { opened: syncToolOpened, paused: !windowVisible, pairs })) return;
  autoSyncRunning = true;
  try {
    for (const pair of pairs) { await autoSyncDevice(pair); }
  } finally { autoSyncRunning = false; }
}

// 服务侧：被对端连接时，主进程把对端快照转来 → 本地合并 → 回包本地（合并后）快照
// 结果：双向收敛到同一份数据（两端各执行一次同规则合并）
if (window.timetable && window.timetable.onSyncExchangeRequest) {
  window.timetable.onSyncExchangeRequest((req) => {
    try {
      const remote = (req && req.snapshot) || {};
      const merged = mergeSyncData(buildSyncSnapshot(), remote);
      applyMergedData(merged, (loadSyncPairs().find(x => x.deviceId === req.peerDeviceId) || {}).name);
      // 回包「合并后的本地快照」，发起方再合并一次即收敛
      window.timetable.syncExchangeRespond(buildSyncSnapshot());
    } catch (e) {
      window.timetable.syncExchangeRespond({});   // 异常兜底：不挂死对端
    }
  });
}

// ============ 外观主题（P4.1）：暗色默认 / 亮色 body.light + 强调色色板 ============
// 强调色三件套（--accent / --accent-rgb / --accent-txt）注入 documentElement，两主题通用
const ACCENT_PALETTE = [
  { id: 'blue',   accent: '#4a90d9', accentRgb: '74, 144, 217',  light: '#8fc1ee' },
  { id: 'teal',   accent: '#3aa8a0', accentRgb: '58, 168, 160',  light: '#8fd8d2' },
  { id: 'purple', accent: '#9b7ede', accentRgb: '155, 126, 222', light: '#c9b8f2' },
  { id: 'orange', accent: '#e08e3c', accentRgb: '224, 142, 60',  light: '#f2c290' },
  { id: 'green',  accent: '#5cab5e', accentRgb: '92, 171, 94',   light: '#a8dcaa' }
];
function loadUiTheme() {
  try {
    const o = JSON.parse(localStorage.getItem('uiTheme') || '{}');
    return {
      mode: o.mode === 'light' ? 'light' : 'dark',
      accent: ACCENT_PALETTE.some(p => p.id === o.accent) ? o.accent : 'blue'
    };
  } catch { return { mode: 'dark', accent: 'blue' }; }
}
function applyUiTheme() {
  const t = loadUiTheme();
  document.body.classList.toggle('light', t.mode === 'light');
  const p = ACCENT_PALETTE.find(x => x.id === t.accent) || ACCENT_PALETTE[0];
  const rs = document.documentElement.style;
  rs.setProperty('--accent', p.accent);
  rs.setProperty('--accent-rgb', p.accentRgb);
  rs.setProperty('--accent-txt', p.light);
}
function saveUiTheme(patch) {
  const t = Object.assign(loadUiTheme(), patch);
  if (!ACCENT_PALETTE.some(p => p.id === t.accent)) t.accent = 'blue';   // 写入前校验，防任意值入库
  try { localStorage.setItem('uiTheme', JSON.stringify(t)); } catch { /* 存储满则仅本次生效 */ }
  applyUiTheme();
}

function buildSettings(panel) {
  panel.innerHTML = `
    <div class="set-group">
      <div class="set-group-title">侧边栏</div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">停靠位置</span>
          <span class="set-desc">贴附在屏幕的哪一侧</span>
        </span>
        <span class="set-seg">
          <button type="button" class="seg-btn" data-side="left">左侧</button>
          <button type="button" class="seg-btn" data-side="right">右侧</button>
        </span>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">显示模式</span>
          <span class="set-desc">隐藏模式下鼠标贴边停留唤出</span>
        </span>
        <select class="set-mode" title="显示模式">
          <option value="rail">常驻窄条</option>
          <option value="mini">迷你 Dock（半高）</option>
          <option value="hidden">完全隐藏</option>
        </select>
      </div>
    </div>
    <div class="set-group">
      <div class="set-group-title">外观</div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">主题</span>
          <span class="set-desc">亮色 / 暗色，切换即时生效</span>
        </span>
        <span class="set-seg">
          <button type="button" class="seg-btn theme-mode-btn" data-mode="dark">暗色</button>
          <button type="button" class="seg-btn theme-mode-btn" data-mode="light">亮色</button>
        </span>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">强调色</span>
          <span class="set-desc">按钮、选中态的主色调</span>
        </span>
        <span class="accent-dots" id="accentDots"></span>
      </div>
    </div>
    <div class="set-group">
      <div class="set-group-title">通用</div>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">开机自动启动</span>
          <span class="set-desc">登录系统后自动运行日程侧边栏</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-autostart-input"><span class="set-slider"></span></span>
      </label>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">剪贴板历史</span>
          <span class="set-desc">自动记录复制的文本，仅保存在本机（最近 30 条）</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-clip-input"><span class="set-slider"></span></span>
      </label>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">语音输入</span>
          <span class="set-desc">事项标题旁显示麦克风按钮，使用 Windows 内置识别（离线，仅本机）</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-voice-input"><span class="set-slider"></span></span>
      </label>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">应用内提醒条</span>
          <span class="set-desc">到点提醒时侧边栏底部显示提醒条（含完成/稍后按钮）；关闭后仅系统通知</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-remind-toast"><span class="set-slider"></span></span>
      </label>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">快捷键唤出侧边栏</span>
          <span class="set-desc">Ctrl+Alt+T 唤出/收起，任何应用前台时全局生效</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-hotkey-toggle" title="Ctrl+Alt+T 唤出/收起侧边栏"><span class="set-slider"></span></span>
      </label>
      <label class="set-row">
        <span class="set-text">
          <span class="set-name">快捷键快速添加</span>
          <span class="set-desc">Ctrl+Alt+N 直接打开快速添加并聚焦（默认关闭）</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-hotkey-qa" title="Ctrl+Alt+N 打开快速添加"><span class="set-slider"></span></span>
      </label>
    </div>
    <div class="set-group">
      <div class="set-group-title">数据与备份</div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">数据目录</span>
          <span class="set-desc" id="dataDirPath">读取中…</span>
        </span>
        <button type="button" class="set-btn" id="dataDirMigrateBtn">迁移…</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">导出设置</span>
          <span class="set-desc">偏好、番茄钟、排序等设备本地设置</span>
        </span>
        <button type="button" class="set-btn" data-backup="settings">导出</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">导出业务数据</span>
          <span class="set-desc">项目、事项、便签等（不含本机偏好）</span>
        </span>
        <button type="button" class="set-btn" data-backup="business">导出</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">完整备份</span>
          <span class="set-desc">业务数据 + 设置 + 剪贴板/UI 配置</span>
        </span>
        <button type="button" class="set-btn" data-backup="full">备份</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">导入备份</span>
          <span class="set-desc">从 .ttbk 文件恢复（有冲突检测）</span>
        </span>
        <button type="button" class="set-btn" id="backupImportBtn">导入</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">导出日历 (.ics)</span>
          <span class="set-desc">全部事项导出为 iCal 日历文件，可导入日历软件</span>
        </span>
        <button type="button" class="set-btn" id="icalExportBtn">导出</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">导入日历 (.ics)</span>
          <span class="set-desc">从 iCal 文件导入事项（先预览勾选）</span>
        </span>
        <button type="button" class="set-btn" id="icalImportBtn">导入</button>
      </div>
    </div>
    <div class="set-group">
      <div class="set-group-title">设备同步</div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">本机设备 ID</span>
          <span class="set-desc" id="deviceIdDisplay">—</span>
        </span>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">局域网同步</span>
          <span class="set-desc">与同网络设备点对点同步项目与事项（加密，不上传服务器）</span>
        </span>
        <button type="button" class="set-btn" id="syncPairBtn">打开设备同步</button>
      </div>
      <div class="set-row">
        <span class="set-text">
          <span class="set-name">自动同步</span>
          <span class="set-desc">每 10 分钟与已配对设备静默同步（窗口隐藏时暂停；需本会话打开过设备同步页）</span>
        </span>
        <span class="set-switch"><input type="checkbox" class="set-autosync-input"><span class="set-slider"></span></span>
      </div>
    </div>
    <div class="set-about" id="setAbout">日程侧边栏<br>所有数据仅保存在本机</div>
  `;

  // 剪贴板历史开关（关 = 暂停记录，不清空已有历史）
  const clipSwitch = panel.querySelector('.set-clip-input');
  const st = loadAppSettings();
  clipSwitch.checked = st.clipboardEnabled !== false;   // 默认开
  clipSwitch.addEventListener('change', () => {
    const s = loadAppSettings();
    s.clipboardEnabled = clipSwitch.checked;
    saveAppSettings(s);
    if (window.timetable) window.timetable.clipboardEnabled(clipSwitch.checked);
    showToast(clipSwitch.checked ? '剪贴板历史已开启' : '剪贴板历史已暂停');
  });

  // 语音输入开关（默认关；切换即时生效到所有已存在的表单麦克风按钮）
  const voiceSwitch = panel.querySelector('.set-voice-input');
  voiceSwitch.checked = st.voiceInputEnabled === true;
  voiceSwitch.addEventListener('change', () => {
    const s = loadAppSettings();
    s.voiceInputEnabled = voiceSwitch.checked;
    saveAppSettings(s);
    // 立即更新所有已存在的麦克风按钮显隐
    weekList.querySelectorAll('.ev-voice-btn').forEach(btn => { btn.hidden = !voiceSwitch.checked; });
    showToast(voiceSwitch.checked ? '语音输入已开启（仅 Windows 内置识别）' : '语音输入已关闭');
  });

  // 应用内提醒条开关（默认开；关闭后到点仅系统通知 + 响铃）
  const remindToastSwitch = panel.querySelector('.set-remind-toast');
  if (remindToastSwitch) {
    remindToastSwitch.checked = st.reminderToastEnabled !== false;
    remindToastSwitch.addEventListener('change', () => {
      const s = loadAppSettings();
      s.reminderToastEnabled = remindToastSwitch.checked;
      saveAppSettings(s);
      showToast(remindToastSwitch.checked ? '应用内提醒条已开启' : '应用内提醒条已关闭（保留系统通知）');
    });
  }

  // 全局快捷键开关（注册失败时主进程降级并回传实际生效状态，这里据此修正 UI 与存储）
  const hkToggle = panel.querySelector('.set-hotkey-toggle');
  const hkQa = panel.querySelector('.set-hotkey-qa');
  if (hkToggle && hkQa) {
    hkToggle.checked = st.hotkeyToggleEnabled !== false;
    hkQa.checked = st.hotkeyQuickAddEnabled === true;
    const syncHotkeys = async () => {
      if (!window.timetable || !window.timetable.hotkeySet) return;
      try {
        const res = await window.timetable.hotkeySet({ toggle: hkToggle.checked, quickadd: hkQa.checked });
        const a = (res && res.active) || {};
        for (const [chk, storeKey, activeKey, name] of [
          [hkToggle, 'hotkeyToggleEnabled', 'toggle', '唤出快捷键'],
          [hkQa, 'hotkeyQuickAddEnabled', 'quickadd', '快速添加快捷键']
        ]) {
          if (a[activeKey] !== undefined && a[activeKey] !== chk.checked) {
            chk.checked = !!a[activeKey];   // 注册失败降级
            const s = loadAppSettings(); s[storeKey] = chk.checked; saveAppSettings(s);
            showToast(`${name}注册失败（可能被其他程序占用），已自动关闭`);
          }
        }
      } catch { /* 主进程不支持时静默 */ }
    };
    hkToggle.addEventListener('change', () => {
      const s = loadAppSettings(); s.hotkeyToggleEnabled = hkToggle.checked; saveAppSettings(s);
      syncHotkeys();
      showToast(hkToggle.checked ? '唤出快捷键已开启（Ctrl+Alt+T）' : '唤出快捷键已关闭');
    });
    hkQa.addEventListener('change', () => {
      const s = loadAppSettings(); s.hotkeyQuickAddEnabled = hkQa.checked; saveAppSettings(s);
      syncHotkeys();
      showToast(hkQa.checked ? '快速添加快捷键已开启（Ctrl+Alt+N）' : '快速添加快捷键已关闭');
    });
  }

  // 开机自动启动（状态实时读系统，避免与注册表/登录项不一致）
  const autoSwitch = panel.querySelector('.set-autostart-input');
  autoSwitch.checked = false;
  if (window.timetable && window.timetable.autostartGet) {
    window.timetable.autostartGet().then(on => { autoSwitch.checked = !!on; });
  }
  autoSwitch.addEventListener('change', () => {
    if (window.timetable) window.timetable.autostartSet(autoSwitch.checked);
    showToast(autoSwitch.checked ? '已开启开机自动启动' : '已关闭开机自动启动');
  });

  // ---- 外观：主题亮暗 + 强调色色板（saveUiTheme 内部即时生效并持久化） ----
  const themeT = loadUiTheme();
  const themeBtns = panel.querySelectorAll('.theme-mode-btn');
  themeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === themeT.mode);
    btn.addEventListener('click', () => {
      saveUiTheme({ mode: btn.dataset.mode });
      themeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === btn.dataset.mode));
    });
  });
  const dotsWrap = panel.querySelector('#accentDots');
  if (dotsWrap) {
    ACCENT_PALETTE.forEach(p => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'accent-dot' + (p.id === themeT.accent ? ' active' : '');
      dot.style.background = p.accent;
      dot.title = p.id;
      dot.setAttribute('aria-label', '强调色 ' + p.id);
      dot.addEventListener('click', () => {
        saveUiTheme({ accent: p.id });
        dotsWrap.querySelectorAll('.accent-dot').forEach(d => d.classList.toggle('active', d === dot));
      });
      dotsWrap.appendChild(dot);
    });
  }

  // ---- 侧边栏：停靠位置 / 显示模式（主进程持有配置，切换即时生效） ----
  const sideBtns = panel.querySelectorAll('.seg-btn[data-side]');
  const modeSel = panel.querySelector('.set-mode');
  const applyCfg = (cfg) => {
    if (!cfg) return;
    sideBtns.forEach(b => b.classList.toggle('active', b.dataset.side === cfg.side));
    modeSel.value = cfg.mode || 'rail';
  };
  if (window.timetable && window.timetable.uiConfigGet) {
    window.timetable.uiConfigGet().then(applyCfg).catch(() => { /* 保持默认 */ });
  }
  sideBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.side;
      sideBtns.forEach(b => b.classList.toggle('active', b === btn));
      if (window.timetable && window.timetable.uiConfigSet) {
        window.timetable.uiConfigSet({ side });
      }
    });
  });
  modeSel.addEventListener('change', () => {
    if (window.timetable && window.timetable.uiConfigSet) {
      window.timetable.uiConfigSet({ mode: modeSel.value });
    }
    const labels = { rail: '常驻窄条', mini: '迷你 Dock', hidden: '完全隐藏' };
    showToast('显示模式：' + (labels[modeSel.value] || modeSel.value));
  });

  // 应用版本号（主进程读取 package.json）
  const aboutEl = panel.querySelector('#setAbout');
  if (aboutEl && window.timetable && window.timetable.appVersion) {
    window.timetable.appVersion().then(v => {
      if (v) aboutEl.innerHTML = `日程侧边栏 v${escapeHtml(v)}<br>所有数据仅保存在本机`;
    }).catch(() => { /* 版本读取失败时保持纯文本 */ });
  }

  // ---- 数据目录：显示当前路径 + 迁移 ----
  const dataDirPathEl = panel.querySelector('#dataDirPath');
  const dataDirMigrateBtn = panel.querySelector('#dataDirMigrateBtn');
  if (window.timetable && window.timetable.dataDirGet) {
    window.timetable.dataDirGet().then(d => {
      if (dataDirPathEl && d && d.current) dataDirPathEl.textContent = d.current;
    }).catch(() => { if (dataDirPathEl) dataDirPathEl.textContent = '读取失败'; });
  }
  if (dataDirMigrateBtn && window.timetable && window.timetable.dataDirMigrate) {
    dataDirMigrateBtn.addEventListener('click', async () => {
      if (!confirm('迁移数据目录会将所有数据复制到新位置，完成后需要重启应用。是否继续？')) return;
      dataDirMigrateBtn.disabled = true;
      dataDirMigrateBtn.textContent = '打包中…';
      try {
        const backup = window.Backup.buildLocalStorageBackup();
        const res = await window.timetable.dataDirMigrate(backup);
        if (res && res.ok) {
          showToast('数据目录已切换，重启后生效');
          setTimeout(() => {
            if (confirm('数据目录迁移完成，是否立即重启应用？')) {
              window.location.reload();
            }
          }, 600);
        } else if (res && res.error) {
          showToast('迁移失败：' + res.error);
        } else if (res && res.canceled) {
          /* 用户取消 */
        }
      } catch (e) {
        showToast('迁移失败：' + (e && e.message || e));
      } finally {
        dataDirMigrateBtn.disabled = false;
        dataDirMigrateBtn.textContent = '迁移…';
      }
    });
  }

  // ---- 备份导出（settings / business / full） ----
  const backupBtns = panel.querySelectorAll('[data-backup]');
  backupBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.backup;
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '打包…';
      try {
        let mainFiles = null;
        if (type === 'full' && window.timetable && window.timetable.backupGetMainFiles) {
          mainFiles = await window.timetable.backupGetMainFiles();
        }
        let appVer = 'unknown';
        if (window.timetable && window.timetable.appVersion) {
          try { appVer = await window.timetable.appVersion() || 'unknown'; } catch {}
        }
        const data = window.Backup.buildBackup(type, mainFiles, appVer);
        const content = JSON.stringify(data, null, 2);
        const stamp = new Date().toISOString().slice(0, 10);
        const name = `timetable-${type}-${stamp}.ttbk`;
        const res = await window.timetable.backupExportDialog(name, content);
        if (res && res.ok) {
          showToast('已导出到：' + res.path.split(/[\\/]/).slice(-1)[0]);
        } else if (res && res.error) {
          showToast('导出失败：' + res.error);
        }
      } catch (e) {
        showToast('导出失败：' + (e && e.message || e));
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });
  });

  // ---- 备份导入（含冲突检测） ----
  const backupImportBtn = panel.querySelector('#backupImportBtn');
  if (backupImportBtn && window.timetable && window.timetable.backupImportDialog) {
    backupImportBtn.addEventListener('click', async () => {
      const oldText = backupImportBtn.textContent;
      backupImportBtn.disabled = true;
      backupImportBtn.textContent = '读取中…';
      try {
        const res = await window.timetable.backupImportDialog();
        if (!res || !res.ok) {
          if (res && res.error) showToast('读取失败：' + res.error);
          return;
        }
        let data;
        try { data = JSON.parse(res.content); }
        catch { showToast('备份文件格式损坏（JSON 解析失败）'); return; }
        const v = window.Backup.validateBackup(data);
        if (!v.ok) { showToast(v.error); return; }

        if (data.type === 'full') {
          if (!confirm('完整备份将覆盖当前所有数据（项目、事项、设置等），此操作不可撤销。是否继续？')) return;
          window.Backup.applyFullReplace(data);
          if (data.mainFiles && window.timetable && window.timetable.backupSetMainFiles) {
            await window.timetable.backupSetMainFiles(data.mainFiles);
          }
          showToast('完整备份已恢复，正在刷新…');
          setTimeout(() => { render(); window.location.reload(); }, 400);
          return;
        }

        // settings / business：冲突检测
        const plan = window.Backup.planImportConflicts(data);
        let projectMode = 'overwrite', eventMode = 'overwrite';
        const pj = plan.projects, ev = plan.events;
        if (pj && pj.conflicts) {
          const a = confirm(`项目有 ${pj.conflicts} 条 ID 冲突。\n点击「确定」=覆盖本地，「取消」=保留两者（导入项加后缀）。\n（如需跳过冲突项请在导入前手动处理）`);
          projectMode = a ? 'overwrite' : 'keep';
        }
        if (ev && ev.conflicts) {
          const a = confirm(`事项有 ${ev.conflicts} 条 ID 冲突。\n点击「确定」=覆盖本地，「取消」=保留两者（导入项加后缀）。`);
          eventMode = a ? 'overwrite' : 'keep';
        }
        const ret = window.Backup.applyImport(data, { projectMode, eventMode });
        showToast('导入完成：' + (ret.logs.length ? ret.logs[0] : '无变化'));
        render();
      } catch (e) {
        showToast('导入失败：' + (e && e.message || e));
      } finally {
        backupImportBtn.disabled = false;
        backupImportBtn.textContent = oldText;
      }
    });
  }

  // ---- iCal 导出/导入（P4.3） ----
  const icalExportBtn = panel.querySelector('#icalExportBtn');
  if (icalExportBtn) {
    icalExportBtn.addEventListener('click', async () => {
      const oldText = icalExportBtn.textContent;
      icalExportBtn.disabled = true;
      icalExportBtn.textContent = '导出中…';
      try {
        const ics = eventsToIcs(loadEvents());
        const stamp = dateKey(today()).replace(/-/g, '');
        const res = await window.timetable.icalExportDialog(`日程导出-${stamp}.ics`, ics);
        if (res && res.ok) {
          showToast('已导出到：' + res.path.split(/[\\/]/).slice(-1)[0]);
        } else if (res && res.error) {
          showToast('导出失败：' + res.error);
        }
      } catch (e) {
        showToast('导出失败：' + (e && e.message || e));
      } finally {
        icalExportBtn.disabled = false;
        icalExportBtn.textContent = oldText;
      }
    });
  }
  const icalImportBtn = panel.querySelector('#icalImportBtn');
  if (icalImportBtn) {
    icalImportBtn.addEventListener('click', async () => {
      try {
        if (!window.timetable || !window.timetable.icalImportDialog) return;
        const res = await window.timetable.icalImportDialog();
        if (!res || !res.ok) {
          if (res && res.error) showToast('读取失败：' + res.error);
          return;
        }
        const parsed = parseIcs(res.content);
        if (!parsed.length) { showToast('未在文件中找到可导入的事项'); return; }
        const existing = loadEvents();
        icalImportItems = parsed.map(ev => ({
          ev,
          checked: true,
          dup: existing.some(e => (e.title || '') === ev.title && eventStart(e) === ev.startDate && (e.time || '') === ev.time)
        }));
        openTool('ical');   // 进入预览面板
      } catch (e) {
        showToast('读取失败：' + (e && e.message || e));
      }
    });
  }

  // ---- 设备同步：显示 deviceId，按钮跳转同步工具页 ----
  const deviceIdEl = panel.querySelector('#deviceIdDisplay');
  if (deviceIdEl) deviceIdEl.textContent = getDeviceId();
  const syncPairBtn = panel.querySelector('#syncPairBtn');
  if (syncPairBtn) {
    syncPairBtn.addEventListener('click', () => openTool('sync'));
  }

  // 自动同步开关（默认关；开启视为已知晓同步功能，本会话自动同步即生效）
  const autosyncSwitch = panel.querySelector('.set-autosync-input');
  if (autosyncSwitch) {
    autosyncSwitch.checked = st.autoSyncEnabled === true;
    autosyncSwitch.addEventListener('change', () => {
      const s = loadAppSettings();
      s.autoSyncEnabled = autosyncSwitch.checked;
      saveAppSettings(s);
      if (autosyncSwitch.checked) syncToolOpened = true;
      showToast(autosyncSwitch.checked ? '自动同步已开启（每 10 分钟）' : '自动同步已关闭');
    });
  }
}

// ============ 右键上下文菜单 ============
const ctxItems = $('ctxItems');
const ctxDatePicker = $('ctxDatePicker');
const dpLabel = $('dpLabel');
const dpInput = $('dpInput');
const dpConfirm = $('dpConfirm');
const dpCancel = $('dpCancel');
const ctxProjectPicker = $('ctxProjectPicker');
const ppLabel = $('ppLabel');
const ppList = $('ppList');

// 待执行的日期/项目选择回调
let pendingDateAction = null;
let pendingProjectAction = null;

document.addEventListener('contextmenu', (e) => {
  // 便签编辑框：有选区时给「将选中文字转为事项」；无选区时保留浏览器原生右键菜单
  if (e.target.classList && e.target.classList.contains('notes-area')) {
    const ta = e.target;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    if (!sel || !sidebar.classList.contains('expanded')) return;
    e.preventDefault();
    showItems(e.clientX, e.clientY);
    ctxItems.innerHTML = `<div class="ctx-item" data-action="notesSel">将选中文字转为事项</div>`;
    bindItemHandlers({ notesSel: () => notesSelectionToEvent(ta) });
    return;
  }
  e.preventDefault();
  if (!sidebar.classList.contains('expanded')) return;
  if (ctxMenu.contains(e.target)) return;

  const projectCard = e.target.closest('.project-card, .project-info');
  const eventItem = e.target.closest('.event-item');
  const ganttEl = e.target.closest('[data-gantt-id]');   // 甘特图时间条/事项名
  const monthEv = e.target.closest('.month-ev');         // 月历事项条（P6.1）
  const monthCell = e.target.closest('.month-cell');     // 月历格子空白区（P6.1）
  const card = e.target.closest('.day-card');
  const targetDate = card ? card.dataset.date : dateKey(today());

  if (projectCard && projectCard.dataset.id) {
    showProjectMenu(e.clientX, e.clientY, projectCard.dataset.id);
  } else if (ganttEl && ganttEl.dataset.ganttId) {
    showEventMenu(e.clientX, e.clientY, ganttEl.dataset.ganttId);
  } else if (monthEv && monthEv.dataset.id) {
    showEventMenu(e.clientX, e.clientY, monthEv.dataset.id);
  } else if (monthCell && monthCell.dataset.key) {
    showMonthCellMenu(e.clientX, e.clientY, monthCell.dataset.key);
  } else if (eventItem && eventItem.dataset.id) {
    showEventMenu(e.clientX, e.clientY, eventItem.dataset.id);
  } else {
    showBlankMenu(e.clientX, e.clientY, targetDate);
  }
});

// —— 月历格子菜单（P6.1）：在该日新建 / 查看该日 ——
function showMonthCellMenu(x, y, key) {
  showItems(x, y);
  ctxItems.innerHTML = `
    <div class="ctx-item" data-action="add">在该日新建事项</div>
    <div class="ctx-item" data-action="goto">查看该日</div>
  `;
  bindItemHandlers({
    add: () => {
      // 月历无内联表单：先切周视图定位该日，再展开该日卡片内的添加表单（日期已预填）
      monthGotoDate(key);
      render();
      openAddForm(key);
    },
    goto: () => { monthGotoDate(key); render(); }
  });
}

// —— 空白处菜单（按视图区分） ——
function showBlankMenu(x, y, targetDate) {
  showItems(x, y);
  if (currentView === 'projects') {
    ctxItems.innerHTML = `
      <div class="ctx-item" data-action="newProject">新建项目</div>
      <div class="ctx-item" data-action="importPrj">导入项目文件</div>
    `;
    bindItemHandlers({
      newProject: () => {
        const btn = weekList.querySelector('.project-create-btn');
        if (btn) btn.click();
      },
      importPrj: () => importProjectFileFlow()
    });
  } else if (currentView === 'tasks' || (currentView === 'calendar' && calendarMode === 'gantt')) {
    // 事项视图 / 日历总览甘特：新建事项（甘特模式无日卡片，转到事项视图打开表单）
    ctxItems.innerHTML = `<div class="ctx-item" data-action="add">新建事项</div>`;
    bindItemHandlers({ add: () => {
      if (currentView !== 'tasks') switchView('tasks');
      const btn = weekList.querySelector('.top-add');
      if (btn) btn.click();
    }});
  } else {
    // 今日 / 日历视图
    ctxItems.innerHTML = `
      <div class="ctx-item" data-action="add">添加事项</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="doneDate">完成指定日期</div>
      <div class="ctx-item" data-action="doneAll">完成所有</div>
    `;
    ctxMenu.dataset.date = targetDate;
    bindItemHandlers({
      add: () => openAddForm(targetDate),
      doneDate: () => openDatePicker('选择要完成的日期', dateKey(today()), (pickedDate) => {
        markDateDone(pickedDate);
      }),
      doneAll: () => markAllDone()
    });
  }
}

// —— 事项菜单 ——
function showEventMenu(x, y, eventId) {
  // 虚拟事项（重复投影）：完成走按日 override；其余操作（编辑/改期/调项目/删除）作用于模板
  const isVirtual = eventId.includes('@');
  const virtDate = isVirtual ? eventId.slice(eventId.lastIndexOf('@') + 1) : '';
  const templateId = isVirtual ? eventId.slice(0, eventId.lastIndexOf('@')) : eventId;
  const ev = loadEvents().find(e => e.id === templateId);
  if (!ev) return;
  showItems(x, y);
  ctxMenu.dataset.eventId = templateId;
  const doneLabel = isVirtual
    ? (recurDoneGet(templateId, virtDate) ? '取消完成此日' : '完成此日（仅当天）')
    : (ev.done ? '事项未完成' : '完成该事项');
  ctxItems.innerHTML = `
    <div class="ctx-item" data-action="toggle">${doneLabel}</div>
    <div class="ctx-item" data-action="edit">编辑事项${isVirtual ? '（重复系列）' : ''}</div>
    <div class="ctx-item" data-action="pomo">开始番茄钟</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="move">将完成时间调整到</div>
    <div class="ctx-item" data-action="toProject">调整事项到项目</div>
    <div class="ctx-item" data-action="toTemplate">存为模板</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">删除</div>
  `;
  bindItemHandlers({
    toggle: () => toggleDone(eventId),   // 复合 id → 按日 override；普通事项行为不变
    edit: () => openTaskEditor(ev),
    pomo: () => {
      POMO.taskId = templateId;
      POMO.taskTitle = ev.title;
      openTool('pomodoro');
    },
    move: () => openDatePicker('调整到哪一天', eventStart(ev) || dateKey(today()), (pickedDate) => {
      moveEventToDate(templateId, pickedDate);
    }),
    toProject: () => openProjectPicker('调整到哪个项目', ev.projectId, (pid) => {
      moveEventToProject(templateId, pid);
    }),
    toTemplate: () => {
      const r = saveEventAsTemplate(ev);
      showToast(r === 'dup' ? '模板已存在（同标题同时间）' : '已存为模板：' + ev.title);
    },
    delete: () => {
      // 重复系列删除影响所有未来日程，删除前确认一次
      if (isVirtual && !confirm(`「${ev.title}」是重复事项，删除将移除全部重复日程，确定？`)) return;
      deleteEvent(templateId);
    }
  });
}

// —— 项目菜单：编辑 / 删除 ——
function showProjectMenu(x, y, projectId) {
  showItems(x, y);
  ctxItems.innerHTML = `
    <div class="ctx-item" data-action="edit">编辑项目</div>
    <div class="ctx-item" data-action="export">导出项目文件</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">删除项目</div>
  `;
  bindItemHandlers({
    edit: () => editProjectViaForm(projectId),
    export: () => exportProjectFile(projectId),
    delete: () => deleteProject(projectId)
  });
}

// 显示菜单项列表（隐藏日期/项目面板）
function showItems(x, y) {
  ctxItems.classList.remove('hidden');
  ctxDatePicker.classList.add('hidden');
  ctxProjectPicker.classList.add('hidden');
  ctxMenu.classList.remove('hidden');
  positionMenu(x, y);   // 定位到鼠标处
}

// 边缘定位：传入 x/y 时定位到鼠标处，否则仅按当前尺寸重新钳制（面板切换时用）
function positionMenu(x, y) {
  const rect = ctxMenu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  const px = (x === undefined) ? (parseInt(ctxMenu.style.left) || 0) : x;
  const py = (y === undefined) ? (parseInt(ctxMenu.style.top) || 0) : y;
  ctxMenu.style.left = Math.max(4, Math.min(px, maxX)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(py, maxY)) + 'px';
}

// 绑定菜单项点击
function bindItemHandlers(handlers) {
  ctxItems.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      if (handlers[action]) handlers[action]();
      // 需要打开选择面板的 action 不关闭菜单
      if (action !== 'doneDate' && action !== 'move' && action !== 'toProject') {
        hideCtxMenu();
      }
    });
  });
}

// 打开日期选择面板（在菜单内部切换）
function openDatePicker(label, defaultDate, callback) {
  pendingDateAction = callback;
  ctxItems.classList.add('hidden');
  ctxProjectPicker.classList.add('hidden');
  ctxDatePicker.classList.remove('hidden');
  dpLabel.textContent = label;
  dpInput.value = defaultDate;
  positionMenu();
  dpInput.focus();
}

// 打开项目选择面板（在菜单内部切换）
function openProjectPicker(label, currentPid, callback) {
  pendingProjectAction = callback;
  ctxItems.classList.add('hidden');
  ctxDatePicker.classList.add('hidden');
  ctxProjectPicker.classList.remove('hidden');
  ppLabel.textContent = label;

  const projects = loadProjects();
  let html = `
    <div class="pp-item ${!currentPid ? 'current' : ''}" data-pid="">
      <span class="pp-check">${!currentPid ? '✓' : ''}</span>未归类
    </div>
  `;
  for (const p of projects) {
    html += `
      <div class="pp-item ${p.id === currentPid ? 'current' : ''}" data-pid="${p.id}">
        <span class="pp-check">${p.id === currentPid ? '✓' : ''}</span>${escapeHtml(p.name)}
      </div>
    `;
  }
  ppList.innerHTML = html;

  ppList.querySelectorAll('.pp-item').forEach(item => {
    item.addEventListener('click', () => {
      if (pendingProjectAction) pendingProjectAction(item.dataset.pid || null);
      pendingProjectAction = null;
      hideCtxMenu();
    });
  });

  positionMenu();
}

// 日期确认 / 取消
dpConfirm.addEventListener('click', () => {
  const picked = dpInput.value;
  if (picked && pendingDateAction) {
    pendingDateAction(picked);
  }
  pendingDateAction = null;
  hideCtxMenu();
});
dpCancel.addEventListener('click', () => {
  pendingDateAction = null;
  hideCtxMenu();
});

function hideCtxMenu() {
  ctxMenu.classList.add('hidden');
  pendingDateAction = null;
  pendingProjectAction = null;
}

// 展开对应日期的内联添加表单
function openAddForm(targetDate) {
  const card = weekList.querySelector(`.day-card[data-date="${targetDate}"]`);
  if (card) {
    weekList.querySelectorAll('.add-form').forEach(f => f.classList.add('hidden'));
    const form = card.querySelector('.add-form');
    form.classList.remove('hidden');
    if (window.timetable) window.timetable.setEditing(true);
    form.querySelector('.ev-title').focus();
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// 点击其他位置关闭菜单
document.addEventListener('click', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
    hideCtxMenu();
  }
});

// 阻止菜单内部的点击冒泡导致关闭
ctxMenu.addEventListener('click', (e) => e.stopPropagation());

// ============ 导航绑定 ============
viewTabs.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ============ 范围导航（滚动轮换，仅日历视图；月历模式翻月） ============
$('prevWeek').addEventListener('click', () => {
  if (calendarMode === 'month') { monthAnchor = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() - 1, 1); monthExpandKey = ''; render(); return; }
  rangeStart = addDays(rangeStart, -PAGE_STEP);
  render();
});
$('nextWeek').addEventListener('click', () => {
  if (calendarMode === 'month') { monthAnchor = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 1); monthExpandKey = ''; render(); return; }
  rangeStart = addDays(rangeStart, PAGE_STEP);
  render();
});

// 收起态点击窄条：乐观切 CSS 类 + 通知主进程立即展开窗口（绕过边缘停留判定）
function ensureExpanded() {
  if (sidebar.classList.contains('expanded')) return;
  sidebar.classList.add('expanded');
  if (window.timetable) window.timetable.requestExpand();
}

// rail：点击空白窄条展开（图标按钮由下方委托处理）
railEl.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  ensureExpanded();
});

// rail 图标：导航切视图 / 工具开面板（收起态单击同时展开侧栏）
railEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.rail-icon');
  if (!btn) return;
  ensureExpanded();
  if (btn.dataset.view) switchView(btn.dataset.view);
  if (btn.dataset.tool) openTool(btn.dataset.tool);
});

// 面板工具条：打开工具
$('toolStrip').addEventListener('click', (e) => {
  const btn = e.target.closest('.strip-btn');
  if (!btn || !btn.dataset.tool) return;
  openTool(btn.dataset.tool);
});

// 主进程状态变化
if (window.timetable) {
  window.timetable.onStateChange((state) => {
    sidebar.classList.toggle('expanded', !!state.expanded);
    // 停靠侧 / 显示模式：镜像圆角边线 + 迷你态压缩样式
    if (state.side) sidebar.classList.toggle('side-left', state.side === 'left');
    if (state.mode) sidebar.classList.toggle('mini', state.mode === 'mini');
  });
  // 启动即应用持久化的 UI 配置（主进程建窗已按配置定位，这里同步渲染层样式类）
  if (window.timetable.uiConfigGet) {
    window.timetable.uiConfigGet().then((cfg) => {
      if (!cfg) return;
      sidebar.classList.toggle('side-left', cfg.side === 'left');
      sidebar.classList.toggle('mini', cfg.mode === 'mini');
    }).catch(() => { /* 主进程不可达时保持默认 */ });
  }
  // 全局快捷键：启动时按持久化设置同步注册（主进程已先按默认注册，这里覆盖为用户设置）
  if (window.timetable.hotkeySet) {
    const st = loadAppSettings();
    window.timetable.hotkeySet({
      toggle: st.hotkeyToggleEnabled !== false,
      quickadd: st.hotkeyQuickAddEnabled === true
    }).catch(() => { /* 同步失败保持主进程默认 */ });
  }
  // 快捷键动作：Ctrl+Alt+N → 打开快速添加
  if (window.timetable.onShortcutAction) {
    window.timetable.onShortcutAction((data) => {
      if (data && data.action === 'quickadd') openTool('quickadd');
    });
  }
}

// ============ 初始化 ============
// 生成本机设备标识（局域网同步预留）
getDeviceId();
// 应用外观主题（暗/亮 + 强调色）：渲染前生效，避免启动闪色
applyUiTheme();
// 上报主进程（配对/同步握手复用同一 deviceId）
if (window.timetable && window.timetable.syncHello) {
  try { window.timetable.syncHello(getDeviceId()); } catch { /* 主进程未就绪时下次启动再报 */ }
}
// 应用设置同步：剪贴板开关下发主进程（关 = 暂停记录）
if (window.timetable) {
  const bootSt = loadAppSettings();
  window.timetable.clipboardEnabled(bootSt.clipboardEnabled !== false);
  // 托盘菜单动作（如"设置"→ 展开并打开设置工具）
  window.timetable.onTrayAction((d) => {
    if (d && d.action === 'settings') openTool('settings');
  });
  // 数据目录迁移后：主进程把备份数据发回渲染层恢复 localStorage
  if (window.timetable.onDataMigrateRestore) {
    window.timetable.onDataMigrateRestore((backup) => {
      try {
        if (window.Backup && backup) {
          window.Backup.restoreLocalStorageBackup(backup);
          showToast('数据目录迁移完成，数据已恢复');
          render();
        }
      } catch (e) {
        showToast('数据恢复失败：' + (e && e.message || e));
      }
    });
  }
}

// 窗口可见性：隐藏进托盘时暂停非必要刷新（60s 全量重绘 / 系统采样 / 天气），重新显示时立即补刷。
// 注意：到点提醒 checkReminders 不受此影响，窗口隐藏时照常通知。
let windowVisible = true;
if (window.timetable && window.timetable.onWindowVisible) {
  window.timetable.onWindowVisible((v) => {
    if (v === windowVisible) return;
    windowVisible = v;
    if (v) { renderClock(); render(); pollSysOnce(); refreshWeather(); }
  });
}
renderClock();
render();
setInterval(renderClock, 30 * 1000);

// 事项到点提醒：15 秒轮询（同一分钟内 4 次机会命中 HH:MM 等值判定）
setInterval(checkReminders, 15 * 1000);
// 定时自动同步（P4.4）：10 分钟固定间隔，开关默认关；tick 内部校验生效前提
setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);
// 通知权限：启动即申请（到点提醒 / 番茄钟通知用）
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  try { Notification.requestPermission(); } catch { /* 忽略 */ }
}
setInterval(() => {
  // 窗口隐藏进托盘时跳过整体重建（重新显示时 onWindowVisible 会立即补刷一次）
  if (!windowVisible) return;
  // 跨日/跨周时自动刷新；但工具打开（快速添加/便签有输入）或表单编辑中时跳过，避免清空用户输入
  if (currentTool) return;
  if (document.querySelector('.add-form:not(.hidden), .project-form:not(.hidden), .editor-block')) return;
  render();
}, 60 * 1000);

// 天气：启动拉取一次，之后每 10 分钟刷新（窄条温度直显）；窗口隐藏时不请求
refreshWeather();
setInterval(() => { if (windowVisible) refreshWeather(); }, 10 * 60 * 1000);
// 系统资源窄条读数：展开态 2s / 收起态 15s 自适应采样（主进程每次采样需 busy-wait 220ms，
// 收起时 3s 常驻是无谓开销；工具面板打开时由 buildSys 自己的 2s 定时器负责）。
// 窗口隐藏进托盘时不采样（窄条不可见），仅以 30s 空转保活，重新显示时由 onWindowVisible 立即补采。
(function sysRailLoop() {
  if (windowVisible) pollSysOnce();
  setTimeout(sysRailLoop, !windowVisible ? 30000 : (sidebar.classList.contains('expanded') ? 2000 : 15000));
})();
