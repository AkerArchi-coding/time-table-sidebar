'use strict';
// P9.1 甘特图阶段层级：阶段日期迁移/设置、按阶段分组、进度、超范围检测、甘特渲染与折叠
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 直接往 localStorage 写项目数据（绕过缓存），随后强制重载
function seedProjectsRaw(sb, arr) {
  appEval(sb, `localStorage.setItem('projects', JSON.stringify(${JSON.stringify(arr).replace(/`/g, '\\`')}))`);
  appEval(sb, `projectsCache = null`);
}
function seedEvents(sb, arr) {
  appEval(sb, `saveEvents(${JSON.stringify(arr)})`);
}
function mkEvent(o) {
  return Object.assign({
    id: 'e1', title: '事项', startDate: '2026-10-10', endDate: '2026-10-10',
    category: 'work', urgency: 'normal', done: false, projectId: 'p1', phaseId: ''
  }, o);
}
function mkProject(o) {
  return Object.assign({ id: 'p1', name: '项目A', category: 'work', priority: 'medium', phases: [] }, o);
}

// ---------- 数据迁移 ----------

test('loadProjects 迁移：阶段缺 startDate/endDate 补空串；倒挂日期自动交换', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({
    phases: [
      { id: 'ph1', name: '无日期', order: 0 },
      { id: 'ph2', name: '倒挂', order: 1, startDate: '2026-10-20', endDate: '2026-10-01' }
    ]
  })]);
  const p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases[0].startDate, '');
  assert.strictEqual(p.phases[0].endDate, '');
  assert.strictEqual(p.phases[1].startDate, '2026-10-01');
  assert.strictEqual(p.phases[1].endDate, '2026-10-20');
});

// ---------- setPhaseDates ----------

test('setPhaseDates：设置阶段日期、倒挂交换、revision 递增；不改动任何事项', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({ phases: [{ id: 'ph1', name: '设计', order: 0 }] })]);
  seedEvents(sb, [mkEvent({ id: 'e1', phaseId: 'ph1', startDate: '2026-09-01', endDate: '2026-09-05' })]);
  const rev0 = appEval(sb, `loadProjects()[0].revision`);
  assert.ok(appEval(sb, `setPhaseDates('p1', 'ph1', '2026-10-20', '2026-10-01')`));
  const p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases[0].startDate, '2026-10-01');
  assert.strictEqual(p.phases[0].endDate, '2026-10-20');
  assert.ok(p.revision > rev0);
  // 事项日期原样不动（即使超出阶段范围）
  const ev = hostify(appEval(sb, `loadEvents()[0]`));
  assert.strictEqual(ev.startDate, '2026-09-01');
  assert.strictEqual(ev.endDate, '2026-09-05');
  // 非法入参
  assert.strictEqual(appEval(sb, `setPhaseDates('nope', 'ph1', '2026-10-01', '2026-10-02')`), false);
  assert.strictEqual(appEval(sb, `setPhaseDates('p1', 'nope', '2026-10-01', '2026-10-02')`), false);
  // 清空日期
  assert.ok(appEval(sb, `setPhaseDates('p1', 'ph1', '', '')`));
  const p2 = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p2.phases[0].startDate, '');
});

// ---------- groupTasksByPhase ----------

test('groupTasksByPhase：按 order 排阶段、空阶段保留、悬空 phaseId 与未分阶段归入末尾 null 组', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({
    phases: [
      { id: 'phA', name: 'A', order: 1 },
      { id: 'phB', name: 'B', order: 0 }
    ]
  })]);
  seedEvents(sb, [
    mkEvent({ id: 'a1', phaseId: 'phA' }),
    mkEvent({ id: 'b1', phaseId: 'phB' }),
    mkEvent({ id: 'x1', phaseId: 'phGhost' }),  // 阶段已删除
    mkEvent({ id: 'l1', phaseId: '' })
  ]);
  const groups = hostify(appEval(sb, `
    groupTasksByPhase(loadProjects()[0], loadEvents())
  `));
  assert.strictEqual(groups.length, 3);            // phB, phA + 末尾 null 组
  assert.strictEqual(groups[0].phase.id, 'phB');   // order 排序
  assert.deepStrictEqual(groups[0].tasks.map(t => t.id), ['b1']);
  assert.deepStrictEqual(groups[1].tasks.map(t => t.id), ['a1']);
  assert.strictEqual(groups[2].phase, null);
  assert.deepStrictEqual(groups[2].tasks.map(t => t.id).sort(), ['l1', 'x1']);
});

test('groupTasksByPhase：全部分配时无 null 组；无阶段项目只有 null 组', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({ phases: [{ id: 'ph1', name: '一', order: 0 }] })]);
  seedEvents(sb, [mkEvent({ id: 'e1', phaseId: 'ph1' })]);
  const g1 = hostify(appEval(sb, `groupTasksByPhase(loadProjects()[0], loadEvents())`));
  assert.strictEqual(g1.length, 1);
  assert.ok(g1[0].phase);
  // 空阶段保留
  const g2 = hostify(appEval(sb, `groupTasksByPhase(loadProjects()[0], [])`));
  assert.strictEqual(g2.length, 1);
  assert.strictEqual(g2[0].tasks.length, 0);
  // 无阶段项目 + 有事项 → 仅 null 组
  seedProjectsRaw(sb, [mkProject({ id: 'p2' })]);
  const g3 = hostify(appEval(sb, `groupTasksByPhase(loadProjects()[0], loadEvents())`));
  assert.strictEqual(g3.length, 1);
  assert.strictEqual(g3[0].phase, null);
  assert.strictEqual(g3[0].tasks.length, 1);
  // null 防御
  assert.deepStrictEqual(hostify(appEval(sb, `groupTasksByPhase(null, [])`)), []);
});

// ---------- phaseProgress ----------

test('phaseProgress：完成度计算；空阶段 pct=0 不发生除零', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(appEval(sb, `phaseProgress([])`)), { done: 0, total: 0, pct: 0 });
  assert.deepStrictEqual(hostify(appEval(sb, `phaseProgress(null)`)), { done: 0, total: 0, pct: 0 });
  const prog = hostify(appEval(sb, `phaseProgress([{done:true},{done:false},{done:true}])`));
  assert.deepStrictEqual(prog, { done: 2, total: 3, pct: 67 });
});

// ---------- phaseRangeViolations ----------

test('phaseRangeViolations：before/after 正确识别，范围内与无日期不误报', () => {
  const { sb } = loadApp();
  const phases = [{ id: 'ph1', name: '阶段', order: 0, startDate: '2026-10-01', endDate: '2026-10-31' }];
  const tasks = [
    mkEvent({ id: 'before', phaseId: 'ph1', startDate: '2026-09-20', endDate: '2026-09-25' }),
    mkEvent({ id: 'after', phaseId: 'ph1', startDate: '2026-11-02', endDate: '2026-11-05' }),
    mkEvent({ id: 'in', phaseId: 'ph1', startDate: '2026-10-10', endDate: '2026-10-12' }),
    mkEvent({ id: 'loose', phaseId: '', startDate: '2026-09-01', endDate: '2026-09-02' }),
    mkEvent({ id: 'nodate', phaseId: 'ph1', startDate: '', endDate: '' })
  ];
  const v = hostify(appEval(sb, `phaseRangeViolations(${JSON.stringify(phases)}, ${JSON.stringify(tasks)})`));
  const map = Object.fromEntries(v.map(x => [x.taskId, x.dir]));
  assert.strictEqual(map.before, 'before');
  assert.strictEqual(map.after, 'after');
  assert.ok(!('in' in map));
  assert.ok(!('loose' in map));
  assert.ok(!('nodate' in map));
  // 阶段无日期时不检测
  const v2 = appEval(sb, `phaseRangeViolations([{id:'ph1',startDate:'',endDate:''}], ${JSON.stringify(tasks)}).length`);
  assert.strictEqual(v2, 0);
});

// ---------- 甘特图渲染 ----------

test('buildGantt：无阶段项目走平铺路径，不出现阶段父级行', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject()]);
  seedEvents(sb, [
    mkEvent({ id: 'e1', title: '事项一', startDate: '2026-10-10', endDate: '2026-10-12' }),
    mkEvent({ id: 'e2', title: '事项二', startDate: '2026-10-15', endDate: '2026-10-15' })
  ]);
  const html = appEval(sb, `buildGantt(loadProjects()[0]).innerHTML`);
  assert.ok(html.includes('data-gantt-id="e1"'));
  assert.ok(html.includes('data-gantt-id="e2"'));
  assert.ok(!html.includes('gantt-phase-row'));
  assert.ok(!html.includes('under-phase'));
});

test('buildGantt：阶段父级行/横条/进度/未设日期/未分阶段组/超范围警告全部渲染', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({
    phases: [
      { id: 'ph1', name: '设计阶段', order: 0, startDate: '2026-10-01', endDate: '2026-10-31' },
      { id: 'ph2', name: '空阶段', order: 1 }
    ]
  })]);
  seedEvents(sb, [
    mkEvent({ id: 'in1', title: '范围内', phaseId: 'ph1', startDate: '2026-10-10', endDate: '2026-10-12', done: true }),
    mkEvent({ id: 'out1', title: '超范围', phaseId: 'ph1', startDate: '2026-11-10', endDate: '2026-11-12' }),
    mkEvent({ id: 'loose1', title: '游离', phaseId: '', startDate: '2026-10-20', endDate: '2026-10-20' })
  ]);
  const html = appEval(sb, `buildGantt(loadProjects()[0]).innerHTML`);
  // 两个阶段父级行 + 未分阶段组
  assert.ok(html.includes('设计阶段'));
  assert.ok(html.includes('空阶段'));
  assert.ok(html.includes('未分阶段'));
  assert.ok(html.includes('gantt-phase-bar'));          // ph1 有日期 → 阶段横条
  assert.ok(html.includes('未设日期'));                  // ph2 无日期
  assert.ok(html.includes('1/2 · 50%'));                // ph1 进度（1 done / 2 total）
  // 超范围事项条带警告类，范围内不带
  const outBar = html.match(/<div class="gantt-bar[^"]*over-range[^"]*" data-gantt-id="out1"/);
  assert.ok(outBar, '超范围事项应有 over-range 类');
  assert.ok(!/data-gantt-id="in1"[^>]*class="[^"]*over-range/.test(html));
  // 下属事项缩进
  assert.ok(html.includes('gantt-name done under-phase') || html.includes('gantt-name under-phase done'));
  // 空阶段显示 0 事项占位
  assert.ok(html.includes('0 事项'));
});

test('buildGantt：折叠状态只影响下属行 hidden 属性，不改动事项数据', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({ phases: [{ id: 'ph1', name: '设计', order: 0 }] })]);
  seedEvents(sb, [mkEvent({ id: 'e1', phaseId: 'ph1', startDate: '2026-10-10', endDate: '2026-10-10' })]);
  const key = appEval(sb, `ganttPhaseKey('p1', 'ph1')`);
  // 展开：无 hidden
  const openHtml = appEval(sb, `buildGantt(loadProjects()[0]).innerHTML`);
  assert.ok(!/data-gphase="p1:ph1" hidden/.test(openHtml));
  assert.ok(openHtml.includes('▾'));
  // 折叠
  appEval(sb, `ganttPhaseCollapsed.add(${JSON.stringify(key)})`);
  const closedHtml = appEval(sb, `buildGantt(loadProjects()[0]).innerHTML`);
  const hiddenCount = (closedHtml.match(/data-gphase="p1:ph1" hidden/g) || []).length;
  assert.strictEqual(hiddenCount, 2);   // 左侧名 + 右侧条行
  assert.ok(closedHtml.includes('▸'));
  // 数据不变
  const ev = hostify(appEval(sb, `loadEvents()[0]`));
  assert.strictEqual(ev.phaseId, 'ph1');
  assert.strictEqual(ev.startDate, '2026-10-10');
});

test('buildOverviewGantt：项目组内渲染阶段父级行；未归类组保持平铺', () => {
  const { sb } = loadApp();
  seedProjectsRaw(sb, [mkProject({
    startDate: '2026-09-01', endDate: '2026-12-31',
    phases: [{ id: 'ph1', name: '总览阶段', order: 0, startDate: '2026-10-01', endDate: '2026-10-31' }]
  })]);
  seedEvents(sb, [
    mkEvent({ id: 'e1', phaseId: 'ph1', startDate: '2026-10-10', endDate: '2026-10-12' }),
    mkEvent({ id: 'e2', projectId: null, phaseId: '', startDate: '2026-10-15', endDate: '2026-10-16', title: '未归类事项' })
  ]);
  const html = appEval(sb, `buildOverviewGantt().innerHTML`);
  assert.ok(html.includes('项目A'));
  assert.ok(html.includes('总览阶段'));
  assert.ok(html.includes('gantt-phase-bar'));
  assert.ok(html.includes('未归类'));
  assert.ok(html.includes('data-gantt-id="e2"'));
});
