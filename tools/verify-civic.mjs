#!/usr/bin/env node
/**
 * 公共核心落位与统计口径校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-civic.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-civic.mjs --self-test  负向自测：在内存中把 C-01 挪进主路，
 *                                          确认脚本确实会报错（不改动任何源文件）
 *
 * 检查口径（单位一律 m / 人 / 亩，与 data.js CIVIC 注释一致）：
 *   1. 编号、计数、类型、档案字段完整性
 *   2. F-02 村委会卡片的 43 人 / 513 亩 == 从 HOUSES / FIELDS 重新聚合的全村口径
 *      （与工具 03 tools/verify-cards.mjs 同一套算法，不允许两处写死不同数字）
 *   3. 落位：主路折线走廊、旋转矩形耕地与院墙、设施、场院、水窖、石墩、
 *      石碾、树干、电线杆脚、彼此边缘净距
 *   4. 巡游：解析 js/tour.js 的第 2 段，采样 101 个机位，确认始终在主路走廊内、
 *      不穿过四处场所，且末帧水平 + 垂直视锥内能带到 ≥ 2 处公共场所 + F-02 村委会；
 *      同时校验 rise 抬升存在（贴地机位会被院墙挡住，静态防回归）
 *   5. 接线：ui / main / controls / tour 四个文件里的公共核心分支仍在
 *
 * 说明：工程 package.json 没有 "type": "module"，直接 import js/data.js 会有一条
 * MODULE_TYPELESS_PACKAGE_JSON 警告；与 verify-cards.mjs 一样临时压掉。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const MARGIN = 0.5;                 // 施工余量，与 verify-production.mjs 一致
const ROAD_SHOULDER = 0.7;         // 路肩余量，与 verify-production.mjs 一致
const HALF_FOV_H = 38;             // 巡游 fov=50°、16:9 时水平半视角约 39.6°，取保守值
const HALF_FOV_V = 25;             // 垂直半视角 = fov/2，单位度
const EYE = 1.8;                   // 低机位眼高，单位 m，与 tour.js 一致
const FILE = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/* ---------- 几何工具 ---------- */
function makeRoadX(ROAD) {
  const pts = ROAD.points.map(([x, z]) => ({ x, z }));
  return (z) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (z >= a.z && z <= b.z) return a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z);
    }
    return z < pts[0].z ? pts[0].x : pts[pts.length - 1].x;
  };
}
/** 点到旋转矩形的距离；矩形世界朝向 rot（world.js 里 g.rotation.y = f.rot） */
function distRect(px, pz, R) {
  const dx = px - R.cx, dz = pz - R.cz;
  const c = Math.cos(R.rot), s = Math.sin(R.rot);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const qx = Math.max(-R.hx, Math.min(R.hx, lx));
  const qz = Math.max(-R.hz, Math.min(R.hz, lz));
  return Math.hypot(lx - qx, lz - qz);
}
/** 两个轴对齐矩形之间的边缘净距（x / z 两轴间隙的欧氏长度） */
function rectGap(a, b) {
  const dx = Math.max(0, Math.abs(a.x - b.x) - (a.hx + b.hx));
  const dz = Math.max(0, Math.abs(a.z - b.z) - (a.hz + b.hz));
  return Math.hypot(dx, dz);
}

/* ---------- 从 tour.js 解析出真实的第 2 段，不复制一份数字 ---------- */
function parseShot2(src) {
  const re = /dur:\s*([\d.]+)[^}]*?from:\s*\{\s*x:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+),\s*look:\s*\[([^\]]+)\]\s*\},\s*to:\s*\{\s*x:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+),\s*look:\s*\[([^\]]+)\]/g;
  const shots = [...src.matchAll(re)];
  if (shots.length < 2) return null;
  const m = shots[1];
  const nums = (s) => s.split(',').map((v) => Number(v.trim()));
  const riseM = /rise:\s*([\d.]+)/.exec(m[0]);   // 第 2 段专属的渐进抬升，单位 m
  return {
    dur: Number(m[1]),
    rise: riseM ? Number(riseM[1]) : 0,
    from: { x: Number(m[2]), z: Number(m[3]), look: nums(m[4]) },
    to: { x: Number(m[5]), z: Number(m[6]), look: nums(m[7]) },
    count: shots.length,
  };
}

/* ---------- 主校验 ---------- */
function run(D, src) {
  const { ALL_OBJECTS, CIVIC, HOUSES, FIELDS, FACILITIES, CISTERNS,
    STONES, MILLSTONE, TREES, PRODUCTION, ROAD, POWER_LINE, STATS } = D;
  const errors = [];
  const ok = (cond, msg) => { if (!cond) errors.push(msg); };
  const roadX = makeRoadX(ROAD);

  /* 1. 编号 / 计数 / 类型 */
  const ids = ALL_OBJECTS.map((o) => o.id);
  ok(new Set(ids).size === ids.length, `ALL_OBJECTS 有重复 ID：${ids.filter((v, i) => ids.indexOf(v) !== i)}`);
  ok(ALL_OBJECTS.length === 199, `ALL_OBJECTS 总数 ${ALL_OBJECTS.length} ≠ 199（188 + 1 看门狗 + 4 + 6 河岸柳）`);
  ok(CIVIC.length === 4, `新建公共场所 ${CIVIC.length} 处 ≠ 4`);
  ok(STATS.civic === 4, `STATS.civic ${STATS.civic} ≠ 4`);
  ok(STATS.civicSites === 5, `STATS.civicSites ${STATS.civicSites} ≠ 5（4 处新建 + F-02）`);
  ok(CIVIC.every((c, i) => c.id === `C-${String(i + 1).padStart(2, '0')}`), 'C-* 编号不连续');
  ok(CIVIC.every((c) => c.type === 'civic'), '存在 type ≠ civic 的条目');
  const kinds = new Set(CIVIC.map((c) => c.kind));
  for (const k of ['shop', 'clinic', 'stage', 'culture']) ok(kinds.has(k), `缺少场所类型 ${k}`);
  for (const c of CIVIC) {
    for (const k of ['name', 'category', 'use', 'scope', 'size', 'structure', 'status', 'note']) {
      ok(typeof c[k] === 'string' && c[k].length > 0, `${c.id} 缺档案字段 ${k}`);
    }
    ok(Number.isFinite(c.area) && c.area > 0, `${c.id} area 非法`);
    ok(Number.isFinite(c.built), `${c.id} 缺建成年份`);
    ok(Array.isArray(c.footprint) && c.footprint.length === 2, `${c.id} footprint 非法`);
    ok(Number.isFinite(c.radius) && c.radius > 0, `${c.id} radius 非法`);
    // radius 必须能包住 footprint 的半对角线，否则 controls.js 的碰撞圆会漏墙角。
    // radius 在 data.js 里只保留 2 位小数，容差取 0.02 m。
    const diag = Math.hypot(c.footprint[0] / 2, c.footprint[1] / 2);
    ok(c.radius + 0.02 >= diag, `${c.id} radius ${c.radius} 明显小于半对角线 ${diag.toFixed(3)}`);
    ok(Math.abs(+(c.footprint[0] * c.footprint[1]).toFixed(2) - c.area) < 0.01,
      `${c.id} area ${c.area} ㎡ ≠ footprint 乘积 ${(c.footprint[0] * c.footprint[1]).toFixed(2)} ㎡`);
  }

  /* 2. 全村统计口径：与 verify-cards.mjs 的 Σ 算法逐项一致 */
  const committee = FACILITIES.find((f) => f.id === 'F-02');
  ok(!!committee, '找不到 F-02 村委会');
  const pop = HOUSES.reduce((s, h) => s + h.residents, 0);
  const farmScene = FIELDS.reduce((s, f) => s + f.area, 0);
  const farmCard = HOUSES.reduce((s, h) => s + h.farmland, 0);
  if (committee) {
    ok(committee.population === pop,
      `F-02 全村人口 ${committee.population} 人 ≠ ΣHOUSES.residents ${pop} 人`);
    ok(committee.farmlandTotal === farmScene,
      `F-02 耕地总面积 ${committee.farmlandTotal} 亩 ≠ ΣFIELDS.area ${farmScene} 亩`);
    ok(committee.farmlandTotal === farmCard,
      `F-02 耕地总面积 ${committee.farmlandTotal} 亩 ≠ ΣHOUSES.farmland ${farmCard} 亩`);
    ok(committee.population === 43 && committee.farmlandTotal === 513,
      'F-02 卡片口径不是任务 03 的 43 人 / 513 亩');
  }
  ok(STATS.residents === pop, `STATS.residents ${STATS.residents} ≠ ${pop}`);
  ok(STATS.farmland === farmScene, `STATS.farmland ${STATS.farmland} ≠ ${farmScene}`);
  ok(pop === 43 && farmScene === 513, `全村基线变了：${pop} 人 / ${farmScene} 亩（应为 43 / 513）`);

  /* 3. 障碍清单（与 verify-production.mjs 同一份口径） */
  const rects = [];
  const circles = [];
  for (const f of FIELDS) rects.push({ cx: f.pos[0], cz: f.pos[2], hx: f.size[0] / 2, hz: f.size[1] / 2,
    rot: f.rot, name: f.id, group: '耕地' });
  for (const h of HOUSES) rects.push({ cx: h.pos[0], cz: h.pos[2], hx: h.yard.w / 2 + 0.3, hz: h.yard.d / 2 + 0.3,
    rot: h.rot, name: h.id, group: '院墙' });
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
  for (const t of TREES) circles.push({ x: t.pos[0], z: t.pos[2], r: 1.0, name: t.id });
  for (const z of POWER_LINE.zs) circles.push({ x: roadX(z) - POWER_LINE.offset, z, r: 0.6, name: '杆脚@' + z });
  for (const p of PRODUCTION) circles.push({ x: p.pos[0], z: p.pos[2], r: p.radius, name: p.id });

  function check(c) {
    const [x, , z] = c.pos;
    const hx = c.footprint[0] / 2;
    const bad = [];
    // 主路是按 x 方向的走廊，用 footprint 的 x 半宽而不是外接圆半径
    let clearance = Math.abs(x - roadX(z)) - (ROAD.width / 2 + ROAD_SHOULDER + hx);
    if (clearance < MARGIN) bad.push('主路');
    for (const R of rects) {
      const d = distRect(x, z, R) - c.radius;   // 外接圆，保守估计
      if (d < clearance) clearance = d;
      if (d < MARGIN) bad.push(`${R.group}:${R.name}`);
    }
    for (const C of circles) {
      const d = Math.hypot(x - C.x, z - C.z) - c.radius - C.r;
      if (d < clearance) clearance = d;
      if (d < MARGIN) bad.push(C.name);
    }
    return { bad, clearance };
  }

  const rows = [];
  let minClear = Infinity;
  for (const c of CIVIC) {
    const [x, y, z] = c.pos;
    ok([x, y, z].every(Number.isFinite), `${c.id} pos 含非数字`);
    ok(y === 0, `${c.id} pos.y 应为 0（标高由 heightAt 取）`);
    const r = check(c);
    if (r.bad.length) errors.push(`${c.id} ${c.category} 与 ${r.bad.join(' / ')} 冲突（净空 ${r.clearance.toFixed(2)} m）`);
    minClear = Math.min(minClear, r.clearance);
    rows.push({ id: c.id, 场所: c.category, 位置: `${x.toFixed(2)}, ${z.toFixed(2)}`,
      占地: c.size, 占位半径: c.radius.toFixed(2), 离路中线: Math.abs(x - roadX(z)).toFixed(2),
      净空: r.clearance.toFixed(2), 冲突: r.bad.length ? r.bad.join(',') : '—' });
  }

  // 彼此边缘净距：按 footprint 轴对齐矩形算，不能用外接圆（会把窄缝误判成重叠）
  const boxes = CIVIC.map((c) => ({ id: c.id, x: c.pos[0], z: c.pos[2],
    hx: c.footprint[0] / 2, hz: c.footprint[1] / 2 }));
  let minGap = Infinity, gapPair = '';
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const g = rectGap(boxes[i], boxes[j]);
    if (g < minGap) { minGap = g; gapPair = `${boxes[i].id} ↔ ${boxes[j].id}`; }
    ok(g >= 3.0, `${boxes[i].id} 与 ${boxes[j].id} 边缘净距 ${g.toFixed(2)} m < 3.0 m（挤在一处）`);
  }

  /* 4. 巡游第 2 段：路径不出主路、不穿场所，末帧视锥带得到公共核心 */
  const shot = parseShot2(src.tour);
  ok(!!shot, '无法从 js/tour.js 解析出第 2 段镜头');
  let tourClear = Infinity, inView = 0, committeeInView = false;
  if (shot) {
    ok(shot.count === 6, `巡游镜头 ${shot.count} 段 ≠ 6`);
    ok(shot.to.z > -70, `第 2 段没延长到村中心（to.z = ${shot.to.z}）`);
    // 贴地 1.8 m 机位会被 2 m 院墙与行道树挡住；实测 8 m 树冠仍糊屋顶，
    // 10 m 时卫生室红十字 / 小卖部红瓦顶 / 村委会二层楼同框且不遮挡，
    // 12 m 孤山与天空占比过大。静态校验防止以后误删抬升或改回贴地。
    ok(shot.rise >= 8 && shot.rise <= 12,
      `第 2 段 rise = ${shot.rise} m，不在 8~12 m 的实测可用区间`);
    ok(/\(\s*shot\.rise\s*\|\|\s*0\s*\)\s*\*\s*p\s*\*\s*p/.test(src.tour),
      'js/tour.js 的 update() 没有把 rise 按 p² 作用到相机高度');
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const x = shot.from.x + (shot.to.x - shot.from.x) * t;
      const z = shot.from.z + (shot.to.z - shot.from.z) * t;
      const off = Math.abs(x - roadX(z));
      ok(off <= ROAD.width / 2, `巡游第 2 段 t=${t.toFixed(2)} 偏出主路走廊 ${off.toFixed(2)} m`);
      for (const c of CIVIC) {
        const d = Math.hypot(x - c.pos[0], z - c.pos[2]) - c.radius;
        tourClear = Math.min(tourClear, d);
        ok(d >= 2.0, `巡游第 2 段 t=${t.toFixed(2)} 穿过 ${c.id}（净距 ${d.toFixed(2)} m）`);
      }
    }
    // 末帧水平视锥：forward 与看向点同向，公共场所须落在 ±HALF_FOV_H 内
    const fwd = Math.atan2(shot.to.look[0] - shot.to.x, shot.to.look[2] - shot.to.z) * 180 / Math.PI;
    const ang = (x, z) => {
      let a = Math.atan2(x - shot.to.x, z - shot.to.z) * 180 / Math.PI - fwd;
      while (a > 180) a -= 360;
      while (a < -180) a += 360;
      return a;
    };
    // 垂直视锥：相机 y = 地形(近似 0) + 眼高 + rise*p²；看向点 y 由 tour.js 给定。
    // 目标取建筑屋脊高度 3.5 m，比较目标仰俯角与视线仰俯角的差。
    const camY = EYE + shot.rise;
    const horiz = Math.hypot(shot.to.look[0] - shot.to.x, shot.to.look[2] - shot.to.z);
    const pitch = Math.atan2(shot.to.look[1] - camY, horiz) * 180 / Math.PI;
    const vang = (x, z) => {
      const d = Math.hypot(x - shot.to.x, z - shot.to.z);
      return Math.atan2(3.5 - camY, d) * 180 / Math.PI - pitch;
    };
    for (const c of CIVIC) {
      const inH = Math.abs(ang(c.pos[0], c.pos[2])) <= HALF_FOV_H;
      const inV = Math.abs(vang(c.pos[0], c.pos[2])) <= HALF_FOV_V;
      if (inH && inV) inView++;
    }
    if (committee) {
      committeeInView = Math.abs(ang(committee.pos[0], committee.pos[2])) <= HALF_FOV_H
        && Math.abs(vang(committee.pos[0], committee.pos[2])) <= HALF_FOV_V;
    }
    ok(inView >= 2, `巡游第 2 段末帧只带到 ${inView} 处公共场所（要求 ≥ 2）`);
    ok(committeeInView, '巡游第 2 段末帧没带到 F-02 村委会');
  }

  /* 5. 接线静态检查：防止以后改 SCHEMA / QA / 碰撞 / 镜头时漏掉公共核心 */
  ok(/\bcivic:\s*\{/.test(src.ui), 'js/ui.js 里找不到 SCHEMA.civic');
  ok(/\['population',\s*'全村常住人口'/.test(src.ui), 'js/ui.js 缺少 population 行');
  ok(/\['farmlandTotal',\s*'全村耕地总面积'/.test(src.ui), 'js/ui.js 缺少 farmlandTotal 行');
  ok(/out\.push\(`civic\s/.test(src.main), 'js/main.js 的 ?qa=1 面板缺少 civic 行');
  ok(/CIVIC\.map\(/.test(src.controls), 'js/controls.js 缺少公共核心碰撞圆');
  ok(/civicMeshes/.test(src.world) && /CIVIC_PROXY/.test(src.world), 'js/world.js 缺少公共核心合批或拾取代理');

  return {
    errors, rows, summary: {
      all: ALL_OBJECTS.length, pop, farm: farmScene, minClear, minGap, gapPair,
      tourClear, inView, committeeInView, shot: shot && { dur: shot.dur, rise: shot.rise, to: shot.to },
    },
  };
}

/* ---------- 执行 ---------- */
const src = {
  ui: FILE('js/ui.js'), main: FILE('js/main.js'), controls: FILE('js/controls.js'),
  world: FILE('js/world.js'), tour: FILE('js/tour.js'),
};

if (process.argv.includes('--self-test')) {
  /* 负向自测：把 C-01 从 (40,-13) 挪到主路中线 (0,-13)，只在内存里改，
   * 源码保持不动。预期脚本报「主路」冲突且退出码为 0（表示自测成功）。 */
  const raw = FILE('js/data.js');
  const tampered = raw.replace("pos: [40.00, 0, -13.00]", "pos: [0.00, 0, -13.00]");
  if (tampered === raw) { console.error('✗ 负向自测找不到 C-01 的坐标字面量'); process.exit(1); }
  const tmp = join(tmpdir(), `verify-civic-negative-${process.pid}.mjs`);
  writeFileSync(tmp, tampered, 'utf8');
  let D;
  try { D = await import(pathToFileURL(tmp).href); }
  finally { rmSync(tmp, { force: true }); }
  const r = run(D, src);
  const hitRoad = r.errors.some((e) => e.includes('C-01') && e.includes('主路'));
  console.log(`负向自测：把 C-01 挪进主路后报错 ${r.errors.length} 项，含主路冲突 = ${hitRoad}`);
  if (!hitRoad) {
    for (const e of r.errors.slice(0, 5)) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✅ 负向自测通过：落位冲突能被检出');
  process.exit(0);
}

const D = await import('../js/data.js');
const r = run(D, src);

console.log('公共核心落位对照表（坐标 / 半径 / 净空，单位 m）');
console.table(r.rows);
const s = r.summary;
console.log(`ALL_OBJECTS = ${s.all}（189 + 10）；公共场所 = 5 处（C-01~C-04 + F-02）`);
console.log(`全村口径：${s.pop} 人 / ${s.farm} 亩（ΣHOUSES.residents / ΣFIELDS.area，与 verify-cards.mjs 一致）`);
console.log(`到最近障碍净空 ${s.minClear.toFixed(2)} m；彼此边缘最小净距 ${s.minGap.toFixed(2)} m（${s.gapPair}）`);
if (s.shot) console.log(`巡游第 2 段：${s.shot.dur}s → (${s.shot.to.x}, ${s.shot.to.z})，渐进抬升 ${s.shot.rise} m，`
  + `末帧带到 ${s.inView} 处公共场所 / 村委会 ${s.committeeInView ? '可见' : '不可见'}；`
  + `路径到场所最小净距 ${s.tourClear.toFixed(2)} m`);

if (r.errors.length) {
  console.error(`\n❌ 校验失败，共 ${r.errors.length} 项：`);
  for (const e of r.errors.slice(0, 30)) console.error('  - ' + e);
  if (r.errors.length > 30) console.error(`  ... 另有 ${r.errors.length - 30} 项`);
  process.exit(1);
}
console.log('\n✅ 全部通过：编号、档案、全村口径、主路、耕地、院墙、场院、杆脚、彼此间距、巡游镜头、接线');
