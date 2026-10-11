// ============ P6.1 单元测试：月历交互补齐（+N 展开 / 定位 / 右键菜单作用路径） ============
// 运行方式：npm test（node --test "tests/*.test.js"）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// 直写 storage 后必须清 app.js 的 eventsCache（loadApp 初始化时已缓存空数组）
function seedEvents(sb, storage, list) {
  storage.setItem('events', JSON.stringify(list));
  appEval(sb, 'invalidateDerivedCaches()');
}

// 造一条单日事项
function mkEvent(id, date, title) {
  return {
    id, title: title || id, startDate: date, endDate: date, time: '', category: 'work',
    urgency: 'normal', done: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  };
}

// 从 buildMonthView 返回的 DOM 树里取指定日期格子（hostify 后为纯数据）
function monthCell(view, key) {
  const gridEl = view.children[1];   // [0]=工具行 [1]=网格
  return gridEl.children.find(c => c.dataset && c.dataset.key === key);
}
function cellChips(cell) {
  return cell.children.filter(c => (c.className || '').split(' ').includes('month-ev'));
}
function cellMore(cell) {
  return cell.children.find(c => (c.className || '').split(' ').includes('month-ev-more'));
}

test('monthToggleExpand：同键再调收起，异键替换（同时只允许一格展开）', () => {
  const { sb } = loadApp();
  appEval(sb, `monthToggleExpand('2026-10-15')`);
  assert.strictEqual(appEval(sb, 'monthExpandKey'), '2026-10-15');
  appEval(sb, `monthToggleExpand('2026-10-20')`);
  assert.strictEqual(appEval(sb, 'monthExpandKey'), '2026-10-20', '异键替换而非并存');
  appEval(sb, `monthToggleExpand('2026-10-20')`);
  assert.strictEqual(appEval(sb, 'monthExpandKey'), '', '同键再调收起');
});

test('monthGotoDate：切周视图且该日落在第二张卡（rangeStart = 前一日）', () => {
  const { sb } = loadApp();
  appEval(sb, `monthGotoDate('2026-10-15')`);
  assert.strictEqual(appEval(sb, 'calendarMode'), 'calendar');
  assert.strictEqual(appEval(sb, 'dateKey(rangeStart)'), '2026-10-14', '该日落在第二张卡');
});

test('buildMonthView：收起态最多 3 条 + 「+N」，展开态全部 + 「收起」', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [1, 2, 3, 4, 5].map(i => mkEvent('e' + i, '2026-10-15', '事项' + i)));
  appEval(sb, `monthAnchor = new Date(2026, 9, 1)`);

  // 收起态
  appEval(sb, `monthExpandKey = ''`);
  let view = hostify(appEval(sb, 'buildMonthView()'));
  let cell = monthCell(view, '2026-10-15');
  assert.strictEqual(cellChips(cell).length, 3, '收起态最多 3 条');
  assert.strictEqual(cellMore(cell).textContent, '+2', '超出显示 +N');

  // 展开态
  appEval(sb, `monthExpandKey = '2026-10-15'`);
  view = hostify(appEval(sb, 'buildMonthView()'));
  cell = monthCell(view, '2026-10-15');
  assert.strictEqual(cellChips(cell).length, 5, '展开态显示全部');
  assert.strictEqual(cellMore(cell).textContent, '收起');
  assert.ok(cell.className.includes('expanded'), '展开格带 expanded 类');
});

test('buildMonthView：≤3 条时不出现 +N；展开他格后本格回收起态', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    mkEvent('a1', '2026-10-15', '甲一'), mkEvent('a2', '2026-10-15', '甲二'),
    mkEvent('b1', '2026-10-20', '乙一'), mkEvent('b2', '2026-10-20', '乙二'),
    mkEvent('b3', '2026-10-20', '乙三'), mkEvent('b4', '2026-10-20', '乙四')
  ]);
  appEval(sb, `monthAnchor = new Date(2026, 9, 1)`);
  appEval(sb, `monthExpandKey = '2026-10-20'`);
  const view = hostify(appEval(sb, 'buildMonthView()'));
  const c15 = monthCell(view, '2026-10-15');
  const c20 = monthCell(view, '2026-10-20');
  assert.strictEqual(cellChips(c15).length, 2);
  assert.strictEqual(cellMore(c15), undefined, '≤3 条无 +N');
  assert.strictEqual(cellChips(c20).length, 4, '展开格显示全部');
  assert.ok(!c15.className.includes('expanded') && c20.className.includes('expanded'));
});

test('buildMonthView：事项条带 data-id（右键菜单/拖拽改期的 id 来源）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [mkEvent('e1', '2026-10-15', '例会')]);
  appEval(sb, `monthAnchor = new Date(2026, 9, 1)`);
  appEval(sb, `monthExpandKey = ''`);
  const view = hostify(appEval(sb, 'buildMonthView()'));
  const chip = cellChips(monthCell(view, '2026-10-15'))[0];
  assert.strictEqual(chip.dataset.id, 'e1');
});
