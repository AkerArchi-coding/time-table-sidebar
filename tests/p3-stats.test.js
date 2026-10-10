// ============ P3.1 单元测试：数据统计与周报 ============
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, hostify } = require('./helpers');

// 构造本地日期的 ISO（与 app 内 toISOString 同形态，避免手写 UTC 偏差）
function iso(y, m, d, hh = 12) { return new Date(y, m - 1, d, hh, 0, 0).toISOString(); }
const NOW = new Date(2026, 9, 10, 12, 0, 0);   // 2026-10-10 周六（本地）

// 标准数据集（窗口 2026-10-04 ~ 10-10；本周 10-05 周一 ~ 10-11 周日）
function seed(sb) {
  sb.saveProjects([{ id: 'p1', name: '项目甲' }]);
  sb.saveEvents([
    { id: 'e1', title: '完成方案', done: true, category: 'work', projectId: 'p1',
      createdAt: iso(2026, 10, 5, 9), updatedAt: iso(2026, 10, 7, 18) },
    { id: 'e2', title: '早前创建', done: false, category: 'work', projectId: null,
      createdAt: iso(2026, 10, 2, 9), updatedAt: iso(2026, 10, 2, 9) },   // 7天窗口外、30天内
    { id: 'e3', title: '今天新增未做', done: false, category: 'work', projectId: null,
      createdAt: iso(2026, 10, 10, 10), updatedAt: iso(2026, 10, 10, 10) },
    { id: 'e4', title: '买菜', done: true, category: 'personal', projectId: null,
      createdAt: iso(2026, 9, 28, 9), updatedAt: iso(2026, 10, 10, 9) },  // 上周创建、今天完成
    { id: 'e5', title: '明天的事', done: false, category: 'work', projectId: null,
      createdAt: iso(2026, 10, 11, 9), updatedAt: iso(2026, 10, 11, 9) },  // 未来，不计
    { id: 'e6', title: '家庭维修', done: true, category: 'family', projectId: 'p1',
      createdAt: iso(2026, 10, 6, 9), updatedAt: iso(2026, 10, 6, 17) }
  ]);
  return [
    { date: '2026-10-08', count: 1, minutes: 25 },
    { date: '2026-10-10', count: 2, minutes: 50 }
  ];
}

// ============ pomoHistoryUpsert ============

test('pomoHistoryUpsert：空数组新增当日聚合', () => {
  const { sb } = loadApp();
  const out = sb.pomoHistoryUpsert([], '2026-10-10', 25);
  assert.deepStrictEqual(hostify(out), [{ date: '2026-10-10', count: 1, minutes: 25 }]);
});

test('pomoHistoryUpsert：同日累加次数与分钟', () => {
  const { sb } = loadApp();
  let out = sb.pomoHistoryUpsert([], '2026-10-10', 25);
  out = sb.pomoHistoryUpsert(out, '2026-10-10', 45);
  assert.deepStrictEqual(hostify(out), [{ date: '2026-10-10', count: 2, minutes: 70 }]);
});

test('pomoHistoryUpsert：不同日追加且不修改原数组', () => {
  const { sb } = loadApp();
  const base = [{ date: '2026-10-09', count: 1, minutes: 25 }];
  const out = sb.pomoHistoryUpsert(base, '2026-10-10', 25);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(base.length, 1, '原数组不被修改');
  assert.strictEqual(base[0].count, 1);
});

test('appendPomoTaskLog：写当日日志同时累积 pomoHistory', () => {
  const { sb } = loadApp();
  sb.appendPomoTaskLog('t1', '写周报', 25);
  sb.appendPomoTaskLog('t1', '写周报', 25);
  const hist = hostify(sb.loadPomoHistory());
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].date, sb.dateKey(sb.today()));
  assert.strictEqual(hist[0].count, 2);
  assert.strictEqual(hist[0].minutes, 50);
});

// ============ 日期工具 ============

test('isoDateKey：ISO（含 UTC 偏移）正确转成本地日期', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.isoDateKey(iso(2026, 10, 10, 9)), '2026-10-10');
  assert.strictEqual(sb.isoDateKey(''), '');
  assert.strictEqual(sb.isoDateKey('not-a-date'), '');
});

test('startOfWeek：周一原样、周日回到前一周周一', () => {
  const { sb } = loadApp();
  assert.strictEqual(sb.dateKey(sb.startOfWeek(new Date(2026, 9, 12))), '2026-10-12');  // 周一
  assert.strictEqual(sb.dateKey(sb.startOfWeek(new Date(2026, 9, 10))), '2026-10-05');  // 周六
  assert.strictEqual(sb.dateKey(sb.startOfWeek(new Date(2026, 9, 11))), '2026-10-05');  // 周日
});

test('dateKeyRange：生成连续日期（含起止、跨月）', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(sb.dateKeyRange('2026-10-05', 7)),
    ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepStrictEqual(hostify(sb.dateKeyRange('2026-09-30', 2)), ['2026-09-30', '2026-10-01']);
});

// ============ buildStats ============

test('buildStats：空数据安全降级（7 天全 0、完成率 0）', () => {
  const { sb } = loadApp();
  const st = sb.buildStats([], [], 7, NOW);
  assert.strictEqual(st.daily.length, 7);
  assert.strictEqual(st.startKey, '2026-10-04');
  assert.strictEqual(st.endKey, '2026-10-10');
  assert.deepStrictEqual(hostify(st.totals), { createdTotal: 0, doneTotal: 0, rate: 0, focusCount: 0, focusMinutes: 0 });
  assert.strictEqual(st.categories.length, 3);
  assert.deepStrictEqual(hostify(st.projects), []);
});

test('buildStats（近7天）：新增/完成/专注按日落位，未来数据不计', () => {
  const { sb } = loadApp();
  const history = seed(sb);
  const st = sb.buildStats(sb.loadEvents(), history, 7, NOW);
  const t = st.totals;
  assert.strictEqual(t.createdTotal, 3, 'e1/e3/e6 在窗口内；e2 窗外、e5 未来');
  assert.strictEqual(t.doneTotal, 3, 'e1/e4/e6 在窗口内完成');
  assert.strictEqual(t.rate, 100);
  assert.strictEqual(t.focusCount, 3);
  assert.strictEqual(t.focusMinutes, 75);

  const byDate = Object.fromEntries(st.daily.map(d => [d.date, d]));
  assert.deepStrictEqual(hostify(byDate['2026-10-05']),
    { date: '2026-10-05', created: 1, done: 0, focusCount: 0, focusMinutes: 0 });
  assert.deepStrictEqual(hostify(byDate['2026-10-06']),
    { date: '2026-10-06', created: 1, done: 1, focusCount: 0, focusMinutes: 0 });
  assert.strictEqual(byDate['2026-10-07'].done, 1);
  assert.strictEqual(byDate['2026-10-10'].created, 1);
  assert.strictEqual(byDate['2026-10-10'].done, 1);
  assert.strictEqual(byDate['2026-10-10'].focusCount, 2);
  assert.strictEqual(byDate['2026-10-10'].focusMinutes, 50);
});

test('buildStats（近7天）：分类分布与项目排行', () => {
  const { sb } = loadApp();
  const history = seed(sb);
  const st = sb.buildStats(sb.loadEvents(), history, 7, NOW);
  const cat = Object.fromEntries(st.categories.map(c => [c.key, c.count]));
  assert.deepStrictEqual(cat, { work: 1, personal: 1, family: 1 });
  assert.strictEqual(st.projects.length, 1);
  assert.strictEqual(st.projects[0].name, '项目甲');
  assert.strictEqual(st.projects[0].done, 2);
  assert.strictEqual(st.projects[0].total, 2);
});

test('buildStats（近30天）：早前创建事项纳入，未来仍排除', () => {
  const { sb } = loadApp();
  const history = seed(sb);
  const st = sb.buildStats(sb.loadEvents(), history, 30, NOW);
  assert.strictEqual(st.daily.length, 30);
  assert.strictEqual(st.startKey, '2026-09-11');
  assert.strictEqual(st.totals.createdTotal, 5, 'e1/e2/e3/e4/e6 在窗内；仅 e5 未来排除');
});

// ============ buildWeeklyReport ============

test('buildWeeklyReport：空数据含周期与空态文案', () => {
  const { sb } = loadApp();
  const md = sb.buildWeeklyReport([], [], [], NOW);
  assert.ok(md.includes('# 周报（2026-10-05 ~ 2026-10-11）'));
  assert.ok(md.includes('完成事项：0 项'));
  assert.ok(md.includes('本周暂无完成事项'));
  assert.ok(md.includes('## 每日完成'));
  assert.strictEqual(md.split('\n').filter(l => l.startsWith('- ') && l.includes('周')).length, 7, '每天一行');
});

test('buildWeeklyReport：专注汇总、项目分组、未归类与条形', () => {
  const { sb } = loadApp();
  const history = seed(sb);
  const md = sb.buildWeeklyReport(sb.loadEvents(), sb.loadProjects(), history, NOW);
  assert.ok(md.includes('完成事项：3 项'));
  assert.ok(md.includes('3 个，共 75 分钟（约 1.3 小时）'));
  assert.ok(md.includes('### 项目甲（2）'));
  assert.ok(md.includes('### 未归类（1）'));
  assert.ok(md.includes('- [x] 完成方案'));
  assert.ok(md.includes('- [x] 买菜'));
  assert.ok(md.includes('10/05 周一'), '每日行使用月/日 + 周几');
  assert.ok(md.includes('█'), '最高日应为满格条');
  // 完成顺序：项目组在前，未归类在后
  assert.ok(md.indexOf('### 项目甲（2）') < md.indexOf('### 未归类（1）'));
});

test('buildWeeklyReport：带时间的完成事项显示时间前缀', () => {
  const { sb } = loadApp();
  sb.saveEvents([{ id: 'x', title: '晨会', time: '09:00', done: true, category: 'work', projectId: null,
    createdAt: iso(2026, 10, 10, 8), updatedAt: iso(2026, 10, 10, 9) }]);
  const md = sb.buildWeeklyReport(sb.loadEvents(), [], [], NOW);
  assert.ok(md.includes('- [x] 09:00 晨会'));
});
