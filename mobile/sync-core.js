// 同步脚本：把 src/core/*.js 原样拷贝到 mobile/www/core/
// src/core 是唯一事实源；www/core 为生成产物，禁止手改。
// 用法：node sync-core.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'core');
const DST = path.join(__dirname, 'www', 'core');

fs.mkdirSync(DST, { recursive: true });

// 目标目录多余文件（src 已删除的）一并清理，保持镜像一致
const srcFiles = new Set(fs.readdirSync(SRC).filter(f => f.endsWith('.js')));
for (const f of fs.readdirSync(DST)) {
  if (!srcFiles.has(f)) {
    fs.unlinkSync(path.join(DST, f));
    console.log('removed:', f);
  }
}
let copied = 0;
for (const f of srcFiles) {
  const s = path.join(SRC, f);
  const d = path.join(DST, f);
  const sBuf = fs.readFileSync(s);
  if (!fs.existsSync(d) || !fs.readFileSync(d).equals(sBuf)) {
    fs.writeFileSync(d, sBuf);
    copied++;
    console.log('synced :', f);
  }
}
console.log(`done. ${srcFiles.size} core files, ${copied} updated.`);
