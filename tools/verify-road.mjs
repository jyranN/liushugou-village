#!/usr/bin/env node
/**
 * 道路分层校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-road.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-road.mjs --self-test  负向自测：在内存里把一条田埂挪进民居院子，
 *                                          确认净空检查确实会报错（不改动任何源文件）
 *
 * 检查口径（单位一律 m，与 data.js 的 ROAD / LANES / RIDGES 注释一致）：
 *   1. 计数与宽度：主路 6.2 + 两侧 0.45 路肩；巷道 5 条（2.8~3.0）；田埂 11 条（0.90）
 *   2. 主路走廊：每条巷道的 a 端必须落在主路路面 + 路肩内（a 端是接进主路的那一头）
 *   3. 田埂落位：全部离主路中线 ≥ 8 m（在田区，不进村）；与民居院墙、设施、场院、水窖、石墩、
 *      石碾、树干、电线杆脚净空 ≥ 0.30 m；田埂之间不交叉（最近采样点 ≥ 0.60 m）
 *   4. 源码结构：ROAD_KIND 五套参数齐全、三类抬升互不相等且都高于耕地田面 0.05 m、
 *      全部路面只 new 一个 Mesh（draw call 1）、旧 laneMat / 硬编码 LANES 已清除、
 *      aSurf 逐顶点覆写 roughnessFactor 与 normal.xy、polygonOffset 防 z-fighting
 */
import { readFileSync } from 'node:fs';
import { ROAD, LANES, RIDGES, HOUSES, FACILITIES, CISTERNS, STONES, MILLSTONE,
  TREES, PRODUCTION, POWER_LINE } from '../js/data.js';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const SRC = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');
const DATA = readFileSync(new URL('../js/data.js', import.meta.url), 'utf8');

const CLEAR = 0.30;        // 田埂到障碍的最小净空，m（窄埂可以贴得很近，但不能压上）
const RIDGE_ROAD_CLEAR = 8.0;  // 田埂到主路中线的最小距离，m（不进村、不占车行道）
const FIELD_Y = 0.05;      // 耕地田面相对 heightAt 的抬升，m（world.js 2736 行附近）

let bad = 0;
const problems = [];
const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------------- 障碍表：与 verify-production / verify-civic 同一套口径 ---------------- */
function buildObstacles(ridgesIn) {
  const obs = [];
  for (const h of HOUSES) obs.push({ kind: 'yard', x: h.pos[0], z: h.pos[2], hw: h.yard.w / 2, hd: h.yard.d / 2, name: h.id });
  for (const f of FACILITIES) if (f.kind !== 'streetlight') obs.push({ kind: 'circle', x: f.pos[0], z: f.pos[2], r: 7, name: f.id });
  for (const c of CISTERNS) obs.push({ kind: 'circle', x: c.pos[0], z: c.pos[1], r: 1.2, name: c.id });
  for (const s of STONES) obs.push({ kind: 'circle', x: s.pos[0], z: s.pos[1], r: 0.9, name: s.id });
  obs.push({ kind: 'circle', x: MILLSTONE.pos[0], z: MILLSTONE.pos[1], r: 1.5, name: MILLSTONE.id });
  for (const t of TREES) obs.push({ kind: 'circle', x: t.pos[0], z: t.pos[2], r: 0.45, name: t.id });
  for (const p of PRODUCTION) obs.push({ kind: 'circle', x: p.pos[0], z: p.pos[2], r: p.kind === 'floor' ? 5.2 : 2.0, name: p.id });
  return obs;
}

function sampleSeg(a, b, step) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.ceil(len / step));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t });
  }
  return out;
}

function clearance(pts, halfW, obs) {
  let worst = { d: Infinity, name: '-' };
  for (const p of pts) {
    for (const o of obs) {
      let d;
      if (o.kind === 'yard') {
        const dx = Math.max(0, Math.abs(p.x - o.x) - o.hw);
        const dz = Math.max(0, Math.abs(p.z - o.z) - o.hd);
        d = Math.hypot(dx, dz) - halfW;
      } else {
        d = Math.hypot(p.x - o.x, p.z - o.z) - o.r - halfW;
      }
      if (d < worst.d) worst = { d, name: o.name };
    }
  }
  return worst;
}

/* ---------------- 1. 计数与宽度 ---------------- */
ok(near(ROAD.width, 6.2, 1e-6), `主路宽 ${ROAD.width} ≠ 6.2 m`);
ok(near(ROAD.shoulder, 0.45, 1e-6), `主路路肩 ${ROAD.shoulder} ≠ 0.45 m`);
ok(ROAD.points.length >= 4, `主路中线只有 ${ROAD.points.length} 个点，太少了`);
ok(LANES.length === 5, `巷道 ${LANES.length} 条 ≠ 5`);
ok(RIDGES.length === 11, `田埂 ${RIDGES.length} 条 ≠ 11`);

LANES.forEach((L, i) => {
  ok(L.id === `LN-${i + 1}`, `巷道编号 ${L.id} 不连续（应为 LN-${i + 1}）`);
  ok(L.w >= 2.8 - 1e-9 && L.w <= 3.0 + 1e-9, `${L.id} 宽 ${L.w} m，不在 2.8~3.0`);
});
RIDGES.forEach((G) => {
  ok(near(G.w, 0.90, 1e-9), `${G.id} 宽 ${G.w} ≠ 0.90 m`);
  ok(Math.hypot(G.b[0] - G.a[0], G.b[1] - G.a[1]) >= 10, `${G.id} 太短（< 10 m）`);
});
const laneLen = LANES.reduce((s, L) => s + Math.hypot(L.b[0] - L.a[0], L.b[1] - L.a[1]), 0);
const ridgeLen = RIDGES.reduce((s, G) => s + Math.hypot(G.b[0] - G.a[0], G.b[1] - G.a[1]), 0);
ok(near(laneLen, 91.1, 0.3), `巷道总长 ${laneLen.toFixed(1)} m ≠ 91.1 m`);
ok(near(ridgeLen, 576.5, 0.5), `田埂总长 ${ridgeLen.toFixed(1)} m ≠ 576.5 m`);

/* ---------------- 2. 主路走廊：巷道 a 端必须接进主路 ---------------- */
function makeRoadX(road) {
  const pts = road.points.map(([x, z]) => ({ x, z }));
  return (z) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (z >= a.z && z <= b.z) return a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z);
    }
    return z < pts[0].z ? pts[0].x : pts[pts.length - 1].x;
  };
}
const roadX = makeRoadX(ROAD);
const halfCorridor = ROAD.width / 2 + ROAD.shoulder;
LANES.forEach((L) => {
  const off = Math.abs(L.a[0] - roadX(L.a[1]));
  ok(off <= halfCorridor + 1e-6,
    `${L.id} 的 a 端距主路中线 ${off.toFixed(2)} m，超出路面 + 路肩 ${halfCorridor.toFixed(2)} m`);
  ok(Math.abs(L.b[0] - roadX(L.b[1])) > 6, `${L.id} 太短，b 端还在主路里`);
});

/* ---------------- 3. 田埂落位 ---------------- */
const ridges = (list) => list.map((g) => ({ g, pts: sampleSeg(g.a, g.b, 1.5) }));

// 3.1 全部在田区：离主路中线至少 8 m，不进村、不占车行道
for (const { g, pts } of ridges(RIDGES)) {
  let minD = Infinity;
  for (const p of pts) minD = Math.min(minD, Math.abs(p.x - roadX(p.z)));
  ok(minD >= RIDGE_ROAD_CLEAR - 1e-6,
    `${g.id} 有采样点离主路中线只有 ${minD.toFixed(1)} m（要求 ≥ ${RIDGE_ROAD_CLEAR}）`);
}

// 3.2 与村内障碍的净空
const obs = buildObstacles();
// 电线杆脚：x = 主路中线 + side * offset（与 data.js POWER_LINE 一致）
for (const z of POWER_LINE.zs) {
  obs.push({ kind: 'circle', x: roadX(z) + POWER_LINE.side * POWER_LINE.offset, z, r: 0.6, name: '杆脚@' + z });
}
let ridgeWorst = { d: Infinity, name: '-', id: '-' };
for (const { g, pts } of ridges(RIDGES)) {
  const c = clearance(pts, g.w / 2, obs);
  if (c.d < ridgeWorst.d) ridgeWorst = { d: c.d, name: c.name, id: g.id };
  ok(c.d >= CLEAR, `${g.id} 与 ${c.name} 净空 ${c.d.toFixed(2)} m < ${CLEAR} m`);
}

// 3.3 田埂之间不交叉：任意两条埂的最近采样点 ≥ 0.60 m
const rs = ridges(RIDGES);
let crossMin = { d: Infinity, a: '-', b: '-' };
for (let i = 0; i < rs.length; i++) {
  for (let j = i + 1; j < rs.length; j++) {
    let m = Infinity;
    for (const p of rs[i].pts) for (const q of rs[j].pts) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < m) m = d;
    }
    if (m < crossMin.d) crossMin = { d: m, a: rs[i].g.id, b: rs[j].g.id };
    ok(m >= 0.60, `${rs[i].g.id} 与 ${rs[j].g.id} 最近只有 ${m.toFixed(2)} m，交叉了`);
  }
}

/* ---------------- 4. 源码结构 ---------------- */
// 4.1 ROAD_KIND 五套参数
const kindBlock = SRC.match(/const ROAD_KIND = \{[\s\S]*?\n    \};/);
ok(!!kindBlock, 'world.js 里找不到 ROAD_KIND 常量块');
const kindSrc = kindBlock ? kindBlock[0] : '';
for (const k of ['main', 'shoulder', 'lane', 'laneEdge', 'ridge']) {
  ok(new RegExp(`\\b${k}:\\s*\\{`).test(kindSrc), `ROAD_KIND 缺 ${k} 这一套参数`);
}
const dyOf = (k) => {
  const m = kindSrc.match(new RegExp(`\\b${k}:\\s*\\{[^}]*dy:\\s*([\\d.]+)`));
  return m ? Number(m[1]) : NaN;
};
const dyMain = dyOf('main'), dyLane = dyOf('lane'), dyRidge = dyOf('ridge');
ok(Number.isFinite(dyMain) && Number.isFinite(dyLane) && Number.isFinite(dyRidge), '三类 dy 解析失败');
ok(new Set([dyMain, dyLane, dyRidge]).size === 3,
  `三类抬升必须互不相等（main ${dyMain} / lane ${dyLane} / ridge ${dyRidge}）`);
ok(Math.min(dyMain, dyLane, dyRidge) > FIELD_Y,
  `最低抬升 ${Math.min(dyMain, dyLane, dyRidge)} m 不高于耕地田面 ${FIELD_Y} m，会与田面 z-fighting`);
// 田埂中心拱起：四段截面（外缘草色缓坡 14% + 中间平顶土色 86%）
const archMatch = SRC.match(/a: 0, b: 0\.86, ya: ([\d.]+)/);
const archRise = archMatch ? Number(archMatch[1]) : 0;
ok(!!archMatch && archRise > 0, '田埂中心没有拱起（找不到四段截面里的 ya）');
ok(dyRidge + archRise > dyMain,
  `田埂中心 ${(dyRidge + archRise).toFixed(3)} m 应高于水泥主路 ${dyMain} m，否则会被主路盖住`);
const ridgeBands = (SRC.match(/kind: 'ridge', colA/g) || []).length;
ok(ridgeBands === 4, `田埂截面 ${ridgeBands} 段，应为 4 段（两段线性插值会把草色摊到半个断面、整条埂发暗）`);

// 4.2 只有一个 Mesh
const roadMeshCount = (SRC.match(/roadMesh = new THREE\.Mesh\(/g) || []).length;
ok(roadMeshCount === 1, `路面 new 了 ${roadMeshCount} 个 Mesh，应只有 1 个`);
ok(/root\.add\(roadMesh\)/.test(SRC), '路面 Mesh 没有挂到 root');
ok(/geo\.setAttribute\('aSurf'/.test(SRC), '缺少 aSurf 逐顶点材质属性');
ok(/roughnessFactor = vSurf\.x/.test(SRC), '着色器没有用 aSurf.x 覆写 roughnessFactor');
ok(/normal\.xy \*= vSurf\.y/.test(SRC), '着色器没有用 aSurf.y 缩放法线强度');
ok(/polygonOffsetFactor: -3/.test(SRC), '路面材质缺少 polygonOffset，可能与地形 z-fighting');
ok(/vertexColors: true/.test(SRC), '路面材质没有开 vertexColors');

// 4.3 旧实现已清除
ok(!/const LANES = \[/.test(SRC), 'world.js 里还留着硬编码的 LANES，应已迁到 data.js');
ok(!/\blaneMat\b/.test(SRC), 'world.js 里还留着 laneMat（旧巷道材质）');
ok(/export const LANES = \[/.test(DATA), 'data.js 没有导出 LANES');
ok(/export const RIDGES = \[/.test(DATA), 'data.js 没有导出 RIDGES');
ok(/export const ROAD = \{[\s\S]*?shoulder: 0\.45/.test(DATA), 'data.js 的 ROAD 缺 shoulder 字段');

/* ---------------- 负向自测 ---------------- */
if (process.argv.includes('--self-test')) {
  // 把第一条田埂挪进 H-03 的院子，确认净空检查确实会报错（不改动任何源文件）
  const moved = RIDGES.map((g, i) => (i === 0 ? { ...g, a: [-14, -54], b: [-8, -54] } : g));
  let caught = false, worst = Infinity;
  for (const { g, pts } of ridges(moved)) {
    const c = clearance(pts, g.w / 2, obs);
    worst = Math.min(worst, c.d);
    if (c.d < CLEAR) caught = true;
  }
  console.log(`\n负向自测：把 ${moved[0].id} 挪到 H-03 院子里，最近净空 ${worst.toFixed(2)} m`);
  if (!caught) { console.log('✗ 负向自测失败：净空检查没有报错'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log(`主路 ${ROAD.width} m + 两侧 ${ROAD.shoulder} m 路肩；巷道 ${LANES.length} 条 ${laneLen.toFixed(1)} m；田埂 ${RIDGES.length} 条 ${ridgeLen.toFixed(1)} m`);
console.log(`路面绘制批次：1 个 Mesh（改造前 6 个：主路 1 + 巷道 5）`);
console.log(`三类抬升 main ${dyMain} / lane ${dyLane} / ridge 边 ${dyRidge} 心 ${(dyRidge + archRise).toFixed(3)} m，均高于田面 ${FIELD_Y} m；田埂截面 ${ridgeBands} 段`);
console.log(`田埂到最近障碍净空 ${ridgeWorst.d.toFixed(2)} m（${ridgeWorst.id} ↔ ${ridgeWorst.name}）；田埂之间最近 ${crossMin.d.toFixed(2)} m（${crossMin.a} ↔ ${crossMin.b}）`);

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
