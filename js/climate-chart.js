/* 气象数据面板：全年气温曲线 + 降水柱状（Canvas 2D 自绘，不引入图表库）
 *
 * 「数字孪生最实的落点」——把 data/ 里岷县 2025 年 8760 条逐小时实测直接画出来：
 *   - 气温：365 个日均值折线（左轴 ℃）；降水：日合计柱（右轴 mm），柱宽随画布宽度聚合
 *   - 数据按画布宽度降采样：x 像素 → 日序线性插值，画布多窄都不丢趋势
 *   - 当前时刻游标与时间轴**双向同步**：
 *       拖时间轴 / 播放 → updateClimateChart(clock, wx)（main.js 每帧调，内部只在游标
 *         x 像素变化 ≥1 时才重绘，静止画面零重绘）
 *       点 / 拖曲线 → clock.hour = round(x/w × 8760 × 4) / 4，对齐 15 分钟一格；
 *         时间条滑块经既有 updateTimebar 回写逻辑跟随
 *
 * 重绘策略（验收：面板展开不明显掉帧、重绘按需）：
 *   静态层（曲线 + 柱 + 刻度）画进 offscreen canvas，只在打开 / resize 时画一次；
 *   可见层重绘 = drawImage(off) + 一条游标线 + 当前实测温降小字（< 0.1 ms）；
 *   redraws 计数暴露给 ?qa 与验收脚本（面板开着不动画面时应恒定）。
 *
 * 单位口径：温度 ℃；降水 mm（日合计，来自逐小时 precipitation 求和）；
 * 时间 hour = 全年小时序（0–8759，含小数），与 Climate.sample / clock.hour 同一口径。
 */

let clockRef = null;
let climateRef = null;
let panel = null;
let canvas = null;
let ctx = null;
let off = null;          // offscreen 静态层
let built = false;
let openState = false;
let lastCursorX = -1;    // 上次重绘时游标 x（像素）
let lastReadout = '';    // 游标文字缓存（变了才写）
let lastWx = null;       // 最近一次逐小时实况（main.js 每帧传入；打开面板时先用它画游标文字）
let stats = null;        // { temps: Float32Array(365), precip: Float32Array(365) }，单位 ℃ / mm
let redraws = 0;         // 可见层重绘次数（验收「重绘按需」用）

export function initClimateChart(climate, clock) {
  climateRef = climate;
  clockRef = clock;
  panel = document.getElementById('wxPanel');
  canvas = document.getElementById('wxCanvas');
  const btn = document.getElementById('wxChartBtn');
  if (!panel || !canvas || !btn) return;
  ctx = canvas.getContext('2d');

  buildStats(climate);
  bindToggle(btn);
  bindPointer(canvas, clock);

  window.addEventListener('resize', () => {
    if (!openState) return;
    sizeCanvas();
    repaintStatic();
    redraw(true);
  });
}

export function isClimatePanelOpen() { return openState; }
export function climateChartRedraws() { return redraws; }

export function toggleClimateChart(force) {
  setOpen(typeof force === 'boolean' ? force : !openState);
}

function setOpen(v) {
  if (openState === v) return;
  openState = v;
  panel.classList.toggle('open', v);
  const btn = document.getElementById('wxChartBtn');
  if (btn) btn.classList.toggle('on', v);
  if (v) {
    sizeCanvas();
    repaintStatic();
    lastCursorX = -1;          // 强制下一帧重画游标
    redraw(true, lastWx);
  }
}

function bindToggle(btn) {
  btn.addEventListener('click', () => setOpen(!openState));
  panel.querySelector('#wxPanelClose')?.addEventListener('click', () => setOpen(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openState) setOpen(false);
  });
}

/* 点 / 拖曲线 → 跳时刻。对齐 15 分钟一格（与时间条 TIME_STEPS=35040 同分辨率），
 * 不动 playing 状态：点一下场景跳过去，播放中则从新时刻继续走。 */
function bindPointer(canvasEl, clock) {
  let dragging = false;
  const jump = (e) => {
    const r = canvasEl.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    clock.hour = Math.round(fx * climateRef.n * 4) / 4;
  };
  canvasEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* 老浏览器忽略 */ }
    jump(e);
    e.preventDefault();
  });
  canvasEl.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
  canvasEl.addEventListener('pointerup', () => { dragging = false; });
  canvasEl.addEventListener('pointercancel', () => { dragging = false; });
}

/* 8760 条逐小时 → 365 个日均温 / 日降水（一次性预算，单位 ℃ / mm） */
function buildStats(cl) {
  const T = cl.hourly.temperature_2m;
  const P = cl.hourly.precipitation;
  const nd = cl.dayCount;
  const temps = new Float32Array(nd);
  const precip = new Float32Array(nd);
  for (let d = 0; d < nd; d++) {
    let t = 0, p = 0;
    for (let h = 0; h < 24; h++) { t += (T[d * 24 + h] ?? 0); p += (P[d * 24 + h] ?? 0); }
    temps[d] = t / 24;
    precip[d] = p;
  }
  stats = { temps, precip };
}

function sizeCanvas() {
  const cssW = canvas.clientWidth || 340;
  const cssH = canvas.clientHeight || 190;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
}

/* 静态层：只在打开 / resize 时画一次。曲线与柱都按画布宽度降采样：
 * 每个像素列 x 对应日序 day = x/w × 365，取值用相邻两天线性插值。 */
function repaintStatic() {
  if (!off || !stats) return;
  const o = off.getContext('2d');
  const w = off.width, h = off.height;
  o.clearRect(0, 0, w, h);
  const nd = stats.temps.length;                 // 365
  const px = (d) => (d / (nd - 1)) * w;          // 日序 → 像素
  const sample = (arr, day) => {
    const i = Math.min(nd - 2, Math.max(0, Math.floor(day)));
    const f = day - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };

  /* ---- 降水柱（右轴 mm）：每柱聚合 ceil(365/柱数) 天的日合计之和 ---- */
  const pMax = Math.max(10, Math.ceil(Math.max(...stats.precip) / 10) * 10);  // mm，向上取整到 10
  const barTop = h * 0.10, base = h - 16;
  const barPitch = Math.max(3, Math.round(w / 160));   // 柱距像素：约 160 根柱，聚合窗口内的日均降水
  for (let x = 0; x < w; x += barPitch) {
    const d0 = (x / w) * nd, d1 = ((x + barPitch) / w) * nd;
    let sum = 0, n = 0;
    for (let d = Math.floor(d0); d < Math.min(nd, Math.ceil(d1)); d++) { sum += stats.precip[d]; n++; }
    if (!n || sum <= 0) continue;
    const mean = sum / n;                        // 柱高画「窗口日均」，避免聚合窗口大小不同导致高矮失真
    const bh = Math.min(base - barTop, (mean / pMax) * (base - barTop));
    o.fillStyle = 'rgba(96, 148, 202, 0.38)';
    o.fillRect(x + 0.5, base - bh, barPitch - 1, bh);
  }

  /* ---- 气温折线（左轴 ℃）---- */
  const tMin = Math.floor(Math.min(...stats.temps) / 5) * 5 - 2;
  const tMax = Math.ceil(Math.max(...stats.temps) / 5) * 5 + 2;
  const tTop = 8, tBot = base;
  const ty = (t) => tBot - ((t - tMin) / (tMax - tMin)) * (tBot - tTop);
  // 0 ℃ 参考线（岷县冬季是否上冻一眼可读）
  if (tMin < 0 && tMax > 0) {
    o.strokeStyle = 'rgba(255,255,255,0.16)';
    o.setLineDash([3, 4]);
    o.beginPath(); o.moveTo(0, ty(0)); o.lineTo(w, ty(0)); o.stroke();
    o.setLineDash([]);
  }
  o.strokeStyle = '#e2a94f';
  o.lineWidth = Math.max(1.2, (window.devicePixelRatio || 1) * 0.7);
  o.beginPath();
  for (let x = 0; x < w; x++) {
    const t = sample(stats.temps, (x / w) * (nd - 1));
    if (x === 0) o.moveTo(x, ty(t)); else o.lineTo(x, ty(t));
  }
  o.stroke();

  /* ---- 刻度与文字 ---- */
  o.fillStyle = 'rgba(255,255,255,0.55)';
  o.font = `${Math.round(10 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
  const months = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const mLabel = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  for (let i = 0; i < 12; i++) {
    const x = px(months[i]);
    if (x > 18 && x < w - 30) o.fillText(mLabel[i], x, h - 4);
  }
  o.fillText(`${tMax - 2}℃`, 2, ty(tMax - 2) + 10);
  o.fillText('0℃', 2, tMin < 0 ? ty(0) - 3 : 12);
  o.fillText(`${pMax}mm`, w - 34, barTop + 10);
}

/* 可见层：游标 x 像素变了才重绘（main.js 每帧调，这里做按需闸门） */
export function updateClimateChart(clock, wx) {
  if (wx) lastWx = wx;
  if (!openState || !ctx) return;
  const x = Math.round((clock.hour / climateRef.n) * canvas.width);
  if (x !== lastCursorX || lastReadout === '') redraw(false, wx);
}

function redraw(force, wx) {
  if (!ctx || !off) return;
  const w = canvas.width, h = canvas.height;
  const x = Math.round((clockRef.hour / climateRef.n) * w);
  if (!force && x === lastCursorX) return;
  wx = wx || lastWx;
  lastCursorX = x;
  redraws++;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(off, 0, 0);

  /* 游标：竖线 + 顶部小圆点 */
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 0.5, 0, 1.5, h - 14);
  ctx.beginPath();
  ctx.arc(x, 6, 3, 0, Math.PI * 2);
  ctx.fill();

  /* 当前实测温降小字（wx 为逐小时插值，与场景同一来源） */
  const txt = wx
    ? `${wx.date.slice(5)} ${String(Math.floor(wx.hourOfDay)).padStart(2, '0')}:${String(Math.floor((wx.hourOfDay % 1) * 60)).padStart(2, '0')}  ${wx.temp.toFixed(1)}℃`
    : `${(clockRef.hour / 24).toFixed(0)} 日`;
  if (txt !== lastReadout) {
    ctx.font = `${Math.round(11 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
    const tw = ctx.measureText(txt).width;
    const tx = Math.min(w - tw - 6, Math.max(4, x + 6));
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(tx - 3, 12, tw + 6, 15 * (window.devicePixelRatio || 1) * 0.8 + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(txt, tx, 24);
    lastReadout = txt;
  }
}
