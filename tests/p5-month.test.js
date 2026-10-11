// ============ P4.2 单元测试：月历网格构建 + 周视图拖拽改期路径 ============
// 运行方式：npm test（node --test "tests/*.test.js"）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// 本地日期 key（YYYY-MM-DD）
const KEY = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

// 直写 storage 后必须清 app.js 的 eventsCache（loadApp 初始化时已缓存空数组）
function seedEvents(sb, storage, list) {
  storage.setItem('events', JSON.stringify(list));
  appEval(sb, 'invalidateDerivedCaches()');
}

test('buildMonthGrid：固定 42 格，1 号落在其所在周的周一开头的网格内', () => {
  const { sb } = loadApp();
  // 2026-10-01 是周四 → 网格从 2026-09-28（周一）开始
  const grid = hostify(appEval(sb, 'buildMonthGrid(new Date(2026, 9, 15))'));
  assert.strictEqual(grid.length, 42);
  assert.strictEqual(grid[0].key, '2026-09-28');
  assert.strictEqual(grid[0].day, 28);
  assert.strictEqual(grid[0].inMonth, false, '首格上月末');
  const first = grid.find(c => c.key === '2026-10-01');
  assert.ok(first && first.inMonth && first.day === 1);
});

test('buildMonthGrid：本月 42 格中本月占满整周数（10 月 31 天含 5 个完整周）', () => {
  const { sb } = loadApp();
  const grid = hostify(appEval(sb, 'buildMonthGrid(new Date(2026, 9, 1))'));
  const inMonth = grid.filter(c => c.inMonth);
  assert.strictEqual(inMonth.length, 31, '10 月 31 天全部 inMonth');
  assert.strictEqual(grid.filter(c => !c.inMonth).length, 11, '其余为跨月补位');
});

test('buildMonthGrid：跨年（1 月锚点）首格在上年 12 月', () => {
  const { sb } = loadApp();
  // 2027-01-01 是周五 → 网格从 2026-12-28（周一）开始
  const grid = hostify(appEval(sb, 'buildMonthGrid(new Date(2027, 0, 10))'));
  assert.strictEqual(grid[0].key, '2026-12-28');
  assert.strictEqual(grid[0].inMonth, false);
  assert.ok(grid.some(c => c.key === '2027-01-01'));
});

test('buildMonthGrid：isToday 恰好标记真实今天一格', () => {
  const { sb } = loadApp();
  const grid = hostify(appEval(sb, 'buildMonthGrid(new Date())'));
  assert.strictEqual(grid.filter(c => c.isToday).length, 1, '当前月历必有今天');
});

test('moveEventToDate：单日事项改期，多日事项整体平移保持时长', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    { id: 'e1', title: '单日', startDate: '2026-10-05', endDate: '2026-10-05', time: '09:00', category: 'work', urgency: 'normal', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'e2', title: '多日', startDate: '2026-10-05', endDate: '2026-10-08', time: '', category: 'work', urgency: 'normal', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
  ]);
  appEval(sb, `moveEventToDate('e1', '2026-10-20')`);
  appEval(sb, `moveEventToDate('e2', '2026-10-20')`);
  const evs = hostify(JSON.parse(storage.getItem('events')));
  const e1 = evs.find(e => e.id === 'e1');
  const e2 = evs.find(e => e.id === 'e2');
  assert.strictEqual(e1.startDate, '2026-10-20');
  assert.strictEqual(e1.endDate, '2026-10-20', '单日保持单日');
  assert.strictEqual(e2.startDate, '2026-10-20');
  assert.strictEqual(e2.endDate, '2026-10-23', '多日平移 15 天保持 4 天时长');
});

test('moveEventToDate：虚拟投影 id 解析为模板后改期（拖拽重复事项路径）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    { id: 'r1', title: '每日站会', startDate: '2026-10-05', endDate: '2026-10-05', time: '09:00', category: 'work', urgency: 'normal', done: false, recur: { freq: 'daily', interval: 1, until: '' }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
  ]);
  // 拖拽拿到的是投影复合 id（模板id@日期），应作用于模板
  appEval(sb, `moveEventToDate('r1@2026-10-06', '2026-10-12')`);
  const evs = hostify(JSON.parse(storage.getItem('events')));
  assert.strictEqual(evs[0].startDate, '2026-10-12', '模板起始日被更新');
  assert.strictEqual(evs[0].id, 'r1', '仍是模板记录（id 不带 @）');
});
