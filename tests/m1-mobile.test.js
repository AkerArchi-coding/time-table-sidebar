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

// ---------- M2 写操作闭环 ----------

test('M2: 重复模板勾选走 recurDone（虚拟 id），不写模板本身', () => {
  const sb = loadMobile();
  const todayKey = sb.TTCore.dates.dateKey(new Date());
  const items = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey));
  const rec = items.find(i => i.title === '每日打卡（重复模板）');
  assert.ok(rec.recur && rec.vid.includes('@'), '重复项应带虚拟 id');
  assert.strictEqual(rec.done, false);
  const r = sb.TTMobile.toggleItem(rec.vid);
  assert.strictEqual(r.virtual, true);
  assert.strictEqual(sb.TTCore.storage.recurDoneGet(rec.id, todayKey), true);
  // 模板本身 done 不变
  const tpl = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === rec.id);
  assert.strictEqual(!!tpl.done, false);
  // 模型反映完成态
  const after = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey));
  assert.strictEqual(after.find(i => i.vid === rec.vid).done, true);
  // 再点取消
  sb.TTMobile.toggleItem(rec.vid);
  assert.strictEqual(sb.TTCore.storage.recurDoneGet(rec.id, todayKey), false);
});

test('M2: addItem 新增事项出现在当天模型', () => {
  const sb = loadMobile();
  const todayKey = sb.TTCore.dates.dateKey(new Date());
  const before = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey)).length;
  sb.TTMobile.addItem({ title: 'M2新增', startDate: todayKey, time: '15:00' });
  const items = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey));
  assert.strictEqual(items.length, before + 1);
  const added = items.find(i => i.title === 'M2新增');
  assert.ok(added && added.time === '15:00' && added.done === false);
});

test('M2: editItem 更新标题/时间/分类/紧急度生效', () => {
  const sb = loadMobile();
  const ev = hostify(sb.TTCore.storage.loadEvents()).find(e => e.title === '买菜');
  sb.TTMobile.editItem(ev.id, { title: '买水果', time: '18:30', category: 'personal', urgency: 'urgent' });
  const after = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === ev.id);
  assert.strictEqual(after.title, '买水果');
  assert.strictEqual(after.time, '18:30');
  assert.strictEqual(after.category, 'personal');
  assert.strictEqual(after.urgency, 'urgent');
});

test('M2: deleteItem 删除后模型与存储均无此项', () => {
  const sb = loadMobile();
  const todayKey = sb.TTCore.dates.dateKey(new Date());
  const ev = hostify(sb.TTCore.storage.loadEvents()).find(e => e.title === '写周报');
  const r = sb.TTMobile.deleteItem(ev.id);
  assert.ok(r.ev && r.ev.title === '写周报');
  const rest = hostify(sb.TTCore.storage.loadEvents());
  assert.ok(!rest.some(e => e.id === ev.id));
  const items = hostify(sb.TTMobile.collectDayItems(rest, todayKey));
  assert.ok(!items.some(i => i.title === '写周报'));
});

test('M2: 重复模板删除解析虚拟 id（删模板本身）', () => {
  const sb = loadMobile();
  const todayKey = sb.TTCore.dates.dateKey(new Date());
  const items = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), todayKey));
  const rec = items.find(i => i.title === '每日打卡（重复模板）');
  sb.TTMobile.deleteItem(rec.id); // UI 长按确认后传 real id
  assert.ok(!hostify(sb.TTCore.storage.loadEvents()).some(e => e.id === rec.id));
});

test('M2: 多日任务按日完成——勾选一天不影响其他天，不写全局 done', () => {
  const sb = loadMobile();
  const D = sb.TTCore.dates;
  const today = D.dateKey(new Date());
  const d1 = D.addDaysKey(today, 1), d2 = D.addDaysKey(today, 2), d3 = D.addDaysKey(today, 3);
  const ev = hostify(sb.TTCore.storage.loadEvents()).find(e => e.title === '多日活动示例');
  assert.strictEqual(ev.startDate, d1); assert.strictEqual(ev.endDate, d3);
  // 三天都出现且都有 @ 虚拟 id、multi=true
  const day1 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d1));
  const it1 = day1.find(i => i.title === '多日活动示例');
  const it2 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d2)).find(i => i.title === '多日活动示例');
  const it3 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d3)).find(i => i.title === '多日活动示例');
  assert.ok(it1.multi && it2.multi && it3.multi);
  assert.strictEqual(it1.vid, ev.id + '@' + d1);
  assert.strictEqual(it1.done, false);
  // 只勾选第 1 天
  sb.TTMobile.toggleItem(it1.vid);
  const after1 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d1)).find(i => i.title === '多日活动示例');
  const after2 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d2)).find(i => i.title === '多日活动示例');
  const after3 = hostify(sb.TTMobile.collectDayItems(sb.TTCore.storage.loadEvents(), d3)).find(i => i.title === '多日活动示例');
  assert.strictEqual(after1.done, true);
  assert.strictEqual(after2.done, false, '第 2 天不应被标记完成');
  assert.strictEqual(after3.done, false, '第 3 天不应被标记完成');
  // 全局 done 未被修改
  const evAfter = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === ev.id);
  assert.strictEqual(!!evAfter.done, false);
  // recurDone 按日落键
  assert.strictEqual(sb.TTCore.storage.recurDoneGet(ev.id, d1), true);
  assert.strictEqual(sb.TTCore.storage.recurDoneGet(ev.id, d2), false);
  // 再点第 1 天取消
  sb.TTMobile.toggleItem(it1.vid);
  assert.strictEqual(sb.TTCore.storage.recurDoneGet(ev.id, d1), false);
});
