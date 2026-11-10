#!/usr/bin/env node
/**
 * 树木形态与分配校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-tree.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-tree.mjs --self-test  负向自测：在内存里把一棵行道杨树挪到河边，
 *                                          确认分配比例检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 m，与 data.js 的 SPECIES / addTree 注释一致）：
 *   1. 计数：101 棵树、ALL_OBJECTS 199，五种 kind 都在
 *   2. 分配规则：主路行道（|Δx 主路| < 14）杨 ≥ 60%；河边（|Δx 河| < 26）柳 ≥ 70%；
 *      院落周边槐 + 榆 ≥ 60%
 *   3. 四种形态：TREE_FORM 四套参数齐全、FORM_OF 覆盖全部 kind、柳树 droop 明显
 *      大于其他三种、杨的冠最窄（crown[0] 最小）
 *   4. 落位：没有树落在河道里（距河心 > RIVER.out），河岸柳都在河边 26 m 内
 *   5. 可复现：treeRng 是纯函数，同 seed 两次生成同一序列，不同 seed 不同；
 *      world.js 里树段不再使用 Math.random 或全局 between
 *   6. 绘制批次：干 / 枝 / 叶 3 个 InstancedMesh，不按树种拆分
 */
import { readFileSync } from 'node:fs';
import { TREES, ALL_OBJECTS, RIVER, riverCenterX, roadX, SPECIES } from '../js/data.js';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const SRC = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');

let bad = 0;
const problems = [];
const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

/* ---------------- 1. 计数与 kind ---------------- */
ok(TREES.length === 101, `树 ${TREES.length} 棵 ≠ 101`);
ok(ALL_OBJECTS.length === 199, `ALL_OBJECTS ${ALL_OBJECTS.length} ≠ 199（188 + 1 看门狗 + 10）`);
const kinds = TREES.reduce((o, t) => (o[t.kind] = (o[t.kind] || 0) + 1, o), {});
for (const sp of SPECIES) ok(kinds[sp.kind] > 0, `树种「${sp.kind}」一棵都没有`);
ok(Object.keys(kinds).length === SPECIES.length,
  `出现了 SPECIES 之外的树种：${Object.keys(kinds).filter((k) => !SPECIES.some((s) => s.kind === k)).join(',')}`);

/* ---------------- 2. 区位分配规则 ---------------- */
const zoneOf = (t) => {
  const dRiver = Math.abs(t.pos[0] - riverCenterX(t.pos[2]));
  const dRoad = Math.abs(t.pos[0] - roadX(t.pos[2]));
  if (dRiver < 26) return 'river';
  if (dRoad < 14) return 'street';
  return 'yard';
};
function ratios(list) {
  const z = { river: {}, street: {}, yard: {} };
  for (const t of list) {
    const k = zoneOf(t);
    z[k][t.kind] = (z[k][t.kind] || 0) + 1;
  }
  const pct = (obj, names) => {
    const tot = Object.values(obj).reduce((a, b) => a + b, 0);
    const n = names.reduce((a, k) => a + (obj[k] || 0), 0);
    return tot ? n / tot : 0;
  };
  return {
    streetPoplar: pct(z.street, ['杨树']),
    riverWillow: pct(z.river, ['柳树']),
    yardLocustElm: pct(z.yard, ['槐树', '榆树']),
    z,
  };
}
const r = ratios(TREES);
ok(r.streetPoplar >= 0.60, `主路行道杨树只占 ${(r.streetPoplar * 100).toFixed(0)}%（要求 ≥ 60%）`);
ok(r.riverWillow >= 0.70, `河边柳树只占 ${(r.riverWillow * 100).toFixed(0)}%（要求 ≥ 70%）`);
ok(r.yardLocustElm >= 0.60, `院落周边槐 + 榆只占 ${(r.yardLocustElm * 100).toFixed(0)}%（要求 ≥ 60%）`);

/* ---------------- 3. 四种形态参数 ---------------- */
const formBlock = SRC.match(/const TREE_FORM = \{[\s\S]*?\n\};/);
ok(!!formBlock, 'world.js 里找不到 TREE_FORM 常量块');
const formSrc = formBlock ? formBlock[0] : '';
const forms = {};
for (const key of ['poplar', 'willow', 'locust', 'elm']) {
  const m = formSrc.match(new RegExp(`\\b${key}:\\s*\\{([^}]*)\\}`));
  ok(!!m, `TREE_FORM 缺 ${key}`);
  if (!m) continue;
  const grab = (name) => {
    const mm = m[1].match(new RegExp(`${name}:\\s*(\\[[^\\]]+\\]|[\\d.]+)`));
    return mm ? mm[1] : null;
  };
  forms[key] = {
    trunk: Number(grab('trunk')),
    crown: (grab('crown') || '[0,0,0]').replace(/[[\]]/g, '').split(',').map(Number),
    droop: Number(grab('droop')),
    clusters: Number(grab('clusters')),
  };
}
ok(forms.willow.droop > 0.5, `柳树 droop = ${forms.willow.droop}，不足以下垂（要求 > 0.5）`);
ok(forms.willow.droop > forms.locust.droop * 2.5,
  `柳树 droop ${forms.willow.droop} 不比槐 ${forms.locust.droop} 明显大，垂枝会看不出来`);
ok(forms.poplar.crown[0] < forms.locust.crown[0] * 0.6,
  `杨冠半径 ${forms.poplar.crown[0]} 不够窄（槐 ${forms.locust.crown[0]}）`);
ok(forms.willow.crown[1] < forms.willow.crown[0] * 0.6,
  `柳冠不够扁（ry ${forms.willow.crown[1]} vs rx ${forms.willow.crown[0]}）`);
const trunkOrder = forms.poplar.trunk > forms.elm.trunk && forms.elm.trunk > forms.locust.trunk
  && forms.locust.trunk > forms.willow.trunk;
ok(trunkOrder, `干高比顺序应为 杨 > 榆 > 槐 > 柳，实际 ${JSON.stringify(Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, v.trunk])))}`);
ok(/willowSegs/.test(SRC), 'world.js 里没有柳树垂枝段计数');

// FORM_OF 覆盖全部 kind
const mapBlock = SRC.match(/const FORM_OF = \{([^}]*)\}/);
ok(!!mapBlock, '找不到 FORM_OF 映射');
if (mapBlock) for (const sp of SPECIES) {
  ok(new RegExp(`${sp.kind}:`).test(mapBlock[1]), `FORM_OF 没有覆盖「${sp.kind}」`);
}

/* ---------------- 4. 落位 ---------------- */
let inRiver = 0;
for (const t of TREES) {
  if (Math.abs(t.pos[0] - riverCenterX(t.pos[2])) <= RIVER.out) inRiver++;
}
ok(inRiver === 0, `有 ${inRiver} 棵树落在河道里（距河心 ≤ ${RIVER.out} m）`);
const willows = TREES.filter((t) => t.kind === '柳树');
ok(willows.length >= 10, `柳树只有 ${willows.length} 棵，河边垂柳的辨识度不够`);
const riverWillows = willows.filter((t) => Math.abs(t.pos[0] - riverCenterX(t.pos[2])) < 26);
ok(riverWillows.length >= 6, `河边柳只有 ${riverWillows.length} 棵（要求 ≥ 6）`);

/* ---------------- 5. 可复现 ---------------- */
// 与 world.js 的 treeRng 同一套 mulberry32
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
const seqA = Array.from({ length: 6 }, treeRng(123456));
const seqB = Array.from({ length: 6 }, treeRng(123456));
const seqC = Array.from({ length: 6 }, treeRng(123457));
ok(seqA.every((v, i) => v === seqB[i]), 'treeRng 同一 seed 两次生成不一致，无法复现');
ok(seqA.some((v, i) => v !== seqC[i]), 'treeRng 不同 seed 生成了同一序列，退化成了常量');
ok(seqA.every((v) => v >= 0 && v < 1), 'treeRng 输出超出 [0,1)');

// 树段里不能再有 Math.random 或全局 between（否则每次刷新树形都会变）
const treeSeg = SRC.slice(SRC.indexOf('for (let ti = 0; ti < TREES.length; ti++)'),
  SRC.indexOf('const mkInst = (geo, mat, list, colors)'));
ok(treeSeg.length > 500, '定位不到树段源码');
ok(!/Math\.random/.test(treeSeg), '树段里还在用 Math.random，树形无法复现');
ok(!/\bbetween\(/.test(treeSeg), '树段里还在用全局 between，会打乱其他系统的随机序列');
ok(/treeRng\(seed\)/.test(treeSeg), '树段没有使用 treeRng(seed)');

/* ---------------- 6. 绘制批次 ---------------- */
const instGroups = [
  [/mkInst\(unitGeo, matBarkTrunk, trunkM\)/, '树干'],
  [/mkInst\(unitGeo, matBark, branchM\)/, '枝条'],
  [/mkInst\(leafGeo, matLeaf, leafM, leafC\)/, '叶片'],
];
let instOk = 0;
for (const [re, name] of instGroups) {
  if (re.test(SRC)) instOk++;
  else ok(false, `缺少${name}实例组`);
}
ok(instOk === 3, `树只挂了 ${instOk} 组实例（应为干 / 枝 / 叶 3 组）`);
ok(!/TREES\.filter\([^)]*\)\.forEach[\s\S]{0,200}new THREE\.Mesh/.test(SRC), '树是按树种各自建 Mesh，会按树种数增加 draw call');

/* ---------------- 负向自测 ---------------- */
if (process.argv.includes('--self-test')) {
  // 把一棵行道杨树挪到河边，杨在河边的占比上升、柳的占比下降，比例检查应当报错
  const moved = TREES.map((t) => ({ ...t }));
  let n = 0;
  for (const t of moved) {
    if (n >= 10) break;
    if (zoneOf(t) === 'river' && t.kind === '柳树') { t.pos = [0, 0, -60]; n++; }
  }
  const r2 = ratios(moved);
  const caught = r2.riverWillow < 0.70;
  console.log(`\n负向自测：把 ${n} 棵河岸柳挪进村后，河边柳占比降到 ${(r2.riverWillow * 100).toFixed(0)}%`);
  if (!caught) { console.log('✗ 负向自测失败：比例检查没有报错'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
const zoneCount = {};
for (const t of TREES) { const z = zoneOf(t); zoneCount[z] = (zoneCount[z] || 0) + 1; }
console.log(`树木 ${TREES.length} 棵：` + Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' / '));
console.log(`区位：行道 ${zoneCount.street} 棵（杨 ${(r.streetPoplar * 100).toFixed(0)}%）/ 院落 ${zoneCount.yard} 棵（槐榆 ${(r.yardLocustElm * 100).toFixed(0)}%）/ 河边 ${zoneCount.river} 棵（柳 ${(r.riverWillow * 100).toFixed(0)}%）`);
console.log('四形态：' + Object.entries(forms).map(([k, v]) => `${k} 干${v.trunk} 冠${v.crown.join('/')} 垂${v.droop}`).join(' | '));
console.log(`绘制批次：干 / 枝 / 叶 3 个 InstancedMesh（不按树种拆分）`);

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
