/**
 * 慢速渲染环境截图：node tools/shot.mjs <query> <output> [等待秒数]
 * 例：node tools/shot.mjs "?day=90&hour=10" /tmp/shot.png 30
 */

const Q = process.argv[2] || '';
const OUT = process.argv[3] || '/tmp/shot.png';
const WAIT = Number(process.argv[4] || 30);
const PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 不可用');
}

async function toText(d) {
  if (typeof d === 'string') return d;
  if (d instanceof Blob) return await d.text();
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf8');
  return String(d);
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', async (e) => {
    let raw;
    try { raw = await toText(e.data); } catch { return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return (method, params = {}, timeoutMs = 180000) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error(`CDP 超时: ${method}`));
    }, timeoutMs);
    pending.set(mid, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const send = rpc(ws);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

const url = `http://localhost:8099/index.html${Q}`;
await send('Page.navigate', { url });
await send('Page.bringToFront');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await sleep(WAIT * 1000);

const ready = await send('Runtime.evaluate', { expression: '!!window.__app', returnByValue: true }, 150000);
if (!ready.result.value) {
  console.log('页面未就绪，再等 40s');
  await sleep(40000);
}

const r = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs/promises');
await fs.writeFile(OUT, Buffer.from(r.data, 'base64'));
console.log('已保存', OUT);
ws.close();
