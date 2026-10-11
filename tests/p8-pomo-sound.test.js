'use strict';
// P8.4 番茄钟音效开关：load/savePomoCfg 持久化 + playChime 守卫
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval } = require('./helpers');

function setCfg(sb, cfg) {
  appEval(sb, `localStorage.setItem('pomoCfg', '${JSON.stringify(cfg)}')`);
  appEval(sb, `loadPomoCfg()`);
}

test('loadPomoCfg：读取 soundEnabled 布尔值', () => {
  const { sb } = loadApp();
  setCfg(sb, { soundEnabled: false });
  assert.strictEqual(appEval(sb, 'POMO.soundEnabled'), false);
  setCfg(sb, { soundEnabled: true });
  assert.strictEqual(appEval(sb, 'POMO.soundEnabled'), true);
});

test('loadPomoCfg：旧版配置无 soundEnabled 时保持默认 true', () => {
  const { sb } = loadApp();
  setCfg(sb, { workMin: 25 });
  assert.strictEqual(appEval(sb, 'POMO.soundEnabled'), true, '默认开启音效');
});

test('savePomoCfg：持久化包含 soundEnabled 字段', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `POMO.soundEnabled = false; savePomoCfg()`);
  const cfg = JSON.parse(storage.getItem('pomoCfg'));
  assert.strictEqual(cfg.soundEnabled, false);
});

test('playChime：soundEnabled=false 时 CHIME.ding 被守卫拦截（不创建 audioCtx）', () => {
  const { sb } = loadApp();
  appEval(sb, `audioCtx = null; POMO.soundEnabled = false; playChime(CHIME.ding)`);
  assert.strictEqual(appEval(sb, 'audioCtx'), null, 'ding 音效被拦截，audioCtx 未创建');
});

test('playChime：soundEnabled=true 时 CHIME.ding 正常播放', () => {
  const { sb } = loadApp();
  appEval(sb, `audioCtx = null; POMO.soundEnabled = true; playChime(CHIME.ding)`);
  assert.notStrictEqual(appEval(sb, 'audioCtx'), null, 'ding 音效正常播放，audioCtx 已创建');
});

test('playChime：soundEnabled=false 不影响 CHIME.remind（事项到点提醒仍播放）', () => {
  const { sb } = loadApp();
  appEval(sb, `audioCtx = null; POMO.soundEnabled = false; playChime(CHIME.remind)`);
  assert.notStrictEqual(appEval(sb, 'audioCtx'), null, 'remind 音效不受番茄钟开关影响');
});
