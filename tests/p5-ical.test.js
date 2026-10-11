'use strict';
// P4.3 iCal 互通：导出 → 导入往返测试
// eventsToIcs / parseIcs 为 app.js 顶层纯函数，经 vm 沙箱直接求值。
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

// 固定 DTSTAMP 输入（仅格式校验，不断言具体 UTC 值，避免测试机时区依赖）
const NOW = 'new Date(2026, 9, 11, 12, 0, 0)';
// 沙箱内执行 导出→解析 往返，返回宿主对象
function roundTrip(sb, eventsLiteral) {
  return hostify(appEval(sb, `parseIcs(eventsToIcs(${eventsLiteral}, ${NOW}))`));
}

test('iCal 导出：骨架 / CRLF / UID / DTSTAMP 格式', () => {
  const { sb } = loadApp();
  const ics = appEval(sb, `eventsToIcs([{ id: 'e1', title: '写周报', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: null }], ${NOW})`);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.includes('\r\nVERSION:2.0\r\n'));
  assert.ok(ics.includes('\r\nBEGIN:VEVENT\r\n'));
  assert.ok(ics.includes('\r\nUID:e1@timetable.local\r\n'));
  assert.match(ics, /\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('iCal 导出：全天单日 DTEND = 结束日 +1（RFC 非包含）', () => {
  const { sb } = loadApp();
  const ics = appEval(sb, `eventsToIcs([{ id: 'e1', title: '全天', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: null }], ${NOW})`);
  assert.ok(ics.includes('\r\nDTSTART;VALUE=DATE:20261005\r\n'));
  assert.ok(ics.includes('\r\nDTEND;VALUE=DATE:20261006\r\n'));
});

test('iCal 导出：全天多日区间 10-05~10-08 → DTEND 20261009', () => {
  const { sb } = loadApp();
  const ics = appEval(sb, `eventsToIcs([{ id: 'e1', title: '出差', startDate: '2026-10-05', endDate: '2026-10-08', time: '', category: 'work', tags: [], description: '', done: false, recur: null }], ${NOW})`);
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261005'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261009'));
});

test('iCal 导出：有时间事件 DTSTART/DTEND 同结束时刻', () => {
  const { sb } = loadApp();
  const ics = appEval(sb, `eventsToIcs([{ id: 'e1', title: '开会', startDate: '2026-10-05', endDate: '2026-10-05', time: '09:30', category: 'work', tags: [], description: '', done: false, recur: null }], ${NOW})`);
  assert.ok(ics.includes('\r\nDTSTART:20261005T093000\r\n'));
  assert.ok(ics.includes('\r\nDTEND:20261005T093000\r\n'));
});

test('iCal 导出：RRULE 四种频率 + UNTIL 映射', () => {
  const { sb } = loadApp();
  const mk = (recur) => appEval(sb, `eventsToIcs([{ id: 'e1', title: '重复', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: ${recur} }], ${NOW})`);
  assert.ok(mk(`{ freq: 'daily', interval: 2 }`).includes('\r\nRRULE:FREQ=DAILY;INTERVAL=2\r\n'));
  assert.ok(mk(`{ freq: 'weekdays', interval: 1 }`).includes('\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR\r\n'));
  // 2026-10-05 是周一 → weekly BYDAY=MO
  assert.ok(mk(`{ freq: 'weekly', interval: 1 }`).includes('\r\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO\r\n'));
  assert.ok(mk(`{ freq: 'monthly', interval: 3 }`).includes('\r\nRRULE:FREQ=MONTHLY;INTERVAL=3\r\n'));
  assert.ok(mk(`{ freq: 'weekly', interval: 1, until: '2026-12-31' }`).includes(';UNTIL=20261231T235959\r\n'));
});

test('iCal 导出/导入：特殊字符转义与还原（逗号/分号/反斜杠/换行）', () => {
  const { sb } = loadApp();
  const ics = appEval(sb, `eventsToIcs([{ id: 'e1', title: 'a,b;c\\\\d\\ne', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: null }], ${NOW})`);
  assert.ok(ics.includes('SUMMARY:a\\,b\\;c\\\\d\\ne\r\n'));
  const out = roundTrip(sb, `[{ id: 'e1', title: 'a,b;c\\\\d\\ne', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: null }]`);
  assert.strictEqual(out[0].title, 'a,b;c\\d\ne');
});

test('iCal 往返：全天多日 endDate 还原为包含式末日', () => {
  const { sb } = loadApp();
  const out = roundTrip(sb, `[{ id: 'e1', title: '出差', startDate: '2026-10-05', endDate: '2026-10-08', time: '', category: 'work', tags: [], description: '', done: false, recur: null }]`);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].startDate, '2026-10-05');
  assert.strictEqual(out[0].endDate, '2026-10-08');
  assert.strictEqual(out[0].time, '');
});

test('iCal 往返：有时间事件 time 还原', () => {
  const { sb } = loadApp();
  const out = roundTrip(sb, `[{ id: 'e1', title: '开会', startDate: '2026-10-05', endDate: '2026-10-06', time: '09:30', category: 'family', tags: [], description: '', done: false, recur: null }]`);
  assert.strictEqual(out[0].time, '09:30');
  assert.strictEqual(out[0].endDate, '2026-10-06');   // 跨天取 DTEND 日期
});

test('iCal 往返：重复规则（weekly + until）还原', () => {
  const { sb } = loadApp();
  const out = roundTrip(sb, `[{ id: 'e1', title: '周会', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'work', tags: [], description: '', done: false, recur: { freq: 'weekly', interval: 1, until: '2026-12-31' } }]`);
  assert.deepStrictEqual(out[0].recur, { freq: 'weekly', interval: 1, until: '2026-12-31' });
});

test('iCal 往返：完成态 / 分类 / tags / 备注还原', () => {
  const { sb } = loadApp();
  const out = roundTrip(sb, `[{ id: 'e1', title: '买菜', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'personal', tags: ['重要', '外出'], description: '顺路取快递', done: true, recur: null }]`);
  assert.strictEqual(out[0].done, true);
  assert.strictEqual(out[0].category, 'personal');
  assert.deepStrictEqual(out[0].tags, ['重要', '外出']);
  assert.strictEqual(out[0].description, '顺路取快递');
});

test('iCal 导入：RFC 5545 行折叠展开', () => {
  const { sb } = loadApp();
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:x@y',
    'DTSTART;VALUE=DATE:20261005',
    'DTEND;VALUE=DATE:20261006',
    'SUMMARY:hello',
    ' world',                                 // 空格开头的续行
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const out = hostify(appEval(sb, `parseIcs(${JSON.stringify(ics)})`));
  assert.strictEqual(out[0].title, 'helloworld');
});

test('iCal 导入：不支持 FREQ 落不重复 + 备注说明', () => {
  const { sb } = loadApp();
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x@y',
    'DTSTART:20261005T090000',
    'DTEND:20261005T090000',
    'SUMMARY:年度体检',
    'RRULE:FREQ=YEARLY;INTERVAL=1',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const out = hostify(appEval(sb, `parseIcs(${JSON.stringify(ics)})`));
  assert.strictEqual(out[0].recur, null);
  assert.ok(out[0].description.includes('原重复规则未支持导入'));
  assert.ok(out[0].description.includes('FREQ=YEARLY'));
});

test('iCal 导入：外部文件（P9.2 起 Z 后缀 UTC 时间转换为本地墙钟）', () => {
  const { sb } = loadApp();
  const ics = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'DTSTART:20261005T013000Z',
    'DTEND:20261005T023000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;INTERVAL=1',
    'DTSTAMP:20261001T000000Z',
    'CREATED:20261001T000000Z',
    'LAST-MODIFIED:20261001T000000Z',
    'UID:abc123@google.com',
    'CREATED旁注行应被忽略'.replace('旁注行应被忽略', ''),
    'SUMMARY:站会',
    'CATEGORIES:工作,例会',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const out = hostify(appEval(sb, `parseIcs(${JSON.stringify(ics)})`));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, '站会');
  // UTC → 本机本地墙钟（应用"时间即本地墙钟"约定）；期望值按测试机时区动态计算
  const d = new Date(Date.UTC(2026, 9, 5, 1, 30));
  const pad = (n) => String(n).padStart(2, '0');
  assert.strictEqual(out[0].startDate, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  assert.strictEqual(out[0].time, `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  assert.strictEqual(out[0].tzid, 'UTC');
  assert.strictEqual(out[0].category, 'work');        // 中文标签「工作」→ work
  assert.deepStrictEqual(out[0].tags, ['例会']);       // 其余词作 tags
  assert.strictEqual(out[0].recur.freq, 'weekly');    // 单 BYDAY=MO → weekly
  assert.strictEqual(out[0].recur.interval, 1);
});

test('iCal 导入：缺 DTSTART 的 VEVENT 块丢弃，空闲文本忽略', () => {
  const { sb } = loadApp();
  const ics = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:随便什么',
    'BEGIN:VEVENT',
    'SUMMARY:坏块',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261005',
    'SUMMARY:好块',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const out = hostify(appEval(sb, `parseIcs(${JSON.stringify(ics)})`));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, '好块');
  assert.strictEqual(out[0].startDate, '2026-10-05');
});

test('iCal 往返：weekdays / daily 往返还原', () => {
  const { sb } = loadApp();
  const out = roundTrip(sb, `[
    { id: 'e1', title: '晨会', startDate: '2026-10-05', endDate: '2026-10-05', time: '08:00', category: 'work', tags: [], description: '', done: false, recur: { freq: 'weekdays', interval: 1, until: '' } },
    { id: 'e2', title: '浇花', startDate: '2026-10-05', endDate: '2026-10-05', time: '', category: 'family', tags: [], description: '', done: false, recur: { freq: 'daily', interval: 3, until: '' } }
  ]`);
  assert.deepStrictEqual(out[0].recur, { freq: 'weekdays', interval: 1, until: '' });
  assert.strictEqual(out[0].time, '08:00');
  assert.deepStrictEqual(out[1].recur, { freq: 'daily', interval: 3, until: '' });
});
