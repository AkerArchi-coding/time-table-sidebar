// ============ P9.4 三种导出 / .prj v2 / 恢复加固 ============
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApp, appEval, hostify } = require('./helpers');

const BACKUP_JS = path.join(__dirname, '..', 'src', 'renderer', 'backup.js');
const backupSrc = fs.readFileSync(BACKUP_JS, 'utf8');

// 在加载 app.js 的同一沙箱里再跑 backup.js（生产页面也是两个 script 同域共享 window/localStorage）
function loadBoth() {
  const h = loadApp();
  vm.runInContext(backupSrc, h.sb, { filename: 'backup.js' });
  return h;
}

// ---------------- A. 备份模块 backup.js ----------------

test('Backup：calEventCfg 进业务键，提醒账本/订阅缓存/密钥不进任何键表', () => {
  const { sb } = loadBoth();
  const B = sb.Backup;
  assert.ok(B.BUSINESS_KEYS.includes('calEventCfg'), 'calEventCfg 必须进备份');
  assert.ok(B.BUSINESS_KEYS.includes('calSubscriptions'));
  assert.ok(B.BUSINESS_KEYS.includes('trashEvents'));
  assert.ok(!B.BUSINESS_KEYS.includes('calRemindLedger'), '提醒触发账本不进备份');
  assert.ok(![...B.SETTINGS_KEYS, ...B.BUSINESS_KEYS].some(k => /secret|cache/i.test(k)), '密钥/缓存键不入表');
});

test('Backup：三档备份内容边界（settings 无 business；business/full 含 calEventCfg 槽位）', () => {
  const { sb, storage } = loadBoth();
  storage.setItem('appSettings', JSON.stringify({ x: 1 }));
  storage.setItem('projects', JSON.stringify([{ id: 'p1' }]));
  storage.setItem('calEventCfg', JSON.stringify({ defaultAheadMin: 10 }));
  const B = sb.Backup;

  const s = B.buildBackup('settings', null, '9.9.9');
  assert.strictEqual(s.kind, 'timetable-backup');
  assert.strictEqual(s.type, 'settings');
  assert.strictEqual(s.app_version, '9.9.9');
  assert.ok(s.settings && s.settings.appSettings);
  assert.strictEqual(s.business, undefined, '设置档不得含业务数据');

  const b = B.buildBackup('business');
  assert.ok(b.business.projects);
  assert.ok('calEventCfg' in b.business);
  assert.ok(JSON.parse(b.business.calEventCfg).defaultAheadMin === 10);
  assert.strictEqual(b.settings, undefined, '业务档不含设置');

  const f = B.buildBackup('full');
  assert.ok(f.settings && f.business && f.state);
  assert.ok(f.business.calEventCfg);
});

test('Backup：validateBackup 版本门——v1 放行、v0/更高版本/坏 kind/坏 type 拒绝', () => {
  const { sb } = loadBoth();
  const B = sb.Backup;
  const mk = (over) => Object.assign({
    kind: 'timetable-backup', schema_version: 1, type: 'full'
  }, over);
  assert.strictEqual(B.validateBackup(mk({})).ok, true);
  assert.ok(!B.validateBackup(mk({ schema_version: 0 })).ok);
  assert.ok(!B.validateBackup(mk({ schema_version: 99 })).ok, '来自更新版本的备份必须拒绝');
  assert.ok(!B.validateBackup(mk({ kind: 'nope' })).ok);
  assert.ok(!B.validateBackup(mk({ type: 'weird' })).ok);
  assert.ok(!B.validateBackup(null).ok);
});

test('Backup：planSettingsImport 逐项 added/changed/same，applySettingsKeys 只写勾选键', () => {
  const { sb, storage } = loadBoth();
  const B = sb.Backup;
  storage.setItem('appSettings', JSON.stringify({ a: 1 }));
  storage.setItem('pomoCfg', JSON.stringify({ focus: 25 }));
  const data = {
    settings: {
      appSettings: JSON.stringify({ a: 2 }),                                   // changed
      pomoCfg: JSON.stringify({ focus: 25 }),                                  // same
      daySort: JSON.stringify({ k: 'v' }),                                     // added
      uiTheme: null                                                            // 缺失跳过
    }
  };
  const plan = B.planSettingsImport(data);
  const byKey = Object.fromEntries(plan.map(x => [x.key, x.status]));
  assert.strictEqual(byKey.appSettings, 'changed');
  assert.strictEqual(byKey.pomoCfg, 'same');
  assert.strictEqual(byKey.daySort, 'added');
  assert.ok(!('uiTheme' in byKey));

  // 键序不同但语义相同也判 same
  assert.strictEqual(B.planSettingsImport({
    settings: { pomoCfg: JSON.stringify({ focus: 25, break: 5 }) }
  })[0].status, 'changed', '本机只有 focus，传入多 break → changed');
  storage.setItem('pomoCfg', JSON.stringify({ break: 5, focus: 25 }));
  assert.strictEqual(B.planSettingsImport({
    settings: { pomoCfg: JSON.stringify({ focus: 25, break: 5 }) }
  })[0].status, 'same', '键序差异不应误判');

  const ret = B.applySettingsKeys(data, ['appSettings', 'daySort']);
  assert.deepStrictEqual(hostify(ret.logs).sort(), ['appSettings', 'daySort']);
  assert.strictEqual(JSON.parse(storage.getItem('appSettings')).a, 2);
  assert.strictEqual(JSON.parse(storage.getItem('daySort')).k, 'v');
  assert.strictEqual(JSON.parse(storage.getItem('pomoCfg')).focus, 25, 'same 且未勾选的键不得改写');
});

test('Backup：applyFullReplace 损坏文件返回错误且不动现有数据（异常中断安全）', () => {
  const { sb, storage } = loadBoth();
  storage.setItem('projects', JSON.stringify([{ id: 'keep-me' }]));
  storage.setItem('deviceId', 'dev-local');
  const B = sb.Backup;
  const data = B.buildBackup('full');
  data.business.events = '{not-json';
  const ret = B.applyFullReplace(data);
  assert.strictEqual(ret.ok, false);
  assert.ok(/events/.test(ret.error));
  assert.strictEqual(JSON.parse(storage.getItem('projects'))[0].id, 'keep-me', '校验失败必须保留原数据');
  assert.strictEqual(storage.getItem('deviceId'), 'dev-local');
});

test('Backup：完整恢复往返——业务/设置/calEventCfg/deviceId 全量还原', () => {
  const { sb, storage } = loadBoth();
  storage.setItem('projects', JSON.stringify([{ id: 'p1', phases: [{ id: 'ph1' }] }]));
  storage.setItem('events', JSON.stringify([{ id: 't1', projectId: 'p1', phaseId: 'ph1' }]));
  storage.setItem('calEventCfg', JSON.stringify({ defaultAheadMin: 15 }));
  storage.setItem('calSubscriptions', JSON.stringify([{ id: 's1' }]));
  storage.setItem('deviceId', 'dev-from-backup');
  storage.setItem('appSettings', JSON.stringify({ uiScale: 2 }));
  const B = sb.Backup;
  const data = B.buildBackup('full');

  storage.clear();
  assert.strictEqual(storage.getItem('projects'), null);
  const ret = B.applyFullReplace(data);
  assert.strictEqual(ret.ok, true, ret.error);
  assert.deepStrictEqual(JSON.parse(storage.getItem('projects')), [{ id: 'p1', phases: [{ id: 'ph1' }] }]);
  assert.strictEqual(JSON.parse(storage.getItem('events'))[0].phaseId, 'ph1');
  assert.strictEqual(JSON.parse(storage.getItem('calEventCfg')).defaultAheadMin, 15);
  assert.deepStrictEqual(JSON.parse(storage.getItem('calSubscriptions')), [{ id: 's1' }]);
  assert.strictEqual(storage.getItem('deviceId'), 'dev-from-backup', '完整恢复包含设备身份');
  assert.strictEqual(JSON.parse(storage.getItem('appSettings')).uiScale, 2);
});

test('Backup：业务档合并不覆盖设备身份，但恢复 calEventCfg/订阅/回收站等业务键', () => {
  const { sb, storage } = loadBoth();
  storage.setItem('deviceId', 'dev-local');
  storage.setItem('syncPairs', JSON.stringify([{ id: 'local-pair' }]));
  storage.setItem('calEventCfg', JSON.stringify({ defaultAheadMin: 5 }));
  const B = sb.Backup;
  const data = B.buildBackup('business');
  // 模拟备份来自另一台设备
  data.business.deviceId = 'dev-other';
  data.business.syncPairs = JSON.stringify([{ id: 'other-pair' }]);
  data.business.calEventCfg = JSON.stringify({ defaultAheadMin: 30 });

  const ret = B.applyImport(data, {});
  assert.strictEqual(ret.ok, true);
  assert.strictEqual(storage.getItem('deviceId'), 'dev-local', '业务档合并禁止覆盖设备 ID');
  assert.deepStrictEqual(JSON.parse(storage.getItem('syncPairs')), [{ id: 'local-pair' }], '同步配对不被覆盖');
  assert.strictEqual(JSON.parse(storage.getItem('calEventCfg')).defaultAheadMin, 30);
});

test('Backup：backupManifest 声明包含项（含阶段标签）与排除项（密钥/缓存/账本）', () => {
  const { sb } = loadBoth();
  const mf = sb.Backup.backupManifest('full', true);
  assert.ok(mf.included.some(s => s.includes('阶段')));
  assert.ok(mf.included.some(s => s.includes('sidebar-ui')));
  assert.ok(mf.excluded.some(s => s.includes('sync-secrets')));
  assert.ok(mf.excluded.some(s => s.includes('calSubCache')));
  assert.ok(mf.excluded.some(s => s.includes('calRemindLedger')));
  const ms = sb.Backup.backupManifest('settings', false);
  assert.ok(ms.included.every(s => s.startsWith('设置')));
  assert.ok(!ms.included.some(s => s.includes('sidebar-ui')));
});

// ---------------- B. .prj v2（app.js） ----------------

function seedProjectSandbox(h) {
  // 走 app 自己的存取函数（存在初始化缓存/迁移，直接捅 localStorage 会被缓存遮蔽）
  appEval(h.sb, `saveProjects(${JSON.stringify([{
    id: 'p1', name: '演示项目', revision: 3,
    phases: [
      { id: 'ph-a', name: '阶段A', order: 0, startDate: '2026-01-01', endDate: '2026-01-10' },
      { id: 'ph-b', name: '阶段B', order: 1, startDate: '', endDate: '' }
    ]
  }])})`);
  appEval(h.sb, `saveEvents(${JSON.stringify([
    { id: 't1', title: '事项1', projectId: 'p1', startDate: '2026-01-02', endDate: '2026-01-03',
      phaseId: 'ph-a', tags: ['x'], recur: { freq: 'weekly' }, remindAhead: 20, pomoCount: 4, done: false }
  ])})`);
  // 深拷贝隔离断言要直接读存储
  return JSON.parse(h.storage.getItem('projects'))[0];
}

test('prj：snapshotProject 导出 v2——phases 深拷贝 + 事项扩展字段齐全', () => {
  const h = loadBoth();
  seedProjectSandbox(h);
  const snap = hostify(appEval(h.sb, `snapshotProject('p1')`));
  assert.strictEqual(snap.phases.length, 2);
  assert.strictEqual(snap.phases[0].id, 'ph-a');
  assert.strictEqual(snap.tasks[0].phaseId, 'ph-a');
  assert.deepStrictEqual(snap.tasks[0].tags, ['x']);
  assert.deepStrictEqual(snap.tasks[0].recur, { freq: 'weekly' });
  assert.strictEqual(snap.tasks[0].remindAhead, 20);
  assert.strictEqual(snap.tasks[0].pomoCount, 4);
  // 深拷贝隔离：改快照不影响存储
  appEval(h.sb, `snapshotProject('p1').phases[0].name='MUT'`);
  assert.strictEqual(JSON.parse(h.storage.getItem('projects'))[0].phases[0].name, '阶段A');
  assert.strictEqual(appEval(h.sb, 'PRJ_SCHEMA_VERSION'), 2);
});

test('prj：validatePrjPayload 兼容 v1/v2，拒绝 v3 与坏 phases；normalize 补齐 v1', () => {
  const { sb } = loadBoth();
  const mk = (over) => Object.assign({
    schema_version: 1, kind: 'timetable-project', project_id: 'p1',
    project: { name: 'P' }, tasks: [{ id: 't', title: 'T' }]
  }, over);
  assert.strictEqual(appEval(sb, `validatePrjPayload(${JSON.stringify(mk({}))})`), null, 'v1 必须放行');
  assert.strictEqual(appEval(sb, `validatePrjPayload(${JSON.stringify(mk({
    schema_version: 2, phases: [{ id: 'ph1', name: 'A' }]
  }))})`), null, 'v2 合法 phases 放行');
  assert.ok(appEval(sb, `validatePrjPayload(${JSON.stringify(mk({ schema_version: 3 }))})`), 'v3 必须拒绝');
  assert.ok(appEval(sb, `validatePrjPayload(${JSON.stringify(mk({ schema_version: 2, phases: [{}] }))})`), '阶段无 id 拒绝');
  assert.ok(appEval(sb, `validatePrjPayload(${JSON.stringify(mk({ schema_version: 2, phases: 'x' }))})`), 'phases 非数组拒绝');

  // v1 补齐
  const v1 = mk({});
  const norm = appEval(sb, `(function(){const d=${JSON.stringify(v1)};normalizePrjPayload(d);return d;})()`);
  assert.deepStrictEqual(hostify(norm.phases), []);
  assert.strictEqual(norm.tasks[0].phaseId, '');
  assert.deepStrictEqual(hostify(norm.tasks[0].tags), []);
  assert.strictEqual(norm.tasks[0].recur, null);
  assert.strictEqual(norm.tasks[0].remindAhead, 0);
  assert.strictEqual(norm.tasks[0].pomoCount, 0);
});

test('prj：mergeProjectPhases 按 id 并集——同 id 以导入为准、本地独有保留、新 id 补入、不按名称匹配', () => {
  const { sb } = loadBoth();
  const code = `(function(){
    const p = { phases: [
      { id: 'a', name: '本地A', order: 0, startDate: '2026-01-01', endDate: '2026-01-02' },
      { id: 'b', name: '本地B', order: 1, startDate: '', endDate: '' }
    ]};
    mergeProjectPhases(p, [
      { id: 'a', name: '导入A2', order: 0, startDate: '2026-03-01', endDate: '2026-03-02' },
      { id: 'c', name: '导入C', order: 2, startDate: '', endDate: '' }
    ]);
    return p.phases;
  })()`;
  const phases = hostify(appEval(sb, code));
  assert.strictEqual(phases.length, 3);
  const byId = Object.fromEntries(phases.map(x => [x.id, x]));
  assert.strictEqual(byId.a.name, '导入A2');
  assert.strictEqual(byId.a.startDate, '2026-03-01');
  assert.strictEqual(byId.b.name, '本地B', '本地独有阶段不得被删除');
  assert.strictEqual(byId.c.name, '导入C');
});

test('prj：eventFromIncoming——v1 兜底新字段，v2 原值带入（含 phaseId/tags/recur/remindAhead/pomoCount）', () => {
  const { sb } = loadBoth();
  const v1 = appEval(sb, `eventFromIncoming({id:'t',title:'T',startDate:'2026-01-01'}, 'p1', '')`);
  assert.strictEqual(v1.phaseId, '');
  assert.deepStrictEqual(hostify(v1.tags), []);
  assert.strictEqual(v1.recur, null);
  assert.strictEqual(v1.remindAhead, 0);
  assert.strictEqual(v1.pomoCount, 0);
  assert.strictEqual(v1.projectId, 'p1');
  assert.strictEqual(v1.date, '2026-01-01');

  const v2 = appEval(sb, `eventFromIncoming({id:'t2',title:'T2',startDate:'2026-02-01',phaseId:'ph-a',tags:['k'],recur:{freq:'daily'},remindAhead:15,pomoCount:7}, 'p1', '')`);
  assert.strictEqual(v2.phaseId, 'ph-a');
  assert.deepStrictEqual(hostify(v2.tags), ['k']);
  assert.deepStrictEqual(hostify(v2.recur), { freq: 'daily' });
  assert.strictEqual(v2.remindAhead, 15);
  assert.strictEqual(v2.pomoCount, 7);
});

test('prj：SYNC_TASK_FIELDS 含 phaseId 且缺省为空串（旧基准/旧文件不产生伪冲突）', () => {
  const { sb } = loadBoth();
  assert.ok(appEval(sb, `SYNC_TASK_FIELDS.some(f=>f.key==='phaseId')`));
  assert.strictEqual(appEval(sb, `TASK_FIELD_DEFAULTS.phaseId`), '');
  // 旧 base 事项无 phaseId、v1 导入补齐后也为 '' → 三方一致
  const m = appEval(sb, `merge3('', '', '')`);
  assert.strictEqual(m.state, 'same');
});
