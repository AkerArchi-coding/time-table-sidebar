'use strict';
// P4.4 提醒与同步增强：贪睡调度 / 提醒条开关 / 自动同步准入
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 直写 storage 后必须清 app.js 的 eventsCache（loadApp 初始化时已缓存空数组）
function seedEvents(sb, storage, list) {
  storage.setItem('events', JSON.stringify(list));
  appEval(sb, 'invalidateDerivedCaches()');
}
// 构造一个今天到点（当前 HH:MM）的普通事项
function dueEvent(sb, extra) {
  const tk = appEval(sb, 'dateKey(today())');
  const d = new Date();
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return Object.assign({
    id: 'r1', date: tk, startDate: tk, endDate: tk, time,
    title: '到点事项', done: false, category: 'work', urgency: 'normal',
    projectId: null, description: '', recur: null, tags: []
  }, extra || {});
}

test('loadAppSettings：提醒条默认开、自动同步默认关', () => {
  const { sb } = loadApp();
  const st = hostify(appEval(sb, 'loadAppSettings()'));
  assert.strictEqual(st.reminderToastEnabled, true);
  assert.strictEqual(st.autoSyncEnabled, false);
});

test('AUTO_SYNC_INTERVAL_MS 固定 10 分钟', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, 'AUTO_SYNC_INTERVAL_MS'), 10 * 60 * 1000);
});

test('autoSyncEligible：开关关闭不生效', () => {
  const { sb } = loadApp();
  const r = appEval(sb, `autoSyncEligible({ autoSyncEnabled: false }, { opened: true, paused: false, pairs: [{ deviceId: 'd1' }] })`);
  assert.strictEqual(r, false);
});

test('autoSyncEligible：会话未打开过同步面板不生效', () => {
  const { sb } = loadApp();
  const r = appEval(sb, `autoSyncEligible({ autoSyncEnabled: true }, { opened: false, paused: false, pairs: [{ deviceId: 'd1' }] })`);
  assert.strictEqual(r, false);
});

test('autoSyncEligible：窗口隐藏（暂停）不生效', () => {
  const { sb } = loadApp();
  const r = appEval(sb, `autoSyncEligible({ autoSyncEnabled: true }, { opened: true, paused: true, pairs: [{ deviceId: 'd1' }] })`);
  assert.strictEqual(r, false);
});

test('autoSyncEligible：无已配对设备不生效', () => {
  const { sb } = loadApp();
  const r = appEval(sb, `autoSyncEligible({ autoSyncEnabled: true }, { opened: true, paused: false, pairs: [] })`);
  assert.strictEqual(r, false);
});

test('autoSyncEligible：全部前提满足才生效', () => {
  const { sb } = loadApp();
  const r = appEval(sb, `autoSyncEligible({ autoSyncEnabled: true }, { opened: true, paused: false, pairs: [{ deviceId: 'd1' }, { deviceId: 'd2' }] })`);
  assert.strictEqual(r, true);
});

test('贪睡中（snoozeUntil 未来）：到点不触发，标记保留', () => {
  const { sb, storage } = loadApp();
  const ev = dueEvent(sb, { id: 'r1', snoozeUntil: Date.now() + 60 * 60 * 1000 });
  seedEvents(sb, storage, [ev]);
  appEval(sb, 'checkReminders()');
  const keys = hostify(appEval(sb, '[...remindedKeys]'));
  assert.ok(!keys.some(k => k.startsWith('r1|')), '贪睡中的事项不应进入已提醒集合');
  const saved = JSON.parse(storage.getItem('events'));
  assert.strictEqual(saved[0].snoozeUntil, ev.snoozeUntil);   // 未消费
});

test('贪睡过期（snoozeUntil 已过）：正常触发并清除贪睡标记', () => {
  const { sb, storage } = loadApp();
  const past = Date.now() - 1000;
  const ev = dueEvent(sb, { id: 'r2', snoozeUntil: past });
  seedEvents(sb, storage, [ev]);
  appEval(sb, 'checkReminders()');
  const tk = appEval(sb, 'dateKey(today())');
  const keys = hostify(appEval(sb, '[...remindedKeys]'));
  assert.ok(keys.includes('r2|' + tk), '贪睡到期后应再次触发提醒');
  const saved = JSON.parse(storage.getItem('events'));
  assert.strictEqual(saved[0].snoozeUntil, 0);                // 已消费清零
});

test('提醒条开关关闭：checkReminders 仍记录已提醒（仅不出提醒条 UI）', () => {
  const { sb, storage } = loadApp();
  storage.setItem('appSettings', JSON.stringify({ reminderToastEnabled: false }));
  const ev = dueEvent(sb, { id: 'r3' });
  seedEvents(sb, storage, [ev]);
  appEval(sb, 'checkReminders()');
  const tk = appEval(sb, 'dateKey(today())');
  const keys = hostify(appEval(sb, '[...remindedKeys]'));
  assert.ok(keys.includes('r3|' + tk));
});
