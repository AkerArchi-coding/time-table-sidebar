// ============ 核心层聚合入口（M0 解耦） ============
// 各 core 模块自行挂载到 window.TTCore.*；本文件只做命名空间兜底与版本标记。
// 加载顺序要求：本文件在所有 core 模块之后、app.js 之前。
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  TTCore.version = 'm0';
  TTCore.ready = true;
})(typeof window !== 'undefined' ? window : globalThis);
