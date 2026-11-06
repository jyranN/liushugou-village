/**
 * 在当前调试页执行一段脚本并截图：node tools/eval-shot.mjs "js表达式" /tmp/out.png [等待秒]
 */
const expr = process.argv[2] || '1';
const OUT = process.argv[3] || '/tmp/eval-shot.png';
const WAIT = Number(process.argv[4] || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有页面');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', async (e) => {
  const raw = typeof e.data === 'string' ? e.data : await e.data.text();
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  const timer = setTimeout(() => reject(new Error('timeout ' + method)), 180000);
  pending.set(mid, (m) => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await send('Page.enable');
await send('Page.bringToFront');
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Runtime.enable');
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.exceptionDetails) console.log('异常', JSON.stringify(r.exceptionDetails));
else console.log('结果', JSON.stringify(r.result?.value));
await sleep(WAIT * 1000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs/promises');
await fs.writeFile(OUT, Buffer.from(shot.data, 'base64'));
console.log('已保存', OUT);
ws.close();
