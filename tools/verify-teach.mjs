#!/usr/bin/env node
/**
 * 教学视图（v1.2 第十二轮：标注层 + 河谷剖面）校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-teach.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-teach.mjs --self-test  负向自测：内存里破坏三份源码副本
 *                                           （关闭不还原裁剪 / 标注写死数值 / 标签拆成逐个 Mesh），
 *                                           确认检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 m，与 world.js 教学视图段注释、CHANGELOG 一致）：
 *   1. 标注层：24 个标签（地名 10 + 地块编号 L-01…L-14）画进一张 canvas 图集，
 *      恰 1 个 InstancedMesh 广告牌（aUvRect + project_vertex 接管）= 1 draw call；
 *      等高线在地形 shader 内（uContour，2 m 间隔，fwidth 抗锯齿）= 0 draw call
 *   2. 剖面：裁剪平面 z=−60（保留南半）；开启挂 clippingPlanes、关闭全部还原 null；
 *      剖面填充面 1 个 quad，heightAt 逐列采样河床轮廓；
 *      尺寸标注读 RIVER 常量（下切 depth=2.2 m / 水位 waterY=−0.6 m / 水面宽 half×2≈8 m），不写死
 *   3. draw call 预算 ≤3：教学视图新增绘制对象恰 2（标签 InstancedMesh 1 + 剖面填充 1，等高线 0）
 *   4. 互斥与复原：main.js 进入第一人称 / 巡游前 closeAll 并提示；
 *      剖面开启保存 rig 机位、关闭还原；renderer.localClippingEnabled 开启
 *   5. 默认全关：labelMesh / sectionMesh visible=false
 *   6. main.js ?qa=1 有 teach 汇总行
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
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const selfTest = process.argv.includes('--self-test');

function runChecks(src, main, html) {
  let bad = 0;
  const problems = [];
  const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

  /* ---- 段定位：教学视图块（从 teachState 到 每帧动画）---- */
  const tStart = src.indexOf('教学视图：标注层 + 河谷剖面');
  const tEnd = src.indexOf('/* ================= 每帧动画');
  ok(tStart > 0 && tEnd > tStart, '找不到教学视图段');
  const TSEG = tStart > 0 && tEnd > tStart ? src.slice(tStart, tEnd) : '';

  /* ---------------- 1. 标注层 ---------------- */
  ok(/id="labelBtn"/.test(html) && /id="sectionBtn"/.test(html), 'index.html 缺 labelBtn / sectionBtn');
  ok(!/id="labelBtn"[^>]*class="[^"]*on/.test(html), '标注按钮应默认关闭（无 on 类）');
  ok(/createElement\('canvas'\)/.test(TSEG) && /CanvasTexture/.test(TSEG), '标签没有走 canvas 图集');
  ok((TSEG.match(/new THREE\.InstancedMesh\(/g) || []).length === 1, '教学段应恰 1 个 InstancedMesh（标签图集合并）');
  ok((TSEG.match(/new THREE\.Mesh\(/g) || []).length === 1, '教学段应恰 1 个剖面填充 Mesh（其余必须合批）');
  ok(/aUvRect/.test(TSEG) && /vLblUv/.test(TSEG) && !/project_vertex 已由广告牌逻辑接管/.test(TSEG),
    '标签没有走「aUvRect 图集 UV + 标准实例化投影」（vLblUv 采样缺失或残留自写投影）');
  ok(/generateMipmaps = false/.test(TSEG) && /LinearFilter/.test(TSEG),
    '标签图集没有关 mipmap（1536×384 NPOT 开 mipmap 实测得到空纹理、整层不可见）');
  ok(/FACILITIES\.filter/.test(TSEG) && /CIVIC\.map/.test(TSEG) && /FIELDS\.map/.test(TSEG),
    '标签来源不是 地名(FACILITIES/CIVIC) + 地块编号(FIELDS)');
  ok(/labelMesh\.visible = false/.test(TSEG), '标注层应默认关闭（visible=false）');
  // 等高线
  ok(/uContour: \{ value: 0 \}/.test(src), '地形缺 uContour uniform（默认关）');
  ok(/uContour > 0\.5/.test(src) && /fwidth\(_ch\)/.test(src) && /vWorldY \/ 2\.0/.test(src),
    '等高线没有走 uContour × 2 m × fwidth 抗锯齿');

  /* ---------------- 2. 剖面 ---------------- */
  ok(/SECTION_Z = -60/.test(TSEG), '剖面切线不在 z=−60');
  ok(/new THREE\.Plane\(new THREE\.Vector3\(0, 0, 1\), -SECTION_Z\)/.test(TSEG),
    '裁剪平面方向不对（应保留南半 z>−60）');
  ok(/heightAt\(wx\(px\), SECTION_Z\)/.test(TSEG), '剖面填充没有按 heightAt 逐列采样河床轮廓');
  ok(/RIVER\.depth\.toFixed\(1\)/.test(TSEG) && /waterY\.toFixed\(1\)/.test(TSEG)
    && /\(half \* 2\)\.toFixed\(0\)/.test(TSEG),
    '剖面尺寸标注必须读 RIVER 常量（下切 depth / 水位 waterY / 水面宽 half×2），不许写死');
  ok(/for \(let d = 3\.0; d <= 4\.5; d \+= 0\.002\)/.test(TSEG),
    '水面半宽没有数值解（riverHeight == waterY 的交线）');
  ok(/sectionMesh\.visible = false/.test(TSEG), '剖面应默认关闭（visible=false）');
  // 裁剪挂 / 卸
  ok(/m\.clippingPlanes = \[sectionPlane\]/.test(TSEG), '开启时没有挂 clippingPlanes');
  ok(/for \(const m of clippedMats\) m\.clippingPlanes = null;/.test(TSEG),
    '关闭时没有把所有材质的 clippingPlanes 还原为 null（会残留裁剪）');
  ok(/o === labelMesh \|\| o === sectionMesh/.test(TSEG), '裁剪遍历应跳过标签与剖面填充自身');

  /* ---------------- 3. 互斥与复原（main.js）---------------- */
  ok(/renderer\.localClippingEnabled = true/.test(main), 'main.js 没有开 localClippingEnabled');
  ok((main.match(/world\.teach\.closeAll\(\)/g) || []).length === 3,
    '第一人称（按钮 + KeyF）与巡游三处入口都应在进入前 closeAll()');
  ok(/与第一人称不兼容/.test(main) && /与自动巡游不兼容/.test(main), '互斥时缺少用户提示');
  ok(/teachCamSave/.test(main) && /rig\.target\.copy\(teachCamSave\.target\)/.test(main),
    '剖面相机的机位保存 / 还原缺失（关闭后场景必须完全复原）');
  ok(/syncTeachBtns\(\)/.test(main), '按钮状态没有同步函数');

  /* ---------------- 4. draw call 预算 ---------------- */
  const newObjs =
    (TSEG.match(/new THREE\.InstancedMesh\(/g) || []).length
    + (TSEG.match(/new THREE\.Mesh\(/g) || []).length;
  ok(newObjs === 2, `教学视图新增绘制对象 ${newObjs} 个（应为标签 1 + 剖面填充 1 = 2，上限 3）`);

  /* ---------------- 5. QA 行 ---------------- */
  ok(/world\.teach/.test(main) && /裁剪材质/.test(main), 'main.js ?qa=1 缺 teach 汇总行');

  return { bad, problems };
}

let { bad, problems } = await runChecks(SRC, MAIN, HTML);

/* ---------------- 负向自测 ---------------- */
if (selfTest) {
  let caught = 0, total = 3;
  // 破坏 1：关闭时不还原裁剪（直接清列表不还原材质）
  const m1 = SRC.replace('for (const m of clippedMats) m.clippingPlanes = null;', 'clippedMats = [];');
  const r1 = await runChecks(m1, MAIN, HTML);
  if (r1.bad > 0) caught++; else console.log('✗ 破坏 1 未被抓到：关闭不还原裁剪后检查仍通过');
  // 破坏 2：剖面标注写死数值（不读 RIVER 常量）
  const m2 = SRC.replace('RIVER.depth.toFixed(1)', '"2.2"').replace('waterY.toFixed(1)', '"-0.6"');
  const r2 = await runChecks(m2, MAIN, HTML);
  if (r2.bad > 0) caught++; else console.log('✗ 破坏 2 未被抓到：标注写死数值后检查仍通过');
  // 破坏 3：标签拆成逐个 Mesh（draw call 超预算）
  const m3 = SRC.replace(
    'const labelMesh = new THREE.InstancedMesh(labelGeo,',
    'const labelMesh = (LBL.items.length, new THREE.Mesh(labelGeo,');
  const r3 = await runChecks(m3, MAIN, HTML);
  if (r3.bad > 0) caught++; else console.log('✗ 破坏 3 未被抓到：标签拆成逐个 Mesh 后检查仍通过');
  console.log(`\n负向自测：${caught}/${total} 项破坏被检查抓到`);
  if (caught < total) { console.log('✗ 负向自测失败'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log('教学视图：标注层 24 标签（图集 1 InstancedMesh）+ 等高线 2 m（shader 内 0 对象）');
console.log('剖面：z=−60 裁剪（保留南半），填充面标注 下切 2.2 m / 水位 −0.6 m / 水面宽 8 m（读 RIVER 常量）');
console.log('新增绘制对象 2 个（上限 3）；关闭 = 裁剪全还原 + visible=false + 机位还原');

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
