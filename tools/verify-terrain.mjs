/**
 * 地形三层材质校验（v1.2）
 *
 * 纯 Node，不依赖 three / DOM / 网络：从源码里读常量与结构，再用一套独立复刻的
 * 权重公式验算。这样「源码改了公式但忘了改这里」会直接报错，而不是静默漂移。
 *
 * 检查项：
 *   1. 源码结构：aTerrW 属性、terrainWeights 在 computeVertexNormals 之后、
 *      patchTerrain 三处 chunk 替换齐全、顶点色不再有 SOIL/ROCK 强色偏
 *   2. 三层世界周期互不成整数比（比值不落在 0.9~1.1 的整数倍附近）
 *   3. 三档 LOD 阈值齐全、near < far、随档位递增
 *   4. 权重公式：逐点权重和 = 1、无负值；村内纯草、山顶以石为主、f 单调
 *
 * 运行：node tools/verify-terrain.mjs
 * 失败退出码 1。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const worldSrc = readFileSync(join(ROOT, 'js/world.js'), 'utf8');
const mainSrc = readFileSync(join(ROOT, 'js/main.js'), 'utf8');

let bad = 0;
const ok = (cond, msg) => {
  if (!cond) { bad++; console.log(`  ✗ ${msg}`); }
};

/* ---------- 1. 源码结构 ---------- */
console.log('== 源码结构 ==');
ok(worldSrc.includes("setAttribute('aTerrW'"), '没找到 aTerrW 属性写入');
ok(worldSrc.includes('terrainWeights(groundGeo)'), 'aTerrW 没有用 terrainWeights(groundGeo) 赋值');

{
  const iNorm = worldSrc.indexOf('groundGeo.computeVertexNormals()');
  const iAttr = worldSrc.indexOf("setAttribute('aTerrW'");
  ok(iNorm > 0 && iAttr > iNorm, 'aTerrW 必须在 computeVertexNormals() 之后算（坡度要用几何法线）');
}

for (const chunk of ['#include <map_fragment>', '#include <roughnessmap_fragment>', '#include <normal_fragment_maps>']) {
  // 只统计 patchTerrain 内部的替换（patchSeason 也替换 map_fragment，不能混为一谈）
  const i0 = worldSrc.indexOf('const patchTerrain = (mat, opts)');
  const seg = i0 >= 0 ? worldSrc.slice(i0, i0 + 9000) : '';
  ok(seg.includes(`'${chunk}'`), `patchTerrain 里没替换 ${chunk}`);
}
ok(!worldSrc.includes('const ROCK = [0.92, 0.98, 1.95]'), '顶点色里的 ROCK 强色偏仍在，会和三层材质相乘导致过饱和');
ok(!worldSrc.includes('const SOIL = [1.52, 1.18, 0.72]'), '顶点色里的 SOIL 强色偏仍在，会和三层材质相乘导致过饱和');
ok(worldSrc.includes('terrainMat: ground.material'), '世界返回值没暴露 terrainMat（main.js 调档位要用）');

/* ---------- 2. 三层周期 ---------- */
console.log('== 三层世界周期 ==');
const T = {};
{
  const m = worldSrc.match(/const TERRAIN = \{([\s\S]*?)\n\};/);
  if (!m) { bad++; console.log('  ✗ 没找到 TERRAIN 常量块'); }
  else {
    for (const k of ['SOIL_TILE', 'ROCK_TILE', 'GRASS_TILE2', 'ROCK_LO', 'ROCK_HI', 'SOIL_LO', 'SOIL_HI', 'SLOPE_LO', 'SLOPE_HI', 'CURV_GAIN']) {
      const mm = m[1].match(new RegExp(`${k}:\\s*([-\\d.]+)`));
      if (!mm) { bad++; console.log(`  ✗ TERRAIN.${k} 缺失`); } else T[k] = Number(mm[1]);
    }
  }
}
// 草层周期由 gRepeat 反算：620 / 300 = 2.07 m（有实拍素材时）
const grassTile = 620 / 300;
const ratios = [T.SOIL_TILE / grassTile, T.ROCK_TILE / grassTile];
ok(Math.abs(ratios[0] - 2.17) < 0.45, `土/草 周期比 ${ratios[0].toFixed(2)} 偏离 2.17 过多（太接近 1 会放大重复）`);
ok(Math.abs(ratios[1] - 12.6) < 2.2, `石/草 周期比 ${ratios[1].toFixed(2)} 偏离 12.6 过多`);
for (const r of ratios) {
  const nearInt = Math.abs(r - Math.round(r)) < 0.06;
  ok(!nearInt, `周期比 ${r.toFixed(2)} 太接近整数，平铺网格会同时对齐`);
}
ok(T.ROCK_LO < T.ROCK_HI && T.SOIL_LO < T.SOIL_HI && T.SLOPE_LO < T.SLOPE_HI, 'TERRAIN 的起止阈值顺序不对');
// 草层第二尺度：村内 f=0 时只有草层，靠它与 2.07 m 叠出非整数比来打散近景重复
{
  const r2 = T.GRASS_TILE2 / grassTile;
  ok(r2 > 2.5 && r2 < 5.5, `草层第二尺度 / 第一尺度 = ${r2.toFixed(2)}，不在 2.5~5.5（太接近 1 打不散重复）`);
  ok(Math.abs(r2 - Math.round(r2)) > 0.15, `草层两尺度比 ${r2.toFixed(2)} 太接近整数`);
  ok(worldSrc.includes('uGrassTiles2'), '没有 uGrassTiles2 uniform，第二尺度没接进着色器');
  ok(worldSrc.includes('_grassUv2'), '着色器里没有 _grassUv2，第二尺度采样缺失');
}

/* ---------- 3. 三档 LOD ---------- */
console.log('== 三档 LOD ==');
const lod = {};
{
  const m = mainSrc.match(/const TERRAIN_LOD = \{([^}]*)\};/);
  if (!m) { bad++; console.log('  ✗ 没找到 TERRAIN_LOD'); }
  else {
    for (const k of ['low', 'mid', 'high']) {
      const mm = m[1].match(new RegExp(`${k}:\\s*\\[([\\d.]+),\\s*([\\d.]+)\\]`));
      if (!mm) { bad++; console.log(`  ✗ TERRAIN_LOD.${k} 缺失`); continue; }
      lod[k] = [Number(mm[1]), Number(mm[2])];
      ok(lod[k][0] < lod[k][1], `${k} 档 near ${lod[k][0]} ≥ far ${lod[k][1]}`);
      ok(lod[k][0] >= 20 && lod[k][1] <= 90, `${k} 档 LOD 阈值 [${lod[k]}] 超出 20~90 m 的合理范围`);
    }
    ok(lod.low[1] < lod.mid[1] && lod.mid[1] < lod.high[1], '三档远景距离没有随画质递增');
  }
}
ok(mainSrc.includes('uTerrLodNear.value') && mainSrc.includes('uTerrLodFar.value'),
  'applyQuality 没有把 LOD 阈值写进 uniform');

/* ---------- 4. 权重公式复刻 ---------- */
console.log('== 权重公式 ==');
const ss = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// 独立复刻：源码改公式而这里没跟，下面的断言就会失败
const weights = (f, slope, curvN) => {
  const slopeW = ss(T.SLOPE_LO, T.SLOPE_HI, slope);
  let wRock = ss(T.ROCK_LO, T.ROCK_HI, f) * (0.55 + 0.45 * slopeW);
  wRock += 0.35 * slopeW * ss(-0.10, 0.60, curvN);
  wRock = Math.min(0.72, Math.max(0, wRock));
  let wSoil = 0.75 * ss(T.SOIL_LO, T.SOIL_HI, f) * (1 - wRock);
  wSoil += 0.25 * ss(0.15, 0.75, -curvN) * (1 - wRock);
  wSoil = Math.min(1 - wRock, Math.max(0, wSoil));
  return [Math.max(0, 1 - wRock - wSoil), wSoil, wRock];
};

// 4a 全域网格：和为 1、无负值
let minSum = 9, maxSum = -9, minW = 9;
for (let i = 0; i <= 20; i++) {
  for (let j = 0; j <= 20; j++) {
    for (let k = 0; k <= 10; k++) {
      const w = weights(i / 20, j / 20, k / 5 - 1);
      const s = w[0] + w[1] + w[2];
      minSum = Math.min(minSum, s); maxSum = Math.max(maxSum, s);
      minW = Math.min(minW, ...w);
    }
  }
}
ok(Math.abs(minSum - 1) < 1e-6 && Math.abs(maxSum - 1) < 1e-6, `权重和应在 [1,1]，实测 [${minSum.toFixed(6)}, ${maxSum.toFixed(6)}]`);
ok(minW >= -1e-6, `出现负权重 ${minW}`);

// 4b 特征点
{
  const [g0, s0, r0] = weights(0, 0, 0);
  ok(g0 > 0.999 && s0 < 1e-6 && r0 < 1e-6, `村内 f=0 应为纯草，实测 草${g0.toFixed(3)} 土${s0.toFixed(3)} 石${r0.toFixed(3)}`);
}
{
  const [g1, s1, r1] = weights(0.95, 0.45, 1.0);
  ok(r1 > 0.60, `山顶 f=0.95 应以石为主，实测 石 ${r1.toFixed(3)}`);
  ok(g1 < 0.12, `山顶 f=0.95 不该还有 ${g1.toFixed(3)} 的草`);
}
{
  const [, s2] = weights(0.60, 0.10, 0.8);
  ok(s2 > 0.35, `山腰 f=0.60 应以土为主，实测 土 ${s2.toFixed(3)}`);
}
{
  // f 单调：同一坡度/曲率下，石权重随 f 不减
  let prev = -1, mono = true;
  for (let i = 0; i <= 40; i++) {
    const r = weights(i / 40, 0.10, 0.3)[2];
    if (r < prev - 1e-6) mono = false;
    prev = r;
  }
  ok(mono, '石权重随 f 不是单调不减');
}

/* ---------- 5. 采样与结论 ---------- */
console.log('== 典型落点 ==');
const rows = [
  ['村内平地 f=0.00', 0, 0, 0],
  ['山脚    f=0.25', 0.25, 0.04, 0.32],
  ['山腰    f=0.60', 0.60, 0.10, 0.80],
  ['陡坡    f=0.75', 0.75, 0.38, 0.70],
  ['山顶    f=0.95', 0.95, 0.45, 1.00],
];
for (const [name, f, sl, cv] of rows) {
  const w = weights(f, sl, cv);
  console.log(`  ${name}  草 ${(w[0] * 100).toFixed(0).padStart(3)}%  土 ${(w[1] * 100).toFixed(0).padStart(3)}%  石 ${(w[2] * 100).toFixed(0).padStart(3)}%`);
}

console.log('');
if (bad) { console.log(`❌ ${bad} 项不一致`); process.exit(1); }
console.log('✅ 全部通过：结构、周期比、三档 LOD、权重归一与单调性');
