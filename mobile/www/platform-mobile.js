// ============ 移动端：平台门面（M1） ============
// 与桌面端 src/renderer/platform.js 同形：向 TTCore 注入宿主能力。
// 移动端实现：toast 用自绘浮层，确认对话框 M1 暂不需要（只读页）。
// 加载顺序：core/* → 本文件 → app-mobile.js
(function (root) {
  'use strict';
  const TTCore = root.TTCore = root.TTCore || {};
  const viewHooks = { onDerivedInvalid: null };

  function configureStorage(opts) {
    TTCore.storage.configure(opts);
  }
  function configureView(hooks) {
    viewHooks.onDerivedInvalid = (hooks && hooks.onDerivedInvalid) || null;
    TTCore.storage.registerDerivedCache(function () {
      if (viewHooks.onDerivedInvalid) viewHooks.onDerivedInvalid();
    });
  }

  // 移动端最简 toast（M1 只读页主要给存储写入失败可见化用）
  function toast(msg) {
    let el = document.getElementById('mToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mToast';
      el.className = 'm-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  root.TTPlatform = { configureStorage, configureView, toast };
})(typeof window !== 'undefined' ? window : globalThis);
