// ============ 局域网同步：配对 + 同步服务（主进程专用） ============
// 设计要点（P3 方案）：
//   - 零依赖：Node 内置 http / dgram / crypto / os；
//   - 配对：A「等待配对」起临时 HTTP 服务 + UDP 广播应答 + 显示 6 位配对码（10 分钟一次性）；
//     B 发 UDP 发现 A 后输入配对码握手，双方各生成 32 字节 secret 并交换
//     （握手载荷用配对码 HKDF 派生密钥加密，防止局域网嗅探）；
//   - 同步：POST /sync/exchange 双向快照，Bearer + AES-256-GCM 加密载荷；
//     快照合并/墓碑逻辑在渲染层（mergeSyncData），主进程只做管道；
//   - secret 存 userData/sync-secrets.json（不进 localStorage/备份，避免备份泄露密钥）；
//   - 服务不常驻：配对/同步会话期间监听，空闲 5 分钟自动关闭（可被再次唤醒）。
'use strict';
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { genSecret, encrypt, decrypt, keyFromPairCode } = require('./sync-crypto');

const UDP_PORT = 47811;                    // 局域网发现端口（应用内约定）
const DISCOVER_MAGIC = 'TIMETABLE_DISCOVER_V1';
const ANNOUNCE_MAGIC = 'TIMETABLE_ANNOUNCE_V1';
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;   // 配对码 10 分钟有效
const IDLE_CLOSE_MS = 5 * 60 * 1000;       // 服务空闲自动关闭
const BODY_LIMIT = 8 * 1024 * 1024;        // 快照体积上限 8MB（防御性）

// ---------- 运行态（模块级单例；main.js 引用本模块即共享） ----------
let server = null;             // 当前 HTTP 服务（配对或同步共用同一端口逻辑：先开后用）
let serverMode = '';           // 'pair' | 'sync'
let idleTimer = null;
let udpSock = null;            // 等待配对时的广播应答 socket

// 配对会话（一次性）：A 侧持有
let pairSession = null;        // { code, expiresAt, mySecret, done:false|{peerSecret,peerDevice} }

// ---------- secret 持久化（userData/sync-secrets.json；设备 deviceId → secret） ----------
let secretsPathFn = null;      // 由 main.js 注入（避免本模块直接 require electron）
function init(secretsPathProvider) { secretsPathFn = secretsPathProvider; }

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(secretsPathFn(), 'utf8')); } catch { return {}; }
}
function saveSecret(deviceId, secret) {
  const all = loadSecrets();
  all[deviceId] = secret;
  try { fs.writeFileSync(secretsPathFn(), JSON.stringify(all, null, 1), 'utf8'); } catch { /* 写盘失败不影响本次会话 */ }
}
function getSecret(deviceId) { return loadSecrets()[deviceId] || null; }
// 解绑：真正移除密钥条目（不是置空）
function deleteSecret(deviceId) {
  const all = loadSecrets();
  if (deviceId in all) {
    delete all[deviceId];
    try { fs.writeFileSync(secretsPathFn(), JSON.stringify(all, null, 1), 'utf8'); } catch { /* 写盘失败下次启动再清 */ }
  }
}

// ---------- 本机局域网 IPv4 列表（手动配对兜底展示） ----------
function lanAddrs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

// ---------- HTTP 工具 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('载荷过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

// 空闲计时：每次请求后重置，超时自动关停（配对会话独立用 code 过期控制）
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stopServer(); }, IDLE_CLOSE_MS);
}

// ---------- 服务开关 ----------
function stopServer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (udpSock) { try { udpSock.close(); } catch { /* 已关 */ } udpSock = null; }
  if (server) { try { server.close(); } catch { /* 已关 */ } server = null; }
  serverMode = '';
  if (pairSession) pairSession = null;
}

// UDP 应答 socket：配对等待态与同步服务态共用（收到 DISCOVER → 回 ANNOUNCE{device, port, mode}）
function bindUdpAnnounce(myDevice, getPort) {
  if (udpSock) { try { udpSock.close(); } catch { /* 已关 */ } udpSock = null; }
  try {
    udpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSock.on('message', (msg, rinfo) => {
      if (String(msg) !== DISCOVER_MAGIC) return;
      const port = getPort();
      if (!port) return;
      const reply = Buffer.from(JSON.stringify({
        magic: ANNOUNCE_MAGIC, device: myDevice, port, mode: serverMode
      }));
      udpSock.send(reply, rinfo.port, rinfo.address, () => {});
    });
    udpSock.on('error', () => { /* 广播失败不阻塞手动连接 */ });
    udpSock.bind(UDP_PORT);
  } catch { /* UDP 不可用时仍支持手动 IP */ }
}

// ============ 配对：A 侧「等待配对」 ============
// 起服务 + UDP 应答 + 生成 6 位码；返回 { port, code, ips, expiresAt }
// onPaired(peer) 回调：配对成功后由 main.js 通知渲染层
function startPairWait(myDevice, onPaired) {
  return new Promise((resolve, reject) => {
    stopServer();
    const code = String(Math.floor(100000 + Math.random() * 900000));   // 6 位
    pairSession = {
      code,
      expiresAt: Date.now() + PAIR_CODE_TTL_MS,
      mySecret: genSecret(),
      done: null
    };
    serverMode = 'pair';
    server = http.createServer((req, res) => handlePairRequest(req, res, myDevice, onPaired));
    server.on('error', (err) => { stopServer(); reject(err); });
    server.listen(0, () => {   // 随机端口
      const port = server.address().port;
      bindUdpAnnounce(myDevice, () => port);
      touchIdle();
      resolve({ ok: true, port, code, ips: lanAddrs(), expiresAt: pairSession.expiresAt });
    });
  });
}

// A 侧配对请求处理：B 发来握手（配对码 + B 的 secret + B 设备信息，用码派生密钥加密）
async function handlePairRequest(req, res, myDevice, onPaired) {
  touchIdle();
  if (req.method !== 'POST' || req.url !== '/pair') {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  if (!pairSession || pairSession.done) { sendJson(res, 409, { ok: false, error: 'pair_session_invalid' }); return; }
  if (Date.now() > pairSession.expiresAt) { sendJson(res, 410, { ok: false, error: 'pair_code_expired' }); return; }
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);
    if (!payload.code || payload.code !== pairSession.code) {
      sendJson(res, 403, { ok: false, error: 'pair_code_wrong' });
      return;
    }
    // 码正确：用码派生密钥解出 B 的 secret 与设备信息
    const key = keyFromPairCode(payload.code);
    const peer = decrypt(key.toString('hex'), payload.blob);
    if (!peer || !peer.secret || !peer.device || !peer.device.deviceId) {
      sendJson(res, 400, { ok: false, error: 'pair_payload_bad' });
      return;
    }
    // 双方持久化对方 secret；会话标记完成（一次性）
    saveSecret(peer.device.deviceId, peer.secret);
    saveSecret(myDevice.deviceId, pairSession.mySecret);
    pairSession.done = { peerSecret: peer.secret, peerDevice: peer.device };
    // 回包：A 的 secret + A 设备信息（同密钥加密）
    const replyBlob = encrypt(key.toString('hex'), { secret: pairSession.mySecret, device: myDevice });
    sendJson(res, 200, { ok: true, blob: replyBlob });
    try { onPaired && onPaired({ peerDevice: peer.device }); } catch { /* 回调异常不影响握手 */ }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'pair_failed:' + String((e && e.message) || e) });
  }
}

// ============ 配对：B 侧「配对新设备」 ============
// 1) UDP 广播发现等待中的设备（800ms 收集）；2) 输入码后 POST /pair 握手
function scanPairingDevices(timeoutMs = 900) {
  return new Promise((resolve) => {
    const found = new Map();   // deviceId → {device, ip, port}
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch { resolve([]); return; }
    const timer = setTimeout(() => {
      try { sock.close(); } catch { /* 已关 */ }
      resolve(Array.from(found.values()));
    }, timeoutMs);
    sock.on('message', (msg, rinfo) => {
      try {
        const o = JSON.parse(String(msg));
        if (o.magic === ANNOUNCE_MAGIC && o.device && o.device.deviceId && o.port) {
          found.set(o.device.deviceId, { device: o.device, ip: rinfo.address, port: o.port });
        }
      } catch { /* 非本协议广播 */ }
    });
    sock.on('error', () => { clearTimeout(timer); try { sock.close(); } catch { /* 已关 */ } resolve([]); });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* 某些网卡不允许广播，仍走手动 */ }
      sock.send(DISCOVER_MAGIC, UDP_PORT, '255.255.255.255', () => {});
      // 同机双实例沙箱：广播可能回环不到，补发 127.0.0.1
      sock.send(DISCOVER_MAGIC, UDP_PORT, '127.0.0.1', () => {});
    });
  });
}

// B 侧握手：向 A 的 ip:port 发送配对码 + B 的 secret/设备信息 → 拿到 A 的 secret
function pairConnect(ip, port, code, myDevice) {
  return new Promise((resolve) => {
    const mySecret = genSecret();
    const key = keyFromPairCode(code);
    const blob = encrypt(key.toString('hex'), { secret: mySecret, device: myDevice });
    const body = JSON.stringify({ code: String(code), blob });
    const req = http.request({
      host: ip, port, path: '/pair', method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      readBody(res).then((text) => {
        let out;
        try { out = JSON.parse(text); } catch { out = null; }
        if (res.statusCode !== 200 || !out || !out.ok) {
          resolve({ ok: false, error: (out && out.error) || ('HTTP ' + res.statusCode) });
          return;
        }
        try {
          const peer = decrypt(key.toString('hex'), out.blob);
          if (!peer || !peer.secret || !peer.device) { resolve({ ok: false, error: 'pair_reply_bad' }); return; }
          // 双方持久化对方 secret
          saveSecret(peer.device.deviceId, peer.secret);
          saveSecret(myDevice.deviceId, mySecret);
          resolve({ ok: true, peerDevice: peer.device });
        } catch (e) {
          resolve({ ok: false, error: 'pair_decrypt_failed:' + String((e && e.message) || e) });
        }
      }, () => resolve({ ok: false, error: 'pair_read_failed' }));
    });
    req.on('error', (e) => resolve({ ok: false, error: 'connect_failed:' + String((e && e.message) || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'connect_timeout' }); });
    req.write(body);
    req.end();
  });
}

// ============ 同步：服务侧（被对端连接的一方） ============
// 监听期间接受 /hello /sync/exchange；合并结果经 onExchange 回调交给渲染层处理后再回包
// onExchange(peerDeviceId, remoteSnapshot) → Promise<localSnapshot>
function startSyncServer(myDevice, onHello, onExchange) {
  return new Promise((resolve, reject) => {
    // 若已有同步服务在跑，直接复用端口
    if (server && serverMode === 'sync') {
      resolve({ ok: true, port: server.address().port, ips: lanAddrs() });
      return;
    }
    stopServer();
    serverMode = 'sync';
    server = http.createServer((req, res) => handleSyncRequest(req, res, myDevice, onHello, onExchange));
    server.on('error', (err) => { stopServer(); reject(err); });
    server.listen(0, () => {
      bindUdpAnnounce(myDevice, () => server ? server.address().port : 0);
      touchIdle();
      resolve({ ok: true, port: server.address().port, ips: lanAddrs() });
    });
  });
}

async function handleSyncRequest(req, res, myDevice, onHello, onExchange) {
  touchIdle();
  if (req.method !== 'POST') { sendJson(res, 404, { ok: false, error: 'not_found' }); return; }
  // Bearer = deviceId（握手时已交换 secret，deviceId 非秘密，仅路由密钥用）
  const auth = String(req.headers.authorization || '');
  const peerId = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const secret = peerId ? getSecret(peerId) : null;
  if (!secret) { sendJson(res, 401, { ok: false, error: 'unknown_peer' }); return; }
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);
    const data = decrypt(secret, payload.blob);   // 密钥错误或篡改 → 抛错
    if (req.url === '/hello') {
      const r = onHello ? await onHello(peerId, data) : null;
      sendJson(res, 200, { ok: true, blob: encrypt(secret, { device: myDevice, extra: r || null }) });
      return;
    }
    if (req.url === '/sync/exchange') {
      const mySnapshot = onExchange ? await onExchange(peerId, data) : {};
      sendJson(res, 200, { ok: true, blob: encrypt(secret, mySnapshot) });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    // 解密失败按 403 处理（密钥不匹配/载荷被改）
    sendJson(res, 403, { ok: false, error: 'decrypt_or_handle_failed:' + String((e && e.message) || e) });
  }
}

// ============ 同步：客户端侧（发起方） ============
function postEncrypted(ip, port, pathName, peerDeviceId, obj, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const secret = getSecret(peerDeviceId);
    if (!secret) { resolve({ ok: false, error: 'no_secret_for_peer' }); return; }
    const body = JSON.stringify({ blob: encrypt(secret, obj) });
    const req = http.request({
      host: ip, port, path: pathName, method: 'POST', timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + peerDeviceId
      }
    }, (res) => {
      readBody(res).then((text) => {
        let out;
        try { out = JSON.parse(text); } catch { out = null; }
        if (res.statusCode !== 200 || !out || !out.ok) {
          resolve({ ok: false, error: (out && out.error) || ('HTTP ' + res.statusCode) });
          return;
        }
        try { resolve({ ok: true, data: decrypt(secret, out.blob) }); }
        catch (e) { resolve({ ok: false, error: 'reply_decrypt_failed:' + String((e && e.message) || e) }); }
      }, () => resolve({ ok: false, error: 'read_failed' }));
    });
    req.on('error', (e) => resolve({ ok: false, error: 'connect_failed:' + String((e && e.message) || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'connect_timeout' }); });
    req.write(body);
    req.end();
  });
}

function serverStatus() {
  return {
    running: !!server,
    mode: serverMode,
    port: server ? server.address().port : 0,
    ips: lanAddrs(),
    pairWaiting: !!(pairSession && !pairSession.done),
    pairCode: (pairSession && !pairSession.done && Date.now() <= pairSession.expiresAt) ? pairSession.code : '',
    pairExpiresAt: pairSession ? pairSession.expiresAt : 0
  };
}

module.exports = {
  init,
  startPairWait, scanPairingDevices, pairConnect,
  startSyncServer, postEncrypted,
  stopServer, serverStatus,
  getSecret, saveSecret, deleteSecret, lanAddrs
};
