'use strict';
// P9.2 外部日历订阅增强：ICS 扩展字段解析、UID 兜底、缓存 v2、extKey/diff、
// 条件请求 304、失败保留旧缓存、刷新频率到期、订阅定义迁移、取消事件投影
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

function vevent(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function parseOne(sb, lines) {
  const out = hostify(appEval(sb, `parseIcs(${JSON.stringify(vevent(lines))})`));
  assert.strictEqual(out.length, 1);
  return out[0];
}

// ---------- ICS 解析增强 ----------

test('parseIcs：UID/LOCATION/SEQUENCE/CREATED/LAST-MODIFIED/DTSTAMP/STATUS 全提取', () => {
  const { sb } = loadApp();
  const ev = parseOne(sb, [
    'UID:evt-1@example.com',
    'DTSTART;VALUE=DATE:20261010',
    'DTEND;VALUE=DATE:20261011',
    'SUMMARY:发布版本',
    'LOCATION:3 号会议室',
    'SEQUENCE:3',
    'STATUS:CONFIRMED',
    'CREATED:20260901T010203Z',
    'LAST-MODIFIED:20260920T040506Z',
    'DTSTAMP:20260920T040506Z'
  ]);
  assert.strictEqual(ev.uid, 'evt-1@example.com');
  assert.strictEqual(ev.location, '3 号会议室');
  assert.strictEqual(ev.sequence, 3);
  assert.strictEqual(ev.status, 'confirmed');
  assert.strictEqual(ev.createdAt, '2026-09-01T01:02:03.000Z');
  assert.strictEqual(ev.updatedAt, '2026-09-20T04:05:06.000Z');
  assert.strictEqual(ev.allDay, true);
  assert.strictEqual(ev.time, '');
  assert.strictEqual(ev.remindAhead, null);
});

test('parseIcs：CANCELLED 状态识别；DTSTAMP 回退 createdAt/updatedAt', () => {
  const { sb } = loadApp();
  const ev = parseOne(sb, [
    'UID:cancel-1', 'DTSTART:20261010T090000', 'SUMMARY:取消的会',
    'STATUS:CANCELLED', 'DTSTAMP:20261001T000000Z'
  ]);
  assert.strictEqual(ev.status, 'cancelled');
  assert.strictEqual(ev.createdAt, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(ev.updatedAt, '2026-10-01T00:00:00.000Z');
});

test('parseIcs：全天多日 DTEND 反推包含式末日；浮动时间 TZID 仅记录不换算', () => {
  const { sb } = loadApp();
  const a = parseOne(sb, ['UID:a', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261013', 'SUMMARY:全天多日']);
  assert.strictEqual(a.startDate, '2026-10-10');
  assert.strictEqual(a.endDate, '2026-10-12');
  assert.strictEqual(a.allDay, true);
  const b = parseOne(sb, ['UID:b', 'DTSTART;TZID=Asia/Shanghai:20261010T090000', 'DTEND;TZID=Asia/Shanghai:20261010T100000', 'SUMMARY:本地时']);
  assert.strictEqual(b.startDate, '2026-10-10');
  assert.strictEqual(b.time, '09:00');
  assert.strictEqual(b.tzid, 'Asia/Shanghai');
  assert.strictEqual(b.allDay, false);
});

test('parseIcs：Z 结尾 UTC 转本地墙钟', () => {
  const { sb } = loadApp();
  const ev = parseOne(sb, ['UID:z', 'DTSTART:20261010T013000Z', 'DTEND:20261010T023000Z', 'SUMMARY:UTC 会']);
  const d = new Date(Date.UTC(2026, 9, 10, 1, 30));
  const pad = (n) => String(n).padStart(2, '0');
  assert.strictEqual(ev.startDate, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  assert.strictEqual(ev.time, `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  assert.strictEqual(ev.tzid, 'UTC');
});

test('parseIcs：VALARM TRIGGER 负向时长 → 提前分钟；绝对/正向忽略', () => {
  const { sb } = loadApp();
  const cases = [
    ['-PT15M', 15], ['-PT1H30M', 90], ['-P1D', 1440], ['-PT0D', 0],
    ['-P1DT2H', 1560]
  ];
  for (const [trig, want] of cases) {
    const ev = parseOne(sb, ['UID:' + trig, 'DTSTART:20261010T090000', 'SUMMARY:x',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${trig}`, 'DESCRIPTION:提醒', 'END:VALARM']);
    assert.strictEqual(ev.remindAhead, want, trig);
  }
  // 绝对触发时间（VALUE=DATE-TIME）不支持 → null
  const abs = parseOne(sb, ['UID:abs', 'DTSTART:20261010T090000', 'SUMMARY:x',
    'BEGIN:VALARM', 'TRIGGER;VALUE=DATE-TIME:20261010T080000Z', 'END:VALARM']);
  assert.strictEqual(abs.remindAhead, null);
  // 正向 TRIGGER（事件后）不支持 → null
  const pos = parseOne(sb, ['UID:pos', 'DTSTART:20261010T090000', 'SUMMARY:x',
    'BEGIN:VALARM', 'TRIGGER:PT15M', 'END:VALARM']);
  assert.strictEqual(pos.remindAhead, null);
});

test('icsFallbackUid：UID 缺失时按内容哈希稳定生成，内容不同则不同', () => {
  const { sb } = loadApp();
  const ev1 = parseOne(sb, ['DTSTART;VALUE=DATE:20261010', 'SUMMARY:无 UID 会议']);
  const ev2 = parseOne(sb, ['DTSTART;VALUE=DATE:20261010', 'SUMMARY:无 UID 会议']);
  const ev3 = parseOne(sb, ['DTSTART;VALUE=DATE:20261011', 'SUMMARY:无 UID 会议']);
  assert.ok(ev1.uid.startsWith('h:'));
  assert.strictEqual(ev1.uid, ev2.uid, '同内容同哈希');
  assert.notStrictEqual(ev1.uid, ev3.uid, '日期变了哈希不同');
});

// ---------- 订阅定义迁移与缓存 v2 ----------

test('loadCalSubs 迁移：补 refreshIntervalMin/etag/lastModified/providerType，非法频率回 60', () => {
  const { sb, storage } = loadApp();
  storage.setItem('calSubscriptions', JSON.stringify([
    { id: 'cs1', url: 'https://a.com/a.ics', name: '旧订阅' },
    { id: 'cs2', url: 'https://b.com/b.ics', name: '手动', refreshIntervalMin: -1 },
    { id: 'cs3', url: 'https://c.com/c.ics', name: '怪频率', refreshIntervalMin: 7 }
  ]));
  appEval(sb, 'calSubsCache = null');
  const subs = hostify(appEval(sb, 'loadCalSubs()'));
  assert.strictEqual(subs[0].refreshIntervalMin, 60);
  assert.strictEqual(subs[0].etag, '');
  assert.strictEqual(subs[0].lastModified, '');
  assert.strictEqual(subs[0].providerType, 'ics-url');
  assert.strictEqual(subs[1].refreshIntervalMin, -1);
  assert.strictEqual(subs[2].refreshIntervalMin, 60);
});

test('订阅缓存：save 写 version:2；v1 缓存读取时补 uid', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveCalSubEvents('cs1', [{uid:'u1',title:'新',startDate:'2026-10-10',endDate:'2026-10-10'}], '2026-10-01T00:00:00.000Z')`);
  const raw = JSON.parse(storage.getItem('calSubCache_cs1'));
  assert.strictEqual(raw.version, 2);
  assert.strictEqual(raw.syncedAt, '2026-10-01T00:00:00.000Z');
  // v1 缓存（无 version、事件无 uid）
  storage.setItem('calSubCache_cs2', JSON.stringify({
    syncedAt: '2026-09-01T00:00:00.000Z',
    events: [{ title: '旧缓存事件', startDate: '2026-10-10', endDate: '2026-10-10' }]
  }));
  const evs = hostify(appEval(sb, `loadCalSubEvents('cs2')`));
  assert.ok(evs[0].uid.startsWith('h:'), 'v1 事件当场补 uid');
});

// ---------- 稳定身份与差异 ----------

test('extEventKey：subId + uid（缺失自动哈希）', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `extEventKey('cs1', {uid:'u1'})`), 'cs1#u1');
  const k = appEval(sb, `extEventKey('cs1', {title:'t',startDate:'2026-10-10',endDate:'2026-10-10',allDay:true})`);
  assert.ok(k.startsWith('cs1#h:'));
});

test('diffExtEvents：added/updated(sequence/updatedAt/内容)/removed/cancelled', () => {
  const { sb } = loadApp();
  const mk = (o) => Object.assign({ uid: 'u', title: 't', startDate: '2026-10-10', endDate: '2026-10-10', time: '', allDay: true, status: 'confirmed', sequence: 0, updatedAt: '', location: '', description: '', remindAhead: null, recur: null }, o);
  const old = [mk({ uid: 'keep' }), mk({ uid: 'gone' }), mk({ uid: 'upd', sequence: 1 }), mk({ uid: 'can' })];
  const neu = [
    mk({ uid: 'keep' }),
    mk({ uid: 'new' }),
    mk({ uid: 'upd', sequence: 2 }),
    mk({ uid: 'can', status: 'cancelled' })
  ];
  const d = hostify(appEval(sb, `diffExtEvents(${JSON.stringify(old)}, ${JSON.stringify(neu)})`));
  assert.deepStrictEqual(d.added, ['new']);
  assert.deepStrictEqual(d.removed, ['gone']);
  assert.deepStrictEqual(d.updated, ['upd', 'can']);  // seq 升级；can 状态改变也算内容更新
  assert.deepStrictEqual(d.cancelledKeys, ['can']);
  // updatedAt 变化也算更新
  const d2 = hostify(appEval(sb, `diffExtEvents(${JSON.stringify([mk({ uid: 'a' })])}, ${JSON.stringify([mk({ uid: 'a', updatedAt: '2026-10-01T00:00:00.000Z' })])})`));
  assert.deepStrictEqual(d2.updated, ['a']);
  // 标题变化（无 seq/updatedAt）→ 内容哈希兜底
  const d3 = hostify(appEval(sb, `diffExtEvents(${JSON.stringify([mk({ uid: 'a' })])}, ${JSON.stringify([mk({ uid: 'a', title: '改标题' })])})`));
  assert.deepStrictEqual(d3.updated, ['a']);
  // 完全一致 → 无差异
  const d4 = hostify(appEval(sb, `diffExtEvents(${JSON.stringify([mk({ uid: 'a' })])}, ${JSON.stringify([mk({ uid: 'a' })])})`));
  assert.deepStrictEqual(d4, { added: [], updated: [], removed: [], cancelledKeys: [] });
});

test('diffSubExtEvents：差异 key 带订阅前缀', () => {
  const { sb } = loadApp();
  const mk = (uid) => ({ uid, title: 't', startDate: '2026-10-10', endDate: '2026-10-10', allDay: true });
  const d = hostify(appEval(sb, `diffSubExtEvents('cs7', ${JSON.stringify([mk('a')])}, ${JSON.stringify([mk('b')])})`));
  assert.deepStrictEqual(d.added, ['cs7#b']);
  assert.deepStrictEqual(d.removed, ['cs7#a']);
});

// ---------- 到期判断 ----------

test('calSubDue：无 lastSync 到期；-1 仅手动；按频率判定', () => {
  const { sb } = loadApp();
  const now = Date.parse('2026-10-10T12:00:00');
  assert.strictEqual(appEval(sb, `calSubDue({refreshIntervalMin:60,lastSync:''}, ${now})`), true);
  assert.strictEqual(appEval(sb, `calSubDue({refreshIntervalMin:-1,lastSync:''}, ${now})`), false);
  assert.strictEqual(appEval(sb, `calSubDue({refreshIntervalMin:60,lastSync:'2026-10-10T11:30:00'}, ${now})`), false, '30 分钟未到期');
  assert.strictEqual(appEval(sb, `calSubDue({refreshIntervalMin:60,lastSync:'2026-10-10T10:59:00'}, ${now})`), true, '61 分钟已到期');
  assert.strictEqual(appEval(sb, `calSubDue({refreshIntervalMin:1440,lastSync:'2026-10-09T12:01:00'}, ${now})`), false);
});

// ---------- 拉取：200 / 304 / 失败保留缓存 ----------

const ICS_A = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  'UID:u1', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011', 'SUMMARY:会 A',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

// 在沙箱内安装 calSubFetch 桩（resExpr 为返回结果的 JS 表达式字符串）
function stubFetch(sb, resExpr) {
  return appEval(sb, `(async () => {
    window.timetable = { calSubFetch: async (url, opts) => (${resExpr}) };
  })()`);
}

// sub 须留在沙箱内（就地更新发生在 vm 对象上），刷新后挂到 __sub 回读
async function refreshInSandbox(sb, subLiteral) {
  await appEval(sb, `(async () => {
    globalThis.__sub = ${subLiteral};
    globalThis.__ok = await calSubRefreshOne(globalThis.__sub);
  })()`);
  return {
    ok: appEval(sb, `globalThis.__ok`),
    sub: hostify(appEval(sb, `globalThis.__sub`))
  };
}

test('calSubRefreshOne：200 覆盖缓存（v2）并保存 etag/lastSync', async () => {
  const { sb, storage } = loadApp();
  await stubFetch(sb, `({ ok: true, content: ${JSON.stringify(ICS_A)}, etag: '"v1"', lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT' })`);
  const { ok, sub } = await refreshInSandbox(sb, `{ id: 'cs1', url: 'https://a.com/a.ics', etag: '', lastModified: '', lastSync: '', lastError: 'x' }`);
  assert.strictEqual(ok, true);
  assert.strictEqual(sub.etag, '"v1"');
  assert.strictEqual(sub.lastModified, 'Mon, 01 Sep 2026 00:00:00 GMT');
  assert.ok(sub.lastSync);
  assert.strictEqual(sub.lastError, '');
  const raw = JSON.parse(storage.getItem('calSubCache_cs1'));
  assert.strictEqual(raw.version, 2);
  assert.strictEqual(raw.events[0].title, '会 A');
});

test('calSubRefreshOne：304 不覆盖缓存与 syncedAt，但更新 lastSync/etag（修复到期重发轮询）', async () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveCalSubEvents('cs1', parseIcs(${JSON.stringify(ICS_A)}), '2026-09-01T00:00:00.000Z')`);
  await stubFetch(sb, `({ ok: true, notModified: true, etag: '"v2"', lastModified: '' })`);
  const { ok, sub } = await refreshInSandbox(sb, `{ id: 'cs1', url: 'https://a.com/a.ics', etag: '"v1"', lastModified: '', lastSync: '2026-09-01T00:00:00.000Z', lastError: '旧错误' }`);
  assert.strictEqual(ok, true);
  assert.ok(sub.lastSync && sub.lastSync !== '2026-09-01T00:00:00.000Z', '304 更新 lastSync（成功联系），否则 calSubDue 永远判定到期');
  assert.strictEqual(sub.etag, '"v2"');
  assert.strictEqual(sub.lastError, '');
  const raw = JSON.parse(storage.getItem('calSubCache_cs1'));
  assert.strictEqual(raw.events[0].title, '会 A', '旧缓存保留');
  assert.strictEqual(raw.syncedAt, '2026-09-01T00:00:00.000Z', '缓存内容时间戳不变');
  // 刷新频率语义回归：304 刷新后立即不再到期
  const now = Date.parse(sub.lastSync) + 1000;
  assert.strictEqual(appEval(sb, `calSubDue({ refreshIntervalMin: 60, lastSync: ${JSON.stringify(sub.lastSync)} }, ${now})`), false, '1 小时档 304 后不应立即到期');
});

test('calSubRefreshOne：网络/解析失败保留旧缓存并标记错误', async () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveCalSubEvents('cs1', parseIcs(${JSON.stringify(ICS_A)}), '2026-09-01T00:00:00.000Z')`);
  await stubFetch(sb, `({ ok: false, error: 'HTTP 500' })`);
  const { ok, sub } = await refreshInSandbox(sb, `{ id: 'cs1', url: 'https://a.com/a.ics', etag: '', lastModified: '', lastSync: '2026-09-01T00:00:00.000Z', lastError: '' }`);
  assert.strictEqual(ok, false);
  assert.strictEqual(sub.lastError, 'HTTP 500');
  const raw = JSON.parse(storage.getItem('calSubCache_cs1'));
  assert.strictEqual(raw.events[0].title, '会 A', '失败不覆盖缓存');
  // 状态：有旧缓存 → stale 过期提示；无缓存 → err
  const stale = hostify(appEval(sb, `calSubStatusInfo(globalThis.__sub)`));
  assert.strictEqual(stale.cls, 'stale');
  assert.ok(stale.text.includes('数据可能过期'));
  storage.removeItem('calSubCache_cs1');
  appEval(sb, `calSubEventsMemo.delete('cs1')`);
  const err = hostify(appEval(sb, `calSubStatusInfo(globalThis.__sub)`));
  assert.strictEqual(err.cls, 'err');
});

test('calSubRefreshAll：非 manual 只刷到期订阅；manual 刷全部启用订阅', async () => {
  const { sb } = loadApp();
  await appEval(sb, `(async () => {
    globalThis.__calls = [];
    window.timetable = { calSubFetch: async (url) => { globalThis.__calls.push(url); return { ok: true, content: ${JSON.stringify(ICS_A)}, etag: '', lastModified: '' }; } };
    saveCalSubs([
      { id: 'cs1', name: '到期', url: 'https://a.com/a.ics', enabled: true, refreshIntervalMin: 60, lastSync: '', lastError: '', etag: '', lastModified: '' },
      { id: 'cs2', name: '未到期', url: 'https://b.com/b.ics', enabled: true, refreshIntervalMin: 60, lastSync: '2099-10-10T11:59:00', lastError: '', etag: '', lastModified: '' },
      { id: 'cs3', name: '手动档', url: 'https://c.com/c.ics', enabled: true, refreshIntervalMin: -1, lastSync: '', lastError: '', etag: '', lastModified: '' }
    ]);
  })()`);
  await appEval(sb, `calSubRefreshAll(true, false)`);
  let called = hostify(appEval(sb, `globalThis.__calls`));
  assert.deepStrictEqual(called, ['https://a.com/a.ics'], '仅无 lastSync 的 cs1 到期（cs2 未来时间，cs3 仅手动）');
  await appEval(sb, `globalThis.__calls = []`);
  await appEval(sb, `calSubRefreshAll(true, true)`);
  called = hostify(appEval(sb, `globalThis.__calls`));
  assert.strictEqual(called.length, 3, '手动刷新忽略频率（-1 也刷）');
});

// ---------- 投影：取消事件 / 稳定 id ----------

test('getCalSubEventsByDate：取消事件仍投影并带 _cancelled；非重复 id=extKey', () => {
  const { sb, storage } = loadApp();
  storage.setItem('calSubscriptions', JSON.stringify([
    { id: 'cs1', url: 'https://a.com/a.ics', name: '源', enabled: true, refreshIntervalMin: -1 }
  ]));
  appEval(sb, 'calSubsCache = null');
  storage.setItem('calSubCache_cs1', JSON.stringify({
    version: 2, syncedAt: '2026-10-01T00:00:00.000Z',
    events: [
      { uid: 'u1', title: '正常', startDate: '2026-10-10', endDate: '2026-10-10', allDay: true, status: 'confirmed' },
      { uid: 'u2', title: '取消', startDate: '2026-10-10', endDate: '2026-10-10', allDay: true, status: 'cancelled' }
    ]
  }));
  appEval(sb, `calSubEventsMemo.delete('cs1')`);
  const day = hostify(appEval(sb, `getCalSubEventsByDate('2026-10-10')`));
  assert.strictEqual(day.length, 2);
  const normal = day.find(e => e.uid === 'u1');
  const cancelled = day.find(e => e.uid === 'u2');
  assert.strictEqual(normal.id, 'cs1#u1');
  assert.strictEqual(normal._extKey, 'cs1#u1');
  assert.strictEqual(normal._cancelled, false);
  assert.strictEqual(cancelled._cancelled, true);
});
