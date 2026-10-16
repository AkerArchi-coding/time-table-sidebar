// ============ M1 移动端冒烟测试 ============
// 验证：src/core + mobile/www 移动门面 + app-mobile.js 在无浏览器环境下可用，
// 且 www/core 镜像与 src/core 不漂移。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeEl, hostify } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const SRC_CORE = path.join(ROOT, 'src', 'core');
const WWW = path.join(ROOT, 'mobile', 'www');
const WWW_CORE = path.join(WWW, 'core');

const CORE_FILES = [
  'constants.js', 'dates.js', 'ids.js', 'models.js', 'storage.js',
  'checklist.js', 'tags.js', 'ical.js', 'nlp.js',
  'templates.js', 'analytics.js',
  'ops-tasks.js', 'ops-projects.js', 'backup-core.js', 'index.js'
];

// 与 mobile/www/index.html 相同的加载顺序
function loadMobile() {
  const map = new Map();
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
  const noop = () => {};
  const doc = {
    readyState: 'complete',
    createElement: (t) => fakeEl(t),
    getElementById: () => fakeEl(),
    addEventListener: noop, removeEventListener: noop,
    body: fakeEl('body')
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    document: doc,
    localStorage,
    setTimeout: () => 0, clearTimeout: noop
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of CORE_FILES) {
    vm.runInContext(fs.readFileSync(path.join(SRC_CORE, f), 'utf8'), sandbox, { filename: 'core/' + f });
  }
  vm.runInContext(fs.readFileSync(path.join(WWW, 'platform-mobile.js'), 'utf8'), sandbox, { filename: 'platform-mobile.js' });
  vm.runInContext(fs.readFileSync(path.join(WWW, 'app-mobile.js'), 'utf8'), sandbox, { filename: 'app-mobile.js' });
  return sandbox;
}

test('M1: www/core 镜像与 src/core 一致（防漂移，先跑 sync-core.js）', () => {
  const srcList = fs.readdirSync(SRC_CORE).filter(f => f.endsWith('.js')).sort();
  const wwwList = fs.existsSync(WWW_CORE) ? fs.readdirSync(WWW_CORE).filter(f => f.endsWith('.js')).sort() : [];
  assert.deepStrictEqual(wwwList, srcList, 'www/core 文件清单与 src/core 不一致');
  for (const f of srcList) {
    const s = fs.readFileSync(path.join(SRC_CORE, f));
    const w = fs.readFileSync(path.join(WWW_CORE, f));
    assert.ok(s.equals(w), `${f} 内容与 src/core 不一致，请运行 mobile/sync-core.js`);
  }
});

test('M1: core 在移动加载链下就绪，示例数据注入成功', () => {
  const sb = loadMobile();
  assert.strictEqual(sb.TTCore.ready, true);
  assert.strictEqual(sb.TTCore.version, 'm0');
  assert.ok(sb.TTMobile, 'TTMobile 未挂载');
  const events = hostify(sb.TTCore.storage.loadEvents());
  assert.strictEqual(events.length, 8, '示例数据应为 8 条');
  // 迁移兜底：每条都有 projectId / tags / recur 字段
  for (const ev of events) {
    assert.ok('projectId' in ev && Array.isArray(ev.tags) && 'recur' in ev);
  }
});

test('M1: 一周模型——今日在首日，跨日事项多日出现，重复模板只在起始日', () => {
  const sb = loadMobile();
  const week = hostify(sb.TTMobile.buildWeekModel(new Date()));
  assert.strictEqual(week.length, 7);
  assert.ok(week[0].label.startsWith('今天'));
  const todayTitles = week[0].items.map(i => i.title);
  assert.ok(todayTitles.includes('晨会') && todayTitles.includes('买菜'));
  // 多日活动示例：第 2~4 天都出现
  for (const i of [1, 2, 3]) {
    assert.ok(week[i].items.some(it => it.title === '多日活动示例'), `第${i}天缺多日活动`);
  }
  assert.ok(!week[4].items.some(it => it.title === '多日活动示例'), '多日活动越界');
  // 重复模板：只在今天出现，后续天不投影
  assert.ok(week[0].items.some(it => it.title === '每日打卡（重复模板）' && it.recur));
  assert.ok(!week[1].items.some(it => it.title === '每日打卡（重复模板）'));
});

test('M1: core 写操作在移动链下可用——toggleDone 后完成项排尾', () => {
  const sb = loadMobile();
  const events = hostify(sb.TTCore.storage.loadEvents());
  const morning = events.find(e => e.title === '晨会');
  const r = sb.TTCore.opsTasks.toggleDone(morning.id);
  assert.strictEqual(r.changed, true);
  const todayKey = vm.runInContext('TTCore.dates.dateKey(new Date())', sb);
  const items = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey));
  const last = items[items.length - 1];
  assert.strictEqual(last.title, '晨会');
  assert.strictEqual(last.done, true);
});
