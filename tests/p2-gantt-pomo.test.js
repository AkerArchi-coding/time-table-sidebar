// ============ P2 单元测试：甘特图缩放 + 番茄钟绑定事项 ============
// 运行方式：npm test（即 node --test tests/）
//
// 原理：app.js 是无模块化的经典脚本，顶层 function 声明会挂到全局对象，
//       顶层 const（POMO / GANTT_STATE 等）位于全局词法环境。
//       这里用 vm 在沙箱中执行 app.js（document / localStorage / AudioContext
//       等浏览器对象用桩替代），再从沙箱取函数做断言；const 通过同上下文
//       runInContext 表达式读写。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const source = fs.readFileSync(APP_JS, 'utf8');

// ---- 桩：内存版 localStorage ----
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map
  };
}

// ---- 桩：最小可用 DOM 元素（容忍任意属性读写 / 监听器注册） ----
// querySelector 按选择符缓存实例：测试可通过 el._qs[sel] 拿到代码内持有的同一元素并触发事件
function fakeEl(tag) {
  const listeners = {};
  const qsCache = {};
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    dataset: {}, style: {}, children: [],
    innerHTML: '', textContent: '', value: '', className: '',
    scrollLeft: 0, scrollTop: 0, clientWidth: 200, clientHeight: 200,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    removeChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector(sel) { return qsCache[sel] || (qsCache[sel] = fakeEl()); },
    querySelectorAll: () => [],
    closest: () => null, contains: () => false,
    focus() {}, blur() {}, click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    _fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
    _qs: qsCache
  };
  return el;
}

// ---- 桩：AudioContext（playChime 依赖，避免测试发声/报错） ----
function fakeAudioContextCtor() {
  const param = () => ({
    value: 0,
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}
  });
  return class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() {}
    createOscillator() { return { type: '', frequency: param(), connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: param(), connect() {} }; }
  };
}

// ---- 在沙箱中加载 app.js；返回沙箱 + document 桩 + localStorage 桩 ----
function loadApp() {
  const storage = memStorage();
  const created = [];
  const doc = {
    _created: created,
    createElement: (tag) => { const el = fakeEl(tag); created.push(el); return el; },
    getElementById: () => fakeEl(),
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: fakeEl('body'),
    documentElement: fakeEl('html')
  };
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    document: doc,
    localStorage: storage,
    navigator: { language: 'zh-CN', platform: 'Win32', userAgent: 'test', clipboard: {} },
    location: { href: 'about:blank', search: '', reload: noop },
    setTimeout: () => 0, clearTimeout: noop,
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, media: '', addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    AudioContext: fakeAudioContextCtor(),
    alert: noop, confirm: () => false, prompt: () => null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: 'app.js' });
  } catch (e) {
    // 初始化阶段的运行时错误可接受：函数声明在执行前已提升挂到全局
    sandbox.__initError = e;
  }
  return { sb: sandbox, doc, storage };
}

// 在 app 的全局词法环境中求值（可读写顶层 const，如 POMO / GANTT_STATE）
function appEval(sb, expr) {
  return vm.runInContext(expr, sb, { filename: 'test-eval.js' });
}

// vm 内创建的数组/对象原型属于另一个 realm，与宿主断言比较前先 JSON 往返转成宿主对象
const hostify = (v) => JSON.parse(JSON.stringify(v));

// ============ 甘特图缩放 ============

test('ganttClampDayW：范围内原样返回', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.ganttClampDayW(28), 28);
  assert.strictEqual(sb.ganttClampDayW(17), 17);
  assert.strictEqual(sb.ganttClampDayW(55), 55);
});

test('ganttClampDayW：越界收敛到 [16, 56]', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.ganttClampDayW(10), 16);
  assert.strictEqual(sb.ganttClampDayW(-100), 16);
  assert.strictEqual(sb.ganttClampDayW(999), 56);
  assert.strictEqual(sb.ganttClampDayW(16), 16);   // 边界值保持
  assert.strictEqual(sb.ganttClampDayW(56), 56);
});

test('甘特图缩放常量与初始状态：16~56、步长 4、默认列宽 28', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, 'GANTT_DAY_W_MIN'), 16);
  assert.strictEqual(appEval(sb, 'GANTT_DAY_W_MAX'), 56);
  assert.strictEqual(appEval(sb, 'GANTT_DAY_W_STEP'), 4);
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 28);
});

test('工具栏「＋/－」缩放：步进 ±4，到边界后不再变化', () => {
  const { sb, doc } = loadApp();
  const wrap = fakeEl('div');
  sb.setupGanttControls(wrap);
  sb.render = () => {};   // 缩放触发整体重渲染，测试中置空
  const toolbar = doc._created.find(e => e.className === 'gantt-toolbar');
  assert.ok(toolbar, '应创建缩放工具栏');
  const label = toolbar._qs['.gantt-zoom-label'];

  toolbar._qs['[data-act="in"]']._fire('click', {});
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 32);
  assert.strictEqual(label.textContent, '32px');
  for (let i = 0; i < 10; i++) toolbar._qs['[data-act="in"]']._fire('click', {});
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 56, '放大到上限 56');

  for (let i = 0; i < 15; i++) toolbar._qs['[data-act="out"]']._fire('click', {});
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 16, '缩小到下限 16');
  assert.strictEqual(label.textContent, '16px');
});

test('Ctrl+滚轮缩放：放大/缩小步进 ±4，越界不生效', () => {
  const { sb } = loadApp();
  const wrap = fakeEl('div');
  sb.setupGanttControls(wrap);
  sb.render = () => {};
  const right = wrap._qs['.gantt-right'];
  const wheel = (ctrlKey, deltaY) => right._fire('wheel', { preventDefault() {}, ctrlKey, deltaY });

  wheel(true, -120);   // 上滚 → 放大
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 32);
  wheel(true, 120);    // 下滚 → 缩小
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 28);

  for (let i = 0; i < 10; i++) wheel(true, -120);
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 56, '连续放大停在 56');
  wheel(true, -120);   // 已到上限，越界步进不生效
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 56);
});

test('普通滚轮：横向滚动（scrollLeft 累加），不改变列宽', () => {
  const { sb } = loadApp();
  const wrap = fakeEl('div');
  sb.setupGanttControls(wrap);
  sb.render = () => {};
  const right = wrap._qs['.gantt-right'];
  right._fire('wheel', { preventDefault() {}, ctrlKey: false, deltaY: 120 });
  right._fire('wheel', { preventDefault() {}, ctrlKey: false, deltaY: 80 });
  assert.strictEqual(right.scrollLeft, 200);
  assert.strictEqual(appEval(sb, 'GANTT_STATE.dayW'), 28, '列宽不变');
});

test('「今天」按钮：按当前列宽定位到今天所在列', () => {
  const { sb, doc } = loadApp();
  const wrap = fakeEl('div');
  wrap.dataset.minKey = '2000-01-01';   // 时间轴起始日
  sb.setupGanttControls(wrap);
  sb.render = () => {};
  const toolbar = doc._created.find(e => e.className === 'gantt-toolbar');
  const right = wrap._qs['.gantt-right'];
  toolbar._qs['.gantt-today-btn']._fire('click', {});
  const dayW = appEval(sb, 'GANTT_STATE.dayW');
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const off = Math.round((todayMidnight - new Date(2000, 0, 1).getTime()) / 86400000);
  assert.strictEqual(right.scrollLeft, off * dayW - right.clientWidth / 2);
});

// ============ 番茄钟绑定事项 ============

test('appendPomoTaskLog：写入当日日志并持久化到 pomoTaskLogs', () => {
  const { sb, storage } = loadApp();
  sb.appendPomoTaskLog('t1', '写周报', 25);

  const logs = sb.loadPomoTaskLogs();
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].taskId, 't1');
  assert.strictEqual(logs[0].taskTitle, '写周报');
  assert.strictEqual(logs[0].minutes, 25);
  assert.ok(logs[0].ts, '应含完成时间戳');

  const raw = JSON.parse(storage.getItem('pomoTaskLogs'));
  assert.strictEqual(raw.date, sb.dateKey(sb.today()), '存储应带当日日期');
  assert.strictEqual(raw.logs.length, 1);
});

test('appendPomoTaskLog：多次完成逐条追加', () => {
  const { sb } = loadApp();
  sb.appendPomoTaskLog('t1', '写周报', 25);
  sb.appendPomoTaskLog('t1', '写周报', 25);
  const logs = sb.loadPomoTaskLogs();
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs.reduce((s, l) => s + l.minutes, 0), 50);
});

test('loadPomoTaskLogs：空存储返回空数组', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(sb.loadPomoTaskLogs()), []);
});

test('loadPomoTaskLogs：非当日数据视为过期，返回空数组', () => {
  const { sb, storage } = loadApp();
  storage.setItem('pomoTaskLogs', JSON.stringify({
    date: '2000-01-01',
    logs: [{ taskId: 'x', taskTitle: '旧数据', minutes: 30, ts: '2000-01-01T00:00:00Z' }]
  }));
  assert.deepStrictEqual(hostify(sb.loadPomoTaskLogs()), []);
});

test('loadPomoTaskLogs：存储内容非法 JSON 时兜底返回空数组', () => {
  const { sb, storage } = loadApp();
  storage.setItem('pomoTaskLogs', '{oops');
  assert.deepStrictEqual(hostify(sb.loadPomoTaskLogs()), []);
});

test('pomoBindComplete：完成专注 → 事项 pomoCount +1 并写入日志', () => {
  const { sb } = loadApp();
  sb.saveEvents([{ id: 't1', title: '写周报', pomoCount: 0 }]);   // 用 saveEvents 播种（绕过 eventsCache）
  appEval(sb, "POMO.taskId = 't1'; POMO.taskTitle = '';");

  sb.pomoBindComplete();

  const ev = sb.loadEvents().find(e => e.id === 't1');
  assert.strictEqual(ev.pomoCount, 1, 'pomoCount 应累计到 1');
  const logs = hostify(sb.loadPomoTaskLogs());
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].taskId, 't1');
  assert.strictEqual(logs[0].taskTitle, '写周报', '绑定标题为空时回退事项标题');
  assert.strictEqual(logs[0].minutes, appEval(sb, 'POMO.workMin'), '记录时长 = 当前专注时长');
});

test('pomoBindComplete：绑定标题优先于事项标题', () => {
  const { sb } = loadApp();
  sb.saveEvents([{ id: 't1', title: '写周报' }]);
  appEval(sb, "POMO.taskId = 't1'; POMO.taskTitle = '自定义标题';");
  sb.pomoBindComplete();
  assert.strictEqual(hostify(sb.loadPomoTaskLogs())[0].taskTitle, '自定义标题');
});

test('pomoBindComplete：两次完成 → pomoCount 累计到 2', () => {
  const { sb } = loadApp();
  sb.saveEvents([{ id: 't1', title: '写周报', pomoCount: 0 }]);
  appEval(sb, "POMO.taskId = 't1'; POMO.taskTitle = '';");
  sb.pomoBindComplete();
  sb.pomoBindComplete();
  assert.strictEqual(sb.loadEvents().find(e => e.id === 't1').pomoCount, 2);
  assert.strictEqual(sb.loadPomoTaskLogs().length, 2);
});

test('pomoBindComplete：未绑定事项（taskId=null）为空操作', () => {
  const { sb } = loadApp();   // POMO.taskId 默认 null
  sb.pomoBindComplete();
  assert.deepStrictEqual(hostify(sb.loadPomoTaskLogs()), []);
});

test('pomoBindComplete：绑定的事项不存在时不写入日志', () => {
  const { sb } = loadApp();
  appEval(sb, "POMO.taskId = 'ghost'; POMO.taskTitle = '幽灵';");
  sb.pomoBindComplete();
  assert.deepStrictEqual(hostify(sb.loadPomoTaskLogs()), []);
});

test('pomoTick 专注结束：pomoCount/日志/今日统计/进入休息 整链路', () => {
  const { sb, storage } = loadApp();
  sb.saveEvents([{ id: 't1', title: '写周报', pomoCount: 0 }]);
  appEval(sb, "POMO.running = true; POMO.mode = 'work'; POMO.endAt = Date.now() - 1;"
    + "POMO.taskId = 't1'; POMO.taskTitle = '';");

  sb.pomoTick();   // 倒计时已到期 → 走专注完成分支

  assert.strictEqual(sb.loadEvents().find(e => e.id === 't1').pomoCount, 1);
  const logs = hostify(sb.loadPomoTaskLogs());
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].taskId, 't1');
  assert.strictEqual(appEval(sb, 'POMO.doneToday'), 1, '今日完成数 +1');
  assert.strictEqual(appEval(sb, 'POMO.mode'), 'break', '自动进入休息');
  const stats = JSON.parse(storage.getItem('pomoStats'));
  assert.strictEqual(stats.count, 1);
});

test('pomoReset：重置后解除事项绑定', () => {
  const { sb } = loadApp();
  appEval(sb, "POMO.taskId = 't1'; POMO.taskTitle = '写周报';");
  sb.pomoReset();
  assert.strictEqual(appEval(sb, 'POMO.taskId'), null);
  assert.strictEqual(appEval(sb, 'POMO.taskTitle'), '');
});
