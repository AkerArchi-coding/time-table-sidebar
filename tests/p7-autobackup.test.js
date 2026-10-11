'use strict';
// P7.2 自动备份：主进程纯逻辑（文件名/解析/裁剪）+ 渲染层调度（间隔判定/写入流程）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, appEval, hostify } = require('./helpers');

// 主进程纯逻辑模块直接 require（无 electron 依赖）
const ab = require('../src/main/auto-backup');

test('autoBackupName：生成 tt-auto-YYYYMMDD-HHmmss.json 格式', () => {
  const d = new Date(2026, 9, 11, 8, 5, 3);   // 2026-10-11 08:05:03 本地时间
  assert.strictEqual(ab.autoBackupName(d), 'tt-auto-20261011-080503.json');
  const d2 = new Date(2026, 0, 2, 23, 59, 59);
  assert.strictEqual(ab.autoBackupName(d2), 'tt-auto-20260102-235959.json');
});

test('parseAutoBackupName：合法名解析回时间戳，非法名返回 null', () => {
  assert.strictEqual(ab.parseAutoBackupName('tt-auto-20261011-080503.json'),
    new Date(2026, 9, 11, 8, 5, 3).getTime());
  assert.strictEqual(ab.parseAutoBackupName('tt-auto-20261311-080503.json'), null, '月份越界拒绝');
  assert.strictEqual(ab.parseAutoBackupName('random.json'), null);
  assert.strictEqual(ab.parseAutoBackupName(''), null);
  assert.strictEqual(ab.parseAutoBackupName(null), null);
  assert.strictEqual(ab.parseAutoBackupName('../evil.json'), null, '路径穿越形态拒绝');
});

test('pickTrim：按时间倒序保留 keep 份，返回应删除的最旧文件', () => {
  const names = [
    'tt-auto-20261010-090000.json',
    'tt-auto-20261011-090000.json',
    'tt-auto-20261009-090000.json',
    'tt-auto-20261012-090000.json'
  ];
  // 保留 2 份 → 删除最旧 2 份（20261009、20261010）
  const trimmed = ab.pickTrim(names, 2);
  assert.deepStrictEqual(trimmed.sort(), ['tt-auto-20261009-090000.json', 'tt-auto-20261010-090000.json']);
  // 保留数足够 → 不删
  assert.deepStrictEqual(ab.pickTrim(names, 10), []);
  assert.deepStrictEqual(ab.pickTrim(names, 4), []);
  // 无法解析的文件不参与裁剪（也不被删除）
  assert.deepStrictEqual(ab.pickTrim(['random.txt', ...names], 3), ['tt-auto-20261009-090000.json']);
  // keep=0 → 全删
  assert.strictEqual(ab.pickTrim(names, 0).length, 4);
});

test('loadAppSettings：自动备份默认开、lastAutoBackupAt 默认 0，已有设置覆盖默认', () => {
  const { sb } = loadApp();
  const s1 = hostify(appEval(sb, 'loadAppSettings()'));
  assert.strictEqual(s1.autoBackupEnabled, true);
  assert.strictEqual(s1.lastAutoBackupAt, 0);
  appEval(sb, `saveAppSettings({ autoBackupEnabled: false, lastAutoBackupAt: 12345 })`);
  const s2 = hostify(appEval(sb, 'loadAppSettings()'));
  assert.strictEqual(s2.autoBackupEnabled, false);
  assert.strictEqual(s2.lastAutoBackupAt, 12345);
});

test('autoBackupDue：从未备份立即执行；20h 内不执行；超 20h 执行', () => {
  const { sb } = loadApp();
  const hour = 60 * 60 * 1000;
  assert.strictEqual(appEval(sb, 'autoBackupDue(0, 1000000)'), true, '从未备份 → 执行');
  assert.strictEqual(appEval(sb, `autoBackupDue(1000000, ${1000000 + 19 * hour})`), false, '19h → 不执行');
  assert.strictEqual(appEval(sb, `autoBackupDue(1000000, ${1000000 + 20 * hour})`), true, '满 20h → 执行');
});

test('runAutoBackup：组装全量备份并写入，成功后记录 lastAutoBackupAt', async () => {
  const { sb } = loadApp();
  // 注入 Backup 桩 + 主进程 IPC 桩
  appEval(sb, `
    window.Backup = { buildBackup: (type, mainFiles, appVer) => ({ kind: 'tt-backup', type, mainFiles, appVer }) };
    window.timetable = {
      backupGetMainFiles: async () => ({ sidebarUi: '{"side":"left"}' }),
      appVersion: async () => '1.2.3',
      backupAutoWrite: async (content) => {
        window.__written = content;
        return { ok: true, name: 'tt-auto-20261011-080503.json' };
      }
    };
  `);
  const ok = await appEval(sb, 'runAutoBackup()');
  assert.strictEqual(ok, true);
  const written = JSON.parse(appEval(sb, 'window.__written'));
  assert.strictEqual(written.kind, 'tt-backup');
  assert.strictEqual(written.type, 'full');
  assert.deepStrictEqual(written.mainFiles, { sidebarUi: '{"side":"left"}' });
  assert.strictEqual(written.appVer, '1.2.3');
  const s = hostify(appEval(sb, 'loadAppSettings()'));
  assert.ok(s.lastAutoBackupAt > 0, '成功后记录时间戳');
});

test('runAutoBackup：主进程写入失败返回 false，不记录时间戳', async () => {
  const { sb } = loadApp();
  appEval(sb, `
    window.Backup = { buildBackup: () => ({ kind: 'tt-backup', type: 'full' }) };
    window.timetable = { backupAutoWrite: async () => ({ ok: false, error: 'disk full' }) };
  `);
  assert.strictEqual(await appEval(sb, 'runAutoBackup()'), false);
  assert.strictEqual(hostify(appEval(sb, 'loadAppSettings()')).lastAutoBackupAt, 0);
});

test('runAutoBackup：无主进程/无 Backup 桩时安全返回 false', async () => {
  const { sb } = loadApp();
  assert.strictEqual(await appEval(sb, 'runAutoBackup()'), false);
});

test('maybeAutoBackup：开关关闭或未到间隔时跳过写入', async () => {
  const { sb } = loadApp();
  appEval(sb, `
    window.Backup = { buildBackup: () => ({ kind: 'tt-backup', type: 'full' }) };
    window.timetable = { backupAutoWrite: async () => { window.__called = (window.__called || 0) + 1; return { ok: true }; } };
  `);
  // 开关关闭 → 不调用
  appEval(sb, `saveAppSettings({ autoBackupEnabled: false })`);
  await appEval(sb, 'maybeAutoBackup()');
  assert.strictEqual(appEval(sb, 'window.__called || 0'), 0);
  // 开关开启 + 刚备份过（未到 20h）→ 不调用
  appEval(sb, `saveAppSettings({ autoBackupEnabled: true, lastAutoBackupAt: ${Date.now() - 3600000} })`);
  await appEval(sb, 'maybeAutoBackup()');
  assert.strictEqual(appEval(sb, 'window.__called || 0'), 0);
  // 开关开启 + 从未备份 → 调用一次
  appEval(sb, `saveAppSettings({ autoBackupEnabled: true, lastAutoBackupAt: 0 })`);
  await appEval(sb, 'maybeAutoBackup()');
  assert.strictEqual(appEval(sb, 'window.__called'), 1);
});
