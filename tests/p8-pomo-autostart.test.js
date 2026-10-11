'use strict';
// P8.3 番茄钟自动开始开关：load/savePomoCfg 持久化 + pomoTick 休息结束行为
const test = require('node:test');
const assert = require('node:assert');
const { loadApp, appEval, hostify } = require('./helpers');

function setCfg(sb, cfg) {
  appEval(sb, `localStorage.setItem('pomoCfg', '${JSON.stringify(cfg)}')`);
  appEval(sb, `loadPomoCfg()`);
}

test('loadPomoCfg：读取 autoStart 布尔值', () => {
  const { sb } = loadApp();
  setCfg(sb, { autoStart: true });
  assert.strictEqual(appEval(sb, 'POMO.autoStart'), true);
  setCfg(sb, { autoStart: false });
  assert.strictEqual(appEval(sb, 'POMO.autoStart'), false);
});

test('loadPomoCfg：旧版配置无 autoStart 时保持默认 false', () => {
  const { sb } = loadApp();
  setCfg(sb, { workMin: 25, breakMin: 5 });
  assert.strictEqual(appEval(sb, 'POMO.autoStart'), false);
});

test('savePomoCfg：持久化包含 autoStart 字段', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `POMO.autoStart = true; savePomoCfg()`);
  const cfg = JSON.parse(storage.getItem('pomoCfg'));
  assert.strictEqual(cfg.autoStart, true);
  assert.ok('workMin' in cfg && 'autoStart' in cfg, '原有字段仍保留');
});

test('pomoTick：休息结束 + autoStart=false → 停止（running=false，endAt=0）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    POMO.mode = 'break';
    POMO.running = true;
    POMO.autoStart = false;
    POMO.endAt = Date.now() - 1000;
    POMO.session = 1; POMO.isLong = false;
    pomoTick();
  `);
  assert.strictEqual(appEval(sb, 'POMO.mode'), 'work');
  assert.strictEqual(appEval(sb, 'POMO.running'), false);
  assert.strictEqual(appEval(sb, 'POMO.endAt'), 0);
});

test('pomoTick：休息结束 + autoStart=true → 自动开始下一个专注（running=true，endAt>0）', () => {
  const { sb } = loadApp();
  appEval(sb, `
    POMO.mode = 'break';
    POMO.running = true;
    POMO.autoStart = true;
    POMO.endAt = Date.now() - 1000;
    POMO.session = 1; POMO.isLong = false;
    pomoTick();
  `);
  assert.strictEqual(appEval(sb, 'POMO.mode'), 'work');
  assert.strictEqual(appEval(sb, 'POMO.running'), true, 'autoStart 时保持 running');
  assert.ok(appEval(sb, 'POMO.endAt > 0'), 'endAt 被设置为未来时间');
});

test('pomoTick：长休息结束 + autoStart=true → session 清零且自动开始', () => {
  const { sb } = loadApp();
  appEval(sb, `
    POMO.mode = 'break';
    POMO.running = true;
    POMO.autoStart = true;
    POMO.endAt = Date.now() - 1000;
    POMO.session = 4; POMO.isLong = true; POMO.cycle = 4;
    pomoTick();
  `);
  assert.strictEqual(appEval(sb, 'POMO.session'), 0, '长休息结束开启新一轮周期');
  assert.strictEqual(appEval(sb, 'POMO.isLong'), false);
  assert.strictEqual(appEval(sb, 'POMO.running'), true);
});
