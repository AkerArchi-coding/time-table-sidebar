'use strict';
// P9.3 外部事件提醒：触发时刻/提前量优先级/到期判定/账本去重与更新重提/
// 取消与静音/刷新联动清理/checkExtReminders 端到端/详情浮层存本地事项与提醒配置
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

const SUB = { id: 'cs1', name: '源', url: 'https://x/a.ics', enabled: true, refreshIntervalMin: -1 };
function ev(o) {
  return Object.assign({
    uid: 'u1', title: '外部会', startDate: '2026-10-10', endDate: '2026-10-10',
    time: '10:00', allDay: false, status: 'confirmed', remindAhead: null, recur: null
  }, o);
}

test('extTriggerMs：全天 09:00；有时间按 HH:MM；提前量前移；非法日期 null', () => {
  const { sb } = loadApp();
  assert.strictEqual(appEval(sb, `extTriggerMs(${JSON.stringify(ev({ allDay: true, time: '' }))}, '2026-10-10', 0)`),
    new Date(2026, 9, 10, 9, 0, 0).getTime());
  assert.strictEqual(appEval(sb, `extTriggerMs(${JSON.stringify(ev({ allDay: true, time: '' }))}, '2026-10-10', 15)`),
    new Date(2026, 9, 10, 8, 45, 0).getTime());
  assert.strictEqual(appEval(sb, `extTriggerMs(${JSON.stringify(ev())}, '2026-10-10', 30)`),
    new Date(2026, 9, 10, 9, 30, 0).getTime());
  assert.strictEqual(appEval(sb, `extTriggerMs(${JSON.stringify(ev())}, 'bad', 0)`), null);
});

test('extAheadMin：静音 > 单事件覆盖 > VALARM > 全局默认；0 覆盖有效', () => {
  const { sb } = loadApp();
  const e = JSON.stringify(ev({ remindAhead: 15 }));
  assert.strictEqual(appEval(sb, `extAheadMin(${e}, {muted:true}, 10)`), null);
  assert.strictEqual(appEval(sb, `extAheadMin(${e}, {aheadMin:30}, 10)`), 30);
  assert.strictEqual(appEval(sb, `extAheadMin(${e}, {aheadMin:0}, 10)`), 0);
  assert.strictEqual(appEval(sb, `extAheadMin(${e}, null, 10)`), 15);
  assert.strictEqual(appEval(sb, `extAheadMin(${JSON.stringify(ev({ remindAhead: null }))}, null, 10)`), 10);
});

test('dueExtReminders：全天 09:00 到点/未到点', () => {
  const { sb } = loadApp();
  const caches = `{ cs1: [${JSON.stringify(ev({ allDay: true, time: '' }))}] }`;
  const call = (dateExpr) =>
    hostify(appEval(sb, `dueExtReminders([${JSON.stringify(SUB)}], ${caches}, {events:{}}, {}, new Date(2026,9,10,${dateExpr}))`));
  assert.strictEqual(call('8,59,59').length, 0, '08:59 未到 09:00');
  assert.strictEqual(call('9,0,0').length, 1, '09:00 准点触发');
  assert.strictEqual(call('23,59,59').length, 1, '当日内仍可触发');
});

test('dueExtReminders：有时间事件按提前量；账本同版本去重、版本变化重提', () => {
  const { sb } = loadApp();
  const caches = `{ cs1: [${JSON.stringify(ev({ remindAhead: 15 }))}] }`;
  const base = `dueExtReminders([${JSON.stringify(SUB)}], ${caches}, {events:{}}, LEDGER, new Date(2026,9,10,9,45,0))`;
  assert.strictEqual(appEval(sb, base.replace('LEDGER', '{}')).length, 1, '09:45 = 10:00 提前 15 分');
  assert.strictEqual(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${caches}, {events:{}}, {}, new Date(2026,9,10,9,44,59)).length`), 0);
  // 同版本已入账 → 跳过
  const v = appEval(sb, `extEventVersion(${JSON.stringify(ev({ remindAhead: 15 }))})`);
  const ledgerSame = `{ 'cs1#u1|2026-10-10': { v: ${JSON.stringify(v)}, ts: 1 } }`;
  assert.strictEqual(appEval(sb, base.replace('LEDGER', ledgerSame)).length, 0);
  // 旧版本账本 → 事件更新后重新提醒
  assert.strictEqual(appEval(sb,
    base.replace('LEDGER', `{ 'cs1#u1|2026-10-10': { v: 'stale', ts: 1 } }`)).length, 1);
});

test('dueExtReminders：已取消/已静音跳过；多日事件仅开始日提醒', () => {
  const { sb } = loadApp();
  const cancelled = `{ cs1: [${JSON.stringify(ev({ status: 'cancelled' }))}] }`;
  assert.strictEqual(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${cancelled}, {events:{}}, {}, new Date(2026,9,10,10,0,0)).length`), 0);
  const muted = `{ events: { 'cs1#u1': { muted: true } } }`;
  const caches = `{ cs1: [${JSON.stringify(ev())}] }`;
  assert.strictEqual(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${caches}, ${muted}, {}, new Date(2026,9,10,10,0,0)).length`), 0);
  // 多日全天：10-10~10-12，10-11 不提醒
  const multi = `{ cs1: [${JSON.stringify(ev({ allDay: true, time: '', startDate: '2026-10-10', endDate: '2026-10-12' }))}] }`;
  assert.strictEqual(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${multi}, {events:{}}, {}, new Date(2026,9,11,9,0,0)).length`), 0);
  assert.strictEqual(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${multi}, {events:{}}, {}, new Date(2026,9,10,9,0,0)).length`), 1);
});

test('dueExtReminders：重复事件命中当日按出现日提醒，ledgerKey 带出现日', () => {
  const { sb } = loadApp();
  const daily = ev({ startDate: '2026-09-01', endDate: '2026-09-01', recur: { freq: 'daily', interval: 1 } });
  const caches = `{ cs1: [${JSON.stringify(daily)}] }`;
  const out = hostify(appEval(sb,
    `dueExtReminders([${JSON.stringify(SUB)}], ${caches}, {events:{}}, {}, new Date(2026,9,10,10,0,0))`));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].ledgerKey, 'cs1#u1|2026-10-10');
  assert.strictEqual(out[0].occDate, '2026-10-10');
});

test('onCalSubEventsReplaced：移除/取消/更新清账本，无差异保留', () => {
  const { sb, storage } = loadApp();
  storage.setItem('calRemindLedger', JSON.stringify({
    'cs1#gone|2026-10-10': { v: 'c1', ts: 1 },
    'cs1#can|2026-10-10': { v: 'c1', ts: 1 },
    'cs1#upd|2026-10-10': { v: 's1', ts: 1 },
    'cs1#keep|2026-10-10': { v: 'c1', ts: 1 },
    'cs9#other|2026-10-10': { v: 'c1', ts: 1 }
  }));
  const mk = (uid, extra) => ev(Object.assign({ uid }, extra));
  const oldEvs = [mk('gone'), mk('can'), mk('upd', { sequence: 1 }), mk('keep')];
  const newEvs = [mk('can', { status: 'cancelled' }), mk('upd', { sequence: 2 }), mk('keep')];
  appEval(sb, `onCalSubEventsReplaced(${JSON.stringify(SUB)}, ${JSON.stringify(oldEvs)}, ${JSON.stringify(newEvs)})`);
  const ledger = JSON.parse(storage.getItem('calRemindLedger'));
  assert.deepStrictEqual(Object.keys(ledger).sort(), ['cs1#keep|2026-10-10', 'cs9#other|2026-10-10']);
  // 再次以完全相同列表刷新：账本不动
  const before = storage.getItem('calRemindLedger');
  appEval(sb, `onCalSubEventsReplaced(${JSON.stringify(SUB)}, ${JSON.stringify(newEvs)}, ${JSON.stringify(newEvs)})`);
  assert.strictEqual(storage.getItem('calRemindLedger'), before);
});

test('removeCalSub/pruneCalEventStateForSub：连带清理该订阅配置与账本', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveCalSubs([
    { id: 'cs1', name: 'a', url: 'https://x/1', refreshIntervalMin: -1 },
    { id: 'cs2', name: 'b', url: 'https://x/2', refreshIntervalMin: -1 }
  ])`);
  storage.setItem('calEventCfg', JSON.stringify({ events: { 'cs1#u1': { muted: true }, 'cs2#u9': { aheadMin: 5 } } }));
  storage.setItem('calRemindLedger', JSON.stringify({ 'cs1#u1|2026-10-10': { v: 'c1' }, 'cs2#u9|2026-10-10': { v: 'c1' } }));
  appEval(sb, `removeCalSub('cs1')`);
  assert.deepStrictEqual(Object.keys(JSON.parse(storage.getItem('calEventCfg')).events), ['cs2#u9']);
  assert.deepStrictEqual(Object.keys(JSON.parse(storage.getItem('calRemindLedger'))), ['cs2#u9|2026-10-10']);
});

test('checkExtReminders 端到端：到点写账本并响铃一次，重复检查不重提；静音不触发', () => {
  const { sb } = loadApp();
  const seedAndCheck = `(() => {
    globalThis.__chime = (globalThis.__chime || 0);
    if (!globalThis.__spyInstalled) {
      globalThis.__spyInstalled = true;
      playChime = () => { globalThis.__chime++; };
    }
    saveCalSubs([${JSON.stringify(Object.assign({}, SUB, { lastSync: '', lastError: '', etag: '', lastModified: '' }))}]);
    const t = new Date(Date.now() - 2 * 60000);
    const pad = (x) => String(x).padStart(2, '0');
    const tk = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
    const hhmm = pad(t.getHours()) + ':' + pad(t.getMinutes());
    saveCalSubEvents('cs1', [{ uid: 'u1', title: '外部会', startDate: tk, endDate: tk, time: hhmm, allDay: false, status: 'confirmed', remindAhead: null }]);
    checkExtReminders();
    return { chime: globalThis.__chime, ledger: JSON.parse(localStorage.getItem('calRemindLedger') || '{}') };
  })()`;
  const r1 = hostify(appEval(sb, seedAndCheck));
  assert.strictEqual(r1.chime, 1);
  assert.strictEqual(Object.keys(r1.ledger).length, 1);
  const r2 = hostify(appEval(sb, seedAndCheck));
  assert.strictEqual(r2.chime, 1, '同版本第二次检查不重复提醒');
  assert.strictEqual(Object.keys(r2.ledger).length, 1);

  // 新沙箱：静音事件不触发
  const { sb: sb2 } = loadApp();
  appEval(sb2, `localStorage.setItem('calEventCfg', JSON.stringify({ events: { 'cs1#u1': { muted: true } } }))`);
  const r3 = hostify(appEval(sb2, seedAndCheck));
  assert.strictEqual(r3.chime, 0);
  assert.strictEqual(Object.keys(r3.ledger).length, 0);
});

test('详情浮层：存为本地事项（含去重）；重复单次出现剥离 recur；提醒配置持久化', () => {
  const { sb, doc } = loadApp();
  appEval(sb, `saveCalSubs([${JSON.stringify(SUB)}])`);
  const proj = Object.assign(ev(), { id: 'cs1#u1', _subId: 'cs1', _subName: '源', _extKey: 'cs1#u1', _cancelled: false, tags: [] });
  appEval(sb, `openCalEventDetail(${JSON.stringify(proj)})`);
  let mask = doc._created[doc._created.length - 1];
  mask._qs['.calev-save-task']._fire('click');
  let tasks = hostify(appEval(sb, `loadEvents()`));
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].title, '外部会');
  assert.strictEqual(tasks[0].projectId, null);
  // 再次打开点击 → 命中去重，不新增
  appEval(sb, `openCalEventDetail(${JSON.stringify(proj)})`);
  mask = doc._created[doc._created.length - 1];
  mask._qs['.calev-save-task']._fire('click');
  assert.strictEqual(appEval(sb, `loadEvents().length`), 1);

  // 重复事件的单次出现（id 含 @date）：存为当天单条，无 recur
  const { sb: sb2, doc: doc2 } = loadApp();
  appEval(sb2, `saveCalSubs([${JSON.stringify(SUB)}])`);
  const occ = Object.assign(ev({ recur: { freq: 'daily', interval: 1 } }),
    { id: 'cs1#u1@2026-10-10', _subId: 'cs1', _subName: '源', _extKey: 'cs1#u1', _cancelled: false, tags: [] });
  appEval(sb2, `openCalEventDetail(${JSON.stringify(occ)})`);
  const mask2 = doc2._created[doc2._created.length - 1];
  mask2._qs['.calev-save-task']._fire('click');
  const saved = hostify(appEval(sb2, `loadEvents()`))[0];
  assert.strictEqual(saved.startDate, '2026-10-10');
  assert.strictEqual(saved.recur, null, '重复事件的单次出现只存当天一条');

  // 提醒配置：勾选静音 + 选提前 30 分（模拟两次操作）
  const mutedCb = mask2._qs['.calev-muted'];
  mutedCb.checked = true;
  mutedCb._fire('change');
  let cfg = JSON.parse(appEval(sb2, `localStorage.getItem('calEventCfg')`));
  assert.strictEqual(cfg.events['cs1#u1'].muted, true);
  const aheadSel = mask2._qs['.calev-ahead'];
  aheadSel.value = '30';
  mutedCb.checked = false;
  aheadSel._fire('change');
  cfg = JSON.parse(appEval(sb2, `localStorage.getItem('calEventCfg')`));
  assert.strictEqual(cfg.events['cs1#u1'].muted, false);
  assert.strictEqual(cfg.events['cs1#u1'].aheadMin, 30);
});
