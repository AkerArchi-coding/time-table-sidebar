'use strict';
// P5.1 统计增强：连续专注 streak / 上一周期对照 prev / 待办积压 backlog / 本周 vs 上周 weekCompare
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// today()+off 天的本地日期 key（YYYY-MM-DD）
function dkey(sb, off) {
  return appEval(sb, `dateKey(addDays(today(), ${off}))`);
}
// today()+off 天 hour 点（本地）的 ISO 时间串
function isoAt(sb, off, hour) {
  return appEval(sb, `(() => { const d = addDays(today(), ${off}); d.setHours(${hour || 12}, 0, 0, 0); return d.toISOString(); })()`);
}
// 构造基础事项
function mkEv(extra) {
  return Object.assign({
    id: 'e1', title: '测试事项', done: false, category: 'work', urgency: 'normal',
    projectId: null, description: '', recur: null, tags: []
  }, extra || {});
}

test('statsTrendMode 模块变量默认 focus（P5.1 趋势双指标）', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, 'statsTrendMode'), 'focus');
});

test('streak：今天与昨天都有专注 → 连续 2 天', () => {
  const { sb } = loadApp();
  const history = [
    { date: dkey(sb, -2), count: 1, minutes: 0 },   // 0 分钟视为无专注
    { date: dkey(sb, -1), count: 1, minutes: 25 },
    { date: dkey(sb, 0), count: 1, minutes: 30 }
  ];
  const st = hostify(appEval(sb, `buildStats([], ${JSON.stringify(history)}, 7, today())`));
  assert.strictEqual(st.streak, 2);
});

test('streak：今天尚无记录 → 从昨天起算，不清零连续', () => {
  const { sb } = loadApp();
  const history = [
    { date: dkey(sb, -3), count: 1, minutes: 25 },
    { date: dkey(sb, -2), count: 1, minutes: 25 },
    { date: dkey(sb, -1), count: 1, minutes: 25 }
  ];
  const st = hostify(appEval(sb, `buildStats([], ${JSON.stringify(history)}, 7, today())`));
  assert.strictEqual(st.streak, 3);
});

test('streak：昨天中断 → 即使今天有记录也只算 1 天', () => {
  const { sb } = loadApp();
  const history = [
    { date: dkey(sb, -2), count: 1, minutes: 0 },
    { date: dkey(sb, -1), count: 1, minutes: 0 },
    { date: dkey(sb, 0), count: 1, minutes: 25 }
  ];
  const st = hostify(appEval(sb, `buildStats([], ${JSON.stringify(history)}, 7, today())`));
  assert.strictEqual(st.streak, 1);
});

test('streak：无任何专注记录 → 0', () => {
  const { sb } = loadApp();
  const st = hostify(appEval(sb, 'buildStats([], [], 7, today())'));
  assert.strictEqual(st.streak, 0);
});

test('prev 对照（7 天）：上一周期 [今天-13, 今天-7] 口径与主区间一致', () => {
  const { sb } = loadApp();
  const events = [
    // 当前区间：今天新建 + 今天完成
    mkEv({ id: 'a', createdAt: isoAt(sb, 0, 9), done: true, updatedAt: isoAt(sb, 0, 10) }),
    // 上一周期边界：今天-7 新建并完成（计入 prev）
    mkEv({ id: 'b', createdAt: isoAt(sb, -7, 9), done: true, updatedAt: isoAt(sb, -7, 10) }),
    // 区间外：今天-14 不计入
    mkEv({ id: 'c', createdAt: isoAt(sb, -14, 9), done: true, updatedAt: isoAt(sb, -14, 10) })
  ];
  const history = [
    { date: dkey(sb, -7), count: 1, minutes: 40 },   // 上一周期
    { date: dkey(sb, 0), count: 1, minutes: 25 }     // 当前周期
  ];
  const st = hostify(appEval(sb, `buildStats(${JSON.stringify(events)}, ${JSON.stringify(history)}, 7, today())`));
  assert.strictEqual(st.totals.createdTotal, 1);
  assert.strictEqual(st.totals.doneTotal, 1);
  assert.strictEqual(st.totals.focusMinutes, 25);
  assert.strictEqual(st.prev.createdTotal, 1);
  assert.strictEqual(st.prev.doneTotal, 1);
  assert.strictEqual(st.prev.focusMinutes, 40);
});

test('prev 对照（30 天）：上一周期 [今天-59, 今天-30]', () => {
  const { sb } = loadApp();
  const events = [
    mkEv({ id: 'a', createdAt: isoAt(sb, -29, 9) }),   // 当前区间（今天-29 起）
    mkEv({ id: 'b', createdAt: isoAt(sb, -30, 9) }),   // 上一区间最后一天
    mkEv({ id: 'c', createdAt: isoAt(sb, -60, 9) })    // 区间外
  ];
  const st = hostify(appEval(sb, `buildStats(${JSON.stringify(events)}, [], 30, today())`));
  assert.strictEqual(st.totals.createdTotal, 1);
  assert.strictEqual(st.prev.createdTotal, 1);
});

test('backlog：逾期/今天/未来/无日期/紧急 五档 + done 与重复事项排除', () => {
  const { sb } = loadApp();
  const tk = dkey(sb, 0), yd = dkey(sb, -1), tm = dkey(sb, 1);
  const events = [
    mkEv({ id: 'over', startDate: yd, endDate: yd }),                       // 逾期
    mkEv({ id: 'span', startDate: yd, endDate: tm }),                       // 跨今天 → 今天档
    mkEv({ id: 'fut', startDate: tm, endDate: tm }),                        // 未来
    mkEv({ id: 'und', startDate: '', endDate: '' }),                        // 无日期
    mkEv({ id: 'urg', startDate: tm, endDate: tm, urgency: 'urgent' }),     // 紧急（同时计未来档）
    mkEv({ id: 'done', startDate: yd, endDate: yd, done: true }),           // 已完成 → 排除
    mkEv({ id: 'rec', startDate: yd, endDate: yd, recur: { freq: 'daily', until: '' } })  // 重复 → 排除
  ];
  const st = hostify(appEval(sb, `buildStats(${JSON.stringify(events)}, [], 7, today())`));
  assert.deepStrictEqual(st.backlog, { overdue: 1, today: 1, future: 2, undated: 1, urgent: 1 });
});

test('weekCompare：本周 vs 上周固定自然周（周一~周日），不随区间变化', () => {
  const { sb } = loadApp();
  // 本周一（startOfWeek）与上周六（startOfWeek-2）：无论今天星期几，必然分别落在本周/上周
  const monIso = appEval(sb, `(() => { const d = startOfWeek(today()); d.setHours(9, 0, 0, 0); return d.toISOString(); })()`);
  const prevSatIso = appEval(sb, `(() => { const d = addDays(startOfWeek(today()), -2); d.setHours(9, 0, 0, 0); return d.toISOString(); })()`);
  const monKey = appEval(sb, 'dateKey(startOfWeek(today()))');
  const prevSatKey = appEval(sb, 'dateKey(addDays(startOfWeek(today()), -2))');
  const events = [
    mkEv({ id: 'w', createdAt: monIso, done: true, updatedAt: monIso }),
    mkEv({ id: 'p1', createdAt: prevSatIso }),
    mkEv({ id: 'p2', createdAt: prevSatIso, done: true, updatedAt: prevSatIso })
  ];
  const history = [
    { date: monKey, count: 1, minutes: 25 },
    { date: prevSatKey, count: 2, minutes: 50 }
  ];
  const wc = hostify(appEval(sb, `weekCompare(${JSON.stringify(events)}, ${JSON.stringify(history)}, today())`));
  assert.deepStrictEqual(wc, {
    done: 1, created: 1, focusMinutes: 25,
    prev: { done: 1, created: 2, focusMinutes: 50 }
  });
});

test('weekCompare：空数据返回全 0（上周基数为 0 时 UI 显示「—」）', () => {
  const { sb } = loadApp();
  const wc = hostify(appEval(sb, 'weekCompare([], [], today())'));
  assert.deepStrictEqual(wc, {
    done: 0, created: 0, focusMinutes: 0,
    prev: { done: 0, created: 0, focusMinutes: 0 }
  });
});

test('buildStatsPanel 冒烟：面板 HTML 生成无运行时错误且包含新卡片', () => {
  const { sb } = loadApp();
  const len = appEval(sb, `(() => {
    const p = document.createElement('div');
    buildStatsPanel(p);
    return p.innerHTML.length;
  })()`);
  assert.ok(len > 500);
  const html = appEval(sb, `(() => { const p = document.createElement('div'); buildStatsPanel(p); return p.innerHTML; })()`);
  assert.ok(html.includes('待办积压'), '应包含待办积压卡');
  assert.ok(html.includes('专注报表'), '应包含专注报表卡');
  assert.ok(html.includes('本周 vs 上周'), '应包含周环比卡');
  assert.ok(html.includes('data-trend="done"'), '趋势卡应包含完成事项切换');
});
