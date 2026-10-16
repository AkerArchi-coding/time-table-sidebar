// ============ 渲染层：平台门面（M0 解耦） ============
// 桌面端（Electron 渲染进程）在此把宿主能力注入核心层，使 src/core 保持零 DOM / 零 Electron 依赖。
// 移动端（Capacitor）后续提供同形门面（不同的 toast / DOM 实现），核心层代码与业务操作无需改动。
// 加载顺序：core/* → 本文件 → app.js
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const viewHooks = { onDerivedInvalid: null };

  // 存储层注入：写入失败时的可见化提示（桌面为 showToast）
  function configureStorage(opts) {
    TTCore.storage.configure(opts);
  }
  // 视图层注入：业务缓存失效时的派生视图缓存清理（桌面为 dayIndex 置空）
  function configureView(hooks) {
    viewHooks.onDerivedInvalid = (hooks && hooks.onDerivedInvalid) || null;
    TTCore.storage.registerDerivedCache(function () {
      if (viewHooks.onDerivedInvalid) viewHooks.onDerivedInvalid();
    });
  }

  root.TTPlatform = { configureStorage, configureView };
})(typeof window !== 'undefined' ? window : globalThis);
