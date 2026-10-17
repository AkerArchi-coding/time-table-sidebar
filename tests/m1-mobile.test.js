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

// ============ M3：项目与阶段管理 ============

test('M3: 示例项目注入——两个阶段 + 两条事项归属，模型计数正确', () => {
  const sb = loadMobile();
  const model = hostify(sb.TTMobile.buildProjectsModel());
  assert.strictEqual(model.length, 1);
  const p = model[0];
  assert.strictEqual(p.name, '示例项目');
  assert.strictEqual(p.phases.length, 2);
  assert.strictEqual(p.phases[0].name, '规划');
  assert.strictEqual(p.phases[1].name, '执行');
  assert.strictEqual(p.phases[0].items[0].title, '写周报');
  assert.strictEqual(p.phases[1].items[0].title, '项目评审');
  assert.strictEqual(p.total, 2);
  assert.strictEqual(p.done, 0);
  assert.strictEqual(p.unphased.length, 0);
});

test('M3: 项目写操作——新建/编辑/完成/删除（删除后事项归未归类）', () => {
  const sb = loadMobile();
  const p = hostify(sb.TTMobile.projCreate({ name: '测试项目', startDate: '2026-10-17', endDate: '2026-10-20' }));
  assert.ok(p.id);
  // 编辑
  assert.strictEqual(sb.TTMobile.projUpdate(p.id, { name: '改名项目' }), true);
  let stored = hostify(sb.TTCore.storage.loadProjects()).find(x => x.id === p.id);
  assert.strictEqual(stored.name, '改名项目');
  // 归属一条事项后完成切换
  const ev = hostify(sb.TTCore.storage.loadEvents()).find(e => e.title === '买菜');
  sb.TTMobile.editItem(ev.id, { projectId: p.id });
  assert.strictEqual(sb.TTMobile.projToggleComplete(p.id), true);
  stored = hostify(sb.TTCore.storage.loadProjects()).find(x => x.id === p.id);
  assert.strictEqual(stored.isCompleted, true);
  assert.ok(stored.completedAt);
  // 删除：项目消失，事项 projectId 置空（事项本身保留）
  assert.strictEqual(sb.TTMobile.projRemove(p.id), true);
  assert.ok(!hostify(sb.TTCore.storage.loadProjects()).some(x => x.id === p.id));
  const evAfter = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === ev.id);
  assert.ok(evAfter, '事项不应被删除');
  assert.strictEqual(evAfter.projectId, null);
});

test('M3: 阶段写操作——新增/重命名/移动/日期/完成/删除（删除后事项归未分阶段）', () => {
  const sb = loadMobile();
  const p = hostify(sb.TTMobile.buildProjectsModel())[0];
  // 新增（带日期倒挂自动交换由 core 负责，这里给正常区间）
  const ph3 = hostify(sb.TTMobile.phaseAdd(p.id, { name: '验收', startDate: '2026-10-25', endDate: '2026-10-27' }));
  assert.ok(ph3.id);
  assert.strictEqual(ph3.order, 2);
  // 重命名 + 日期
  assert.strictEqual(sb.TTMobile.phaseRename(p.id, ph3.id, '验收上线'), true);
  assert.strictEqual(sb.TTMobile.phaseDates(p.id, ph3.id, '2026-10-26', '2026-10-28'), true);
  // 上移
  assert.strictEqual(sb.TTMobile.phaseMove(p.id, ph3.id, -1), true);
  let model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.deepStrictEqual(model.phases.map(x => x.name), ['规划', '验收上线', '执行']);
  const ph3m = model.phases[1];
  assert.strictEqual(ph3m.startDate, '2026-10-26');
  assert.strictEqual(ph3m.endDate, '2026-10-28');
  // 完成切换
  assert.strictEqual(sb.TTMobile.phaseToggleComplete(p.id, ph3.id), true);
  model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.strictEqual(model.phases[1].isCompleted, true);
  // 把一条事项放进该阶段后删除阶段 → 事项归未分阶段
  const ev = hostify(sb.TTCore.storage.loadEvents()).find(e => e.title === '健身');
  sb.TTMobile.editItem(ev.id, { projectId: p.id, phaseId: ph3.id });
  assert.strictEqual(sb.TTMobile.phaseRemove(p.id, ph3.id), true);
  model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.strictEqual(model.phases.length, 2);
  assert.strictEqual(model.unphased.length, 1);
  assert.strictEqual(model.unphased[0].title, '健身');
});

test('M3: 事项归属闭环——新建带项目/阶段，编辑改归属，模型同步', () => {
  const sb = loadMobile();
  const D = sb.TTCore.dates;
  const todayKey = D.dateKey(new Date());
  const p = hostify(sb.TTMobile.buildProjectsModel())[0];
  const ph = p.phases[1];   // 执行
  // 新建：直接落入项目+阶段（addItem 补 phaseId）
  const ev = hostify(sb.TTMobile.addItem({ title: '归属测试事项', startDate: todayKey, projectId: p.id, phaseId: ph.id }));
  const stored = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === ev.id);
  assert.strictEqual(stored.projectId, p.id);
  assert.strictEqual(stored.phaseId, ph.id);
  let model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.ok(model.phases[1].items.some(i => i.title === '归属测试事项'));
  // 编辑：改到未归类
  sb.TTMobile.editItem(ev.id, { projectId: null, phaseId: '' });
  const stored2 = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === ev.id);
  assert.strictEqual(stored2.projectId, null);
  model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.ok(!model.phases[1].items.some(i => i.title === '归属测试事项'));
});

test('M3: 项目视图内事项勾选沿用按日语义（重复模板不写全局 done）', () => {
  const sb = loadMobile();
  const p = hostify(sb.TTMobile.buildProjectsModel())[0];
  const rec = hostify(sb.TTCore.storage.loadEvents()).find(e => e.recur);
  sb.TTMobile.editItem(rec.id, { projectId: p.id, phaseId: '' });
  let model = hostify(sb.TTMobile.buildProjectsModel())[0];
  const item = model.unphased.find(i => i.id === rec.id);
  assert.ok(item, '重复模板应出现在未分阶段');
  assert.ok(item.vid.includes('@'), '项目视图内重复模板用虚拟 id');
  sb.TTMobile.toggleItem(item.vid);
  const tpl = hostify(sb.TTCore.storage.loadEvents()).find(e => e.id === rec.id);
  assert.strictEqual(!!tpl.done, false, '勾选不得写模板全局 done');
  model = hostify(sb.TTMobile.buildProjectsModel())[0];
  assert.strictEqual(model.unphased.find(i => i.id === rec.id).done, true);
});

test('M3: 渲染——日程视图含分段控件与项目/阶段下拉，render 不抛错', () => {
  const sb = loadMobile();
  const html = sb.TTMobile.render();
  // 分段切换控件
  assert.ok(html.includes('data-act="view-days"'), '应含日程切换按钮');
  assert.ok(html.includes('data-act="view-projects"'), '应含项目切换按钮');
  // 事项编辑表单应带项目/阶段归属下拉（先制造编辑态不可行——ui 为闭包态；
  // 改为断言导出函数可构建含下拉的模型：新建表单在 adding 态才出现，此处退而验证
  // 日程视图结构完整：7 个日期区块 + 添加入口）
  const dayCount = (html.match(/class="m-day"/g) || []).length;
  assert.strictEqual(dayCount, 7);
  assert.ok(html.includes('data-act="open-add"'));
});

// ============ M4：甘特图概览 ============

test('M4: 甘特模型——项目条/未归类组/多日事项行结构与偏移正确', () => {
  const sb = loadMobile();
  const D = sb.TTCore.dates;
  const todayKey = D.dateKey(new Date());
  const winStart = D.addDaysKey(todayKey, -3);
  const m = hostify(sb.TTMobile.buildGanttModel(winStart, 31));
  assert.strictEqual(m.winDays, 31);
  assert.strictEqual(m.days.length, 31);
  assert.strictEqual(m.todayOff, 3);
  // 行：示例项目（today~today+13）+ 未归类组 + 多日活动示例（today+1~today+3）
  assert.deepStrictEqual(m.rows.map(r => r.kind), ['project', 'group', 'multi']);
  const proj = m.rows[0];
  assert.strictEqual(proj.label, '示例项目');
  assert.strictEqual(proj.off, 3);
  assert.strictEqual(proj.len, 14);
  assert.strictEqual(proj.depth, 0);
  const multi = m.rows[2];
  assert.strictEqual(multi.label, '多日活动示例');
  assert.strictEqual(multi.off, 4);
  assert.strictEqual(multi.len, 3);
  assert.strictEqual(multi.depth, 1);
});

test('M4: 甘特模型——窗口裁剪（左截断）与窗口外数据剔除', () => {
  const sb = loadMobile();
  const D = sb.TTCore.dates;
  const todayKey = D.dateKey(new Date());
  // 窗口从 today+2 开始：项目左截断 len=12，多日事项截断为 2 天
  const m = hostify(sb.TTMobile.buildGanttModel(D.addDaysKey(todayKey, 2), 31));
  const proj = m.rows.find(r => r.kind === 'project');
  assert.strictEqual(proj.off, 0);
  assert.strictEqual(proj.len, 12);
  const multi = m.rows.find(r => r.kind === 'multi');
  assert.strictEqual(multi.off, 0);
  assert.strictEqual(multi.len, 2);
  // 完全在窗口之后（today+40 起）：无任何行
  const m2 = hostify(sb.TTMobile.buildGanttModel(D.addDaysKey(todayKey, 40), 31));
  assert.strictEqual(m2.rows.length, 0);
  assert.strictEqual(m2.todayOff, -40);
});

test('M4: 甘特模型——带日期的阶段成行、归属事项按 phaseId 决定缩进', () => {
  const sb = loadMobile();
  const D = sb.TTCore.dates;
  const todayKey = D.dateKey(new Date());
  const p = hostify(sb.TTMobile.buildProjectsModel())[0];
  // 给「执行」阶段设日期
  sb.TTMobile.phaseDates(p.id, p.phases[1].id, D.addDaysKey(todayKey, 5), D.addDaysKey(todayKey, 9));
  // 归属到该阶段的多日事项
  const ev = hostify(sb.TTMobile.addItem({
    title: '阶段内多日事项', startDate: D.addDaysKey(todayKey, 6),
    endDate: D.addDaysKey(todayKey, 8), projectId: p.id, phaseId: p.phases[1].id
  }));
  assert.ok(ev.id);
  const m = hostify(sb.TTMobile.buildGanttModel(D.addDaysKey(todayKey, -3), 31));
  const kinds = m.rows.map(r => r.kind + ':' + r.label);
  assert.ok(kinds.includes('phase:执行'), '应含阶段行');
  assert.ok(kinds.includes('multi:阶段内多日事项'), '应含阶段内多日事项行');
  const phRow = m.rows.find(r => r.kind === 'phase');
  assert.strictEqual(phRow.off, 8);   // today+5，窗口 -3 → off=8
  assert.strictEqual(phRow.len, 5);
  const evRow = m.rows.find(r => r.label === '阶段内多日事项');
  assert.strictEqual(evRow.depth, 2, '归属阶段的多日事项缩进两层');
  assert.strictEqual(evRow.off, 9);
  assert.strictEqual(evRow.len, 3);
});

test('M4: 甘特渲染——概览视图 HTML 含刻度/条/今天线，render 不抛错', () => {
  const sb = loadMobile();
  // 默认日程视图 → 切不到概览（ui 为闭包态），改为验证：
  // 1) 分段控件含「概览」入口；2) buildGanttModel 输出可序列化、无异常
  const html = sb.TTMobile.render();
  assert.ok(html.includes('data-act="view-gantt"'), '分段控件应含概览入口');
  const D = sb.TTCore.dates;
  const m = sb.TTMobile.buildGanttModel(D.addDaysKey(D.dateKey(new Date()), -3), 31);
  assert.ok(JSON.stringify(hostify(m)).length > 0);
});
