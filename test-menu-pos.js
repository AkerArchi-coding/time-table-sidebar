const WebSocket = require('ws');
async function main() {
  const resp = await fetch('http://localhost:9225/json');
  const pages = await resp.json();
  const page = pages.find(p => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { ws.off('message', handler); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  ws.on('open', async () => {
    await evalJs(`document.getElementById('sidebar').classList.add('expanded')`);
    // 在 (200, 150) 处弹出菜单，检查位置是否等于鼠标坐标（或被边缘钳制）
    const r1 = await evalJs(`(function(){
      showBlankMenu(200, 150, '2026-09-12');
      var rect = document.getElementById('ctxMenu').getBoundingClientRect();
      return JSON.stringify({left: rect.left, top: rect.top, expectLeft: 200, expectTop: 150});
    })()`);
    console.log('菜单定位测试:', r1);
    // 边缘钳制：靠近右下角
    const r2 = await evalJs(`(function(){
      hideCtxMenu();
      showBlankMenu(9999, 9999, '2026-09-12');
      var rect = document.getElementById('ctxMenu').getBoundingClientRect();
      return JSON.stringify({left: Math.round(rect.left), top: Math.round(rect.top), winW: window.innerWidth, winH: window.innerHeight});
    })()`);
    console.log('边缘钳制测试:', r2);
    // 面板切换后保持位置
    const r3 = await evalJs(`(function(){
      hideCtxMenu();
      showBlankMenu(200, 150, '2026-09-12');
      openDatePicker('test', '2026-09-12', function(){});
      var rect = document.getElementById('ctxMenu').getBoundingClientRect();
      return JSON.stringify({left: Math.round(rect.left), top: Math.round(rect.top)});
    })()`);
    console.log('面板切换保持位置:', r3);
    await evalJs(`hideCtxMenu()`);
    console.log('完成');
    ws.close();
    process.exit(0);
  });
  ws.on('error', (e) => { console.error(e.message); process.exit(1); });
}
main().catch(e => { console.error(e); process.exit(1); });
