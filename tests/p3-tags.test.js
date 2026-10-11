// ============ P3.3 单元测试：事项标签（解析 / 汇总 / 筛选 / 迁移） ============
// 运行方式：npm test（node --test "tests/*.test.js"）
// 复用 helpers.js 的 vm 沙箱 harness（加载 app.js，浏览器对象桩化）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// ============ parseTags ============

test('parseTags：中英文逗号混用、去除空白与空项', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(sb.parseTags('工作, 重要，加班')), ['工作', '重要', '加班']);
  assert.deepStrictEqual(hostify(sb.parseTags(' a ，，b ')), ['a', 'b']);
});

test('parseTags：去重（保留首次出现顺序）、上限 6 个截断', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(sb.parseTags('工作,工作, 重要,重要 ,工作')), ['工作', '重要']);
  const seven = '1,2,3,4,5,6,7';
  assert.deepStrictEqual(hostify(sb.parseTags(seven)), ['1', '2', '3', '4', '5', '6']);
});

test('parseTags：单个标签超长截断 12 字符；空/非字符串输入返回 []', () => {
  const { sb } = loadApp();
  const long = '一二三四五六七八九十甲乙丙丁';
  assert.deepStrictEqual(hostify(sb.parseTags(long)), ['一二三四五六七八九十甲乙']);
  assert.deepStrictEqual(hostify(sb.parseTags('')), []);
  assert.deepStrictEqual(hostify(sb.parseTags('   ')), []);
  assert.deepStrictEqual(hostify(sb.parseTags(null)), []);
  assert.deepStrictEqual(hostify(sb.parseTags(undefined)), []);
});

// ============ collectTags ============

test('collectTags：汇总全部事项标签、去重、按中文排序', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  storage.setItem('events', JSON.stringify([
    { id: 'a', title: 'A', tags: ['工作', '重要'] },
    { id: 'b', title: 'B', tags: ['工作', '家庭'] },
    { id: 'c', title: 'C' }              // 无 tags 字段（老数据）也不报错
  ]));
  const tags = hostify(sb.collectTags());
  assert.deepStrictEqual(new Set(tags), new Set(['工作', '重要', '家庭']));
  // 升序校验（中文 localeCompare）
  const sorted = [...tags].sort((x, y) => x.localeCompare(y, 'zh'));
  assert.deepStrictEqual(tags, sorted);
});

test('collectTags：无任何标签时返回空数组', () => {
  const { sb } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  assert.deepStrictEqual(hostify(sb.collectTags()), []);
});

// ============ filterByTag ============

test('filterByTag：空标签原样返回；命中过滤；无 tags 字段的事项被排除', () => {
  const { sb } = loadApp();
  const list = [
    { id: 'a', tags: ['工作'] },
    { id: 'b', tags: ['家庭'] },
    { id: 'c' }                          // 老数据无 tags
  ];
  assert.strictEqual(sb.filterByTag(list, ''), list, '空 tag 原样返回（同引用）');
  const hit = hostify(sb.filterByTag(list, '工作'));
  assert.deepStrictEqual(hit, [{ id: 'a', tags: ['工作'] }]);
  assert.deepStrictEqual(hostify(sb.filterByTag(list, '不存在')), []);
});

// ============ 数据迁移与写穿 ============

test('loadEvents 老数据迁移：无 tags 字段自动补 []', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  storage.setItem('events', JSON.stringify([{ id: 'old1', title: '旧事项' }]));
  const list = hostify(sb.loadEvents());
  assert.deepStrictEqual(list[0].tags, [], '迁移兜底补空数组');
});

test('addEvent：tags 字段落库', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  sb.addEvent({ title: '带标签事项', startDate: '2026-10-10', endDate: '2026-10-10', tags: ['工作', '重要'] });
  const list = JSON.parse(storage.getItem('events'));
  assert.deepStrictEqual(list[0].tags, ['工作', '重要']);
});

test('addEvent：未传 tags 时兜底为 []（不产生 undefined 字段）', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  sb.addEvent({ title: '无标签事项', startDate: '2026-10-10', endDate: '2026-10-10' });
  const list = JSON.parse(storage.getItem('events'));
  assert.deepStrictEqual(list[0].tags, []);
});

test('updateEvent：可更新 tags 字段', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  sb.addEvent({ title: '初始', startDate: '2026-10-10', endDate: '2026-10-10', tags: ['工作'] }, true);
  const id = JSON.parse(storage.getItem('events'))[0].id;
  sb.updateEvent(id, { tags: ['家庭', '周末'] });
  const list = JSON.parse(storage.getItem('events'));
  assert.deepStrictEqual(list[0].tags, ['家庭', '周末']);
});

// ============ 虚拟投影与标签的协同 ============

test('重复事项虚拟投影继承模板 tags，filterByTag 可命中虚拟事项', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  storage.setItem('events', JSON.stringify([
    { id: 'r1', title: '晨会', startDate: '2026-10-05', endDate: '2026-10-05',
      recur: { freq: 'daily', interval: 1, until: '' }, tags: ['工作'] }
  ]));
  const day = hostify(sb.getEventsByDate('2026-10-10'));
  assert.strictEqual(day.length, 1);
  assert.deepStrictEqual(day[0].tags, ['工作'], '虚拟投影继承模板标签');
  assert.strictEqual(day[0].id, 'r1@2026-10-10');
  const filtered = hostify(sb.filterByTag(day, '工作'));
  assert.strictEqual(filtered.length, 1);
  assert.deepStrictEqual(sb.filterByTag(day, '家庭'), []);
});
