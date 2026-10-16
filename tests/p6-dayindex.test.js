// ============ P6.3 单元测试：按日索引缓存 + 派生缓存统一失效 ============
// 运行方式：npm test（node --test "tests/*.test.js"）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// 直写 storage 后必须让派生缓存统一失效（loadApp 初始化时已缓存空数组）
function seedEvents(sb, storage, list) {
  storage.setItem('events', JSON.stringify(list));
  appEval(sb, 'invalidateDerivedCaches()');
}
function mkEvent(id, s, e, extra) {
  return Object.assign({
    id, title: id, startDate: s, endDate: e, time: '', category: 'work',
    urgency: 'normal', done: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
  }, extra || {});
}
const ids = (list) => list.map(e => e.id).sort();

test('索引口径与全量扫描一致：单日/多日/无日期/重复投影', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    mkEvent('single', '2026-10-15', '2026-10-15'),
    mkEvent('multi', '2026-10-14', '2026-10-16'),
    mkEvent('nodate', '', ''),
    mkEvent('recurDaily', '2026-10-10', '2026-10-10', { recur: { freq: 'daily', interval: 1, until: '' } })
  ]);
  const d15 = ids(hostify(appEval(sb, `getEventsByDate('2026-10-15')`)));
  assert.deepStrictEqual(d15, ['multi', 'recurDaily@2026-10-15', 'single'], '15 日：单日+多日+投影');
  const d16 = ids(hostify(appEval(sb, `getEventsByDate('2026-10-16')`)));
  assert.deepStrictEqual(d16, ['multi', 'recurDaily@2026-10-16'], '16 日：多日+投影');
  const d17 = ids(hostify(appEval(sb, `getEventsByDate('2026-10-17')`)));
  assert.deepStrictEqual(d17, ['recurDaily@2026-10-17'], '17 日：仅投影');
  assert.ok(!d15.includes('nodate'), '无日期事项不进任何一天');
});

test('result 缓存：同日两次查询返回同一数组引用（O(1) 命中）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [mkEvent('a', '2026-10-15', '2026-10-15')]);
  assert.strictEqual(appEval(sb, `getEventsByDate('2026-10-15') === getEventsByDate('2026-10-15')`), true);
});

test('saveEvents 写路径索引失效：新增事项立即可查', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [mkEvent('a', '2026-10-15', '2026-10-15')]);
  appEval(sb, `getEventsByDate('2026-10-15')`);   // 建立缓存
  appEval(sb, `addEvent({ title: '新增', startDate: '2026-10-15', endDate: '2026-10-15' }, true)`);
  const after = ids(hostify(appEval(sb, `getEventsByDate('2026-10-15')`)));
  assert.strictEqual(after.length, 2, 'saveEvents 后索引已重建');
  assert.ok(after.includes('a'));
});

test('recurDoneSet 后索引失效：投影完成态按日刷新', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    mkEvent('r1', '2026-10-10', '2026-10-10', { recur: { freq: 'daily', interval: 1, until: '' } })
  ]);
  assert.strictEqual(appEval(sb, `getEventsByDate('2026-10-15')[0].done`), false);
  appEval(sb, `recurDoneSet('r1', '2026-10-15', true)`);
  assert.strictEqual(appEval(sb, `getEventsByDate('2026-10-15')[0].done`), true, '勾选后投影完成态刷新');
  appEval(sb, `recurDoneSet('r1', '2026-10-15', false)`);
  assert.strictEqual(appEval(sb, `getEventsByDate('2026-10-15')[0].done`), false, '取消勾选同样刷新');
});

test('invalidateDerivedCaches：直写 storage 后统一失效（备份导入路径口径）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [mkEvent('a', '2026-10-15', '2026-10-15')]);
  appEval(sb, `getEventsByDate('2026-10-15')`);
  // 模拟 applyImport 直写 localStorage（不走 saveEvents）
  storage.setItem('events', JSON.stringify([mkEvent('a', '2026-10-15', '2026-10-15'), mkEvent('imported', '2026-10-15', '2026-10-15')]));
  appEval(sb, 'invalidateDerivedCaches()');
  const after = ids(hostify(appEval(sb, `getEventsByDate('2026-10-15')`)));
  assert.deepStrictEqual(after, ['a', 'imported'], '直写后失效 → 索引读到新数据');
});

test('排序口径保持：索引结果仍走 sortDayEvents（时间升序）', () => {
  const { sb, storage } = loadApp();
  seedEvents(sb, storage, [
    mkEvent('late', '2026-10-15', '2026-10-15', { time: '18:00' }),
    mkEvent('early', '2026-10-15', '2026-10-15', { time: '09:00' }),
    mkEvent('notime', '2026-10-15', '2026-10-15')
  ]);
  const order = hostify(appEval(sb, `getEventsByDate('2026-10-15').map(e => e.id)`));
  // sortDayEvents 默认按 time 升序（无时间排前或后由其实现决定，这里锚定实际顺序防回归）
  assert.strictEqual(order.indexOf('early') < order.indexOf('late'), true, '早时间排前');
});

test('notifyStorageFail：10s 节流（重复失败只提示一次的计数口径）', () => {
  const { sb } = loadApp();
  // 注入计数用 toast，观察节流行为（首次提示、窗口内不再提示）
  appEval(sb, `globalThis.__toastCount = 0; TTCore.storage.configure({ toast: function(){ globalThis.__toastCount++; } })`);
  appEval(sb, `notifyStorageFail(new Error('QuotaExceeded'))`);
  assert.strictEqual(appEval(sb, 'globalThis.__toastCount'), 1, '首次失败提示一次');
  appEval(sb, `notifyStorageFail(new Error('QuotaExceeded'))`);
  assert.strictEqual(appEval(sb, 'globalThis.__toastCount'), 1, '节流窗口内不重复提示');
});
