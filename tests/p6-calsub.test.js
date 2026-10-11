// ============ P6.4 单元测试：外部日历只读订阅 ============
// 覆盖：订阅定义存取 / 缓存键命名与读写 / 只读投影（启停过滤、跨日覆盖、重复投影、标记）/ 与业务库隔离
// 运行方式：npm test（node --test "tests/*.test.js"）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// 直写订阅定义后清缓存（与 loadCalSubs 的 calSubsCache/memo 口径一致）
function seedSubs(sb, storage, list) {
  storage.setItem('calSubscriptions', JSON.stringify(list));
  appEval(sb, 'calSubsCache = null');
}
function seedSubEvents(sb, storage, id, events) {
  storage.setItem('calSubCache_' + id, JSON.stringify({ syncedAt: '2026-10-01T00:00:00.000Z', events }));
  appEval(sb, 'calSubEventsMemo.delete(' + JSON.stringify(id) + ')');
}

const SUB = { id: 'cs1', name: '公司日历', url: 'https://example.com/a.ics', enabled: true, lastSync: '', lastError: '' };

test('loadCalSubs/saveCalSubs：存取往返一致，非法条目被过滤', () => {
  const { sb, storage } = loadApp();
  seedSubs(sb, storage, [SUB, { name: '无id' }, null, { id: 'cs2', url: 'https://b.com/x.ics' }]);
  const subs = hostify(appEval(sb, 'loadCalSubs()'));
  assert.strictEqual(subs.length, 2, '缺 id/url 的条目被过滤');
  assert.strictEqual(subs[0].name, '公司日历');
  // 保存后再读应一致
  appEval(sb, `saveCalSubs([{ id: 'cs9', name: 'n', url: 'https://c.com/c.ics', enabled: false, lastSync: '', lastError: '' }])`);
  const again = hostify(appEval(sb, 'loadCalSubs()'));
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].id, 'cs9');
  assert.strictEqual(again[0].enabled, false);
});

test('calSubCacheKey 命名 + 缓存读写 + memo 同步', () => {
  const { sb, storage } = loadApp();
  assert.strictEqual(appEval(sb, `calSubCacheKey('cs1')`), 'calSubCache_cs1');
  appEval(sb, `saveCalSubEvents('cs1', [{ title: '例会', startDate: '2026-10-12', endDate: '2026-10-12', time: '10:00' }])`);
  // memo 命中也应与 storage 一致
  const evs = hostify(appEval(sb, `loadCalSubEvents('cs1')`));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].title, '例会');
  const raw = JSON.parse(storage.getItem('calSubCache_cs1'));
  assert.strictEqual(raw.events.length, 1);
  assert.ok(raw.syncedAt, '写入同步时间戳');
  // 无缓存 → 空数组
  assert.deepStrictEqual(hostify(appEval(sb, `loadCalSubEvents('csX')`)), []);
});

test('removeCalSub：定义与缓存一并移除', () => {
  const { sb, storage } = loadApp();
  seedSubs(sb, storage, [SUB]);
  seedSubEvents(sb, storage, 'cs1', [{ title: 't', startDate: '2026-10-12', endDate: '2026-10-12' }]);
  appEval(sb, `removeCalSub('cs1')`);
  assert.deepStrictEqual(hostify(appEval(sb, 'loadCalSubs()')), []);
  assert.strictEqual(storage.getItem('calSubCache_cs1'), null, '缓存键已清');
});

test('getCalSubEventsByDate：跨日覆盖 + 只读标记 + 停用过滤', () => {
  const { sb, storage } = loadApp();
  seedSubs(sb, storage, [SUB, { ...SUB, id: 'cs2', name: '停用源', enabled: false }]);
  seedSubEvents(sb, storage, 'cs1', [
    { title: '多日会', startDate: '2026-10-12', endDate: '2026-10-14', time: '', category: 'work' },
    { title: '单日会', startDate: '2026-10-13', endDate: '2026-10-13', time: '09:30', category: 'life' }
  ]);
  seedSubEvents(sb, storage, 'cs2', [
    { title: '不该出现', startDate: '2026-10-13', endDate: '2026-10-13', time: '', category: 'work' }
  ]);
  const d13 = hostify(appEval(sb, `getCalSubEventsByDate('2026-10-13')`));
  assert.strictEqual(d13.length, 2, '停用订阅不投影');
  const titles = d13.map(e => e.title);
  assert.ok(titles.includes('多日会') && titles.includes('单日会'));
  // 有时间优先（sortDayEvents 默认 start 正序）
  assert.strictEqual(d13[0].title, '单日会');
  assert.strictEqual(d13[0]._subName, '公司日历', '带来源标记');
  assert.ok(d13.every(e => String(e.id).startsWith('cs1#')), '合成 id 带订阅前缀');
  // 区间外不投影
  assert.deepStrictEqual(hostify(appEval(sb, `getCalSubEventsByDate('2026-10-20')`)), []);
  // 边界日命中（含起含止）
  assert.strictEqual(hostify(appEval(sb, `getCalSubEventsByDate('2026-10-12')`)).length, 1);
  assert.strictEqual(hostify(appEval(sb, `getCalSubEventsByDate('2026-10-14')`)).length, 1);
});

test('getCalSubEventsByDate：重复订阅事项按日投影为只读复合 id', () => {
  const { sb, storage } = loadApp();
  seedSubs(sb, storage, [SUB]);
  seedSubEvents(sb, storage, 'cs1', [
    { title: '每日晨报', startDate: '2026-10-12', endDate: '2026-10-12', time: '08:00', recur: { freq: 'daily', interval: 1, until: '2026-10-15' } }
  ]);
  const d14 = hostify(appEval(sb, `getCalSubEventsByDate('2026-10-14')`));
  assert.strictEqual(d14.length, 1);
  assert.strictEqual(d14[0].id, 'cs1#0@2026-10-14', '重复投影复合 id');
  assert.strictEqual(d14[0].startDate, '2026-10-14');
  assert.strictEqual(d14[0]._subName, '公司日历');
  // until 之外不投影
  assert.deepStrictEqual(hostify(appEval(sb, `getCalSubEventsByDate('2026-10-16')`)), []);
});

test('订阅投影与业务库隔离：不进 getEventsByDate / loadEvents', () => {
  const { sb, storage } = loadApp();
  storage.setItem('events', JSON.stringify([
    { id: 'e1', title: '本地事项', startDate: '2026-10-13', endDate: '2026-10-13', time: '', category: 'work', urgency: 'normal', done: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
  ]));
  appEval(sb, 'invalidateDerivedCaches()');
  seedSubs(sb, storage, [SUB]);
  seedSubEvents(sb, storage, 'cs1', [
    { title: '订阅事项', startDate: '2026-10-13', endDate: '2026-10-13', time: '', category: 'work' }
  ]);
  const local = hostify(appEval(sb, `getEventsByDate('2026-10-13')`));
  assert.strictEqual(local.length, 1, '业务按日查询不含订阅');
  assert.strictEqual(local[0].title, '本地事项');
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 1, '业务库未被写入');
  const subs = hostify(appEval(sb, `getCalSubEventsByDate('2026-10-13')`));
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(subs[0].title, '订阅事项');
});

test('calSubNameFromUrl：主机名优先，非法地址兜底截断', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `calSubNameFromUrl('https://calendar.example.com/xx/a.ics')`), 'calendar.example.com');
  assert.ok(String(appEval(sb, `calSubNameFromUrl('not a url')`)).length > 0);
});
