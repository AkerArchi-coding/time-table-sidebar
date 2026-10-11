'use strict';
// P8.1 项目阶段层级（Phase）：数据迁移、增删改、删除阶段事项 phaseId 清空、阶段标签辅助函数
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 造一个基础项目（其余字段由 loadProjects 归一化补齐）
function seedProject(sb, p) {
  const base = { id: 'p1', name: '测试项目', category: 'work', priority: 'medium', phases: [] };
  appEval(sb, `saveProjects([Object.assign(${JSON.stringify(base)}, ${JSON.stringify(p)})])`);
}
// 直接往 localStorage 写旧版项目数据（无 phases 字段），用于迁移测试
function seedLegacyProject(sb, p) {
  const base = { id: 'p1', name: '旧版项目', category: 'work', priority: 'medium' };
  const data = Object.assign({}, base, p);
  appEval(sb, `localStorage.setItem('projects', JSON.stringify([${JSON.stringify(data)}]))`);
  appEval(sb, `projectsCache = null`);   // 清空缓存，强制 loadProjects 重新读取并迁移
}
// 造一个基础事项
function seedEvent(sb, ev) {
  const base = { id: 'e1', title: '测试事项', startDate: '2026-10-10', endDate: '2026-10-10', category: 'work', urgency: 'normal', done: false, phaseId: '' };
  appEval(sb, `saveEvents([Object.assign(${JSON.stringify(base)}, ${JSON.stringify(ev)})])`);
}
// 直接往 localStorage 写旧版事项数据（无 phaseId 字段），用于迁移测试
function seedLegacyEvent(sb, ev) {
  const base = { id: 'e1', title: '旧版事项', startDate: '2026-10-10', endDate: '2026-10-10', category: 'work', urgency: 'normal', done: false };
  const data = Object.assign({}, base, ev);
  appEval(sb, `localStorage.setItem('events', JSON.stringify([${JSON.stringify(data)}]))`);
  appEval(sb, `eventsCache = null`);
}

test('loadProjects 迁移：无 phases 字段时补空数组，有 phases 时保留', () => {
  const { sb } = loadApp();
  // 无 phases（旧版数据）
  seedLegacyProject(sb, { id: 'p1', name: '无阶段项目' });
  const p1 = hostify(appEval(sb, `loadProjects()[0]`));
  assert.ok(Array.isArray(p1.phases));
  assert.strictEqual(p1.phases.length, 0);
  // 有 phases
  appEval(sb, `saveProjects([{id:'p2', name:'有阶段', phases:[{id:'ph1', name:'设计', order:0}]}])`);
  appEval(sb, `projectsCache = null`);
  const p2 = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p2.phases.length, 1);
  assert.strictEqual(p2.phases[0].name, '设计');
});

test('loadEvents 迁移：无 phaseId 时补空字符串', () => {
  const { sb } = loadApp();
  seedLegacyEvent(sb, { id: 'e1', title: '无阶段事项' });
  const ev = hostify(appEval(sb, `loadEvents()[0]`));
  assert.strictEqual(ev.phaseId, '');
});

test('addPhase：新增阶段，order 递增，revision 更新', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A' });
  const ph = hostify(appEval(sb, `addPhase('p1', '需求分析')`));
  assert.strictEqual(ph.name, '需求分析');
  assert.strictEqual(ph.order, 0);
  const p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases.length, 1);
  assert.ok(p.revision > 1);
  // 再新增一个
  appEval(sb, `addPhase('p1', '开发')`);
  const p2 = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p2.phases.length, 2);
  assert.strictEqual(p2.phases[1].name, '开发');
  assert.strictEqual(p2.phases[1].order, 1);
});

test('renamePhase：重命名阶段，空名称保持原值', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A', phases: [{ id: 'ph1', name: '旧名', order: 0 }] });
  assert.ok(appEval(sb, `renamePhase('p1', 'ph1', '新名')`));
  let p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases[0].name, '新名');
  // 空名称不改变
  assert.ok(appEval(sb, `renamePhase('p1', 'ph1', '   ')`));
  p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases[0].name, '新名');
  // 不存在的项目/阶段返回 false
  assert.strictEqual(appEval(sb, `renamePhase('noexist', 'ph1', 'x')`), false);
  assert.strictEqual(appEval(sb, `renamePhase('p1', 'noexist', 'x')`), false);
});

test('movePhase：上移/下移，边界返回 false，重排后 order 连续', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A', phases: [
    { id: 'ph1', name: '一', order: 0 },
    { id: 'ph2', name: '二', order: 1 },
    { id: 'ph3', name: '三', order: 2 }
  ]});
  // 第一个上移失败
  assert.strictEqual(appEval(sb, `movePhase('p1', 'ph1', -1)`), false);
  // 最后一个下移失败
  assert.strictEqual(appEval(sb, `movePhase('p1', 'ph3', 1)`), false);
  // ph2 上移 → 与 ph1 交换
  assert.ok(appEval(sb, `movePhase('p1', 'ph2', -1)`));
  const p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases[0].id, 'ph2');
  assert.strictEqual(p.phases[1].id, 'ph1');
  assert.strictEqual(p.phases[0].order, 0);
  assert.strictEqual(p.phases[1].order, 1);
});

test('deletePhase：删除阶段，该阶段事项 phaseId 清空', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A', phases: [{ id: 'ph1', name: '设计', order: 0 }] });
  // 一次性保存两个事项（saveEvents 是整体覆盖）
  appEval(sb, `saveEvents([
    { id: 'e1', title: '设计事项', startDate: '2026-10-10', endDate: '2026-10-10', category: 'work', urgency: 'normal', done: false, projectId: 'p1', phaseId: 'ph1' },
    { id: 'e2', title: '其他事项', startDate: '2026-10-10', endDate: '2026-10-10', category: 'work', urgency: 'normal', done: false, projectId: 'p1', phaseId: '' }
  ])`);
  assert.ok(appEval(sb, `deletePhase('p1', 'ph1')`));
  const p = hostify(appEval(sb, `loadProjects()[0]`));
  assert.strictEqual(p.phases.length, 0);
  const ev1 = hostify(appEval(sb, `loadEvents().find(e => e.id === 'e1')`));
  assert.strictEqual(ev1.phaseId, '');
  const ev2 = hostify(appEval(sb, `loadEvents().find(e => e.id === 'e2')`));
  assert.strictEqual(ev2.phaseId, '');
});

test('phaseNameMap：返回 {phaseId: name} 映射', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A', phases: [
    { id: 'ph1', name: '设计', order: 0 },
    { id: 'ph2', name: '开发', order: 1 }
  ]});
  const m = hostify(appEval(sb, `phaseNameMap('p1')`));
  assert.strictEqual(m.ph1, '设计');
  assert.strictEqual(m.ph2, '开发');
  // 不存在的项目返回空对象
  const m2 = hostify(appEval(sb, `phaseNameMap('noexist')`));
  assert.deepStrictEqual(m2, {});
});

test('phaseOptionsHtml：无项目/无阶段返回空串，有阶段返回 option 列表', () => {
  const { sb } = loadApp();
  // 无项目
  assert.strictEqual(appEval(sb, `phaseOptionsHtml('', '')`), '');
  // 项目无阶段
  seedProject(sb, { id: 'p1', name: '无阶段' });
  assert.strictEqual(appEval(sb, `phaseOptionsHtml('p1', '')`), '');
  // 有阶段
  appEval(sb, `saveProjects([{id:'p2', name:'有阶段', phases:[{id:'ph1', name:'设计', order:0}, {id:'ph2', name:'开发', order:1}]}])`);
  const html = appEval(sb, `phaseOptionsHtml('p2', 'ph2')`);
  assert.ok(html.includes('value="ph1"'));
  assert.ok(html.includes('value="ph2" selected'));
  assert.ok(html.includes('设计'));
  assert.ok(html.includes('开发'));
});

test('phaseBadgeHtml：有 phaseId 且项目有阶段时返回标签，否则空串', () => {
  const { sb } = loadApp();
  seedProject(sb, { id: 'p1', name: '项目A', phases: [{ id: 'ph1', name: '设计', order: 0 }] });
  // 有阶段
  const html = appEval(sb, `phaseBadgeHtml({phaseId:'ph1', projectId:'p1'})`);
  assert.ok(html.includes('设计'));
  assert.ok(html.includes('gantt-phase-tag'));
  // 无 phaseId
  assert.strictEqual(appEval(sb, `phaseBadgeHtml({phaseId:'', projectId:'p1'})`), '');
  // 无项目
  assert.strictEqual(appEval(sb, `phaseBadgeHtml({phaseId:'ph1', projectId:''})`), '');
  // 阶段不存在
  assert.strictEqual(appEval(sb, `phaseBadgeHtml({phaseId:'noexist', projectId:'p1'})`), '');
});
