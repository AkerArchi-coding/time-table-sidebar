'use strict';
// P7.3 提醒增强：remindedKeys 扩展结构（ts/stop）与旧结构兼容、重复提醒判定、
// 提醒有效期、toast 三档贪睡 + 不再提醒、默认提前量（设置与表单初值）
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

test('loadAppSettings：重复提醒与默认提前量默认 0，已有设置覆盖默认', () => {
  const { sb } = loadApp();
  const s1 = hostify(appEval(sb, 'loadAppSettings()'));
  assert.strictEqual(s1.remindRepeatMin, 0);
  assert.strictEqual(s1.remindAheadDefault, 0);
  appEval(sb, `saveAppSettings({ remindRepeatMin: 10, remindAheadDefault: 15 })`);
  const s2 = hostify(appEval(sb, 'loadAppSettings()'));
  assert.strictEqual(s2.remindRepeatMin, 10);
  assert.strictEqual(s2.remindAheadDefault, 15);
});

test('remindedKeys 持久化：save 写入 ts/stop，load 还原；旧结构 {date,ids} 兼容', () => {
  const { sb, storage } = loadApp();
  // 旧结构（无 ts/stop）加载不报错且字段兜底为空
  const tk = hostify(appEval(sb, 'dateKey(today())'));
  storage.setItem('remindedKeys', JSON.stringify({ date: tk, ids: ['a|' + tk] }));
  appEval(sb, 'loadRemindedKeys()');
  assert.deepStrictEqual(hostify(appEval(sb, '[...remindedKeys]')), ['a|' + tk]);
  assert.deepStrictEqual(hostify(appEval(sb, 'remindTs')), {});
  assert.deepStrictEqual(hostify(appEval(sb, '[...remindStop]')), []);
  // 新结构：save 带 ts/stop，load 还原
  appEval(sb, `const __k = 'x|' + dateKey(today()); remindedKeys = new Set([__k]); remindTs = { [__k]: 1728600000000 }; remindStop = new Set(['y|' + dateKey(today())]); saveRemindedKeys();`);
  appEval(sb, `remindedKeys = new Set(); remindTs = {}; remindStop = new Set(); loadRemindedKeys();`);
  const tk2 = 'x|' + tk;
  assert.deepStrictEqual(hostify(appEval(sb, '[...remindedKeys]')), [tk2]);
  assert.strictEqual(hostify(appEval(sb, 'remindTs'))[tk2], 1728600000000);
  assert.deepStrictEqual(hostify(appEval(sb, '[...remindStop]')), ['y|' + tk]);
});

test('shouldReRemind：间隔/stop/无 ts/未开 启各条件判定', () => {
  const { sb } = loadApp();
  appEval(sb, `
    var __now = new Date('2026-10-11T10:00:00');
    remindTs = {};
    remindStop = new Set();
  `);
  // 未开启（repeatMin=0）
  assert.strictEqual(appEval(sb, `shouldReRemind({}, 'k', __now, 0)`), false);
  // 从未触发（无 ts）
  assert.strictEqual(appEval(sb, `shouldReRemind({}, 'k', __now, 10)`), false);
  // 未到间隔（5 分钟前触发，间隔 10 分钟）
  appEval(sb, `remindTs['k'] = __now.getTime() - 5 * 60 * 1000;`);
  assert.strictEqual(appEval(sb, `shouldReRemind({}, 'k', __now, 10)`), false);
  // 到间隔且未结束（当日事件）
  appEval(sb, `remindTs['k'] = __now.getTime() - 11 * 60 * 1000;`);
  assert.strictEqual(appEval(sb, `shouldReRemind({ endDate: '2026-10-11' }, 'k', __now, 10)`), true);
  // 用户已点「不再提醒」
  appEval(sb, `remindStop.add('k');`);
  assert.strictEqual(appEval(sb, `shouldReRemind({ endDate: '2026-10-11' }, 'k', __now, 10)`), false);
});

test('shouldReRemind：事件当日结束后不再重复提醒', () => {
  const { sb } = loadApp();
  appEval(sb, `
    var __now2 = new Date('2026-10-11T23:30:00');
    remindTs = { 'k2': __now2.getTime() - 11 * 60 * 1000 };
    remindStop = new Set();
  `);
  // 结束日 2026-10-11（23:59:59 截止）→ 23:30 仍提醒
  assert.strictEqual(appEval(sb, `shouldReRemind({ endDate: '2026-10-11' }, 'k2', __now2, 10)`), true);
  // 结束日 2026-10-10（已过）→ 不再提醒
  assert.strictEqual(appEval(sb, `shouldReRemind({ endDate: '2026-10-10' }, 'k2', __now2, 10)`), false);
});

test('reminderEndTimeMs：结束日取 23:59:59.999；异常日期视为不限', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `reminderEndTimeMs({ endDate: '2026-10-11' })`),
    new Date(2026, 9, 11, 23, 59, 59, 999).getTime());
  assert.strictEqual(appEval(sb, `reminderEndTimeMs({})`), Infinity);
  assert.strictEqual(appEval(sb, `reminderEndTimeMs({ endDate: 'bad' })`), Infinity);
});

test('提醒 toast：含三档贪睡（5/10/30 分）与「不再提醒」按钮', () => {
  const { sb } = loadApp();
  // 沙箱 querySelector 每次返回新桩，覆写为 null 强制走 createElement → appendChild 路径
  appEval(sb, 'document.querySelector = () => null;');
  appEval(sb, `showReminderToast({ id: 'e1', title: '站会', time: '09:30' }, 0)`);
  const created = hostify(appEval(sb, 'document.body.children.length'));
  assert.ok(created >= 1, 'toast 元素已挂到 body');
  const html = hostify(appEval(sb, `document.body.children[document.body.children.length - 1].innerHTML`));
  assert.ok(html.includes('data-min="5"') && html.includes('data-min="10"') && html.includes('data-min="30"'), '三档贪睡按钮');
  assert.ok(html.includes('不再提醒'), '不再提醒按钮');
});

test('新建事项表单：提前提醒初值取全局默认设置', () => {
  const { sb } = loadApp();
  // 默认 0
  const f1 = appEval(sb, `buildTaskForm({ fixedDate: '2026-10-11' })`);
  const h1 = hostify(f1.innerHTML);
  assert.ok(/class="ev-remind"[\s\S]*?<option value="0" selected/.test(h1), '默认不提前');
  // 设置默认 15
  appEval(sb, `saveAppSettings({ remindAheadDefault: 15 })`);
  const f2 = appEval(sb, `buildTaskForm({ fixedDate: '2026-10-11' })`);
  const h2 = hostify(f2.innerHTML);
  assert.ok(/class="ev-remind"[\s\S]*?<option value="15" selected/.test(h2), '初值取全局默认 15');
});

test('编辑事项表单：提前提醒初值仍取事项自身值（优先于全局默认）', () => {
  const { sb } = loadApp();
  appEval(sb, `saveAppSettings({ remindAheadDefault: 15 })`);
  appEval(sb, `saveEvents([{ id: 'e1', title: '编辑', startDate: '2026-10-11', endDate: '2026-10-11', time: '09:00', remindAhead: 5 }])`);
  const f = appEval(sb, `buildTaskForm({ event: loadEvents()[0] })`);
  const h = hostify(f.innerHTML);
  assert.ok(/class="ev-remind"[\s\S]*?<option value="5" selected/.test(h), '事项自身值优先');
});
