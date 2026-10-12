// ============ P11 单元测试：重复「持续方式」（时长预设 / 按次数） ============
// 运行方式：npm test（node --test "tests/*.test.js"）
// 复用 helpers.js 的 vm 沙箱 harness（加载 app.js，浏览器对象桩化）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers.js');

// ============ recurPresetUntil（时长预设 → 截止日，含开始日当天） ============

test('recurPresetUntil：一周 = 起始日 + 6 天', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurPresetUntil('1w', '2026-10-05'), '2026-10-11');
});

test('recurPresetUntil：一个月含跨月钳制（1/31 → 2/28）', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurPresetUntil('1m', '2026-10-05'), '2026-11-04');
  assert.strictEqual(sb.recurPresetUntil('1m', '2026-01-31'), '2026-02-28');
});

test('recurPresetUntil：一年含跨年钳制（2024 闰年 2/29 → 次年 2/28）', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurPresetUntil('1y', '2026-10-05'), '2027-10-04');
  assert.strictEqual(sb.recurPresetUntil('1y', '2024-02-29'), '2025-02-28');
});

test('recurPresetUntil：无开始日期返回空（表单侧退化为永远重复）', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurPresetUntil('1m', ''), '');
  assert.strictEqual(sb.recurPresetUntil('bad', '2026-10-05'), '');
});

// ============ recurCountUntil（第 N 次出现日 = 截止日，口径与 recurMatchesDate 一致） ============

test('recurCountUntil：daily 第 N 次 = 起始日 + N-1', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurCountUntil('daily', '2026-10-05', 1), '2026-10-05');
  assert.strictEqual(sb.recurCountUntil('daily', '2026-10-05', 5), '2026-10-09');
});

test('recurCountUntil：weekly 第 N 次 = 起始日 + 7(N-1)', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurCountUntil('weekly', '2026-10-05', 3), '2026-10-19');
});

test('recurCountUntil：weekdays 跳过周末（10-09 周五起，第 2 次 = 下周一）', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurCountUntil('weekdays', '2026-10-09', 2), '2026-10-12');
  assert.strictEqual(sb.recurCountUntil('weekdays', '2026-10-09', 3), '2026-10-13');
});

test('recurCountUntil：monthly 跳过无该日号的月份（1/31 第 2 次 = 3/31）', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurCountUntil('monthly', '2026-01-31', 1), '2026-01-31');
  assert.strictEqual(sb.recurCountUntil('monthly', '2026-01-31', 2), '2026-03-31');
  assert.strictEqual(sb.recurCountUntil('monthly', '2026-01-10', 3), '2026-03-10');
});

test('recurCountUntil：非法参数返回空', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurCountUntil('daily', '', 3), '');
  assert.strictEqual(sb.recurCountUntil('daily', '2026-10-05', 0), '');
  assert.strictEqual(sb.recurCountUntil('none', '2026-10-05', 3), '');
});

// ============ recurModeOf（编辑预填：由 until/count 反推持续方式） ============

test('recurModeOf：反推 永远/一周/一个月/一年/自定义', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '', 0), 'forever');
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2026-10-11', 0), '1w');
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2026-11-04', 0), '1m');
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2027-10-04', 0), '1y');
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2026-10-20', 0), 'custom');
});

test('recurModeOf：有 count 且与现值吻合优先识别为按次数', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2026-10-09', 5), 'count');
  assert.strictEqual(sb.recurModeOf('weekly', '2026-10-05', '2026-10-19', 3), 'count');
  // count 与 until 不吻合（用户手改过截止日）→ 回落到其它识别
  assert.strictEqual(sb.recurModeOf('daily', '2026-10-05', '2026-10-20', 5), 'custom');
});

// ============ 与现有投影口径联动：count-until 作为 until 时命中次数正确 ============

test('口径联动：daily 3 次的 until 在投影中恰好命中 3 天', () => {
  const { sb } = loadApp();
  const start = '2026-10-05';
  const until = sb.recurCountUntil('daily', start, 3);
  assert.strictEqual(until, '2026-10-07');
  const recur = { freq: 'daily', interval: 1, until };
  let hits = 0;
  for (let d = start; d <= '2026-10-31'; d = sb.addDaysKey(d, 1)) {
    if (sb.recurMatchesDate(recur, start, d)) hits++;
  }
  assert.strictEqual(hits, 3);
});
