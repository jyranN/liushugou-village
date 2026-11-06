/** 在已打开的调试页上执行表达式：node tools/probe.mjs "expr" */
const PORT = 9222;
const expr = process.argv[2] || '1';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('没有页面');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const out = await new Promise((resolve, reject) => {
  const id = 1;
  const timer = setTimeout(() => reject(new Error('timeout')), 30000);
  ws.addEventListener('message', async (e) => {
    const raw = typeof e.data === 'string' ? e.data : await e.data.text();
    const m = JSON.parse(raw);
    if (m.id === id) { clearTimeout(timer); resolve(m); }
  });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
console.log(JSON.stringify(out.result, null, 2));
ws.close();
