#!/usr/bin/env node
/**
 * 旱作农业元素（v1.2 第十轮：地膜 / 篱笆 / 田埂）校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-farm.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-farm.mjs --self-test  负向自测：内存里破坏三份源码副本
 *                                          （z-fight 防护失效 / 地膜不跟 g / 田埂拆回逐 Mesh），
 *                                          确认检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 m / rad，与 world.js 注释一致）：
 *   1. 田块数据：FIELDS 14 块、蔬菜地恰 2 块（L-05 门前菜地 / L-13 门前园子，栅栏目标）
 *   2. 田埂合并：56 条边埂 → 1 个 Mesh（不再逐条 new THREE.Mesh）；
 *      宽窄随地形（heightAt 采样高差，宽 0.5→0.7 m、高 0.34→0.42 m）
 *   3. 地膜：恰 1 个 InstancedMesh；uFieldG 接线（跟时间轴）；覆盖度
 *      播种淡入（0.001→0.02）× 出苗揭膜（0.10→0.20）；小麦不覆膜；
 *      抬高 0.012 m + polygonOffset −2 双保险；白膜（玉米/蔬菜）与黑膜（药材）instanceColor
 *   4. 篱笆：围两块蔬菜地（田埂外 0.8 m）、立柱约 2.2 m 一根 + 双横杆（0.52/0.92 m）、
 *      合并 1 个 Mesh；随机散段已拆除且 between() 消耗保留（随机序列零消耗）
 *   5. draw call 预算 ≤4：旱作轮新增恰 3 个 Mesh（田埂 1 + 篱笆 1 + 地膜 InstancedMesh 1）
 *   6. main.js ?qa=1 有 farm 汇总行
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
const DATAJS = readFileSync(new URL('../js/data.js', import.meta.url), 'utf8');
const selfTest = process.argv.includes('--self-test');

async function runChecks(src, main, selfTest = false) {
  let bad = 0;
  const problems = [];
  const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

  /* ---------------- 1. 田块数据（import data.js 重算；自测模式跳过） ---------------- */
  if (!selfTest) {
    const D = await import(new URL('../js/data.js', import.meta.url) + `?t=${Date.now()}`);
    ok(D.FIELDS.length === 14, `FIELDS ${D.FIELDS.length} ≠ 14 块`);
    const veg = D.FIELDS.filter((f) => f.crop === '蔬菜');
    ok(veg.length === 2 && veg.some((f) => f.id === 'L-05') && veg.some((f) => f.id === 'L-13'),
      `蔬菜地应为 L-05 / L-13 两块（实际 ${veg.map((f) => f.id).join(',')}）`);
    ok(D.FIELDS.every((f) => typeof f.rot === 'number' && f.size?.length === 2 && f.pos?.length === 3),
      'FIELDS 缺 rot/size/pos 字段（栅栏与地膜变换依赖）');
  }

  /* ---------------- 2. 田埂合并 + 宽窄随地形 ---------------- */
  const fStart = src.indexOf('/* ================= 田块');
  const fEnd = src.indexOf('/* ================= 村口树下');
  ok(fStart > 0 && fEnd > fStart, '找不到田块段');
  const FSEG = fStart > 0 && fEnd > fStart ? src.slice(fStart, fEnd) : '';
  ok(/const ridgeGeos = \[\]/.test(FSEG), '缺少田埂几何收集数组 ridgeGeos');
  ok((FSEG.match(/new THREE\.BoxGeometry\(w, h, d\)/g) || []).length === 1
    && /mergeGeometries\(ridgeGeos/.test(FSEG), '田埂没有合并成 1 个 Mesh（仍是逐条 Mesh 会涨 draw call）');
  ok(!/new THREE\.Mesh\(new THREE\.BoxGeometry\(w, 0\.34, d\), ridgeMat\)/.test(FSEG),
    '旧的逐条田埂 Mesh 还在（56 draw call 未合并）');
  ok((FSEG.match(/root\.add\(new THREE\.Mesh/g) || []).length === 0,
    '田块段不应直接 add 逐个 new Mesh（合并田埂应先建后 add；出现即逐条回潮）');
  // 宽窄随地形：heightAt 采样 + 下坡加宽 0.2、加高 0.08
  ok(/const drop = y - heightAt\(wx, wz\)/.test(FSEG), '田埂没有按地形高差采样（宽窄随地形缺失）');
  ok(/ax \+ 0\.2 \* k/.test(FSEG) && /0\.34 \+ 0\.08 \* k/.test(FSEG),
    '田埂宽窄随地形的数值口径不在（宽 +0.2 m / 高 +0.08 m）');

  /* ---------------- 3. 地膜 ---------------- */
  const cStart = src.indexOf('地膜：西北旱作的高辨识度元素');
  const cEnd = src.indexOf('const plantT = TEX.cropPlant()');
  ok(cStart > 0 && cEnd > cStart, '找不到地膜段');
  const CSEG = cStart > 0 && cEnd > cStart ? src.slice(cStart, cEnd) : '';
  ok((CSEG.match(/new THREE\.InstancedMesh\(filmGeo, filmMat, strips\.length\)/g) || []).length === 1,
    '地膜应恰好 1 个 InstancedMesh（draw call 预算）');
  ok(/shader\.uniforms\.uFieldG = cropUniforms\.uFieldG/.test(CSEG),
    '地膜没有接 uFieldG（不跟作物状态/时间轴）');
  ok(/smoothstep\(0\.001, 0\.02, _fg\)/.test(CSEG) && /1\.0 - smoothstep\(0\.10, 0\.20, _fg\)/.test(CSEG),
    '地膜覆盖度公式不在（播种淡入 0.001→0.02、出苗揭膜 0.10→0.20）');
  ok(/transformed\.x \*= _film;/.test(CSEG) && /transformed\.z \*= _film;/.test(CSEG),
    '地膜收起时应把条带退化成一点（缩放塌缩缺失）');
  // z-fighting 双保险：抬高 + polygonOffset
  ok(/cy \+ 0\.062/.test(CSEG), '地膜没有在田面上方 0.012 m（0.05 田面 + 0.012 = 0.062）');
  ok(/polygonOffsetFactor: -2/.test(CSEG) && /polygonOffsetUnits: -2/.test(CSEG),
    '地膜缺少 polygonOffset −2（z-fighting 第二道保险）');
  // 小麦不覆膜 + 黑白两色
  ok(/filter\(\(f\) => f\.crop !== '小麦'\)/.test(CSEG), '小麦应不覆膜（filter 排除缺失）');
  ok(/colWhite/.test(CSEG) && /colBlack/.test(CSEG) && /setColorAt/.test(CSEG),
    '地膜缺少白膜/黑膜 instanceColor');
  // 与作物同一开关
  ok(src.indexOf('has(\'nocrop\')') > 0 && cStart > src.indexOf('has(\'nocrop\')'),
    '地膜段应放在 ?nocrop 分支内（与作物一致）');

  /* ---------------- 4. 篱笆 ---------------- */
  const gStart = src.indexOf('菜园 / 院前小块地木栅栏（v1.2');
  const gEnd = src.indexOf('/* ================= 漫水桥') > 0 ? src.indexOf('/* ================= 漫水桥') : gStart + 4000;
  ok(gStart > 0, '找不到菜园木栅栏段');
  const GSEG = gStart > 0 ? src.slice(gStart, gEnd) : '';
  ok(/filter\(\(ff\) => ff\.crop === '蔬菜'\)/.test(GSEG), '栅栏没有按「蔬菜地」围（应恰围 L-05 / L-13）');
  ok(/0\.8 m/.test(GSEG) || /\/ 2 \+ 0\.8/.test(GSEG), '栅栏线应在田埂外 0.8 m');
  ok(/for \(const hy of \[0\.52, 0\.92\]\)/.test(GSEG), '缺少双横杆（0.52 / 0.92 m）');
  ok(/Math\.round\(len \/ 2\.2\) \+ 1/.test(GSEG), '立柱间距应约 2.2 m');
  ok(/mergeGeometries\(fenceGeos/.test(GSEG), '栅栏没有合并成 1 个 Mesh');
  ok((GSEG.match(/new THREE\.Mesh\(/g) || []).length === 1, '栅栏段应只有 1 个合并 Mesh');
  // 随机散段拆除 + between 消耗保留
  const mStart = src.indexOf('================= 村内杂物');
  const mEnd = gStart;
  const MSEG = mStart > 0 && mEnd > mStart ? src.slice(mStart, mEnd) : '';
  ok(!/new THREE\.Mesh\(new THREE\.CylinderGeometry\(0\.055, 0\.07, 1\.15, 5\), fenceMat\)/.test(MSEG),
    '旧随机散篱笆（0.055/0.07/1.15 柱）还在');
  ok(/const ang = between\(0, Math\.PI\);/.test(MSEG),
    '随机散段拆除后必须保留 between() 消耗（随机序列零位移）');
  // 顶点色微差不消耗随机序列
  ok(/fenceSeq\+\+\) \* 137/.test(GSEG), '栅栏顶点色微差应使用确定性 hash（不消耗 rnd）');

  /* ---------------- 5. draw call 预算 ---------------- */
  // 旱作轮新增 Mesh：田埂 1（mergeGeometries(ridgeGeos)）+ 篱笆 1（mergeGeometries(fenceGeos)）
  // + 地膜 InstancedMesh 1 = 3 个，任务上限 ≤4
  const newMeshes =
    (FSEG.match(/new THREE\.Mesh\(mergeGeometries\(ridgeGeos/g) || []).length
    + (GSEG.match(/new THREE\.Mesh\(mergeGeometries\(fenceGeos/g) || []).length
    + (CSEG.match(/new THREE\.InstancedMesh\(filmGeo/g) || []).length;
  ok(newMeshes === 3, `旱作轮新增绘制对象 ${newMeshes} 个（应为田埂 1 + 篱笆 1 + 地膜 1 = 3，上限 4）`);

  /* ---------------- 6. QA 行 ---------------- */
  ok(/world\.farm/.test(main) && /地膜/.test(main) && /篱笆/.test(main),
    'main.js ?qa=1 缺少 farm 汇总行');

  return { bad, problems };
}

let { bad, problems } = await runChecks(SRC, MAIN, selfTest);

/* ---------------- 负向自测 ---------------- */
if (selfTest) {
  let caught = 0, total = 3;
  // 破坏 1：拿掉 z-fighting 双保险（抬高与 polygonOffset）
  const m1 = SRC.replace('cy + 0.062', 'cy + 0.0505')
    .replace('polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,', '');
  const r1 = await runChecks(m1, MAIN, true);
  if (r1.bad > 0) caught++; else console.log('✗ 破坏 1 未被抓到：z-fight 防护失效后检查仍通过');
  // 破坏 2：地膜不再跟 g（覆盖度恒为 1，播种前与夏季都铺着）
  const m2 = SRC.replace(
    'float _film = smoothstep(0.001, 0.02, _fg) * (1.0 - smoothstep(0.10, 0.20, _fg));',
    'float _film = 1.0;');
  const r2 = await runChecks(m2, MAIN, true);
  if (r2.bad > 0) caught++; else console.log('✗ 破坏 2 未被抓到：地膜不跟时间轴后检查仍通过');
  // 破坏 3：田埂拆回逐 Mesh（draw call 超预算）
  // 更直接的破坏：把合并 Mesh 拆成逐条
  const m3b = SRC.replace('ridgeGeos.push(rgeo);',
    'ridgeGeos.push(rgeo); if (ridgeGeos.length === 1) { root.add(new THREE.Mesh(rgeo, ridgeMat)); }');
  const r3 = await runChecks(m3b, MAIN, true);
  if (r3.bad > 0) caught++; else console.log('✗ 破坏 3 未被抓到：田埂逐 Mesh 化后检查仍通过');
  console.log(`\n负向自测：${caught}/${total} 项破坏被检查抓到`);
  if (caught < total) { console.log('✗ 负向自测失败'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log('旱作元素：地膜 1 个 InstancedMesh（约 200 条带，白/黑按作物，播种铺/出苗揭）');
console.log('篱笆：围 L-05 / L-13 两块菜园，立柱 2.2 m + 双横杆，合并 1 Mesh；田埂：56 条合并 1 Mesh，宽窄随地形');
console.log('新增绘制对象 3 个（上限 4）；随机散篱笆拆除（净减 119 draw call）');

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
