// ============ P6.2 单元测试：事项检查清单（子任务） ============
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
function readEvents(storage) {
  return hostify(JSON.parse(storage.getItem('events') || '[]'));
}

test('checklistProgress：无字段/空数组返回 null；有子任务返回 {done,total}', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `checklistProgress({ id: 'x' })`), null, '缺省字段');
  assert.strictEqual(appEval(sb, `checklistProgress({ id: 'x', checklist: [] })`), null, '空数组视为无子任务');
  const p = hostify(appEval(sb, `checklistProgress({ checklist: [{ done: true }, { done: false }, { done: true }] })`));
  assert.deepStrictEqual(p, { done: 2, total: 3 });
});

test('addEvent：checklist 非空时持久化；为空/缺省时不占字段', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `addEvent({ title: '有子任务', startDate: '2026-10-15', endDate: '2026-10-15', checklist: [{ id: 'ck1', text: '步骤一', done: false }] }, true)`);
  appEval(sb, `addEvent({ title: '空子任务', startDate: '2026-10-15', endDate: '2026-10-15', checklist: [] }, true)`);
  appEval(sb, `addEvent({ title: '无子任务', startDate: '2026-10-15', endDate: '2026-10-15' }, true)`);
  const evs = readEvents(storage);
  assert.deepStrictEqual(evs[0].checklist, [{ id: 'ck1', text: '步骤一', done: false }]);
  assert.strictEqual(evs[1].checklist, undefined, '空数组不落字段');
  assert.strictEqual(evs[2].checklist, undefined, '缺省不落字段');
});

test('updateEvent：白名单含 checklist（更新勾选态 / 删空）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [{
    id: 'e1', title: '事项', startDate: '2026-10-15', endDate: '2026-10-15', time: '',
    category: 'work', urgency: 'normal', done: false,
    checklist: [{ id: 'ck1', text: '步骤一', done: false }],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  }]);
  // 勾选
  appEval(sb, `updateEvent('e1', { checklist: [{ id: 'ck1', text: '步骤一', done: true }] })`);
  let ev = readEvents(storage)[0];
  assert.strictEqual(ev.checklist[0].done, true);
  assert.strictEqual(hostify(appEval(sb, `checklistProgress(${JSON.stringify(ev)})`)).done, 1);
  // 删空（编辑表单支持清空子任务）
  appEval(sb, `updateEvent('e1', { checklist: [] })`);
  ev = readEvents(storage)[0];
  assert.deepStrictEqual(ev.checklist, [], '删空写回空数组');
  assert.strictEqual(appEval(sb, `checklistProgress(${JSON.stringify(ev)})`), null, '空数组进度为 null');
  // 不传 checklist 字段时保持原值
  appEval(sb, `updateEvent('e1', { title: '改名' })`);
  ev = readEvents(storage)[0];
  assert.deepStrictEqual(ev.checklist, [], '未传字段不受影响');
  assert.strictEqual(ev.title, '改名');
});

test('旧数据兼容：无 checklist 字段的事项 progress 为 null 且可正常更新', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [{
    id: 'old1', title: '旧事项', startDate: '2026-10-15', endDate: '2026-10-15', time: '',
    category: 'work', urgency: 'normal', done: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  }]);
  assert.strictEqual(appEval(sb, `checklistProgress(loadEvents()[0])`), null);
  appEval(sb, `updateEvent('old1', { checklist: [{ id: 'ck9', text: '新增子任务', done: false }] })`);
  const ev = readEvents(storage)[0];
  assert.strictEqual(ev.checklist.length, 1, '旧数据可后补子任务');
});

test('buildEventItem：有子任务显示进度角标，全完成带 all 类', () => {
  const { sb } = loadApp();
  const html1 = appEval(sb, `buildEventItem({ id: 'a', title: 't', time: '', category: 'work', urgency: 'normal', done: false, checklist: [{ id: '1', text: 'x', done: true }, { id: '2', text: 'y', done: false }] }).innerHTML`);
  assert.ok(html1.includes('event-ck-badge') && html1.includes('▸1/2'), '显示 1/2 角标');
  assert.ok(!html1.includes('event-ck-badge all'), '未全完成不带 all');
  const html2 = appEval(sb, `buildEventItem({ id: 'a', title: 't', time: '', category: 'work', urgency: 'normal', done: false, checklist: [{ id: '1', text: 'x', done: true }] }).innerHTML`);
  assert.ok(html2.includes('event-ck-badge all'), '全完成带 all 类');
  const html3 = appEval(sb, `buildEventItem({ id: 'a', title: 't', time: '', category: 'work', urgency: 'normal', done: false }).innerHTML`);
  assert.ok(!html3.includes('event-ck-badge'), '无子任务无角标');
});
