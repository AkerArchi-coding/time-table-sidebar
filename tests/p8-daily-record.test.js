'use strict';
// P8.2 每日工作记录：buildDailyWorkRecord 纯函数
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

function seed(sb, events, history, projects) {
  appEval(sb, `saveEvents(${JSON.stringify(events)})`);
  if (history) appEval(sb, `savePomoHistory(${JSON.stringify(history)})`);
  if (projects) appEval(sb, `saveProjects(${JSON.stringify(projects)})`);
}

test('buildDailyWorkRecord：完成事项按 updatedAt 日期归属，统计数量与清单', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'a', title: '写周报', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T09:00:00Z', projectId: 'p1' },
    { id: 'b', title: '开会', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-09T10:00:00Z' },
    { id: 'c', title: '未完成', startDate: '2026-10-10', endDate: '2026-10-10', done: false, updatedAt: '2026-10-10T11:00:00Z' }
  ];
  seed(sb, events, [], [{ id: 'p1', name: '项目A' }]);
  const r = hostify(appEval(sb, `buildDailyWorkRecord(loadEvents(), loadPomoHistory(), '2026-10-10', loadProjects())`));
  assert.strictEqual(r.doneCount, 1, '只有 a 在 10-10 完成');
  assert.strictEqual(r.doneItems.length, 1);
  assert.strictEqual(r.doneItems[0].id, 'a');
  assert.strictEqual(r.doneItems[0].projectName, '项目A');
});

test('buildDailyWorkRecord：专注汇总从 history 对应日期取', () => {
  const { sb } = loadApp();
  const history = [
    { date: '2026-10-10', count: 4, minutes: 100 },
    { date: '2026-10-09', count: 2, minutes: 50 }
  ];
  seed(sb, [], history, []);
  const r = hostify(appEval(sb, `buildDailyWorkRecord(loadEvents(), loadPomoHistory(), '2026-10-10', loadProjects())`));
  assert.strictEqual(r.focusCount, 4);
  assert.strictEqual(r.focusMinutes, 100);
});

test('buildDailyWorkRecord：无专注记录时 focusCount/minutes 为 0', () => {
  const { sb } = loadApp();
  seed(sb, [], [], []);
  const r = hostify(appEval(sb, `buildDailyWorkRecord([], [], '2026-10-10', [])`));
  assert.strictEqual(r.focusCount, 0);
  assert.strictEqual(r.focusMinutes, 0);
  assert.deepStrictEqual(r.doneItems, []);
});

test('buildDailyWorkRecord：事项按 time 升序，无时间排最后', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'a', title: '午后', time: '14:00', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T06:00:00Z' },
    { id: 'b', title: '早晨', time: '09:00', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T01:00:00Z' },
    { id: 'c', title: '无时间', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T08:00:00Z' }
  ];
  seed(sb, events, [], []);
  const r = hostify(appEval(sb, `buildDailyWorkRecord(loadEvents(), loadPomoHistory(), '2026-10-10', loadProjects())`));
  assert.deepStrictEqual(r.doneItems.map(x => x.id), ['b', 'a', 'c'], '早晨→午后→无时间');
});

test('buildDailyWorkRecord：projectId 不存在时项目名显示未分类，无 projectId 显示未归类', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'a', title: '有项目', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T01:00:00Z', projectId: 'ghost' },
    { id: 'b', title: '无项目', startDate: '2026-10-10', endDate: '2026-10-10', done: true, updatedAt: '2026-10-10T02:00:00Z' }
  ];
  seed(sb, events, [], []);
  const r = hostify(appEval(sb, `buildDailyWorkRecord(loadEvents(), loadPomoHistory(), '2026-10-10', loadProjects())`));
  const names = r.doneItems.reduce((m, it) => { m[it.id] = it.projectName; return m; }, {});
  assert.strictEqual(names.a, '未分类', 'projectId 指向不存在的项目');
  assert.strictEqual(names.b, '未归类', '无 projectId');
});

test('buildDailyWorkRecord：completedAt 缺失时回退 createdAt', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'a', title: '旧数据', startDate: '2026-10-10', endDate: '2026-10-10', done: true, createdAt: '2026-10-10T03:00:00Z' }
  ];
  seed(sb, events, [], []);
  const r = hostify(appEval(sb, `buildDailyWorkRecord(loadEvents(), loadPomoHistory(), '2026-10-10', loadProjects())`));
  assert.strictEqual(r.doneCount, 1);
});
