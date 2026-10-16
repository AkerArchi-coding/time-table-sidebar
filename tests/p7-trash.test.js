'use strict';
// P7.1 回收站与撤销删除：存取/上限/过期、删除入站、恢复（updatedAt/墓碑/去重）、批量撤销、备份键覆盖
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, appEval, hostify } = require('./helpers');

// backup-core.js 为核心层全局脚本（window.Backup），在同一沙箱内求值读取导出（M0 已自 renderer/backup.js 平移）
const BACKUP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backup-core.js'), 'utf8');

// 造一个基础事项（其余字段由 loadEvents 归一化补齐）
function seedEvent(sb, ev) {
  const base = { id: 'e1', title: '测试事项', startDate: '2026-10-10', endDate: '2026-10-10', category: 'work', urgency: 'normal', done: false };
  appEval(sb, `saveEvents([Object.assign(${JSON.stringify(base)}, ${JSON.stringify(ev)})])`);
}

test('trashPush：加 deletedAt、最新在前、同 id 去重保留最新、200 条滚动', () => {
  const { sb } = loadApp();
  const r = hostify(appEval(sb, `trashPush([{ id: 'a', title: '旧' }], { id: 'x', title: '新' }, new Date('2026-10-11T00:00:00Z'))`));
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].id, 'x', '新条目在前');
  assert.strictEqual(r[0].deletedAt, '2026-10-11T00:00:00.000Z');
  assert.strictEqual(r[1].id, 'a', '原有条目保留');
  // 同 id 去重：保留最新删除记录
  const r2 = hostify(appEval(sb, `trashPush(trashPush([], { id: 'x', title: '一' }, new Date('2026-10-01T00:00:00Z')), { id: 'x', title: '二' }, new Date('2026-10-02T00:00:00Z'))`));
  assert.strictEqual(r2.length, 1);
  assert.strictEqual(r2[0].title, '二');
  // 200 条滚动截断
  const r3 = hostify(appEval(sb, `(() => { let l = []; for (let i = 0; i < 210; i++) l = trashPush(l, { id: 'e' + i }, new Date(2026, 0, 1)); return l; })()`));
  assert.strictEqual(r3.length, 200);
  assert.strictEqual(r3[0].id, 'e209');
  assert.strictEqual(r3[199].id, 'e10');
});

test('trashPurge：清理超 30 天条目；缺 deletedAt 视为极旧', () => {
  const { sb } = loadApp();
  const list = JSON.stringify([
    { id: 'fresh', deletedAt: '2026-10-10T00:00:00Z' },
    { id: 'old', deletedAt: '2026-09-01T00:00:00Z' },
    { id: 'noinfo' }
  ]);
  const r = hostify(appEval(sb, `trashPurge(${list}, new Date('2026-10-11T00:00:00Z'))`));
  assert.deepStrictEqual(r.map(t => t.id), ['fresh']);
});

test('deleteEvent：事项进回收站（含 deletedAt）+ 从 events 移除 + 写墓碑', () => {
  const { sb, storage } = loadApp();
  seedEvent(sb, { id: 'e1', title: '周报', projectId: 'p1' });
  appEval(sb, `deleteEvent('e1')`);
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 0);
  const trash = JSON.parse(storage.getItem('trashEvents'));
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].id, 'e1');
  assert.strictEqual(trash[0].title, '周报');
  assert.ok(trash[0].deletedAt, '回收站条目带删除时间');
  const tombs = JSON.parse(storage.getItem('syncTombstones'));
  assert.ok(tombs.some(t => t.id === 'e1' && t.kind === 'event'), '删除仍写同步墓碑');
});

test('deleteEvent：虚拟投影 id 作用于模板且模板整体进回收站', () => {
  const { sb, storage } = loadApp();
  seedEvent(sb, { id: 'tpl1', title: '晨会', recur: { freq: 'daily' } });
  appEval(sb, `deleteEvent('tpl1@2026-10-11')`);
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 0);
  const trash = JSON.parse(storage.getItem('trashEvents'));
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].id, 'tpl1');
});

test('restoreFromTrash：恢复写回 events、updatedAt 刷新、清回收站条目与墓碑', () => {
  const { sb, storage } = loadApp();
  seedEvent(sb, { id: 'e1', title: '周报', projectId: 'p1' });
  appEval(sb, `deleteEvent('e1')`);
  assert.strictEqual(appEval(sb, `restoreFromTrash(['e1'])`), 1);
  const evs = hostify(appEval(sb, 'loadEvents()'));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].id, 'e1');
  assert.strictEqual(evs[0].title, '周报');
  assert.ok(evs[0].updatedAt, '恢复后 updatedAt 刷新（晚于墓碑，同步不会再删它）');
  assert.ok(!('deletedAt' in evs[0]), '恢复后不带 deletedAt 标记');
  assert.strictEqual(JSON.parse(storage.getItem('trashEvents')).length, 0);
  const tombs = JSON.parse(storage.getItem('syncTombstones'));
  assert.ok(!tombs.some(t => t.id === 'e1' && t.kind === 'event'), '恢复后清除本地事件墓碑');
});

test('restoreFromTrash：同 id 事项已存在时跳过且不覆盖现有数据', () => {
  const { sb, storage } = loadApp();
  seedEvent(sb, { id: 'e1', title: 'A' });
  appEval(sb, `deleteEvent('e1')`);
  // 删除后手工新建同 id 事项
  appEval(sb, `saveEvents(loadEvents().concat([{ id: 'e1', title: 'B', startDate: '2026-10-11', endDate: '2026-10-11' }]))`);
  assert.strictEqual(appEval(sb, `restoreFromTrash(['e1'])`), 0);
  const evs = hostify(appEval(sb, 'loadEvents()'));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].title, 'B', '现有同 id 事项不被覆盖');
  assert.strictEqual(JSON.parse(storage.getItem('trashEvents')).length, 0, '对应回收站条目被消费移除');
});

test('batchDeleteEvents：多项入回收站，恢复数量正确', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveEvents([
    { id: 'a', title: 'A', startDate: '2026-10-10', endDate: '2026-10-10' },
    { id: 'b', title: 'B', startDate: '2026-10-10', endDate: '2026-10-10' },
    { id: 'c', title: 'C', startDate: '2026-10-10', endDate: '2026-10-10' }
  ])`);
  appEval(sb, `batchDeleteEvents(['a', 'b'])`);
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 1);
  assert.strictEqual(JSON.parse(storage.getItem('trashEvents')).length, 2);
  assert.strictEqual(appEval(sb, `restoreFromTrash(['a', 'b'])`), 2);
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 3);
});

test('purgeTrashItems：仅移除回收站条目，不动 events 与墓碑', () => {
  const { sb, storage } = loadApp();
  seedEvent(sb, { id: 'e1', title: 'A' });
  appEval(sb, `deleteEvent('e1')`);
  appEval(sb, `purgeTrashItems(['e1'])`);
  assert.strictEqual(JSON.parse(storage.getItem('trashEvents')).length, 0);
  assert.strictEqual(hostify(appEval(sb, 'loadEvents()')).length, 0);
  const tombs = JSON.parse(storage.getItem('syncTombstones'));
  assert.ok(tombs.some(t => t.id === 'e1'), '彻底删除不动墓碑（删除语义已在删除时确立）');
});

test('trashPruneOnOpen：打开面板时清理超期条目并回写存储', () => {
  const { sb, storage } = loadApp();
  storage.setItem('trashEvents', JSON.stringify([
    { id: 'fresh', title: '新', deletedAt: new Date(Date.now() - 86400000).toISOString() },
    { id: 'stale', title: '旧', deletedAt: '2020-01-01T00:00:00Z' }
  ]));
  const list = hostify(appEval(sb, 'trashPruneOnOpen()'));
  assert.deepStrictEqual(list.map(t => t.id), ['fresh']);
  assert.strictEqual(JSON.parse(storage.getItem('trashEvents')).length, 1);
});

test('loadTrashEvents：损坏 JSON 兜底为空数组', () => {
  const { sb, storage } = loadApp();
  storage.setItem('trashEvents', '{oops');
  assert.deepStrictEqual(hostify(appEval(sb, 'loadTrashEvents()')), []);
});

test('BUSINESS_KEYS 含 trashEvents（进三档备份，不进同步快照）', () => {
  const { sb, storage } = loadApp();
  appEval(sb, BACKUP_SRC);
  const keys = hostify(appEval(sb, 'window.Backup.BUSINESS_KEYS'));
  assert.ok(keys.includes('trashEvents'), 'trashEvents 应在 BUSINESS_KEYS 中');
  storage.setItem('trashEvents', JSON.stringify([{ id: 't1', title: '回收站事项' }]));
  const snapshot = hostify(appEval(sb, 'window.Backup.buildBackup("business").business'));
  assert.ok('trashEvents' in snapshot, 'business 备份应收集 trashEvents');
  const syncSnap = hostify(appEval(sb, 'buildSyncSnapshot()'));
  assert.ok(!('trashEvents' in syncSnap), '局域网同步快照不包含回收站');
});
