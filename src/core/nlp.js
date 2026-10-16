// ============ 核心层：自然语言快速添加解析（M0 解耦） ============
// 纯函数：从标题剥离日期/时间短语；无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const { pad2, dateKey, stripTime, addDays, today, parseDateKey } = TTCore.dates;

  // 从标题剥离日期/时间短语 → { title, date, time, hits }
  // date: 'YYYY-MM-DD'，time: 'HH:MM'，未命中为 ''；hits 为命中的原始片段
  // 规则：先绝对后相对、先长词后短词；剥离后标题为空则整体不解析（避免"周五"这类词被误清空）
  const CN_DIG = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const CN_WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  // 中文/阿拉伯数字串 → 整数（0~99，支持"二十三"）；无法解析返回 NaN
  function parseCnNum(s) {
    if (/^\d{1,2}$/.test(s)) return parseInt(s, 10);
    if (!s) return NaN;
    const ten = s.indexOf('十');
    if (ten === -1) return CN_DIG[s] !== undefined ? CN_DIG[s] : NaN;
    const b = s.slice(0, ten), a = s.slice(ten + 1);
    const tens = b ? CN_DIG[b] : 1, ones = a ? CN_DIG[a] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }
  // 时段前缀映射小时数：中午12点→12、下午X点(+12)、晚上X点(≤11+12，12→0)、上午/早上/凌晨原值
  function mapDaypart(part, h) {
    if (!part) return h;
    if (part === '中午') return 12;
    if (part === '下午') return h === 12 ? 12 : (h >= 1 && h <= 11 ? h + 12 : h);
    if (part === '晚上') return h === 12 ? 0 : (h <= 11 ? h + 12 : h);
    return h;
  }
  function parseQuickInput(text, now) {
    now = now || today();
    const original = String(text || '').trim();
    let work = original;
    let dateK = '', timeS = '';
    const hits = [];
    // 命中片段从工作串剥离（以空格占位，最终压缩空白）
    const take = (m) => {
      hits.push(m[0]);
      work = work.slice(0, m.index) + ' ' + work.slice(m.index + m[0].length);
    };
    const t0 = stripTime(now);
    const setDate = (d) => { if (!dateK) dateK = dateKey(d); };
    // 相对时长（分钟）→ date（未设时取计算日）+ time
    const applyRelTime = (mins) => {
      const d = new Date(now.getTime() + mins * 60000);
      if (!dateK) dateK = dateKey(d);
      timeS = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    };

    // —— 日期词表（先绝对后相对）——
    // YYYY-MM-DD
    let m = work.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) { setDate(new Date(+m[1], +m[2] - 1, +m[3])); take(m); }
    // X月X号/日（年份取未来最近：已过 → 明年）
    if (!dateK && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[号日]/))) {
      const mo = parseCnNum(m[1]), da = parseCnNum(m[2]);
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        let cand = new Date(t0.getFullYear(), mo - 1, da);
        if (cand < t0) cand = new Date(t0.getFullYear() + 1, mo - 1, da);
        if (cand.getDate() === da) { setDate(cand); take(m); }
      }
    }
    // MM-DD（未来最近：已过 → 明年）
    if (!dateK && (m = work.match(/(?<!\d)(\d{1,2})-(\d{1,2})(?!\d)/))) {
      const mo = +m[1], da = +m[2];
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        let cand = new Date(t0.getFullYear(), mo - 1, da);
        if (cand < t0) cand = new Date(t0.getFullYear() + 1, mo - 1, da);
        if (cand.getDate() === da) { setDate(cand); take(m); }
      }
    }
    // X号/X日（本月；已过 → 下月）
    if (!dateK && (m = work.match(/(?<![\d月])(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[号日](?!内)/))) {
      const da = parseCnNum(m[1]);
      if (da >= 1 && da <= 31) {
        let cand = new Date(t0.getFullYear(), t0.getMonth(), da);
        if (cand < t0) cand = new Date(t0.getFullYear(), t0.getMonth() + 1, da);
        if (cand.getDate() === da) { setDate(cand); take(m); }
      }
    }
    // 大后天/后天/明天/今晚/今天（今晚额外默认 19:00，纯"今晚"才有别于"今天"）
    if (!dateK && (m = work.match(/大后天|后天|明天|今晚|今天/))) {
      setDate(addDays(t0, { 大后天: 3, 后天: 2, 明天: 1, 今晚: 0, 今天: 0 }[m[0]]));
      if (m[0] === '今晚' && !timeS) timeS = '19:00';
      take(m);
    }
    // N天后（阿拉伯或中文数字 1~99）
    if (!dateK && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天\s*之?后/))) {
      const n = parseCnNum(m[1]);
      if (n >= 1 && n <= 99) { setDate(addDays(t0, n)); take(m); }
    }
    // 下周X（强制下一自然周，周一起算）
    if (!dateK && (m = work.match(/下(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
      const tgt = CN_WEEK[m[1]];
      if (tgt !== undefined) {
        const wd = (t0.getDay() + 6) % 7;              // 周一=0 … 周日=6
        setDate(addDays(t0, (7 - wd) + ((tgt + 6) % 7)));
        take(m);
      }
    }
    // 周X/星期X（未来最近该日，含今天）
    if (!dateK && (m = work.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
      const tgt = CN_WEEK[m[1]];
      if (tgt !== undefined) {
        setDate(addDays(t0, (tgt - t0.getDay() + 7) % 7));
        take(m);
      }
    }

    // —— 时间词表（先绝对后相对、先带时段后裸写）——
    // 时段 + HH:MM（下午3:30 → 15:30）
    m = work.match(/(上午|早上|凌晨|中午|下午|晚上)?\s*(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
    if (m) {
      const h = mapDaypart(m[1], +m[2]);
      if (h >= 0 && h <= 23) { timeS = pad2(h) + ':' + m[3]; take(m); }
    }
    // 时段 + X点[半/Y分/整]
    if (!timeS && (m = work.match(/(上午|早上|凌晨|中午|下午|晚上)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点(?:\s*(半|整|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分))?/))) {
      const h = mapDaypart(m[1], parseCnNum(m[2]));
      const min = m[3] === '半' ? 30 : (m[4] !== undefined ? parseCnNum(m[4]) : 0);
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) { timeS = pad2(h) + ':' + pad2(min); take(m); }
    }
    // 裸 HH:MM
    if (!timeS && (m = work.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/))) {
      timeS = pad2(+m[1]) + ':' + m[2]; take(m);
    }
    // 裸 X点[半/Y分/整]（前一位不能是数字/点，避免命中已剥离内容的残段）
    if (!timeS && (m = work.match(/(?<![\d点])(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*点(?:\s*(半|整|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分))?/))) {
      const h = parseCnNum(m[1]);
      const min = m[2] === '半' ? 30 : (m[3] !== undefined ? parseCnNum(m[3]) : 0);
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) { timeS = pad2(h) + ':' + pad2(min); take(m); }
    }
    // 半小时后 / N小时后 / N分钟后（相对 now，产生 date+time；date 已设则仅回填时间）
    if (!timeS && (m = work.match(/半\s*个?\s*小时后/))) { applyRelTime(30); take(m); }
    if (!timeS && (m = work.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*个?\s*小时后/))) {
      const n = parseCnNum(m[1]);
      if (n >= 1 && n <= 23) { applyRelTime(n * 60); take(m); }
    }
    if (!timeS && (m = work.match(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*个?\s*分钟后/))) {
      const n = parseCnNum(m[1]);
      if (n >= 1 && n <= 720) { applyRelTime(n); take(m); }
    }

    const title = work.replace(/\s+/g, ' ').trim();
    // 剥离后标题为空（或无任何命中）→ 整体不解析
    if (!title || !hits.length) return { title: original, date: '', time: '', hits: [] };
    return { title, date: dateK, time: timeS, hits };
  }
  // 解析预览文案（P5.2）：「→ 10/13(周二) 15:00」；无命中返回 ''
  function quickInputPreview(parsed) {
    if (!parsed || (!parsed.date && !parsed.time)) return '';
    const parts = [];
    if (parsed.date) {
      const d = parseDateKey(parsed.date);
      parts.push(`${d.getMonth() + 1}/${d.getDate()}(周${'日一二三四五六'[d.getDay()]})`);
    }
    if (parsed.time) parts.push(parsed.time);
    return '→ ' + parts.join(' ');
  }

  TTCore.nlp = { CN_DIG, CN_WEEK, parseCnNum, mapDaypart, parseQuickInput, quickInputPreview };
})(typeof window !== 'undefined' ? window : globalThis);
