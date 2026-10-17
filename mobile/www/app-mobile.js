// ============ 移动端：事项 + 项目管理应用（M3 项目与阶段管理） ============
// M1：只读 7 天列表 + core 复用验证。M2：勾选 / 新增 / 编辑 / 删除。
// M3：项目视图（顶部「日程|项目」分段切换）——项目卡片手风琴展开、
//     项目/阶段写操作全闭环，事项表单支持项目/阶段归属下拉。
// 全部写操作走 TTCore.opsTasks / TTCore.opsProjects；重复模板与多日任务勾选
// 走虚拟 id（evId@dateKey）写 recurDone，不写全局 done。
// 交互：点勾选框=切换完成；点标题=行内编辑；左滑条目=露出删除（二次确认）；长按兜底。
// 纯逻辑（seed/collect/buildWeekModel/buildProjectsModel）挂 TTMobile 供 node --test 在 vm 沙箱断言。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const D = () => TTCore.dates;

  const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

  // ---------- 示例数据注入（M1 沿用 + M3 示例项目） ----------
  function seedIfEmpty() {
    const events = TTCore.storage.loadEvents();
    if (events.length) return false;
    const todayKey = D().dateKey(new Date());
    const samples = [
      { title: '晨会', startDate: todayKey, time: '09:30', category: 'work', urgency: 'normal' },
      { title: '写周报', startDate: todayKey, time: '17:00', category: 'work', urgency: 'urgent' },
      { title: '买菜', startDate: todayKey, category: 'family', urgency: 'loose' },
      { title: '项目评审', startDate: D().addDaysKey(todayKey, 1), time: '14:00', category: 'work', urgency: 'urgent' },
      { title: '健身', startDate: D().addDaysKey(todayKey, 2), time: '19:00', category: 'personal', urgency: 'normal' },
      { title: '还书', startDate: D().addDaysKey(todayKey, 3), category: 'personal', urgency: 'loose' },
      { title: '多日活动示例', startDate: D().addDaysKey(todayKey, 1), endDate: D().addDaysKey(todayKey, 3), category: 'family', urgency: 'normal' },
      { title: '每日打卡（重复模板）', startDate: todayKey, time: '08:00', category: 'personal', urgency: 'normal', recur: { freq: 'daily', interval: 1, until: '' } }
    ];
    for (const s of samples) TTCore.opsTasks.createEvent(s);
    return true;
  }

  // M3：示例项目（含两个阶段，关联两条示例事项），仅在无任何项目时注入
  function seedProjectsIfEmpty() {
    if (TTCore.storage.loadProjects().length) return false;
    const todayKey = D().dateKey(new Date());
    const p = TTCore.opsProjects.createProject({
      name: '示例项目', startDate: todayKey, endDate: D().addDaysKey(todayKey, 13)
    });
    const ph1 = TTCore.opsProjects.addPhase(p.id, { name: '规划' });
    const ph2 = TTCore.opsProjects.addPhase(p.id, { name: '执行' });
    const byTitle = (t) => TTCore.storage.loadEvents().find(e => e.title === t);
    const a = byTitle('写周报');
    if (a) TTCore.opsTasks.updateEvent(a.id, { projectId: p.id, phaseId: ph1.id });
    const b = byTitle('项目评审');
    if (b) TTCore.opsTasks.updateEvent(b.id, { projectId: p.id, phaseId: ph2.id });
    return true;
  }

  // ---------- 纯逻辑：按日收集 + 一周模型（可无 DOM 测试） ----------
  function collectDayItems(events, key) {
    const C = TTCore.constants;
    const items = [];
    for (const ev of events) {
      if (!D().eventSpansDate(ev, key)) continue;
      if (ev.recur && D().eventStart(ev) !== key) continue; // 重复模板只在起始日出现（投影属后续阶段）
      const cat = C.CATEGORIES[ev.category] || C.CATEGORIES.work;
      const urg = C.URGENCIES[ev.urgency] || C.URGENCIES.normal;
      const isRecur = !!ev.recur;
      // 按日完成：重复模板 + 多日任务（跨天的每一天都独立勾选，复用 recurDone 按日记录）
      const isMulti = !isRecur && D().eventEnd(ev) > D().eventStart(ev);
      const perDay = isRecur || isMulti;
      items.push({
        id: ev.id,
        vid: perDay ? ev.id + '@' + key : ev.id,   // 勾选用虚拟 id；删除/编辑用 real id
        title: ev.title || '(无标题)', time: ev.time || '',
        done: perDay ? TTCore.storage.recurDoneGet(ev.id, key) : !!ev.done,
        recur: isRecur, multi: isMulti,
        category: ev.category || 'work', urgency: ev.urgency || 'normal',
        projectId: ev.projectId || '', phaseId: ev.phaseId || '',
        catLabel: cat.label, catColor: cat.color,
        urgLabel: urg.label, urgColor: urg.color
      });
    }
    items.sort((a, b) => (a.done - b.done) || (a.time || '99:99').localeCompare(b.time || '99:99'));
    return items;
  }

  function buildWeekModel(now) {
    const events = TTCore.storage.loadEvents();
    const todayKey = D().dateKey(now || new Date());
    const days = [];
    for (let i = 0; i < 7; i++) {
      const key = D().addDaysKey(todayKey, i);
      const d = D().parseDateKey(key);
      days.push({
        key,
        label: (i === 0 ? '今天' : '周' + WEEKDAY_CN[d.getDay()]) + ' ' + D().fmtShort(key),
        items: collectDayItems(events, key)
      });
    }
    return days;
  }

  // ---------- M3 纯逻辑：项目模型（阶段按 order、事项按完成态+时间排序） ----------
  // 项目视图内事项沿用按日完成语义：重复/多日事项以"今天"为 key 生成虚拟 id 与勾选态
  function projItem(ev, todayKey) {
    const isRecur = !!ev.recur;
    const isMulti = !isRecur && D().eventEnd(ev) > D().eventStart(ev);
    const perDay = isRecur || isMulti;
    return {
      id: ev.id,
      vid: perDay ? ev.id + '@' + todayKey : ev.id,
      title: ev.title || '(无标题)', time: ev.time || '',
      done: perDay ? TTCore.storage.recurDoneGet(ev.id, todayKey) : !!ev.done,
      recur: isRecur, multi: isMulti
    };
  }
  function sortProjItems(items) {
    items.sort((a, b) => (a.done - b.done) || (a.time || '99:99').localeCompare(b.time || '99:99'));
    return items;
  }
  function buildProjectsModel() {
    const projects = TTCore.storage.loadProjects();
    const events = TTCore.storage.loadEvents();
    const todayKey = D().dateKey(new Date());
    return projects.map(p => {
      const evs = events.filter(e => e.projectId === p.id);
      const phases = (p.phases || []).slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(ph => ({
          id: ph.id, name: ph.name || '(未命名阶段)',
          startDate: ph.startDate || '', endDate: ph.endDate || '',
          isCompleted: !!ph.isCompleted,
          items: sortProjItems(evs.filter(e => e.phaseId === ph.id).map(e => projItem(e, todayKey)))
        }));
      const phaseIds = new Set((p.phases || []).map(ph => ph.id));
      const unphased = sortProjItems(
        evs.filter(e => !e.phaseId || !phaseIds.has(e.phaseId)).map(e => projItem(e, todayKey))
      );
      return {
        id: p.id, name: p.name || '(未命名项目)',
        category: p.category || 'work',
        startDate: p.startDate || '', endDate: p.endDate || '',
        isCompleted: !!p.isCompleted,
        total: evs.length, done: evs.filter(e => e.done).length,
        phases, unphased
      };
    });
  }

  // ---------- M4 纯逻辑：甘特图概览模型（可无 DOM 测试） ----------
  const GANTT_CELL = 30;   // 每天格宽（px）
  // 行：项目条（无日期用事项范围推导）→ 阶段条(depth1) → 多日事项条(depth1/2)；
  // 未归类多日事项归入底部「未归类」组；单日事项与重复模板不进甘特。
  function buildGanttModel(winStartKey, winDays) {
    winDays = winDays || 31;
    const winEnd = D().addDaysKey(winStartKey, winDays - 1);
    const dayDiff = (a, b) => Math.round((D().parseDateKey(a) - D().parseDateKey(b)) / 86400000);
    const clip = (s, e) => {   // 跨度裁剪到窗口；越界 null，否则 { off, len }
      if (!s || !e || e < winStartKey || s > winEnd) return null;
      const cs = s < winStartKey ? winStartKey : s;
      const ce = e > winEnd ? winEnd : e;
      return { off: dayDiff(cs, winStartKey), len: dayDiff(ce, cs) + 1 };
    };
    const C = TTCore.constants;
    const events = TTCore.storage.loadEvents();
    const rows = [];
    const isMulti = (e) => !e.recur && D().eventEnd(e) > D().eventStart(e);
    const multiRow = (ev, depth) => {
      const c = clip(D().eventStart(ev), D().eventEnd(ev));
      return c ? { kind: 'multi', id: ev.id, label: ev.title || '(无标题)', depth, done: !!ev.done,
        start: D().eventStart(ev), end: D().eventEnd(ev), off: c.off, len: c.len } : null;
    };
    for (const p of TTCore.storage.loadProjects()) {
      let s = p.startDate || '', e = p.endDate || '';
      if (!s || !e) {
        const evs = events.filter(x => x.projectId === p.id);
        if (!evs.length) continue;
        s = s || evs.map(x => D().eventStart(x)).sort()[0];
        e = e || evs.map(x => D().eventEnd(x)).sort().slice(-1)[0];
      }
      const span = clip(s, e);
      const childRows = [];
      for (const ph of (p.phases || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))) {
        const c = clip(ph.startDate || '', ph.endDate || '');
        if (c) childRows.push({ kind: 'phase', id: ph.id, label: ph.name || '(未命名阶段)', depth: 1,
          done: !!ph.isCompleted, start: ph.startDate, end: ph.endDate, off: c.off, len: c.len });
      }
      for (const ev of events.filter(x => x.projectId === p.id && isMulti(x))) {
        const r = multiRow(ev, ev.phaseId ? 2 : 1);
        if (r) childRows.push(r);
      }
      if (!span && !childRows.length) continue;
      if (span) rows.push({ kind: 'project', id: p.id, label: p.name || '(未命名项目)', depth: 0,
        done: !!p.isCompleted, start: s, end: e,
        color: (C.CATEGORIES[p.category] || C.CATEGORIES.work).color, off: span.off, len: span.len });
      rows.push(...childRows);
    }
    const unRows = events.filter(e => isMulti(e) && !e.projectId).map(ev => multiRow(ev, 1)).filter(Boolean);
    if (unRows.length) rows.push({ kind: 'group', id: '', label: '未归类', depth: 0 }, ...unRows);
    const days = [];
    for (let i = 0; i < winDays; i++) {
      const k = D().addDaysKey(winStartKey, i);
      const d = D().parseDateKey(k);
      days.push({ key: k, label: (d.getMonth() + 1) + '/' + d.getDate(), wd: '周' + WEEKDAY_CN[d.getDay()] });
    }
    return { winStart: winStartKey, winDays, days, rows, todayOff: dayDiff(D().dateKey(new Date()), winStartKey) };
  }

  // ---------- 写操作薄封装（委托 core，便于测试与统一入口） ----------
  function toggleItem(vid) { return TTCore.opsTasks.toggleDone(vid); }
  function addItem(fields) {
    const ev = TTCore.opsTasks.createEvent(fields);
    // createEvent 不落 phaseId（core 字段表不含），有归属时补一笔 update
    if (ev && fields && fields.phaseId) TTCore.opsTasks.updateEvent(ev.id, { phaseId: fields.phaseId });
    return ev;
  }
  function editItem(id, fields) { return TTCore.opsTasks.updateEvent(id, fields); }
  function deleteItem(id) { return TTCore.opsTasks.removeEvent(id); }

  function projCreate(fields) { return TTCore.opsProjects.createProject(fields); }
  function projUpdate(id, fields) { return TTCore.opsProjects.updateProject(id, fields); }
  function projRemove(id) { return TTCore.opsProjects.removeProject(id); }
  function projToggleComplete(id) { return TTCore.opsProjects.toggleProjectComplete(id); }
  function phaseAdd(pid, fields) { return TTCore.opsProjects.addPhase(pid, fields); }
  function phaseRename(pid, phid, name) { return TTCore.opsProjects.renamePhase(pid, phid, name); }
  function phaseMove(pid, phid, dir) { return TTCore.opsProjects.movePhase(pid, phid, dir); }
  function phaseDates(pid, phid, s, e) { return TTCore.opsProjects.setPhaseDates(pid, phid, s, e); }
  function phaseToggleComplete(pid, phid) { return TTCore.opsProjects.togglePhaseComplete(pid, phid); }
  function phaseRemove(pid, phid) { return TTCore.opsProjects.deletePhase(pid, phid); }

  // ---------- DOM 渲染 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function catOptions(selected) {
    const C = TTCore.constants.CATEGORIES;
    return Object.keys(C).map(k =>
      `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(C[k].label)}</option>`).join('');
  }
  function urgOptions(selected) {
    const U = TTCore.constants.URGENCIES;
    return Object.keys(U).map(k =>
      `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(U[k].label)}</option>`).join('');
  }
  // M3：项目/阶段归属下拉（事项表单用）；空值 = 未归类 / 未分阶段
  function projOptions(selectedId) {
    const ps = TTCore.storage.loadProjects();
    return '<option value="">未归类</option>' + ps.map(p =>
      `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name || '(未命名项目)')}</option>`).join('');
  }
  function phaseOptions(pid, selectedPhid) {
    const p = pid ? TTCore.storage.loadProjects().find(x => x.id === pid) : null;
    const phs = p && Array.isArray(p.phases) ? p.phases.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
    return '<option value="">未分阶段</option>' + phs.map(ph =>
      `<option value="${esc(ph.id)}"${ph.id === selectedPhid ? ' selected' : ''}>${esc(ph.name || '(未命名阶段)')}</option>`).join('');
  }

  function itemHtml(it, dayKey) {
    const flags = (it.recur ? '<em class="m-recur">重复</em>' : '') + (it.multi ? '<em class="m-multi">多日</em>' : '');
    return `<li class="m-item${it.done ? ' done' : ''}" data-id="${esc(it.vid)}" data-real="${esc(it.id)}" data-recur="${it.recur ? 1 : 0}" data-day="${dayKey}">` +
      `<div class="m-item-inner">` +
      `<span class="m-check" data-act="toggle" role="checkbox" aria-checked="${it.done}">${it.done ? '✓' : ''}</span>` +
      `<span class="m-time">${esc(it.time)}</span>` +
      `<span class="m-title" data-act="edit">${esc(it.title)}${flags}</span>` +
      `<span class="m-badge" style="background:${it.catColor}">${esc(it.catLabel)}</span>` +
      `<span class="m-badge urg" style="color:${it.urgColor};border-color:${it.urgColor}">${esc(it.urgLabel)}</span>` +
      `</div>` +
      `<div class="m-swipe-actions"><button class="m-swipe-del" data-act="ask-del">删除</button></div>` +
      `</li>`;
  }

  function editFormHtml(it, dayKey) {
    return `<li class="m-item m-form" data-id="${esc(it.vid)}" data-real="${esc(it.id)}" data-recur="${it.recur ? 1 : 0}" data-day="${dayKey}">` +
      `<div class="m-form-grid">` +
      `<input class="m-input m-edit-title" type="text" value="${esc(it.title)}" placeholder="标题" />` +
      `<input class="m-input m-edit-time" type="time" value="${esc(it.time)}" />` +
      `<select class="m-input m-edit-cat">${catOptions(it.category)}</select>` +
      `<select class="m-input m-edit-urg">${urgOptions(it.urgency)}</select>` +
      `<select class="m-input m-edit-proj">${projOptions(it.projectId)}</select>` +
      `<select class="m-input m-edit-phase">${phaseOptions(it.projectId, it.phaseId)}</select>` +
      `<div class="m-form-btns">` +
      `<button class="m-btn primary" data-act="save-edit">保存</button>` +
      `<button class="m-btn" data-act="cancel">取消</button>` +
      `<button class="m-btn danger" data-act="ask-del">删除</button>` +
      `</div></div></li>`;
  }

  function confirmHtml(it, dayKey) {
    let tip = '删除后不可恢复。';
    if (it.recur) tip = '该事项为重复模板，删除后所有日期均不再出现。';
    else if (it.multi) tip = '该事项跨多天，删除将整条移除（含全部日期）。';
    return `<li class="m-item m-confirm" data-id="${esc(it.vid)}" data-real="${esc(it.id)}" data-day="${dayKey}">` +
      `<span class="m-confirm-tip">确认删除「${esc(it.title)}」？${tip}</span>` +
      `<button class="m-btn danger" data-act="do-del">删除</button>` +
      `<button class="m-btn" data-act="cancel">取消</button></li>`;
  }

  function addFormHtml(dayKey) {
    return `<div class="m-form m-add-form" data-day="${dayKey}">` +
      `<div class="m-form-grid">` +
      `<input class="m-input m-add-title" type="text" placeholder="事项标题（必填）" />` +
      `<input class="m-input m-add-time" type="time" />` +
      `<select class="m-input m-add-proj">${projOptions('')}</select>` +
      `<select class="m-input m-add-phase">${phaseOptions('', '')}</select>` +
      `<div class="m-form-btns">` +
      `<button class="m-btn primary" data-act="save-add" data-day="${dayKey}">保存</button>` +
      `<button class="m-btn" data-act="cancel">取消</button>` +
      `</div></div></div>`;
  }

  // ---------- M3：项目视图 HTML ----------
  function phaseItemsHtml(items) {
    if (!items.length) return '';
    let html = '<ul class="m-list m-phase-items">';
    for (const it of items) {
      const flags = (it.recur ? '<em class="m-recur">重复</em>' : '') + (it.multi ? '<em class="m-multi">多日</em>' : '');
      html += `<li class="m-item${it.done ? ' done' : ''}" data-kind="phitem" data-id="${esc(it.vid)}" data-real="${esc(it.id)}">` +
        `<div class="m-item-inner">` +
        `<span class="m-check" data-act="toggle" role="checkbox" aria-checked="${it.done}">${it.done ? '✓' : ''}</span>` +
        `<span class="m-time">${esc(it.time)}</span>` +
        `<span class="m-title">${esc(it.title)}${flags}</span>` +
        `</div></li>`;
    }
    return html + '</ul>';
  }

  function phaseFormHtml(pid, ph) {
    return `<div class="m-form m-phase-form" data-pid="${esc(pid)}"${ph ? ` data-phid="${esc(ph.id)}"` : ''}>` +
      `<div class="m-form-grid">` +
      `<input class="m-input m-phf-name" type="text" placeholder="阶段名称（必填）" value="${ph ? esc(ph.name) : ''}" />` +
      `<input class="m-input m-phf-start" type="date" value="${ph ? esc(ph.startDate) : ''}" />` +
      `<input class="m-input m-phf-end" type="date" value="${ph ? esc(ph.endDate) : ''}" />` +
      `<div class="m-form-btns">` +
      `<button class="m-btn primary" data-act="phase-save">保存</button>` +
      `<button class="m-btn" data-act="cancel">取消</button>` +
      `</div></div></div>`;
  }

  function phaseConfirmStripHtml(pid, ph) {
    return `<div class="m-confirm" data-pid="${esc(pid)}" data-phid="${esc(ph.id)}">` +
      `<span class="m-confirm-tip">删除阶段「${esc(ph.name)}」？其下事项将归为未分阶段。</span>` +
      `<button class="m-btn danger" data-act="phase-do-del">删除</button>` +
      `<button class="m-btn" data-act="cancel">取消</button></div>`;
  }

  function projDetailHtml(p) {
    let html = '<div class="m-proj-detail">';
    for (const ph of p.phases) {
      if (ui.phaseConfirm && ui.phaseConfirm.phid === ph.id) {
        html += phaseConfirmStripHtml(p.id, ph);
        continue;
      }
      if (ui.phaseForm && ui.phaseForm.mode === 'edit' && ui.phaseForm.phid === ph.id) {
        html += phaseFormHtml(p.id, ph);
        continue;
      }
      const dates = (ph.startDate || ph.endDate) ? `${esc(ph.startDate || '…')} ~ ${esc(ph.endDate || '…')}` : '';
      html += `<div class="m-phase${ph.isCompleted ? ' done' : ''}">` +
        `<div class="m-phase-row">` +
        `<span class="m-check" data-act="phase-complete" data-pid="${esc(p.id)}" data-phid="${esc(ph.id)}">${ph.isCompleted ? '✓' : ''}</span>` +
        `<span class="m-phase-name" data-act="phase-edit" data-pid="${esc(p.id)}" data-phid="${esc(ph.id)}">${esc(ph.name)}</span>` +
        `<span class="m-phase-dates">${dates}</span>` +
        `<button class="m-mini" data-act="phase-up" data-pid="${esc(p.id)}" data-phid="${esc(ph.id)}">↑</button>` +
        `<button class="m-mini" data-act="phase-down" data-pid="${esc(p.id)}" data-phid="${esc(ph.id)}">↓</button>` +
        `<button class="m-mini danger" data-act="phase-ask-del" data-pid="${esc(p.id)}" data-phid="${esc(ph.id)}">删</button>` +
        `</div>` +
        phaseItemsHtml(ph.items) +
        `</div>`;
    }
    if (ui.phaseForm && ui.phaseForm.mode === 'add' && ui.phaseForm.pid === p.id) {
      html += phaseFormHtml(p.id, null);
    }
    if (p.unphased.length) {
      html += `<div class="m-phase"><div class="m-phase-row"><span class="m-phase-name m-muted">未分阶段</span></div>` +
        phaseItemsHtml(p.unphased) + `</div>`;
    }
    html += `<div class="m-phase-ops">` +
      `<div class="m-add" data-act="phase-open-add" data-pid="${esc(p.id)}">＋ 阶段</div>` +
      `<div class="m-add" data-act="proj-open-edit" data-pid="${esc(p.id)}">✎ 编辑项目</div>` +
      `</div></div>`;
    return html;
  }

  function projCardHtml(p) {
    const open = ui.projOpen === p.id;
    const dates = (p.startDate || p.endDate) ? `${esc(p.startDate || '…')} ~ ${esc(p.endDate || '…')} · ` : '';
    return `<li class="m-item m-proj${p.isCompleted ? ' done' : ''}${open ? ' open' : ''}" data-kind="proj" data-id="${esc(p.id)}">` +
      `<div class="m-item-inner">` +
      `<span class="m-check" data-act="proj-complete" role="checkbox" aria-checked="${p.isCompleted}">${p.isCompleted ? '✓' : ''}</span>` +
      `<span class="m-proj-main" data-act="proj-toggle">` +
      `<span class="m-title">${esc(p.name)}</span>` +
      `<span class="m-proj-sub">${dates}${p.done}/${p.total} 完成</span>` +
      `</span>` +
      `<span class="m-proj-arrow" data-act="proj-toggle">${open ? '▾' : '▸'}</span>` +
      `</div>` +
      `<div class="m-swipe-actions"><button class="m-swipe-del" data-act="proj-ask-del">删除</button></div>` +
      (open ? projDetailHtml(p) : '') +
      `</li>`;
  }

  function projFormHtml(p) {
    return `<li class="m-item m-form" data-kind="proj"${p ? ` data-real="${esc(p.id)}"` : ''}>` +
      `<div class="m-form-grid">` +
      `<input class="m-input m-pf-name" type="text" placeholder="项目名称（必填）" value="${p ? esc(p.name) : ''}" />` +
      `<input class="m-input m-pf-start" type="date" value="${p ? esc(p.startDate) : ''}" />` +
      `<input class="m-input m-pf-end" type="date" value="${p ? esc(p.endDate) : ''}" />` +
      `<div class="m-form-btns">` +
      `<button class="m-btn primary" data-act="${p ? 'proj-save-edit' : 'proj-save-add'}">保存</button>` +
      `<button class="m-btn" data-act="cancel">取消</button>` +
      `</div></div></li>`;
  }

  function projConfirmHtml(p) {
    return `<li class="m-item m-confirm" data-kind="proj" data-real="${esc(p.id)}">` +
      `<span class="m-confirm-tip">确认删除项目「${esc(p.name)}」？其下事项将归为未归类（不会删除事项）。</span>` +
      `<button class="m-btn danger" data-act="proj-do-del">删除</button>` +
      `<button class="m-btn" data-act="cancel">取消</button></li>`;
  }

  // ---------- M4：甘特图概览视图 HTML ----------
  function ganttViewHtml() {
    if (!ui.ganttStart) ui.ganttStart = D().addDaysKey(D().dateKey(new Date()), -3);
    const m = buildGanttModel(ui.ganttStart, 31);
    const trackW = m.winDays * GANTT_CELL;
    let html = '<section class="m-gantt-wrap">';
    html += `<div class="m-gantt-ctl">` +
      `<button class="m-mini" data-act="gantt-prev">‹ 前四周</button>` +
      `<span class="m-gantt-range">${esc(m.days[0].label)} ~ ${esc(m.days[m.winDays - 1].label)}</span>` +
      `<button class="m-mini" data-act="gantt-today">回到今天</button>` +
      `<button class="m-mini" data-act="gantt-next">后四周 ›</button></div>`;
    html += `<div class="m-gantt"><div class="m-g-grid" style="width:${96 + trackW}px">`;
    if (m.todayOff >= 0 && m.todayOff < m.winDays) {
      html += `<div class="m-g-todayline" style="left:${96 + m.todayOff * GANTT_CELL + GANTT_CELL / 2}px"></div>`;
    }
    html += `<div class="m-g-row m-g-head"><div class="m-g-label"></div><div class="m-g-track" style="width:${trackW}px">`;
    m.days.forEach((d, i) => {
      html += `<div class="m-g-cell${i === m.todayOff ? ' today' : ''}" style="left:${i * GANTT_CELL}px"><b>${esc(d.label)}</b><i>${esc(d.wd)}</i></div>`;
    });
    html += '</div></div>';
    const BAR_COLOR = { phase: '#5b8dd9', multi: '#8a6fd0' };
    for (const r of m.rows) {
      if (r.kind === 'group') {
        html += `<div class="m-g-row m-g-group"><div class="m-g-label">${esc(r.label)}</div><div class="m-g-track" style="width:${trackW}px"></div></div>`;
        continue;
      }
      const color = r.kind === 'project' ? (r.color || '#5b8dd9') : BAR_COLOR[r.kind];
      html += `<div class="m-g-row">` +
        `<div class="m-g-label" style="padding-left:${6 + r.depth * 12}px">${esc(r.label)}</div>` +
        `<div class="m-g-track" style="width:${trackW}px">` +
        `<div class="m-g-bar ${r.kind}${r.done ? ' done' : ''}" data-act="gantt-bar" data-label="${esc(r.label)}"` +
        ` data-range="${esc(r.start)} ~ ${esc(r.end)}"` +
        ` style="left:${r.off * GANTT_CELL + 1}px;width:${r.len * GANTT_CELL - 2}px;background:${color}"></div>` +
        `</div></div>`;
    }
    if (!m.rows.length) html += '<div class="m-empty">窗口内无项目或多日事项</div>';
    html += '</div></div></section>';
    return html;
  }

  // 渲染态：日程视图（editing/confirming/adding）+ 项目视图（projOpen/projForm/projConfirm/phaseForm/phaseConfirm）
  const ui = {
    view: 'days',
    editing: null, confirming: null, adding: null,
    projOpen: null, projForm: null, projConfirm: null,
    phaseForm: null, phaseConfirm: null,
    ganttStart: null   // M4：甘特窗口起点（null = 今天-3）
  };

  function clearTransient() {
    ui.editing = null; ui.confirming = null; ui.adding = null;
    ui.projForm = null; ui.projConfirm = null;
    ui.phaseForm = null; ui.phaseConfirm = null;
  }

  function headerHtml() {
    return '<header class="m-header"><h1>日程表</h1>' +
      `<div class="m-seg">` +
      `<button data-act="view-days"${ui.view === 'days' ? ' class="on"' : ''}>日程</button>` +
      `<button data-act="view-projects"${ui.view === 'projects' ? ' class="on"' : ''}>项目</button>` +
      `<button data-act="view-gantt"${ui.view === 'gantt' ? ' class="on"' : ''}>概览</button>` +
      `</div></header>`;
  }

  function daysViewHtml() {
    const days = buildWeekModel(new Date());
    let html = '';
    for (const day of days) {
      html += `<section class="m-day"><h2 class="m-day-title">${esc(day.label)}</h2>`;
      if (!day.items.length && ui.adding !== day.key) {
        html += '<div class="m-empty">无事项</div>';
      }
      if (day.items.length) {
        html += '<ul class="m-list">';
        for (const it of day.items) {
          if (ui.confirming === it.vid) html += confirmHtml(it, day.key);
          else if (ui.editing === it.vid) html += editFormHtml(it, day.key);
          else html += itemHtml(it, day.key);
        }
        html += '</ul>';
      }
      html += (ui.adding === day.key)
        ? addFormHtml(day.key)
        : `<div class="m-add" data-act="open-add" data-day="${day.key}">＋ 添加</div>`;
      html += '</section>';
    }
    return html;
  }

  function projectsViewHtml() {
    const model = buildProjectsModel();
    let html = '<section class="m-projects">';
    if (ui.projForm && ui.projForm.mode === 'add') {
      html += projFormHtml(null);
    } else {
      html += '<div class="m-add" data-act="proj-open-add">＋ 新建项目</div>';
    }
    if (!model.length) html += '<div class="m-empty">暂无项目</div>';
    if (model.length) {
      html += '<ul class="m-list">';
      for (const p of model) {
        if (ui.projConfirm === p.id) html += projConfirmHtml(p);
        else if (ui.projForm && ui.projForm.mode === 'edit' && ui.projForm.id === p.id) html += projFormHtml(p);
        else html += projCardHtml(p);
      }
      html += '</ul>';
    }
    return html + '</section>';
  }

  function render() {
    const rootEl = document.getElementById('app');
    const html = headerHtml() + (ui.view === 'projects' ? projectsViewHtml() : ui.view === 'gantt' ? ganttViewHtml() : daysViewHtml());
    if (rootEl) rootEl.innerHTML = html;
    return html;   // 返回渲染串供沙箱测试断言
  }

  // ---------- 交互 ----------
  function findItem(vid) {
    const days = buildWeekModel(new Date());
    for (const d of days) {
      const it = d.items.find(i => i.vid === vid);
      if (it) return { item: it, dayKey: d.key };
    }
    return null;
  }

  const SWIPE_W = 72;        // 操作条宽度（px）
  const SWIPE_OPEN = 56;     // 打开阈值
  let swallowNextClick = false;  // 手势结束后只吞掉本次手势附带的那一个 click
  const DEL_ASK_ACTS = ['ask-del', 'proj-ask-del'];   // 滑动操作条上的删除类按钮

  function closeSwipes(except) {
    const rootEl = document.getElementById('app');
    rootEl.querySelectorAll('li.m-item.swiped').forEach(li => {
      if (li === except) return;
      li.classList.remove('swiped');
      const inner = li.querySelector('.m-item-inner');
      if (inner) { inner.style.transition = ''; inner.style.transform = ''; }
    });
  }

  function bindEvents() {
    const rootEl = document.getElementById('app');
    if (!rootEl || rootEl._mBound) return;
    rootEl._mBound = true;

    // 捕获阶段吞掉手势附带的合成 click（touch ~300ms 后 / mouse 拖拽后立即），只吞一个
    rootEl.addEventListener('click', (e) => {
      if (swallowNextClick) { swallowNextClick = false; e.stopPropagation(); }
    }, true);

    // 项目下拉变更 → 联动重填阶段下拉（不整页 render，保留表单输入）
    rootEl.addEventListener('change', (e) => {
      const sel = e.target.closest && e.target.closest('.m-edit-proj, .m-add-proj');
      if (!sel) return;
      const form = sel.closest('.m-form');
      const phSel = form && form.querySelector('.m-edit-phase, .m-add-phase');
      if (phSel) phSel.innerHTML = phaseOptions(sel.value, '');
    });

    rootEl.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      const liEl = e.target.closest('li.m-item');

      // 点击其他区域：先收起已展开的滑动操作条（删除类按钮放行）
      if (liEl && liEl.classList.contains('swiped') && (!actEl || DEL_ASK_ACTS.indexOf(actEl.dataset.act) < 0)) {
        closeSwipes();
        return;
      }
      if (!liEl) { closeSwipes(); if (!actEl) return; }

      if (!actEl) return;
      const act = actEl.dataset.act;

      // ---------- 视图切换 ----------
      if (act === 'view-days' || act === 'view-projects' || act === 'view-gantt') {
        ui.view = act === 'view-days' ? 'days' : act === 'view-projects' ? 'projects' : 'gantt';
        clearTransient();
        render();
        return;
      }

      // ---------- 甘特图概览（M4，只读） ----------
      if (act === 'gantt-prev' || act === 'gantt-next') {
        const base = ui.ganttStart || D().addDaysKey(D().dateKey(new Date()), -3);
        ui.ganttStart = D().addDaysKey(base, act === 'gantt-prev' ? -28 : 28);
        render();
        return;
      }
      if (act === 'gantt-today') {
        ui.ganttStart = null;
        render();
        return;
      }
      if (act === 'gantt-bar') {
        TTPlatform.toast(actEl.dataset.label + '：' + actEl.dataset.range);
        return;
      }

      // ---------- 事项（日程视图 + 项目详情内勾选） ----------
      if (act === 'toggle') {
        const vid = liEl && liEl.dataset.id;
        if (!vid) return;
        toggleItem(vid);
        render();
        return;
      }
      if (act === 'edit') {
        const vid = liEl && liEl.dataset.id;
        if (!vid) return;
        clearTransient();
        ui.editing = vid;
        render();
        return;
      }
      if (act === 'open-add') {
        clearTransient();
        ui.adding = actEl.dataset.day;
        render();
        const inp = rootEl.querySelector('.m-add-title');
        if (inp) inp.focus();
        return;
      }
      if (act === 'save-add') {
        const dayKey = actEl.dataset.day;
        const form = rootEl.querySelector(`.m-add-form[data-day="${dayKey}"]`);
        const title = form.querySelector('.m-add-title').value.trim();
        const time = form.querySelector('.m-add-time').value;
        const projectId = form.querySelector('.m-add-proj').value || null;
        const phaseId = projectId ? (form.querySelector('.m-add-phase').value || '') : '';
        if (!title) { TTPlatform.toast('请填写标题'); return; }
        addItem({ title, startDate: dayKey, time: time || '', projectId, phaseId });
        ui.adding = null;
        render();
        return;
      }
      if (act === 'save-edit') {
        const form = actEl.closest('li.m-form');
        const realId = form.dataset.real;
        const projectId = form.querySelector('.m-edit-proj').value || null;
        const fields = {
          title: form.querySelector('.m-edit-title').value.trim(),
          time: form.querySelector('.m-edit-time').value || '',
          category: form.querySelector('.m-edit-cat').value,
          urgency: form.querySelector('.m-edit-urg').value,
          projectId,
          phaseId: projectId ? (form.querySelector('.m-edit-phase').value || '') : ''
        };
        if (!fields.title) { TTPlatform.toast('请填写标题'); return; }
        editItem(realId, fields);
        ui.editing = null;
        render();
        return;
      }
      if (act === 'ask-del') {
        const targetLi = actEl.closest('li.m-item');
        clearTransient();
        ui.confirming = targetLi.dataset.id;
        render();
        return;
      }
      if (act === 'do-del') {
        const li = actEl.closest('li.m-confirm');
        deleteItem(li.dataset.real);
        ui.confirming = null;
        render();
        return;
      }

      // ---------- 项目 ----------
      if (act === 'proj-toggle') {
        const pid = liEl && liEl.dataset.id;
        if (!pid) return;
        ui.projOpen = ui.projOpen === pid ? null : pid;
        ui.projForm = null; ui.projConfirm = null;
        ui.phaseForm = null; ui.phaseConfirm = null;
        render();
        return;
      }
      if (act === 'proj-complete') {
        const pid = liEl && liEl.dataset.id;
        if (!pid) return;
        projToggleComplete(pid);
        render();
        return;
      }
      if (act === 'proj-open-add') {
        clearTransient();
        ui.projForm = { mode: 'add' };
        render();
        const inp = rootEl.querySelector('.m-pf-name');
        if (inp) inp.focus();
        return;
      }
      if (act === 'proj-open-edit') {
        clearTransient();
        ui.projForm = { mode: 'edit', id: actEl.dataset.pid };
        render();
        return;
      }
      if (act === 'proj-save-add' || act === 'proj-save-edit') {
        const form = actEl.closest('li.m-form');
        const name = form.querySelector('.m-pf-name').value.trim();
        if (!name) { TTPlatform.toast('请填写项目名称'); return; }
        const fields = {
          name,
          startDate: form.querySelector('.m-pf-start').value || '',
          endDate: form.querySelector('.m-pf-end').value || ''
        };
        if (act === 'proj-save-add') projCreate(fields);
        else projUpdate(form.dataset.real, fields);
        ui.projForm = null;
        render();
        return;
      }
      if (act === 'proj-ask-del') {
        const targetLi = actEl.closest('li.m-item');
        clearTransient();
        ui.projConfirm = targetLi.dataset.id;
        render();
        return;
      }
      if (act === 'proj-do-del') {
        const li = actEl.closest('li.m-confirm');
        projRemove(li.dataset.real);
        ui.projConfirm = null;
        render();
        return;
      }

      // ---------- 阶段 ----------
      if (act === 'phase-open-add') {
        clearTransient();
        ui.phaseForm = { mode: 'add', pid: actEl.dataset.pid };
        render();
        return;
      }
      if (act === 'phase-edit') {
        clearTransient();
        ui.phaseForm = { mode: 'edit', pid: actEl.dataset.pid, phid: actEl.dataset.phid };
        render();
        return;
      }
      if (act === 'phase-save') {
        const form = actEl.closest('.m-phase-form');
        const pid = form.dataset.pid;
        const name = form.querySelector('.m-phf-name').value.trim();
        if (!name) { TTPlatform.toast('请填写阶段名称'); return; }
        const s = form.querySelector('.m-phf-start').value || '';
        const e2 = form.querySelector('.m-phf-end').value || '';
        if (form.dataset.phid) {
          phaseRename(pid, form.dataset.phid, name);
          phaseDates(pid, form.dataset.phid, s, e2);
        } else {
          phaseAdd(pid, { name, startDate: s, endDate: e2 });
        }
        ui.phaseForm = null;
        render();
        return;
      }
      if (act === 'phase-complete') {
        phaseToggleComplete(actEl.dataset.pid, actEl.dataset.phid);
        render();
        return;
      }
      if (act === 'phase-up' || act === 'phase-down') {
        phaseMove(actEl.dataset.pid, actEl.dataset.phid, act === 'phase-up' ? -1 : 1);
        render();
        return;
      }
      if (act === 'phase-ask-del') {
        clearTransient();
        ui.phaseConfirm = { pid: actEl.dataset.pid, phid: actEl.dataset.phid };
        render();
        return;
      }
      if (act === 'phase-do-del') {
        const strip = actEl.closest('.m-confirm');
        phaseRemove(strip.dataset.pid, strip.dataset.phid);
        ui.phaseConfirm = null;
        render();
        return;
      }

      if (act === 'cancel') {
        clearTransient();
        render();
      }
    });

    // ---------- 左滑露出删除（touch + mouse 同源逻辑） ----------
    let g = null;   // { li, inner, x, y, axis, moved, cur }
    let pressTimer = null;

    function pressStart(e) {
      const t = e.touches ? e.touches[0] : e;
      const li = t.target && t.target.closest && t.target.closest('li.m-item');
      if (!li || li.classList.contains('m-form') || li.classList.contains('m-confirm')) return;
      if (li.dataset.kind === 'phitem') return;   // 项目详情内事项条目不支持滑动/长按（删除走日程视图）
      g = { li, inner: li.querySelector('.m-item-inner'), x: t.clientX, y: t.clientY, axis: null, moved: false, cur: 0 };
      // 长按兜底（桌面鼠标 / 未滑动时）：500ms 进删除确认（项目条目走项目确认）
      if (g.inner) {
        pressTimer = setTimeout(() => {
          if (!g || g.axis) return;
          clearTransient();
          if (g.li.dataset.kind === 'proj') ui.projConfirm = g.li.dataset.id;
          else ui.confirming = g.li.dataset.id;
          render();
        }, 500);
      }
    }
    function pressMove(e) {
      if (!g) return;
      const t = e.touches ? e.touches[0] : e;
      if (e.touches === undefined && e.buttons === 0) { g = null; return; }  // 鼠标未按住
      const dx = t.clientX - g.x, dy = t.clientY - g.y;
      if (!g.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (g.axis === 'y' && pressTimer) { clearTimeout(pressTimer); pressTimer = null; }  // 纵向滚动手势不触发长按
      }
      if (g.axis !== 'x') return;
      e.preventDefault();                 // 阻止纵向滚动与合成 click（监听须 passive:false）
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      g.moved = true;
      closeSwipes(g.li);
      const base = g.li.classList.contains('swiped') ? -SWIPE_W : 0;
      const nx = Math.max(-SWIPE_W, Math.min(0, base + dx));
      g.cur = nx;
      g.inner.style.transition = 'none';
      g.inner.style.transform = 'translateX(' + nx + 'px)';
    }
    function pressEnd(e) {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (!g) return;
      const gg = g; g = null;
      if (gg.axis !== 'x' || !gg.moved || !gg.inner || !gg.li.isConnected) return;
      const open = gg.cur < -SWIPE_OPEN;
      gg.inner.style.transition = '';
      gg.inner.style.transform = '';
      gg.li.classList.toggle('swiped', open);
      swallowNextClick = true;   // 只吞掉本次手势附带的合成 click，主动点击不受影响
    }

    rootEl.addEventListener('touchstart', pressStart, { passive: true });
    rootEl.addEventListener('touchmove', pressMove, { passive: false });
    rootEl.addEventListener('touchend', pressEnd);
    rootEl.addEventListener('touchcancel', pressEnd);
    rootEl.addEventListener('mousedown', pressStart);
    rootEl.addEventListener('mousemove', pressMove);
    rootEl.addEventListener('mouseup', pressEnd);
    rootEl.addEventListener('mouseleave', () => { g = null; if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });
  }

  // ---------- 启动 ----------
  function init() {
    TTPlatform.configureStorage({ toast: TTPlatform.toast });
    TTPlatform.configureView({ onDerivedInvalid: null });
    const seeded = seedIfEmpty();
    seedProjectsIfEmpty();
    render();
    bindEvents();
    if (seeded) TTPlatform.toast('已注入示例数据（仅本地）');
  }

  root.TTMobile = {
    seedIfEmpty, seedProjectsIfEmpty,
    collectDayItems, buildWeekModel, buildProjectsModel, buildGanttModel,
    toggleItem, addItem, editItem, deleteItem,
    projCreate, projUpdate, projRemove, projToggleComplete,
    phaseAdd, phaseRename, phaseMove, phaseDates, phaseToggleComplete, phaseRemove,
    render, init
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
