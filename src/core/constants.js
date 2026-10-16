// ============ 核心层：分类 / 紧急程度 / 项目优先级配置（M0 解耦） ============
// 单一数据源：桌面 app.js 通过同名常量引用本文件，移动端直接复用。
// 经典脚本（无 import/export），挂载到 window.TTCore.constants。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  const CATEGORIES = {
    work:    { label: '工作',     color: '#4a90d9' },   // 蓝色
    personal:{ label: '个人事务', color: '#9b59b6' },   // 紫色
    family:  { label: '家庭事务', color: '#8b6914' }    // 棕色
  };
  const URGENCIES = {
    urgent: { label: '紧急', color: '#e74c3c' },   // 红色
    normal: { label: '一般', color: '#f1c40f' },   // 黄色
    loose:  { label: '松散', color: '#2ecc71' }    // 绿色
  };
  // 项目优先级（三档枚举，默认中）
  const PRIORITIES = {
    high:   { label: '高优先', color: '#e74c3c' },
    medium: { label: '中优先', color: '#f1c40f' },
    low:    { label: '低优先', color: '#2ecc71' }
  };
  function projectPriority(p) { return PRIORITIES[p && p.priority] || PRIORITIES.medium; }

  // 重复规则频率枚举（isRecurOn / recurMatchesDate / RRULE 映射共用）
  const RECUR_FREQS = ['daily', 'weekdays', 'weekly', 'monthly'];

  TTCore.constants = { CATEGORIES, URGENCIES, PRIORITIES, RECUR_FREQS, projectPriority };
})(typeof window !== 'undefined' ? window : globalThis);
