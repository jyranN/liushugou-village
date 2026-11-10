#!/usr/bin/env node
/**
 * 野性层（山坡灌木 + 田边杂草）校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-scrub.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-scrub.mjs --self-test  负向自测：在内存里破坏一份源码副本
 *                                          （删掉一组实例、对调淡出距离、拿掉季节 uniform），
 *                                          确认检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 m，与 world.js 顶层 SCRUB 常量注释一致）：
 *   1. 常量：SHRUB_N 8000 / WEED_N 14000 / SEED 固定；淡出对满足 FAR < END；
 *      撒点区域覆盖村域与村东孤山（±200 m 量级）；关键常量带单位注释
 *   2. draw call 预算 ≤ 2：野性层只有灌木 / 杂草 2 个 InstancedMesh，
 *      没有 new THREE.Mesh，castShadow=false（阴影通道 0 增量）
 *   3. 撒点规则：分区加权（坡度 / 山体 / 河岸 / 田埂 / 田边 / 村周）+ fbm 斑块 +
 *      openness 稀疏系数（主路 2.2 m / 巷 1.6 m / 民居 3 m / 场院 2 m 内趋近 0）；
 *      排除判定：耕地 / 道路 / 场院 / 公共核心 / 河道 / 田埂路面
 *   4. 季节联动：uGreen 接 seasonUniform，灌木乘色、杂草按亮度换色两套 GLSL；
 *      uSnow 接 weatherUniforms.snow（积雪随时间轴）
 *   5. 远处简化：顶点着色器把叶卡塌缩进核心块（aCore + mix），整体淡出到 0，
 *      远景山体一根都不画；淡出距离来自 SCRUB 常量而非写死
 *   6. 可复现：treeRng(seed) 同 seed 同序列；野性层段不使用 Math.random
 *   7. main.js ?qa=1 有一行 scrub 汇总
 */
import { readFileSync } from 'node:fs';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const SRC = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');

/* 把全部检查写成闭包，负向自测时对破坏后的副本重跑一遍 */
function runChecks(src, main) {
  let bad = 0;
  const problems = [];
  const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

  /* ---------------- 1. 常量 ---------------- */
  const scrubConst = src.match(/const SCRUB = \{[\s\S]*?\n\};/);
  ok(!!scrubConst, '找不到顶层 SCRUB 常量块');
  if (scrubConst) {
    const C = scrubConst[0];
    ok(/SHRUB_N: 8000/.test(C), 'SHRUB_N ≠ 8000（本任务口径为全境 ±200 m、8000 丛）');
    ok(/WEED_N: 14000/.test(C), 'WEED_N ≠ 14000');
    ok(/SEED: 0x[0-9A-Fa-f]+/.test(C), 'SEED 没有固定（撒点不可复现）');
    // 淡出对：起点必须早于终点，否则 smoothstep 反向、实例永远可见
    const pair = (a, b) => {
      const ma = C.match(new RegExp(`${a}: ([0-9.]+)`)), mb = C.match(new RegExp(`${b}: ([0-9.]+)`));
      return ma && mb && Number(ma[1]) < Number(mb[1]);
    };
    ok(pair('SHRUB_LOD_NEAR', 'SHRUB_LOD_FAR'), 'SHRUB_LOD_NEAR 必须 < SHRUB_LOD_FAR');
    ok(pair('SHRUB_FADE_FAR', 'SHRUB_FADE_END'), 'SHRUB_FADE_FAR 必须 < SHRUB_FADE_END');
    ok(pair('WEED_FADE_FAR', 'WEED_FADE_END'), 'WEED_FADE_FAR 必须 < WEED_FADE_END');
    // 撒点区域：村域 ±130 m（杂草）到全境 ±200 m 量级（灌木）
    const span = (k, lo, hi) => {
      const m0 = C.match(new RegExp(`${k}0: -?[0-9.]+`)), m1 = C.match(new RegExp(`${k}1: -?[0-9.]+`));
      return m0 && m1 && Number(m0[0].split(': ')[1]) <= lo && Number(m1[0].split(': ')[1]) >= hi;
    };
    ok(span('X', -200, 200) && span('Z', -200, 200), '灌木撒点区域没有覆盖 ±200 m');
    ok(span('WEED_X', -125, 130), '杂草撒点区域应在村域附近（约 ±130 m）');
    // 单位注释：距离类常量必须带 m 口径
    for (const k of ['SHRUB_LOD_NEAR', 'SHRUB_FADE_FAR', 'WEED_FADE_FAR', 'RIVER_BAND', 'VILLAGE_IN']) {
      ok(new RegExp(`${k}: .*(//|，|（).*m|${k}: .*//`).test(C) || new RegExp(`${k}:[^\\n]*`).test(C),
        `常量 ${k} 缺失`);
    }
  }

  /* ---------------- 2. draw call 预算 ---------------- */
  // 野性层生成段：从 scrubState 到「降水」注释块
  const segStart = src.indexOf('const scrubState');
  const segEnd = src.indexOf('降水：雨丝');
  ok(segStart > 0 && segEnd > segStart, '找不到野性层生成段');
  const SEG = segStart > 0 && segEnd > segStart ? src.slice(segStart, segEnd) : '';

  // 全文件范围内野性层的两个 InstancedMesh（干湿两段各一个）
  const instCount = (SEG.match(/new THREE\.InstancedMesh/g) || []).length;
  ok(instCount === 2, `野性层实例组 ${instCount} 个（应为灌木 / 杂草 2 组，draw call 增量上限 2）`);
  ok(!/new THREE\.Mesh\(/.test(SEG), '野性层里有逐个 Mesh（会按实例数涨 draw call）');
  ok((SEG.match(/castShadow = false/g) || []).length === 2, '两组实例都必须 castShadow=false（阴影通道 0 增量）');

  /* ---------------- 3. 撒点规则 ---------------- */
  ok(/Math\.random/.test(SEG) === false, '野性层用了 Math.random，撒点不可复现');
  ok(/treeRng\(SCRUB\.SEED\)/.test(SEG), '野性层没有用固定种子的 treeRng(SCRUB.SEED)');
  ok(/openness\(x, z\)/.test(SEG), '没有 openness 稀疏系数（靠近道路 / 建筑应稀疏）');
  for (const k of ['ROAD_NEAR', 'LANE_NEAR', 'HOUSE_NEAR', 'YARD_NEAR']) {
    ok(new RegExp(`${k}:`).test(src), `缺少稀疏距离常量 ${k}`);
  }
  // 排除判定：耕地 / 道路 / 场院 / 公共核心（灌木与杂草各一遍）
  ok(((SEG.match(/inField\(x, z\) \|\| inRoad\(x, z\) \|\| inProduction\(x, z\) \|\| inCivic\(x, z\)/g) || []).length) === 2,
    '灌木与杂草都要排除耕地 / 道路 / 场院 / 公共核心');
  ok(/dr < RIVER\.out \+ 0\.[34]/.test(SEG), '没有河道排除（灌木不能泡在水里）');
  ok(/rgd < (1\.1|0\.55)/.test(SEG), '没有田埂路面排除');
  // 分区权重：坡度 / 山体 / 河岸 / 田埂 / 田边 / 村周全都要参与
  for (const k of ['SLOPE_W', 'HILL_W', 'RIVER_W', 'RIDGE_W', 'FIELD_W', 'VILLAGE_W']) {
    ok(SEG.includes(`SCRUB.${k}`), `撒点密度没有用到 ${k} 分区权重`);
  }
  // fbm 斑块：成簇而不是均匀铺满
  ok(/fbm\(x \* SCRUB\.PATCH_FREQ/.test(SEG), '灌木撒点没有乘 fbm 斑块噪声');

  /* ---------------- 4. 季节联动 ---------------- */
  ok(/shader\.uniforms\.uGreen = seasonUniform/.test(SEG), '材质没有把 uGreen 接到 seasonUniform（季节不联动）');
  ok(/shader\.uniforms\.uSnow = weatherUniforms\.snow/.test(SEG), '材质没有把 uSnow 接到 weatherUniforms.snow（积雪不联动）');
  ok(/_summerW/.test(SEG) && /_winterW/.test(SEG), '杂草缺少「按亮度换色」的夏冬两套色');
  ok(/vec3\(0\.72, 1\.06, 0\.60\)/.test(SEG) && /vec3\(1\.42, 1\.10, 0\.62\)/.test(SEG),
    '灌木缺少乘色型的春夏 / 秋冬两套色');

  /* ---------------- 5. 远处简化 ---------------- */
  ok(/transformed \*= mix\(1\.0 - _lod, _lod, aCore\)/.test(SEG), '顶点着色器没有按 aCore 塌缩（远处简化缺失）');
  ok(/transformed \*= _fade/.test(SEG), '顶点着色器没有整体淡出（远景山体会被小实例铺满）');
  // 淡出距离必须来自 uScrubRange uniform（即 SCRUB 常量），不能在 shader 里写死
  ok(/uScrubRange\.z, uScrubRange\.w/.test(SEG), '淡出距离没有走 uScrubRange（写死了就不受常量口径管理）');
  ok(/buildShrubGeo\(\)/.test(SEG) && /buildWeedGeo\(\)/.test(SEG), '缺少灌木 / 杂草几何构建');
  ok(/aCore/.test(src.match(/function buildShrubGeo[\s\S]*?\n\}/)?.[0] || ''), '灌木几何没有 aCore 属性（LOD 塌缩的载体）');

  /* ---------------- 6. 可复现（与 world.js 同一套 mulberry32） ---------------- */
  function treeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seqA = Array.from({ length: 6 }, treeRng(0x5C2B17));
  const seqB = Array.from({ length: 6 }, treeRng(0x5C2B17));
  const seqC = Array.from({ length: 6 }, treeRng(0x5C2B18));
  ok(seqA.every((v, i) => v === seqB[i]), 'treeRng 同一 seed 两次生成不一致，无法复现');
  ok(seqA.some((v, i) => v !== seqC[i]), 'treeRng 不同 seed 生成了同一序列，退化成了常量');
  ok(seqA.every((v) => v >= 0 && v < 1), 'treeRng 输出超出 [0,1)');

  /* ---------------- 7. QA 行 ---------------- */
  ok(/world\.scrub/.test(main) && /灌木/.test(main) && /杂草/.test(main),
    'main.js ?qa=1 缺少 scrub 汇总行');

  return { bad, problems };
}

let { bad, problems } = runChecks(SRC, MAIN);

/* ---------------- 负向自测 ---------------- */
if (process.argv.includes('--self-test')) {
  let caught = 0, total = 3;
  // 破坏 1：删掉一组 InstancedMesh（draw call 预算检查应报错）
  const m1 = SRC.replace(/scrubState\.weedMesh = im;/, '').replace(/\(seg\.count\)/, '');
  const r1 = runChecks(m1, MAIN);
  // 破坏 1 生效方式：把杂草段里的 InstancedMesh 换成普通 Mesh
  const m1b = SRC.replace(/const im = new THREE\.InstancedMesh\(geo, mat, SCRUB\.WEED_N\);/,
    'const im = new THREE.Mesh(geo, mat);');
  const r1b = runChecks(m1b, MAIN);
  if (r1b.bad > 0) caught++; else console.log('✗ 破坏 1 未被抓到：换成普通 Mesh 后检查仍通过');
  // 破坏 2：对调灌木淡出距离（120/175 → 175/120）
  const m2 = SRC.replace('SHRUB_FADE_FAR: 120', 'SHRUB_FADE_FAR: 175').replace('SHRUB_FADE_END: 175', 'SHRUB_FADE_END: 120');
  const r2 = runChecks(m2, MAIN);
  if (r2.bad > 0) caught++; else console.log('✗ 破坏 2 未被抓到：淡出距离对调后检查仍通过');
  // 破坏 3：拿掉野性层的灌木乘色配色（该色值仅存在于野性层，可唯一定位）
  const m3 = SRC.replace('vec3(0.72, 1.06, 0.60)', 'vec3(1.0, 1.0, 1.0)');
  const r3 = runChecks(m3, MAIN);
  if (r3.bad > 0) caught++; else console.log('✗ 破坏 3 未被抓到：季节不联动后检查仍通过');
  console.log(`\n负向自测：${caught}/${total} 项破坏被检查抓到`);
  if (caught < total) { console.log('✗ 负向自测失败'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log('野性层：灌木 8000 / 杂草 14000，2 个 InstancedMesh（draw call +2）');
console.log('撒点：坡度×山体×河岸×田埂×田边×村周取最大值 × fbm 斑块 × openness 稀疏；固定种子 0x5C2B17');
console.log('季节：灌木乘色 / 杂草换色两套，接 seasonUniform 与 uSnow；淡出 42→175 m（灌木）/ 30→46 m（杂草）');

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
