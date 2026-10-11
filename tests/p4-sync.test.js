// ============ P3.4 单元测试：加解密（sync-crypto）+ 同步合并（mergeSyncData）+ 墓碑 ============
// 运行方式：npm test（node --test "tests/*.test.js"）
// sync-crypto 是 CommonJS 模块直接 require；mergeSyncData 走 vm 沙箱加载 app.js。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadApp, appEval, hostify } = require('./helpers.js');
const cryptoMod = require(path.join(__dirname, '..', 'src', 'main', 'sync-crypto.js'));

// ============ sync-crypto：加解密往返 ============

test('genSecret：64 位 hex，两次生成不同', () => {
  const a = cryptoMod.genSecret();
  const b = cryptoMod.genSecret();
  assert.strictEqual(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('encrypt/decrypt：对象往返一致；嵌套中文正常', () => {
  const secret = cryptoMod.genSecret();
  const obj = { title: '中文标题', nested: { a: [1, 2, { b: 'x' }] }, empty: null };
  const enc = cryptoMod.encrypt(secret, obj);
  assert.strictEqual(typeof enc, 'string');
  assert.deepStrictEqual(cryptoMod.decrypt(secret, enc), obj);
});

test('decrypt：错误密钥抛错（GCM 认证失败），篡改密文抛错', () => {
  const s1 = cryptoMod.genSecret();
  const s2 = cryptoMod.genSecret();
  const enc = cryptoMod.encrypt(s1, { v: 1 });
  assert.throws(() => cryptoMod.decrypt(s2, enc), '错误密钥必抛错');
  // 篡改末位字符
  const bad = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + '=';
  assert.throws(() => cryptoMod.decrypt(s1, bad), '篡改载荷必抛错');
});

test('keyFromPairCode：同码同密钥，异码异密钥；encrypt/decrypt 可用派生密钥', () => {
  const k1 = Buffer.from(cryptoMod.keyFromPairCode('123456'));
  const k2 = Buffer.from(cryptoMod.keyFromPairCode('123456'));
  const k3 = Buffer.from(cryptoMod.keyFromPairCode('654321'));
  assert.ok(k1.equals(k2));
  assert.ok(!k1.equals(k3));
  // 派生密钥可直接用于加解密（hex 形态）
  const enc = cryptoMod.encrypt(k1.toString('hex'), { hello: 'pair' });
  assert.deepStrictEqual(cryptoMod.decrypt(k2.toString('hex'), enc), { hello: 'pair' });
  assert.throws(() => cryptoMod.decrypt(k3.toString('hex'), enc));
});

test('encrypt：密钥长度错误抛错（不接受弱密钥）', () => {
  assert.throws(() => cryptoMod.encrypt('abcd', { v: 1 }));
});

// ============ 墓碑存取 ============

test('addTombstone：写入、幂等更新、按 deletedAt 滚动', () => {
  const { sb, storage } = loadApp();
  sb.addTombstone('e1', 'event');
  sb.addTombstone('p1', 'project');
  let list = JSON.parse(storage.getItem('syncTombstones'));
  assert.strictEqual(list.length, 2);
  // 幂等：同 id+kind 再写不翻倍
  sb.addTombstone('e1', 'event');
  list = JSON.parse(storage.getItem('syncTombstones'));
  assert.strictEqual(list.length, 2);
  // 不同 kind 互不影响
  sb.addTombstone('e1', 'project');
  list = JSON.parse(storage.getItem('syncTombstones'));
  assert.strictEqual(list.length, 3);
});

test('deleteEvent 写墓碑；批量删除批量写墓碑', () => {
  const { sb, storage } = loadApp();
  appEval(sb, 'invalidateDerivedCaches()');
  storage.setItem('events', JSON.stringify([
    { id: 'e1', title: 'A', startDate: '2026-10-10', endDate: '2026-10-10' },
    { id: 'e2', title: 'B', startDate: '2026-10-10', endDate: '2026-10-10' },
    { id: 'e3', title: 'C', startDate: '2026-10-10', endDate: '2026-10-10' }
  ]));
  sb.deleteEvent('e1');
  let tombs = JSON.parse(storage.getItem('syncTombstones'));
  assert.ok(tombs.some(t => t.id === 'e1' && t.kind === 'event'), 'deleteEvent 写墓碑');
  sb.batchDeleteEvents(['e2', 'e3']);
  tombs = JSON.parse(storage.getItem('syncTombstones'));
  assert.ok(tombs.some(t => t.id === 'e2') && tombs.some(t => t.id === 'e3'), '批量删除写墓碑');
});

// ============ mergeSyncData：核心合并规则 ============

// 构造快照的便捷函数
const snap = (deviceId, events, projects, tombstones) => ({
  deviceId, at: '2026-10-11T00:00:00.000Z',
  events: events || [], projects: projects || [], tombstones: tombstones || [], pomoHistory: []
});
const ev = (id, title, upd) => ({ id, title, startDate: '2026-10-10', endDate: '2026-10-10', updatedAt: upd });

test('mergeSyncData：双向新增合并（各自独有的记录都保留）', () => {
  const { sb } = loadApp();
  const local = snap('dev-A', [ev('e1', '本地事项', '2026-10-10T01:00:00.000Z')]);
  const remote = snap('dev-B', [ev('e2', '对端事项', '2026-10-10T02:00:00.000Z')]);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.events.length, 2);
  assert.deepStrictEqual(m.stats.events, { added: 1, updated: 0, deleted: 0 });
});

test('mergeSyncData：LWW——updatedAt 新者胜', () => {
  const { sb } = loadApp();
  const local = snap('dev-A', [ev('e1', '旧标题', '2026-10-10T01:00:00.000Z')]);
  const remote = snap('dev-B', [ev('e1', '新标题', '2026-10-10T03:00:00.000Z')]);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.events[0].title, '新标题');
  assert.strictEqual(m.stats.events.updated, 1);
  // 反向：本地更新则不采纳远端旧值
  const m2 = hostify(sb.mergeSyncData(remote, local));
  assert.strictEqual(m2.events[0].title, '新标题');
});

test('mergeSyncData：updatedAt 完全相同时按 deviceId 字典序兜底（确定性）', () => {
  const { sb } = loadApp();
  const upd = '2026-10-10T01:00:00.000Z';
  const a = snap('dev-AAA', [ev('e1', 'A设备的值', upd)]);
  const b = snap('dev-ZZZ', [ev('e1', 'Z设备的值', upd)]);
  // 两端各自合并，结果必须一致（不抖动）
  const m1 = hostify(sb.mergeSyncData(a, b));
  const m2 = hostify(sb.mergeSyncData(b, a));
  assert.strictEqual(m1.events[0].title, m2.events[0].title);
});

test('mergeSyncData：墓碑删除传播——远端删了的本地也删', () => {
  const { sb } = loadApp();
  const local = snap('dev-A', [ev('e1', '还在', '2026-10-10T01:00:00.000Z')]);
  const remote = snap('dev-B', [], [], [
    { id: 'e1', kind: 'event', deletedAt: '2026-10-10T05:00:00.000Z', deviceId: 'dev-B' }
  ]);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.events.length, 0, '墓碑晚于记录 → 删除');
  assert.strictEqual(m.stats.events.deleted, 1);
  // 墓碑本身保留（继续传播给第三台设备）
  assert.strictEqual(m.tombstones.length, 1);
});

test('mergeSyncData：墓碑与编辑竞争——删除晚于编辑则删，编辑晚于删除则复活', () => {
  const { sb } = loadApp();
  const tomb = [{ id: 'e1', kind: 'event', deletedAt: '2026-10-10T05:00:00.000Z', deviceId: 'dev-B' }];
  // 编辑晚于删除 → 记录保留（墓碑输给更新的记录）
  const local = snap('dev-A', [ev('e1', '我又被编辑了', '2026-10-10T06:00:00.000Z')]);
  const remote = snap('dev-B', [], [], tomb);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.events.length, 1, '编辑时间晚于删除时间 → 记录保留');
});

test('mergeSyncData：项目合并同样适用 LWW+墓碑', () => {
  const { sb } = loadApp();
  const local = snap('dev-A', [], [{ id: 'p1', name: '旧名', updatedAt: '2026-10-10T01:00:00.000Z' }]);
  const remote = snap('dev-B', [], [{ id: 'p1', name: '新名', updatedAt: '2026-10-10T02:00:00.000Z' }]);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.projects[0].name, '新名');
  assert.strictEqual(m.stats.projects.updated, 1);
});

test('mergeSyncData：pomoHistory 按日期合并取大值', () => {
  const { sb } = loadApp();
  const local = snap('dev-A', [], [], []);
  local.pomoHistory = [{ date: '2026-10-10', count: 4, minutes: 100 }];
  const remote = snap('dev-B', [], [], []);
  remote.pomoHistory = [{ date: '2026-10-10', count: 2, minutes: 130 }, { date: '2026-10-09', count: 1, minutes: 25 }];
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.strictEqual(m.pomoHistory.length, 2);
  const d10 = m.pomoHistory.find(h => h.date === '2026-10-10');
  assert.strictEqual(d10.count, 4, 'count 取大');
  assert.strictEqual(d10.minutes, 130, 'minutes 取大');
});

test('mergeSyncData：重复事项的 recur/tags 字段随记录同步保留', () => {
  const { sb } = loadApp();
  const recurEv = { ...ev('r1', '每日站会', '2026-10-10T01:00:00.000Z'), recur: { freq: 'daily', interval: 1, until: '' }, tags: ['工作'] };
  const local = snap('dev-A', []);
  const remote = snap('dev-B', [recurEv]);
  const m = hostify(sb.mergeSyncData(local, remote));
  assert.deepStrictEqual(m.events[0].recur, { freq: 'daily', interval: 1, until: '' });
  assert.deepStrictEqual(m.events[0].tags, ['工作']);
});
