// ============ 核心层：数据模型归一化迁移（M0 解耦） ============
// 纯函数：就地补齐/纠正单条记录字段，兼容历史数据。不做 IO、不依赖 DOM。
// 迁移规则必须与历史版本一致，避免旧数据语义漂移。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  // 事项（Task）记录迁移
  function migrateEvent(ev) {
    if (ev.projectId === undefined) ev.projectId = null;
    if (ev.description === undefined) ev.description = '';
    // 老数据只有单日期 date → 起止日期相同
    if (ev.startDate === undefined) ev.startDate = ev.date || '';
    if (ev.endDate === undefined) ev.endDate = ev.date || '';
    // 纠正异常区间（结束早于开始 → 交换）
    if (ev.startDate && ev.endDate && ev.endDate < ev.startDate) {
      const t = ev.startDate; ev.startDate = ev.endDate; ev.endDate = t;
    }
    // 番茄钟累计完成数（绑定事项后，每完成一个专注 +1）
    if (ev.pomoCount === undefined) ev.pomoCount = 0;
    // 提醒：提前分钟数 / 贪睡截止时间戳
    if (ev.remindAhead === undefined) ev.remindAhead = 0;
    if (ev.snoozeUntil === undefined) ev.snoozeUntil = 0;
    // 同步预留：最后同步时间
    if (ev.lastSyncAt === undefined) ev.lastSyncAt = '';
    // 重复规则（P3.2）：null = 不重复；命中日由虚拟投影动态生成
    if (ev.recur === undefined) ev.recur = null;
    // 标签（P3.3）：字符串数组，用于今日/事项视图筛选
    if (!Array.isArray(ev.tags)) ev.tags = [];
    // 阶段（P8.1）：事项所属项目阶段 id，空字符串表示未分阶段
    if (ev.phaseId === undefined) ev.phaseId = '';
    // 完成时间戳（V3）：done 为 true 时记录完成时刻；旧数据兜底用 updatedAt
    if (ev.completedAt === undefined) ev.completedAt = ev.done ? (ev.updatedAt || new Date().toISOString()) : '';
    return ev;
  }

  // 项目（Project）记录迁移（含阶段 Phase）
  function migrateProject(p) {
    if (p.startDate === undefined) p.startDate = '';
    if (p.endDate === undefined) p.endDate = '';
    if (p.category === undefined) p.category = 'work';
    if (p.revision === undefined) p.revision = 1;                 // 同步版本号（导出/修改递增）
    if (p.updatedAt === undefined) p.updatedAt = p.createdAt || '';
    // 阶段（P8.1）：[{id, name, order, startDate, endDate, description, isCompleted, completedAt}]
    if (!Array.isArray(p.phases)) p.phases = [];
    p.phases = p.phases.filter(ph => ph && typeof ph === 'object');   // 过滤 null/非对象脏数据
    for (const ph of p.phases) {
      if (ph.startDate === undefined) ph.startDate = '';
      if (ph.endDate === undefined) ph.endDate = '';
      if (ph.description === undefined) ph.description = '';            // V3：阶段简介
      if (ph.isCompleted === undefined) ph.isCompleted = false;        // V3：阶段完成状态
      if (ph.completedAt === undefined) ph.completedAt = '';           // V3：阶段完成时间
      if (ph.startDate && ph.endDate && ph.endDate < ph.startDate) {
        const t = ph.startDate; ph.startDate = ph.endDate; ph.endDate = t;
      }
    }
    // V3：项目完成状态
    if (p.isCompleted === undefined) p.isCompleted = false;
    if (p.completedAt === undefined) p.completedAt = '';
    if (p.startDate && p.endDate && p.endDate < p.startDate) {
      const t = p.startDate; p.startDate = p.endDate; p.endDate = t;
    }
    return p;
  }

  TTCore.models = { migrateEvent, migrateProject };
})(typeof window !== 'undefined' ? window : globalThis);
