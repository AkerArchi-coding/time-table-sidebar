// ============ 核心层：只读分析与统计（M0 解耦） ============
// 纯函数（buildStats 会读 storage 的项目列表，但不写库、不渲染）；无 DOM / 无 Electron 依赖，两端共用。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const { dateKey, stripTime, addDays, isoDateKey, startOfWeek, dateKeyRange, parseDateKey, eventStart, eventEnd } = TTCore.dates;
  const { CATEGORIES, RECUR_FREQS } = TTCore.constants;

  // 是否重复事项（recur.freq 为已知枚举）
  function isRecurOn(ev) {
    return !!(ev && ev.recur && RECUR_FREQS.includes(ev.recur.freq));
  }

  // 区间统计：每日新增/完成/专注 + 汇总 + 分类分布 + 项目排行
  // 口径：新增按 createdAt 日期；完成按 updatedAt 日期（仅 done 项）；未来日期不计入
  function buildStats(events, history, rangeDays, now) {
    now = now || new Date();
    const days = Math.max(1, rangeDays | 0);
    const keys = dateKeyRange(dateKey(addDays(stripTime(now), -(days - 1))), days);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const daily = keys.map(k => ({ date: k, created: 0, done: 0, focusCount: 0, focusMinutes: 0 }));
    const focusMap = new Map((history || []).map(h => [h.date, h]));

    let createdTotal = 0, doneTotal = 0;
    const catCount = {};
    const projDone = new Map();
    for (const ev of events || []) {
      const ci = idx.get(isoDateKey(ev.createdAt));
      if (ci !== undefined) { daily[ci].created++; createdTotal++; }
      if (ev.done) {
        const di = idx.get(isoDateKey(ev.updatedAt || ev.createdAt));
        if (di !== undefined) {
          daily[di].done++; doneTotal++;
          catCount[ev.category] = (catCount[ev.category] || 0) + 1;
          if (ev.projectId) projDone.set(ev.projectId, (projDone.get(ev.projectId) || 0) + 1);
        }
      }
    }
    let focusCount = 0, focusMinutes = 0;
    for (const d of daily) {
      const h = focusMap.get(d.date);
      if (h) { d.focusCount = h.count || 0; d.focusMinutes = h.minutes || 0; }
      focusCount += d.focusCount; focusMinutes += d.focusMinutes;
    }
    const categories = Object.keys(CATEGORIES).map(k => ({
      key: k, label: CATEGORIES[k].label, color: CATEGORIES[k].color, count: catCount[k] || 0
    }));
    // 项目排行：只列有事项的项目，按区间完成数降序（平局按项目名），最多 5 个
    const projects = TTCore.storage.loadProjects().map(p => {
      const total = (events || []).filter(e => e.projectId === p.id).length;
      return { id: p.id, name: p.name, done: projDone.get(p.id) || 0, total };
    }).filter(p => p.total > 0).sort((a, b) => (b.done - a.done) || a.name.localeCompare(b.name)).slice(0, 5);

    // 连续专注 streak（P5.1）：从今天往前数连续有专注的天数；
    // 今天尚无记录则从昨天起算（避免"当天还没专注"清零连续记录）
    const focusMinMap = new Map((history || []).map(h => [h.date, h.minutes || 0]));
    let streak = 0;
    {
      let cursor = stripTime(now);
      if ((focusMinMap.get(dateKey(cursor)) || 0) <= 0) cursor = addDays(cursor, -1);
      while ((focusMinMap.get(dateKey(cursor)) || 0) > 0) { streak++; cursor = addDays(cursor, -1); }
    }

    // 上一周期对照（P5.1）：区间整体前移同长度，口径与主区间一致
    const pKeys = dateKeyRange(dateKey(addDays(stripTime(now), -(days * 2 - 1))), days);
    const pIdx = new Map(pKeys.map((k, i) => [k, i]));
    let prevCreated = 0, prevDone = 0, prevFocusMinutes = 0;
    for (const ev of events || []) {
      if (pIdx.has(isoDateKey(ev.createdAt))) prevCreated++;
      if (ev.done && pIdx.has(isoDateKey(ev.updatedAt || ev.createdAt))) prevDone++;
    }
    for (const h of history || []) {
      if (pIdx.has(h.date)) prevFocusMinutes += h.minutes || 0;
    }

    // 未完成积压（P5.1）：一次性事项按截止日分档；重复事项执行区间语义复杂，不计入
    const tkNow = dateKey(now);
    const backlog = { overdue: 0, today: 0, future: 0, undated: 0, urgent: 0 };
    for (const ev of events || []) {
      if (ev.done || isRecurOn(ev)) continue;
      const s = eventStart(ev), e = eventEnd(ev) || s;
      if (ev.urgency === 'urgent') backlog.urgent++;
      if (!s) { backlog.undated++; continue; }
      if (e < tkNow) backlog.overdue++;
      else if (s <= tkNow) backlog.today++;
      else backlog.future++;
    }

    return {
      startKey: keys[0], endKey: keys[keys.length - 1], daily,
      totals: {
        createdTotal, doneTotal,
        rate: createdTotal ? Math.round(doneTotal / createdTotal * 100) : 0,
        focusCount, focusMinutes
      },
      categories, projects,
      streak,
      prev: { createdTotal: prevCreated, doneTotal: prevDone, focusMinutes: prevFocusMinutes },
      backlog
    };
  }

  // 本周 vs 上周对照（P5.1 纯函数）：完成/新增/专注分钟 三指标，固定按自然周（周一~周日）
  function weekCompare(events, history, now) {
    now = now || new Date();
    const wk = new Set(dateKeyRange(dateKey(startOfWeek(now)), 7));
    const pw = new Set(dateKeyRange(dateKey(addDays(startOfWeek(now), -7)), 7));
    let done = 0, created = 0, pDone = 0, pCreated = 0;
    for (const ev of events || []) {
      const ck = isoDateKey(ev.createdAt), dk = isoDateKey(ev.updatedAt || ev.createdAt);
      if (wk.has(ck)) created++;
      if (pw.has(ck)) pCreated++;
      if (ev.done) {
        if (wk.has(dk)) done++;
        if (pw.has(dk)) pDone++;
      }
    }
    let fm = 0, pfm = 0;
    for (const h of history || []) {
      if (wk.has(h.date)) fm += h.minutes || 0;
      if (pw.has(h.date)) pfm += h.minutes || 0;
    }
    return { done, created, focusMinutes: fm, prev: { done: pDone, created: pCreated, focusMinutes: pfm } };
  }

  // 年热力图（P7.5 纯函数）：GitHub 风格周对齐网格，53 列（周）× 7 行（周一~周日）
  // daily: buildStats().daily（连续日期升序，缺失日安全为 0）；metric: 'done' | 'focusMinutes'
  // 网格终点固定为 endKey 所在周的周日，向前铺满 371 格 → 覆盖 ≥365 天，首列可能前导空档（值 0）
  // 返回 { cells: [{date, value, level, col, row}], cols, rows, max }；level 0~4 五档色阶
  function buildHeatmap(daily, metric, endKey) {
    const map = new Map((daily || []).map(d => [d.date, d]));
    const end = parseDateKey(endKey) || new Date();
    const endSunday = addDays(end, 6 - ((end.getDay() + 6) % 7));   // 所在周的周日（周一为一周之首）
    const cells = [];
    let max = 0;
    for (let i = 0; i < 371; i++) {
      const k = dateKey(addDays(endSunday, i - 370));
      const rec = map.get(k);
      const v = rec ? Math.max(0, Number(rec[metric]) || 0) : 0;
      if (v > max) max = v;
      cells.push({ date: k, value: v, col: Math.floor(i / 7), row: i % 7 });
    }
    // 分档：0 → 0 档；峰值 ≤4 时按值直接映射（低活跃也有梯度），否则按峰值比例分 4 段
    for (const c of cells) {
      if (!c.value) { c.level = 0; continue; }
      if (max <= 4) { c.level = c.value; continue; }
      const t = c.value / max;
      c.level = t > 0.75 ? 4 : t > 0.5 ? 3 : t > 0.25 ? 2 : 1;
    }
    return { cells, cols: 53, rows: 7, max };
  }
  // 每日工作记录（P8.2 纯函数）：指定日期的完成事项清单 + 专注汇总
  // 完成口径：ev.done 且 isoDateKey(updatedAt || createdAt) === dateKeyStr
  // 专注口径：history 中 date === dateKeyStr 的记录
  // doneItems 按 time 升序，无时间排最后
  function buildDailyWorkRecord(events, history, dateKeyStr, projects) {
    const dk = String(dateKeyStr || '');
    const projMap = new Map((projects || []).map(p => [p.id, p.name]));
    const doneItems = (events || [])
      .filter(ev => ev.done && isoDateKey(ev.updatedAt || ev.createdAt) === dk)
      .map(ev => ({
        id: ev.id,
        title: ev.title || '',
        time: ev.time || '',
        projectName: ev.projectId ? (projMap.get(ev.projectId) || '未分类') : '未归类',
        projectId: ev.projectId || ''
      }))
      .sort((a, b) => {
        if (!!a.time !== !!b.time) return a.time ? -1 : 1;
        return (a.time || '').localeCompare(b.time || '');
      });
    const h = (history || []).find(x => x.date === dk) || {};
    return {
      date: dk,
      doneCount: doneItems.length,
      focusCount: h.count || 0,
      focusMinutes: h.minutes || 0,
      doneItems
    };
  }
  // 周报 Markdown：本周（周一~周日）完成事项按项目分组 + 专注汇总 + 每日完成条形
  function buildWeeklyReport(events, projects, history, now) {
    now = now || new Date();
    const ws = startOfWeek(now), we = addDays(ws, 6);
    const wsK = dateKey(ws), weK = dateKey(we);
    const keys = dateKeyRange(wsK, 7);
    const inWeek = (k) => keys.includes(k);

    let focusCount = 0, focusMinutes = 0;
    for (const h of history || []) {
      if (inWeek(h.date)) { focusCount += h.count || 0; focusMinutes += h.minutes || 0; }
    }
    const doneEvents = (events || []).filter(e => e.done && inWeek(isoDateKey(e.updatedAt || e.createdAt)));
    const dayCount = keys.map(k => doneEvents.filter(e => isoDateKey(e.updatedAt || e.createdAt) === k).length);
    const maxCount = Math.max(1, ...dayCount);
    const WD = ['一', '二', '三', '四', '五', '六', '日'];
    const barOf = (n) => '█'.repeat(Math.round(n / maxCount * 8)) + '░'.repeat(8 - Math.round(n / maxCount * 8));

    const lines = [];
    lines.push(`# 周报（${wsK} ~ ${weK}）`, '');
    lines.push('## 专注概览', '');
    lines.push(`- 完成专注：${focusCount} 个，共 ${focusMinutes} 分钟（约 ${(focusMinutes / 60).toFixed(1)} 小时）`);
    lines.push(`- 完成事项：${doneEvents.length} 项`, '');
    lines.push('## 每日完成', '');
    keys.forEach((k, i) => {
      const md = k.slice(5).replace('-', '/');
      lines.push(`- ${md} 周${WD[i]}  ${dayCount[i]} ${barOf(dayCount[i])}`);
    });
    lines.push('', '## 完成事项', '');
    if (!doneEvents.length) {
      lines.push('本周暂无完成事项。', '');
    } else {
      // 按项目分组：项目按 projects 现有顺序，未归类放最后
      const groups = [];
      const pushGroup = (name, list) => { if (list.length) groups.push({ name, list }); };
      for (const p of projects) {
        pushGroup(p.name, doneEvents.filter(e => e.projectId === p.id));
      }
      pushGroup('未归类', doneEvents.filter(e => !e.projectId));
      for (const g of groups) {
        lines.push(`### ${g.name}（${g.list.length}）`, '');
        for (const ev of g.list) lines.push(`- [x] ${ev.time ? ev.time + ' ' : ''}${ev.title}`);
        lines.push('');
      }
    }
    lines.push('> 由日程侧边栏自动生成');
    return lines.join('\n');
  }

  // 纯函数（P9.1）：事项按阶段分组。阶段按 order 排列，空阶段保留成组；未分阶段事项归末尾 null 组（有事项才成组）
  function groupTasksByPhase(project, tasks) {
    const phases = (project && Array.isArray(project.phases)) ? project.phases.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
    const groups = phases.map(phase => ({ phase, tasks: [] }));
    const idx = new Map(phases.map((ph, i) => [ph.id, i]));
    const loose = [];
    for (const t of tasks || []) {
      const gi = t.phaseId ? idx.get(t.phaseId) : undefined;
      if (gi === undefined) loose.push(t);
      else groups[gi].tasks.push(t);
    }
    if (loose.length) groups.push({ phase: null, tasks: loose });
    return groups;
  }
  // 纯函数（P9.1）：阶段进度 = 完成事项数 / 阶段内事项总数；空阶段返回 0，杜绝除零
  function phaseProgress(tasks) {
    const total = (tasks || []).length;
    const done = (tasks || []).filter(t => t.done).length;
    return { done, total, pct: total ? Math.round(done / total * 100) : 0 };
  }
  // 纯函数（P9.1）：超范围事项检测。仅当阶段与事项都有日期时判定：
  // 事项结束日 < 阶段开始日 → before；事项开始日 > 阶段结束日 → after
  function phaseRangeViolations(phases, tasks) {
    const pmap = new Map((phases || []).map(ph => [ph.id, ph]));
    const out = [];
    for (const t of tasks || []) {
      const ph = t.phaseId ? pmap.get(t.phaseId) : null;
      if (!ph || !ph.startDate || !ph.endDate) continue;
      const s = eventStart(t), e = eventEnd(t) || s;
      if (!s) continue;
      if (e < ph.startDate) out.push({ taskId: t.id, phaseId: ph.id, dir: 'before' });
      else if (s > ph.endDate) out.push({ taskId: t.id, phaseId: ph.id, dir: 'after' });
    }
    return out;
  }
  // 纯函数：获取项目阶段名称映射（{phaseId: name}），便于事项显示阶段标签
  function phaseNameMap(projectId) {
    const p = TTCore.storage.loadProjects().find(x => x.id === projectId) || null;
    const m = {};
    if (p && Array.isArray(p.phases)) {
      for (const ph of p.phases) m[ph.id] = ph.name;
    }
    return m;
  }

  TTCore.analytics = {
    isRecurOn, buildStats, weekCompare, buildHeatmap, buildDailyWorkRecord, buildWeeklyReport,
    groupTasksByPhase, phaseProgress, phaseRangeViolations, phaseNameMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
