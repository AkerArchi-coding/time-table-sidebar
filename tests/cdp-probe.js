const ws = require('ws');
const target = process.argv[2];
const expr = process.argv[3] || 'null';
const sock = new ws.WebSocket(target);
let id = 0;
const pending = new Map();
function call(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    sock.send(JSON.stringify({ id: msgId, method, params }));
  });
}
sock.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});
sock.on('open', async () => {
  try {
    await call('Runtime.enable');
    await call('Log.enable');
    const r = await call('Runtime.evaluate', { expression: `(async()=>{try{${expr}}catch(e){return 'EXC:'+e.message+'\\n'+(e.stack||'');}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.error('EVAL_ERROR:', JSON.stringify(r.exceptionDetails));
    else { const v = r.result.value; console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }
  } catch (e) { console.error('ERR:', e.message); }
  finally { sock.close(); process.exit(0); }
});
sock.on('error', (e) => { console.error('WS_ERR:', e.message); process.exit(1); });
