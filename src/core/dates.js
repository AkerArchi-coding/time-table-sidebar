// ============ 核心层：日期工具 + 日期区间工具（M0 解耦） ============
// 纯函数，无 DOM / 无 Electron 依赖，两端共用。
// 语义与桌面端完全一致：'YYYY-MM-DD' 一律按本地零点解析，不引入 UTC 偏移。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function stripTime(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
  }

  function today() { return new Date(); }

  // 'YYYY-MM-DD' → 本地零点 Date（避免 new Date(str) 的 UTC 偏移）
  function parseDateKey(key) {
    if (!key) return null;
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // 日期 key 加减天数
  function addDaysKey(key, n) {
    return dateKey(addDays(parseDateKey(key), n));
  }

  // 持续天数：首尾都计入，9/15～9/15 = 1，9/15～9/20 = 6
  function durationDays(startKey, endKey) {
    if (!startKey && !endKey) return 0;
    const s = startKey || endKey, e = endKey || startKey;
    return Math.round((parseDateKey(e) - parseDateKey(s)) / 86400000) + 1;
  }

  // 事项的开始/结束日（兼容老数据）
  function eventStart(ev) { return ev.startDate || ev.date || ''; }
  function eventEnd(ev) { return ev.endDate || ev.date || ''; }

  // 事项在某一天是否处于执行区间内
  function eventSpansDate(ev, key) {
    const s = eventStart(ev);
    if (!s) return false;
    const e = eventEnd(ev) || s;
    return s <= key && key <= e;
  }

  // 'YYYY-MM-DD' → 'M/D'
  function fmtShort(key) {
    return `${+key.slice(5, 7)}/${+key.slice(8, 10)}`;
  }

  // ISO 时间 → 本地日期 key（toISOString 为 UTC，直接 slice 会有时区偏差，统一转本地）
  function isoDateKey(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : dateKey(d);
  }
  // 周一为一周起始
  function startOfWeek(d) {
    const r = stripTime(d);
    const wd = (r.getDay() + 6) % 7;   // 周一=0 … 周日=6
    return addDays(r, -wd);
  }
  // 生成连续日期 key 数组（从 startKey 起共 days 天）
  function dateKeyRange(startKey, days) {
    const start = parseDateKey(startKey);
    const out = [];
    for (let i = 0; i < days; i++) out.push(dateKey(addDays(start, i)));
    return out;
  }

  TTCore.dates = {
    pad2, dateKey, stripTime, addDays, isSameDay, today,
    parseDateKey, addDaysKey, durationDays,
    eventStart, eventEnd, eventSpansDate, fmtShort,
    isoDateKey, startOfWeek, dateKeyRange
  };
})(typeof window !== 'undefined' ? window : globalThis);
