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
let calendarMode = 'calendar';     // 日历页显示模式：calendar（日历）| gantt（总览甘特）
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
    }
    eventsCache = list;
    return list;
  } catch { eventsCache = []; return eventsCache; }
}
function saveEvents(list) {
  eventsCache = Array.isArray(list) ? list : [];
  localStorage.setItem('events', JSON.stringify(eventsCache));
}
function getEventsByDate(key) {
  return sortDayEvents(
    loadEvents().filter(e => eventSpansDate(e, key))   // 多日事项在覆盖的每一天都显示
  );
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

  item.innerHTML = `
    <span class="urgency-dot" style="background:${urg.color}" title="${urg.label}"></span>
    <span class="event-check" data-id="${ev.id}" title="${ev.done ? '取消完成' : '标记完成'}"></span>
    <span class="event-time">${escapeHtml(ev.time || '')}</span>
    ${badges}
    <span class="event-title">${escapeHtml(ev.title)}</span>
    <span class="event-del" data-id="${ev.id}" title="删除">×</span>
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
      projectId
    };
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
    });
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
  // 昨日、聚焦日、明日、后日 共 4 张日期卡（点击卡片头部可切换；排序控件只挂在聚焦卡）
  for (let off = -1; off <= 2; off++) {
    weekList.appendChild(buildDayCard(addDays(d, off), {
      showSort: off === 0, anchorCard: off === 0, clickable: true
    }));
  }
  bindViewEvents();
}

// ============ 日历视图（周视图 / 总览甘特） ============
function renderWeek() {
  const todayD = today();
  const todayKey = dateKey(todayD);
  const isGantt = calendarMode === 'gantt';

  if (isGantt) {
    setHeader('总览甘特', '全部项目与事项', false);
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

  // 日历 / 总览甘特 显示模式切换
  const modeTabs = document.createElement('div');
  modeTabs.className = 'sub-tabs';
  modeTabs.innerHTML = `
    <button data-cal-mode="calendar" class="${!isGantt ? 'active' : ''}">日历</button>
    <button data-cal-mode="gantt" class="${isGantt ? 'active' : ''}">总览甘特</button>
  `;
  weekList.appendChild(modeTabs);

  if (isGantt) {
    weekList.appendChild(buildOverviewGantt());
  } else {
    for (let i = 0; i < RANGE_DAYS; i++) {
      weekList.appendChild(buildDayCard(addDays(rangeStart, i)));
    }
  }
  bindViewEvents();
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
  const events = getEventsByDate(key);

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
const GANTT_DAY_W = 28;    // 甘特图单日列宽 px
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
  const innerW = totalDays * GANTT_DAY_W;
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
      leftHtml += `<div class="gantt-name${t.done ? ' done' : ''}" style="height:${GANTT_ROW_H}px" data-gantt-id="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>`;
    }
  }

  // 右侧日期表头
  let headHtml = '';
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(parseDateKey(minK), i);
    const key = dateKey(d);
    headHtml += `<div class="gh-day${key === tk ? ' today' : ''}" style="width:${GANTT_DAY_W}px;flex:0 0 ${GANTT_DAY_W}px">
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
               style="left:${off * GANTT_DAY_W + 1}px;width:${dur * GANTT_DAY_W - 3}px;background:${cat.color}55;border-left-color:${cat.color}"
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
              ? `<div class="gantt-today-line" style="left:${todayOffset * GANTT_DAY_W + GANTT_DAY_W / 2}px"></div>` : ''}
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
  const innerW = totalDays * GANTT_DAY_W;
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
        style="left:${off * GANTT_DAY_W + 1}px;width:${dur * GANTT_DAY_W - 3}px;background:${cat.color}26;border-left-color:${cat.color}"
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
        leftHtml += `<div class="gantt-name${t.done ? ' done' : ''}" style="height:${GANTT_ROW_H}px" data-gantt-id="${t.id}" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>`;
        rowsHtml += `
          <div class="gantt-row" style="height:${GANTT_ROW_H}px">
            <div class="gantt-bar${t.done ? ' done' : ''}" data-gantt-id="${t.id}"
                 style="left:${off * GANTT_DAY_W + 1}px;width:${dur * GANTT_DAY_W - 3}px;background:${tcat.color}55;border-left-color:${tcat.color}"
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
    headHtml += `<div class="gh-day${key === tk ? ' today' : ''}" style="width:${GANTT_DAY_W}px;flex:0 0 ${GANTT_DAY_W}px">
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
              ? `<div class="gantt-today-line" style="left:${todayOffset * GANTT_DAY_W + GANTT_DAY_W / 2}px"></div>` : ''}
            ${rowsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  // 全部无日期事项（各项目 + 未归类）在时间轴下方单列
  appendUndated();

  bindGanttDrag(wrap);
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
        const deltaDays = Math.round((ev2.clientX - startX) / GANTT_DAY_W);
        if (deltaDays === 0) return;
        moved = true;
        bar.classList.add('dragging');
        if (resize) {
          const newEnd = addDaysKey(origEnd, deltaDays);
          if (newEnd < origStart) return;
          bar.style.width = (durationDays(origStart, newEnd) * GANTT_DAY_W - 3) + 'px';
          bar.dataset.dragEnd = newEnd;
        } else {
          const newStart = addDaysKey(origStart, deltaDays);
          const newEnd = addDaysKey(origEnd, deltaDays);
          const baseStart = wrap.dataset.minKey;
          const off = Math.round((parseDateKey(newStart) - parseDateKey(baseStart)) / 86400000);
          bar.style.left = (off * GANTT_DAY_W + 1) + 'px';
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
function renderTasks() {
  const all = sortEvents(loadEvents());
  setHeader('全部事项', `共 ${all.length} 项`, false);
  weekList.innerHTML = '';

  // 新建事项入口（未固定日期/项目）
  const block = document.createElement('div');
  block.className = 'add-block';
  const addBtn = document.createElement('button');
  addBtn.className = 'top-add';
  addBtn.textContent = '+ 新建事项';
  const form = buildTaskForm({});
  block.appendChild(addBtn);
  block.appendChild(form);
  weekList.appendChild(block);

  const list = document.createElement('div');
  list.className = 'event-list';
  if (all.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '— 暂无事项 —';
    list.appendChild(hint);
  } else {
    for (const ev of all) list.appendChild(buildEventItem(ev, { showDate: true, showProject: true }));
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
    description: '',
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
    for (const k of ['time', 'title', 'category', 'urgency', 'projectId']) {
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
  const all = loadEvents();
  const ev = all.find(e => e.id === id);
  saveEvents(all.filter(e => e.id !== id));
  if (ev && ev.projectId) bumpProjectRevision(ev.projectId);
  render();
}

function toggleDone(id) {
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

// 将事项移动到指定日期：多日事项整体平移（保持持续天数），单日事项直接改期
function moveEventToDate(id, newDateKey) {
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

// 完成指定日期的全部事项（含当天处于执行区间内的多日事项）
function markDateDone(dateKeyStr) {
  const all = loadEvents();
  let changed = false;
  for (const ev of all) {
    if (eventSpansDate(ev, dateKeyStr) && !ev.done) { ev.done = true; changed = true; }
  }
  if (changed) { saveEvents(all); render(); }
}

// 完成日历当前可见范围的全部事项（区间与可见范围有交集即完成）
function markAllDone() {
  const all = loadEvents();
  const rangeEnd = dateKey(addDays(rangeStart, RANGE_DAYS - 1));
  let changed = false;
  for (const ev of all) {
    const s = eventStart(ev), e = eventEnd(ev);
    const inRange = s && !(e < dateKey(rangeStart)) && !(s > rangeEnd);
    if (inRange && !ev.done) { ev.done = true; changed = true; }
  }
  if (changed) { saveEvents(all); render(); }
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
  'import-new': '导入新项目'
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
  const hm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  for (const ev of loadEvents()) {
    if (ev.done || !ev.time || eventStart(ev) !== tk) continue;
    if (ev.time !== hm) continue;
    const key = ev.id + '|' + tk;
    if (remindedKeys.has(key)) continue;
    remindedKeys.add(key);
    saveRemindedKeys();
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('日程到点提醒', { body: `${ev.time} ${ev.title}` });
      }
    } catch { /* 通知不可用时仅响铃 */ }
    playChime(CHIME.remind);
    showToast('到点提醒：' + ev.title);
  }
}

// ============ 侧边栏工具（快速添加 / 番茄钟 / 今日进度 / 快速便签） ============
// 工具以「内容区覆盖层」呈现，不改 currentView，返回即回原视图；均为本地功能，不涉及网络。
const TOOL_DEFS = {
  quickadd:  { title: '快速添加', pinEditing: true },
  pomodoro:  { title: '番茄钟',   pinEditing: false },
  progress:  { title: '今日进度', pinEditing: false },
  notes:     { title: '快速便签', pinEditing: true },
  weather:   { title: '天气',     pinEditing: false },
  sys:       { title: '系统资源', pinEditing: false },
  clipboard: { title: '剪贴板',   pinEditing: false },
  settings:  { title: '设置',     pinEditing: false }
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
  else if (currentTool === 'notes') buildNotes(panel);
  else if (currentTool === 'weather') buildWeather(panel);
  else if (currentTool === 'sys') buildSys(panel);
  else if (currentTool === 'clipboard') buildClipboard(panel);
  else if (currentTool === 'settings') buildSettings(panel);
  weekList.appendChild(panel);
}

// ---- 工具一：快速添加（默认今天、未归类，回车连续录入） ----
function buildQuickAdd(panel) {
  const tk = dateKey(today());
  panel.innerHTML = `
    <div class="tool-hint">回车快速保存，可连续添加；默认归属今天</div>
    <input type="text" class="qa-input" maxlength="60" placeholder="要做点什么？" />
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
  doneDate: ''
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
    if (Notification.permission === 'granted') new Notification(title, { body });
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
  panel.innerHTML = `
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

// ---- 工具三：今日进度 ----
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
      ...saved                     // 已有设置覆盖默认
    };
  } catch { return {}; }
}
function saveAppSettings(s) {
  localStorage.setItem('appSettings', JSON.stringify(s));
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
    </div>
    <div class="set-about">日程侧边栏 v0.1.0<br>所有数据仅保存在本机</div>
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
  const card = e.target.closest('.day-card');
  const targetDate = card ? card.dataset.date : dateKey(today());

  if (projectCard && projectCard.dataset.id) {
    showProjectMenu(e.clientX, e.clientY, projectCard.dataset.id);
  } else if (ganttEl && ganttEl.dataset.ganttId) {
    showEventMenu(e.clientX, e.clientY, ganttEl.dataset.ganttId);
  } else if (eventItem && eventItem.dataset.id) {
    showEventMenu(e.clientX, e.clientY, eventItem.dataset.id);
  } else {
    showBlankMenu(e.clientX, e.clientY, targetDate);
  }
});

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
  const ev = loadEvents().find(e => e.id === eventId);
  if (!ev) return;
  showItems(x, y);
  ctxMenu.dataset.eventId = eventId;
  const doneLabel = ev.done ? '事项未完成' : '完成该事项';
  ctxItems.innerHTML = `
    <div class="ctx-item" data-action="toggle">${doneLabel}</div>
    <div class="ctx-item" data-action="edit">编辑事项</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="move">将完成时间调整到</div>
    <div class="ctx-item" data-action="toProject">调整事项到项目</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="delete">删除</div>
  `;
  bindItemHandlers({
    toggle: () => toggleDone(eventId),
    edit: () => openTaskEditor(ev),
    move: () => openDatePicker('调整到哪一天', eventStart(ev) || dateKey(today()), (pickedDate) => {
      moveEventToDate(eventId, pickedDate);
    }),
    toProject: () => openProjectPicker('调整到哪个项目', ev.projectId, (pid) => {
      moveEventToProject(eventId, pid);
    }),
    delete: () => deleteEvent(eventId)
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

// ============ 范围导航（滚动轮换，仅日历视图） ============
$('prevWeek').addEventListener('click', () => {
  rangeStart = addDays(rangeStart, -PAGE_STEP);
  render();
});
$('nextWeek').addEventListener('click', () => {
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
}

// ============ 初始化 ============
// 应用设置同步：剪贴板开关下发主进程（关 = 暂停记录）
if (window.timetable) {
  const bootSt = loadAppSettings();
  window.timetable.clipboardEnabled(bootSt.clipboardEnabled !== false);
  // 托盘菜单动作（如"设置"→ 展开并打开设置工具）
  window.timetable.onTrayAction((d) => {
    if (d && d.action === 'settings') openTool('settings');
  });
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
