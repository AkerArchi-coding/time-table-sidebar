// ============ 局域网同步加解密（AES-256-GCM，Node 内置 crypto，零依赖） ============
// 载荷格式：iv(12B) + authTag(16B) + 密文，整体 base64 后作为 HTTP body 传输。
// 密钥：配对握手时双方交换的 32 字节 secret（本模块只接受 Buffer/hex，不管理存储）。
'use strict';
const crypto = require('crypto');

const IV_LEN = 12;    // GCM 推荐 96 位随机 IV
const TAG_LEN = 16;   // 认证标签 128 位
const KEY_LEN = 32;   // AES-256

// 生成 32 字节随机 secret（hex 字符串，64 字符）——配对握手时双方各生成一份交换
function genSecret() {
  return crypto.randomBytes(KEY_LEN).toString('hex');
}

// 内部统一密钥形态：hex 字符串或 Buffer → Buffer；长度不对直接抛错（避免静默弱密钥）
function normKey(secret) {
  const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'hex');
  if (buf.length !== KEY_LEN) throw new Error('同步密钥长度错误（应为 32 字节）');
  return buf;
}

// 加密：任意可 JSON 化对象 → base64 字符串（自包含 iv+tag，传输即一个字段）
function encrypt(secret, obj) {
  const key = normKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// 解密：base64 字符串 → 原对象；密钥错误/数据被篡改 → 抛错（GCM 认证失败）
function decrypt(secret, b64) {
  const key = normKey(secret);
  const raw = Buffer.from(String(b64 || ''), 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new Error('同步载荷长度异常');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// 配对码 → 临时加密密钥（HKDF-SHA256）：配对阶段 secret 尚未交换，
// 用双方共同持有的 6 位配对码派生一次性密钥保护握手载荷。
// 加盐固定常量即可（握手仅一次、码一次性，10 分钟过期，穷举空间受速率限制）。
function keyFromPairCode(code) {
  // hkdfSync 返回 ArrayBuffer，统一包装成 Buffer 供 normKey 使用
  return Buffer.from(crypto.hkdfSync('sha256', String(code), 'timetable-pair-v1', 'pair-channel', KEY_LEN));
}

module.exports = { genSecret, encrypt, decrypt, keyFromPairCode, KEY_LEN };
