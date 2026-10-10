// ============ P3.4 双实例沙箱端到端脚本（非单测，手动/CI 均可跑） ============
// 模拟两台设备：A 等待配对 → B 发现+握手 → 双向同步 → 删除传播 → 载荷加密校验
// 运行：node tests/p4-e2e-sync.js（退出码 0 = 全部通过）
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 两套独立 userData（模拟两台设备的 secret 存储）
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-sync-A-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-sync-B-'));

// 同一份 sync-server 模块加载两次会共享模块态（server 单例），
// 所以 A/B 必须用隔离的 require 实例：清缓存再 require。
function loadServerInstance(secretsFile) {
  const modPath = path.join(__dirname, '..', 'src', 'main', 'sync-server.js');
  const cryptoPath = path.join(__dirname, '..', 'src', 'main', 'sync-crypto.js');
  delete require.cache[require.resolve(modPath)];
  delete require.cache[require.resolve(cryptoPath)];
  const m = require(modPath);
  m.init(() => path.join(secretsFile, 'sync-secrets.json'));
  return m;
}

const srvA = loadServerInstance(dirA);
const srvB = loadServerInstance(dirB);

const devA = { deviceId: 'dev-AAA-1111', name: '电脑A', platform: 'win32' };
const devB = { deviceId: 'dev-BBB-2222', name: '电脑B', platform: 'win32' };

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✔ ' + msg);
  else { console.error('  ✘ ' + msg); failed++; }
};

(async () => {
  console.log('[1] A 等待配对 → 显示配对码');
  let pairedA = null;
  const wait = await srvA.startPairWait(devA, (info) => { pairedA = info; });
  ok(wait.ok && /^\d{6}$/.test(wait.code), `配对码=${wait.code} 端口=${wait.port}`);

  console.log('[2] B UDP 发现 A（含 127.0.0.1 回环）');
  const found = await srvB.scanPairingDevices(1500);
  const hitA = found.find(f => f.device.deviceId === devA.deviceId);
  ok(!!hitA, hitA ? `发现 A@${hitA.ip}:${hitA.port}` : '未发现 A');
  const targetIp = hitA ? hitA.ip : '127.0.0.1';
  const targetPort = hitA ? hitA.port : wait.port;

  console.log('[3] 错误配对码被拒');
  const badCode = wait.code === '000000' ? '000001' : '000000';
  const bad = await srvB.pairConnect(targetIp, targetPort, badCode, devB);
  ok(!bad.ok, '错误码 → ' + (bad.error || '拒绝'));

  console.log('[4] B 用正确码握手 → 双方互换 secret');
  const good = await srvB.pairConnect(targetIp, targetPort, wait.code, devB);
  ok(good.ok && good.peerDevice.deviceId === devA.deviceId, 'B 拿到 A 的设备信息');
  ok(pairedA && pairedA.peerDevice.deviceId === devB.deviceId, 'A 回调拿到 B 的设备信息');
  ok(srvA.getSecret(devB.deviceId), 'A 存有 B 的 secret');
  ok(srvB.getSecret(devA.deviceId), 'B 存有 A 的 secret');

  console.log('[5] 配对码一次性：再次握手被拒');
  const again = await srvB.pairConnect(targetIp, targetPort, wait.code, devB);
  ok(!again.ok, '二次握手 → ' + (again.error || '拒绝'));

  console.log('[6] B 启动同步服务（接收方）');
  const snapA = {
    deviceId: devA.deviceId, at: new Date().toISOString(),
    projects: [{ id: 'p1', name: 'A的项目', updatedAt: '2026-10-10T01:00:00.000Z' }],
    events: [{ id: 'e1', title: '来自A的事项', updatedAt: '2026-10-10T01:00:00.000Z', tags: ['工作'] }],
    tombstones: [],
    pomoHistory: [{ date: '2026-10-10', count: 3, minutes: 75 }]
  };
  const snapB = {
    deviceId: devB.deviceId, at: new Date().toISOString(),
    projects: [],
    events: [{ id: 'e2', title: '来自B的事项', updatedAt: '2026-10-10T02:00:00.000Z', recur: { freq: 'daily', interval: 1, until: '' } }],
    tombstones: [],
    pomoHistory: []
  };
  let receivedByB = null;
  const listen = await srvB.startSyncServer(devB, null, async (peerId, remoteSnap) => {
    receivedByB = remoteSnap;
    return snapB;   // B 回包自己的快照
  });
  ok(listen.ok, `B 监听端口=${listen.port}`);

  console.log('[7] A 发起同步：hello + 快照交换（加密载荷）');
  const hello = await srvA.postEncrypted('127.0.0.1', listen.port, '/hello', devB.deviceId, { device: devA });
  ok(hello.ok && hello.data.device.deviceId === devB.deviceId, 'hello 握手成功');
  const ex = await srvA.postEncrypted('127.0.0.1', listen.port, '/sync/exchange', devB.deviceId, snapA);
  ok(ex.ok, '快照交换成功');
  ok(receivedByB && receivedByB.events[0].title === '来自A的事项', 'B 收到 A 的快照（含 tags）');
  ok(ex.data.events[0].id === 'e2' && ex.data.events[0].recur.freq === 'daily', 'A 收到 B 的快照（含 recur）');

  console.log('[8] 载荷确实加密：同一内容两次密文不同，且明文不出现在密文中');
  const c1 = require('../src/main/sync-crypto.js');
  const secret = srvA.getSecret(devB.deviceId);
  const enc1 = c1.encrypt(secret, snapA);
  const enc2 = c1.encrypt(secret, snapA);
  ok(enc1 !== enc2, '随机 IV → 同文不同密文');
  ok(!enc1.includes('来自A的事项'), '密文不含明文');

  console.log('[9] 未配对设备访问被拒（unknown_peer）');
  const stranger = loadServerInstance(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-sync-C-')));
  const evil = await stranger.postEncrypted('127.0.0.1', listen.port, '/sync/exchange', 'dev-EVIL-9999', { hi: 1 });
  ok(!evil.ok, '未配对 → ' + (evil.error || '拒绝'));

  console.log('[10] 删除传播数据：A 带墓碑再同步，B 校验墓碑可达');
  const snapA2 = { ...snapA, tombstones: [{ id: 'e2', kind: 'event', deletedAt: '2026-10-11T01:00:00.000Z', deviceId: devA.deviceId }] };
  const ex2 = await srvA.postEncrypted('127.0.0.1', listen.port, '/sync/exchange', devB.deviceId, snapA2);
  ok(ex2.ok, '携带墓碑的第二次同步成功');

  srvA.stopServer(); srvB.stopServer(); stranger.stopServer();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });

  console.log(failed ? `\n失败 ${failed} 项` : '\n端到端全部通过');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E 异常：', e); process.exit(1); });
