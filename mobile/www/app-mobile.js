// ============ 移动端：只读列表应用（M1） ============
// 目标：验证 src/core 在手机 WebView 中零改动复用。仅读取，不写回业务数据。
// 数据策略：首次启动（events 为空）注入一份相对今天的示例数据；真实同步属 M2+。
// 重复事项（P3.2 虚拟投影属视图逻辑）M1 不展开，重复模板在起始日标注「重复」。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const D = () => TTCore.dates;

  const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

  // ---------- 示例数据注入 ----------
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
      if (ev.recur && D().eventStart(ev) !== key) continue; // 重复模板只在起始日出现
      const cat = C.CATEGORIES[ev.category] || C.CATEGORIES.work;
      const urg = C.URGENCIES[ev.urgency] || C.URGENCIES.normal;
      items.push({
        id: ev.id, title: ev.title || '(无标题)', time: ev.time || '',
        done: !!ev.done, recur: !!ev.recur,
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

  // ---------- DOM 渲染 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function render() {
    const rootEl = document.getElementById('app');
    if (!rootEl) return;
    const days = buildWeekModel(new Date());
    let html = '<header class="m-header"><h1>日程表</h1><span class="m-sub">M1 只读预览 · 数据在本地</span></header>';
    for (const day of days) {
      html += `<section class="m-day"><h2 class="m-day-title">${esc(day.label)}</h2>`;
      if (!day.items.length) {
        html += '<div class="m-empty">无事项</div>';
      } else {
        html += '<ul class="m-list">';
        for (const it of day.items) {
          html += `<li class="m-item${it.done ? ' done' : ''}">` +
            `<span class="m-time">${esc(it.time)}</span>` +
            `<span class="m-title">${esc(it.title)}${it.recur ? '<em class="m-recur">重复</em>' : ''}</span>` +
            `<span class="m-badge" style="background:${it.catColor}">${esc(it.catLabel)}</span>` +
            `<span class="m-badge urg" style="color:${it.urgColor};border-color:${it.urgColor}">${esc(it.urgLabel)}</span>` +
            `</li>`;
        }
        html += '</ul>';
      }
      html += '</section>';
    }
    rootEl.innerHTML = html;
  }

  // ---------- 启动 ----------
  function init() {
    TTPlatform.configureStorage({ toast: TTPlatform.toast });
    TTPlatform.configureView({ onDerivedInvalid: null });
    const seeded = seedIfEmpty();
    render();
    if (seeded) TTPlatform.toast('已注入示例数据（仅本地，M1 验证用）');
  }

  // 对外暴露纯逻辑，便于 node --test 在 vm 沙箱中断言
  root.TTMobile = { seedIfEmpty, collectDayItems, buildWeekModel, render, init };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
