// ============ 移动端：事项读写应用（M2 写操作闭环） ============
// M1：只读 7 天列表 + core 复用验证。M2 新增：勾选 / 新增 / 编辑 / 删除。
// 全部写操作走 TTCore.opsTasks.*；重复模板勾选走虚拟 id（evId@dateKey）写 recurDone。
// 交互：点勾选框=切换完成；点标题=行内编辑；长按条目=操作条（删除，二次确认）。
// 纯逻辑（seed/collect/buildWeekModel）挂 TTMobile 供 node --test 在 vm 沙箱断言。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const D = () => TTCore.dates;

  const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

  // ---------- 示例数据注入（M1 沿用） ----------
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

  // ---------- 写操作薄封装（委托 core，便于测试与统一入口） ----------
  function toggleItem(vid) { return TTCore.opsTasks.toggleDone(vid); }
  function addItem(fields) { return TTCore.opsTasks.createEvent(fields); }
  function editItem(id, fields) { return TTCore.opsTasks.updateEvent(id, fields); }
  function deleteItem(id) { return TTCore.opsTasks.removeEvent(id); }

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
      `<div class="m-form-btns">` +
      `<button class="m-btn primary" data-act="save-add" data-day="${dayKey}">保存</button>` +
      `<button class="m-btn" data-act="cancel">取消</button>` +
      `</div></div></div>`;
  }

  // 渲染态：正在编辑/确认删除的条目 vid，正在新增的 dayKey（render 后恢复表单用）
  const ui = { editing: null, confirming: null, adding: null };

  function render() {
    const rootEl = document.getElementById('app');
    if (!rootEl) return;
    const days = buildWeekModel(new Date());
    let html = '<header class="m-header"><h1>日程表</h1><span class="m-sub">M2 · 数据在本地</span></header>';
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
    rootEl.innerHTML = html;
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

    rootEl.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      const liEl = e.target.closest('li.m-item');

      // 点击其他区域：先收起已展开的滑动操作条
      if (liEl && liEl.classList.contains('swiped') && (!actEl || actEl.dataset.act !== 'ask-del')) {
        closeSwipes();
        return;
      }
      if (!liEl) { closeSwipes(); if (!actEl) return; }

      if (!actEl) return;
      const act = actEl.dataset.act;

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
        ui.editing = vid; ui.confirming = null; ui.adding = null;
        render();
        return;
      }
      if (act === 'open-add') {
        ui.adding = actEl.dataset.day; ui.editing = null; ui.confirming = null;
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
        if (!title) { TTPlatform.toast('请填写标题'); return; }
        addItem({ title, startDate: dayKey, time: time || '' });
        ui.adding = null;
        render();
        return;
      }
      if (act === 'save-edit') {
        const form = actEl.closest('li.m-form');
        const realId = form.dataset.real;
        const fields = {
          title: form.querySelector('.m-edit-title').value.trim(),
          time: form.querySelector('.m-edit-time').value || '',
          category: form.querySelector('.m-edit-cat').value,
          urgency: form.querySelector('.m-edit-urg').value
        };
        if (!fields.title) { TTPlatform.toast('请填写标题'); return; }
        editItem(realId, fields);
        ui.editing = null;
        render();
        return;
      }
      if (act === 'ask-del') {
        const targetLi = actEl.closest('li.m-item');
        ui.confirming = targetLi.dataset.id; ui.editing = null; ui.adding = null;
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
      if (act === 'cancel') {
        ui.editing = null; ui.confirming = null; ui.adding = null;
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
      g = { li, inner: li.querySelector('.m-item-inner'), x: t.clientX, y: t.clientY, axis: null, moved: false, cur: 0 };
      // 长按兜底（桌面鼠标 / 未滑动时）：500ms 进删除确认
      if (g.inner) {
        pressTimer = setTimeout(() => {
          if (!g || g.axis) return;
          ui.confirming = g.li.dataset.id; ui.editing = null; ui.adding = null;
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
    render();
    bindEvents();
    if (seeded) TTPlatform.toast('已注入示例数据（仅本地）');
  }

  root.TTMobile = {
    seedIfEmpty, collectDayItems, buildWeekModel,
    toggleItem, addItem, editItem, deleteItem,
    render, init
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
