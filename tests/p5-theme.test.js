// ============ P4.1 单元测试：开机自启路径解析 + 外观主题（亮暗/强调色） ============
// 运行方式：npm test（node --test "tests/*.test.js"）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveLaunchExe } = require('../src/main/launch-path.js');
const { loadApp, appEval, hostify } = require('./helpers.js');

// ============ resolveLaunchExe（开机自启写入注册表的 exe 路径） ============

test('resolveLaunchExe：常规安装版直接取 process.execPath', () => {
  assert.strictEqual(
    resolveLaunchExe('C:\\Apps\\Timetable\\日程侧边栏.exe', {}),
    'C:\\Apps\\Timetable\\日程侧边栏.exe'
  );
});

test('resolveLaunchExe：便携版用 PORTABLE_EXECUTABLE_FILE 兜底真实 exe', () => {
  assert.strictEqual(
    resolveLaunchExe('C:\\Users\\x\\AppData\\Local\\Temp\\abc\\Timetable.exe', {
      PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\日程侧边栏-0.2.1-便携版.exe'
    }),
    'D:\\Tools\\日程侧边栏-0.2.1-便携版.exe'
  );
});

test('resolveLaunchExe：便携变量为目录（非 .exe）时忽略，回退 execPath', () => {
  assert.strictEqual(
    resolveLaunchExe('C:\\real\\app.exe', { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools' }),
    'C:\\real\\app.exe'
  );
});

test('resolveLaunchExe：便携变量带首尾空白时 trim 后仍可用', () => {
  assert.strictEqual(
    resolveLaunchExe('C:\\real\\app.exe', { PORTABLE_EXECUTABLE_FILE: '  D:\\x.exe  ' }),
    'D:\\x.exe'
  );
});

// ============ 外观主题：loadUiTheme / saveUiTheme / applyUiTheme ============

test('loadUiTheme：无存储时默认暗色 + 蓝色强调', () => {
  const { sb } = loadApp();
  assert.deepStrictEqual(hostify(appEval(sb, 'loadUiTheme()')), { mode: 'dark', accent: 'blue' });
});

test('loadUiTheme：合法存储读回；非法 mode/accent 值兜底为默认', () => {
  const { sb, storage } = loadApp();
  storage.setItem('uiTheme', JSON.stringify({ mode: 'light', accent: 'teal' }));
  assert.deepStrictEqual(hostify(appEval(sb, 'loadUiTheme()')), { mode: 'light', accent: 'teal' });
  storage.setItem('uiTheme', JSON.stringify({ mode: '高对比', accent: '彩虹' }));
  assert.deepStrictEqual(hostify(appEval(sb, 'loadUiTheme()')), { mode: 'dark', accent: 'blue' });
});

test('loadUiTheme：损坏 JSON 兜底默认', () => {
  const { sb, storage } = loadApp();
  storage.setItem('uiTheme', '{broken');
  assert.deepStrictEqual(hostify(appEval(sb, 'loadUiTheme()')), { mode: 'dark', accent: 'blue' });
});

test('saveUiTheme：部分补丁合并持久化，并触发 applyUiTheme 注入强调色变量', () => {
  const { sb, storage, doc } = loadApp();
  appEval(sb, `saveUiTheme({ mode: 'light', accent: 'purple' })`);
  const saved = JSON.parse(storage.getItem('uiTheme'));
  assert.deepStrictEqual(saved, { mode: 'light', accent: 'purple' });
  // applyUiTheme 效果：documentElement.style 记录到 --accent 三件套
  const sets = doc.documentElement.style._sets;
  assert.ok(sets['--accent'], '已注入 --accent');
  assert.ok(sets['--accent-rgb'], '已注入 --accent-rgb');
  assert.ok(sets['--accent-txt'], '已注入 --accent-txt');
});

test('ACCENT_PALETTE：5 个预设色，三字段齐全且互不相同', () => {
  const { sb } = loadApp();
  const palette = hostify(appEval(sb, 'ACCENT_PALETTE'));
  assert.strictEqual(palette.length, 5);
  const ids = new Set();
  for (const p of palette) {
    assert.ok(p.id && p.accent && p.accentRgb && p.light, `${p.id} 字段齐全`);
    ids.add(p.id);
  }
  assert.strictEqual(ids.size, 5, 'id 互不相同');
});

test('saveUiTheme：非法 accent 被兜底为 blue（防注入任意 CSS）', () => {
  const { sb, storage } = loadApp();
  appEval(sb, `saveUiTheme({ accent: 'not-exist' })`);
  assert.strictEqual(JSON.parse(storage.getItem('uiTheme')).accent, 'blue');
});
