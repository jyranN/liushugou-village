/**
 * 自动化验收：连 CDP，检查首屏、拾取、第一人称、帧率
 * 用法：node tools/qa.mjs [端口] [输出目录]
 */

const PORT = process.argv[2] || 9222;
const OUT = process.argv[3] || '/tmp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* 等 Chrome 起来 */ }
    await sleep(250);
  }
  throw new Error('未能连接到 Chrome 调试端口');
}

async function toText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
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
  return (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error(`CDP 超时: ${method}`));
    }, 120000);
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

const errors = [];
ws.addEventListener('message', async (e) => {
  let m;
  try { m = JSON.parse(await toText(e.data)); } catch { return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || '未知异常');
  }
});

await send('Page.navigate', { url: 'http://localhost:8099/index.html' });
await sleep(4000);
// 软件渲染 / 首次着色器编译时首帧可能很慢，必须等 app 真正就绪
for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', { expression: '!!window.__app', returnByValue: true });
  if (r.result.value) break;
  await sleep(1000);
}
await sleep(1500);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '执行失败');
  return r.result.value;
};

const report = {};

report.appReady = await evalJs('!!window.__app');
report.loaderHidden = await evalJs("getComputedStyle(document.getElementById('loader')).display === 'none'");
report.statsItems = await evalJs("document.querySelectorAll('#stats .stat').length");
report.pickables = await evalJs('window.__app.world.pickables.length');
report.sceneChildren = await evalJs('window.__app.scene.children.length');

// 拾取：直接把相机对准一棵树并投影到屏幕，再点击
report.pickResult = await evalJs(`(() => {
  const app = window.__app;
  const p = app.world.pickables[20];
  p.updateWorldMatrix(true, false);
  const pos = p.getWorldPosition(new (p.position.constructor)());
  const proj = pos.clone().project(app.camera);
  return { x: Math.round((proj.x * 0.5 + 0.5) * innerWidth), y: Math.round((-proj.y * 0.5 + 0.5) * innerHeight), z: proj.z };
})()`);

// 用程序方式触发选中，验证档案卡渲染
report.cardShown = await evalJs(`(() => {
  const o = window.__app.objectById.get(window.__app.world.pickables[20].userData.objectId);
  window.__app.UI.showCard(o);
  const card = document.getElementById('card');
  return { open: card.classList.contains('open'), title: card.querySelector('.card-title')?.textContent, rows: card.querySelectorAll('.row').length };
})()`);

report.cardClosed = await evalJs(`(() => {
  window.__app.UI.hideCard();
  return !document.getElementById('card').classList.contains('open');
})()`);

// 第一人称
report.walk = await evalJs(`(() => {
  const app = window.__app;
  app.rig.enterWalk();
  return { mode: app.rig.mode, camY: +app.camera.position.y.toFixed(2), fov: app.camera.fov };
})()`);

await sleep(1200);
report.walkAfterTick = await evalJs(`(() => {
  const app = window.__app;
  return { mode: app.rig.mode, camY: +app.camera.position.y.toFixed(2) };
})()`);

report.fps = await evalJs("document.getElementById('fps').textContent");

const fs = await import('node:fs/promises');
try {
  const shot1 = await send('Page.captureScreenshot', { format: 'png' }, 60000);
  await fs.writeFile(`${OUT}/qa-walk.png`, Buffer.from(shot1.data, 'base64'));
} catch (e) { report.walkShotFailed = true; }

// 回上帝视角截一张
await evalJs('window.__app.rig.exitWalk(); window.__app.UI.setMode("orbit")');
await sleep(2500);
try {
  const shot2 = await send('Page.captureScreenshot', { format: 'png' }, 60000);
  await fs.writeFile(`${OUT}/qa-orbit.png`, Buffer.from(shot2.data, 'base64'));
} catch (e) { report.orbitShotFailed = true; }

report.jsErrors = errors;

console.log(JSON.stringify(report, null, 2));
ws.close();
