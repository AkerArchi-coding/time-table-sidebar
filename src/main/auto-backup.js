'use strict';
// 自动备份（P7.2）纯逻辑模块：文件名生成 / 解析 / 保留裁剪。
// 只依赖 node 内置模块（不依赖 electron），主进程 IPC 与单元测试共用。
const AUTO_BACKUP_KEEP = 7;   // 固定保留最近 7 份

// 备份文件名：tt-auto-YYYYMMDD-HHmmss.json
function autoBackupName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `tt-auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

// 从文件名解析时间戳（毫秒；不符合命名规则返回 null）
function parseAutoBackupName(name) {
  const m = /^tt-auto-(\d{8})-(\d{6})\.json$/.exec(String(name || ''));
  if (!m) return null;
  const s = m[1], t = m[2];
  const y = Number(s.slice(0, 4)), mo = Number(s.slice(4, 6)), day = Number(s.slice(6, 8));
  const h = Number(t.slice(0, 2)), mi = Number(t.slice(2, 4)), sec = Number(t.slice(4, 6));
  const d = new Date(y, mo - 1, day, h, mi, sec);
  // JS Date 会把越界分量滚动到相邻周期（如 13 月 → 次年 1 月），需逐分量回验
  if (isNaN(d.getTime()) || d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day
    || d.getHours() !== h || d.getMinutes() !== mi || d.getSeconds() !== sec) return null;
  return d.getTime();
}

// 保留裁剪：按文件名时间倒序保留 keep 份，返回应删除的文件名数组（无法解析的文件不动）
function pickTrim(names, keep) {
  const k = Math.max(0, Number(keep) || 0);
  const items = (names || [])
    .map(n => ({ n, t: parseAutoBackupName(n) }))
    .filter(x => x.t !== null)
    .sort((a, b) => b.t - a.t);
  return items.slice(k).map(x => x.n);
}

module.exports = { AUTO_BACKUP_KEEP, autoBackupName, parseAutoBackupName, pickTrim };
