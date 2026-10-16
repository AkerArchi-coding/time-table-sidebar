// ============ 测试公共 harness：在 vm 沙箱中加载 app.js ============
// app.js 是无模块化经典脚本：顶层 function 挂全局对象，顶层 const 在全局词法环境。
// document / localStorage / AudioContext 等浏览器对象用桩替代。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const source = fs.readFileSync(APP_JS, 'utf8');

// M0 核心层：显式有序加载清单（必须先于 app.js）。文件不存在则跳过，便于按切片增量接入。
const CORE_DIR = path.join(__dirname, '..', 'src', 'core');
const CORE_FILES = [
  'constants.js', 'dates.js',
  'ids.js', 'storage.js', 'models.js',
  'checklist.js', 'tags.js', 'ical.js', 'nlp.js',
  'templates.js', 'analytics.js',
  'ops-tasks.js', 'ops-projects.js',
  'backup-core.js',
  'index.js'
];

// M0 渲染层：平台门面须在 app.js 之前加载（app.js 经 TTPlatform 注入宿主能力）
const PLATFORM_JS = path.join(__dirname, '..', 'src', 'renderer', 'platform.js');

// 桩：内存版 localStorage
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

// 桩：最小可用 DOM 元素（容忍任意属性读写 / 监听器注册）
// querySelector 按选择符缓存实例：测试可通过 el._qs[sel] 拿到代码内持有的同一元素并触发事件
function fakeEl(tag) {
  const listeners = {};
  const qsCache = {};
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    dataset: {},
    // style 桩：支持直接属性赋值（style.width=…）+ setProperty 记录（CSS 变量注入断言用）
    style: { _sets: {}, setProperty(k, v) { this._sets[k] = v; }, removeProperty() {} },
    children: [],
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

// 桩：AudioContext（playChime 依赖，避免测试发声/报错）
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

// 在沙箱中加载 app.js；返回沙箱 + document 桩 + localStorage 桩
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
    URL,   // Chromium 全局 URL（P6.4 订阅地址解析用）
    alert: noop, confirm: () => false, prompt: () => null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // M0：先按序加载存在的 core 模块（app.js 依赖 TTCore 常量/日期函数）
  for (const f of CORE_FILES) {
    const p = path.join(CORE_DIR, f);
    if (!fs.existsSync(p)) continue;
    try {
      vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: 'core/' + f });
    } catch (e) {
      sandbox.__coreError = e;
    }
  }
  // M0 渲染层平台门面（先于 app.js）
  if (fs.existsSync(PLATFORM_JS)) {
    vm.runInContext(fs.readFileSync(PLATFORM_JS, 'utf8'), sandbox, { filename: 'renderer/platform.js' });
  }
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

module.exports = { loadApp, fakeEl, appEval, hostify };
