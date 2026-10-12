'use strict';
// P10.1 置顶功能：withPinnedFirst 排序、事项/项目置顶切换、同步快照不受置顶影响
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// ---------- withPinnedFirst 排序 ----------

test('withPinnedFirst：pinned 排最前按 pinnedAt 倒序，未置顶保持原相对顺序', () => {
  const { sb } = loadApp();
  const out = hostify(appEval(sb, `withPinnedFirst([
    { id: 'a' },
    { id: 'b', pinned: true, pinnedAt: '2026-10-12T01:00:00.000Z' },
    { id: 'c' },
    { id: 'd', pinned: true, pinnedAt: '2026-10-12T03:00:00.000Z' },
    { id: 'e', pinned: true, pinnedAt: '2026-10-12T02:00:00.000Z' }
  ])`));
  assert.deepStrictEqual(out.map(x => x.id), ['d', 'e', 'b', 'a', 'c']);
});

test('withPinnedFirst：无置顶项时保持原顺序；空数组安全', () => {
  const { sb } = loadApp();
  const out = hostify(appEval(sb, `withPinnedFirst([{ id: 'x' }, { id: 'y' }])`));
  assert.deepStrictEqual(out.map(x => x.id), ['x', 'y']);
  assert.deepStrictEqual(hostify(appEval(sb, `withPinnedFirst([])`)), []);
  // 非 pinned 值（如 false/null）不进置顶组
  const out2 = hostify(appEval(sb, `withPinnedFirst([{ id: 'x', pinned: false }, { id: 'y' }])`));
  assert.deepStrictEqual(out2.map(x => x.id), ['x', 'y']);
});

// ---------- toggleEventPin / toggleProjectPin ----------

test('toggleEventPin：置顶写入 pinned+pinnedAt，再次调用取消并删除字段', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveEvents([{ id: 't1', title: '任务A' }, { id: 't2', title: '任务B' }])`);
  appEval(sb, `toggleEventPin('t1')`);
  let evs = hostify(JSON.parse(storage.getItem('events')));
  assert.strictEqual(evs[0].pinned, true);
  assert.ok(typeof evs[0].pinnedAt === 'string' && evs[0].pinnedAt.length > 0);
  // 取消置顶：字段彻底删除（不留 pinned:false 脏数据）
  appEval(sb, `toggleEventPin('t1')`);
  evs = hostify(JSON.parse(storage.getItem('events')));
  assert.strictEqual('pinned' in evs[0], false);
  assert.strictEqual('pinnedAt' in evs[0], false);
  // 不存在的 id 安全无操作
  appEval(sb, `toggleEventPin('nope')`);
  assert.strictEqual(hostify(JSON.parse(storage.getItem('events'))).length, 2);
});

test('toggleProjectPin：项目置顶切换行为与事项一致', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveProjects([{ id: 'p1', name: '项目一' }])`);
  appEval(sb, `toggleProjectPin('p1')`);
  let ps = hostify(JSON.parse(storage.getItem('projects')));
  assert.strictEqual(ps[0].pinned, true);
  assert.ok(ps[0].pinnedAt);
  appEval(sb, `toggleProjectPin('p1')`);
  ps = hostify(JSON.parse(storage.getItem('projects')));
  assert.strictEqual('pinned' in ps[0], false);
  assert.strictEqual('pinnedAt' in ps[0], false);
});

// ---------- 同步/导出快照隔离 ----------

test('normTaskSnap：pinned/pinnedAt 不进同步快照，置顶不触发三方合并 diff', () => {
  const { sb } = loadApp();
  const snap = hostify(appEval(sb, `normTaskSnap({ id: 't1', title: 'X', pinned: true, pinnedAt: '2026-10-12T00:00:00.000Z' })`));
  assert.strictEqual('pinned' in snap, false);
  assert.strictEqual('pinnedAt' in snap, false);
  // updatedAt 不被置顶改动的前提：toggle 函数不写 updatedAt（白名单字段无变化 → 无 diff）
  const { sb: sb2, storage } = loadApp();
  appEval(sb2, `saveEvents([{ id: 't1', title: 'X', updatedAt: '2026-01-01T00:00:00.000Z' }])`);
  appEval(sb2, `toggleEventPin('t1')`);
  const ev = hostify(JSON.parse(storage.getItem('events')))[0];
  assert.strictEqual(ev.updatedAt, '2026-01-01T00:00:00.000Z');
});
