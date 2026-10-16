// ============ 核心层：iCal 互通（导出 .ics / 导入 .ics） ============
// 纯函数，无 DOM / 无 Electron 依赖，两端共用。
// 约定：本机浮点时间，不写 TZID/VTIMEZONE（与 app 内"时间即本地墙钟"语义一致，不做时区换算）；
// 输出按 RFC 5545 用 CRLF 换行；导出不折叠长行（多数日历软件可读），导入支持行折叠展开。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const { pad2, parseDateKey, addDaysKey, eventStart, eventEnd } = TTCore.dates;
  const CATEGORIES = TTCore.constants.CATEGORIES;

  const ICAL_BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];  // getDay() → RFC 5545 星期码

  // ics 文本转义（SUMMARY/DESCRIPTION/CATEGORIES 值；反斜杠最先处理防二次转义）
  function icsEscape(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }
  // ics 文本反转义：单趟替换，避免「\\n（字面反斜杠+n）」被误展开为换行
  function icsUnescape(s) {
    return String(s || '').replace(/\\n|\\,|\\;|\\\\/g, (m) => {
      if (m === '\\n') return '\n';
      if (m === '\\,') return ',';
      if (m === '\\;') return ';';
      return '\\';
    });
  }
  // 'YYYY-MM-DD' → 'YYYYMMDD'
  function icsDate(key) { return String(key || '').replace(/-/g, ''); }
  // 'HH:MM' → 'HHMMSS'（异常格式兜底 000000）
  function icsTime(time) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
    if (!m) return '000000';
    return pad2(+m[1]) + m[2] + '00';
  }
  // 重复规则 → RRULE 值（不重复/未知返回 ''；weekly 的 BYDAY 取开始日星期码）
  function recurToRrule(recur, startKey) {
    if (!recur || !recur.freq || recur.freq === 'none') return '';
    const n = Math.max(1, parseInt(recur.interval, 10) || 1);
    let rule = '';
    if (recur.freq === 'daily') rule = 'FREQ=DAILY;INTERVAL=' + n;
    else if (recur.freq === 'weekdays') rule = 'FREQ=WEEKLY;INTERVAL=' + n + ';BYDAY=MO,TU,WE,TH,FR';
    else if (recur.freq === 'weekly') {
      const d = parseDateKey(startKey) || new Date();
      rule = 'FREQ=WEEKLY;INTERVAL=' + n + ';BYDAY=' + ICAL_BYDAY[d.getDay()];
    } else if (recur.freq === 'monthly') rule = 'FREQ=MONTHLY;INTERVAL=' + n;
    else return '';
    if (recur.until) rule += ';UNTIL=' + icsDate(recur.until) + 'T235959';
    return rule;
  }
  // RRULE 值 → 重复规则（无法映射返回 null；调用方需落"不重复 + 备注说明"）
  function rruleToRecur(rule, startKey) {
    if (!rule) return null;
    const parts = {};
    for (const seg of String(rule).split(';')) {
      const i = seg.indexOf('=');
      if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
    }
    const freq = (parts.FREQ || '').toUpperCase();
    const n = Math.max(1, parseInt(parts.INTERVAL, 10) || 1);
    let freqKey = null;
    if (freq === 'DAILY') freqKey = 'daily';
    else if (freq === 'WEEKLY') {
      const days = (parts.BYDAY || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
      if (days.join(',') === 'MO,TU,WE,TH,FR') freqKey = 'weekdays';
      else if (days.length === 1) freqKey = 'weekly';
      // 其它 BYDAY 组合（如 MO,WE,FR）无法映射 → 落不重复
    } else if (freq === 'MONTHLY') freqKey = 'monthly';
    if (!freqKey) return null;
    const recur = { freq: freqKey, interval: n, until: '' };
    if (parts.UNTIL && /^\d{8}/.test(parts.UNTIL)) {
      recur.until = parts.UNTIL.slice(0, 4) + '-' + parts.UNTIL.slice(4, 6) + '-' + parts.UNTIL.slice(6, 8);
    }
    return recur;   // weekly 的 BYDAY 由开始日星期码决定，导入时以 startKey 为准（与导出一致）
  }

  // 事项列表 → iCalendar 文本（每事项一个 VEVENT；now 参数仅供测试注入 DTSTAMP）
  function eventsToIcs(list, now) {
    const stamp = now || new Date();
    const dtStamp = stamp.getUTCFullYear() + pad2(stamp.getUTCMonth() + 1) + pad2(stamp.getUTCDate()) +
      'T' + pad2(stamp.getUTCHours()) + pad2(stamp.getUTCMinutes()) + pad2(stamp.getUTCSeconds()) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Timetable001//日程侧边栏//CN'];
    for (const ev of (list || [])) {
      const sKey = eventStart(ev);
      if (!sKey) continue;                        // 无开始日期的异常数据跳过
      const eKey = eventEnd(ev) || sKey;
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + icsEscape(ev.id || String(stamp.getTime())) + '@timetable.local');
      lines.push('DTSTAMP:' + dtStamp);
      if (!ev.time) {
        // 全天：DTSTART 含首日，DTEND 为结束日 +1（RFC 5545 全天区间非包含）
        lines.push('DTSTART;VALUE=DATE:' + icsDate(sKey));
        lines.push('DTEND;VALUE=DATE:' + icsDate(addDaysKey(eKey, 1)));
      } else {
        // 有时间：DTEND 与结束时刻相同（app 内结束时刻为包含语义，导出按同时刻落盘）
        const t = icsTime(ev.time);
        lines.push('DTSTART:' + icsDate(sKey) + 'T' + t);
        lines.push('DTEND:' + icsDate(eKey) + 'T' + t);
      }
      lines.push('SUMMARY:' + icsEscape(ev.title || '（无标题）'));
      // 分类与标签：中文分类标签放首位，tags 并入 CATEGORIES（导入时反向解析，备注不重复携带 tags）
      const cat = CATEGORIES[ev.category];
      const cats = [cat ? cat.label : ''].concat(Array.isArray(ev.tags) ? ev.tags : []).filter(Boolean);
      if (cats.length) lines.push('CATEGORIES:' + icsEscape(cats.join(',')));
      if (ev.description) lines.push('DESCRIPTION:' + icsEscape(ev.description));
      if (ev.done) lines.push('STATUS:COMPLETED');
      const rrule = recurToRrule(ev.recur, sKey);
      if (rrule) lines.push('RRULE:' + rrule);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  // 解析 ics 日期值 → { date: 'YYYY-MM-DD', time: 'HH:MM' | '', allDay, tzid }
  // VALUE=DATE 或纯 8 位日期为全天；Z 结尾 UTC 时间转换为本地墙钟（应用"时间即本地墙钟"约定）；
  // 浮动时间与 TZID 时间按本地处理，TZID 仅原样记录（无 tzdata，不做时区换算）
  function parseIcsDateVal(val, params) {
    const v = String(val || '').trim();
    const tzidM = /TZID=([^;:]+)/i.exec(params || '');
    const tzid = tzidM ? tzidM[1].replace(/^"|"$/g, '') : '';
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '', allDay: true, tzid: '' };
    if (/VALUE=DATE/i.test(params || '') && /^\d{8}/.test(v)) {
      return { date: v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8), time: '', allDay: true, tzid: '' };
    }
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
    if (m) {
      if (m[7]) {
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
        return {
          date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
          time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()), allDay: false, tzid: 'UTC'
        };
      }
      return { date: `${m[1]}-${m[2]}-${m[3]}`, time: pad2(+m[4]) + ':' + pad2(+m[5]), allDay: false, tzid };
    }
    return null;
  }

  // ICS UTC 时间戳（CREATED/LAST-MODIFIED/DTSTAMP）→ ISO 字符串；无法解析返回 ''
  function icsStampToIso(val) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/.exec(String(val || '').trim());
    if (!m) return '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString();
  }

  // VALARM TRIGGER 负向 DURATION → 提前分钟数（-PT15M→15，-PT1H30M→90，-P1D→1440，-PT0D→0）；
  // 绝对触发时间（VALUE=DATE-TIME）与正向/无法识别的格式返回 null
  function parseIcsTriggerMinutes(val) {
    const s = String(val || '').trim().toUpperCase();
    if (!s.startsWith('-')) return null;
    const body = s.slice(1);
    if (body === 'PT0D' || body === 'P0D') return 0;   // 宽容：部分源把零时长写成 -PT0D
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(body);
    if (!m) return null;
    const weeks = +(m[1] || 0), days = +(m[2] || 0), hours = +(m[3] || 0), mins = +(m[4] || 0);
    if (!weeks && !days && !hours && !mins) return 0;   // -PT0D / -P0D
    return weeks * 7 * 24 * 60 + days * 24 * 60 + hours * 60 + mins;
  }

  // 外部事件稳定身份兜底：UID 缺失时用内容字段哈希（djb2，base36）
  function icsFallbackUid(ev) {
    const basis = [ev.title, ev.startDate, ev.endDate, ev.time, ev.allDay ? 'd' : 't'].join('|');
    let h = 5381;
    for (let i = 0; i < basis.length; i++) { h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0; }
    return 'h:' + h.toString(36);
  }

  // 外部事件内容版本哈希：sequence/updatedAt 之外的字段级变更兜底判定（FNV-1a，base36）
  function icsContentHash(ev) {
    const basis = [ev.title, ev.startDate, ev.endDate, ev.time, ev.allDay ? 1 : 0, ev.location || '',
      ev.description || '', ev.status || '', ev.remindAhead === null ? '' : ev.remindAhead,
      ev.recur ? JSON.stringify(ev.recur) : ''].join('');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < basis.length; i++) { h ^= basis.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // 解析出的 VEVENT 块 → 外部事件字段（缺 DTSTART 的块返回 null 丢弃）
  // 注意：文件导入为 Task 的出口只挑 Task 字段，下列外部字段（uid/status/…）不会写入业务库
  function normalizeIcsEvent(raw) {
    const ds = raw._dtStart;
    if (!ds) return null;
    const de = raw._dtEnd;
    let sKey = ds.date;
    let eKey = (de && de.date) || ds.date;
    if (ds.allDay && de && de.allDay && de.date > ds.date) {
      eKey = addDaysKey(de.date, -1);             // 全天 DTEND 非包含 → 反推回包含式末日
    } else if (!ds.allDay) {
      eKey = (de && de.date) || ds.date;          // 有时间：DTEND 同结束时刻（跨天取结束日）
    }
    // 分类：CATEGORIES 中首个匹配中文标签的项 → category，其余项进 tags
    let category = '';
    const tags = [];
    for (const t of raw.tags || []) {
      const hit = Object.keys(CATEGORIES).find(k => CATEGORIES[k].label === t);
      if (hit && !category) category = hit;
      else if (!tags.includes(t)) tags.push(t);
    }
    let description = raw.description || '';
    let recur = rruleToRecur(raw._rrule, sKey);
    if (raw._rrule && !recur) {
      // 不支持的重复规则：落不重复，规则原文追加进备注说明
      recur = null;
      description += (description ? '\n' : '') + `（原重复规则未支持导入：${raw._rrule}）`;
    }
    const ev = {
      uid: String(raw.uid || '').trim(),
      title: raw.title || '（无标题）',
      description,
      location: raw.location || '',
      startDate: sKey,
      endDate: eKey || sKey,
      time: ds.allDay ? '' : (ds.time || ''),
      allDay: !!ds.allDay,
      tzid: ds.tzid || '',
      status: String(raw.status || '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'confirmed',
      sequence: Number.isFinite(raw.sequence) ? raw.sequence : 0,
      createdAt: raw.createdAt || '',
      updatedAt: raw.updatedAt || '',
      category: category || 'work',
      tags,
      done: !!raw.done,
      recur,
      remindAhead: (raw.remindAhead === undefined || raw.remindAhead === null) ? null : raw.remindAhead
    };
    if (!ev.uid) ev.uid = icsFallbackUid(ev);
    return ev;
  }

  // .ics 文本 → 事项字段列表（CRLF/LF 归一 + RFC 5545 行折叠展开 + VEVENT 块扫描）
  function parseIcs(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const folded = [];
    for (const line of raw.split('\n')) {
      if ((line.startsWith(' ') || line.startsWith('\t')) && folded.length) {
        folded[folded.length - 1] += line.slice(1);   // 续行：去掉首个空白拼接
      } else {
        folded.push(line);
      }
    }
    const blocks = [];
    let cur = null;
    let inAlarm = false;
    for (const line of folded) {
      if (line === 'BEGIN:VEVENT') { cur = { tags: [] }; inAlarm = false; continue; }
      if (line === 'BEGIN:VALARM') { inAlarm = true; continue; }
      if (line === 'END:VALARM') { inAlarm = false; continue; }
      if (line === 'END:VEVENT') {
        if (cur) blocks.push(cur);
        cur = null;
        inAlarm = false;
        continue;
      }
      if (!cur || !line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const val = line.slice(colon + 1);
      const semi = head.indexOf(';');
      const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
      const params = semi < 0 ? '' : head.slice(semi + 1);
      // VALARM 内只取 TRIGGER（其他行不覆盖事件本体）；只支持事件开始前的负向 DURATION
      if (inAlarm) {
        if (name === 'TRIGGER' && cur.remindAhead === undefined) {
          const mins = parseIcsTriggerMinutes(val);
          if (mins !== null) cur.remindAhead = mins;
        }
        continue;
      }
      if (name === 'SUMMARY') cur.title = icsUnescape(val).trim();
      else if (name === 'DESCRIPTION') cur.description = icsUnescape(val).trim();
      else if (name === 'LOCATION') cur.location = icsUnescape(val).trim();
      else if (name === 'UID') cur.uid = icsUnescape(val).trim();
      else if (name === 'SEQUENCE') { const n = parseInt(val.trim(), 10); if (Number.isFinite(n)) cur.sequence = n; }
      else if (name === 'CREATED') cur.createdAt = icsStampToIso(val);
      else if (name === 'LAST-MODIFIED') cur.updatedAt = icsStampToIso(val);
      else if (name === 'DTSTAMP') cur.dtstamp = icsStampToIso(val);
      else if (name === 'STATUS') {
        const st = val.trim().toUpperCase();
        cur.status = st;
        if (st === 'COMPLETED') cur.done = true;
      }
      else if (name === 'CATEGORIES') {
        for (const c of icsUnescape(val).split(',')) {
          const t = c.trim();
          if (t) cur.tags.push(t);
        }
      } else if (name === 'DTSTART') cur._dtStart = parseIcsDateVal(val, params);
      else if (name === 'DTEND') cur._dtEnd = parseIcsDateVal(val, params);
      else if (name === 'RRULE') cur._rrule = val.trim();
    }
    return blocks.map(b => {
      if (!b.updatedAt && b.dtstamp) b.updatedAt = b.dtstamp;
      if (!b.createdAt && b.dtstamp) b.createdAt = b.dtstamp;
      return normalizeIcsEvent(b);
    }).filter(Boolean);
  }

  TTCore.ical = {
    ICAL_BYDAY,
    icsEscape, icsUnescape, icsDate, icsTime,
    recurToRrule, rruleToRecur,
    eventsToIcs,
    parseIcsDateVal, icsStampToIso, parseIcsTriggerMinutes,
    icsFallbackUid, icsContentHash, normalizeIcsEvent,
    parseIcs
  };
})(typeof window !== 'undefined' ? window : globalThis);
