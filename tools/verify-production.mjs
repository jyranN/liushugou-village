/**
 * 生产性空间落位校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：node tools/verify-production.mjs
 * 通过：打印 16 行对照表 + 合计行，退出码 0
 * 失败：打印具体冲突项，退出码 1（可用来做负向测试：改错一个 pos / radius 应当报错）
 *
 * 检查的口径与 data.js 的 PRODUCTION 注释一一对应，单位 m：
 *   - 旋转矩形：耕地（按 f.rot 反变换到局部坐标）、民居院墙、公共设施占地
 *   - 圆：水窖、石墩、石碾、树干、电线杆脚、其它生产性空间物件、公共核心四处场所
 *   - 主路：折线中线 + 半宽 3.10 m + 0.70 m 路肩余量
 *
 * v1.2 公共核心：障碍清单补上 C-01 ~ C-04 的占位圆（半径 = footprint 半对角线，
 * 单位 m，与 controls.js / verify-civic.mjs 同一口径），保证两轮新增物件互不压占。
 * 反向的「公共核心 → 场院」避让由 tools/verify-civic.mjs 校验。
 */
import { ALL_OBJECTS, PRODUCTION, CIVIC, HOUSES, FIELDS, FACILITIES, CISTERNS,
  STONES, MILLSTONE, TREES, ROAD, POWER_LINE, STATS } from '../js/data.js';

const MARGIN = 0.5;                 // 所有间距统一留 0.5 m 施工余量
const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

/* ---------- 障碍清单 ---------- */
const rects = [];
const circles = [];

const roadPts = ROAD.points.map(([x, z]) => ({ x, z }));
function roadX(z) {
  for (let i = 0; i < roadPts.length - 1; i++) {
    const a = roadPts[i], b = roadPts[i + 1];
    if (z >= a.z && z <= b.z) return a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z);
  }
  return z < roadPts[0].z ? roadPts[0].x : roadPts[roadPts.length - 1].x;
}

// 耕地：world.js 里 g.rotation.y = f.rot，矩形随之旋转
for (const f of FIELDS) {
  rects.push({ cx: f.pos[0], cz: f.pos[2], hx: f.size[0] / 2, hz: f.size[1] / 2,
    rot: f.rot, name: f.id, group: '耕地' });
}
// 民居院墙：w × d，墙厚 0.28 m，外扩 0.30 m 作为保守外轮廓
for (const h of HOUSES) {
  rects.push({ cx: h.pos[0], cz: h.pos[2], hx: h.yard.w / 2 + 0.3, hz: h.yard.d / 2 + 0.3,
    rot: h.rot, name: h.id, group: '院墙' });
}
// 公共设施：按 buildFacility() 里的实际板/代理盒占地
const FAC_BOX = {
  well: [2.2, 2.2], committee: [7.0, 4.7], barn: [11.5, 7.0], yard: [13.5, 9.0],
  mill: [5.5, 3.2], plaza: [15.5, 10.5], streetlight: [1.0, 0.6], signboard: [2.0, 0.5],
};
for (const f of FACILITIES) {
  const [hx, hz] = FAC_BOX[f.kind] || [2, 2];
  rects.push({ cx: f.pos[0], cz: f.pos[2], hx, hz, rot: 0, name: f.id, group: '设施' });
}
for (const c of CISTERNS) circles.push({ x: c.pos[0], z: c.pos[1], r: 1.1, name: c.id });
for (const s of STONES) circles.push({ x: s.pos[0], z: s.pos[1], r: 0.7, name: s.id });
circles.push({ x: MILLSTONE.pos[0], z: MILLSTONE.pos[1], r: 1.5, name: MILLSTONE.id });
// 只避让树干：树冠伸到场院上方是农村常态，不算穿模
for (const t of TREES) circles.push({ x: t.pos[0], z: t.pos[2], r: 1.0, name: t.id });
for (const z of POWER_LINE.zs) circles.push({ x: roadX(z) - POWER_LINE.offset, z, r: 0.6, name: '杆脚@' + z });
for (const c of CIVIC) circles.push({ x: c.pos[0], z: c.pos[2], r: c.radius, name: c.id });

function distRect(px, pz, R) {
  const dx = px - R.cx, dz = pz - R.cz;
  const c = Math.cos(R.rot), s = Math.sin(R.rot);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const qx = Math.max(-R.hx, Math.min(R.hx, lx));
  const qz = Math.max(-R.hz, Math.min(R.hz, lz));
  return Math.hypot(lx - qx, lz - qz);
}

/** 返回 { bad: 冲突名[], clearance: 到最近障碍的净空 m } */
function check(x, z, r) {
  const bad = [];
  let clearance = Math.abs(x - roadX(z)) - (ROAD.width / 2 + 0.7 + r);
  if (clearance < MARGIN) bad.push('主路');
  for (const R of rects) {
    const d = distRect(x, z, R) - r;
    if (d < clearance) clearance = d;
    if (d < MARGIN) bad.push(`${R.group}:${R.name}`);
  }
  for (const C of circles) {
    const d = Math.hypot(x - C.x, z - C.z) - r - C.r;
    if (d < clearance) clearance = d;
    if (d < MARGIN) bad.push(C.name);
  }
  return { bad, clearance };
}

/* ---------- 1. 编号与计数 ---------- */
const ids = ALL_OBJECTS.map((o) => o.id);
ok(new Set(ids).size === ids.length, `ALL_OBJECTS 有重复 ID：${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
ok(ALL_OBJECTS.length === 199, `ALL_OBJECTS 总数 ${ALL_OBJECTS.length} ≠ 199（188 + 1 看门狗 + 4 公共核心 + 6 河岸柳）`);
ok(PRODUCTION.length === 16, `生产性空间 ${PRODUCTION.length} 个 ≠ 16（任务要求 12–18）`);
ok(STATS.production === 16, `STATS.production ${STATS.production} ≠ 16`);
ok(PRODUCTION.every((p, i) => p.id === `P-${String(i + 1).padStart(2, '0')}`), 'P-* 编号不连续');
ok(PRODUCTION.every((p) => p.type === 'production'), '存在 type ≠ production 的条目');

const kinds = PRODUCTION.reduce((o, p) => (o[p.kind] = (o[p.kind] || 0) + 1, o), {});
for (const k of ['floor', 'straw', 'wood', 'dung', 'coop', 'sty']) {
  ok((kinds[k] || 0) >= 1, `六类缺 ${k}`);
}
ok(kinds.floor === 6, `麦场 ${kinds.floor} 处 ≠ 6`);
ok(STATS.yards === 6, `共享场院 ${STATS.yards} 处 ≠ 6`);

/* ---------- 2. 共享分组：13 户在住户、每组 2–3 户、H-09 空置不设 ---------- */
const houseById = new Map(HOUSES.map((h) => [h.id, h]));
// 一处场院里有麦场 + 若干垛，sharedBy 会重复出现：按 yardId 去重，只以麦场为准，
// 再反向校验同院其它物件的服务户必须与麦场完全一致。
const floors = PRODUCTION.filter((p) => p.kind === 'floor');
const seen = [];
for (const p of floors) {
  ok(Array.isArray(p.sharedBy) && p.sharedBy.length >= 2 && p.sharedBy.length <= 3,
    `${p.id} 共享 ${p.sharedBy?.length} 户，超出 2–3 户`);
  for (const h of p.sharedBy || []) {
    ok(houseById.has(h), `${p.id} 引用了不存在的户 ${h}`);
    ok(!seen.includes(h), `户 ${h} 被登记到两处场院`);
    seen.push(h);
  }
  for (const q of PRODUCTION.filter((o) => o.yardId === p.yardId && o.kind !== 'floor')) {
    ok(JSON.stringify([...q.sharedBy].sort()) === JSON.stringify([...p.sharedBy].sort()),
      `${q.id} 与 ${p.id} 同院但服务户不一致`);
  }
}
for (const p of PRODUCTION.filter((o) => o.yardId && o.kind !== 'floor')) {
  ok(floors.some((f) => f.yardId === p.yardId), `${p.id} 的 yardId ${p.yardId} 没有对应麦场`);
}
const inhabited = HOUSES.filter((h) => !h.vacant).map((h) => h.id).sort();
ok(JSON.stringify([...new Set(seen)].sort()) === JSON.stringify(inhabited),
  `场院覆盖 ${[...new Set(seen)].sort().join(',')} ≠ 在住户 ${inhabited.join(',')}`);
ok(!seen.includes('H-09'), '空置户 H-09 不该有场院');

/* ---------- 3. 鸡窝 / 猪圈贴院墙 ---------- */
const HALF_X = { coop: 0.80, sty: 1.60 };   // 沿墙法线的半尺寸，m
for (const p of PRODUCTION.filter((p) => p.kind === 'coop' || p.kind === 'sty')) {
  const h = houseById.get(p.sharedBy[0]);
  ok(!!h, `${p.id} 未找到所属民居`);
  if (!h) continue;
  ok(p.sharedBy.length === 1, `${p.id} 应为单户所有`);
  const dx = p.pos[0] - h.pos[0], dz = p.pos[2] - h.pos[2];
  const c = Math.cos(h.rot), s = Math.sin(h.rot);
  const lx = dx * c - dz * s;                 // 该户局部 x（正 = 东）
  const wallFace = h.yard.w / 2 + 0.14;       // 院墙外表面
  const centerDist = Math.abs(lx) - wallFace;
  const gap = centerDist - HALF_X[p.kind];    // 物件近边到墙外表面的净距
  ok(Math.sign(lx) === h.side, `${p.id} 不在背街一侧（lx=${lx.toFixed(2)}）`);
  ok(gap >= 0.2 && gap <= 1.8, `${p.id} 贴墙净距 ${gap.toFixed(2)} m 不在 0.2–1.8 m`);
  ok(Math.abs((p.rot || 0) - h.rot) < 1e-6, `${p.id} 的 rot 与所属民居不一致`);
}

/* ---------- 4. 逐件落位：主路 / 耕地 / 院墙 / 设施 / 树 / 杆 / 彼此 ---------- */
const rows = [];
let minClear = Infinity;
for (const p of PRODUCTION) {
  const [x, y, z] = p.pos;
  ok([x, y, z].every(Number.isFinite), `${p.id} pos 含非数字`);
  ok(y === 0, `${p.id} pos.y 应为 0（标高由 heightAt 取）`);
  ok(Number.isFinite(p.radius) && p.radius > 0, `${p.id} radius 非法`);
  for (const k of ['name', 'category', 'scope', 'size', 'use', 'structure', 'season', 'status', 'note']) {
    ok(typeof p[k] === 'string' && p[k].length > 0, `${p.id} 缺字段 ${k}`);
  }
  const r = check(x, z, p.radius);
  if (r.bad.length) errors.push(`${p.id} ${p.category} 与 ${r.bad.join(' / ')} 冲突（净空 ${r.clearance.toFixed(2)} m）`);
  minClear = Math.min(minClear, r.clearance);
  rows.push({ id: p.id, 类别: p.category, 位置: `${x.toFixed(2)}, ${z.toFixed(2)}`,
    占位半径: p.radius.toFixed(2), 服务: p.scope, 净空: r.clearance.toFixed(2), 冲突: r.bad.length ? r.bad.join(',') : '—' });
}
// 两两之间留 0.30 m 缝（同一处场院里的垛与场面也在此列）
for (let i = 0; i < PRODUCTION.length; i++) {
  for (let j = i + 1; j < PRODUCTION.length; j++) {
    const a = PRODUCTION[i], b = PRODUCTION[j];
    const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);
    if (d < a.radius + b.radius + 0.30) {
      errors.push(`${a.id} 与 ${b.id} 重叠：中心距 ${d.toFixed(2)} m < ${(a.radius + b.radius + 0.3).toFixed(2)} m`);
    }
  }
}

/* ---------- 5. 与耕地的边界单独再报一次最小净空 ---------- */
let fieldClear = Infinity, fieldPair = '';
for (const p of PRODUCTION) {
  for (const f of FIELDS) {
    const R = { cx: f.pos[0], cz: f.pos[2], hx: f.size[0] / 2, hz: f.size[1] / 2, rot: f.rot };
    const d = distRect(p.pos[0], p.pos[2], R) - p.radius;
    if (d < fieldClear) { fieldClear = d; fieldPair = `${p.id} ↔ ${f.id}`; }
  }
}
ok(fieldClear >= MARGIN, `场院与耕地最小净空 ${fieldClear.toFixed(2)} m（${fieldPair}）< ${MARGIN} m`);

/* ---------- 输出 ---------- */
console.log('生产性空间落位对照表（坐标 m，半径 m，净空 m）');
console.table(rows);
console.log(`合计：${PRODUCTION.length} 个可点物件 / ${STATS.yards} 处共享场院 / 六类 ${JSON.stringify(kinds)}`);
console.log(`覆盖在住户 ${new Set(seen).size} 户：${[...new Set(seen)].sort().join(', ')}`);
console.log(`到最近障碍净空 ${minClear.toFixed(2)} m；与耕地最小净空 ${fieldClear.toFixed(2)} m（${fieldPair}）`);
console.log(`ALL_OBJECTS = ${ALL_OBJECTS.length}（172 + 16 生产性空间 + 4 公共核心 + 6 河岸柳）`);

if (errors.length) {
  console.error(`\n❌ 校验失败，共 ${errors.length} 项：`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✅ 全部通过：编号、分组、贴墙、主路、耕地、设施、树、杆脚、彼此间距均无冲突');
