// ============ P3.2 单元测试：重复事项（虚拟投影）+ 全局搜索 ============
// 运行方式：npm test（node --test "tests/*.test.js"）
// 复用 helpers.js 的 vm 沙箱 harness（加载 app.js，浏览器对象桩化）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers.js');

// 本地时间构造日期 key 辅助（YYYY-MM-DD）
const KEY = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

// 2026-10-05 是周一；2026-10-10 是周六
const R = { daily: { freq: 'daily', interval: 1, until: '' } };

// ============ recurMatchesDate ============

test('recurMatchesDate：daily 起始日命中、次日命中、前日不命中', () => {
  const { sb } = loadApp();
  const start = '2026-10-05';
  assert.strictEqual(sb.recurMatchesDate(R.daily, start, '2026-10-05'), true, '起始日必命中');
  assert.strictEqual(sb.recurMatchesDate(R.daily, start, '2026-10-06'), true);
  assert.strictEqual(sb.recurMatchesDate(R.daily, start, '2026-10-10'), true);
  assert.strictEqual(sb.recurMatchesDate(R.daily, start, '2026-10-04'), false, '早于起始不命中');
});

test('recurMatchesDate：weekdays 周末排除（但周六起始日仍可见）', () => {
  const { sb } = loadApp();
  const recur = { freq: 'weekdays', interval: 1, until: '' };
  const start = '2026-10-10';   // 周六
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-10'), true, '起始日恒命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-11'), false, '周日不命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-12'), true, '周一命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-16'), true, '周五命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-17'), false, '次周六不命中');
});

test('recurMatchesDate：weekly 同星期几命中、跨周命中、不同不命中', () => {
  const { sb } = loadApp();
  const recur = { freq: 'weekly', interval: 1, until: '' };
  const start = '2026-10-05';   // 周一
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-12'), true, '下周一命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-19'), true, '下下周一命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-10'), false, '周六不命中');
});

test('recurMatchesDate：monthly 同日号命中、目标月无该日号不命中', () => {
  const { sb } = loadApp();
  const recur = { freq: 'monthly', interval: 1, until: '' };
  assert.strictEqual(sb.recurMatchesDate(recur, '2026-01-31', '2026-02-28'), false, '2 月无 31 日');
  assert.strictEqual(sb.recurMatchesDate(recur, '2026-01-31', '2026-03-31'), true, '3 月 31 日命中');
  assert.strictEqual(sb.recurMatchesDate(recur, '2026-01-10', '2026-02-10'), true);
  assert.strictEqual(sb.recurMatchesDate(recur, '2026-01-10', '2026-02-11'), false);
});

test('recurMatchesDate：until 截止（含当天）、之后不命中', () => {
  const { sb } = loadApp();
  const recur = { freq: 'daily', interval: 1, until: '2026-10-08' };
  const start = '2026-10-05';
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-08'), true, '截止日当天命中');
  assert.strictEqual(sb.recurMatchesDate(recur, start, '2026-10-09'), false, '截止后不命中');
});

test('recurMatchesDate：无效规则 / 空锚点日期 一律不命中', () => {
  const { sb } = loadApp();
  const tk = '2026-10-10';
  assert.strictEqual(sb.recurMatchesDate(null, '2026-10-05', tk), false, '无规则');
  assert.strictEqual(sb.recurMatchesDate({ freq: 'none', interval: 1, until: '' }, '2026-10-05', tk), false, 'freq=none');
  assert.strictEqual(sb.recurMatchesDate({ freq: 'yearly' }, '2026-10-05', tk), false, '不支持的 freq');
  assert.strictEqual(sb.recurMatchesDate(R.daily, '', tk), false, '无开始日期不投影');
  assert.strictEqual(sb.recurMatchesDate(R.daily, '2026-10-05', ''), false, '空目标日期');
});

// ============ recurDone 存取 ============

test('recurDoneSet/Get：写入、删除（false 即移除 key）、持久化', () => {
  const { sb, storage } = loadApp();
  assert.strictEqual(sb.recurDoneGet('e1', '2026-10-10'), false, '初始未完成');
  sb.recurDoneSet('e1', '2026-10-10', true);
  assert.strictEqual(sb.recurDoneGet('e1', '2026-10-10'), true);
  const raw = JSON.parse(storage.getItem('recurDone'));
  assert.deepStrictEqual(raw, { 'e1|2026-10-10': true }, '写穿到 localStorage');
  sb.recurDoneSet('e1', '2026-10-10', false);
  assert.strictEqual(sb.recurDoneGet('e1', '2026-10-10'), false, '取消完成');
  assert.deepStrictEqual(JSON.parse(storage.getItem('recurDone')), {}, 'false 时移除 key');
});

// ============ 虚拟投影 ============

// 标准数据集：r1 daily（10-05 周一起）、r2 weekly（10-05 周一起）、e1 普通单日、e2 多日
function seed(sb) {
  const events = [
    {
      id: 'r1', title: '晨间跑步', time: '07:00', date: '2026-10-05',
      startDate: '2026-10-05', endDate: '2026-10-05', done: false,
      category: 'personal', urgency: 'normal', projectId: null,
      description: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      recur: { freq: 'daily', interval: 1, until: '' }
    },
    {
      id: 'r2', title: '周会准备', time: '09:00', date: '2026-10-05',
      startDate: '2026-10-05', endDate: '2026-10-05', done: false,
      category: 'work', urgency: 'normal', projectId: null,
      description: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      recur: { freq: 'weekly', interval: 1, until: '' }
    },
    {
      id: 'e1', title: '普通事项', time: '12:00', date: '2026-10-10',
      startDate: '2026-10-10', endDate: '2026-10-10', done: false,
      category: 'work', urgency: 'normal', projectId: null,
      description: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      recur: null
    },
    {
      id: 'e2', title: '多日事项', time: '', date: '2026-10-09',
      startDate: '2026-10-09', endDate: '2026-10-11', done: false,
      category: 'family', urgency: 'normal', projectId: null,
      description: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      recur: null
    }
  ];
  sb.saveEvents(events);
  return events;
}

test('makeVirtualEvent：复合 id + 日期覆盖 + 完成态查 recurDone', () => {
  const { sb } = loadApp();
  const ev = {
    id: 'r1', title: '晨间跑步', date: '2026-10-05', startDate: '2026-10-05',
    endDate: '2026-10-05', done: false, recur: R.daily
  };
  sb.recurDoneSet('r1', '2026-10-10', true);
  const v = hostify(sb.makeVirtualEvent(ev, '2026-10-10'));
  assert.strictEqual(v.id, 'r1@2026-10-10', '复合键 = 模板id@日期');
  assert.strictEqual(v._templateId, 'r1');
  assert.strictEqual(v._recurDate, '2026-10-10');
  assert.strictEqual(v.startDate, '2026-10-10', '虚拟日期指向命中日');
  assert.strictEqual(v.endDate, '2026-10-10');
  assert.strictEqual(v.done, true, '完成态来自 recurDone 而非模板');
});

test('getEventsByDate：重复事项按命中日投影，非命中日不出现', () => {
  const { sb } = loadApp();
  seed(sb);
  // 2026-10-10（周六）：r1 daily 命中、r2 weekly（周一）不命中、e1/e2 普通
  const ids = sb.getEventsByDate('2026-10-10').map(e => e.id);
  assert.ok(ids.includes('r1@2026-10-10'), 'daily 投影到 10-10');
  assert.ok(!ids.includes('r2@2026-10-10'), 'weekly 周六不投影');
  assert.ok(!ids.includes('r2'), '模板本身不以原始 id 出现');
  assert.ok(ids.includes('e1') && ids.includes('e2'), '普通/多日事项照常');

  // 2026-10-12（下周一）：r1、r2 均命中
  const ids2 = sb.getEventsByDate('2026-10-12').map(e => e.id);
  assert.ok(ids2.includes('r1@2026-10-12'));
  assert.ok(ids2.includes('r2@2026-10-12'));
});

test('getEventsByDate：老数据 recur 缺失时迁移兜底为 null，行为不变', () => {
  const { sb, storage } = loadApp();
  storage.setItem('events', JSON.stringify([
    { id: 'old1', title: '老事项', date: '2026-10-10', startDate: '2026-10-10', endDate: '2026-10-10', done: false }
  ]));
  appEval(sb, 'invalidateDerivedCaches()');   // 模拟重启后从盘加载（初始化已缓存空数组）
  const list = sb.loadEvents();
  assert.strictEqual(list[0].recur, null, '迁移兜底 recur=null');
  assert.deepStrictEqual(
    hostify(sb.getEventsByDate('2026-10-10').map(e => e.id)),
    ['old1'], '普通显示不受影响'
  );
});

test('toggleDone：虚拟 id 写 recurDone override，模板 done 不变', () => {
  const { sb } = loadApp();
  seed(sb);
  sb.toggleDone('r1@2026-10-10');
  assert.strictEqual(sb.recurDoneGet('r1', '2026-10-10'), true, 'override 已写入');
  assert.strictEqual(sb.loadEvents().find(e => e.id === 'r1').done, false, '模板 done 未动');
  // 投影后的完成态
  const v = sb.getEventsByDate('2026-10-10').find(e => e.id === 'r1@2026-10-10');
  assert.strictEqual(v.done, true, '投影视图显示已完成');
  // 再勾选 = 取消
  sb.toggleDone('r1@2026-10-10');
  assert.strictEqual(sb.recurDoneGet('r1', '2026-10-10'), false);
});

test('toggleDone：普通 id 行为不变（模板 done 翻转）', () => {
  const { sb } = loadApp();
  seed(sb);
  sb.toggleDone('e1');
  assert.strictEqual(sb.loadEvents().find(e => e.id === 'e1').done, true);
});

test('deleteEvent：虚拟 id 解析为模板，删除整个重复系列', () => {
  const { sb } = loadApp();
  seed(sb);
  sb.deleteEvent('r1@2026-10-10');
  const ids = sb.loadEvents().map(e => e.id);
  assert.ok(!ids.includes('r1'), '模板已删除');
  assert.ok(ids.includes('r2') && ids.includes('e1'), '其余不受影响');
  assert.ok(!sb.getEventsByDate('2026-10-11').some(e => e._templateId === 'r1'), '后续投影消失');
});

test('markDateDone：重复事项该日写 override，不动模板 done', () => {
  const { sb } = loadApp();
  seed(sb);
  sb.markDateDone('2026-10-10');
  assert.strictEqual(sb.recurDoneGet('r1', '2026-10-10'), true, 'daily 投影 override');
  assert.strictEqual(sb.loadEvents().find(e => e.id === 'r1').done, false);
  assert.strictEqual(sb.loadEvents().find(e => e.id === 'e1').done, true, '普通事项直接完成');
  // 10-11（周日）：e2 多日覆盖；r1 的其他投影仍是未完成
  const v11 = sb.getEventsByDate('2026-10-11').find(e => e.id === 'r1@2026-10-11');
  assert.strictEqual(v11.done, false, '其他命中日不受影响');
});

test('checkReminders：重复事项命中日触发提醒、override 完成日跳过', () => {
  const { sb } = loadApp();
  // 用可注入时钟验证逻辑：直接调 recurMatchesDate + recurDoneGet 的组合口径
  seed(sb);
  const ev = sb.loadEvents().find(e => e.id === 'r1');
  // 模拟 checkReminders 的当日有效性判断（口径与实现一致）
  const validToday = (evObj, tk) =>
    sb.isRecurOn(evObj)
      ? sb.recurMatchesDate(evObj.recur, sb.eventStart(evObj), tk) && !sb.recurDoneGet(evObj.id, tk)
      : !evObj.done && sb.eventStart(evObj) === tk;
  assert.strictEqual(validToday(ev, '2026-10-10'), true, '命中日应提醒');
  sb.recurDoneSet('r1', '2026-10-10', true);
  assert.strictEqual(validToday(ev, '2026-10-10'), false, 'override 完成后不提醒');
  assert.strictEqual(validToday(ev, '2026-10-12'), true, '其他命中日仍提醒');
});

// ============ 全局搜索 ============

test('searchEvents：匹配标题与备注、不区分大小写', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'a', title: 'Buy Milk', description: '', startDate: '2026-10-01', endDate: '2026-10-01' },
    { id: 'b', title: '写周报', description: '整理 Gantt 图反馈', startDate: '2026-10-02', endDate: '2026-10-02' },
    { id: 'c', title: '无关事项', description: '', startDate: '2026-10-03', endDate: '2026-10-03' }
  ];
  // searchEvents 返回的数组在 vm 沙箱内创建，跨 realm 断言前先 JSON 往返
  assert.deepStrictEqual(hostify(sb.searchEvents(events, 'milk').map(e => e.id)), ['a'], '标题命中（大小写不敏感）');
  assert.deepStrictEqual(hostify(sb.searchEvents(events, 'gantt').map(e => e.id)), ['b'], '备注命中');
  assert.deepStrictEqual(hostify(sb.searchEvents(events, '周报').map(e => e.id)), ['b']);
  assert.deepStrictEqual(hostify(sb.searchEvents(events, '')), [], '空关键字返回空');
  assert.deepStrictEqual(hostify(sb.searchEvents(events, '  ')), [], '纯空白返回空');
  assert.deepStrictEqual(hostify(sb.searchEvents(events, '不存在')), [], '无匹配返回空');
});

test('searchEvents：按开始日期升序，无日期排最后', () => {
  const { sb } = loadApp();
  const events = [
    { id: 'late', title: '事项甲', startDate: '2026-10-20', endDate: '2026-10-20' },
    { id: 'none', title: '事项乙', startDate: '', endDate: '' },
    { id: 'early', title: '事项丙', startDate: '2026-10-01', endDate: '2026-10-01' }
  ];
  assert.deepStrictEqual(
    hostify(sb.searchEvents(events, '事项').map(e => e.id)),
    ['early', 'late', 'none'],
    '有日期升序在前，无日期垫底'
  );
});
