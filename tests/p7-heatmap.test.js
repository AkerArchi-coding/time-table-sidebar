'use strict';
// P7.5 年热力图：buildHeatmap 周对齐（周一为首行）、53 列×7 行网格、
// 色阶分档（0 档 / 峰值比例 1-4 档 / 小数值直映射）、空数据降级、指标切换
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 沙箱内构造 buildHeatmap 输入（Date 原型属另一 realm，日期断言用字符串 key）
const build = (sb, daily, metric, endKey) =>
  hostify(appEval(sb, `buildHeatmap(${JSON.stringify(daily)}, ${JSON.stringify(metric)}, ${JSON.stringify(endKey)})`));

test('buildHeatmap：371 格、列=周（周一起）行=周一~周日、末格为结束日', () => {
  const { sb } = loadApp();
  const hm = build(sb, [], 'done', '2026-10-11');
  assert.strictEqual(hm.cells.length, 371);
  assert.strictEqual(hm.cols, 53);
  assert.strictEqual(hm.rows, 7);
  assert.strictEqual(hm.max, 0);
  // 末格 = endKey，行 = 周日（第 7 行）
  assert.strictEqual(hm.cells[370].date, '2026-10-11');
  assert.strictEqual(hm.cells[370].row, 6);
  assert.strictEqual(hm.cells[370].col, 52);
  // col/row 恒满足 col = floor(i/7), row = i%7
  assert.strictEqual(hm.cells[7].col, 1);
  assert.strictEqual(hm.cells[7].row, 0);
  assert.strictEqual(hm.cells[100].col, Math.floor(100 / 7));
  assert.strictEqual(hm.cells[100].row, 100 % 7);
  // 每行首格（row=0）都是周一；每行末格（row=6）都是周日
  const dow = (sb2, k) => appEval(sb2, `parseDateKey(${JSON.stringify(k)}).getDay()`);
  for (const i of [0, 7, 98, 364]) {
    assert.strictEqual(hostify(dow(sb, hm.cells[i].date)), 1, `第 ${i} 格应为周一`);
  }
  for (const i of [6, 13, 370]) {
    assert.strictEqual(hostify(dow(sb, hm.cells[i].date)), 0, `第 ${i} 格应为周日`);
  }
});

test('buildHeatmap：峰值比例分档（0.25/0.5/0.75 边界）', () => {
  const { sb } = loadApp();
  const daily = [
    { date: '2026-10-11', done: 10 },   // max → 4 档
    { date: '2026-10-10', done: 8 },    // 0.8 > 0.75 → 4 档
    { date: '2026-10-09', done: 6 },    // 0.6 → 3 档
    { date: '2026-10-08', done: 3 },    // 0.3 → 2 档
    { date: '2026-10-07', done: 1 }     // 0.1 → 1 档
  ];
  const hm = build(sb, daily, 'done', '2026-10-11');
  assert.strictEqual(hm.max, 10);
  const lv = Object.fromEntries(hm.cells.map(c => [c.date, c.level]));
  assert.strictEqual(lv['2026-10-11'], 4);
  assert.strictEqual(lv['2026-10-10'], 4);
  assert.strictEqual(lv['2026-10-09'], 3);
  assert.strictEqual(lv['2026-10-08'], 2);
  assert.strictEqual(lv['2026-10-07'], 1);
  assert.strictEqual(lv['2026-10-06'], 0, '无记录日为 0 档');
  assert.ok(hm.cells.every(c => c.date <= '2026-10-11'), '网格不含结束日之后的日期');
});

test('buildHeatmap：峰值 ≤4 小数值直接映射档位', () => {
  const { sb } = loadApp();
  const daily = [
    { date: '2026-10-11', done: 3 },
    { date: '2026-10-10', done: 1 },
    { date: '2026-10-09', done: 4 }
  ];
  const hm = build(sb, daily, 'done', '2026-10-11');
  const lv = Object.fromEntries(hm.cells.map(c => [c.date, c.level]));
  assert.strictEqual(lv['2026-10-11'], 3);
  assert.strictEqual(lv['2026-10-10'], 1);
  assert.strictEqual(lv['2026-10-09'], 4);
});

test('buildHeatmap：focusMinutes 指标口径切换', () => {
  const { sb } = loadApp();
  const daily = [
    { date: '2026-10-11', done: 0, focusMinutes: 0 },
    { date: '2026-10-10', done: 5, focusMinutes: 0 },
    { date: '2026-10-09', done: 0, focusMinutes: 120 },
    { date: '2026-10-08', done: 0, focusMinutes: 30 }
  ];
  const hm = build(sb, daily, 'focusMinutes', '2026-10-11');
  assert.strictEqual(hm.max, 120);
  const lv = Object.fromEntries(hm.cells.map(c => [c.date, c.level]));
  assert.strictEqual(lv['2026-10-09'], 4);
  assert.strictEqual(lv['2026-10-08'], 1, '30/120 = 0.25，不 > 0.25 → 1 档');
  assert.strictEqual(lv['2026-10-10'], 0, 'done 有值但 focusMinutes 指标为 0');
});

test('buildHeatmap：空数据 / null 输入安全降级', () => {
  const { sb } = loadApp();
  const hm1 = build(sb, [], 'done', '2026-10-11');
  assert.strictEqual(hm1.cells.length, 371);
  assert.ok(hm1.cells.every(c => c.value === 0 && c.level === 0));
  const hm2 = build(sb, null, 'focusMinutes', '2026-10-11');
  assert.strictEqual(hm2.cells.length, 371);
  assert.strictEqual(hm2.max, 0);
});
