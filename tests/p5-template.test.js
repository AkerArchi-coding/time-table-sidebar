'use strict';
// P5.3 事项模板：存取/去重/删除 + chips 行 HTML + 备份键覆盖
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, appEval, hostify } = require('./helpers');

// backup.js 为渲染层全局脚本（window.Backup），在同一沙箱内求值读取导出
const BACKUP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'backup.js'), 'utf8');

test('saveEventAsTemplate：保存字段快照且不携带日期字段', () => {
  const { sb } = loadApp();
  const ev = {
    id: 'e1', title: '每日站会', time: '09:30', startDate: '2026-10-11', endDate: '2026-10-11',
    category: 'work', urgency: 'urgent', recur: { freq: 'daily', until: '' },
    tags: ['例会'], description: '15 分钟', done: false, projectId: 'p1'
  };
  assert.strictEqual(appEval(sb, `saveEventAsTemplate(${JSON.stringify(ev)})`), 'saved');
  const list = hostify(appEval(sb, 'loadEventTemplates()'));
  assert.strictEqual(list.length, 1);
  const t = list[0];
  assert.strictEqual(t.title, '每日站会');
  assert.strictEqual(t.time, '09:30');
  assert.strictEqual(t.category, 'work');
  assert.strictEqual(t.urgency, 'urgent');
  assert.deepStrictEqual(t.recur, { freq: 'daily', until: '' });
  assert.deepStrictEqual(t.tags, ['例会']);
  assert.strictEqual(t.description, '15 分钟');
  assert.ok(String(t.id).startsWith('tpl-'), '模板 id 以 tpl- 开头');
  assert.ok(t.createdAt, '记录创建时间');
  assert.ok(!('startDate' in t) && !('endDate' in t) && !('date' in t), '模板不入日期字段');
});

test('saveEventAsTemplate：同 title+time 去重（跳过）；同 title 不同 time 可存', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `saveEventAsTemplate({ id: 'e1', title: '站会', time: '09:30' })`), 'saved');
  assert.strictEqual(appEval(sb, `saveEventAsTemplate({ id: 'e2', title: '站会', time: '14:00' })`), 'saved');
  assert.strictEqual(appEval(sb, `saveEventAsTemplate({ id: 'e3', title: '站会', time: '09:30' })`), 'dup');
  assert.strictEqual(appEval(sb, `saveEventAsTemplate({ id: 'e4', title: '站会', time: '' })`), 'saved');
  assert.strictEqual(hostify(appEval(sb, 'loadEventTemplates()')).length, 3);
});

test('deleteEventTemplate：按 id 删除，不影响其他模板', () => {
  const { sb } = loadApp();
  appEval(sb, `saveEventAsTemplate({ id: 'e1', title: 'A', time: '' })`);
  appEval(sb, `saveEventAsTemplate({ id: 'e2', title: 'B', time: '' })`);
  const idA = hostify(appEval(sb, 'loadEventTemplates()')).find(t => t.title === 'A').id;
  appEval(sb, `deleteEventTemplate(${JSON.stringify(idA)})`);
  const list = hostify(appEval(sb, 'loadEventTemplates()'));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'B');
});

test('loadEventTemplates：损坏 JSON 兜底为空数组', () => {
  const { sb, storage } = loadApp();
  storage.setItem('eventTemplates', '{oops');
  assert.deepStrictEqual(hostify(appEval(sb, 'loadEventTemplates()')), []);
});

test('BUSINESS_KEYS 含 eventTemplates（进三档备份，不进同步快照）', () => {
  const { sb } = loadApp();
  appEval(sb, BACKUP_SRC);
  const keys = hostify(appEval(sb, 'window.Backup.BUSINESS_KEYS'));
  assert.ok(keys.includes('eventTemplates'), 'eventTemplates 应在 BUSINESS_KEYS 中');
  const snapshot = hostify(appEval(sb, 'buildBackup("business").business'));
  assert.ok('eventTemplates' in snapshot, 'business 备份应收集 eventTemplates');
});

test('tplChipsHtml：空模板返回空串；默认最多 8 个 + 「…」展开', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, 'tplChipsHtml()'), '');
  appEval(sb, `for (let i = 0; i < 10; i++) saveEventAsTemplate({ id: 'e' + i, title: '模板' + i, time: '' })`);
  const html = appEval(sb, 'tplChipsHtml()');
  assert.ok(html.includes('qa-tpl-row'));
  assert.strictEqual((html.match(/data-tpl="/g) || []).length, 8, '默认只渲染 8 个 chip');
  assert.ok(html.includes('data-tpl-more="1"'), '含展开按钮');
  appEval(sb, 'qaTplExpanded = true');
  const html2 = appEval(sb, 'tplChipsHtml()');
  assert.strictEqual((html2.match(/data-tpl="/g) || []).length, 10, '展开后渲染全部');
  assert.ok(!html2.includes('data-tpl-more'), '展开后无「…」按钮');
});

test('buildQuickAdd 面板：含模板 chips 容器（面板冒烟）', () => {
  const { sb } = loadApp();
  const html = appEval(sb, `(() => { const p = document.createElement('div'); buildQuickAdd(p); return p.innerHTML; })()`);
  assert.ok(html.includes('qa-tpl-holder'), '面板应包含模板 chips 容器');
});
