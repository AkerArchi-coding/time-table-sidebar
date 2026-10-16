// ============ 核心层：ID 生成器（M0 解耦） ============
// 纯函数，无 DOM / 无 Electron 依赖。各 id 前缀与历史格式必须原样保留：
// 同步层（墓碑 / id 重映射）与备份兼容判定依赖既有格式，不得更改。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};

  // 随机后缀：Math.random().toString(36).slice(2, n)
  function rand(n) { return Math.random().toString(36).slice(2, n); }

  // 事项（Task）id：无前缀（历史格式）；时间戳 + 随机
  function mkEventId() { return String(Date.now()) + rand(6); }
  // 项目 id
  function mkProjectId() { return 'p' + String(Date.now()) + rand(6); }
  // 项目阶段（Phase）id
  function mkPhaseId() { return 'ph' + String(Date.now()) + rand(6); }
  // 子任务（检查清单）id：时间戳转 36 进制
  function mkCkId() { return 'ck' + Date.now().toString(36) + rand(6); }
  // 外部日历订阅 id
  function mkCalSubId() { return 'cs' + Date.now().toString(36) + rand(7); }
  // 事项模板 id
  function mkTplId() { return 'tpl-' + Date.now().toString(36) + rand(6); }
  // iCal 导入事项 id：'t' 前缀，区别于本地无前缀事项
  function mkImportEventId() { return 't' + Date.now() + rand(6); }

  TTCore.ids = {
    rand, mkEventId, mkProjectId, mkPhaseId, mkCkId, mkCalSubId, mkTplId, mkImportEventId
  };
})(typeof window !== 'undefined' ? window : globalThis);
