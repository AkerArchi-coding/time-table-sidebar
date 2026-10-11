'use strict';
// P5.2 自然语言快速添加：parseQuickInput 词表 / quickInputPreview / buildQuickAdd 实时回填
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 固定基准时间：2026-10-11（周日）12:00 本地
const NOW_SRC = 'new Date(2026, 9, 11, 12, 0, 0)';
function parse(sb, text) {
  return hostify(appEval(sb, `parseQuickInput(${JSON.stringify(text)}, ${NOW_SRC})`));
}
function preview(sb, text) {
  return appEval(sb, `quickInputPreview(parseQuickInput(${JSON.stringify(text)}, ${NOW_SRC}))`);
}

// ---- 日期词表：相对 ----
test('相对日期：今天/明天/后天/大后天', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '今天买菜').date, '2026-10-11');
  assert.strictEqual(parse(sb, '明天开会').date, '2026-10-12');
  assert.strictEqual(parse(sb, '后天交稿').date, '2026-10-13');
  assert.strictEqual(parse(sb, '大后天体检').date, '2026-10-14');
});
test('相对日期：今晚 = 今天 + 19:00', () => {
  const { sb } = loadApp();
  const p = parse(sb, '今晚看电影');
  assert.strictEqual(p.date, '2026-10-11');
  assert.strictEqual(p.time, '19:00');
  assert.strictEqual(p.title, '看电影');
});
test('相对日期：N天后（阿拉伯 + 中文 + 两）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '3天后复查').date, '2026-10-14');
  assert.strictEqual(parse(sb, '十五天后复盘').date, '2026-10-26');
  assert.strictEqual(parse(sb, '两天后跟进').date, '2026-10-13');
});
test('星期：周X/星期X 取未来最近（含今天，周日=今天）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '周日休息').date, '2026-10-11');   // 今天即周日
  assert.strictEqual(parse(sb, '周天休息').date, '2026-10-11');
  assert.strictEqual(parse(sb, '周三例会').date, '2026-10-14');
  assert.strictEqual(parse(sb, '周一晨会').date, '2026-10-12');   // 最近的周一是明天（下周的周一）
  assert.strictEqual(parse(sb, '星期五提交').date, '2026-10-16');
});
test('下周X：强制下一自然周（周日基线）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '下周一启动').date, '2026-10-12');
  assert.strictEqual(parse(sb, '下周三评审').date, '2026-10-14');
  assert.strictEqual(parse(sb, '下周日总结').date, '2026-10-18');
});

// ---- 日期词表：绝对 ----
test('绝对日期：X月X号/日（已过 → 明年）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '10月13号答辩').date, '2026-10-13');
  assert.strictEqual(parse(sb, '10月1号放假').date, '2027-10-01');   // 已过 → 明年
  assert.strictEqual(parse(sb, '十月十三日汇报').date, '2026-10-13'); // 中文数字
});
test('绝对日期：X号/日（本月，已过 → 下月；N日内不误判）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '13号发版').date, '2026-10-13');
  assert.strictEqual(parse(sb, '5号缴费').date, '2026-11-05');      // 已过 → 下月
  assert.strictEqual(parse(sb, '11号值班').date, '2026-10-11');     // 今天含
  const p = parse(sb, '3日内完成');                                  // 时长语义不解析
  assert.strictEqual(p.date, '');
  assert.strictEqual(p.title, '3日内完成');
});
test('绝对日期：MM-DD 与 YYYY-MM-DD', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '12-20 年会').date, '2026-12-20');
  assert.strictEqual(parse(sb, '09-01 补休').date, '2027-09-01');    // 已过 → 明年
  assert.strictEqual(parse(sb, '2026-12-25 聚餐').date, '2026-12-25');
});

// ---- 时间词表 ----
test('时间：HH:MM（补零）与时段+HH:MM', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '开会 15:30').time, '15:30');
  assert.strictEqual(parse(sb, '开会 9:30').time, '09:30');
  assert.strictEqual(parse(sb, '下午3:30开会').time, '15:30');       // 时段参与映射
});
test('时间：X点半/X点Y分/X点整（含中文数字）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '两点半散步').time, '02:30');
  assert.strictEqual(parse(sb, '10点15分站会').time, '10:15');
  assert.strictEqual(parse(sb, '十点五十分取件').time, '10:50');
  assert.strictEqual(parse(sb, '12点整午餐').time, '12:00');
  assert.strictEqual(parse(sb, '9点上班').time, '09:00');
});
test('时间：时段前缀映射（上午原值/中午/下午+12/晚上≤11+12、12→0）', () => {
  const { sb } = loadApp();
  assert.strictEqual(parse(sb, '上午9点晨会').time, '09:00');
  assert.strictEqual(parse(sb, '中午12点吃饭').time, '12:00');
  assert.strictEqual(parse(sb, '下午三点开会').time, '15:00');
  assert.strictEqual(parse(sb, '下午12点午休').time, '12:00');
  assert.strictEqual(parse(sb, '晚上11点复盘').time, '23:00');
  assert.strictEqual(parse(sb, '晚上12点跨年').time, '00:00');
  assert.strictEqual(parse(sb, '下午3点半喝茶').time, '15:30');
});
test('相对时间：N小时后/N分钟后/半小时后（产生 date+time）', () => {
  const { sb } = loadApp();
  const p1 = parse(sb, '提醒我吃药 3小时后');
  assert.strictEqual(p1.time, '15:00');                              // 12:00 + 3h
  assert.strictEqual(p1.date, '2026-10-11');
  assert.strictEqual(p1.title, '提醒我吃药');
  assert.strictEqual(parse(sb, '半小时后取快递').time, '12:30');
  assert.strictEqual(parse(sb, '90分钟后续杯').time, '13:30');
  assert.strictEqual(parse(sb, '五分钟后下楼').time, '12:05');
});

// ---- 混合与边界 ----
test('混合输入：日期+时间+标题 剥离与压缩空白', () => {
  const { sb } = loadApp();
  const p = parse(sb, '明天下午3点半开会');
  assert.deepStrictEqual(p, { title: '开会', date: '2026-10-12', time: '15:30', hits: ['明天', '下午3点半'] });
  const p2 = parse(sb, '买菜   明天');
  assert.strictEqual(p2.title, '买菜');
  assert.strictEqual(p2.date, '2026-10-12');
});
test('优先级：绝对日期优先于相对（先长后短）', () => {
  const { sb } = loadApp();
  const p = parse(sb, '今天10月13号复诊');
  assert.strictEqual(p.date, '2026-10-13');
  assert.strictEqual(p.title, '今天 复诊');                          // 相对词未消费，剥离处以空格占位
});
test('日期已设时相对时间只回填时间（跨天拼接）', () => {
  const { sb } = loadApp();
  const p = parse(sb, '明天 2小时后取件');
  assert.strictEqual(p.date, '2026-10-12');
  assert.strictEqual(p.time, '14:00');                               // 以 now+2h 计时，date 保留明天
});
test('剥离后标题为空 → 整体不解析', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(parse(sb, '周五'), { title: '周五', date: '', time: '', hits: [] });
  assert.deepStrictEqual(parse(sb, '明天下午3点半'), { title: '明天下午3点半', date: '', time: '', hits: [] });
});
test('无命中：原样返回', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(parse(sb, '更新周报'), { title: '更新周报', date: '', time: '', hits: [] });
});
test('无命中：普通词不误判（周报/月度/观点）', () => {
  const { sb } = loadApp();
  for (const t of ['更新周报', '月度总结', '发表观点', '写日报']) {
    const p = parse(sb, t);
    assert.strictEqual(p.date + p.time, '', `${t} 不应解析出日期时间`);
    assert.strictEqual(p.title, t);
  }
});

// ---- 预览与面板 ----
test('quickInputPreview：日期(周X) + 时间', () => {
  const { sb } = loadApp();
  assert.strictEqual(preview(sb, '明天下午3点半开会'), '→ 10/12(周一) 15:30');
  assert.strictEqual(preview(sb, '更新周报'), '');
});
test('buildQuickAdd 面板：输入触发解析回填控件', () => {
  const { sb } = loadApp();
  const html = appEval(sb, `(() => { const p = document.createElement('div'); buildQuickAdd(p); return p.innerHTML; })()`);
  assert.ok(html.includes('qa-hint'), '面板应包含解析 hint 行');
  // 模拟输入「明天开会」→ 触发 input 事件
  const r = hostify(appEval(sb, `(() => {
    const p = document.createElement('div');
    buildQuickAdd(p);
    const title = p._qs['.qa-input'];
    title.value = '明天开会';
    title._fire('input', {});
    return { hint: p._qs['.qa-hint'].textContent, hidden: p._qs['.qa-hint'].hidden, date: p._qs['.qa-date'].value, time: p._qs['.qa-time'].value };
  })()`));
  assert.strictEqual(r.date, appEval(sb, 'dateKey(addDays(today(), 1))'));
  assert.strictEqual(r.time, '');
  assert.ok(r.hint.startsWith('→ '));
  assert.strictEqual(r.hidden, false);
  // 继续输入同结果文本 → hint 仍在但控件不被重复覆盖（值不变）
  const r2 = hostify(appEval(sb, `(() => {
    const p = document.createElement('div');
    buildQuickAdd(p);
    const title = p._qs['.qa-input'];
    title.value = '明天开会';
    title._fire('input', {});
    p._qs['.qa-date'].value = '2026-01-01';   // 模拟手动改控件
    title.value = '明天开会 讨论Q4';          // 解析结果未变
    title._fire('input', {});
    return { date: p._qs['.qa-date'].value };
  })()`));
  assert.strictEqual(r2.date, '2026-01-01', '解析结果未变化时不应覆盖手动修改');
});
