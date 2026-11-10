/**
 * 场景装配：地形、天空、光照、道路、民居、树木、家畜、公共设施、田块
 * 所有可点选物体都挂一个不可见代理盒，射线只打代理，保证拾取精准且省性能
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TEX from './textures.js';
import { HOUSES, TREES, ANIMAL_LIST, FACILITIES, FIELDS, YARD_DETAILS, ROAD, VILLAGE,
  RIVER, riverCenterX, STONES, MILLSTONE, CISTERNS, FLAGS, POWER_LINE, PRODUCTION,
  CIVIC, LANES, RIDGES, roadX } from './data.js';
import { cookingIntensity, herdActivity } from './schedule.js';

/* ---------- 地形噪声 ---------- */
const hash = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f); f *= 2; amp *= 0.5; }
  return v;
}

/** 地面底板高度：村所在的川地平坦，向外抬升为岷山北麓的丘陵 */
function baseHeight(x, z) {
  const d = Math.hypot(x * 0.85, z * 1.0);
  const flat = Math.min(1, Math.max(0, (d - 100) / 155));
  const ridge = (fbm(x * 0.0055, z * 0.0055, 4) - 0.42) * 96;
  const ripple = (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 2.4;
  return ridge * flat * flat + ripple * Math.min(1, flat * 3);
}

/* ================= 村东山：一座孤山 =================
 * 位置是算过的：中心 (170,20)，山脚半径 75 → 西缘落在 x≈95，
 * 最东侧的田（L-14「梁上地」）东北角伸到 x≈103，但那一带山脚只抬起十几厘米，
 * 不会真的压住田面。半径不要放大，放大就会啃进田里。
 */
const HILL = { x: 170, z: 20, rx: 75, rz: 68, rot: -0.10, top: 58 };

const sm01 = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** 山顶要落在绝对高度 58 m，所以抬升量按"58 − 当地底板"折算 */
const HILL_LIFT = HILL.top - baseHeight(HILL.x, HILL.z);

/** 山体抬升量（米）。返回 0 表示这一点不在山上 */
function hillLift(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  if (dx * dx + dz * dz > HILL.rx * HILL.rx) return 0;   // 粗筛，绝大多数点不进三角函数
  const c = Math.cos(HILL.rot), s = Math.sin(HILL.rot);
  const lx = dx * c + dz * s;                            // 转到山的局部坐标（略压成椭圆）
  const lz = -dx * s + dz * c;
  const r = Math.hypot(lx / HILL.rx, lz / HILL.rz);
  if (r >= 1) return 0;
  const t = 1 - r;                                       // 0=山脚，1=山顶
  // 二次衰减：山脚平缓、山腰最陡、山顶收圆；两端斜率为 0，与川地无缝接上
  const prof = sm01(t);

  // 等高线扰动只加在高度上，且在峰、脚两处都衰减到 0：
  // 山顶仍精确等于 HILL.top，山脚半径仍是 75（半径不能改）
  const ang = Math.atan2(lz, lx);
  const lobe = Math.sin(ang * 2 + 0.7) * 1.05
    + Math.sin(ang * 3 - 2.1) * 0.72
    + Math.sin(ang * 5 + 1.2) * 0.34;
  let h = HILL_LIFT * (prof + t * t * (1 - t) * (1 - t) * lobe * 2.2);

  // 坡面起伏：整座山不该是抛光过的曲面，峰和脚同样衰减到 0
  h += (fbm(x * 0.05, z * 0.05, 3) - 0.5) * 2.8 * (t * (1 - t) * 4);
  // 放射状冲沟：七道浅沟从山顶挂下来，侧光时能看出坡面是"有沟壑的"
  h += Math.sin(ang * 7 + 0.4) * 1.7 * (t * (1 - t) * 4);

  // 北侧伸出一道小山梁（长在主体内，不影响山脚半径），破掉对称的圆锥感
  const sx = x - 152, sz = z + 24;
  h += 9.5 * Math.exp(-(sx * sx + sz * sz) / (2 * 21 * 21)) * (t * (1 - t) * 4);

  // 西麓耕地让位：数据里 L-14「梁上地」东北角实际到 (103.1, -5.2)，
  // 比「最东的田到 x=91」这个设计前提更靠东，山脚西缘 x≈95 会擦到田角约 0.35 m。
  // 山脚半径按设计不动，只在这块田的占地内把抬升削到 4 cm 以内（田面是刚性平面，
  // 超过 8 cm 就会被山脚顶穿）；出田界 6 m 内平滑接回。
  // x=95 的山脚零点、(170,20) 的 58 m 山顶都不在这块窗口里，不受影响。
  const kx = Math.max(68 - x, x - 104, 0), kz = Math.max(-30 - z, z - 2, 0);
  const kd = Math.hypot(kx, kz);
  if (kd < 6) {
    const w = 1 - sm01(kd / 6);
    h += (Math.min(h, 0.04) - h) * w;
  }
  return h;
}

/* 山腰上的两块人工台地：庙基 + 庙前老槐的树盘。
 * r 以内完全压平，到 blend 处平滑接回山坡，免得屋基和树根一半悬空。 */
const PAD = { x: 140, z: 20, r: 4.8, blend: 14 };       // 庙基（下面搭庙时用）
const TREE_PAD = { x: 147, z: 28, r: 2.6, blend: 7 };   // 老槐树盘
const rawHeight = (x, z) => baseHeight(x, z) + hillLift(x, z);

// 台地标高取「上游台地处理完之后」的地形，避免两块台地叠出一个鼓包
const PADS = [];
for (const p of [PAD, TREE_PAD]) {
  let y = rawHeight(p.x, p.z);
  for (const q of PADS) {
    const pd = Math.hypot(p.x - q.x, p.z - q.z);
    if (pd >= q.blend) continue;
    const w = 1 - sm01((pd - q.r) / (q.blend - q.r));
    y += (q.y - y) * w;
  }
  PADS.push({ ...p, y });
}

/* ================= 村西小河：河谷横截面 =================
 * 河床是恒定标高 RIVER.bedY(-2.2m)，沿河 5 个取样点数值完全一致；
 * 从中心到 half=6m 用 sm01 把 2.2m 抬回岸顶，两端导数都是 0，
 * 所以谷底圆、岸坡平滑、与川地无缝，不会出现断崖；
 * 6~9m 这一段再接回原始大地形（村外两端的高差在这里被吸收）。
 * 常水位 waterY=-0.6m，与坡面的交线落在 |d|≈3.88m，
 * 也就是"河宽 8 米"读的是常水位水面宽，岸上还留着干河滩。
 */
function riverHeight(x, z) {
  if (z < RIVER.z0 - 12 || z > RIVER.z1 + 12) return rawHeight(x, z);
  const d = Math.abs(x - riverCenterX(z));
  if (d >= RIVER.out) return rawHeight(x, z);
  const groove = RIVER.bedY + RIVER.depth * sm01(Math.min(1, d / RIVER.half));
  const t = sm01((d - RIVER.half) / (RIVER.out - RIVER.half));
  return groove * (1 - t) + rawHeight(x, z) * t;
}

/** 漫水桥：桥面只比常水位高 0.30m，汛期水直接从桥上漫过去，不设栏杆 */
const BRIDGE = {
  z: 18,
  x: riverCenterX(18),
  halfL: 8.0, halfW: 1.7,
  deckY: RIVER.waterY + 0.30,
};

/* ================= 地形材质：三层混合的世界尺度与权重阈值 =================
 * 单位：米（TILE_*）与无量纲（其余）。
 * 草层周期由 gRepeat 反算（620 / 300 = 2.07 m），这里只定土与石：
 *   2.07 : 4.50 : 26.00 = 1 : 2.17 : 12.6，互不成整数比，
 *   三张图的平铺网格不会同时对齐 —— 这是消除重复感的关键，不是随便取的数。
 *
 * 权重阈值按 46,986 个顶点的实测分布标定（2026-11-09）：
 *   slope 中位 0.011 / p90 0.077，只有山顶一带才到 0.37
 *   curv  原始拉普拉斯 p10 −0.0136 / p50 0 / p90 0.0132，山顶中位 0.072
 * 所以坡度只做加速项，主判据是 f（山体相对抬升）——
 * 若按"常见陡坡 0.3"当岩石阈值，全图只有山顶几十个顶点命中，山会整片变绿。
 */
const TERRAIN = {
  SOIL_TILE: 4.50,      // 土层世界周期，米（沥青路面状车辙，斜过坡面读作水蚀细沟）
  ROCK_TILE: 26.00,     // 石层世界周期，米（地形裸岩是无规则噪声，不怕远处混叠）
  GRASS_TILE2: 7.90,    // 草层第二尺度周期，米（与 2.07 m 比 3.8，非整数）
  ROCK_LO: 0.42, ROCK_HI: 0.92,   // f 的岩石起止
  SOIL_LO: 0.10, SOIL_HI: 0.48,   // f 的土起止
  SLOPE_LO: 0.015, SLOPE_HI: 0.30, // 坡度加速项起止
  CURV_GAIN: 40,        // 曲率放大倍数：把实测 ±0.014 拉到 ±0.56
};

/* ================= 地形三层混合权重 =================
 * 逐顶点算草 / 土 / 石三个权重，写进 aTerrW（vec3）属性，供 patchTerrain 混合。
 *   f      山体相对抬升，0 = 村内平地，1 = 孤山顶（hillLift / HILL_LIFT）
 *   slope  坡度，1 − 法线.y，0 = 水平，1 = 垂直
 *   curvN  曲率，顶点拉普拉斯 ÷ 边长² × CURV_GAIN，clamp ±1；正 = 凸（山脊），负 = 凹（沟）
 * 三个权重逐顶点恒和为 1（wGrass 取剩余量），所以混合不会把 albedo 推出原量级。
 */
function terrainWeights(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const idx = geo.index.array;
  const N = pos.count;

  // 曲率：按三角形邻接累加顶点拉普拉斯。d 取三角形三条边长的均值，
  // 这样河道加密带（x 方向 0.54 m）的短边不会被当成剧烈起伏放大 36 倍。
  const lap = new Float32Array(N);
  const cnt = new Uint16Array(N);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ya = pos.getY(a), yb = pos.getY(b), yc = pos.getY(c);
    const ax = pos.getX(a), az = pos.getZ(a);
    const bx = pos.getX(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cz = pos.getZ(c);
    const d = (Math.hypot(bx - ax, bz - az) + Math.hypot(cx - bx, bz - cz)
      + Math.hypot(ax - cx, az - cz)) / 3;
    const inv = 1 / (d * d);
    lap[a] += (2 * ya - yb - yc) * inv; cnt[a]++;
    lap[b] += (2 * yb - ya - yc) * inv; cnt[b]++;
    lap[c] += (2 * yc - ya - yb) * inv; cnt[c]++;
  }

  const ss = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // 分界线加一点低频噪声，免得山坡上出现一条完美的等高线
    const f = Math.min(1, Math.max(0,
      hillLift(x, z) / HILL_LIFT + (fbm(x * 0.055, z * 0.055, 2) - 0.5) * 0.07));
    const slope = Math.min(1, Math.max(0, 1 - nor.getY(i)));
    const curvN = cnt[i]
      ? Math.min(1, Math.max(-1, (lap[i] / cnt[i]) * TERRAIN.CURV_GAIN))
      : 0;

    const slopeW = ss(TERRAIN.SLOPE_LO, TERRAIN.SLOPE_HI, slope);
    let wRock = ss(TERRAIN.ROCK_LO, TERRAIN.ROCK_HI, f) * (0.55 + 0.45 * slopeW);
    wRock += 0.35 * slopeW * ss(-0.10, 0.60, curvN);
    // 上限 0.72：石层贴图是给挡墙画的砌块图，权重满格时整座山读成棋盘；
    // 留 28% 给土/草，山体才是「裸岩夹土」而不是一片石墙。
    wRock = Math.min(0.72, Math.max(0, wRock));

    let wSoil = 0.75 * ss(TERRAIN.SOIL_LO, TERRAIN.SOIL_HI, f) * (1 - wRock);
    wSoil += 0.25 * ss(0.15, 0.75, -curvN) * (1 - wRock);
    wSoil = Math.min(1 - wRock, Math.max(0, wSoil));

    out[i * 3] = Math.max(0, 1 - wRock - wSoil);
    out[i * 3 + 1] = wSoil;
    out[i * 3 + 2] = wRock;
  }
  return out;
}

export function heightAt(x, z) {
  let h = riverHeight(x, z);
  // 两处台地的影响范围都在 x∈[126,154]、z∈[6,35]，村内绝大多数顶点直接跳过
  if (x < 120 || x > 160 || z < 4 || z > 40) return h;
  for (const p of PADS) {
    const pd = Math.hypot(x - p.x, z - p.z);
    if (pd >= p.blend) continue;
    const w = 1 - sm01((pd - p.r) / (p.blend - p.r));
    h += (p.y - h) * w;
  }
  return h;
}

/** 只给第一人称用：桥面范围内把落脚高度抬到桥板上，边缘 0.6m 平滑接回地面 */
export function walkHeightAt(x, z) {
  const h = heightAt(x, z);
  const dx = BRIDGE.halfL - Math.abs(x - BRIDGE.x);
  const dz = BRIDGE.halfW - Math.abs(z - BRIDGE.z);
  if (dx <= 0 || dz <= 0) return h;
  return h + (BRIDGE.deckY - h) * Math.min(1, Math.min(dx, dz) / 0.6);
}

const rnd = Math.random;
const between = (a, b) => a + rnd() * (b - a);

/** mulberry32：树木专用确定性随机。树是同一份 TREES 数据、同一颗种子，
 *  每次加载长出来的枝与叶完全一致；不动全局 rnd，也不受其他系统影响。 */
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

/* 四种树形轮廓。单位：比例无量纲，角度 rad。
 * 形态只作用于实例矩阵与叶簇分布 —— 几何仍是同一份圆柱 + 叶面片，
 * 所以仍然是干 / 枝 / 叶 3 个 InstancedMesh，draw call 与树种数无关。
 *   trunk    树干占全高的比例
 *   crown    [rx, ry, rz] 冠椭球，乘 canopy
 *   tilt     主枝与竖直方向的夹角范围（越小越贴干上扬）
 *   segs     主枝分段数（柳 3 段折线做下垂）
 *   droop    每往下一段，仰角减掉的弧度
 *   clusters 叶簇数量系数
 *   leaf     叶片缩放系数
 *   leafAspect [x,y,z] 叶片各向缩放（柳叶细长，用 [0.58, 1.32, 1]） */
const TREE_FORM = {
  // 杨：冠半径只有 0.28，枝条几乎贴干向上，整棵像一根柱子
  poplar: { trunk: 0.58, crown: [0.28, 0.78, 0.28], tilt: [0.22, 0.44], segs: 2, droop: 0.10, clusters: 1.32, leaf: 1.02 },
  // 柳：冠扁而宽，主枝 5 根折线下垂，叶量主要挂在垂枝上（clusters 只给冠顶留 0.55）
  willow: { trunk: 0.34, crown: [0.74, 0.32, 0.74], tilt: [0.55, 0.85], segs: 3, droop: 0.86, clusters: 0.62, leaf: 0.93, leafAspect: [0.58, 1.32, 1] },
  // 槐：近球形、叶最密
  locust: { trunk: 0.42, crown: [0.62, 0.56, 0.62], tilt: [0.50, 0.82], segs: 2, droop: 0.16, clusters: 1.22, leaf: 1.08 },
  // 榆：冠瘦高、枝条向外张、叶最疏
  elm:    { trunk: 0.54, crown: [0.46, 0.70, 0.46], tilt: [0.42, 0.72], segs: 2, droop: 0.12, clusters: 0.82, leaf: 1.13 },
};
// 杏树是矮小圆冠果树，复用槐的轮廓（数据里 canopy 本来就小一档）
const FORM_OF = { 杨树: 'poplar', 柳树: 'willow', 槐树: 'locust', 杏树: 'locust', 榆树: 'elm' };

/* ================= 野性层：灌木丛与杂草 =================
 * 单位：数量「株」、长度「米」、密度权重「无量纲 0..1」、角度 rad。
 * 两级实例，draw call 恒为 2（灌木 1 + 杂草 1），castShadow=false，
 * 所以阴影通道 0 —— 合计 +2，正好等于任务上限。
 * 不新增贴图文件：灌木叶卡复用 TEX.leafCard()，杂草纯顶点色。
 *
 * 距离分三段（米，顶点着色器里按实例到相机的距离算）：
 *   0 … LOD_NEAR        完整几何（灌木 16 三角形 / 40 顶点，杂草 18 / 54）
 *   LOD_NEAR … LOD_FAR  灌木把叶卡塌缩进核心块（只剩核心 8 三角形）
 *   FADE_FAR … FADE_END 整体缩放淡出到 0 —— 远景山体一根都不画，观感不受影响
 */
const SCRUB = {
  SHRUB_N: 8000,            // 灌木目标株数
  WEED_N: 14000,            // 杂草目标株数
  SEED: 0x5C2B17,           // 撒点随机种子（mulberry32，固定可复现）

  // 灌木：矮丛 0.55~1.65 m 高，冠幅 0.7~1.3 倍株高
  SHRUB_H: [0.55, 1.65],
  SHRUB_W: [0.70, 1.30],
  SHRUB_LOD_NEAR: 42,       // 叶卡开始塌缩，m
  SHRUB_LOD_FAR: 58,        // 叶卡完全塌缩，m
  SHRUB_FADE_FAR: 120,      // 整体开始淡出，m（远景仍留低模团块，不是一根不画）
  SHRUB_FADE_END: 175,      // 完全消失，m

  // 杂草：0.35~0.95 m 高的丛生草，比实体草（0.10~0.58 m）高一档
  WEED_H: [0.35, 0.95],
  WEED_FADE_FAR: 30,        // m
  WEED_FADE_END: 46,        // m

  // 撒点区域（世界坐标，m）：覆盖村域、田区与村东孤山
  X0: -215, X1: 255, Z0: -200, Z1: 200,
  // 杂草比灌木矮得多，只在村域附近铺，远处看不到、省顶点
  WEED_X0: -130, WEED_X1: 140, WEED_Z0: -160, WEED_Z1: 160,

  // 密度：坡度、山体、河岸、田埂四路加权
  SLOPE_LO: 0.08, SLOPE_HI: 0.30,   // 坡度（1 m 水平距离的高差）起止
  SLOPE_W: 0.85,                    // 陡坡灌木权重
  HILL_W: 0.70,                     // 孤山山体（hillLift）权重
  HILL_LO: 2, HILL_HI: 12,          // 山体抬升起止，m
  RIVER_W: 0.90,                    // 河岸带权重
  RIVER_BAND: 12,                   // 河岸带宽，m（从 RIVER.out 起算）
  RIDGE_W: 0.55,                    // 田埂两侧权重
  RIDGE_BAND: 2.5,                  // 田埂两侧带宽，m
  FIELD_W: 0.85,                    // 耕地外侧田边权重（田边那一圈最容易长灌木）
  FIELD_NEAR: 0.7, FIELD_FAR: 5.0,  // 田边带内外边界，m
  FLAT_W: 0.10,                     // 平地底噪（村内偶尔一丛）
  VILLAGE_W: 0.22,                  // 村周权重：房前屋后的空地
  VILLAGE_IN: 22, VILLAGE_OUT: 70,  // 村周带的内外半径，m

  // 噪声斑块：让灌木成簇，不是均匀铺满
  PATCH_FREQ: 0.030,
  PATCH_LO: 0.40, PATCH_HI: 0.68,

  // 靠近道路与建筑处稀疏：各自给 (near, far)，near 内为 0、far 外恢复 1
  ROAD_NEAR: 2.2, ROAD_FAR: 11,
  LANE_NEAR: 1.6, LANE_FAR: 8,
  HOUSE_NEAR: 3, HOUSE_FAR: 12,
  YARD_NEAR: 2, YARD_FAR: 9,        // 场院 / 公共核心 / 设施
};

/** 灌木几何：3 片交叉叶卡 + 1 片顶盖 + 1 个八角体核心块。
 *  几何高 1 m、宽 1 m，实例按株高缩放。
 *  aCore：核心块顶点 1、叶卡顶点 0 —— 远处顶点着色器把叶卡塌缩进核心块，
 *  这是「远处用简化替代」的实现，不新增 draw call。
 *  顶点色：核心块偏暗（内膛阴影），叶卡由下往上提亮。 */
function buildShrubGeo() {
  const parts = [];
  const addPart = (geo, core, colFn) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const aCore = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const c = colFn(p.getY(i), p.getX(i), p.getZ(i));
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      aCore[i] = core;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aCore', new THREE.BufferAttribute(aCore, 1));
    parts.push(g);
  };

  // 3 片交叉叶卡：互成 60°，各自带一点内倾，读起来是「一丛」而不是「一块板」
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(1, 1, 1, 1);
    g.translate(0, 0.5, 0);
    g.rotateZ((i % 2 ? 1 : -1) * 0.06);
    g.rotateY((i / 3) * Math.PI);
    addPart(g, 0, (y) => {
      const t = Math.min(1, Math.max(0, y));
      const k = 0.60 + t * 0.40;
      return [0.64 * k, 0.70 * k, 0.48 * k];
    });
  }
  // 顶盖：俯视时叶卡只有一条线，靠这片水平卡把冠顶填住
  {
    const g = new THREE.PlaneGeometry(0.92, 0.92, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.66, 0);
    addPart(g, 0, () => [0.80, 0.86, 0.60]);
  }
  // 核心块：二十面体压扁。近处缩到 0（只在叶卡里当内膛），42~58 m 才长出来接替叶卡，
  // 是「远处那丛灌木」的低模替身；八角体在近景会露出硬棱，二十面体圆得多。
  {
    const g = new THREE.IcosahedronGeometry(0.42, 0);
    g.scale(1, 0.88, 1);
    g.translate(0, 0.40, 0);
    addPart(g, 1, (y) => {
      const t = Math.min(1, Math.max(0, y / 0.80));
      const k = 0.30 + t * 0.26;
      return [0.44 * k, 0.50 * k, 0.32 * k];
    });
  }
  const out = mergeGeometries(parts, false);
  out.computeBoundingSphere();
  return out;
}

/** 杂草几何：8 片细窄的弧形叶，从根部散开、向外张、梢部微垂。
 *  几何高约 0.88 m（实例再按 0.35~0.95 缩放），纯顶点色、不采样贴图。
 *  单叶片 2 段（4 三角形）、8 片共 32 三角形 / 48 顶点 —— 密度靠株数堆，
 *  不靠单株细节，这样 1.4 万株也只有 45 万个三角形。
 *  法线统一朝上：薄叶片若按几何法线算，正反两面会一面死黑一面过曝；
 *  朝上让它们吃天光，与草地的整体明度一致。 */
function buildWeedGeo() {
  const pos = [], col = [], uv = [], aCore = [], nrm = [];
  const pushTri = (p0, p1, p2, c0, c1, c2) => {
    pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    col.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
    uv.push(0.5, p0[1], 0.5, p1[1], 0.5, p2[1]);
    aCore.push(0, 0, 0);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  };
  const NB = 8;
  const ROWS = [0, 0.55, 1.0];
  const W = [0.013, 0.008, 0.0025];      // 根宽 / 中宽 / 尖宽，m（细窄才是草，宽了像龙舌兰）
  const C = [[0.16, 0.20, 0.09], [0.30, 0.34, 0.15], [0.46, 0.44, 0.22]];
  for (let i = 0; i < NB; i++) {
    const ang = (i / NB) * Math.PI * 2 + 0.4;
    const lean = 0.30 + (i % 4) * 0.07;             // 外张程度
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const px = -dz, pz = dx;                        // 叶面横向
    const pt = (row, side) => {
      const t = ROWS[row];
      const spread = 0.05 + lean * t * t;           // 二次外张 = 弧形
      const y = t * (1.0 - 0.12 * t * t);           // 梢部微垂
      return [dx * spread + px * W[row] * side, y, dz * spread + pz * W[row] * side];
    };
    for (let r = 0; r < 2; r++) {
      const a0 = pt(r, -1), b0 = pt(r, 1), a1 = pt(r + 1, -1), b1 = pt(r + 1, 1);
      pushTri(a0, b0, a1, C[r], C[r], C[r + 1]);
      pushTri(b0, b1, a1, C[r], C[r + 1], C[r + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCore', new THREE.Float32BufferAttribute(aCore, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}


export function buildWorld(scene, assets = null) {
  const pickables = [];
  // 电线杆线的实测数据（杆位、档距、导线段数），建完由 ?qa=1 与校验脚本读
  let powerLine = null;
  // 季节绿度：0 = 枯黄，1 = 盛夏浓绿；由外部按日期驱动
  const seasonUniform = { value: 0.0 };
  // 天气地表状态：地面积雪 / 地面湿润，由 environment.js 按真实降水记录驱动
  const weatherUniforms = {
    wet: { value: 0 },
    snow: { value: 0 },
  };

  /* ---------- 风场 ----------
   * 全项目只有这一份风场 uniform，草、作物、雨丝、雪片、旗面共用同一组对象引用，
   * 所以"三处方向一致"是结构上的保证，不是各算各的凑巧对上。
   * 由 environment.js 每帧写入（含矢量低通平滑）：
   *   uWindDir   世界坐标单位向量（xz），指向「风吹去」的方向；+x 东、+z 南
   *   uWindSpeed 平滑后的风速，m/s
   */
  const windUniforms = {
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 0 },
  };

  /* 风动与旗面共用的时间（秒）。与昼夜时间轴无关：暂停时间时它照走，
   * 与 v1.1 里草摆、水波的行为一致（属于环境动画，不受时间轴控制）。 */
  const windTime = { value: 0 };

  /* ---------- 风场顶点位移注入器 ----------
   * 位移必须落在**世界空间**。v1.1 的草是在对象空间加的偏移，而每株草的实例矩阵里
   * 带一个随机 Y 旋转，于是每株朝自己转过的方向摆——这就是"草地各晃各的"的根因。
   * root 是挂在场景根上的空 Group（无位移/旋转/缩放），所以 instanceMatrix 之后
   * 就是世界坐标，直接在这一步加减偏移即可。
   *
   * base / gain：静风时的常驻摆幅、风速 9 m/s 时多出来的幅度（单位 m，作用在竖直
   * 参数为 1 的顶点上，实际还要乘实例的竖向缩放）。草软、作物硬，两者给不同值。
   *
   * simple=true 走廉价分支（单个 sin + y² 衰减，不做 length()）：
   * 作物有 18 万个实例、约 144 万顶点，而它在 v1.1 里完全没有顶点动画——全量公式
   * 在这一层是纯增开销。y² 与原 y^1.7 的形态差别肉眼看不出来。
   */
  const windProject = (base, gain, simple = false) => `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
float _wAmp = clamp( uWindSpeed / 9.0, 0.0, 1.0 );
float _wScl = 1.0;
#ifdef USE_INSTANCING
  _wScl = length( instanceMatrix[ 1 ].xyz );
#endif
// 顺风 / 横风坐标：相位沿顺风方向推进，风浪是"扫过"草地而不是原地齐步摆
float _along = dot( mvPosition.xz, uWindDir );
float _across = dot( mvPosition.xz, vec2( -uWindDir.y, uWindDir.x ) );
float _freq = 1.15 + _wAmp * 2.7;
${simple ? `
float _osc = sin( uTime * _freq - _along * 0.9 + _across * 0.4 );
float _lean = 0.62 + 0.38 * _osc;
float _shape = max( transformed.y, 0.0 );
_shape *= _shape;
` : `
float _osc = sin( uTime * _freq - _along * 0.62 + _across * 0.35 ) * 0.62
           + sin( uTime * _freq * 1.73 - _along * 1.05 + _across * 0.71 ) * 0.38;
float _lean = 0.55 + 0.45 * _osc;
float _shape = pow( max( transformed.y, 0.0 ), 1.7 );
`}
// 用 transformed.y（已含本节令高矮/株高缩放）而不是 position.y：
// 作物入冬被压到接近 0 高时不该还在地上左右扫
float _disp = ( ${base} + ${gain} * _wAmp ) * _shape * _wScl * _lean;
mvPosition.xz += uWindDir * _disp;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

  /** 给 MeshStandardMaterial 接上风场：只替换 project_vertex 一处 */
  const patchWind = (mat, base, gain, simple = false) => {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      shader.uniforms.uWindDir = windUniforms.uWindDir;
      shader.uniforms.uWindSpeed = windUniforms.uWindSpeed;
      shader.uniforms.uTime = windTime;
      shader.vertexShader = 'uniform vec2 uWindDir;\nuniform float uWindSpeed;\nuniform float uTime;\n'
        + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        windProject(base, gain, simple)
      );
    };
    mat.needsUpdate = true;
    return mat;
  };

  /* ---------- 共用着色片段 ----------
   * patchSeason（屋顶 / 墙 / 路面 / 田垄）与 patchTerrain（地形三层混合）共用同一套
   * 大尺度色斑与「季节绿 / 积雪 / 湿润」公式。抽成函数是为了两处不会各改一遍后漂移；
   * patchSeason 的行为与抽取前逐字一致（只改了代码位置，GLSL 一个字没动）。
   */

  /** 挂上三层尺度 macro 亮度斑，返回对应的 fragment 片段 */
  const attachMacro = (shader, macro) => {
    shader.uniforms.uMacro = { value: macro };
    shader.vertexShader = 'varying vec2 vMacroUv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n         vMacroUv = uv;'
    );
    shader.fragmentShader = 'uniform sampler2D uMacro;\nvarying vec2 vMacroUv;\n'
      + shader.fragmentShader;
    // 三层尺度互不成整数比（3.7 / 11.3 / 28.9），靠叠加打散平铺的周期
    return `
         float _mA = texture2D(uMacro, vMacroUv * 3.70).g;
         float _mB = texture2D(uMacro, vMacroUv * 11.30 + vec2(0.37, 0.61)).g;
         float _mC = texture2D(uMacro, vMacroUv * 28.90 + vec2(0.13, 0.29)).g;
         float _mv = _mA * 0.52 + _mB * 0.31 + _mC * 0.17;
         // 用亮度调制而不是乘色，避免把地面染脏
         diffuseColor.rgb *= mix(vec3(0.88, 0.89, 0.86), vec3(1.10, 1.10, 1.08), _mv);`;
  };

  /** 季节绿 → 整体压暗 → 积雪 → 湿润，所有地面类材质共用 */
  const seasonTail = () => `
         float _lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summer = vec3(0.175, 0.235, 0.108) * (0.62 + _lum * 1.05);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summer, uGreen * 0.46);
         // 草地整体压暗一档，让立体的草浮起来，不至于和地面糊成一片
         diffuseColor.rgb *= 0.80;
         // 真实天气：降雪积白、降雨压暗（湿润）
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.75, 0.79), uSnow * 0.86);
         diffuseColor.rgb *= 1.0 - uWet * 0.20;`;

  const patchSeason = (mat, opts = {}) => {
    const include = opts.include || '#include <map_fragment>';
    const macro = opts.macro || null;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      shader.uniforms.uGreen = seasonUniform;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.uniforms.uSnow = weatherUniforms.snow;
      if (!shader.fragmentShader.includes('uniform float uGreen')) {
        shader.fragmentShader = 'uniform float uGreen;\nuniform float uWet;\nuniform float uSnow;\n'
          + shader.fragmentShader;
      }
      const macroFrag = macro ? attachMacro(shader, macro) : '';
      shader.fragmentShader = shader.fragmentShader.replace(
        include,
        `${include}${macroFrag}${seasonTail()}`
      );
    };
    mat.needsUpdate = true;
    return mat;
  };

  /* ================= 地形三层 PBR 混合 =================
   * 为什么做：地形是一整块 620m×620m 的 Mesh，改前只采一张 grass、repeat=300，
   * 全图都是同一个 2.07m 周期；macro 只能调亮度，改不了图案本身，所以近景必然看出重复。
   *
   * 三层（全部是现有素材，不新增贴图文件）：
   *   草 = assets.grass（实拍，map + normal + roughness），世界周期 2.07 m
   *   土 = assets.road （实拍夯土，完整 PBR），          世界周期 4.50 m，UV 旋转 +27°
   *   石 = TEX.terrainRock()（程序化裸岩，无砌块网格），  世界周期 26.00 m，UV 旋转 −41°
   * 周期比 1 : 2.17 : 12.6，互不成整数比，三张图的平铺网格不可能同时对齐；
   * 再叠 macro 的 3.7 / 11.3 / 28.9 三层，近景 5 m 内看不出可辨的重复。
   * 土用旋转而不是平铺：road 自带两条车辙，斜着过坡面读成黄土坡上的水蚀细沟。
   *
   * 权重 aTerrW 由 terrainWeights() 在 CPU 逐顶点算好（见该函数），
   * 这里只做加权混合，不做 smoothstep —— fragment 端没有额外判断成本。
   *
   * 距离 LOD：uTerrLodNear 以内走完整三层，Near→Far 平滑淡出，Far 以外只采基础层。
   * 三档画质只改这两个距离，层数不变，所以三档观感一致。
   */
  const patchTerrain = (mat, opts) => {
    const { soil, rock, macro, baseRepeat, lodNear, lodFar } = opts;
    // road 素材带 roughnessMap，回退的程序化 road 没有 —— 用 define 决定是否采第三张图。
    // 不这么写的话，null 会被绑成空纹理、采样得到 0，整个地形会变成镜面。
    if (soil.roughnessMap) mat.defines = { ...(mat.defines || {}), TERRAIN_SOIL_ROUGH: '' };

    // uniform 在编译前就建好并挂到 material.userData：
    // main.js 的 applyQuality 会在首帧编译之前改 uTerrLodNear/Far，
    // 若放在 onBeforeCompile 里创建，那时还拿不到对象，档位就落不下去。
    const uniforms = {
      uGreen: seasonUniform,
      uWet: weatherUniforms.wet,
      uSnow: weatherUniforms.snow,
      uSoilMap: { value: soil.map },
      uSoilNormal: { value: soil.normalMap },
      uSoilRough: { value: soil.roughnessMap || null },
      uRockMap: { value: rock.map },
      uRockNormal: { value: rock.normalMap },
      uBaseRepeat: { value: baseRepeat },
      // 归一化 uv（0..1 覆盖整块地形）上的平铺次数：620 / 周期
      uSoilTiles: { value: (EXT * 2) / TERRAIN.SOIL_TILE },
      uRockTiles: { value: (EXT * 2) / TERRAIN.ROCK_TILE },
      // 草层第二尺度：同一张 grass 转 61°、周期 7.9 m。
      // 村内 f=0 时只有草层，单靠 2.07 m 周期在近景 5 m 内就是 2.4 个重复，必须再叠一层。
      uGrassTiles2: { value: (EXT * 2) / TERRAIN.GRASS_TILE2 },
      uTerrLodNear: { value: lodNear },
      uTerrLodFar: { value: lodFar },
      // 教学标注层：等高线开关（0 关 / 1 开），线间隔写死在地形 shader 内（2 m）
      uContour: { value: 0 },
    };
    mat.userData.terrainUniforms = uniforms;

    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      if (!shader.fragmentShader.includes('uniform float uGreen')) {
        shader.fragmentShader = 'uniform float uGreen;\nuniform float uWet;\nuniform float uSnow;\n'
          + shader.fragmentShader;
      }

      // ---- 顶点：权重属性透传 ----
      shader.vertexShader = 'attribute vec3 aTerrW;\nvarying vec3 vTerrW;\nvarying float vWorldY;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n         vTerrW = aTerrW;\n         vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;'
      );

      // ---- 片元：uniform 声明 ----
      shader.fragmentShader = `
uniform sampler2D uSoilMap;
uniform sampler2D uSoilNormal;
uniform sampler2D uSoilRough;
uniform sampler2D uRockMap;
uniform sampler2D uRockNormal;
uniform float uBaseRepeat;
uniform float uSoilTiles;
uniform float uRockTiles;
uniform float uGrassTiles2;
uniform float uTerrLodNear;
uniform float uTerrLodFar;
uniform float uContour;
varying vec3 vTerrW;
varying float vWorldY;
` + shader.fragmentShader;

      const macroFrag = macro ? attachMacro(shader, macro) : '';

      // ---- 1) 颜色：三层加权 ----
      // vMapUv = uv * uBaseRepeat，除以 uBaseRepeat 拿回 0..1 的地形归一化坐标。
      // _w / _lod / 两个 UV 变量都定义在这一层，后面法线与粗糙度直接复用（同一 main 作用域）。
      //
      // 注意：这里**不能**保留 `#include <map_fragment>`。
      // 那个 chunk 已经把 diffuseColor 乘过一次 map；再乘 _cG（同一张 map）会乘两遍，
      // 草地会明显偏暗偏饱和。所以这一层是「替换」而不是「追加」：自己完成基础层采样。
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `// —— 地形三层混合（v1.2）——
         vec2 _baseUv = vMapUv / uBaseRepeat;
         // 土与石各转一个角度，让三张图的平铺网格互不平行（mat2 是列主序）
         const mat2 _ROT_SOIL = mat2(0.8910, -0.4540, 0.4540, 0.8910);   // +27°
         const mat2 _ROT_ROCK = mat2(0.7550, 0.6560, -0.6560, 0.7550);   // −41°
         // 草层第二尺度：同一张 grass、周期 7.9 m，与第一层同向但错开相位。
         // 早先给它转 61°，两层方向不同的网格叠出斜向摩尔纹；同向不同周期只打散周期、不产生交叉格子。
         vec2 _soilUv = _ROT_SOIL * (_baseUv * uSoilTiles) + vec2(0.13, 0.57);
         vec2 _rockUv = _ROT_ROCK * (_baseUv * uRockTiles) + vec2(0.61, 0.23);
         vec2 _grassUv2 = _baseUv * uGrassTiles2 + vec2(0.37, 0.61);

         // 相机距离 LOD：近处完整三层，远处退回基础层（任务要求"只在近景提升"）
         float _camD = length(vViewPosition);
         float _lod = 1.0 - smoothstep(uTerrLodNear, uTerrLodFar, _camD);

         // 颜色：三层**始终**按权重混合。
         // 早先把远处也一起降级成单层，结果山体离相机总有 100+ m、_lod 恒为 0，
         // 整座山只剩一张 grass 的 mipmap 平均色，草/土/石的层次完全消失。
         // 正确的"远景简化"是省掉细节层（草层第二尺度、三层法线、三层粗糙度），
         // 而不是省掉材质本身 —— 三次颜色采样在远处像素少，负担很小。
         vec3 _cG = texture2D(map, vMapUv).rgb;
         if (_lod > 0.004) {
           // 草层第二尺度只在近景叠，远处省一次采样。
           // 权重 0.18：足够打散 2.07m 的单一周期，又不会把两层图案差异放大成新的规律纹理。
           _cG = mix(_cG, texture2D(map, _grassUv2).rgb, 0.18 * _lod);
         }
         vec3 _cS = texture2D(uSoilMap, _soilUv).rgb;
         vec3 _cR = texture2D(uRockMap, _rockUv).rgb;
         vec3 _w = vec3(1.0 - vTerrW.y - vTerrW.z, vTerrW.y, vTerrW.z);
         diffuseColor.rgb *= _cG * _w.x + _cS * _w.y + _cR * _w.z;
         // 等高线（教学标注层）：每 2 m 一条，fwidth 抗锯齿；uContour 0 关 / 1 开
         if (uContour > 0.5) {
           float _ch = vWorldY / 2.0;
           float _cf = abs(fract(_ch) - 0.5);
           float _cl = smoothstep(0.5 - fwidth(_ch) * 1.4, 0.5 + fwidth(_ch) * 1.4, _cf);
           diffuseColor.rgb *= 1.0 - _cl * 0.72;
         }
${macroFrag}${seasonTail()}`
      );

      // ---- 2) 粗糙度：三层加权（本 chunk 在 normal_fragment_begin 之前）----
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
         float _rG = texture2D(roughnessMap, vMapUv).g;
#else
         float _rG = 1.0;
#endif
#ifdef TERRAIN_SOIL_ROUGH
         float _rS = 0.95;
         // 粗糙度也只在近景采第三张图，远处用常量，与法线同一个 LOD 判据
         if (_lod > 0.004) _rS = texture2D(uSoilRough, _soilUv).g;
#else
         float _rS = 0.95;
#endif
         // 石块比土更糙、比草面更干；乘权重后仍是原量级，不会把材质推到镜面
         roughnessFactor *= _rG * _w.x + _rS * _w.y + 0.90 * _w.z;`
      );

      // ---- 3) 法线：三层切线空间法线按同一组权重混，再走 tbn ----
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
         vec3 _nG = texture2D(normalMap, vMapUv).xyz * 2.0 - 1.0;
         // z 用基础层原值，且整体只 normalize 一次：
         // three 原版是 normalize(tbn * mapN)；若在这里先把 xy 归一化到 z=1 再乘 normalScale，
         // 法线会被压平、normalScale 效果削掉一截，近景反而更容易看出贴图重复。
         vec3 _nMix = _nG;
         if (_lod > 0.004) {
           vec3 _nS = texture2D(uSoilNormal, _soilUv).xyz * 2.0 - 1.0;
           vec3 _nR = texture2D(uRockNormal, _rockUv).xyz * 2.0 - 1.0;
           _nMix.xy = _nG.xy * _w.x + _nS.xy * _w.y + _nR.xy * _w.z;
         }
         _nMix.xy *= normalScale;
         normal = normalize(tbn * _nMix);
#endif
         // 积雪把微表面抹平：雪盖厚时法线几乎完全拉回几何法线。
         // 早先只拉到 0.75，剩下 25% 的石层凹凸在雪面上仍会显出一片方格网，
         // 属于「雪天异常色块」，所以拉到 0.95。
         normal = normalize(mix(normal, nonPerturbedNormal, uSnow * 0.95));`
      );
    };
    mat.needsUpdate = true;
    return mat;
  };

  const root = new THREE.Group();
  scene.add(root);

  /* ================= 天空 ================= */
  const cloudTex = TEX.cloudLayer();
  const skyUniforms = {
    topColor: { value: new THREE.Color(0x6b88a4) },
    botColor: { value: new THREE.Color(0xb9c2c2) },
    uCloud: { value: cloudTex.map },
    uTime: { value: 0 },
    uCoverage: { value: 0.44 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.88) },
    uSunI: { value: 1 },
  };

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 botColor;
      uniform sampler2D uCloud;
      uniform float uTime;
      uniform float uCoverage;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunI;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float t = clamp(h * 1.5 + 0.14, 0.0, 1.0);
        vec3 base = mix(botColor, topColor, t);

        // 云：用球面坐标采样。
        // 之前用 d.xz/h 的平面投影，低仰角处 uv 会爆掉，采样频率过高 → 混叠成一条灰带。
        float cloud = 0.0;
        {
          float phi = atan(d.z, d.x);
          float theta = acos(clamp(d.y, -1.0, 1.0));
          vec2 uv = vec2(phi * 0.15915, theta * 0.31831);   // 1/2π, 1/π
          uv = uv * vec2(7.0, 4.0) + vec2(uTime * 0.004, uTime * 0.0016);
          vec4 s1 = texture2D(uCloud, uv);
          vec4 s2 = texture2D(uCloud, uv * 0.41 + vec2(0.37, 0.71));
          cloud = clamp(s1.a * 0.72 + s2.a * 0.55, 0.0, 1.0);
          cloud *= smoothstep(0.015, 0.26, h);
          // 覆盖度 1.0 时阈值必须高于 1，否则晴天还留着一层云
          float thresh = mix(0.02, 1.12, uCoverage);
          cloud *= smoothstep(thresh, thresh + 0.22, cloud);
        }

        vec3 cloudCol = mix(vec3(0.74, 0.77, 0.80), vec3(0.95, 0.96, 0.97), smoothstep(0.2, 0.9, cloud));
        vec3 col = mix(base, cloudCol, cloud * 0.92);

        // 地平线大气雾化。
        // 范围必须拉宽：原来在 h=0.16 处收尾，正好落在画面顶部，
        // 形成一条亮度突变的横带。雾带颜色必须与场景雾色(=botColor)一致，
        // 否则远山会在亮带前形成一条突兀的断层。
        col = mix(botColor, col, smoothstep(-0.10, 0.46, h));

        // 落日方向的地平线暖光：西边天幕泛橙、背面仍是冷蓝，这是黄昏最像黄昏的地方
        vec3 hd = normalize(vec3(d.x, 0.0, d.z));
        vec3 sd = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
        float azF = max(dot(hd, sd), 0.0);
        float lowSky = exp(-max(h, 0.0) * 5.5);
        col = mix(col, uSunColor * vec3(1.0, 0.52, 0.22), lowSky * pow(azF, 2.5) * uSunI * 0.55);

        // 太阳本体与光晕：位置逐帧连续，日出日落时能看见它压着山脊走
        float sd2 = max(dot(d, normalize(uSunDir)), 0.0);
        float glow = pow(sd2, 620.0) * 0.55 + pow(sd2, 34.0) * 0.14;
        float disc = smoothstep(0.99962, 0.99986, sd2);
        col += uSunColor * (disc * 2.8 + glow) * uSunI;

        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
  scene.add(sky);

  scene.fog = new THREE.FogExp2(0xbcc4c6, 0.0018);

  /* ================= 光照 ================= */
  const hemi = new THREE.HemisphereLight(0xa6bccd, 0x6b6047, 0.86);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.5);
  sun.position.set(118, 58, 124);
  sun.castShadow = true;
  // 阴影范围要同时盖住村子（x −105…105）和东边的孤山（x 95…245）：
  // 正交框中心挪到 x=70、半宽 180 → 覆盖 x −110…250、z ±180。
  // 代价是每像素覆盖的地面变宽（2048 / 360m ≈ 5.7 px/m），村内影子会比之前软一点。
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 60;
  sun.shadow.camera.far = 520;
  const S = 180;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  // 改了正交范围必须重算投影矩阵，否则阴影相机还停在默认的 10m 盒子里
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.045;
  // 光照方向仍以太阳矢量定义，只把"看着哪儿"的靶点挪到 70，见 environment.js
  sun.userData.shadowCenter = { x: 70, z: 0 };
  sun.target.position.set(70, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const bounce = new THREE.DirectionalLight(0x9fb8c8, 0.30);
  bounce.position.set(-80, 40, -90);
  scene.add(bounce);

  // 月光：只在夜里生效的冷色补光，不投影（省一遍 shadow pass）
  const moon = new THREE.DirectionalLight(0xa8c2e6, 0);
  moon.position.set(-120, 150, -70);
  scene.add(moon);

  /* ================= 地形 ================= */
  // 有实景素材就用实景（画质分水岭），没有则回退程序化
  const gTex = assets?.grass || TEX.grass();
  // 密到远处 mipmap 直接抹平，就不再有可辨的方格
  const gRepeat = assets?.grass ? 300 : 96;
  // 河谷只有 12m 宽，原来 3.26m 一格的均匀网格在岸坡上只剩两三个采样点，
  // 再平滑的剖面也会被插值成折线。这里只在河道带 [-118,-82] 内把 x 方向
  // 加密到 0.54m，其余区域维持原密度：约多 1 万个顶点，draw call 不变。
  const EXT = 310, NZ = 190, STEP = (EXT * 2) / NZ;
  const zs = Array.from({ length: NZ + 1 }, (_, j) => -EXT + STEP * j);
  const xs = [];
  for (let i = 0; i <= NZ; i++) {
    const x0 = -EXT + STEP * i;
    xs.push(x0);
    if (i < NZ && x0 >= -118 && x0 < -82) {
      for (let k = 1; k < 6; k++) xs.push(x0 + STEP * k / 6);
    }
  }
  const NX = xs.length;
  const groundGeo = new THREE.BufferGeometry();
  {
    const vp = new Float32Array(NX * (NZ + 1) * 3);
    const uv = new Float32Array(NX * (NZ + 1) * 2);
    const idx = [];
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i, x = xs[i], z = zs[j];
        vp[n * 3] = x; vp[n * 3 + 1] = heightAt(x, z); vp[n * 3 + 2] = z;
        uv[n * 2] = (x + EXT) / (EXT * 2);
        uv[n * 2 + 1] = (EXT - z) / (EXT * 2);   // 与 PlaneGeometry.rotateX 后的 v 方向一致
      }
    }
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = (j + 1) * NX + i;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    groundGeo.setAttribute('position', new THREE.BufferAttribute(vp, 3));
    groundGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    groundGeo.setIndex(idx);
  }
  groundGeo.computeVertexNormals();

  // 三层混合权重：必须在 computeVertexNormals() 之后算 —— 坡度项要用几何法线。
  // 只追加一条 vec3 属性（46,986 顶点 ≈ 564 KB），顶点位置 / 索引 / UV / 网格密度都不动。
  groundGeo.setAttribute('aTerrW',
    new THREE.BufferAttribute(terrainWeights(groundGeo), 3));

  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
    map: gTex.map,
    normalMap: gTex.normalMap,
    roughnessMap: gTex.roughnessMap || null,
    normalScale: new THREE.Vector2(assets?.grass ? 1.35 : 0.8, assets?.grass ? 1.35 : 0.8),
    roughness: gTex.roughnessMap ? 1 : 0.96,
    metalness: 0,
  }));
  // 地形专用：草（grass）+ 土（road，实拍夯土）+ 石（程序化石块）三层加权混合。
  // 土沿用实拍 road 的完整 PBR（含 roughnessMap），石用程序化 stone（无 roughness，用常量 0.90）。
  patchTerrain(ground.material, {
    soil: assets?.road || TEX.road(),
    rock: TEX.terrainRock(),
    macro: TEX.groundMacro().map,
    baseRepeat: gRepeat,
    lodNear: 36, lodFar: 58,     // 默认中档口径；main.js 的 applyQuality 会按档位覆写
  });
  ground.receiveShadow = true;
  root.add(ground);

  // 地面放大后加密贴图平铺
  gTex.map.repeat.set(gRepeat, gRepeat);
  gTex.normalMap.repeat.set(gRepeat, gRepeat);
  if (gTex.roughnessMap) gTex.roughnessMap.repeat.set(gRepeat, gRepeat);

  // 顶点色只保留两件事：海拔压暗、河床沙砾。
  // 草 / 土 / 石的材质分带已经交给 aTerrW + 三层 PBR 混合（见 patchTerrain），
  // 这里再乘一遍 SOIL/ROCK 的强色偏（原来是土黄 ×1.52、岩石蓝 ×1.95）会让颜色被乘两遍，
  // 混合出来的裸土和岩石直接过饱和，所以那两行按本轮改动去掉了。
  {
    const col = [];
    const p2 = groundGeo.attributes.position;
    for (let i = 0; i < p2.count; i++) {
      const x = p2.getX(i), z = p2.getZ(i), y = p2.getY(i);

      // 原有的"高处偏冷偏暗"是给远处山脊用的；孤山有自己的调色板，
      // 再叠这层压暗会把山顶压回深橄榄色，岩石就看不出来了，所以按 f 让它退出
      const f = Math.min(1, Math.max(0,
        hillLift(x, z) / HILL_LIFT + (fbm(x * 0.055, z * 0.055, 2) - 0.5) * 0.07));
      const k = Math.min(1, Math.max(0, (y - 10) / 46));
      const shade = 1 - k * 0.30 * (1 - Math.min(1, f * 1.5));

      // 河床不能是绿草地：顶点色乘成偏沙砾的土黄，透过浅水能读到河底。
      // 与海拔压暗共用一次遍历，不额外建网格、不增加 draw call。
      let rt = 0;
      if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12) {
        const rd = Math.abs(x - riverCenterX(z));
        if (rd < RIVER.out) rt = 1 - sm01((rd - RIVER.half * 0.55) / (RIVER.out - RIVER.half * 0.55));
      }
      col.push(shade * (1 + rt * 0.42), shade * 0.97 * (1 + rt * 0.02), shade * 0.9 * (1 - rt * 0.42));
    }
    groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    ground.material.vertexColors = true;
    ground.material.needsUpdate = true;
  }

  /* ================= 村西小河：水面层 =================
   * 单独一层水平带，绝对不做实时反射（Reflector/SSR 那种昂贵的东西一律不碰）：
   * 天光反射全部来自 scene.environment 里的 HDRI（Poly Haven 阴天开阔田野），
   * 流水感只靠程序化法线贴图沿流向缓慢滚动。
   * 带子铺到 |d|=4.2m，比岸坡与水位线的交线（≈3.88m）略宽，
   * 多出来的部分被地形深度遮住，所以水面边缘是自然裁出来的，不会悬空一条缝。 */
  const waterState = { mat: null, normal: null, mesh: null };
  {
    const W = 4.2, Z0 = RIVER.z0 - 12, Z1 = RIVER.z1 + 12, M = 16, N = 280;
    const wPos = [], wUv = [], wIdx = [];
    for (let j = 0; j <= N; j++) {
      const z = Z0 + (Z1 - Z0) * j / N;
      const c = riverCenterX(z);
      for (let i = 0; i <= M; i++) {
        wPos.push(c + W * (-1 + 2 * i / M), RIVER.waterY, z);
        wUv.push(i / M * 2, j / N * 46);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < M; i++) {
        const a = j * (M + 1) + i, b = (j + 1) * (M + 1) + i;
        wIdx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const wGeo = new THREE.BufferGeometry();
    wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
    wGeo.setIndex(wIdx);
    wGeo.computeVertexNormals();

    const nTex = TEX.water().normalMap.clone();
    nTex.needsUpdate = true;
    nTex.wrapS = nTex.wrapT = THREE.RepeatWrapping;
    nTex.repeat.set(1, 1);          // 重复次数已编进 uv，滚动只动 offset

    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x4c7078,
      normalMap: nTex,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.075,             // 低粗糙度，HDRI 天光能成片地铺在水面上
      metalness: 0.34,
      envMapIntensity: 2.8,
      transparent: true,
      opacity: 0.70,
      depthWrite: false,            // 半透明层，不写深度，免得挡住后面的河床
      side: THREE.DoubleSide,
    });
    if (scene.environment) waterMat.envMap = scene.environment;
    // 掠射角补一层天光：纯视角项，不采样场景、不做任何实时反射。
    // 用的法线是 normalMap 扰动后的，所以这层高光会跟着滚动的波纹一起流动；
    // 颜色直接引用天空 uniform，阴天/黄昏/雪天会和天色一起变，不会白天亮夜里还亮。
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyColor = skyUniforms.topColor;
      shader.vertexShader = 'varying vec3 vRiverView;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n         vRiverView = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;'
      );
      shader.fragmentShader = 'uniform vec3 uSkyColor;\nvarying vec3 vRiverView;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         float _fres = pow(1.0 - abs(dot(normalize(vRiverView), normal)), 3.0);
         gl_FragColor.rgb += uSkyColor * _fres * 0.68;
         gl_FragColor.a = min(1.0, gl_FragColor.a + _fres * 0.22);`
      );
    };
    const water = new THREE.Mesh(wGeo, waterMat);
    water.name = 'river-water';
    water.renderOrder = 2;
    root.add(water);
    waterState.mat = waterMat;
    waterState.normal = nTex;
    waterState.mesh = water;
  }

  /* ================= 远景山体：给村子一圈纵深 ================= */
  // 原来地形只有 620 m 见方，边缘之外直接接天，远处看去就是一条灰带。
  {
    const g = new THREE.PlaneGeometry(3200, 3200, 160, 160);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const col = [];
    const sm = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const d = Math.hypot(x, z);
      // 内圈沿用地形高度场，与 620m 地形边缘无缝衔接；
      // 但地形网格覆盖范围内必须压低藏在下面，否则共面 z-fighting 会打成迷彩斑块
      // 这里只取底板高度、不含孤山：远山网格 20m 一格，采样 58m 的山会顶出地形，形成斑块
      const local = baseHeight(x, z);
      const dx = Math.max(0, Math.abs(x) - 306);
      const dz = Math.max(0, Math.abs(z) - 306);
      const edge = Math.hypot(dx, dz);        // 0 = 仍在地形网格覆盖内
      // 远山网格 20m 一格、地形 3.26m 一格，同样取 heightAt 但插值曲率不同，
      // 误差可达数米：下潜太浅山面会从地形里顶出来，形成一片片不规则斑块。
      // 出边界后 sink 归零，衔接仍然无高差。
      //
      // v1.2 地形材质：原来只按 edge 固定下潜 4m，但远山用的是 baseHeight（不含孤山），
      // 孤山抬升 58m 时远山会与地形齐平甚至顶出来，把整座地形孤山盖住 ——
      // 地形材质再怎么改，山上都看不见。这里按 hillLift 加权补下潜，
      // 保证地形范围内的远山严格低于地形表面。村内 hillLift=0，行为不变。
      const sink = 4.0 * (1 - sm(edge / 70)) + hillLift(x, z) * 1.12;
      // 中圈：快速隆起盖住地形边界；外圈：升为岷山北麓高山
      const rise = sm((d - 330) / 620);
      const rise2 = sm((d - 820) / 900);
      const ridge = 0.58 + 0.42 * fbm(x * 0.0016, z * 0.0016, 4);
      const spur = (fbm(x * 0.0061 + 11, z * 0.0061 + 5, 3) - 0.5) * 34 * rise;
      const mtn = (70 + 240 * rise2) * ridge + spur + rise * 42;
      const k = sm(edge / 240);
      const h = (local - sink) * (1 - k) + mtn * k;
      p.setY(i, h);

      // 空气透视：内圈贴近地形草色，越远越偏冷灰蓝，让山往后退
      const kc = sm((d - 340) / 1300);
      const hi = Math.min(1, Math.max(0, h / 320)) * 0.04;
      const r0 = 0.47 + (0.54 - 0.47) * kc + hi;
      const g0 = 0.51 + (0.58 - 0.51) * kc + hi;
      const b0 = 0.36 + (0.52 - 0.36) * kc + hi;
      col.push(r0, g0, b0);
    }

    g.computeVertexNormals();
    // 把坡面明暗预烘进顶点色：远山不该跟着近景的强直射光走，
    // 否则晴天向阳坡过曝成白斑、背阴坡塌成黑斑，像贴了一层云影
    {
      const nrm = g.attributes.normal;
      for (let i = 0; i < nrm.count; i++) {
        const s = 0.84 + 0.16 * Math.max(0, nrm.getY(i));
        col[i * 3] *= s; col[i * 3 + 1] *= s; col[i * 3 + 2] *= s;
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, fog: true, side: THREE.DoubleSide,
    }));
    m.material.userData.isMountain = true;   // 由 environment.js 按昼夜调色
    m.receiveShadow = false;
    m.castShadow = false;
    root.add(m);
  }

  /* ================= 道路：三类路面，一次合批 =================
   * 单位：宽度 / 长度 / 抬升 m，坐标为世界坐标（x 东 / z 南）。
   *
   * 三类（参数集中在 ROAD_KIND，都是「现有素材 + 顶点色/材质参数」，不新增贴图）：
   *   main     水泥主路：路面 6.2 m（ROAD.width）+ 两侧各 0.45 m 路肩。
   *            顶点色灰白、去饱和 0.55（把夯土贴图的黄压掉）、粗糙度 0.78（轻微反光）。
   *   shoulder 路肩：比路面低 0.035 m，土石色、粗糙度 0.98。三类里只有主路有路肩。
   *   lane     土质巷道：2.8~3.0 m，两侧各 0.18 m 倒角压下去 0.03，不设路肩。
   *   ridge    田埂小路：0.70 m，中间拱起 0.07 m，两侧顶点直接给草色、没进草里。
   *
   * 全部推进同一组缓冲 → 1 个 Mesh / 1 个材质 / 1 个 draw call。
   * 改造前是主路 1 + 5 条巷道各 1 = 6 个，本轮 −5。
   * 逐点取 heightAt 贴地形，不再用「中心点一处高度」的平面近似（坡上会插地或悬空）。
   */
  let roadMesh = null;
  let roadVerts = 0;
  const roadSpine = [];   // 主路中线采样点，供草层 inRoad() 判定，避免草穿透路面
  const roadStats = { main: 1, lane: LANES.length, ridge: RIDGES.length };
  {
    // rough 粗糙度（0 镜面 → 1 全漫反射）、nrm 法线强度倍率、desat 去饱和量、
    // col 顶点色乘数、dy 相对 heightAt 的抬升（m）、uv 贴图一格对应的世界尺寸（m）、
    // uvOff 贴图横向偏移（张数）：road 贴图中间偏上有一条车辙暗带，田埂太窄会整条落在暗带上。
    const ROAD_KIND = {
      main:     { rough: 0.78, nrm: 0.55, desat: 0.55, col: [0.96, 0.97, 0.96], dy: 0.080, uv: 2.6 },
      shoulder: { rough: 0.98, nrm: 1.00, desat: 0.08, col: [0.66, 0.56, 0.42], dy: 0.045, uv: 1.6 },
      lane:     { rough: 0.94, nrm: 0.85, desat: 0.08, col: [0.62, 0.50, 0.36], dy: 0.060, uv: 1.7 },
      laneEdge: { rough: 0.99, nrm: 1.00, desat: 0.08, col: [0.48, 0.40, 0.30], dy: 0.060, uv: 1.7 },
      ridge:    { rough: 1.00, nrm: 0.60, desat: 0.62, col: [2.30, 2.02, 1.46], dy: 0.160, uv: 1.4, uvOff: 0.5 },
    };
    const GRASS_COL = [0.98, 1.04, 0.62];   // 田埂两侧没入草里的颜色（只占断面外缘 14%）
    // road 贴图在田埂这段 UV 上偏暗（实测约 0.15），顶点色要给到 2.3 才读得出干土色；
    // 过曝测试 (3,3,3) 会变成亮灰白，2.3 落在"浅干土"上。
    const RIDGE_COL = [2.30, 2.02, 1.46];

    const pos = [], uv = [], col = [], srf = [], idx = [];

    /**
     * 沿中心线铺一条路面带。
     * pts   [{x, z, s}]，s 是沿路累计距离（m）
     * halfW 半宽（m）
     * bands [{a, b, ya, yb, kind, colA, colB, wob}]
     *   a/b   横向比例（-1..1），宽度 = t * halfW
     *   ya/yb 两端额外抬升（m），叠加在 kind.dy 上
     *   wob   边缘毛化幅度（m），用 (沿路 s, 横向 t) 做噪声输入 —— 相邻带在同一个 t 上
     *         取值相同，接缝不会错开；田埂太窄，不毛。
     */
    const addRibbon = (pts, halfW, bands) => {
      const nrm = pts.map((p, i) => {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
        const tx = p1.x - p0.x, tz = p1.z - p0.z;
        const l = Math.hypot(tx, tz) || 1;
        return { x: -tz / l, z: tx / l };
      });
      for (const bd of bands) {
        const K = ROAD_KIND[bd.kind];
        const base = pos.length / 3;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], n = nrm[i];
          for (const side of [0, 1]) {
            const t = side ? bd.b : bd.a;
            const wob = bd.wob
              ? (fbm(p.s * 0.21 + t * 7.3, t * 3.7 + 11, 2) - 0.5) * bd.wob * Math.sign(t)
              : 0;
            const off = t * halfW + wob;
            const x = p.x + n.x * off, z = p.z + n.z * off;
            pos.push(x, heightAt(x, z) + K.dy + (side ? bd.yb : bd.ya), z);
            uv.push(off / K.uv + (K.uvOff || 0), p.s / K.uv);
            const c = (side ? (bd.colB || bd.col) : (bd.colA || bd.col)) || K.col;
            col.push(c[0], c[1], c[2]);
            srf.push(K.rough, K.nrm, K.desat);
          }
          if (i > 0) {
            // 绕序：a 端在切线左侧、b 端在右侧；(a, a+1, b) 的叉积朝 +y，
            // 写反会让整条路法线朝下、从上方被背面剔除。
            const a = base + (i - 1) * 2, b = base + i * 2;
            idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
      }
    };

    /** 直线段 → 采样点，step 是采样间距（m），s 是沿路累计距离 */
    const linePts = (a, b, step) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(2, Math.ceil(len / step));
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, s: len * t });
      }
      return out;
    };

    // ---- 1. 水泥主路 + 两侧路肩 ----
    {
      const curve = new THREE.CatmullRomCurve3(
        ROAD.points.map(([x, z]) => new THREE.Vector3(x, 0, z))
      );
      const N = 220, totalLen = curve.getLength();
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N, p = curve.getPoint(t);
        pts.push({ x: p.x, z: p.z, s: totalLen * t });
      }
      roadSpine.push(...pts);
      const hw = ROAD.width / 2, sw = ROAD.shoulder / hw;
      addRibbon(pts, hw, [
        { a: -1 - sw, b: -1, ya: -0.035, yb: 0, kind: 'shoulder',
          colA: [0.58, 0.50, 0.38], colB: [0.78, 0.70, 0.56], wob: 0.22 },
        { a: -1, b: 1, ya: 0, yb: 0, kind: 'main', wob: 0.22 },
        { a: 1, b: 1 + sw, ya: 0, yb: -0.035, kind: 'shoulder',
          colA: [0.78, 0.70, 0.56], colB: [0.58, 0.50, 0.38], wob: 0.22 },
      ]);
    }

    // ---- 2. 土质巷道（原先 5 条各一个 Mesh，现在推进同一缓冲）----
    for (const L of LANES) {
      addRibbon(linePts(L.a, L.b, 2.0), L.w / 2, [
        { a: -1, b: -0.88, ya: -0.030, yb: 0, kind: 'laneEdge', wob: 0.10 },
        { a: -0.88, b: 0.88, ya: 0, yb: 0, kind: 'lane', wob: 0.10 },
        { a: 0.88, b: 1, ya: 0, yb: -0.030, kind: 'laneEdge', wob: 0.10 },
      ]);
    }

    // ---- 3. 田埂小路（新增）----
    for (const G of RIDGES) {
      // 四段截面：外侧 14% 缓坡做草色过渡，中间 86% 是平顶土色。
      // 只做「两段线性插值」的话，草色会摊到半个断面，整条埂被拖成深褐色，像一条沟。
      addRibbon(linePts(G.a, G.b, 2.5), G.w / 2, [
        { a: -1, b: -0.86, ya: 0, yb: 0.020, kind: 'ridge', colA: GRASS_COL, colB: RIDGE_COL },
        { a: -0.86, b: 0, ya: 0.020, yb: 0.120, kind: 'ridge', colA: RIDGE_COL, colB: RIDGE_COL },
        { a: 0, b: 0.86, ya: 0.120, yb: 0.020, kind: 'ridge', colA: RIDGE_COL, colB: RIDGE_COL },
        { a: 0.86, b: 1, ya: 0.020, yb: 0, kind: 'ridge', colA: RIDGE_COL, colB: GRASS_COL },
      ]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // aSurf = (粗糙度, 法线强度倍率, 去饱和量)，逐顶点区分三类路面
    geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(srf, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const rTex = assets?.road || TEX.road();
    const roadMat = new THREE.MeshStandardMaterial({
      map: rTex.map,
      normalMap: rTex.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 1.0,           // 真实值由 aSurf.x 逐顶点覆写
      metalness: 0,
      vertexColors: true,
      polygonOffset: true,      // 三类都高于地形与耕地田面，靠 offset 压住，不 z-fighting
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -4,
    });

    const roadMacro = TEX.groundMacro().map;
    roadMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSnow = weatherUniforms.snow;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.uniforms.uRoadMacro = { value: roadMacro };

      shader.vertexShader = 'attribute vec3 aSurf;\nvarying vec3 vSurf;\nvarying vec3 vRoadWorld;\n'
        + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSurf = aSurf;
         vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

      shader.fragmentShader = 'uniform float uSnow;\nuniform float uWet;\nuniform sampler2D uRoadMacro;\n'
        + 'varying vec3 vSurf;\nvarying vec3 vRoadWorld;\n' + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `// 去饱和要在乘顶点色之前：水泥把夯土贴图的黄压掉，土巷保留原色
         float _rLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(_rLum), vSurf.z);
         #include <color_fragment>
         // 大尺度干湿/新旧：与院墙共用同一张 macro，不新增素材
         float _rA = texture2D(uRoadMacro, vRoadWorld.xz * 0.0075).g;
         float _rB = texture2D(uRoadMacro, vRoadWorld.xz * 0.031 + vec2(0.37, 0.61)).g;
         float _rM = _rA * 0.68 + _rB * 0.32;
         diffuseColor.rgb *= mix(vec3(0.78, 0.76, 0.72), vec3(1.16, 1.13, 1.06), _rM);
         // 雪：水泥路面留白厚、土面与田埂透一点土色；湿：水泥压暗更多
         float _rSoft = smoothstep(0.70, 1.0, vSurf.x);
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.75, 0.78),
                                uSnow * mix(0.84, 0.70, _rSoft));
         diffuseColor.rgb *= 1.0 - uWet * mix(0.34, 0.20, _rSoft);`
      );

      // 逐顶点粗糙度：水泥 0.78 有轻微反光，土巷 0.94，田埂 1.00
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = vSurf.x;`
      );

      // 逐顶点法线强度：水泥最平（0.55），田埂最起伏（1.10）
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal.xy *= vSurf.y;
         normal = normalize(normal);`
      );
    };

    roadMesh = new THREE.Mesh(geo, roadMat);
    roadMesh.name = 'roads';
    roadMesh.receiveShadow = true;
    roadMesh.castShadow = false;
    root.add(roadMesh);
    roadVerts = pos.length / 3;
  }

  /* ================= 电线杆与架空线 =================
   * 单位：长度 m，坐标 m（世界坐标，x 东 / z 北）。
   * 布局与尺寸的口径写在 data.js 的 POWER_LINE 注释里，这里只负责生成。
   * 合批：杆身 + 横担 + 绝缘子 + 基础 + 拉线锚墩 → 1 个 Mesh（用顶点色区分
   *       混凝土 / 钢 / 瓷三种材质，省掉两个材质槽）；
   *       21 段导线 + 2 根拉线 → 1 个 Mesh。
   *       合计 2 个 draw call（杆投影再 +1，低画质关阴影时只 +2）。
   */
  {
    // 主路中线按 z 反查 x：曲线横向只摆 5 m，600 段采样足够（±0.03 m）
    const roadCurve = new THREE.CatmullRomCurve3(
      ROAD.points.map(([x, z]) => new THREE.Vector3(x, 0, z))
    );
    const SEG = 600, spine = [];
    for (let i = 0; i <= SEG; i++) spine.push(roadCurve.getPoint(i / SEG));
    const midX = (z) => {
      let best = spine[0];
      for (const p of spine) if (Math.abs(p.z - z) < Math.abs(best.z - z)) best = p;
      return best.x;
    };

    // 杆脚：x 由路中线 + 偏距得到，y 取地形（基础再往下埋 0.25 m，坡地不悬空）
    const feet = POWER_LINE.zs.map((z) => {
      const x = midX(z) + POWER_LINE.side * POWER_LINE.offset;
      return new THREE.Vector3(x, heightAt(x, z), z);
    });

    const { shaftTop, arm, armLen, spread, wireY, sag, wireR, guy } = POWER_LINE;

    // 顶点色：一个材质画三种材质，合并后仍然只有 1 个 draw call
    const paint = (geo, hex) => {
      const c = new THREE.Color(hex);
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    const CONCRETE = 0xb4b1a8, STEEL = 0x4a4f53, CERAMIC = 0xdad6c9;
    const parts = [];
    const put = (geo, hex) => { parts.push(paint(geo, hex)); return geo; };

    for (const f of feet) {
      // 基础：高 0.55 m，中心抬 0.03 m → 埋入地下 0.25 m、露出 0.30 m
      put(new THREE.BoxGeometry(0.46, 0.55, 0.46).translate(f.x, f.y + 0.03, f.z), CONCRETE);
      // 杆身：4 棱柱转 45° 就是方杆；下口 0.24 m、上口 0.16 m
      put(new THREE.CylinderGeometry(0.113, 0.170, shaftTop + 0.25, 4, 1)
        .rotateY(Math.PI / 4)
        .translate(f.x, f.y + (shaftTop - 0.25) / 2, f.z), CONCRETE);
      // 杆顶压顶
      put(new THREE.BoxGeometry(0.19, 0.07, 0.19).translate(f.x, f.y + shaftTop + 0.02, f.z), CONCRETE);
      // 横担：压在杆顶，沿世界 x（线路走向基本是 z，交叉 90° 即可）
      put(new THREE.BoxGeometry(armLen, 0.10, 0.09).translate(f.x, f.y + arm, f.z), STEEL);
      // 横担下的抱箍，让横担不是凭空粘在杆上
      put(new THREE.BoxGeometry(0.20, 0.26, 0.14).translate(f.x, f.y + arm - 0.16, f.z), STEEL);
      // 3 只瓷绝缘子（6 棱柱，够看出是瓷瓶）
      for (const dx of [-spread, 0, spread]) {
        put(new THREE.CylinderGeometry(0.062, 0.086, 0.17, 6)
          .translate(f.x + dx, f.y + arm + 0.135, f.z), CERAMIC);
      }
    }

    // 导线：每档 3 根。抛物线近似悬链线（跨中下垂 sag），端点严格落在绝缘子顶
    const wires = [];
    const attach = (f, dx) => new THREE.Vector3(f.x + dx, f.y + wireY, f.z);
    for (let i = 0; i < feet.length - 1; i++) {
      const a = feet[i], b = feet[i + 1];
      for (const dx of [-spread, 0, spread]) {
        const pa = attach(a, dx), pb = attach(b, dx);
        const pts = [];
        for (let k = 0; k <= 4; k++) {
          const t = k / 4;
          const p = pa.clone().lerp(pb, t);
          p.y -= sag * 4 * t * (1 - t);
          pts.push(p);
        }
        wires.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, wireR, 5, false));
      }
    }

    // 两端拉线：从杆顶下方 1.2 m 斜拉到 guy=4.6 m 外的锚墩，直线不下垂
    for (const [f, dir] of [[feet[0], -1], [feet[feet.length - 1], 1]]) {
      const ax = f.x, az = f.z + dir * guy;
      const ay = heightAt(ax, az);
      wires.push(new THREE.TubeGeometry(
        new THREE.LineCurve3(
          new THREE.Vector3(f.x, f.y + shaftTop - 1.2, f.z),
          new THREE.Vector3(ax, ay + 0.34, az)
        ), 1, 0.022, 4, false));
      put(new THREE.BoxGeometry(0.34, 0.52, 0.34).translate(ax, ay + 0.06, az), CONCRETE);
    }

    const poleMesh = new THREE.Mesh(mergeGeometries(parts, false), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.82, metalness: 0.06, flatShading: true,
    }));
    poleMesh.name = 'power-poles';
    poleMesh.castShadow = true;
    poleMesh.receiveShadow = true;
    root.add(poleMesh);

    const wireMesh = new THREE.Mesh(mergeGeometries(wires, false), new THREE.MeshStandardMaterial({
      color: 0x24262a, roughness: 0.55, metalness: 0.15,
    }));
    wireMesh.name = 'power-wires';
    wireMesh.castShadow = false;
    wireMesh.receiveShadow = false;
    root.add(wireMesh);

    // 供 ?qa=1 与 tools/verify-poles.mjs 核对：杆位、档距、导线段数
    const spans = [];
    for (let i = 0; i < feet.length - 1; i++) {
      spans.push(+feet[i].distanceTo(feet[i + 1]).toFixed(2));
    }
    powerLine = {
      poles: feet.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]),
      spans,
      spanMin: Math.min(...spans),
      spanMax: Math.max(...spans),
      wires: wires.length,
      mesh: poleMesh,
      wiresMesh: wireMesh,
    };
  }

  /* ================= 代理盒工具 ================= */
  const proxyMat = new THREE.MeshBasicMaterial();
  proxyMat.visible = false;

  function proxy(data, size, center = [0, 0, 0], parentY = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), proxyMat);
    m.position.set(center[0], center[1] + parentY, center[2]);
    m.userData.objectId = data.id;
    pickables.push(m);
    return m;
  }

  /* ================= 民居 ================= */
  const brickT = TEX.brick();
  const plasterT = TEX.plaster([216, 206, 186]);
  const roofT = TEX.tile();
  const woodT = TEX.wood([122, 88, 58]);
  const stoneT = TEX.stone();

  // 有实景素材优先：砖、瓦都用扫描件，看不出规律性重复
  const rep = (t, x, y) => {
    const c = t.clone();
    c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(x, y);
    return c;
  };

  const matBrick = assets?.brick
    ? new THREE.MeshStandardMaterial({
        map: rep(assets.brick.map, 3.0, 1.9),
        normalMap: rep(assets.brick.normalMap, 3.0, 1.9),
        normalScale: new THREE.Vector2(1.25, 1.25),
        roughness: 0.92,
        metalness: 0,
      })
    : new THREE.MeshStandardMaterial({
        map: brickT.map, normalMap: brickT.normalMap,
        normalScale: new THREE.Vector2(1.9, 1.9), roughness: 0.94,
      });

  const matPlaster = new THREE.MeshStandardMaterial({ map: plasterT.map, normalMap: plasterT.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4), roughness: 0.95 });

  // 檐下软遮蔽：直接烘进墙材质本身。
  // 不能用半透明贴片去叠——那会污染 GTAO 的深度/法线预通道，整片墙会黑白花掉。
  // 村内民居地势基本齐平（heightAt≈0），按世界高度 2.45→3.40m 渐暗即可。
  const addEaveAO = (mat) => {
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'varying float vEaveY;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vEaveY = (modelMatrix * vec4(transformed, 1.0)).y;`
      );
      shader.fragmentShader = 'varying float vEaveY;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _eave = smoothstep(2.45, 3.40, vEaveY) * (1.0 - smoothstep(3.46, 4.05, vEaveY));
         diffuseColor.rgb *= 1.0 - _eave * 0.40;`
      );
    };
    mat.needsUpdate = true;
  };
  addEaveAO(matBrick);
  addEaveAO(matPlaster);

  const matRoof = assets?.roof
    ? new THREE.MeshStandardMaterial({
        map: rep(assets.roof.map, 5.0, 3.4),
        normalMap: rep(assets.roof.normalMap, 5.0, 3.4),
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.78,
        side: THREE.DoubleSide,
      })
    : new THREE.MeshStandardMaterial({ map: roofT.map, normalMap: roofT.normalMap,
        normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.8, side: THREE.DoubleSide });
  // 远处瓦面 mipmap 会被抹成一片死橙色：按世界坐标叠一层低频色差，
  // 让每户屋顶的深浅/老化程度略有不同
  {
    const roofMacro = TEX.groundMacro().map;
    matRoof.onBeforeCompile = (shader) => {
      shader.uniforms.uRoofMacro = { value: roofMacro };
      shader.uniforms.uSnow = weatherUniforms.snow;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.vertexShader = 'varying vec3 vRoofWorld;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRoofWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
      shader.fragmentShader = 'uniform sampler2D uRoofMacro;\nuniform float uSnow;\nuniform float uWet;\nvarying vec3 vRoofWorld;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _rm = texture2D(uRoofMacro, vRoofWorld.xz * 0.021 + 0.37).g;
         float _rm2 = texture2D(uRoofMacro, vRoofWorld.xz * 0.083 + vec2(0.61, 0.12)).g;
         diffuseColor.rgb *= mix(vec3(0.78, 0.75, 0.71), vec3(1.14, 1.10, 1.04), _rm * 0.72 + _rm2 * 0.28);
         // 坡屋顶积雪比平地薄，雨天窗面变暗
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.78, 0.81), uSnow * 0.68);
         diffuseColor.rgb *= 1.0 - uWet * 0.16;`
      );
    };
  }
  const matWood = new THREE.MeshStandardMaterial({ map: woodT.map, normalMap: woodT.normalMap, roughness: 0.78 });
  const matStone = new THREE.MeshStandardMaterial({ map: stoneT.map, normalMap: stoneT.normalMap, roughness: 0.9 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.9 });
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x3d4e58, roughness: 0.18, metalness: 0.55 });
  // 院墙：夯土墙。纯色最假，必须有抹面的颗粒与雨痕
  const matMud = new THREE.MeshStandardMaterial({
    map: rep(plasterT.map, 14.0, 4.2),
    normalMap: rep(plasterT.normalMap, 14.0, 4.2),
    normalScale: new THREE.Vector2(0.75, 0.75),
    color: 0xa08b6e,
    roughness: 0.97,
    vertexColors: true,
  });
  // 世界坐标驱动的大尺度雨痕/泛碱：同一张抹面贴图贴到十几户院墙上，
  // 只靠 UV 相位还是会看出「同一块脏迹」在每户重复，必须按世界坐标取纹理
  {
    const wallMacro = TEX.groundMacro().map;
    matMud.onBeforeCompile = (shader) => {
      shader.uniforms.uWallMacro = { value: wallMacro };
      shader.vertexShader = 'varying vec3 vWallWorld;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWallWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
      shader.fragmentShader = 'uniform sampler2D uWallMacro;\nvarying vec3 vWallWorld;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         vec2 _wuv = vec2(vWallWorld.x * 0.041 + vWallWorld.z * 0.033,
                          vWallWorld.y * 0.13 + vWallWorld.z * 0.012);
         float _dirt = texture2D(uWallMacro, _wuv).g;
         float _rain = texture2D(uWallMacro, _wuv * 2.7 + vec2(0.31, 0.67)).g;
         float _m = _dirt * 0.66 + _rain * 0.34;
         diffuseColor.rgb *= mix(vec3(0.80, 0.79, 0.75), vec3(1.10, 1.08, 1.03), _m);`
      );
    };
  }
  const matSkirt = new THREE.MeshStandardMaterial({ color: 0x6a6055, roughness: 0.97 });
  const matTrim = new THREE.MeshStandardMaterial({ color: 0x6a5640, roughness: 0.82 });
  const matDoor = new THREE.MeshStandardMaterial({
    map: rep(woodT.map, 1.4, 2.2),
    normalMap: rep(woodT.normalMap, 1.4, 2.2),
    color: 0xc9a87a, roughness: 0.84,
  });
  const matWallCap = new THREE.MeshStandardMaterial({ color: 0x585650, roughness: 0.9 });

  // 院内是踩实的夯土地，不该和村外草坡一样长满草
  const yardGroundT = TEX.soil();
  const matYardGround = new THREE.MeshStandardMaterial({
    map: rep(yardGroundT.map, 3.2, 4.0),
    normalMap: rep(yardGroundT.normalMap, 3.2, 4.0),
    normalScale: new THREE.Vector2(0.55, 0.55),
    color: 0xc0b49a, roughness: 0.98,
  });

  /** 双坡屋顶：三角截面沿 Z 拉伸 */
  function gableRoof(w, d, h) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    shape.lineTo(0, h);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    geo.translate(0, 0, -d / 2);
    return geo;
  }

  /* ================= 院内生活物件 ================= */
  // 秋收后晾药材、夏天挂辣椒：两组挂晒物按真实日期切换可见性
  const yardAutumn = [], yardSummer = [];
  const detailMats = {
    wood: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }),
    pole: new THREE.MeshStandardMaterial({ color: 0x9a8158, roughness: 0.88 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0x5d4438, roughness: 0.62 }),
    water: new THREE.MeshStandardMaterial({ color: 0x25333a, roughness: 0.24, metalness: 0.18 }),
    straw: new THREE.MeshStandardMaterial({ color: 0xb69a63, roughness: 0.96 }),
    chili: new THREE.MeshStandardMaterial({ color: 0xa8362a, roughness: 0.8 }),
    tarp: new THREE.MeshStandardMaterial({ color: 0x6c787b, roughness: 0.94 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x242422, roughness: 0.92 }),
  };

  function buildYardDetail(d, g) {
    const [x, z] = d.local;
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const put = (geo, mat, px, py, pz, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
      return m;
    };
    let boxSize, boxCenter;

    if (d.kind === 'drying') {
      for (const sx of [-1.15, 1.15]) {
        put(new THREE.CylinderGeometry(0.055, 0.07, 2.05, 6), detailMats.pole, sx, 1.02, 0);
        put(new THREE.BoxGeometry(0.055, 0.85, 0.055), detailMats.pole,
          sx * 0.86, 1.55, 0, 0, 0, sx * 0.55);
      }
      put(new THREE.BoxGeometry(2.9, 0.085, 0.085), detailMats.pole, 0, 2.02, 0);

      const mkStrings = (mat, geo) => {
        const im = new THREE.InstancedMesh(geo, mat, 40);
        const mx = new THREE.Matrix4(), q = new THREE.Quaternion();
        let n = 0;
        for (let i = 0; i < 8; i++) {
          const bx = -1.05 + i * 0.30;
          for (let j = 0; j < 5; j++) {
            const wob = Math.sin(i * 2.3 + j * 1.7) * 0.018;
            mx.compose(new THREE.Vector3(bx + wob, 1.88 - j * 0.16, wob * 0.6),
              q, new THREE.Vector3(1, 1, 1));
            im.setMatrixAt(n++, mx);
          }
        }
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true;
        const wrap = new THREE.Group();
        wrap.add(im);
        grp.add(wrap);
        return wrap;
      };
      yardAutumn.push(mkStrings(detailMats.straw, new THREE.BoxGeometry(0.13, 0.17, 0.13)));
      yardSummer.push(mkStrings(detailMats.chili, new THREE.BoxGeometry(0.055, 0.21, 0.055)));
      boxSize = [3.0, 2.3, 0.9]; boxCenter = [x, 1.15, z];
    }
    else if (d.kind === 'woodpile') {
      put(new THREE.BoxGeometry(2.0, 0.14, 1.1), matStone, 0, 0.07, 0);
      const logs = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.95, 6), detailMats.wood, 24);
      const mx = new THREE.Matrix4(), q = new THREE.Quaternion();
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      let n = 0;
      for (let layer = 0; layer < 4; layer++) {
        for (let k = 0; k < 6; k++) {
          mx.compose(new THREE.Vector3(-0.62 + k * 0.25 + (layer % 2) * 0.06,
            0.25 + layer * 0.17, (k % 2 ? 0.22 : -0.22)), q, new THREE.Vector3(1, 1, 1));
          logs.setMatrixAt(n++, mx);
        }
      }
      logs.instanceMatrix.needsUpdate = true;
      logs.castShadow = true; logs.receiveShadow = true;
      grp.add(logs);
      put(new THREE.BoxGeometry(2.1, 0.04, 1.2), detailMats.tarp, 0, 1.0, 0, 0, 0, 0.05);
      boxSize = [2.3, 1.2, 1.4]; boxCenter = [x, 0.6, z];
    }
    else if (d.kind === 'waterjar') {
      put(new THREE.CylinderGeometry(0.52, 0.39, 0.92, 14), detailMats.ceramic, 0, 0.46, 0);
      put(new THREE.TorusGeometry(0.52, 0.045, 8, 18), detailMats.ceramic, 0, 0.92, 0, Math.PI / 2);
      put(new THREE.CircleGeometry(0.47, 18), detailMats.water, 0, 0.87, 0, -Math.PI / 2);
      put(new THREE.CylinderGeometry(0.10, 0.08, 0.06, 10), detailMats.wood, 0.64, 0.06, 0.24);
      put(new THREE.BoxGeometry(0.30, 0.035, 0.035), detailMats.wood, 0.82, 0.09, 0.24);
      boxSize = [1.4, 1.1, 1.4]; boxCenter = [x, 0.55, z];
    }
    else if (d.kind === 'cart') {
      put(new THREE.BoxGeometry(1.7, 0.09, 0.95), detailMats.wood, 0, 0.62, 0);
      for (const sz of [-0.47, 0.47]) {
        put(new THREE.BoxGeometry(1.7, 0.26, 0.055), detailMats.wood, 0, 0.78, sz);
      }
      for (const sz of [-0.55, 0.55]) {
        put(new THREE.TorusGeometry(0.32, 0.07, 8, 14), detailMats.rubber, 0, 0.33, sz);
      }
      for (const sx of [-0.38, 0.38]) {
        put(new THREE.BoxGeometry(0.06, 0.06, 1.35), detailMats.pole, sx, 0.6, 1.35);
      }
      boxSize = [1.6, 1.0, 2.8]; boxCenter = [x, 0.6, z + 0.6];
    }
    else if (d.kind === 'grain') {
      put(new THREE.CylinderGeometry(0.90, 0.90, 0.16, 12), matStone, 0, 0.08, 0);
      put(new THREE.CylinderGeometry(0.74, 0.82, 1.45, 12), detailMats.straw, 0, 0.88, 0);
      put(new THREE.ConeGeometry(0.94, 0.55, 12), detailMats.straw, 0, 1.88, 0);
      for (const hy of [0.55, 1.25]) {
        put(new THREE.TorusGeometry(0.79, 0.022, 6, 14), detailMats.wood, 0, hy, 0, Math.PI / 2);
      }
      boxSize = [1.9, 2.3, 1.9]; boxCenter = [x, 1.15, z];
    }

    g.add(grp);
    if (boxSize) g.add(proxy(d, boxSize, boxCenter));
  }

  /* 烟囱：14 户的箱体与帽盖分别攒起来，建完后合并（见 HOUSES.forEach 之后）。
   * chimneys 记的是烟囱口世界坐标 + 该户在作息表里的编号，供炊烟取起点。 */
  const chimneyBody = [];
  const chimneyCap = [];
  const chimneys = [];

  function buildHouse(h) {
    const g = new THREE.Group();
    const y = heightAt(h.pos[0], h.pos[2]);
    g.position.set(h.pos[0], y, h.pos[2]);
    g.rotation.y = h.rot;

    const W = 9.6, D = 7.2, WH = 3.1, RH = 2.0;
    const baseY = 0.34;                       // 台基高度，所有构件抬这么高
    const wallMat = h.structure === '土木' ? matPlaster : matBrick;

    // 院内夯土地面：略高于地形，压住草，留出被踩实的土色
    {
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(h.yard.w - 0.7, h.yard.d - 0.7), matYardGround);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.055;
      floor.receiveShadow = true;
      g.add(floor);
    }

    // 石砌台基
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, baseY, D + 0.7), matStone);
    plinth.position.y = baseY / 2;
    plinth.castShadow = plinth.receiveShadow = true;
    g.add(plinth);

    // 墙裙（防潮的深色抹面）
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.9, D + 0.1), matSkirt);
    skirt.position.y = baseY + 0.45;
    skirt.castShadow = skirt.receiveShadow = true;
    g.add(skirt);

    // 墙体
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, WH, D), wallMat);
    body.position.y = baseY + WH / 2;
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // 双坡屋顶
    const roof = new THREE.Mesh(gableRoof(W + 1.1, D + 1.2, RH), matRoof);
    roof.position.y = baseY + WH;
    roof.castShadow = roof.receiveShadow = true;
    g.add(roof);

    // 前檐挑出
    const eave = new THREE.Mesh(new THREE.BoxGeometry(W + 1.3, 0.16, 0.62), matWallCap);
    eave.position.set(0, baseY + WH + 0.05, D / 2 + 0.56);
    eave.castShadow = true;
    g.add(eave);

    // 檐下椽头：一排深色方木，檐口不再是平板一条
    {
      const nR = 23;
      const rim = new THREE.InstancedMesh(new THREE.BoxGeometry(0.10, 0.15, 0.72), matTrim, nR);
      const mx = new THREE.Matrix4();
      for (let i = 0; i < nR; i++) {
        mx.makeTranslation(-W / 2 - 0.36 + (i + 0.5) * (W + 0.72) / nR,
          baseY + WH - 0.05, D / 2 + 0.30);
        rim.setMatrixAt(i, mx);
      }
      rim.instanceMatrix.needsUpdate = true;
      rim.castShadow = true;
      g.add(rim);
    }


    // 屋脊
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.22, 0.34), matDark);
    ridge.position.y = baseY + WH + RH - 0.05;
    ridge.castShadow = true;
    g.add(ridge);

    // 门：门框、门楣、门槛（比原来外凸、加粗，站在院里能看出是一套门套）
    for (const sx of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.20, 2.46, 0.26), matTrim);
      jamb.position.set(sx * 0.80, baseY + 1.23, D / 2 + 0.07);
      jamb.castShadow = true;
      g.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.24, 0.30), matTrim);
    lintel.position.set(0, baseY + 2.55, D / 2 + 0.07);
    lintel.castShadow = true;
    g.add(lintel);

    // 门洞暗背景：一层薄片贴在门板后面。原来做成 0.26m 厚的实心黑盒，
    // 把门板和压条整个包在里面，所以门看起来永远是一块黑。
    const doorHole = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.36, 0.02), matDark);
    doorHole.position.set(0, baseY + 1.18, D / 2 - 0.18);
    g.add(doorHole);

    const door = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.26, 0.08), matDoor);
    door.position.set(0, baseY + 1.14, D / 2 - 0.04);
    door.castShadow = true;
    g.add(door);

    // 门板压条：两横一竖，老木门的样子
    for (const py of [0.55, 1.75]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.10, 0.035), matTrim);
      strip.position.set(0, baseY + py, D / 2 - 0.005);
      g.add(strip);
    }
    const stripV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.12, 0.03), matTrim);
    stripV.position.set(0, baseY + 1.14, D / 2 - 0.005);
    g.add(stripV);

    const sill = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.42), matStone);
    sill.position.set(0, baseY + 0.07, D / 2 + 0.14);
    sill.receiveShadow = true;
    g.add(sill);

    // 窗：洞壁 + 玻璃 + 空心窗框 + 窗棂 + 外挑窗台
    // 关键是做出进深：贴一层面片在墙上，永远像贴纸
    for (const dx of [-3.1, 3.1]) {
      // 窗洞暗背景：同样改成薄片。原来 0.30m 厚的黑盒把玻璃和窗棂全挡住了
      const hole = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.42, 0.02), matDark);
      hole.position.set(dx, baseY + 2.0, D / 2 - 0.20);
      hole.receiveShadow = true;
      g.add(hole);

      // 玻璃往里退，窗框才能显出厚度
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 0.06), matGlass);
      win.position.set(dx, baseY + 2.0, D / 2 - 0.05);
      g.add(win);

      // 空心窗框：四条边，中间留空看到玻璃（比原来宽 3cm，暗处也能读出窗套）
      const fw = 1.76, fh = 1.56, ft = 0.13, fd = 0.15;
      const bars = [
        [fw, ft, 0, fh / 2 - ft / 2],
        [fw, ft, 0, -fh / 2 + ft / 2],
        [ft, fh, -fw / 2 + ft / 2, 0],
        [ft, fh, fw / 2 - ft / 2, 0],
      ];
      for (const [bw, bh, bx, by] of bars) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, fd), matTrim);
        b.position.set(dx + bx, baseY + 2.0 + by, D / 2 + 0.02);
        b.castShadow = true;
        g.add(b);
      }

      // 窗棂：十字，压在玻璃表面
      const barV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.34, 0.045), matTrim);
      barV.position.set(dx, baseY + 2.0, D / 2 - 0.015);
      g.add(barV);
      const barH = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.045), matTrim);
      barH.position.set(dx, baseY + 2.0, D / 2 - 0.015);
      g.add(barH);

      // 外挑窗台，底下一圈滴水线
      const sillW = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.11, 0.34), matStone);
      sillW.position.set(dx, baseY + 1.18, D / 2 + 0.10);
      sillW.castShadow = true;
      g.add(sillW);

      const drip = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.05, 0.06), matWallCap);
      drip.position.set(dx, baseY + 1.11, D / 2 + 0.25);
      g.add(drip);
    }

    // 院墙 + 墙帽
    if (h.hasWall) {
      const { w, d } = h.yard;
      const wh = 1.9, thick = 0.28;
      const segs = [
        { s: [w, wh, thick], p: [0, wh / 2, d / 2 - 1.6] },
        { s: [w, wh, thick], p: [0, wh / 2, -d / 2] },
        { s: [thick, wh, d], p: [-w / 2, wh / 2, 0] },
        { s: [thick, wh, d], p: [w / 2, wh / 2, 0] },
      ];
      for (const sg of segs) {
        const wallGeo = new THREE.BoxGeometry(...sg.s);
        // 每段墙随机 UV 相位/镜像 + 逐墙色差，配合世界坐标污渍打散重复
        const wuv = wallGeo.attributes.uv;
        const uOff = Math.random(), vOff = Math.random();
        const flip = Math.random() < 0.5 ? -1 : 1;
        const tint = 0.93 + Math.random() * 0.14;
        const warm = 0.97 + Math.random() * 0.06;
        const wcol = [];
        for (let i = 0; i < wuv.count; i++) {
          wuv.setXY(i, wuv.getX(i) * flip + uOff, wuv.getY(i) + vOff);
          wcol.push(tint * warm, tint, tint * (2 - warm));
        }
        wuv.needsUpdate = true;
        wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wcol, 3));
        const m = new THREE.Mesh(wallGeo, matMud);
        m.position.set(...sg.p);
        m.castShadow = m.receiveShadow = true;
        g.add(m);

        const cap = new THREE.Mesh(new THREE.BoxGeometry(sg.s[0] + 0.16, 0.12, sg.s[2] + 0.16), matWallCap);
        cap.position.set(sg.p[0], sg.p[1] + wh / 2 + 0.06, sg.p[2]);
        cap.castShadow = true;
        g.add(cap);

        // 墙根潮气痕：贴着地面发深，是老墙最明显的痕迹
        const stain = new THREE.Mesh(
          new THREE.BoxGeometry(sg.s[0] + 0.03, 0.40, sg.s[2] + 0.03), matSkirt);
        stain.position.set(sg.p[0], sg.p[1] - wh / 2 + 0.20, sg.p[2]);
        stain.receiveShadow = true;
        g.add(stain);
      }

      // 院门：门柱 + 小门楼
      const gz = d / 2 - 1.6, gx = -w / 2 + 2.6;
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 2.5, 0.32), matBrick);
        post.position.set(gx + sx * 1.05, 1.25, gz);
        post.castShadow = true;
        g.add(post);
      }
      const gateLintel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.24, 0.4), matTrim);
      gateLintel.position.set(gx, 2.55, gz);
      gateLintel.castShadow = true;
      g.add(gateLintel);

      const gateRoof = new THREE.Mesh(gableRoof(2.9, 1.0, 0.5), matRoof);
      gateRoof.rotation.y = Math.PI / 2;
      gateRoof.position.set(gx, 2.67, gz);
      gateRoof.castShadow = true;
      g.add(gateRoof);

      const gate = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.1, 0.14), matWood);
      gate.position.set(gx, 1.05, gz + 0.02);
      gate.castShadow = true;
      g.add(gate);
    }

    // 烟囱：几何先烘到世界坐标，等 14 户都建完后统一合并成 2 个 Mesh。
    // 逐户建 Mesh 是 14×2 = 28 个 draw call；合并后只要 2 个（v1.1 里是 11×2 = 22 个）。
    // 箱体向下多伸 0.4 m：屋面在烟囱处的标高是 4.17 m，而旧箱体底面在 4.13 m，
    // 外侧会露出不到 6 cm 的缝；向下延长把缝埋进屋面，露出屋脊以上的轮廓完全不变。
    {
      const lx = W / 2 - 1.4, lz = -D / 2 + 1.6;
      const lyBody = baseY + WH + RH * 0.72 - 0.2;
      const lyTop = baseY + WH + RH * 0.72 + 0.78;
      const M = new THREE.Matrix4().makeRotationY(h.rot).setPosition(h.pos[0], y, h.pos[2]);

      const bodyGeo = new THREE.BoxGeometry(0.55, 1.9, 0.55);
      bodyGeo.translate(lx, lyBody, lz);
      bodyGeo.applyMatrix4(M);
      chimneyBody.push(bodyGeo);

      const capGeo = new THREE.BoxGeometry(0.68, 0.1, 0.68);
      capGeo.translate(lx, lyTop, lz);
      capGeo.applyMatrix4(M);
      chimneyCap.push(capGeo);

      // 烟囱口世界坐标（帽顶再高 5 cm），供炊烟粒子取起点
      const c = Math.cos(h.rot), s = Math.sin(h.rot);
      chimneys.push({
        idx: Number(h.id.slice(2)) || 0,   // H-07 → 7，作息表拿它当哈希种子
        residents: h.residents,
        x: h.pos[0] + lx * c + lz * s,
        y: y + lyTop + 0.05,
        z: h.pos[2] - lx * s + lz * c,
      });
    }

    g.add(proxy(h, [W + 1.4, WH + RH + baseY, D + 1.4], [0, (WH + RH + baseY) / 2, 0]));
    for (const d of YARD_DETAILS) if (d.houseId === h.id) buildYardDetail(d, g);
    root.add(g);
    return g;
  }

  HOUSES.forEach(buildHouse);

  /* ---- 烟囱合并：14 户共 28 个几何 → 2 个 Mesh（matBrick + matWallCap）----
   * v1.1 是逐户两个 Mesh，11 户有烟囱就是 22 个 draw call；这里顺手降到 2 个，
   * 顺带让 3 户砖混也补上了烟囱（原先按 structure !== '砖混' 跳过）。 */
  {
    const bodyMesh = new THREE.Mesh(mergeGeometries(chimneyBody, false), matBrick);
    bodyMesh.name = 'house-chimneys';
    bodyMesh.castShadow = bodyMesh.receiveShadow = true;
    root.add(bodyMesh);
    const capMesh = new THREE.Mesh(mergeGeometries(chimneyCap, false), matWallCap);
    capMesh.name = 'house-chimney-caps';
    capMesh.castShadow = true;
    root.add(capMesh);
  }

  /* ================= 炊烟 =================
   * 14 户 × 8 粒 = 112 个烟团，合成**一个** THREE.Points —— 只占 1 个 draw call。
   * 上升、顺风漂移、湍流、膨胀、淡入淡出全在顶点着色器里按时间算；CPU 每帧只把
   * 「各户此刻的生火强度」写进预分配的 aLevel 数组，循环里不建任何对象（零逐帧 GC）。
   *
   * 时间基准 smokeTime **只在时间轴播放时累加**：暂停就定住不动（本任务的验收要求）。
   * 这一点与草摆、水波那类纯 real-time 的环境动画不同，是刻意的。
   *
   * 为什么放主场景而不是 weatherScene：雨雪用 depthTest:false 画在合成之后，因为它们
   * 永远包在相机周围、不需要被房子遮挡；炊烟在 5.7 m 高的屋脊上，被前排房子挡住时必须
   * 真的被挡住，所以留在主场景里吃深度测试和雾。
   */
  const SMOKE_PER = 10;                      // 每户烟团数
  const SMOKE_N = chimneys.length * SMOKE_PER;
  const smokeTime = { value: 0 };
  const smokeState = { lit: 0, mesh: null, uniforms: null, level: null, levelAttr: null, count: SMOKE_N };

  if (SMOKE_N > 0) {
    const origin = new Float32Array(SMOKE_N * 3);
    const seed = new Float32Array(SMOKE_N);
    const phase = new Float32Array(SMOKE_N);
    const level = new Float32Array(SMOKE_N);

    for (let i = 0; i < chimneys.length; i++) {
      const c = chimneys[i];
      for (let k = 0; k < SMOKE_PER; k++) {
        const n = i * SMOKE_PER + k;
        origin[n * 3] = c.x;
        origin[n * 3 + 1] = c.y;
        origin[n * 3 + 2] = c.z;
        seed[n] = Math.random();
        // 相位在 [0,1) 内错开，烟柱一上来就是连续的一股，不用等 6 秒才成形
        phase[n] = (k + Math.random() * 0.6) / SMOKE_PER;
      }
    }

    const originAttr = new THREE.BufferAttribute(origin, 3);
    const levelAttr = new THREE.BufferAttribute(level, 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', originAttr);   // 与 aOrigin 共用同一个缓冲：位置只作包围盒用
    geo.setAttribute('aOrigin', originAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aLevel', levelAttr);
    geo.computeBoundingSphere();

    const smokeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: smokeTime,
        uWindDir: windUniforms.uWindDir,        // 与旗、草共用同一组风场
        uWindSpeed: windUniforms.uWindSpeed,
        // 烟色偏中灰而不是纯白：岷县早晨常是 100% 云量的白天空，纯白烟对着白天空
        // 几乎看不见（实测确实看不见），中灰在亮天空和暗屋顶上都读得出来
        uColor: { value: new THREE.Color(0xc2c6c7) },
        uLight: { value: 1 },
        uSnow: { value: 0 },
        uViewH: { value: 720 },                 // 绘制缓冲高度（物理像素），用来把米换算成像素
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexShader: `
        uniform float uTime, uWindSpeed, uLight, uSnow, uViewH;
        uniform vec2 uWindDir;
        attribute vec3 aOrigin;
        attribute float aSeed;
        attribute float aPhase;
        attribute float aLevel;
        varying float vAlpha;
        varying float vShade;
        void main() {
          // 这户此刻没生火：直接推到裁剪空间外，不占像素
          if ( aLevel <= 0.001 ) {
            gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vShade = 1.0;
            return;
          }
          float life = 6.4 - uSnow * 1.2;                 // 雪天升得慢、散得快
          float age = fract( uTime / life + aPhase );      // 0..1 的一生
          vec3 p = aOrigin;
          p.y += age * ( 4.2 + uWindSpeed * 0.18 );        // 热气上升，一生约 4–6 m
          // 顺风漂移用**线性**：起先写成 age²，9 m/s 时末端被吹出 14.6 m，
          // 10 团之间拉开到 1.5 m 以上，整条烟变成一串珠子横穿半个村子。
          // 线性 + 上限后仍然"越老越远"，但烟柱是连续的。
          p.xz += uWindDir * min( age * ( 1.4 + uWindSpeed * 0.55 ), 7.0 );
          p.x += sin( age * 6.1 + aSeed * 21.0 ) * age * 0.40;            // 湍流
          p.z += cos( age * 5.3 + aSeed * 17.0 ) * age * 0.40;
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mv;
          float dep = max( 3.0, -mv.z );
          // 把世界尺寸（米）换算成设备像素：proj[1][1] = 1/tan(fov/2)，
          // 屏幕上 1 米在 dep 米处约占 proj * 画布高 * 0.5 / dep 个像素。
          // 第一版直接拿常数当系数，烟团只有 7 px，远看就是几个点。
          float sizeM = 0.55 + age * 3.0;
          gl_PointSize = clamp( sizeM * projectionMatrix[1][1] * uViewH * 0.5 / dep, 2.0, 260.0 );
          float fadeIn = smoothstep( 0.0, 0.09, age );
          float fadeOut = 1.0 - smoothstep( 0.52, 1.0, age );
          // 风越大烟被撕得越薄；雪天整层空气浑浊，烟的对比度也低
          float thin = 1.0 / ( 1.0 + uWindSpeed * 0.10 + uSnow * 0.55 );
          float distFade = 1.0 - smoothstep( 120.0, 260.0, dep );
          vAlpha = fadeIn * fadeOut * aLevel * thin * distFade * ( 0.55 + 0.45 * uLight );
          vShade = 0.55 + 0.45 * uLight;                  // 夜里烟转暗，但仍能看出是一股
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vShade;
        void main() {
          float d = length( gl_PointCoord - 0.5 );
          // 软边圆点：边缘 0.05 到 0.5 之间过渡，不会出现硬边的方片
          float a = smoothstep( 0.5, 0.05, d ) * vAlpha * 0.78;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( uColor * vShade, a );
        }`,
    });

    const points = new THREE.Points(geo, smokeMat);
    points.name = 'house-smoke';
    points.frustumCulled = false;    // 粒子随年龄漂出包围球，关掉剔除省得算
    root.add(points);

    smokeState.mesh = points;
    smokeState.uniforms = smokeMat.uniforms;
    smokeState.level = level;
    smokeState.levelAttr = levelAttr;
  }

  /* ---- 民居构件补强：门板竖纹、加密窗棂、门前三级台阶 ----
   * 每户加 10 条门/窗木条 + 3 级石阶。若按户建 Mesh 是 14×13=182 个 draw call；
   * 这里把「一套构件」合并成一个几何，再用 14 个实例矩阵复用 → 只加 2 个 draw call。 */
  {
    const DD = 7.2, baseY = 0.34;
    const woodParts = [], stoneParts = [];
    // 门板竖纹：两条深色凹槽，压在门板前
    for (const sx of [-0.27, 0.27]) {
      const g = new THREE.BoxGeometry(0.035, 2.10, 0.018);
      g.translate(sx, baseY + 1.14, DD / 2 + 0.008);
      woodParts.push(g);
    }
    // 窗棂加密：每窗 2 竖 2 横，压在玻璃前（与原有十字棂错开 2mm，避免共面）
    for (const dx of [-3.1, 3.1]) {
      for (const sx of [-0.43, 0.43]) {
        const g = new THREE.BoxGeometry(0.04, 1.34, 0.03);
        g.translate(dx + sx, baseY + 2.0, DD / 2 - 0.010);
        woodParts.push(g);
      }
      for (const sy of [-0.36, 0.36]) {
        const g = new THREE.BoxGeometry(1.5, 0.04, 0.03);
        g.translate(dx, baseY + 2.0 + sy, DD / 2 - 0.010);
        woodParts.push(g);
      }
    }
    // 门前三级台阶：从门槛石外沿开始，逐级落到院内地面
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BoxGeometry(1.9, 0.11, 0.30);
      g.translate(0, 0.11 + i * 0.09, DD / 2 + 0.50 + i * 0.30);
      stoneParts.push(g);
    }
    const mkInst = (geo, mat, name) => {
      const im = new THREE.InstancedMesh(geo, mat, HOUSES.length);
      const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      HOUSES.forEach((h, i) => {
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(h.pos[0], heightAt(h.pos[0], h.pos[2]), h.pos[2]),
          q.setFromAxisAngle(up, h.rot),
          new THREE.Vector3(1, 1, 1));
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = im.receiveShadow = true;
      im.name = name;
      root.add(im);
    };
    mkInst(mergeGeometries(woodParts, false), matTrim, 'house-joinery');
    mkInst(mergeGeometries(stoneParts, false), matStone, 'house-steps');
  }

  /* ================= 山神庙：山腰平台上的小庙 + 上山石阶 =================
   * 按材质合批：所有石构件合成一个几何、所有木构件合成一个，
   * 整座庙（含香炉、匾、40 级台阶）总共只占 6 个绘制调用。
   */
  {
    const padY = heightAt(PAD.x, PAD.z);
    const g = new THREE.Group();
    g.position.set(PAD.x, padY, PAD.z);
    root.add(g);

    const W = 5.0;   // 进深（x，东西向）
    const D = 6.0;   // 面阔（z，南北向）
    const WH = 2.9;  // 檐口高
    const baseY = 0.42;

    const bags = new Map();
    const add = (geo, mat, x, y, z, ry = 0) => {
      if (ry) geo.rotateY(ry);
      geo.translate(x, y, z);
      if (!bags.has(mat)) bags.set(mat, []);
      bags.get(mat).push(geo);
    };

    // 台基（比房子略高：山坡上要压住地面）
    add(new THREE.BoxGeometry(W + 0.9, baseY, D + 0.9), matStone, 0, baseY / 2, 0);
    // 墙体
    add(new THREE.BoxGeometry(W, WH, D), matBrick, 0, baseY + WH / 2, 0);
    // 硬山顶：屋脊沿 z（南北向），门开在西面山墙一侧
    add(gableRoof(W + 1.3, D + 1.0, 1.55), matRoof, 0, baseY + WH, 0);
    // 前后檐口压条
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.16, 0.14, D + 1.1), matWallCap, sx * (W / 2 + 0.67), baseY + WH + 0.02, 0);
    }

    // 门洞：西面正中，宽 1.5 高 2.15
    const doorW = 1.5, doorH = 2.15;
    add(new THREE.BoxGeometry(0.10, doorH, doorW), matWood, -W / 2 - 0.03, baseY + doorH / 2, 0);
    // 门框：两竖一横
    for (const sz of [-1, 1]) {
      add(new THREE.BoxGeometry(0.16, doorH + 0.18, 0.12), matTrim,
        -W / 2 - 0.05, baseY + (doorH + 0.18) / 2, sz * (doorW / 2 + 0.06));
    }
    add(new THREE.BoxGeometry(0.16, 0.14, doorW + 0.36), matTrim, -W / 2 - 0.05, baseY + doorH + 0.19, 0);

    // 小匾：门楣上方一块横匾（深色匾心 + 木框），不引入新素材
    add(new THREE.BoxGeometry(0.08, 0.44, 1.34), matWood, -W / 2 - 0.10, baseY + doorH + 0.60, 0);
    add(new THREE.BoxGeometry(0.05, 0.32, 1.14), matDark, -W / 2 - 0.14, baseY + doorH + 0.60, 0);

    // 门前香炉：石座 + 炉身 + 炉口 + 三足
    const cx = -W / 2 - 1.55;
    add(new THREE.BoxGeometry(1.0, 0.16, 1.0), matStone, cx, 0.08, 0);
    add(new THREE.CylinderGeometry(0.34, 0.42, 0.56, 12), matStone, cx, 0.44, 0);
    {
      const rim = new THREE.TorusGeometry(0.40, 0.055, 8, 16);
      rim.rotateX(-Math.PI / 2);                       // 炉口是平躺的一圈
      add(rim, matStone, cx, 0.72, 0);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      add(new THREE.CylinderGeometry(0.05, 0.06, 0.30, 6), matStone,
        cx + Math.cos(a) * 0.30, 0.22, Math.sin(a) * 0.30);
    }

    // 合批落地
    for (const [mat, geos] of bags) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      geos.forEach((gg) => { if (gg !== merged) gg.dispose(); });
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }

    /* ---------- 上山石阶：40 级，每级顶面按地形落地 ---------- */
    {
      const N = 40, x0 = 95.5, x1 = PAD.x - 2.5;
      const tread = (x1 - x0) / N;
      const stepGeos = [];
      for (let i = 0; i < N; i++) {
        const fx = x0 + i * tread;                       // 这一级的下沿
        const top = heightAt(fx, 20) + 0.06;             // 踏面高度：取地形，略抬以免陷进草里
        const h = 2.2;                                   // 石条厚度，埋进坡里，侧面看是实心台阶
        const geo = new THREE.BoxGeometry(tread + 0.10, h, 2.3);
        geo.translate(fx + tread / 2, top - h / 2, 20);
        stepGeos.push(geo);
      }
      const merged = mergeGeometries(stepGeos, false);
      stepGeos.forEach((gg) => gg.dispose());
      const stairs = new THREE.Mesh(merged, matStone);
      stairs.castShadow = stairs.receiveShadow = true;
      root.add(stairs);
    }
  }

  /* ================= 树木：干 / 枝 / 叶 三组实例化，共 3 个绘制调用 =================
   * 四种树形（杨高窄 / 柳垂枝 / 槐圆冠 / 榆疏冠）只改实例矩阵与叶簇分布，
   * 几何仍是同一份圆柱 + 叶面片，所以 draw call 恒为 3。 */
  let treeStats = null;
  const barkT = TEX.bark();
  const matBark = new THREE.MeshStandardMaterial({
    map: barkT.map, normalMap: barkT.normalMap, roughness: 0.92, metalness: 0,
    color: 0xb8a894,
    // 树冠内部几乎照不到直射光，纯 PBR 会把枝条压成黑棍；给一点暖色底光
    emissive: 0x6b5540, emissiveIntensity: 0.32,
  });
  // 树干单独一份材质：在顶点着色器里按高度平方做弯曲，越往上越偏。
  // 偏移在 instanceMatrix 之后加，是绝对米数，不会被树干半径的缩放压扁成几厘米。
  const matBarkTrunk = matBark.clone();
  matBarkTrunk.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4(transformed, 1.0);
       #ifdef USE_INSTANCING
         mvPosition = instanceMatrix * mvPosition;
       #endif
       float _bh = clamp(transformed.y, 0.0, 1.0);
       float _seed = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.4;
       mvPosition.x += pow(_bh, 2.0) * (0.35 + 0.25 * sin(_seed));
       mvPosition.z += pow(_bh, 2.0) * (0.20 * cos(_seed * 1.3));
       mvPosition = modelViewMatrix * mvPosition;
       gl_Position = projectionMatrix * mvPosition;`
    );
  };

  {
    const unitGeo = new THREE.CylinderGeometry(0.38, 1, 1, 10, 1);
    unitGeo.translate(0, 0.5, 0);

    const leafNeutral = TEX.leafCard([238, 236, 226]);
    const matLeaf = new THREE.MeshStandardMaterial({
      map: leafNeutral.map,
      // 法线贴图一直生成了却没用上，白白丢掉叶片的立体感
      normalMap: leafNeutral.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      alphaTest: 0.22,
      side: THREE.DoubleSide,
      roughness: 0.88,
      metalness: 0,
    });
    // 叶片没有 map_fragment 之外的 diffuse 修改点，用 emissive 曲线近似季节色偏
    matLeaf.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.vertexShader = 'uniform float uGreen;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // 春夏舒展变大、入冬收缩；远处按距离补偿，避免叶片小到被采样吃掉
         float _dLeaf = -(modelViewMatrix * vec4(transformed, 1.0)).z;
         float _growLeaf = 1.0 + smoothstep(30.0, 170.0, _dLeaf) * 3.2;
         transformed *= _growLeaf * (0.72 + uGreen * 0.72);`
      );
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _lum2 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summerL = vec3(0.205, 0.375, 0.132) * (0.62 + _lum2 * 1.18);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summerL, uGreen * 0.84);`
      );
      // 叶片透光：真实叶子是薄的，逆光时会透出黄绿光。
      // MeshStandardMaterial 没有次表面项，用背光方向的 emissive 近似，
      // 与几何弯曲的法线配合，近看才不像一块平板贴纸。
        shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         #if NUM_DIR_LIGHTS > 0
           vec3 _sunDirV = directionalLights[0].direction;
           // 透光量必须跟太阳强度走：太阳落山后光强为 0，
           // 否则夜里每片叶子还在自己发绿光，树冠会像灯泡一样亮着
           float _sunI = clamp(dot(directionalLights[0].color, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
           float _backLit = max(0.0, dot(-normal, _sunDirV));
           vec3 _trans = vec3(0.30, 0.46, 0.13) * (0.34 + uGreen * 0.36);
           totalEmissiveRadiance += diffuseColor.rgb * _trans * pow(_backLit, 1.4) * 1.5 * _sunI;
         #endif`
      );
    };
    // 叶片做成横向微卷、叶尖下垂的曲面，而不是一张纸片
    const leafGeo = new THREE.PlaneGeometry(1, 1, 4, 4);
    {
      const lp = leafGeo.attributes.position, luv = leafGeo.attributes.uv;
      for (let i = 0; i < lp.count; i++) {
        const u = luv.getX(i), v = luv.getY(i);
        const cup = -Math.pow((u - 0.5) * 2, 2) * 0.085;   // 沿主脉微微对折
        const droop = -Math.pow(Math.max(0, v - 0.42), 2) * 0.16; // 叶尖下垂
        const ripple = Math.sin(v * Math.PI * 2 + u * 3.0) * 0.012;
        lp.setZ(i, cup + droop + ripple);
      }
      lp.needsUpdate = true;
      leafGeo.computeVertexNormals();
    }

    const trunkM = [], branchM = [], leafM = [], leafC = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const formCount = { poplar: 0, willow: 0, locust: 0, elm: 0 };
    let willowSegs = 0;

    /** 把方向向量绕水平轴向下压 ang 弧度（正的 ang = 更垂）。
     *  柳树的垂枝就是连续两次调用它做出来的：第 1 段上扬、第 2 段平、第 3 段下垂。 */
    const droopDir = (d, ang) => {
      const h = Math.hypot(d.x, d.z) || 1e-4;
      const el = Math.atan2(d.y, h) - ang;
      const nh = Math.cos(el), ny = Math.sin(el);
      return new THREE.Vector3(d.x / h * nh, ny, d.z / h * nh);
    };

    for (let ti = 0; ti < TREES.length; ti++) {
      const t = TREES[ti];
      const formKey = FORM_OF[t.kind] || 'locust';
      const F = TREE_FORM[formKey];
      formCount[formKey]++;
      // 每棵树一个独立种子（位置毫米 + 序号）：改一棵不会连累别棵，
      // 同一份数据每次加载长出来的枝与叶完全一致。
      const seed = (Math.round(t.pos[0] * 1000) * 73856093)
        ^ (Math.round(t.pos[2] * 1000) * 19349663)
        ^ ((ti + 1) * 83492791);
      const R = treeRng(seed);
      const rr = (lo, hi) => lo + R() * (hi - lo);

      const y = heightAt(t.pos[0], t.pos[2]);
      const base = new THREE.Vector3(t.pos[0], y, t.pos[2]);
      const trunkH = t.height * F.trunk;
      const rBot = Math.max(0.11, t.dbh / 100 / 2);
      const rTop = rBot * (formKey === 'poplar' ? 0.34 : 0.44);
      const rotY = rr(0, Math.PI * 2);
      // 与 shader 同一套弯曲参数：树干在 0.88 高度处偏 0.774 倍，枝条从这里长出去
      const seedBend = t.pos[0] * 0.7 + t.pos[2] * 0.4;
      const bendX = 0.35 + 0.25 * Math.sin(seedBend);
      const bendZ = 0.20 * Math.cos(seedBend * 1.3);
      const crownBX = bendX * 0.774, crownBZ = bendZ * 0.774;

      m4.compose(base, new THREE.Quaternion().setFromAxisAngle(UP, rotY),
        new THREE.Vector3(rBot, trunkH, rBot));
      trunkM.push(m4.clone());

      const crownY = y + trunkH * 0.88;
      const branchStart = new THREE.Vector3(base.x + crownBX, crownY, base.z + crownBZ);
      const nb = formKey === 'willow' ? 5 : 3;   // 柳树多两根主枝，垂帘才成势
      const tips = [];          // 垂枝末梢，柳树用来挂叶帘

      for (let bi = 0; bi < nb; bi++) {
        const a = rotY + (bi / nb) * Math.PI * 2 + rr(-0.32, 0.32);
        const tilt = rr(F.tilt[0], F.tilt[1]);
        let dir = new THREE.Vector3(
          Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)
        ).normalize();
        const dir0 = dir.clone();
        let start = branchStart.clone();
        let segLen = t.canopy * rr(0.44, 0.60);
        // 主枝底部半径 = 树干顶部半径的 0.95 倍（原来 1.95 倍，比树干还粗，叶子一稀就露馅）
        let br = rTop * 0.95;

        for (let sg = 0; sg < F.segs; sg++) {
          q.setFromUnitVectors(UP, dir);
          m4.compose(start, q, new THREE.Vector3(br, segLen, br));
          branchM.push(m4.clone());
          if (formKey === 'willow') willowSegs++;
          start = start.clone().addScaledVector(dir, segLen * 0.9);
          // 柳树把每一段末端都记下来：第 2、3 段是真正下垂的部分，垂帘挂在这里
          if (formKey === 'willow') tips.push({ p: start.clone(), sg });
          if (sg < F.segs - 1) {
            dir = droopDir(dir, F.droop * (1.0 + sg * 0.45));
            segLen *= 0.90;
            br *= 0.70;
          }
        }

        // 二级枝：从主枝中上段再分出去，起点用第一段方向，避免垂枝把分叉点拖下去
        for (let k = 0; k < 3; k++) {
          const seg = rr(0.40, 0.68);
          const mid = branchStart.clone().addScaledVector(dir0, t.canopy * 0.5 * seg);
          const a2 = a + (k === 0 ? rr(0.6, 1.0) : rr(-1.0, -0.6));
          const tilt2 = Math.min(1.25, Math.max(0.10, tilt - rr(0.12, 0.38)));
          let dir2 = new THREE.Vector3(
            Math.sin(a2) * Math.sin(tilt2), Math.cos(tilt2), Math.cos(a2) * Math.sin(tilt2)
          ).normalize();
          if (formKey === 'willow') dir2 = droopDir(dir2, 0.30);
          const len2 = t.canopy * rr(0.22, 0.36);
          q.setFromUnitVectors(UP, dir2);
          m4.compose(mid, q, new THREE.Vector3(br * 0.48, len2, br * 0.48));
          branchM.push(m4.clone());
        }
      }

      // 叶簇：按 form 的冠椭球撒 —— 杨窄而高、槐近球、榆高而疏、柳宽而扁
      const cy = crownY + t.canopy * F.crown[1] * 0.50;
      const baseCol = new THREE.Color(t.leaf[0] / 255, t.leaf[1] / 255, t.leaf[2] / 255).multiplyScalar(1.28);
      const nClusters = Math.round(Math.min(48, Math.max(8, t.canopy * 3.6 * F.clusters)));
      const spreadK = formKey === 'willow' ? 0.145 : 0.185;

      const putCluster = (ccx, ccy, ccz, per) => {
        const spread = t.canopy * spreadK;
        for (let k = 0; k < per; k++) {
          const px = ccx + rr(-spread, spread);
          const pz = ccz + rr(-spread, spread);
          const py = ccy + rr(-spread * 0.8, spread * 0.8);
          const sc = rr(0.46, 0.86) * F.leaf;
          const asp = F.leafAspect || null;
          q.setFromEuler(new THREE.Euler(
            rr(-Math.PI, Math.PI), rr(-Math.PI, Math.PI), rr(-Math.PI, Math.PI)
          ));
          m4.compose(new THREE.Vector3(px, py, pz), q,
            asp ? new THREE.Vector3(sc * asp[0], sc * asp[1], sc * asp[2]) : new THREE.Vector3(sc, sc, sc));
          leafM.push(m4.clone());
          leafC.push(baseCol.clone().offsetHSL(
            rr(-0.02, 0.02), rr(-0.1, 0.05), rr(-0.09, 0.11)
          ));
        }
      };

      for (let ci = 0; ci < nClusters; ci++) {
        const cu = rr(0, Math.PI * 2);
        const cv = Math.acos(2 * R() - 1);
        const cr = Math.pow(R(), 0.5);
        putCluster(
          base.x + crownBX + Math.sin(cv) * Math.cos(cu) * t.canopy * F.crown[0] * cr,
          cy + Math.cos(cv) * t.canopy * F.crown[1] * cr,
          base.z + crownBZ + Math.sin(cv) * Math.sin(cu) * t.canopy * F.crown[2] * cr,
          Math.round(rr(10, 20))
        );
      }

      // 柳树的叶帘：垂枝每一段末端都往下挂 2~3 串，越靠下挂得越多 ——
      // 这是「垂柳」最好认的特征，冠顶的叶簇反而要少（clusters 只给 0.55）
      if (formKey === 'willow') {
        for (const tip of tips) {
          const per = tip.sg >= 2 ? 3 : 2;
          for (let k = 0; k < per; k++) {
            const sway = t.canopy * 0.05 * k;
            putCluster(
              tip.p.x + rr(-sway, sway),
              tip.p.y - k * t.canopy * 0.22,
              tip.p.z + rr(-sway, sway),
              Math.round(rr(7, 12))
            );
          }
        }
      }

      root.add(proxy(t,
        [t.canopy * 0.9, t.height * 0.86, t.canopy * 0.9],
        [t.pos[0], y + t.height * 0.46, t.pos[2]]));
    }

    treeStats = {
      count: TREES.length,
      forms: formCount,
      kinds: TREES.reduce((o, t) => (o[t.kind] = (o[t.kind] || 0) + 1, o), {}),
      trunk: trunkM.length,
      branch: branchM.length,
      leaf: leafM.length,
      willowSegs,
      meshes: 3,
    };

    const mkInst = (geo, mat, list, colors) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mx, i) => im.setMatrixAt(i, mx));
      if (colors) colors.forEach((c, i) => im.setColorAt(i, c));
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      root.add(im);
      return im;
    };

    mkInst(unitGeo, matBarkTrunk, trunkM);
    mkInst(unitGeo, matBark, branchM);
    mkInst(leafGeo, matLeaf, leafM, leafC);
  }

  /* ================= 家畜 =================
   * 低模动物：躯干/脖子/头/口鼻/耳/角/眼/两段腿/尾巴+毛球全部程序化拼出来，
   * 但每只只留「身体 1 Mesh + 头 1 Mesh」两个网格，17 只（牛 4 / 羊 6 / 鸡 6 / 看门狗 1）
   * 共 34 个 draw call（v1.2 微动作轮加狗，+2）。
   * 毛色用顶点色做背深腹浅；尾巴的 aTail 属性在顶点着色器里摆动，
   * 摆频 aFreq（Hz）与摆幅 aWag（无量纲，1 = 牲畜基准）也做成几何属性，
   * 看门狗用 2.6 Hz × 0.35（摇尾），牛羊 1.15 Hz × 1.0 维持原状；
   * 头是独立 Mesh，pivot 在脖子根，每帧绕 z 轴低头吃草。
   * 雨雪避檐：每只在 build 时算好 shelter 点（见 buildAnimal），update 里
   * 用气候数据（跟时间轴）驱动平滑因子 wetK，约 8 秒实时走完。 */
  const animalUniforms = { uTime: { value: 0 } };
  const matHide = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  matHide.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = animalUniforms.uTime;
    shader.vertexShader = 'attribute float aTail;\nattribute float aFreq;\nattribute float aWag;\nuniform float uTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // 尾巴：越靠末端权重越大；相位按世界位置错开，17 只不会同步摆
       float _ph = modelMatrix[3].x * 0.73 + modelMatrix[3].z * 0.51;
       float _sw = sin(uTime * aFreq + _ph) * aTail * aWag;
       transformed.z += _sw * 0.11;
       transformed.y += abs(_sw) * 0.02;`
    );
  };

  const animals = [];
  const animalGeoCache = new Map();

  function paintGeo(geo, fn) {
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      fn(p.getX(i), p.getY(i), p.getZ(i), c);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }
  /* aTail/aFreq/aWag 三个几何属性喂给 matHide 的顶点着色器（单位：Hz / 无量纲）。
   * freq/wag 不传时用牲畜基准 1.15 Hz × 1.0 —— 牛/羊/鸡的尾巴表现与 v1.1 逐位一致。 */
  function setTail(geo, rootX, tipX, freq = 1.15, wag = 1) {
    const p = geo.attributes.position;
    const n = p.count;
    const arr = new Float32Array(n);
    const span = rootX - tipX || 1;
    for (let i = 0; i < n; i++) {
      arr[i] = Math.min(1, Math.max(0, (rootX - p.getX(i)) / span));
    }
    geo.setAttribute('aTail', new THREE.BufferAttribute(arr, 1));
    geo.setAttribute('aFreq', new THREE.BufferAttribute(new Float32Array(n).fill(freq), 1));
    geo.setAttribute('aWag', new THREE.BufferAttribute(new Float32Array(n).fill(wag), 1));
    return geo;
  }
  function noTail(geo) {
    const p = geo.attributes.position;
    const n = p.count;
    geo.setAttribute('aTail', new THREE.BufferAttribute(new Float32Array(n), 1));
    geo.setAttribute('aFreq', new THREE.BufferAttribute(new Float32Array(n).fill(1.15), 1));
    geo.setAttribute('aWag', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    return geo;
  }
  const put = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    if (rx) geo.rotateX(rx);
    if (ry) geo.rotateY(ry);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    return geo;
  };

  const HIDE = {
    '牛': { dark: 0x54331f, light: 0x916741, face: 0x6b4a30, leg: 0x4d2f1c, horn: 0xcfc0a0 },
    '羊': { dark: 0xc9c2b2, light: 0xefeae0, face: 0xb3a795, leg: 0x9d9282, horn: 0x8e8272 },
    '鸡': { dark: 0x8f552c, light: 0xd59a5c, face: 0xc23b2e, leg: 0xb98a3f, horn: 0xd8a94a },
    '狗': { dark: 0x8a6238, light: 0xc9a06a, face: 0xa8825a, leg: 0x7a5a34, horn: 0x241a10 },
  };

  /** 一种动物的两套几何：身体（躯干+腿+尾）与头（脖子+头+口鼻+耳+角/冠+眼） */
  function makeAnimalGeo(kind) {
    const S = kind === '牛' ? 1 : kind === '羊' ? 0.62 : 0.22;
    const L = 1.7 * S, H = 0.78 * S, W = 0.7 * S;
    const C = HIDE[kind];
    const dark = new THREE.Color(C.dark), light = new THREE.Color(C.light);
    const faceC = new THREE.Color(C.face), legC = new THREE.Color(C.leg);
    const hornC = new THREE.Color(C.horn);
    const body = [], head = [];

    /* ---- 看门狗：卧姿，独立分支（尺寸单位 m，中华田园犬中等体型）----
     * 身长 0.72 / 卧高 0.30 / 身宽 0.26；头 pivot 在胸前上方 (0.30, 0.20)，
     * 休息时口鼻贴近前爪；尾巴向后平伸，aTail 沿尾递增，摇尾 2.6 Hz × 0.35。
     * 抬头/摇尾/呼吸全部由 update() 驱动，几何本身静止。 */
    if (kind === '狗') {
      const torso = new THREE.SphereGeometry(1, 16, 12);
      torso.scale(0.37, 0.135, 0.135);
      paintGeo(torso, (x, y, z, c) => {
        const t = Math.min(1, Math.max(0, (y / 0.135 + 1) * 0.5));
        c.copy(light).lerp(dark, t * t);
      });
      noTail(torso);
      body.push(put(torso, 0, 0.165, 0));
      // 后半身略厚
      const rump = new THREE.SphereGeometry(1, 12, 10);
      rump.scale(0.21, 0.15, 0.145);
      paintGeo(rump, (x, y, z, c) => { c.copy(dark).lerp(light, 0.25); });
      noTail(rump);
      body.push(put(rump, -0.28, 0.16, 0));
      // 前腿前伸、前爪并拢（贴地的细圆柱 + 爪尖椭球）
      for (const s of [-1, 1]) {
        const fore = new THREE.CylinderGeometry(0.032, 0.026, 0.20, 6);
        paintGeo(fore, (x, y, z, c) => { c.copy(legC); });
        noTail(fore);
        body.push(put(fore, 0.42, 0.045, s * 0.075, 0, 0, Math.PI / 2));
        const paw = new THREE.SphereGeometry(1, 8, 6);
        paw.scale(0.045, 0.028, 0.038);
        paintGeo(paw, (x, y, z, c) => { c.copy(legC).offsetHSL(0, 0, 0.04); });
        noTail(paw);
        body.push(put(paw, 0.53, 0.04, s * 0.075));
        // 后腿折叠收在体侧
        const thigh = new THREE.SphereGeometry(1, 10, 8);
        thigh.scale(0.16, 0.09, 0.075);
        paintGeo(thigh, (x, y, z, c) => { c.copy(dark).lerp(legC, 0.5); });
        noTail(thigh);
        body.push(put(thigh, -0.14, 0.10, s * 0.155));
      }
      // 尾巴：向后平伸约 0.28 m，端头毛球；摇尾频率/幅度见 setTail 参数（先 put 再 setTail，同牛羊）
      const tail = new THREE.CylinderGeometry(0.026, 0.012, 0.28, 6);
      paintGeo(tail, (x, y, z, c) => { c.copy(dark).lerp(light, 0.3); });
      put(tail, -0.56, 0.09, 0, 0, 0, Math.PI / 2);
      setTail(tail, -0.42, -0.70, 2.6, 0.35);
      body.push(tail);
      const tip = new THREE.SphereGeometry(0.03, 8, 6);
      paintGeo(tip, (x, y, z, c) => { c.copy(light); });
      put(tip, -0.70, 0.09, 0);
      setTail(tip, -0.42, -0.70, 2.6, 0.35);
      body.push(tip);

      /* 头：短颈 + 头骨 + 口鼻 + 垂耳 + 眼；休息位口鼻在 y≈0.22、贴近前爪 */
      const neck = new THREE.CylinderGeometry(0.055, 0.07, 0.16, 7);
      paintGeo(neck, (x, y, z, c) => { c.copy(faceC).lerp(dark, 0.35); });
      noTail(neck);
      head.push(put(neck, 0.36, 0.22, 0, 0, 0, Math.PI / 2 - 0.25));
      const skull = new THREE.SphereGeometry(1, 14, 10);
      skull.scale(0.10, 0.088, 0.088);
      paintGeo(skull, (x, y, z, c) => { c.copy(faceC); });
      noTail(skull);
      head.push(put(skull, 0.43, 0.255, 0));
      const muzzle = new THREE.SphereGeometry(1, 10, 8);
      muzzle.scale(0.062, 0.05, 0.052);
      paintGeo(muzzle, (x, y, z, c) => { c.copy(faceC).offsetHSL(0, 0, 0.06); });
      noTail(muzzle);
      head.push(put(muzzle, 0.52, 0.225, 0));
      const nose = new THREE.SphereGeometry(0.02, 7, 5);
      paintGeo(nose, (x, y, z, c) => { c.copy(hornC); });
      noTail(nose);
      head.push(put(nose, 0.575, 0.235, 0));
      // 垂耳：两侧压扁椭球，微微外八
      for (const s of [-1, 1]) {
        const ear = new THREE.SphereGeometry(1, 10, 8);
        ear.scale(0.028, 0.085, 0.05);
        paintGeo(ear, (x, y, z, c) => { c.copy(dark).offsetHSL(0, 0, -0.02); });
        noTail(ear);
        head.push(put(ear, 0.415, 0.24, s * 0.09, 0, 0, s * 0.85));
      }
      for (const s of [-1, 1]) {
        const eye = new THREE.SphereGeometry(0.013, 7, 5);
        paintGeo(eye, (x, y, z, c) => { c.set(0x14100c); });
        noTail(eye);
        head.push(put(eye, 0.475, 0.27, s * 0.06));
      }
      return {
        bodyGeo: mergeGeometries(body, false),
        headGeo: mergeGeometries(head, false),
        pivotX: 0.30, pivotY: 0.20,
      };
    }

    /* ---- 躯干：椭球；牛有肩峰，羊有轻微背弓 ---- */
    const torso = new THREE.SphereGeometry(1, 18, 13);
    torso.scale(L * 0.5, H * 0.55, W * 0.50);
    {
      const p = torso.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const up = Math.max(0, y / (H * 0.5));
        if (kind === '牛') {
          // 肩峰：长在前腿上方（x≈0.55），窄而缓；背线再加一点起伏
          const hump = Math.exp(-((x - 0.55) ** 2) / 0.05) * up * 0.085;
          const spine = Math.exp(-(z * z) / 0.03) * up * 0.018 * Math.sin(x * 5.5);
          p.setY(i, y + hump + spine);
        } else if (kind === '羊') {
          p.setY(i, y + Math.exp(-((x - 0.16) ** 2) / 0.08) * up * 0.05);
        }
      }
      torso.computeVertexNormals();
    }
    paintGeo(torso, (x, y, z, c) => {
      const t = Math.min(1, Math.max(0, (y / (H * 0.5) + 1) * 0.5)); // 0 腹 1 背
      c.copy(light).lerp(dark, t * t);
      const spine = Math.exp(-(z * z) / (W * W * 0.05)) * 0.08 * t;
      c.offsetHSL(0, 0, -spine);
    });
    noTail(torso);
    torso.translate(0, H * 1.14, 0);
    body.push(torso);

    /* ---- 四条腿：上段粗、下段细、中间一个关节球 ---- */
    const legH = H * 0.78;
    const rU = kind === '牛' ? 0.12 : kind === '羊' ? 0.062 : 0.020;
    for (const [lx, lz] of [[-0.55, -0.24], [-0.55, 0.24], [0.55, -0.24], [0.55, 0.24]]) {
      const x = lx * L, z = lz * W * 1.6;
      const up = new THREE.CylinderGeometry(rU, rU * 0.78, legH * 0.55, 6);
      paintGeo(up, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, py < 0 ? -0.05 : 0.02); });
      noTail(up);
      body.push(put(up, x, legH * 0.72, z));
      const lo = new THREE.CylinderGeometry(rU * 0.72, rU * 0.5, legH * 0.5, 6);
      paintGeo(lo, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, py < 0 ? -0.07 : 0); });
      noTail(lo);
      body.push(put(lo, x, legH * 0.25, z));
      const knee = new THREE.SphereGeometry(rU * 0.95, 7, 5);
      paintGeo(knee, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, -0.03); });
      noTail(knee);
      body.push(put(knee, x, legH * 0.47, z));
    }

    /* ---- 尾巴：牛/羊是细尾 + 末端毛球；鸡是尾羽丛 ---- */
    if (kind === '鸡') {
      const rootX = -L * 0.42, rootY = H * 1.35;
      for (let i = 0; i < 3; i++) {
        const f = new THREE.ConeGeometry(0.045, 0.30, 4);
        f.scale(1, 1, 0.42);
        paintGeo(f, (px, py, pz, c) => { c.set(0x33402a).offsetHSL(0, 0, (i - 1) * 0.02); });
        put(f, rootX, rootY, (i - 1) * 0.045, 0, 0, 1.15 + (i - 1) * 0.16);
        setTail(f, rootX, rootX - 0.25);
        body.push(f);
      }
      const tuft = new THREE.SphereGeometry(0.028, 7, 5);
      paintGeo(tuft, (px, py, pz, c) => { c.set(0x2b3622); });
      put(tuft, rootX - 0.24, rootY + 0.10, 0);
      setTail(tuft, rootX, rootX - 0.25);
      body.push(tuft);
    } else {
      const tailLen = (kind === '牛' ? 0.72 : 0.46) * S;
      const dx = -0.93, dy = -0.37;
      const rx = -L * 0.48, ry = H * 0.96;
      const tail = new THREE.CylinderGeometry(0.040 * S, 0.026 * S, tailLen, 5);
      paintGeo(tail, (px, py, pz, c) => { c.copy(dark).offsetHSL(0, 0, -0.04); });
      put(tail, rx + dx * tailLen * 0.5, ry + dy * tailLen * 0.5, 0, 0, 0, 1.95);
      setTail(tail, rx, rx + dx * tailLen);
      body.push(tail);
      const ball = new THREE.SphereGeometry(0.075 * S, 8, 6);
      paintGeo(ball, (px, py, pz, c) => { c.copy(dark).offsetHSL(0, 0, -0.07); });
      put(ball, rx + dx * tailLen, ry + dy * tailLen, 0);
      setTail(ball, rx, rx + dx * tailLen);
      body.push(ball);
    }

    /* ---- 头：pivot 在脖子根，低头时整段脖子跟着转 ---- */
    const pivotX = L * 0.33, pivotY = H * 1.14;
    const neckLen = kind === '牛' ? 0.55 * S : kind === '羊' ? 0.55 * S : 0.95 * S;
    const tilt = kind === '牛' ? 0.38 : kind === '羊' ? 0.72 : 0.55;   // 牛粗短平伸，羊细长上举
    const nR = kind === '牛' ? 0.21 * S : kind === '羊' ? 0.10 * S : 0.055 * S;
    const neck = new THREE.CylinderGeometry(nR * 0.82, nR, neckLen, 7);
    paintGeo(neck, (px, py, pz, c) => { c.copy(faceC).lerp(dark, 0.45); });
    noTail(neck);
    put(neck, Math.cos(tilt) * neckLen * 0.5, Math.sin(tilt) * neckLen * 0.5, 0, 0, 0, -Math.PI / 2 + tilt);
    head.push(neck);

    const headR = kind === '牛' ? 0.26 : kind === '羊' ? 0.16 : 0.08;
    const hx = Math.cos(tilt) * neckLen + headR * 0.55;
    const hy = Math.sin(tilt) * neckLen + headR * 0.15;
    const skull = new THREE.SphereGeometry(1, 14, 10);
    skull.scale(headR * 1.05, headR * 0.95, headR * 0.85);
    paintGeo(skull, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, 0.03); });
    noTail(skull);
    head.push(put(skull, hx, hy, 0));

    const muzzle = new THREE.SphereGeometry(1, 10, 8);
    muzzle.scale(headR * 0.72, headR * 0.55, headR * 0.62);
    paintGeo(muzzle, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, 0.07); });
    noTail(muzzle);
    head.push(put(muzzle, hx + headR * 0.82, hy - headR * 0.30, 0));

    for (const s of [-1, 1]) {
      if (kind === '鸡') {
        // 鸡耳只是头侧一小撮，不做外扩
        const ear = new THREE.SphereGeometry(headR * 0.22, 6, 4);
        paintGeo(ear, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, -0.05); });
        noTail(ear);
        head.push(put(ear, hx - headR * 0.25, hy + headR * 0.15, s * headR * 0.78));
        continue;
      }
      const ear = new THREE.SphereGeometry(1, 8, 6);
      ear.scale(headR * 0.55, headR * 0.22, headR * 0.32);
      paintGeo(ear, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, -0.03); });
      noTail(ear);
      // 牛耳横伸，羊耳下垂
      const earRz = kind === '羊' ? s * 1.05 : s * 0.42;
      head.push(put(ear, hx - headR * 0.02, hy + headR * 0.50, s * headR * 0.86, 0, 0, earRz));
    }

    if (kind === '牛' || kind === '羊') {
      for (const s of [-1, 1]) {
        const horn = new THREE.ConeGeometry(headR * (kind === '牛' ? 0.26 : 0.16),
          headR * (kind === '牛' ? 1.25 : 0.55), 5);
        paintGeo(horn, (px, py, pz, c) => { c.copy(hornC); });
        noTail(horn);
        if (kind === '牛') {
          head.push(put(horn, hx - headR * 0.15, hy + headR * 0.82, s * headR * 0.60, 0, 0, s * 0.95));
        } else {
          // 羊角向后弯，贴着耳后
          head.push(put(horn, hx - headR * 0.42, hy + headR * 0.42, s * headR * 0.52, 0, 0, s * 1.95));
        }
      }
    } else {
      // 鸡冠：三颗红球；肉垂一颗
      for (const [cx, cy, cr] of [[-0.30, 0.42, 0.32], [0.0, 0.52, 0.40], [0.30, 0.42, 0.30]]) {
        const comb = new THREE.SphereGeometry(headR * cr, 7, 5);
        paintGeo(comb, (px, py, pz, c) => { c.set(0xb8342a); });
        noTail(comb);
        head.push(put(comb, hx + headR * cx, hy + headR * cy, 0));
      }
      const wattle = new THREE.SphereGeometry(headR * 0.30, 7, 5);
      paintGeo(wattle, (px, py, pz, c) => { c.set(0xa82f26); });
      noTail(wattle);
      head.push(put(wattle, hx + headR * 0.72, hy - headR * 0.62, 0));
      const beak = new THREE.ConeGeometry(headR * 0.30, headR * 0.72, 4);
      paintGeo(beak, (px, py, pz, c) => { c.copy(hornC); });
      noTail(beak);
      head.push(put(beak, hx + headR * 1.08, hy - headR * 0.10, 0, 0, 0, -Math.PI / 2));
    }

    // 眼睛：两侧各一颗小黑球
    for (const s of [-1, 1]) {
      const eye = new THREE.SphereGeometry(headR * (kind === '鸡' ? 0.16 : 0.13), 7, 5);
      paintGeo(eye, (px, py, pz, c) => { c.set(0x14100c); });
      noTail(eye);
      head.push(put(eye, hx + headR * 0.42, hy + headR * 0.20, s * headR * 0.72));
    }

    return {
      bodyGeo: mergeGeometries(body, false),
      headGeo: mergeGeometries(head, false),
      pivotX, pivotY,
    };
  }

  /* 避雨点（单位 m）：雨雪时牲畜在 update() 里平滑走到这里。
   * 牛/羊 → 东头畜圈 F-03（[46, 34]）檐下沿圈散开；
   * 鸡 → 就近鸡窝（P-13 赵宅 / P-14 刘宅，坐标与 data.js 一致）旁 0.9 m；
   * 狗 → 自家（赵宅 H-05）院墙根 0.7 m，屋檐底下。 */
  const SHELTER = {
    barn: [46, 34],
    coops: [[-26.12, -35.47], [25.77, 32.69]],
    dogEave: null,   // buildAnimal 里按 HOUSES[4] 推导
  };

  function shelterFor(a, i) {
    if (a.kind === '狗') {
      const h = HOUSES[4];
      const e = [h.pos[0] + h.yard.w * 0.5 + 0.65, h.pos[2] + 5];
      return [e[0], heightAt(e[0], e[1]), e[1]];
    }
    if (a.kind === '牛' || a.kind === '羊') {
      // 沿圈散开：半径 4.5 m、按序号错开角度，避免雨中叠成一堆
      const ang = (i / 10) * Math.PI * 2 + 0.6;
      const x = SHELTER.barn[0] + Math.cos(ang) * 4.5;
      const z = SHELTER.barn[1] + Math.sin(ang) * 4.5;
      return [x, heightAt(x, z), z];
    }
    // 鸡：两处鸡窝取近的那处
    const c = (a.pos[0] * a.pos[2] + a.pos[1]) >= 0 ? SHELTER.coops[1] : SHELTER.coops[0];
    const x = c[0] + 0.9, z = c[1] + 0.35;
    return [x, heightAt(x, z), z];
  }

  function buildAnimal(a, i) {
    const g = new THREE.Group();
    const y = heightAt(a.pos[0], a.pos[2]);
    g.position.set(a.pos[0], y, a.pos[2]);
    const dog = a.kind === '狗';
    // 狗固定朝向巷道（+x 方向、微偏），不调用 between——全局随机序列零消耗
    g.rotation.y = dog ? -0.12 : between(0, Math.PI * 2);

    if (!animalGeoCache.has(a.kind)) animalGeoCache.set(a.kind, makeAnimalGeo(a.kind));
    const G = animalGeoCache.get(a.kind);

    const bodyMesh = new THREE.Mesh(G.bodyGeo, matHide);
    bodyMesh.castShadow = true;
    g.add(bodyMesh);

    const headMesh = new THREE.Mesh(G.headGeo, matHide);
    headMesh.position.set(G.pivotX, G.pivotY, 0);
    headMesh.castShadow = true;
    g.add(headMesh);

    if (dog) {
      // 狗几何按真实尺寸建（卧姿长约 1.0 m 含头尾），代理盒单位 m
      g.add(proxy(a, [0.95, 0.5, 0.75], [0.05, 0.2, 0]));
    } else {
      const scale = a.kind === '牛' ? 1 : a.kind === '羊' ? 0.62 : 0.22;
      const bodyLen = 1.7 * scale, bodyH = 0.78 * scale, bodyW = 0.7 * scale;
      g.add(proxy(a, [bodyLen * 1.5, bodyH * 2.4, bodyW * 2.4], [0, bodyH * 1.1, 0]));
    }
    root.add(g);
    // 狗 phase 写死 3.3（避开 rnd 消耗）；shelter 是雨雪避雨点 [x, y, z]，单位 m
    const sh = shelterFor(a, i);
    animals.push({
      group: g, head: headMesh, base: g.position.clone(),
      phase: dog ? 3.3 : rnd() * 10, kind: a.kind,
      shelter: new THREE.Vector3(sh[0], sh[1], sh[2]),
    });
    return g;
  }
  ANIMAL_LIST.forEach(buildAnimal);

  /* ================= 公共设施 ================= */
  // 路灯：灯罩自发光 + 有限半径点光源，夜里由 environment.js 按昼夜点亮
  const matLampGlow = new THREE.MeshStandardMaterial({
    color: 0x2b2a27, emissive: 0xffd39a, emissiveIntensity: 0, roughness: 0.42,
  });
  const matLampPole = new THREE.MeshStandardMaterial({ color: 0x8d938f, metalness: 0.65, roughness: 0.42 });
  const matSolar = new THREE.MeshStandardMaterial({ color: 0x1d2634, metalness: 0.35, roughness: 0.28 });
  const lampLights = [];
  // 旗杆落位：buildFacility 里登记，旗面统一在设施建完后合成一个 Mesh
  const flagMounts = [];

  function buildFacility(f) {
    const g = new THREE.Group();
    const y = heightAt(f.pos[0], f.pos[2]);
    g.position.set(f.pos[0], y, f.pos[2]);

    if (f.kind === 'well') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.75, 16), matStone);
      base.position.y = 0.38; base.castShadow = base.receiveShadow = true; g.add(base);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.16, 8, 20), matStone);
      rim.rotation.x = Math.PI / 2; rim.position.y = 0.78; g.add(rim);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.92, 16), new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.3 }));
      hole.rotation.x = -Math.PI / 2; hole.position.y = 0.66; g.add(hole);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.0, 0.16), matWood);
        post.position.set(s * 0.95, 1.75, 0); post.castShadow = true; g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.0, 8), matWood);
      beam.rotation.z = Math.PI / 2; beam.position.y = 2.6; g.add(beam);
      g.add(proxy(f, [2.8, 3.0, 2.8], [0, 1.4, 0]));
    }
    else if (f.kind === 'committee') {
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(13, 3.4, 8.4), matBrick);
      b1.position.y = 1.7; b1.castShadow = b1.receiveShadow = true; g.add(b1);
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(13, 3.2, 8.4), matPlaster);
      b2.position.y = 5.0; b2.castShadow = true; g.add(b2);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.34, 9.0), matRoof);
      roof.position.y = 6.78; roof.castShadow = true; g.add(roof);
      for (let i = -2; i <= 2; i++) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 0.1), matGlass);
        win.position.set(i * 2.4, 4.9, 4.24); g.add(win);
      }
      // 旗杆：8 m → 9.5 m。屋面顶在 6.95 m，原杆只高出一个头，
      // 挂上 0.96 m 高的旗布会蹭屋面；抬到 9.5 m 后旗底离屋脊还有 1.2 m。
      const POLE_H = 9.5;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, POLE_H, 8), new THREE.MeshStandardMaterial({ color: 0xcfd6da, metalness: 0.8, roughness: 0.3 }));
      pole.position.set(-4, POLE_H / 2, 7); g.add(pole);
      flagMounts.push({ kind: 'committee', x: f.pos[0] - 4, y: y + POLE_H, z: f.pos[2] + 7 });
      g.add(proxy(f, [14, 7.2, 9.4], [0, 3.6, 0]));
    }
    else if (f.kind === 'barn') {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(22, 0.2, 13), new THREE.MeshStandardMaterial({ color: 0x8c8577, roughness: 1 }));
      floor.position.y = 0.1; floor.receiveShadow = true; g.add(floor);
      const roof = new THREE.Mesh(gableRoof(13, 22, 2.6), new THREE.MeshStandardMaterial({ color: 0x6f7a80, roughness: 0.7, metalness: 0.3 }));
      roof.rotation.y = Math.PI / 2; roof.position.set(0, 3.0, 0); roof.castShadow = true; g.add(roof);
      for (const s of [-1, 1]) {
        for (let i = -3; i <= 3; i++) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.0, 6), new THREE.MeshStandardMaterial({ color: 0x8d949a, metalness: 0.6, roughness: 0.5 }));
          post.position.set(i * 3, 1.5, s * 6.2); post.castShadow = true; g.add(post);
        }
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(22, 0.12, 0.12), matWood);
      rail.position.set(0, 1.1, 6.2); g.add(rail);
      g.add(proxy(f, [23, 5.4, 14], [0, 2.7, 0]));
    }
    else if (f.kind === 'yard' || f.kind === 'plaza') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x9d998e, roughness: 0.95 });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(f.kind === 'plaza' ? 30 : 26, 0.16, f.kind === 'plaza' ? 20 : 17), mat);
      slab.position.y = 0.08; slab.receiveShadow = true; g.add(slab);
      if (f.kind === 'plaza') {
        const POLE_H = 9;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, POLE_H, 8), new THREE.MeshStandardMaterial({ color: 0xdfe4e6, metalness: 0.7, roughness: 0.35 }));
        pole.position.set(-9, POLE_H / 2, 6); pole.castShadow = true; g.add(pole);
        flagMounts.push({ kind: 'plaza', x: f.pos[0] - 9, y: y + POLE_H, z: f.pos[2] + 6 });
      } else {
        for (let i = 0; i < 5; i++) {
          const heap = new THREE.Mesh(new THREE.ConeGeometry(between(0.8, 1.4), between(0.5, 0.9), 10), new THREE.MeshStandardMaterial({ color: 0x8a7050, roughness: 1 }));
          heap.position.set(between(-9, 9), 0.3, between(-5, 5));
          heap.castShadow = true; g.add(heap);
        }
      }
      g.add(proxy(f, [f.kind === 'plaza' ? 31 : 27, 1.2, f.kind === 'plaza' ? 21 : 18], [0, 0.6, 0]));
    }
    else if (f.kind === 'mill') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.2, 5.4), matPlaster);
      body.position.y = 1.6; body.castShadow = body.receiveShadow = true; g.add(body);
      const roof = new THREE.Mesh(gableRoof(7.2, 6.2, 1.9), matRoof);
      roof.position.y = 3.2; roof.castShadow = true; g.add(roof);
      // 河在磨坊西侧：水轮挂在朝河那一面，轮面法线沿 x（正对河），
      // 轮缘下沿落在常水位附近，从河西看过去是"轮子泡在水边"。
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.16, 8, 18), matWood);
      wheel.position.set(-5.2, 1.45, 0); wheel.rotation.y = Math.PI / 2;
      wheel.castShadow = true; g.add(wheel);
      const axle = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 0.18), matWood);
      axle.name = 'mill-axle';
      axle.position.set(-4.1, 1.45, 0); axle.castShadow = true; g.add(axle);
      g.add(proxy(f, [11, 5.2, 6.4], [-1.5, 2.4, 0]));
    }
    else if (f.kind === 'streetlight') {
      const side = f.pos[0] < 0 ? 1 : -1;      // 灯臂一律伸向路中心
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.24, 0.26, 10), matStone);
      base.position.y = 0.13; base.castShadow = true; g.add(base);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, 4.6, 8), matLampPole);
      pole.position.y = 2.3; pole.castShadow = true; g.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.075, 0.075), matLampPole);
      arm.position.set(side * 0.5, 4.52, 0); arm.castShadow = true; g.add(arm);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.30), matLampGlow);
      head.position.set(side * 0.98, 4.44, 0); g.add(head);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.56), matSolar);
      panel.position.set(-side * 0.22, 4.78, 0);
      panel.rotation.z = side * 0.30; panel.castShadow = true; g.add(panel);
      const pl = new THREE.PointLight(0xffd8a4, 0, 18, 2);
      pl.position.set(side * 0.98, 4.28, 0);
      g.add(pl);
      lampLights.push(pl);
      g.add(proxy(f, [1.9, 5.0, 1.2], [side * 0.35, 2.5, 0]));
    }
    else if (f.kind === 'signboard') {
      const sign = TEX.signBoard().map;
      const matSign = new THREE.MeshStandardMaterial({ map: sign, roughness: 0.9, metalness: 0 });
      for (const sx of [-1.5, 1.5]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 2.3, 8), matLampPole);
        post.position.set(sx, 1.15, 0); post.castShadow = true; g.add(post);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.32), matStone);
        foot.position.set(sx, 0.11, 0); g.add(foot);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.6, 0.10), matLampPole);
      frame.position.set(0, 2.0, 0); frame.castShadow = true; g.add(frame);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(3.42, 1.42), matSign);
      face.position.set(0, 2.0, 0.056); g.add(face);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.09, 0.34), matWallCap);
      hood.position.set(0, 2.86, 0.02); hood.castShadow = true; g.add(hood);
      g.add(proxy(f, [4.0, 3.0, 0.8], [0, 1.5, 0]));
    }

    root.add(g);
    return g;
  }
  FACILITIES.forEach(buildFacility);

  /* ================= 旗面：两面旗合成一个 Mesh =================
   * 两根杆 v1.1 就已经立着（村委会院内 9.5 m、广场东侧 9 m），这里只补旗布。
   * 两面旗布合成一个 BufferGeometry、一个材质 —— 整套「让风看得见」只多 1 个 draw call。
   *
   * 顶点着色器做三件事：
   *   1. 按 uWindSpeed 在「静风顺杆下垂」与「大风完全展开」之间插值；
   *   2. 叠一层沿旗长推进的行波褶皱，振幅随离杆距离与风速增大；
   *   3. 整面旗绕杆转到 uWindDir 指向的方位。
   * 每面旗的杆顶世界坐标、旗面长宽、沿旗长/沿旗高的参数都烘在顶点属性里，
   * 所以不需要逐面一个 mesh，也不需要每帧在 CPU 改矩阵（改矩阵要逐面算，还得重建包围盒）。
   */
  let flagMesh = null;
  if (FLAGS.length && flagMounts.length) {
    const NX = 16, NY = 8;                 // 旗面细分 16 × 8
    const pos = [], aU = [], aV = [], aAnchor = [], aLen = [], aHgt = [], aSeed = [], tris = [];
    let vBase = 0;

    for (let fi = 0; fi < FLAGS.length; fi++) {
      const fl = FLAGS[fi];
      const mount = flagMounts.find((m) => m.kind === fl.mount);
      if (!mount) continue;
      const L = fl.cloth[0], Hh = fl.cloth[1];
      const seed = fi * 2.41;
      for (let iy = 0; iy <= NY; iy++) {
        for (let ix = 0; ix <= NX; ix++) {
          const u = ix / NX, v = iy / NY;
          // position 只用于包围盒：真实位置在着色器里按锚点重算
          pos.push(u * L, -v * Hh, 0);
          aU.push(u); aV.push(v);
          aAnchor.push(mount.x, mount.y - 0.06, mount.z);   // 旗顶离杆顶 6 cm
          aLen.push(L); aHgt.push(Hh); aSeed.push(seed);
        }
      }
      const row = NX + 1;
      for (let iy = 0; iy < NY; iy++) {
        for (let ix = 0; ix < NX; ix++) {
          const a = vBase + iy * row + ix, b = a + 1, c = a + row, d = c + 1;
          tris.push(a, c, b, b, c, d);
        }
      }
      vBase += row * (NY + 1);
    }

    if (tris.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
      g.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 1));
      g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(aAnchor, 3));
      g.setAttribute('aLen', new THREE.Float32BufferAttribute(aLen, 1));
      g.setAttribute('aHgt', new THREE.Float32BufferAttribute(aHgt, 1));
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1));
      g.setIndex(tris);
      g.computeVertexNormals();            // 仅占位，真实法线在着色器里算

      const flagMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x35558c),  // 靛蓝素布；改旗色只改这一处
        roughness: 0.88,
        metalness: 0,
        side: THREE.DoubleSide,
      });

      flagMat.onBeforeCompile = (shader) => {
        shader.uniforms.uWindDir = windUniforms.uWindDir;
        shader.uniforms.uWindSpeed = windUniforms.uWindSpeed;
        shader.uniforms.uTime = windTime;
        shader.vertexShader = `uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uTime;
attribute float aU;
attribute float aV;
attribute vec3 aAnchor;
attribute float aLen;
attribute float aHgt;
attribute float aSeed;
` + shader.vertexShader;

        // 法线：旗面基本垂直于风向，再按行波给一点偏摆，免得整面旗一个死板的明暗
        shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
float _ny = sin( uTime * ( 2.0 + uWindSpeed * 0.9 ) - aU * 7.5 + aSeed );
vec3 objectNormal = normalize( vec3( -uWindDir.y, _ny * 0.35, uWindDir.x ) );`);

        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
// 1) 展开度：静风 0 → 大风 1。
//    指数取 0.6：岷县全年风速中位数只有 1.44 m/s，线性插值的话旗子大部分时间
//    都是垂着的一条，看不出风向；0.6 次方让微风就有能读出方向的展开度。
float _fly = pow( clamp( uWindSpeed / 5.0, 0.0, 1.0 ), 0.6 );
// 整面旗绕"垂直于风向的水平轴"从平展转到下垂。直接对两个位姿做 mix 是不行的：
// 下垂位姿里沿旗长和沿旗高都落在同一根竖轴上，布面会退化成一条线（试过，旗子会消失）。
// 最大下垂角取 54°（1.30 rad 会让布几乎贴杆、侧对镜头时看不见）：比完全平展明显下沉，
// 但布面始终能读出朝向。
float _th = ( 1.0 - _fly ) * 0.95;
float _ct = cos( _th ), _st = sin( _th );
vec2 _q = vec2( aU * aLen, -aV * aHgt );
vec3 _p = vec3( _q.x * _ct + _q.y * _st, -_q.x * _st + _q.y * _ct, 0.0 );
_p.x += 0.03;                          // 让布面离开杆，不然贴死在杆上看不见
// 2) 行波褶皱：离杆越远越自由，振幅随风速增大；垂着的时候布是软的，褶皱很弱
float _amp = ( 0.018 + 0.115 * clamp( uWindSpeed / 9.0, 0.0, 1.0 ) ) * aU * ( 0.30 + 0.70 * _fly );
float _ph = uTime * ( 2.0 + uWindSpeed * 0.9 ) - aU * 7.5 + aSeed;
_p.z += sin( _ph ) * _amp;
_p.y += sin( _ph * 1.31 + 0.8 ) * _amp * 0.30;
// 3) 绕杆转到风向：局部 +x 对齐 uWindDir（世界坐标 xz）
float _yaw = atan( -uWindDir.y, uWindDir.x );
float _c = cos( _yaw ), _s = sin( _yaw );
vec3 transformed = aAnchor + vec3( _p.x * _c + _p.z * _s, _p.y, -_p.x * _s + _p.z * _c );`);
      };

      const mesh = new THREE.Mesh(g, flagMat);
      mesh.name = 'village-flags';
      // 顶点被着色器搬到杆顶，烘焙的包围盒不再有效；反正只有两面旗，直接关掉视锥剔除
      mesh.frustumCulled = false;
      // 旗布不投/不受阴影：省掉阴影通道的额外绘制，双面薄片的自阴影还会在布面留假黑边
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      root.add(mesh);
      flagMesh = mesh;

      // 可点代理：旗面会绕杆转，用一个 1.6 m 的方块罩住杆顶最省事
      for (const fl of FLAGS) {
        const mount = flagMounts.find((m) => m.kind === fl.mount);
        if (!mount) continue;
        root.add(proxy(fl, [1.6, 1.1, 1.6], [mount.x, mount.y - 0.75, mount.z]));
      }
    }
  }

  /* ================= 田块 ================= */
  const soilT = TEX.soil();
  // 每块地的生长进度标量 uniform：田面泛绿只看自己这块地的作物状态，
  // 不再跟全局季节绿（否则 10 月草还绿、收割完的田也跟着绿，看不出差别）
  const fieldGUniforms = [];
  // 旱作元素状态（供 ?qa=1 与校验读取）：田埂/地膜/篱笆的合并 Mesh 与计数
  const farmState = { ridgeMesh: null, filmMesh: null, fenceMesh: null, filmTotal: 0, fenceLength: 0 };
  const ridgeGeos = [];
  const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x6f6047, roughness: 1 });
  for (const f of FIELDS) {
    const g = new THREE.Group();
    const y = heightAt(f.pos[0], f.pos[2]);
    g.position.set(f.pos[0], y, f.pos[2]);
    g.rotation.y = f.rot;

    const geo = new THREE.PlaneGeometry(f.size[0], f.size[1], 1, 1);
    geo.rotateX(-Math.PI / 2);

    // 每块地按自身尺寸铺垄：垄距固定约 0.75 m，不随地块大小变形
    const fMap = soilT.map.clone();
    fMap.needsUpdate = true;
    fMap.repeat.set(Math.max(0.6, f.size[0] / 11), Math.max(2, f.size[1] / 3.2));
    const fNrm = soilT.normalMap.clone();
    fNrm.needsUpdate = true;
    fNrm.repeat.copy(fMap.repeat);
    fNrm.wrapS = fNrm.wrapT = THREE.RepeatWrapping;

    const fieldMat = new THREE.MeshStandardMaterial({
      map: fMap, normalMap: fNrm, normalScale: new THREE.Vector2(2.2, 2.2),
      roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -1,
    });
    // 远处一株作物只有几个像素，靠田面自身泛绿表达"这块地种着东西"
    const gUni = { value: 0 };
    fieldGUniforms.push(gUni);
    fieldMat.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.uniforms.uG = gUni;
      shader.fragmentShader = 'uniform float uGreen;\nuniform float uG;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _fl = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         // 覆盖度：出苗后起来、收割后归零；成熟后色相转黄褐
         float _cov = smoothstep(0.02, 0.16, uG) * (1.0 - smoothstep(0.98, 1.04, uG));
         float _yel2 = smoothstep(0.72, 0.98, uG);
         vec3 _cropTone = mix(vec3(0.155, 0.205, 0.088), vec3(0.245, 0.205, 0.082), _yel2)
                        * (0.72 + _fl * 1.24);
         diffuseColor.rgb = mix(diffuseColor.rgb, _cropTone, _cov * 0.58);
         // 田面整体压暗一档，否则在强光下像刷了白漆
         diffuseColor.rgb *= 0.74;`
      );
    };
    const m = new THREE.Mesh(geo, fieldMat);
    m.position.y = 0.05;
    m.receiveShadow = true;
    g.add(m);

    // 田埂：14 块 × 4 条 = 56 条边埂合并成 1 个 Mesh（改造前 56 个独立 Mesh = 56 draw call）。
    // 宽窄随地形：每边外沿中点采地形高差，下坡侧（外沿更低）加宽加高——
    // 下坡容易被雨水冲垮，农作上外埂修得比内埂壮。基础口径：宽 0.5 m、高 0.34 m。
    for (const [ax, az, px, pz] of [
      [f.size[0], 0.5, 0, f.size[1] / 2], [f.size[0], 0.5, 0, -f.size[1] / 2],
      [0.5, f.size[1], f.size[0] / 2, 0], [0.5, f.size[1], -f.size[0] / 2, 0],
    ]) {
      // 本地系边沿中点 → 世界系（rotation.y 顺时针，x' = c·px + s·pz / z' = −s·px + c·pz）
      const c = Math.cos(f.rot), s = Math.sin(f.rot);
      const wx = f.pos[0] + c * px + s * pz, wz = f.pos[2] + -s * px + c * pz;
      const drop = y - heightAt(wx, wz);           // 米，>0 = 这边是下坡
      const k = Math.min(1, Math.max(0, drop / 1.5));   // 高差 1.5 m 内线性到满
      const w = ax + 0.2 * k, d = az + 0.2 * k;    // 宽 0.5 → 0.7 m
      const h = 0.34 + 0.08 * k;                   // 高 0.34 → 0.42 m
      const rgeo = new THREE.BoxGeometry(w, h, d);
      rgeo.translate(px, h / 2, pz);               // 本地系落位（埂底贴田面）
      rgeo.rotateY(f.rot);                         // → 世界朝向
      rgeo.translate(f.pos[0], y, f.pos[2]);       // → 世界位置
      ridgeGeos.push(rgeo);
    }

    g.add(proxy(f, [f.size[0], 1.0, f.size[1]], [0, 0.5, 0]));
    root.add(g);
  }

  // 田埂合并 Mesh：56 条边埂 → 1 个 draw call；阴影与改造前一致
  const ridgeMesh = new THREE.Mesh(mergeGeometries(ridgeGeos, false), ridgeMat);
  ridgeMesh.castShadow = ridgeMesh.receiveShadow = true;
  root.add(ridgeMesh);
  farmState.ridgeMesh = ridgeMesh;

  /* ================= 村口树下：石墩、石碾、水窖 =================
   * 石头全部复用 TEX.stone() 的石材贴图（只 clone 改 repeat，不新建贴图素材）。
   * 控制 draw call：石墩 5 只合并成 1 个 Mesh；石碾石件/木架各 1；
   * 3 处水窖按石/铁/木各合并 1 个。合计 +6，预算 15。
   * 每只石墩、石碾、每处水窖各挂一个 invisible proxy，射线只打代理。 */
  {
    // 石墩与碾盘用同一套放大后的石纹：repeat 调小，砌块缝消失，读成整石凿面
    const seatMap = stoneT.map.clone();
    seatMap.needsUpdate = true;
    seatMap.wrapS = seatMap.wrapT = THREE.RepeatWrapping;
    seatMap.repeat.set(0.90, 0.75);
    const seatNrm = stoneT.normalMap.clone();
    seatNrm.needsUpdate = true;
    seatNrm.wrapS = seatNrm.wrapT = THREE.RepeatWrapping;
    seatNrm.repeat.copy(seatMap.repeat);
    const matSeatStone = new THREE.MeshStandardMaterial({
      map: seatMap, normalMap: seatNrm,
      normalScale: new THREE.Vector2(1.35, 1.35), roughness: 0.96,
    });
    const matWellStone = matSeatStone.clone();
    matWellStone.side = THREE.DoubleSide;          // 窖壁从上面看是内表面
    const matIron = new THREE.MeshStandardMaterial({
      color: 0x3b4144, metalness: 0.72, roughness: 0.44,
    });

    /** 凿痕：沿周向的低频起伏把圆柱侧面揉得不规整（顶/底中心点跳过） */
    const roughen = (geo, seed, amp) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const r = Math.hypot(x, z);
        if (r < 1e-4) continue;
        const a = Math.atan2(z, x);
        const d = (Math.sin(a * 7 + seed) * 0.62 + Math.sin(a * 17 + y * 11 + seed * 2) * 0.38) * amp;
        const f = 1 + d / Math.max(r, 0.12);
        p.setX(i, x * f); p.setZ(i, z * f);
      }
      geo.computeVertexNormals();
    };

    /* ---- 一、老杨树下的五只八棱石墩 ---- */
    // 坐面单独用“整石凿平”的材质：只有石材法线、没有砌块缝，免得顶面读成井盖；
    // 侧面仍带 stone 的石纹与凿痕。两只 Mesh 各合并一次，draw call +2。
    const seatTopNrm = stoneT.normalMap.clone();
    seatTopNrm.needsUpdate = true;
    seatTopNrm.wrapS = seatTopNrm.wrapT = THREE.RepeatWrapping;
    seatTopNrm.repeat.set(1.5, 1.5);
    const matSeatTop = new THREE.MeshStandardMaterial({
      color: 0x948d81, normalMap: seatTopNrm,
      normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.98,
    });

    const seatParts = [];
    for (let i = 0; i < STONES.length; i++) {
      const s = STONES[i];
      const yBase = heightAt(s.pos[0], s.pos[1]) - 0.010;
      const place = (g) => {
        g.rotateY(s.rotY);
        // 每只略微歪一点：倾斜量不同，底下再压 1cm 免得翘角
        g.rotateX(-0.032 + (i % 3) * 0.026);
        g.rotateZ(0.022 - (i % 2) * 0.036);
        // CylinderGeometry 以几何中心为原点，必须整体抬到「柱底 + 半个坐高」，
        // 否则一半会埋在地面以下，露出来的坐高只剩 0.2m。
        g.translate(s.pos[0], yBase + s.seatHeight / 2, s.pos[1]);
        return g;
      };
      // 侧面：开口八棱柱（不封顶，坐面单独铺）
      const side = new THREE.CylinderGeometry(s.radius * 0.94, s.radius * 1.05, s.seatHeight, 8, 3, true);
      roughen(side, i * 2.3 + 0.7, 0.010);
      seatParts.push(place(side));
      // 坐面：整石凿平的一块，比柱顶低 1.2cm（磨凹），略大于开口盖住缝
      const top = new THREE.CircleGeometry(s.radius * 0.95, 8);
      top.rotateX(-Math.PI / 2);
      top.translate(0, s.seatHeight / 2 - 0.012, 0);
      const uv = top.attributes.uv, tp = top.attributes.position;
      for (let k = 0; k < uv.count; k++) {
        uv.setXY(k, tp.getX(k) / (s.radius * 2.0) + 0.5, tp.getZ(k) / (s.radius * 2.0) + 0.5);
      }
      uv.needsUpdate = true;
      seatParts.push(place(top));
    }
    // 侧面与坐面合成一个 Mesh，统一用“整石凿面”材质；顶点色带一点石料色差，
    // 避免纯色发死。这样 5 只石墩只占 1 个 draw call。
    const seatGeo = mergeGeometries(seatParts, false);
    {
      const p = seatGeo.attributes.position, col = [];
      for (let k = 0; k < p.count; k++) {
        const n = 0.93 + 0.07 * (0.5 + 0.5 * Math.sin(
          p.getX(k) * 9.1 + p.getZ(k) * 7.3 + p.getY(k) * 11.7));
        col.push(n, n * 0.995, n * 0.97);
      }
      seatGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    matSeatTop.vertexColors = true;
    const seatMesh = new THREE.Mesh(seatGeo, matSeatTop);
    seatMesh.name = 'village-stone-seats';
    seatMesh.castShadow = seatMesh.receiveShadow = true;
    root.add(seatMesh);
    for (const s of STONES) {
      root.add(proxy(s, [s.radius * 2.6, s.seatHeight + 0.16, s.radius * 2.6],
        [s.pos[0], s.seatHeight * 0.5, s.pos[1]]));
    }

    /* ---- 二、老槐树下的石碾：碾盘 2.4m + 碾磙 + 木架 ---- */
    {
      const M = MILLSTONE;
      const base = heightAt(M.pos[0], M.pos[1]);
      const stoneParts = [], woodParts = [];

      const disc = new THREE.CylinderGeometry(1.2, 1.2, 0.18, 30, 1, false);
      roughen(disc, 1.7, 0.013);                       // 边缘磨得不圆
      disc.translate(0, 0.09, 0);
      stoneParts.push(disc);
      // 外缘磨圆的亮边（比盘面高 1cm，侧光时能看出 2~3cm 的凹槽）
      const rim = new THREE.TorusGeometry(1.185, 0.028, 6, 30);
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 0.145, 0);
      stoneParts.push(rim);
      // 中心立轴
      const post = new THREE.CylinderGeometry(0.095, 0.11, 1.05, 10);
      post.translate(0, 0.62, 0);
      stoneParts.push(post);
      // 碾磙：横躺，轴线沿 x，压在盘面 z=+0.55
      const roller = new THREE.CylinderGeometry(0.36, 0.36, 1.35, 20);
      roller.rotateZ(Math.PI / 2);
      roller.translate(0, 0.54, 0.55);
      stoneParts.push(roller);

      // 木架：立轴横担 + 两根连杆 + 推杆 + 碾磙木轴
      const beam = new THREE.BoxGeometry(1.55, 0.12, 0.12);
      beam.translate(0, 1.03, 0);
      woodParts.push(beam);
      for (const sx of [-0.56, 0.56]) {
        const link = new THREE.BoxGeometry(0.09, 0.09, 0.62);
        link.translate(sx, 0.99, 0.27);
        woodParts.push(link);
      }
      const handle = new THREE.BoxGeometry(0.075, 0.075, 1.55);
      handle.translate(0, 1.03, -0.80);
      woodParts.push(handle);
      const axle = new THREE.CylinderGeometry(0.045, 0.045, 1.72, 8);
      axle.rotateZ(Math.PI / 2);
      axle.translate(0, 0.54, 0.55);
      woodParts.push(axle);

      const ms = new THREE.Mesh(mergeGeometries(stoneParts, false), matSeatStone);
      ms.name = 'village-millstone-stone';
      ms.position.set(M.pos[0], base, M.pos[1]);
      ms.castShadow = ms.receiveShadow = true;
      root.add(ms);
      const mw = new THREE.Mesh(mergeGeometries(woodParts, false), matWood);
      mw.name = 'village-millstone-wood';
      mw.position.set(M.pos[0], base, M.pos[1]);
      mw.castShadow = mw.receiveShadow = true;
      root.add(mw);
      root.add(proxy(M, [2.7, 1.45, 2.7], [M.pos[0], base + 0.72, M.pos[1]]));
    }

    /* ---- 三、三处水窖：内凹窖口 + 铸铁盖 + 简易辘轳 ---- */
    {
      const stoneParts = [], ironParts = [], woodParts = [];
      for (const c of CISTERNS) {
        const base = heightAt(c.pos[0], c.pos[1]);
        const at = (geo) => geo.translate(c.pos[0], base, c.pos[1]);

        // 石砌窖台：一圈石环，顶面略高于地面
        const collar = new THREE.TorusGeometry(0.74, 0.12, 8, 22);
        collar.rotateX(Math.PI / 2);
        collar.translate(0, 0.10, 0);
        stoneParts.push(at(collar));
        // 内凹的窖壁（上大下小），DoubleSide 保证从上面看得到内表面
        const wall = new THREE.CylinderGeometry(0.62, 0.54, 0.95, 18, 1, true);
        wall.translate(0, -0.375, 0);
        stoneParts.push(at(wall));
        // 窖底：压到 -0.845，从口部看下去是暗的
        const bottom = new THREE.CircleGeometry(0.535, 18);
        bottom.rotateX(-Math.PI / 2);
        bottom.translate(0, -0.845, 0);
        stoneParts.push(at(bottom));

        // 铸铁盖挪到窖台南侧地上，窖口完全露出（打水时的常态）
        const lid = new THREE.CylinderGeometry(0.60, 0.60, 0.05, 20);
        lid.rotateZ(0.08);
        lid.translate(0, 0.028, 1.02);
        ironParts.push(at(lid));
        const ring = new THREE.TorusGeometry(0.10, 0.018, 6, 12);
        ring.rotateZ(0.08);
        ring.translate(0, 0.115, 1.12);
        ironParts.push(at(ring));

        // 辘轳：两根立柱 + 横轴 + 摇柄
        for (const sx of [-0.78, 0.78]) {
          const post = new THREE.BoxGeometry(0.09, 1.30, 0.09);
          post.translate(sx, 0.65, 0);
          woodParts.push(at(post));
        }
        const shaft = new THREE.CylinderGeometry(0.05, 0.05, 1.72, 8);
        shaft.rotateZ(Math.PI / 2);
        shaft.translate(0, 1.22, 0);
        woodParts.push(at(shaft));
        const crank = new THREE.BoxGeometry(0.06, 0.06, 0.42);
        crank.translate(0.86, 1.22, 0.21);
        woodParts.push(at(crank));
        const grip = new THREE.BoxGeometry(0.07, 0.26, 0.07);
        grip.translate(0.86, 1.08, 0.42);
        woodParts.push(at(grip));

        root.add(proxy(c, [1.9, 1.55, 1.9], [c.pos[0], base + 0.78, c.pos[1]]));
      }
      const cs = new THREE.Mesh(mergeGeometries(stoneParts, false), matWellStone);
      cs.name = 'village-cistern-stone';
      cs.castShadow = cs.receiveShadow = true;
      root.add(cs);
      const ci = new THREE.Mesh(mergeGeometries(ironParts, false), matIron);
      ci.name = 'village-cistern-iron';
      ci.castShadow = true;
      root.add(ci);
      const cw = new THREE.Mesh(mergeGeometries(woodParts, false), matWood);
      cw.name = 'village-cistern-wood';
      cw.castShadow = true;
      root.add(cw);
    }
  }

  /* ================= 生产性空间：院外场院六类物件 =================
   * 单位：长度 m，坐标 m（世界坐标 x 东 / z 南），角度 rad。
   * 尺寸与落位口径写在 data.js 的 PRODUCTION 注释里，这里只负责生成。
   *
   * 合批：全部按材质并成 4 个 Mesh —— ① 土（麦场面 + 粪堆 + 圈底 + 土坯窝）
   *      ② 石（边石 + 猪圈矮墙）③ 草（草垛 + 草顶）④ 木（柴垛 + 窝门 + 圈门）。
   *      每个 Mesh 用 vertexColors 区分同类里的色差，省掉额外材质槽。
   *      4 个主通道 draw call，其中只有草、木两组开 castShadow（阴影通道 +2），
   *      合计增量 ≤ 6，任务上限 8。
   * 静态：不接时间轴、不随天气变化，也不做碰撞（与既有静态场所一致）。
   */
  const prodSoil = [], prodStone = [], prodStraw = [], prodWood = [];
  const prodMeshes = [];

  /** 给几何刷顶点色：同一材质里区分土/石/草/木与各自的深浅 */
  const prodPaint = (geo, tint) => {
    const c = new THREE.Color(tint);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  };
  /** 局部坐标烘到世界坐标：先按所属物件的 rot 转，再平移到 heightAt 地形标高 */
  const prodBake = (list, geo, tint, p) => {
    prodPaint(geo, tint);
    if (p.rot) geo.rotateY(p.rot);
    geo.translate(p.pos[0], heightAt(p.pos[0], p.pos[2]), p.pos[2]);
    list.push(geo);
    return geo;
  };
  // 顶点色是「乘数」：贴图本身偏暗时 tint 再压一档就会发黑，
  // 所以这里一律取亮色，明暗差异交给贴图与光照，只留小幅色差。
  const T_SOIL = 0xffffff, T_DUNG = 0xa3835f, T_ADOBE = 0xe4cdac,
    T_STONE = 0xffffff, T_STRAW = 0xfff2cf, T_STRAW_D = 0xdcc393,
    T_WOOD = 0xf2ddbe, T_TARP = 0xb4bdbc, T_DARK = 0x5a5148;

  for (const p of PRODUCTION) {
    if (p.kind === 'floor') {
      // 压实土圆场：面厚 0.06 m，埋入 0.01 m 免得边缘翘起
      prodBake(prodSoil, new THREE.CylinderGeometry(3.60, 3.60, 0.06, 28, 1)
        .translate(0, 0.02, 0), T_SOIL, p);
      // 16 块边石：0.24 × 0.18 × 0.40 m，石心落在半径 3.45 m 上，切线方向摆放
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI / 8;
        const g = new THREE.BoxGeometry(0.24, 0.18, 0.40);
        g.rotateY(-a);
        g.translate(Math.cos(a) * 3.45, 0.09, Math.sin(a) * 3.45);
        prodBake(prodStone, g, i % 4 === 0 ? 0xe0dcd0 : T_STONE, p);
      }
    }
    else if (p.kind === 'straw') {
      // 圆台底 1.10 / 顶 0.75 m、高 1.60 m，上加 0.70 m 锥顶，通高 2.30 m
      prodBake(prodStraw, new THREE.CylinderGeometry(0.75, 1.10, 1.60, 12, 1)
        .translate(0, 0.80, 0), T_STRAW, p);
      prodBake(prodStraw, new THREE.ConeGeometry(0.95, 0.70, 12)
        .translate(0, 1.95, 0), T_STRAW, p);
      for (const hy of [0.55, 1.30]) {
        const ring = new THREE.TorusGeometry(0.88, 0.025, 5, 14);
        ring.rotateX(Math.PI / 2).translate(0, hy, 0);
        prodBake(prodStraw, ring, T_STRAW_D, p);
      }
    }
    else if (p.kind === 'wood') {
      // 5 层 × 3 根劈柴，长 2.40 / 宽 1.20 / 高 1.30 m；层间错缝
      for (let layer = 0; layer < 5; layer++) {
        for (let k = 0; k < 3; k++) {
          const g = new THREE.BoxGeometry(2.30, 0.22, 0.34);
          g.translate((layer % 2 ? 0.05 : -0.05), 0.15 + layer * 0.24, -0.40 + k * 0.40);
          prodBake(prodWood, g, layer % 2 ? 0xe0c69c : T_WOOD, p);
        }
      }
      prodBake(prodWood, new THREE.BoxGeometry(2.50, 0.04, 1.30)
        .rotateZ(0.035).translate(0, 1.34, 0), T_TARP, p);
      for (const sx of [-1.20, 1.20]) {
        prodBake(prodWood, new THREE.BoxGeometry(0.06, 1.30, 1.30)
          .translate(sx, 0.65, 0), T_WOOD, p);
      }
    }
    else if (p.kind === 'dung') {
      // 底半径 1.60 m、高 0.90 m 的缓坡堆，顶上再压一小坨
      prodBake(prodSoil, new THREE.CylinderGeometry(0.45, 1.60, 0.90, 12, 1)
        .translate(0, 0.45, 0), T_DUNG, p);
      prodBake(prodSoil, new THREE.SphereGeometry(0.38, 8, 6)
        .scale(1, 0.55, 1).translate(0.18, 0.92, -0.12), 0x8a7055, p);
    }
    else if (p.kind === 'coop') {
      // 土坯窝 1.60 × 1.20 × 1.10 m，草顶、木门、门前斜坡
      prodBake(prodSoil, new THREE.BoxGeometry(1.60, 0.85, 1.20)
        .translate(0, 0.43, 0), T_ADOBE, p);
      prodBake(prodWood, new THREE.BoxGeometry(0.55, 0.50, 0.04)
        .translate(0.12, 0.30, 0.62), T_DARK, p);
      prodBake(prodStraw, new THREE.BoxGeometry(1.82, 0.10, 1.42)
        .rotateZ(0.06).translate(0, 0.93, 0), T_STRAW_D, p);
      prodBake(prodWood, new THREE.BoxGeometry(0.52, 0.04, 0.70)
        .rotateX(-0.32).translate(0.12, 0.12, 0.96), T_WOOD, p);
      for (const sx of [-0.62, 0.62]) {
        prodBake(prodWood, new THREE.BoxGeometry(0.09, 0.14, 0.09)
          .translate(sx, 0.07, 0.48), T_DARK, p);
      }
    }
    else if (p.kind === 'sty') {
      // 3.20 × 2.60 m 围栏、栏高 0.95 m；前墙留 1.00 m 门洞
      prodBake(prodSoil, new THREE.BoxGeometry(3.20, 0.06, 2.60)
        .translate(0, 0.03, 0), T_DUNG, p);
      for (const [w, d, px, pz] of [
        [1.10, 0.20, -1.05, 1.30], [1.10, 0.20, 1.05, 1.30],
        [3.20, 0.20, 0, -1.30], [0.20, 2.60, -1.60, 0], [0.20, 2.60, 1.60, 0],
      ]) {
        prodBake(prodStone, new THREE.BoxGeometry(w, 0.95, d)
          .translate(px, 0.48, pz), T_STONE, p);
      }
      for (const sx of [-0.32, 0, 0.32]) {
        prodBake(prodWood, new THREE.BoxGeometry(0.08, 0.88, 0.10)
          .translate(sx, 0.44, 1.30), T_WOOD, p);
      }
      prodBake(prodWood, new THREE.BoxGeometry(0.90, 0.22, 0.36)
        .translate(-0.85, 0.14, -0.85), T_WOOD, p);
      // 半边草顶，给猪圈一个能认出来的轮廓
      prodBake(prodStraw, new THREE.BoxGeometry(1.70, 0.08, 2.70)
        .rotateZ(0.05).translate(-0.75, 1.06, 0), T_STRAW_D, p);
    }
  }

  // 麦场是踩实的夯土，不能沿用 TEX.soil()：那张程序化贴图带一条条垄沟，
  // 铺到圆场上会像木条拼的桶盖。改复用主路那套夯土 PBR（真实扫描照片
  // assets.road，单文件版里以 data URI 内联），只调色，不新增任何贴图文件。
  const prodEarthTex = assets?.road || TEX.road();
  const matProdEarth = new THREE.MeshStandardMaterial({
    map: prodEarthTex.map,
    normalMap: prodEarthTex.normalMap,
    roughnessMap: prodEarthTex.roughnessMap || null,
    color: 0xdac6a4, roughness: 0.98, metalness: 0,
  });
  const prodGroups = [
    [prodSoil, matProdEarth, 'production-soil', false],
    [prodStone, matStone, 'production-stone', false],
    [prodStraw, detailMats.straw, 'production-straw', true],
    [prodWood, matWood, 'production-wood', true],
  ];
  for (const [parts, base, name, shadow] of prodGroups) {
    const mat = base.clone();
    mat.vertexColors = true;                 // 同一材质内靠顶点色区分，避免多开材质槽
    mat.roughness = Math.max(mat.roughness, 0.92);
    const mesh = new THREE.Mesh(mergeGeometries(parts, false), mat);
    mesh.name = name;
    mesh.castShadow = shadow;               // 只有草垛与木构投影，阴影通道最多 +2
    mesh.receiveShadow = true;
    root.add(mesh);
    prodMeshes.push(mesh);
  }

  // 拾取代理：不可见盒不产生 draw call；16 个 P-* 全部进 pickables
  const PROD_PROXY = {
    floor: [7.30, 0.50, 7.30], straw: [2.30, 2.40, 2.30], wood: [2.50, 1.40, 1.30],
    dung: [3.30, 1.00, 3.30], coop: [1.70, 1.20, 1.30], sty: [3.30, 1.10, 2.70],
  };
  for (const p of PRODUCTION) {
    const s = PROD_PROXY[p.kind];
    root.add(proxy(p, s, [p.pos[0], s[1] / 2, p.pos[2]]));
  }

  /* 场院下不长草：在所有随机数取完之后判定，把落在场院/粪堆/圈舍范围内的
   * 草实例缩放写成 0。这样既不改撒点循环里的随机序列（全村草位不重排），
   * 也不增加 draw call；判定用占位半径 + 0.30 m 缓冲。 */
  const prodFoots = PRODUCTION.map((p) => ({ x: p.pos[0], z: p.pos[2], r: p.radius + 0.30 }));
  const prodBB = {
    x0: Math.min(...prodFoots.map((f) => f.x - f.r)) - 1,
    x1: Math.max(...prodFoots.map((f) => f.x + f.r)) + 1,
    z0: Math.min(...prodFoots.map((f) => f.z - f.r)) - 1,
    z1: Math.max(...prodFoots.map((f) => f.z + f.r)) + 1,
  };
  const inProduction = (x, z) => {
    if (x < prodBB.x0 || x > prodBB.x1 || z < prodBB.z0 || z > prodBB.z1) return false;
    for (const f of prodFoots) {
      const dx = x - f.x, dz = z - f.z;
      if (dx * dx + dz * dz < f.r * f.r) return true;
    }
    return false;
  };

  /* ================= 公共核心：村中心主路两侧 =================
   * C-01 ~ C-04 四处新建场所，另给 F-02 村委会原址补一块村务公示栏。
   * 全部沿用现有构件拼装（Box / Cylinder / Cone），不做高模、不引入新几何类型。
   *
   * 合批：构件按材质分进 4 组（墙 / 瓦 / 木 / 石），每组 mergeGeometries 成 1 个 Mesh；
   *      顶点色区分同类色差，避免多开材质槽。四种文字标识共用 textures.js 的
   *      civicSigns() 程序化图集、UV 分区后合成第 5 个 Mesh。主通道 draw call +5，
   *      只有墙/瓦/木开 castShadow（阴影通道最多 +3），合计增量 ≤ 10。
   *      不新增任何贴图文件；屋顶 clone matRoof，沿用其雪/湿 uniform（接天气、不写死日期）。
   * 静态：四处场所本身不接时间轴、不随时间变化；碰撞由 controls.js 的 OBSTACLES 负责。
   */
  const civicWall = [], civicRoof = [], civicWood = [], civicStone = [], civicSignGeos = [];
  const civicMeshes = [];
  const civicPaint = prodPaint;      // 复用生产性空间的顶点色刷函数
  const civicBake = (list, geo, tint, p, dx = 0, dy = 0, dz = 0) => {
    civicPaint(geo, tint);
    geo.translate(p.pos[0] + dx, heightAt(p.pos[0], p.pos[2]) + dy, p.pos[2] + dz);
    list.push(geo);
    return geo;
  };
  // 顶点色是乘数：贴图本身有颜色，tint 一律取亮色，只留小幅色差
  const C_ADOBE = 0xefdcc0, C_WHITE = 0xfaf7ee, C_BRICK = 0xe8c8ab,
    C_ROOF = 0xf4e6d0, C_WOOD = 0xf2ddbe, C_DARKWOOD = 0xc9ab86,
    C_STONE = 0xffffff, C_CONCRETE = 0xece8de, C_IRON = 0xd6d2c8;

  /** 图集取格：col/row 与 textures.js civicSigns() 的四格顺序一一对应 */
  const civicSign = (col, row, w, h, x, y, z, rotY = 0) => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    const u0 = col * 0.5, v0 = 1 - (row + 1) * 0.5;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5);
    uv.needsUpdate = true;
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    civicSignGeos.push(g);
  };
  /** 双坡顶：两片斜 Box 拼装，不引入 ExtrudeGeometry 以免合批属性不一致 */
  const civicGable = (p, w, d, h, y0, tint) => {
    const ang = Math.atan2(h, w / 2), len = Math.hypot(w / 2, h) + 0.30;
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(len, 0.18, d);
      g.rotateZ(-s * ang);
      civicBake(civicRoof, g, tint, p, s * w / 4, y0 + h / 2, 0);
    }
  };
  /** 台阶：dir = -1 朝西（面向主路）、+1 朝东；靠近建筑的一级最高 */
  const civicSteps = (p, n, x0, z0, w, tint, dir = -1) => {
    for (let i = 0; i < n; i++) {
      const h = 0.16 * (n - i);
      civicBake(civicStone, new THREE.BoxGeometry(0.42, h, w)
        .translate(x0 + dir * i * 0.42, h / 2, z0), tint, p);
    }
  };

  for (const c of CIVIC) {
    const [fw, fd] = c.footprint;
    const y = heightAt(c.pos[0], c.pos[2]);

    if (c.kind === 'shop') {
      /* 小卖部：砖木平房、红瓦双坡顶、朝主路的门脸与手写招牌 */
      civicBake(civicStone, new THREE.BoxGeometry(fw + 0.30, 0.30, fd + 0.30).translate(0, 0.15, 0), C_STONE, c);
      civicBake(civicWall, new THREE.BoxGeometry(fw, 2.90, fd).translate(0, 1.75, 0), C_ADOBE, c);
      civicGable(c, fw + 0.80, fd + 0.70, 1.35, 3.20, C_ROOF);
      // 门与窗开在西立面（面向主路）
      civicBake(civicWood, new THREE.BoxGeometry(0.10, 2.10, 1.45).translate(-fw / 2 - 0.06, 1.35, 0.85), C_DARKWOOD, c);
      civicBake(civicWood, new THREE.BoxGeometry(0.10, 1.25, 1.65).translate(-fw / 2 - 0.06, 1.95, -1.55), C_DARKWOOD, c);
      civicBake(civicWood, new THREE.BoxGeometry(0.12, 1.25, 0.08).translate(-fw / 2 - 0.12, 1.95, -1.55), C_WOOD, c);
      // 门楣招牌底板：西立面法线是 -X，所以厚度给 X、宽度给 Z；
      // 若写成 (3.60, 1.20, 0.10) 会变成一块侧立的薄板，从主路看正好
      // 挡在招牌中间成一条竖黑条（v1.2 首版实测截图发现的）。
      civicBake(civicWood, new THREE.BoxGeometry(0.10, 1.20, 3.60).translate(-fw / 2 - 0.09, 2.62, 0), C_DARKWOOD, c);
      civicSign(0, 0, 3.30, 1.02, c.pos[0] - fw / 2 - 0.15, y + 2.62, c.pos[2], -Math.PI / 2);
      civicSteps(c, 2, -fw / 2 - 0.30, 0.85, 1.80, C_STONE);

    } else if (c.kind === 'clinic') {
      /* 卫生室：白墙平顶、女儿墙、山墙红十字 */
      civicBake(civicStone, new THREE.BoxGeometry(fw + 0.30, 0.30, fd + 0.30).translate(0, 0.15, 0), C_STONE, c);
      civicBake(civicWall, new THREE.BoxGeometry(fw, 3.10, fd).translate(0, 1.85, 0), C_WHITE, c);
      civicBake(civicStone, new THREE.BoxGeometry(fw + 0.50, 0.22, fd + 0.50).translate(0, 3.49, 0), C_CONCRETE, c);
      for (const s of [-1, 1]) {
        civicBake(civicWall, new THREE.BoxGeometry(fw + 0.50, 0.36, 0.24).translate(0, 3.76, s * (fd / 2 + 0.16)), C_WHITE, c);
        civicBake(civicWall, new THREE.BoxGeometry(0.24, 0.36, fd + 0.50).translate(s * (fw / 2 + 0.16), 3.76, 0), C_WHITE, c);
      }
      civicBake(civicWood, new THREE.BoxGeometry(0.10, 2.20, 1.60).translate(-fw / 2 - 0.06, 1.40, 1.10), C_DARKWOOD, c);
      for (const zz of [-1.70, 0.20]) {
        civicBake(civicWood, new THREE.BoxGeometry(0.10, 1.30, 1.45).translate(-fw / 2 - 0.06, 2.05, zz), C_DARKWOOD, c);
      }
      civicSign(1, 0, 3.00, 1.50, c.pos[0] - fw / 2 - 0.15, y + 2.95, c.pos[2], -Math.PI / 2);
      civicSteps(c, 2, -fw / 2 - 0.30, 1.10, 2.00, C_STONE);

    } else if (c.kind === 'stage') {
      /* 戏台：高台基、四柱、青瓦顶、后台墙、台口匾额；台口朝东对着主路 */
      civicBake(civicStone, new THREE.BoxGeometry(fw + 0.30, 0.90, fd + 0.30).translate(0, 0.45, 0), C_STONE, c);
      civicBake(civicStone, new THREE.BoxGeometry(fw, 0.12, fd).translate(0, 0.96, 0), C_CONCRETE, c);
      civicBake(civicWall, new THREE.BoxGeometry(0.35, 2.60, fd).translate(-fw / 2 + 0.18, 2.32, 0), C_BRICK, c);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        civicBake(civicWood, new THREE.CylinderGeometry(0.15, 0.18, 3.00, 8)
          .translate(sx * (fw / 2 - 0.55), 2.52, sz * (fd / 2 - 0.55)), C_WOOD, c);
      }
      for (const sz of [-1, 1]) {
        civicBake(civicWood, new THREE.BoxGeometry(fw + 0.30, 0.22, 0.22)
          .translate(0, 3.94, sz * (fd / 2 - 0.55)), C_DARKWOOD, c);
      }
      civicGable(c, fw + 0.90, fd + 0.80, 1.70, 4.05, C_ROOF);
      civicSign(1, 1, 2.80, 1.00, c.pos[0] + fw / 2 + 0.16, y + 3.50, c.pos[2], Math.PI / 2);
      civicSteps(c, 3, fw / 2 + 0.30, 0, 2.40, C_STONE, 1);

    } else if (c.kind === 'culture') {
      /* 文化广场：水泥场坪 + 青石收边 + 两组石桌凳 + 三根宣传柱（让主路上也看得见） */
      civicBake(civicStone, new THREE.BoxGeometry(fw, 0.16, fd).translate(0, 0.08, 0), C_CONCRETE, c);
      for (const s of [-1, 1]) {
        civicBake(civicStone, new THREE.BoxGeometry(fw + 0.30, 0.22, 0.30).translate(0, 0.12, s * (fd / 2 + 0.15)), C_STONE, c);
        civicBake(civicStone, new THREE.BoxGeometry(0.30, 0.22, fd + 0.30).translate(s * (fw / 2 + 0.15), 0.12, 0), C_STONE, c);
      }
      for (const cx of [-2.30, 2.30]) {
        civicBake(civicStone, new THREE.CylinderGeometry(0.78, 0.78, 0.12, 12).translate(cx, 0.79, 0), C_STONE, c);
        civicBake(civicStone, new THREE.CylinderGeometry(0.14, 0.18, 0.70, 8).translate(cx, 0.43, 0), C_STONE, c);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          civicBake(civicStone, new THREE.CylinderGeometry(0.28, 0.30, 0.42, 8)
            .translate(cx + sx * 1.35, 0.37, sz * 1.35), C_STONE, c);
        }
      }
      // 三根 3.4 m 宣传柱：广场本身是平的，靠这组竖向构件在第一人称里可辨认
      for (let i = -1; i <= 1; i++) {
        civicBake(civicWood, new THREE.BoxGeometry(0.22, 3.40, 0.22).translate(0, 1.86, i * 2.60 + fd / 2 - 0.60), C_WOOD, c);
        // 板面朝东对着主路：厚度给 X、宽度给 Z，别让主路上只看到一条边
        civicBake(civicWood, new THREE.BoxGeometry(0.10, 0.70, 1.70).translate(0, 3.35, i * 2.60 + fd / 2 - 0.60), C_DARKWOOD, c);
      }
    }
  }

  /* F-02 村委会原址升级：门前补一块村务公示栏（附属构件，不单独占可点对象）。
   * 位置由 FACILITIES 的 F-02 推出，避免把村委会坐标在两处各写一遍。 */
  const committee = FACILITIES.find((f) => f.id === 'F-02');
  if (committee) {
    const bx = committee.pos[0] + 3.20, bz = committee.pos[2] + 5.60;
    const cy = heightAt(committee.pos[0], committee.pos[2]);
    const anchor = { pos: [bx, 0, bz] };
    for (const s of [-1, 1]) {
      civicBake(civicWood, new THREE.CylinderGeometry(0.07, 0.09, 2.60, 8), C_IRON, anchor, 0, 1.30, s * 1.65);
      civicBake(civicStone, new THREE.BoxGeometry(0.32, 0.22, 0.32), C_STONE, anchor, 0, 0.11, s * 1.65);
    }
    civicBake(civicWood, new THREE.BoxGeometry(0.12, 1.70, 3.60).translate(0, 2.05, 0), C_DARKWOOD, anchor);
    civicBake(civicStone, new THREE.BoxGeometry(0.50, 0.10, 3.90).translate(0, 2.94, 0), C_STONE, anchor);
    civicSign(0, 1, 3.40, 1.50, bx - 0.08, cy + 2.05, bz, -Math.PI / 2);
  }

  const civicRawWall = new THREE.MeshStandardMaterial({
    map: matPlaster.map, normalMap: matPlaster.normalMap,
    normalScale: (matPlaster.normalScale || new THREE.Vector2(1, 1)).clone(),
    roughness: 0.95, vertexColors: true,
  });
  /* three r160 的 Material.clone() 不复制 onBeforeCompile（vendor/three.module.js
   * 的 copy() 属性表里没有它），所以克隆后必须手动挂回去，否则戏台/小卖部的
   * 坡屋顶会丢掉 matRoof 的雪/湿 uniform，下雪天与全村其他屋顶不一致。 */
  const civicRoofMat = matRoof.clone();
  civicRoofMat.onBeforeCompile = matRoof.onBeforeCompile;
  civicRoofMat.customProgramCacheKey = matRoof.customProgramCacheKey;
  const civicGroups = [
    [civicWall, civicRawWall, 'civic-wall', true],
    [civicRoof, civicRoofMat, 'civic-roof', true],
    [civicWood, matWood.clone(), 'civic-wood', true],
    [civicStone, matStone.clone(), 'civic-stone', false],
  ];
  for (const [parts, base, name, shadow] of civicGroups) {
    base.vertexColors = true;
    base.roughness = Math.max(base.roughness, 0.90);
    const mesh = new THREE.Mesh(mergeGeometries(parts, false), base);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    root.add(mesh);
    civicMeshes.push(mesh);
  }
  // 四种标识共用一张图集、一次绘制
  const signMat = new THREE.MeshStandardMaterial({
    map: TEX.civicSigns().map, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
  });
  const signMesh = new THREE.Mesh(mergeGeometries(civicSignGeos, false), signMat);
  signMesh.name = 'civic-signs';
  signMesh.receiveShadow = true;
  root.add(signMesh);
  civicMeshes.push(signMesh);

  // 拾取代理：不可见盒不产生 draw call；4 个 C-* 全部进 pickables
  const CIVIC_PROXY = {
    shop: [7.30, 4.60, 5.30], clinic: [8.30, 3.90, 6.30],
    stage: [9.30, 5.80, 6.80], culture: [10.30, 3.60, 8.30],
  };
  for (const c of CIVIC) {
    const s = CIVIC_PROXY[c.kind];
    root.add(proxy(c, s, [c.pos[0], s[1] / 2, c.pos[2]]));
  }

  /* 建筑底下不长草：与场院共用同一套「取完随机数再缩放写 0」的做法，
   * 绝不在撒点循环里插 continue（会让全村草位重排）。 */
  const civicFoots = CIVIC.map((c) => ({ x: c.pos[0], z: c.pos[2], r: c.radius + 0.30 }));
  const civicBB = {
    x0: Math.min(...civicFoots.map((f) => f.x - f.r)) - 1,
    x1: Math.max(...civicFoots.map((f) => f.x + f.r)) + 1,
    z0: Math.min(...civicFoots.map((f) => f.z - f.r)) - 1,
    z1: Math.max(...civicFoots.map((f) => f.z + f.r)) + 1,
  };
  const inCivic = (x, z) => {
    if (x < civicBB.x0 || x > civicBB.x1 || z < civicBB.z0 || z > civicBB.z1) return false;
    for (const f of civicFoots) {
      const dx = x - f.x, dz = z - f.z;
      if (dx * dx + dz * dz < f.r * f.r) return true;
    }
    return false;
  };

  /** 点是否落在某块耕地里（含 0.6 m 田埂余量）。
   *  耕地上不能长草：10 月收割后草还绿着，会把「留茬露土」整片盖掉，
   *  看上去就像作物从来没长过。判定与作物生成用同一套旋转变换。 */
  const inField = (x, z) => {
    for (const f of FIELDS) {
      const hw = f.size[0] / 2 + 0.6, hd = f.size[1] / 2 + 0.6;
      const dx = x - f.pos[0], dz = z - f.pos[2];
      if (Math.abs(dx) > hw + hd || Math.abs(dz) > hw + hd) continue;   // 粗筛，省掉大部分点
      const c = Math.cos(f.rot), s = Math.sin(f.rot);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) return true;
    }
    return false;
  };

  /** 点是否落在路面或路肩上（含 0.10 m 余量）。
   *  草层撒点时把落在路上的实例缩放写 0 —— 否则草会直接穿透路面，
   *  水泥主路上立着一根根草比土路时刺眼得多。判定放在所有随机取数之后，
   *  不插 continue，15 万株草的随机序列与实例数都不变。
   *  先用包围盒粗筛，只有几千株草需要做精确的点到折线距离计算。 */
  const inRoad = (x, z) => {
    const PAD = 0.10;
    // 主路 + 两侧路肩
    const zA = ROAD.points[0][1], zB = ROAD.points[ROAD.points.length - 1][1];
    if (x > -8 && x < 10 && z > zA - 2 && z < zB + 2) {
      const lim = ROAD.width / 2 + ROAD.shoulder + PAD;
      for (let i = 1; i < roadSpine.length; i++) {
        const a = roadSpine[i - 1], b = roadSpine[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) < lim) return true;
      }
    }
    // 巷道（含 0.18 m 倒角）
    for (const L of LANES) {
      const x0 = Math.min(L.a[0], L.b[0]) - 4, x1 = Math.max(L.a[0], L.b[0]) + 4;
      const z0 = Math.min(L.a[1], L.b[1]) - 4, z1 = Math.max(L.a[1], L.b[1]) + 4;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const dx = L.b[0] - L.a[0], dz = L.b[1] - L.a[1];
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - L.a[0]) * dx + (z - L.a[1]) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - (L.a[0] + dx * t), z - (L.a[1] + dz * t)) < L.w / 2 + 0.18 + PAD) return true;
    }
    // 田埂不清草：它的两侧本来就设计成「没进草里」
    return false;
  };

  /* ================= 田里作物：五状态 × 四形态族 =================
   * 改造要点（v1.2 第 4 轮）：
   *
   * 1) 五状态不再靠一个 uGreen 连续缩放，而是每块地按**有效积温**算一个生长进度 g：
   *      g = clamp((积温 − 播种日积温) / gddNeed, 0, 1.10)
   *    g 的五个区间就是五个状态，但所有形态参数（株高/密度/色相/留茬）都是 g 的
   *    连续函数，所以拖时间轴不会某天突然整片换模型。
   *
   * 2) 形态按「族」分组，不再让 8 种作物共用一张交叉面片：
   *      tall   玉米：两段交叉面片，上部更宽，读成高秆层叠叶
   *      dense  小麦 / 党参 / 柴胡：窄面片，密植
   *      low    马铃薯 / 蔬菜 / 黄芪：宽面片，低矮铺地
   *      umbel  当归：叶丛 + 单独一层的花葶与伞形花序（抽薹才出现）
   *    4 族 + 当归花序 = 5 个 InstancedMesh，draw call 从 1 增到 5（+4，上限 ≤6）。
   *
   * 3) 每帧只更新 14 个 float（地块数）到 uniform 数组 uFieldG，
   *    实例各自带 aFieldIdx 在顶点着色器里取自己的 g —— 不遍历几万个实例。
   *
   * 单位口径：gddNeed ℃·d；sow 日序（1 = 1 月 1 日）；h / gap / row 米。
   */
  let cropMeshes = [];
  let cropCount = 0;
  const cropUniforms = { uFieldG: { value: new Float32Array(FIELDS.length) } };
  // 每块地的运行时物候状态（供档案卡与 ?qa=1 读）
  const fieldState = FIELDS.map((f) => ({ id: f.id, crop: f.crop, g: 0, stage: '休耕', gddEff: 0, gddNeed: 0 }));

  const CROP_SPEC = {
    当归: { family: 'umbel', gddNeed: 1730, sow: 105, h: 0.52, gap: 0.40, row: 0.58, col: [0.30, 0.44, 0.19] },
    玉米: { family: 'tall', gddNeed: 1500, sow: 105, h: 1.60, gap: 0.82, row: 0.66, col: [0.34, 0.46, 0.16] },
    小麦: { family: 'dense', gddNeed: 760, sow: 74, h: 0.72, gap: 0.48, row: 0.54, col: [0.46, 0.50, 0.22] },
    党参: { family: 'dense', gddNeed: 1760, sow: 100, h: 0.42, gap: 0.52, row: 0.80, col: [0.36, 0.47, 0.21] },
    黄芪: { family: 'low', gddNeed: 1740, sow: 100, h: 0.40, gap: 0.50, row: 0.78, col: [0.33, 0.41, 0.22] },
    柴胡: { family: 'dense', gddNeed: 1700, sow: 100, h: 0.42, gap: 0.42, row: 0.76, col: [0.31, 0.40, 0.19] },
    马铃薯: { family: 'low', gddNeed: 1400, sow: 105, h: 0.55, gap: 0.44, row: 0.86, col: [0.23, 0.37, 0.16] },
    蔬菜: { family: 'low', gddNeed: 1780, sow: 95, h: 0.34, gap: 0.48, row: 0.70, col: [0.26, 0.46, 0.19] },
  };

  /** g → 五状态名。区间与着色器里的形态曲线一一对应，改一处必须同步另一处 */
  const stageOf = (g) => (g <= 0.001 ? '休耕' : g < 0.12 ? '出苗' : g < 0.72 ? '生长' : g < 1.0 ? '成熟' : '收割后（留茬）');

  if (!new URLSearchParams(location.search).has('nocrop')) {
    /* ---------- 地膜：西北旱作的高辨识度元素（v1.2 旱作轮）----------
     * 白膜：玉米（全膜双垄沟播）、蔬菜菜园；黑膜：当归 / 党参 / 柴胡 / 黄芪 / 马铃薯
     * （岷县药材黑膜压草是当地标准做法）；小麦条播不覆膜。
     * 出现节奏由各块地的 g 驱动（uFieldG，作物轮每帧已写，跟时间轴不写死日期）：
     *   播种后出现（g 0.001→0.02 淡入），出苗后揭膜（g 0.10→0.20 淡出），
     *   休耕（g=0）与收割后（g≥1）没有。
     * 防 z-fighting 双保险：条带在田面上方 0.012 m（1.2 cm）+ polygonOffset −2，
     * 与田面材质同一套做法。
     * 条带口径（单位 m）：带宽 1.10、带间隔 0.35（膜间露 0.35 m 苗带）、长 = 田长 − 1.2；
     * 全部条带合成 1 个 InstancedMesh ≈ 200 条 × 2 三角形 = 1 draw call。 */
    {
      const filmFields = FIELDS.filter((f) => f.crop !== '小麦');
      const strips = [];
      for (const f of filmFields) {
        const pitch = 1.45;                        // 带宽 1.10 + 露 0.35
        const n = Math.max(1, Math.floor((f.size[1] - 1.2) / pitch));
        for (let i = 0; i < n; i++) strips.push({ f, z: (i - (n - 1) / 2) * pitch });
      }
      const filmGeo = new THREE.PlaneGeometry(1, 1);
      filmGeo.rotateX(-Math.PI / 2);
      const fIdx = new Float32Array(strips.length);
      for (let i = 0; i < strips.length; i++) fIdx[i] = filmFields.indexOf(strips[i].f);
      filmGeo.setAttribute('aFieldIdx', new THREE.BufferAttribute(fIdx, 1));
      const filmMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.55,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
      });
      filmMat.onBeforeCompile = (shader) => {
        shader.uniforms.uFieldG = cropUniforms.uFieldG;   // 与作物实例共用同一数组（每帧 14 个 float）
        shader.vertexShader = `attribute float aFieldIdx;\nuniform float uFieldG[${FIELDS.length}];\n` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float _fg = uFieldG[int(aFieldIdx + 0.5)];
           // 覆盖度：播种即铺、出苗揭膜；0 = 完全收起（条带退化成一点，不参与光栅化）
           float _film = smoothstep(0.001, 0.02, _fg) * (1.0 - smoothstep(0.10, 0.20, _fg));
           transformed.x *= _film;
           transformed.z *= _film;`
        );
      };
      const filmMesh = new THREE.InstancedMesh(filmGeo, filmMat, strips.length);
      const mtx = new THREE.Matrix4();
      const colWhite = new THREE.Color(0xe9e7e0), colBlack = new THREE.Color(0x27272a);
      strips.forEach((s, i) => {
        const f = s.f;
        const cy = heightAt(f.pos[0], f.pos[2]);
        const c = Math.cos(f.rot), sn = Math.sin(f.rot);
        // 本地系条带（长沿 x、宽沿 z、横向偏 s.z）→ 世界系
        mtx.makeRotationY(f.rot);
        mtx.scale(new THREE.Vector3(f.size[0] - 1.2, 1, 1.10));
        mtx.setPosition(f.pos[0] + sn * s.z, cy + 0.062, f.pos[2] + c * s.z);
        filmMesh.setMatrixAt(i, mtx);
        filmMesh.setColorAt(i, (f.crop === '玉米' || f.crop === '蔬菜') ? colWhite : colBlack);
      });
      filmMesh.receiveShadow = true;
      filmMesh.frustumCulled = false;              // 条带散布 14 块地，整体一个包围球不划算
      root.add(filmMesh);
      farmState.filmMesh = filmMesh;
      farmState.filmTotal = strips.length;
      farmState.filmWhite = strips.filter((s) => s.f.crop === '玉米' || s.f.crop === '蔬菜').length;
    }

    const plantT = TEX.cropPlant();
    const umbelT = TEX.cropUmbel();

    /* ---------- 形态族几何（全部按 1.0 高建模，实例矩阵给真实株高） ---------- */
    const geoOf = (family) => {
      const parts = [];
      if (family === 'tall') {
        // 玉米：下段窄、上段宽，两段交叉 → 高秆 + 层叠叶的剪影
        const a = new THREE.PlaneGeometry(0.62, 0.80); a.translate(0, 0.40, 0);
        const b = a.clone(); b.rotateY(Math.PI / 2);
        const c = new THREE.PlaneGeometry(1.02, 0.58); c.translate(0, 0.71, 0);
        const d = c.clone(); d.rotateY(Math.PI / 2);
        parts.push(a, b, c, d);
      } else if (family === 'dense') {
        const a = new THREE.PlaneGeometry(0.30, 1.0); a.translate(0, 0.5, 0);
        const b = a.clone(); b.rotateY(Math.PI / 2);
        parts.push(a, b);
      } else if (family === 'low') {
        const a = new THREE.PlaneGeometry(0.95, 1.0); a.translate(0, 0.5, 0);
        const b = a.clone(); b.rotateY(Math.PI / 2);
        parts.push(a, b);
      } else {
        // 当归叶丛：一个水平叶盘 + 两片竖直叶。
        // 只用竖直薄片的话，平视看是一条线、俯瞰看是一条缝，田里几乎读不出作物；
        // 加一层贴地叶盘后，斜俯视能看成"散开的叶丛"，正好是当归的样子。
        const flat = new THREE.PlaneGeometry(1.15, 1.15);
        flat.rotateX(-Math.PI / 2);
        flat.translate(0, 0.12, 0);
        const up = new THREE.PlaneGeometry(0.78, 0.58); up.translate(0, 0.29, 0);
        const up2 = up.clone(); up2.rotateY(Math.PI / 2);
        parts.push(flat, up, up2);
      }
      return mergeGeometries(parts);
    };
    // 当归花葶 + 伞形花序：细杆两片 + 顶部两片花序，总高 1.0
    const umbelHeadGeo = mergeGeometries([
      new THREE.PlaneGeometry(0.10, 0.62).translate(0, 0.31, 0),
      new THREE.PlaneGeometry(0.10, 0.62).translate(0, 0.31, 0).rotateY(Math.PI / 2),
      new THREE.PlaneGeometry(0.72, 0.52).translate(0, 0.80, 0),
      new THREE.PlaneGeometry(0.72, 0.52).translate(0, 0.80, 0).rotateY(Math.PI / 2),
    ]);

    /* ---------- 作物材质：叶 / 花两套，逻辑相同 ---------- */
    const makeCropMat = (mapTex, isHead) => {
      const mat = new THREE.MeshStandardMaterial({
        map: mapTex.map,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        roughness: 0.92,
        metalness: 0,
      });
      // 花序专属的一段形态覆盖（用数组拼字符串，避免在模板里再嵌一层反引号）
      const headCode = isHead ? [
        '         // 花序只在抽薹后出现，收割后随留茬一起消失',
        '         float _on = smoothstep(0.44, 0.62, _g) * (1.0 - smoothstep(0.98, 1.06, _g));',
        '         _h = _on;',
        '         _den = _on;',
      ].join('\n') : '';
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uFieldG = cropUniforms.uFieldG;
        shader.uniforms.uGreen = seasonUniform;
        shader.vertexShader = `attribute float aFieldIdx;
attribute float aRand;
uniform float uFieldG[${FIELDS.length}];
uniform float uGreen;
varying float vYel;
` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
         // 本实例所属地块的生长进度（0 = 休耕，1.10 = 留茬末期）
         float _g = uFieldG[int(aFieldIdx + 0.5)];
         float _h, _den, _yel;
         if (_g < 0.12) {
           float t = clamp(_g / 0.12, 0.0, 1.0);
           _h = mix(0.06, 0.18, t); _den = mix(0.35, 0.75, t); _yel = 1.0;
         } else if (_g < 0.72) {
           float t = (_g - 0.12) / 0.60;
           _h = mix(0.18, 0.92, t); _den = mix(0.75, 1.0, t); _yel = 1.0 - t;
         } else if (_g < 1.0) {
           // 成熟期：株高到顶、密度开始回落、颜色转黄褐（t 到 1 时黄 0.90，远看能读成"该收了"）
           float t = (_g - 0.72) / 0.28;
           _h = mix(0.92, 1.0, t); _den = mix(1.0, 0.72, t); _yel = t * 0.90;
         } else {
           // 收割后：只留 5% 株高的残茬，密度降到 0.10，让田面裸土重新露出来
           float t = clamp((_g - 1.0) / 0.10, 0.0, 1.0);
           _h = mix(1.0, 0.05, t); _den = mix(0.72, 0.10, t); _yel = 1.0;
         }
         // 休耕必须彻底消失，否则 den 的残值会让少数实例留成一条细线
         _den *= smoothstep(0.0, 0.02, _g);
${headCode}
         // 密度：逐实例固定阈值 + 平滑过渡，出苗与收割时按顺序长出来 / 消失，不会整片闪
         float _vis = smoothstep(aRand - 0.08, aRand + 0.08, _den);
         float _dc = -(modelViewMatrix * vec4(transformed, 1.0)).z;
         float _zoom = 1.0 + smoothstep(16.0, 85.0, _dc) * 2.4;
         transformed *= _vis;
         transformed.y *= _h * 0.96;
         transformed.xz *= (0.55 + _h * 0.45) * _zoom;
         vYel = _yel;`
        );
        shader.fragmentShader = `varying float vYel;
` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
         // 苗期偏嫩黄，盛期转深绿；成熟后转黄褐，留茬偏枯
         diffuseColor.rgb *= mix(vec3(0.88, 1.02, 0.82), vec3(1.16, 1.06, 0.68), vYel);`
        );
      };
      // 作物比草硬：静风 8 mm 的抖，大风再加 7 cm；作物量大，走廉价分支
      patchWind(mat, '0.008', '0.070', true);
      return mat;
    };

    const plantMat = makeCropMat(plantT, false);
    const headMat = makeCropMat(umbelT, true);

    /* ---------- 逐地块收集实例 ---------- */
    const buckets = { tall: [], dense: [], low: [], umbel: [], umbelHead: [] };
    for (let fi = 0; fi < FIELDS.length; fi++) {
      const f = FIELDS[fi];
      const sp = CROP_SPEC[f.crop] || CROP_SPEC.当归;
      const nx = Math.max(2, Math.floor(f.size[0] / sp.gap));
      const nz = Math.max(2, Math.floor(f.size[1] / sp.row));
      const y = heightAt(f.pos[0], f.pos[2]);
      const halfW = f.size[0] / 2, halfD = f.size[1] / 2;
      const cth = Math.cos(f.rot), sth = Math.sin(f.rot);
      const stepX = f.size[0] / nx, stepZ = f.size[1] / nz;
      const base = new THREE.Color(sp.col[0], sp.col[1], sp.col[2]);
      const target = buckets[sp.family];

      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          const lx = -halfW + (ix + 0.5) * stepX + between(-0.07, 0.07);
          const lz = -halfD + (iz + 0.5) * stepZ + between(-0.06, 0.06);
          const wx = f.pos[0] + lx * cth + lz * sth;
          const wz = f.pos[2] - lx * sth + lz * cth;
          const hs = sp.h * between(0.78, 1.18);
          const ws = hs * between(0.85, 1.15);
          const rotY = between(0, Math.PI);
          const shade = between(0.82, 1.16);
          const tint = base.clone().multiplyScalar(shade);
          target.push({ x: wx, y: y + 0.04, z: wz, hs, ws, rotY, tint, fi, rand: Math.random() });
          // 当归：叶丛之外再播一层花葶，位置略靠株心
          if (sp.family === 'umbel') {
            buckets.umbelHead.push({
              x: wx, y: y + 0.04, z: wz,
              hs: 1.55 * between(0.90, 1.10), ws: 1.25 * between(0.90, 1.10),
              rotY: between(0, Math.PI), tint, fi, rand: Math.random(),
            });
          }
        }
      }
    }

    /* ---------- 建 InstancedMesh ---------- */
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const v3 = new THREE.Vector3();
    const sc = new THREE.Vector3();

    const buildFamily = (name, list, geo, mat) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const fieldIdx = new Float32Array(list.length);
      const rand = new Float32Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        q.setFromAxisAngle(UP, c.rotY);
        v3.set(c.x, c.y, c.z);
        sc.set(c.ws, c.hs, c.ws);
        m4.compose(v3, q, sc);
        im.setMatrixAt(i, m4);
        im.setColorAt(i, c.tint);
        fieldIdx[i] = c.fi;
        rand[i] = c.rand;
      }
      im.geometry.setAttribute('aFieldIdx', new THREE.InstancedBufferAttribute(fieldIdx, 1));
      im.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;   // 包围盒按原点算会误剔除；作物始终在视野附近
      root.add(im);
      cropCount += list.length;
      cropMeshes.push(im);
      return im;
    };

    buildFamily('tall', buckets.tall, geoOf('tall'), plantMat);
    buildFamily('dense', buckets.dense, geoOf('dense'), plantMat);
    buildFamily('low', buckets.low, geoOf('low'), plantMat);
    buildFamily('umbel', buckets.umbel, geoOf('umbel'), plantMat);
    buildFamily('umbelHead', buckets.umbelHead, umbelHeadGeo, headMat);
  }

  /**
   * 按气候积温更新 14 块地的生长进度。每帧只写 14 个 float 到 uniform 数组，
   * 不遍历实例 —— 作物总实例数约 4 万，逐实例更新会直接吃掉帧率。
   *
   * 口径：g = clamp((当前积温 − 播种日积温) / gddNeed, 0, 1.10)
   *   g ≤ 0.001 休耕 | <0.12 出苗 | <0.72 生长 | <1.0 成熟 | ≥1.0 收割后留茬
   * 若 climate 未传入（例如无数据的环境），全部按休耕处理，不会报错。
   */
  function updateCropGrowth(climate, hour) {
    const arr = cropUniforms.uFieldG.value;
    const doy = ((hour % 8760) + 8760) % 8760 / 24;
    const gdd = climate ? climate.gddAt(doy) : 0;
    for (let i = 0; i < FIELDS.length; i++) {
      const f = FIELDS[i];
      const sp = CROP_SPEC[f.crop] || CROP_SPEC.当归;
      const sowGdd = climate ? climate.gddAt(sp.sow) : 0;
      const eff = Math.max(0, gdd - sowGdd);
      const g = Math.min(1.10, eff / sp.gddNeed);
      arr[i] = g;
      if (fieldGUniforms[i]) fieldGUniforms[i].value = g;
      const st = fieldState[i];
      st.g = g;
      st.stage = stageOf(g);
      st.gddEff = eff;
      st.gddNeed = sp.gddNeed;
    }
  }

  /* ================= 村内杂物 =================
   * 巷道已并入上面的「道路」段（三类路面合批）。草垛 / 柴堆在此随机散布；
   * 篱笆已改为下方「菜园 / 院前小块地木栅栏」（围 L-05 / L-13，合并 1 个 Mesh）。 */
  {
    // 草垛、柴堆：只做背景，不参与拾取
    const hayMat = new THREE.MeshStandardMaterial({ color: 0xb99a5c, roughness: 0.98 });
    const hayTopMat = new THREE.MeshStandardMaterial({ color: 0x8e7340, roughness: 1 });
    const logMat = new THREE.MeshStandardMaterial({ color: 0x6f5638, roughness: 0.95 });

    const spots = [];
    for (let i = 0; i < 34; i++) {
      const x = between(-72, 72);
      const z = between(-96, 104);
      if (Math.abs(x) < 7) continue;              // 避开主路
      if (HOUSES.some((h) => Math.hypot(h.pos[0] - x, h.pos[2] - z) < 14)) continue;
      spots.push([x, z]);
    }

    spots.forEach(([x, z], i) => {
      const y = heightAt(x, z);
      if (i % 3 === 0) {
        // 草垛
        const r = between(1.1, 1.6), h = between(1.4, 2.1);
        const bale = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, h, 12), hayMat);
        bale.position.set(x, y + h / 2, z);
        bale.castShadow = bale.receiveShadow = true;
        root.add(bale);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 1.02, 0.6, 12), hayTopMat);
        cap.position.set(x, y + h + 0.28, z);
        cap.castShadow = true;
        root.add(cap);
      } else if (i % 3 === 1) {
        // 柴堆
        for (let k = 0; k < 5; k++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, between(1.8, 2.6), 6), logMat);
          log.position.set(x + between(-0.5, 0.5), y + 0.16 + k * 0.24, z + between(-0.4, 0.4));
          log.rotation.z = Math.PI / 2;
          log.rotation.y = between(-0.2, 0.2);
          log.castShadow = true;
          root.add(log);
        }
      } else {
        // 篱笆段（v1.2 旱作元素轮改为菜园围栏）：这里不再随机散建，
        // 但保留 between() 消耗——全局随机序列一 bit 都不能动，
        // 否则其后所有用 between/rnd 的段落整体位移（任务 05 的教训）。
        const ang = between(0, Math.PI);
      }
    });
  }

  /* 菜园 / 院前小块地木栅栏（v1.2 旱作元素轮）：
   * 围住两块蔬菜地——L-05「门前菜地」22×16 m 与 L-13「门前园子」44×30 m。
   * 木栅：立柱每约 2.2 m 一根（柱高 1.25 m、埋深 0.15 m），双横杆（0.52 / 0.92 m 高）；
   * 栅栏线在田埂外 0.8 m（不含在耕地面积里）。树枝栅质感用顶点色微差（亮度 ±6%，
   * 由序号 hash 决定，不消耗随机序列）。全部合并 1 个 BufferGeometry = 1 draw call
   * （改造前的随机散篱笆是 11 段 × 6 Mesh = 66 个 draw call）。 */
  {
    const fenceMat2 = new THREE.MeshStandardMaterial({ color: 0x8a7150, roughness: 0.95, vertexColors: true });
    const fenceGeos = [];
    let fenceSeq = 0;
    const fencePaint = (g) => {
      // 亮度 ±6%：确定性 hash，不调 rnd
      const v = 1 - 0.06 + (((fenceSeq++) * 137) % 13) / 13 * 0.12;
      const col = new THREE.Color(0.62 * v, 0.50 * v, 0.35 * v);
      const p = g.attributes.position;
      const arr = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };
    const toWorld = (g, f, px, py, pz) => {
      g.translate(px, py, pz);
      g.rotateY(f.rot);
      g.translate(f.pos[0], heightAt(f.pos[0], f.pos[2]), f.pos[2]);
      return g;
    };
    for (const f of FIELDS.filter((ff) => ff.crop === '蔬菜')) {
      const W = f.size[0] / 2 + 0.8, D = f.size[1] / 2 + 0.8;   // 栅栏半长/半宽（田埂外 0.8 m）
      const corners = [[-W, -D], [W, -D], [W, D], [-W, D]];
      for (let side = 0; side < 4; side++) {
        const [x0, z0] = corners[side], [x1, z1] = corners[(side + 1) % 4];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(2, Math.round(len / 2.2) + 1);       // 立柱间距约 2.2 m
        const posts = [];
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1);
          const px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
          posts.push([px, pz]);
          // 柱：末段略细（埋地端 0.07 → 顶 0.05），高 1.25 m、中心在地面下 0.15 m 起算
          fenceGeos.push(fencePaint(toWorld(new THREE.CylinderGeometry(0.05, 0.07, 1.25, 5), f, px, 0.475, pz)));
        }
        // 双横杆：0.52 / 0.92 m 高，杆长 = 边长 - 柱径
        for (const hy of [0.52, 0.92]) {
          const rail = new THREE.BoxGeometry(len - 0.1, 0.06, 0.055);
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          const ang2 = Math.atan2(z1 - z0, x1 - x0);
          rail.rotateY(-ang2);
          rail.translate(mx, hy, mz);
          fenceGeos.push(fencePaint(toWorld(rail, f, 0, 0, 0)));
        }
      }
      farmState.fenceLength += 2 * (2 * (W + D));               // 周长，单位 m
    }
    const fenceMesh = new THREE.Mesh(mergeGeometries(fenceGeos, false), fenceMat2);
    fenceMesh.castShadow = true;
    root.add(fenceMesh);
    farmState.fenceMesh = fenceMesh;
  }

  /* ================= 漫水桥 =================
   * 西北旱地小河上常见的低平石桥：桥面只比常水位高 0.30m，汛期水直接从桥上
   * 漫过去，不设栏杆。所有构件共用一种石材并合并成一个 Mesh，只占 1 个 draw call；
   * 第一人称能踏上桥面（walkHeightAt 在桥板范围内抬到 deckY）。 */
  {
    const parts = [];
    const put = (geo, x, y, z) => { geo.translate(x, y, z); parts.push(geo); };
    const { x: bx, z: bz, deckY } = BRIDGE;
    put(new THREE.BoxGeometry(16, 0.28, 3.4), bx, deckY - 0.14, bz);
    for (const s of [-1, 1]) {
      put(new THREE.BoxGeometry(1.4, 0.50, 3.8), bx + s * 8.2, deckY - 0.25, bz);
      put(new THREE.BoxGeometry(4.6, 0.16, 3.0), bx + s * 10.9, -0.06, bz);
    }
    for (let i = -1.5; i <= 1.5; i++) {
      put(new THREE.BoxGeometry(0.55, 1.62, 3.0), bx + i * 3.6, RIVER.bedY + 0.81, bz);
    }
    const bridgeGeo = mergeGeometries(parts, false);
    // 石材贴图默认是细密小方砖，桥面太大时会糊成一片网格；把 uv 收小，读成大块石板
    const buv = bridgeGeo.attributes.uv;
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i) * 0.24, buv.getY(i) * 0.24);
    buv.needsUpdate = true;
    const bridge = new THREE.Mesh(bridgeGeo, matStone);
    bridge.name = 'river-bridge';
    bridge.castShadow = true; bridge.receiveShadow = true;
    root.add(bridge);
  }

  /* ================= 几何草：每一根都是实体，带风动 ================= */
  const grassState = { mat: null, riverSkipped: 0, count: 0 };

  {
    // 单根草叶：底部宽、向上收窄、带自然弯曲；根部深、尖端浅
    const SEG = 4;
    const buildBlade = () => {
      const pos = [], idx = [], col = [], uv = [];
      const W = 0.0115;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const w = W * (1 - t * 0.92);
        const bend = t * t * 0.34;
        pos.push(-w, t, bend, w, t, bend);
        const c = 0.46 + t * 0.52;
        col.push(0.43 * c, 0.41 * c, 0.21 * c, 0.43 * c, 0.41 * c, 0.21 * c);
        uv.push(0, t, 1, t);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };

    const bladeGeo = buildBlade();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float _lum3 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summerG = vec3(0.185, 0.320, 0.105) * (0.62 + _lum3 * 1.15);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summerG, uGreen * 0.86);
         // 季节染绿之后，把每株自己的色相（枯黄/青绿）找补回来；
         // 但不能再把亮度归一化掉，否则根深尖浅的渐变会变成一刀切
         vec3 _tint = vColor / max(0.05, dot(vColor, vec3(0.333)));
         float _vl = clamp(dot(vColor, vec3(0.333)), 0.0, 1.0);
         diffuseColor.rgb *= mix(vec3(1.0), _tint, 0.62) * mix(0.84, 1.10, _vl);`
      );
      // 顶点：只保留"按季节定高矮"这一个形态项；
      // 摆动交给 patchWind 在**世界空间**统一按风向做（v1.0/v1.1 是对象空间随机向）
      shader.vertexShader = 'uniform float uGreen;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed.y *= 0.82 + uGreen * 0.5;`
      );
      grassState.mat = shader;
    };
    // 草软：静风 3 cm 的常驻轻摆，大风再加 40 cm（作用于尖端，实际还要乘每株竖向缩放，
    // 9 m/s 时最高的草约 55% 株高顺风倾伏）。每株草自带 ±11° 随机基础倾角，
    // 风致幅度必须压过它，"风向统一"才看得出来；低于 0.15 时只剩纹理抖动。
    patchWind(mat, '0.030', '0.400');

    // 只在村子核心区铺实体草，外围继续靠贴图
    const R = 46;
    const N = new URLSearchParams(location.search).has('nograss') ? 0 : 150000;
    const im = new THREE.InstancedMesh(bladeGeo, mat, N);
    const arr = im.instanceMatrix.array;

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const tmpColor = new THREE.Color();

    let n = 0, guard = 0;
    while (n < N && guard++ < N * 14) {
      const x = between(-R, R);
      const z = between(-R, R);
      if (x * x + z * z > R * R) continue;
      // 路边软过渡：越靠近路面中心，长草概率越低（踩踏效应）
      const rd = Math.abs(x);
      const keep = rd < 2.6 ? 0.05 : rd < 4.2 ? 0.35 : rd < 5.4 ? 0.72 : 1;
      if (Math.random() > keep) continue;
      if (HOUSES.some((h) => Math.abs(h.pos[0] - x) < 7.5 && Math.abs(h.pos[2] - z) < 9.5)) continue;
      if (FIELDS.some((f) => Math.abs(f.pos[0] - x) < f.size[0] / 2 && Math.abs(f.pos[2] - z) < f.size[1] / 2)) continue;
      // 河道带内一根草都不留：水面是半透明层，草叶浮在水上会直接穿帮。
      // 现有撒点半径只有 46m、河在 x≈-100，物理上到不了，这里仍是显式保证，
      // 万一以后把草铺到村外也不会失效；计数可供 probe 核对。
      if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12 &&
          Math.abs(x - riverCenterX(z)) < RIVER.out + 2) {
        grassState.riverSkipped++;
        continue;
      }

      const y = heightAt(x, z);
      // 加大形态差异：高矮、粗细、倒伏角度都不同，避免"一片同款绿条"
      // 基础倾角从 ±0.34 rad 收到 ±0.20：每株草的随机倾角一旦大过风致位移，
      // "风向统一"在静止画面上就读不出来（6 m/s 时实测会被随机方向盖掉）
      const hgt = between(0.10, 0.58);
      const wid = between(0.55, 1.65);
      q.setFromEuler(new THREE.Euler(
        between(-0.20, 0.20), between(0, Math.PI * 2), between(-0.20, 0.20)
      ));
      // 场院/粪堆/圈舍是压实地面，不让草从里面钻出来；判定放在所有随机取数之后，
      // 不消耗新的随机数，也不会打乱后续撒点（缩放为 0 的实例仍然写满，n 照常递增）。
      const hidden = (inProduction(x, z) || inCivic(x, z) || inField(x, z) || inRoad(x, z)) ? 0 : 1;
      m4.compose(
        new THREE.Vector3(x, y - 0.01, z),
        q,
        new THREE.Vector3(wid * hidden, hgt * hidden, wid * hidden)
      );
      m4.toArray(arr, n * 16);

      // 固有色：一部分是枯草（偏黄褐），一部分青绿，各自还有深浅
      const dryness = Math.pow(Math.random(), 1.6);       // 多数偏绿，少数枯
      const shade = between(0.78, 1.22);
      const cr = (0.86 + dryness * 0.62) * shade;
      const cg = (1.08 - dryness * 0.16) * shade;
      const cb = (0.82 - dryness * 0.34) * shade;
      im.setColorAt(n, tmpColor.setRGB(cr, cg, cb));
      n++;
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = true;
    im.frustumCulled = false;
    root.add(im);

    grassState.mesh = im;
    grassState.count = n;

    /* 近景加密层：村内 34m 核心区再叠一层更矮更密的短草。
     * 与基础层共用材质（uTime 自然同步），单独一个 InstancedMesh 只占 1 个 draw call；
     * 相机在村里时近处密度接近翻倍，走到村外这层自然落在身后。 */
    {
      const SEG = 3, pos = [], idx = [], col = [], uv = [];
      const BW = 0.0135;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const w = BW * (1 - t * 0.92);
        const bend = t * t * 0.30;
        pos.push(-w, t, bend, w, t, bend);
        const c = 0.40 + t * 0.60;      // 根深尖浅，比基础层再拉开一点
        col.push(0.43 * c, 0.43 * c, 0.21 * c, 0.43 * c, 0.43 * c, 0.21 * c);
        uv.push(0, t, 1, t);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const nearGeo = new THREE.BufferGeometry();
      nearGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      nearGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      nearGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      nearGeo.setIndex(idx);
      nearGeo.computeVertexNormals();

      const NN = 50000, RN = 34;
      const nim = new THREE.InstancedMesh(nearGeo, mat, NN);
      const narr = nim.instanceMatrix.array;
      let nn = 0, nguard = 0;
      while (nn < NN && nguard++ < NN * 14) {
        const x = between(-RN, RN);
        const z = between(-RN, RN);
        if (x * x + z * z > RN * RN) continue;
        if (HOUSES.some((h) => Math.abs(h.pos[0] - x) < 7.5 && Math.abs(h.pos[2] - z) < 9.5)) continue;
        if (FIELDS.some((f) => Math.abs(f.pos[0] - x) < f.size[0] / 2 && Math.abs(f.pos[2] - z) < f.size[1] / 2)) continue;
        if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12 &&
            Math.abs(x - riverCenterX(z)) < RIVER.out + 2) continue;
        const y = heightAt(x, z);
        const hgt = between(0.07, 0.34);
        const wid = between(0.60, 1.50);
        q.setFromEuler(new THREE.Euler(
          between(-0.18, 0.18), between(0, Math.PI * 2), between(-0.18, 0.18)
        ));
        const hidden = (inProduction(x, z) || inCivic(x, z) || inField(x, z) || inRoad(x, z)) ? 0 : 1;
        m4.compose(
          new THREE.Vector3(x, y - 0.008, z),
          q,
          new THREE.Vector3(wid * hidden, hgt * hidden, wid * hidden)
        );
        m4.toArray(narr, nn * 16);
        const dryness = Math.pow(Math.random(), 2.1);
        const shade = between(0.80, 1.16);
        nim.setColorAt(nn, tmpColor.setRGB(
          (0.82 + dryness * 0.55) * shade,
          (1.10 - dryness * 0.14) * shade,
          (0.80 - dryness * 0.30) * shade
        ));
        nn++;
      }
      nim.count = nn;
      nim.instanceMatrix.needsUpdate = true;
      if (nim.instanceColor) nim.instanceColor.needsUpdate = true;
      nim.castShadow = false;
      nim.receiveShadow = true;
      nim.frustumCulled = false;
      root.add(nim);
      grassState.near = nim;
      grassState.nearCount = nn;
    }
  }

  /* ================= 野性层：灌木丛 + 杂草 =================
   * 坡地、田埂、河岸在原有一层草皮之外再叠两级：矮丛灌木（0.55~1.65 m）与
   * 丛生杂草（0.35~0.95 m）。两级各自 1 个 InstancedMesh，draw call 恒为 2，
   * castShadow=false 所以阴影通道 0；数值口径全部集中在顶层 SCRUB 常量。
   *
   * 撒点规则（不消耗全局 rnd，固定种子可复现）：
   *   密度 = 坡度权 / 山体权 / 河岸带 / 田埂带 的最大值 × fbm 斑块 × 靠近路建时的稀疏系数
   *   斑块让灌木成簇、留出空档；靠近主路 2.2 m、巷道 1.6 m、民居院墙 3 m 内趋近 0。
   * 远处：顶点着色器按实例到相机的距离把叶卡塌缩进核心块（42~58 m），
   *   再整体淡出（58~80 m）；杂草 30~46 m 直接淡出。远景山体一根都不画。
   */
  const scrubState = {
    count: 0, weedCount: 0, meshes: 2, shrubMesh: null, weedMesh: null,
    fade: { shrub: [SCRUB.SHRUB_FADE_FAR, SCRUB.SHRUB_FADE_END], weed: [SCRUB.WEED_FADE_FAR, SCRUB.WEED_FADE_END] },
  };

  {
    const R = treeRng(SCRUB.SEED);
    const rand = (a, b) => a + R() * (b - a);
    const sstep = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };

    // ---- 距离辅助（单位 m）----
    const segDist = (x, z, ax, az, bx, bz) => {
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    };
    const laneDist = (x, z) => {
      let d = 1e9;
      for (const L of LANES) d = Math.min(d, segDist(x, z, L.a[0], L.a[1], L.b[0], L.b[1]));
      return d;
    };
    const ridgeDist = (x, z) => {
      let d = 1e9;
      for (const G of RIDGES) d = Math.min(d, segDist(x, z, G.a[0], G.a[1], G.b[0], G.b[1]));
      return d;
    };
    const houseDist = (x, z) => {
      let d = 1e9;
      for (const h of HOUSES) {
        const dx = Math.max(0, Math.abs(x - h.pos[0]) - h.yard.w / 2);
        const dz = Math.max(0, Math.abs(z - h.pos[2]) - h.yard.d / 2);
        d = Math.min(d, Math.hypot(dx, dz));
      }
      return d;
    };
    const yardDist = (x, z) => {
      let d = 1e9;
      for (const p of PRODUCTION) {
        d = Math.min(d, Math.hypot(x - p.pos[0], z - p.pos[2]) - (p.kind === 'floor' ? 5.6 : 2.2));
      }
      for (const c of CIVIC) d = Math.min(d, Math.hypot(x - c.pos[0], z - c.pos[2]) - c.radius);
      for (const f of FACILITIES) {
        if (f.kind === 'streetlight') continue;
        d = Math.min(d, Math.hypot(x - f.pos[0], z - f.pos[2]) - 7);
      }
      return d;
    };
    /** 点到最近耕地矩形边界的距离（m，田内为 0）。田边那一圈最容易长灌木，
     *  也最容易被看见，比田埂之间那条缝更自然。用旋转矩形，与 inField 同一套变换。 */
    const fieldDist = (x, z) => {
      let d = 1e9;
      for (const f of FIELDS) {
        const c = Math.cos(f.rot), sn = Math.sin(f.rot);
        const dx = x - f.pos[0], dz = z - f.pos[2];
        const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        const ox = Math.max(0, Math.abs(lx) - f.size[0] / 2);
        const oz = Math.max(0, Math.abs(lz) - f.size[1] / 2);
        d = Math.min(d, Math.hypot(ox, oz));
      }
      return d;
    };
    // 坡度：1.6 m 半基线的中心差分，量纲 m/m；同时回填梯度供灌木顺坡倾斜
    const grad = { x: 0, z: 0 };
    const slopeAt = (x, z) => {
      const e = 1.6;
      const gx = heightAt(x + e, z) - heightAt(x - e, z);
      const gz = heightAt(x, z + e) - heightAt(x, z - e);
      grad.x = gx / (2 * e);
      grad.z = gz / (2 * e);
      return Math.hypot(grad.x, grad.z);
    };
    // 地形法线（近似）：灌木按它倾斜，陡坡上才不会被看出「一根根直立插在坡上」
    const slopeQuat = (out, yaw) => {
      const n = new THREE.Vector3(-grad.x, 1, -grad.z).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.35).normalize();
      out.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
      return out;
    };
    // 靠近道路与建筑处的稀疏系数：0 = 完全不长，1 = 不受限
    const openness = (x, z) => sstep(SCRUB.ROAD_NEAR, SCRUB.ROAD_FAR, Math.abs(x - roadX(z)))
      * sstep(SCRUB.LANE_NEAR, SCRUB.LANE_FAR, laneDist(x, z))
      * sstep(SCRUB.HOUSE_NEAR, SCRUB.HOUSE_FAR, houseDist(x, z))
      * sstep(SCRUB.YARD_NEAR, SCRUB.YARD_FAR, yardDist(x, z));

    /**
     * 野性层材质。两套实例共用同一个 shader 源（只差 uniform 值），所以只编译一次。
     * 片段：
     *   1) 灌木叶卡带 alphaTest，核心块（aCore=1）强制走过 alpha 并绕开贴图
     *      —— 核心块没有 uv，采到的贴图颜色不可用；
     *   2) 季节：春夏偏青绿、秋冬偏枯黄褐，两端都乘在顶点色上，保留各自的明暗；
     *   3) 积雪按局部高度扫白（越靠上堆得越多），与地形/屋顶用同一个 uSnow；
     *   4) 远处略压暗，避免密集小实例在远距离闪成亮斑。
     * 顶点：
     *   1) 叶卡按 aCore 塌缩（远处只剩核心块 = 简化模型）；
     *   2) 整体按距离淡出，远景山体不受影响。
     */
    const leafTex = TEX.leafCard([226, 230, 214]);
    // 季节配色：灌木走「乘色」保住叶卡的深绿层次；杂草走「换色」，
    // 与草地一样按亮度重建色相 —— 不这么做，枯草会把顶点色乘成一片惨白。
    const seasonGLSL = (kind) => (kind === 'weed'
      ? `float _wl = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summerW = vec3(0.170, 0.300, 0.098) * (0.62 + _wl * 2.10);
         vec3 _winterW = vec3(0.400, 0.330, 0.135) * (0.62 + _wl * 2.10);
         diffuseColor.rgb = mix(_winterW, _summerW, uGreen);`
      : `vec3 _spr = diffuseColor.rgb * vec3(0.72, 1.06, 0.60);
         vec3 _win = diffuseColor.rgb * vec3(1.42, 1.10, 0.62);
         diffuseColor.rgb = mix(_win, _spr, uGreen);`);
    const makeScrubMat = (range, lodOn, withMap, kind) => {
      const mat = new THREE.MeshStandardMaterial({
        map: withMap ? leafTex.map : null,
        alphaTest: withMap ? 0.24 : 0,
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.96,
        metalness: 0,
      });
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = function (shader, renderer) {
        if (prev) prev.call(this, shader, renderer);
        shader.uniforms.uGreen = seasonUniform;
        shader.uniforms.uSnow = weatherUniforms.snow;
        shader.uniforms.uScrubRange = { value: new THREE.Vector4(range[0], range[1], range[2], range[3]) };
        shader.uniforms.uScrubLod = { value: lodOn };

        shader.vertexShader = 'attribute float aCore;\nuniform vec4 uScrubRange;\nuniform float uScrubLod;\n'
          + 'varying float vLocalY;\nvarying float vFade;\nvarying float vCore;\n'
          + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vLocalY = clamp(position.y, 0.0, 1.0);
           vCore = aCore;
           #ifdef USE_INSTANCING
             float _sd = distance(instanceMatrix[3].xyz, cameraPosition);
           #else
             float _sd = 0.0;
           #endif
           // 远处把叶卡塌缩、同时把核心块长出来：近处 aCore=1 的核心块缩到 0，
           // 远处叶卡缩到 0、只剩核心块。三角形退化成一点，不参与光栅化。
           float _lod = smoothstep(uScrubRange.x, uScrubRange.y, _sd) * uScrubLod;
           transformed *= mix(1.0 - _lod, _lod, aCore);
           // 整体淡出：远景一根都不画
           float _fade = 1.0 - smoothstep(uScrubRange.z, uScrubRange.w, _sd);
           transformed *= _fade;
           vFade = _fade;`
        );

        shader.fragmentShader = 'uniform float uGreen;\nuniform float uSnow;\n'
          + 'varying float vLocalY;\nvarying float vFade;\nvarying float vCore;\n'
          + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           // 核心块：不吃贴图（没有 uv），并跳过 alpha 裁切
           diffuseColor.rgb = mix(diffuseColor.rgb, vColor, vCore);
           diffuseColor.a = mix(diffuseColor.a, 1.0, vCore);
           // 季节：春夏青绿、秋冬枯黄褐（灌木乘色、杂草换色，见 seasonGLSL）
           ${seasonGLSL(kind)}
           // 积雪：越靠上堆得越多，与地形共用 uSnow
           float _snowM = mix(0.30, 1.0, smoothstep(0.10, 0.95, vLocalY));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.78, 0.82), uSnow * _snowM * 0.80);
           // 远处略压暗，防止密集小实例闪成亮斑
           diffuseColor.rgb *= mix(1.0, 0.90, vFade);`
        );
      };
      return mat;
    };

    // ---- 灌木 ----
    {
      const geo = buildShrubGeo();
      const mat = makeScrubMat(
        [SCRUB.SHRUB_LOD_NEAR, SCRUB.SHRUB_LOD_FAR, SCRUB.SHRUB_FADE_FAR, SCRUB.SHRUB_FADE_END], 1, true, 'shrub'
      );
      patchWind(mat, '0.006', '0.045');    // 木质灌木：风里只轻轻晃
      const im = new THREE.InstancedMesh(geo, mat, SCRUB.SHRUB_N);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const UP = new THREE.Vector3(0, 1, 0);
      const tmpC = new THREE.Color();
      let n = 0, guard = 0;
      while (n < SCRUB.SHRUB_N && guard++ < SCRUB.SHRUB_N * 40) {
        const x = rand(SCRUB.X0, SCRUB.X1);
        const z = rand(SCRUB.Z0, SCRUB.Z1);

        // 1) 斑块噪声：成簇分布，patch 低的地方整片空着
        const patch = sstep(SCRUB.PATCH_LO, SCRUB.PATCH_HI,
          fbm(x * SCRUB.PATCH_FREQ, z * SCRUB.PATCH_FREQ, 3));
        if (patch < 0.02) continue;

        // 2) 分区权重取最大值：陡坡 / 山体 / 河岸 / 田埂
        const slope = slopeAt(x, z);
        let base = Math.max(SCRUB.FLAT_W, sstep(SCRUB.SLOPE_LO, SCRUB.SLOPE_HI, slope) * SCRUB.SLOPE_W);
        const hill = hillLift(x, z);
        if (hill > 0) base = Math.max(base, sstep(SCRUB.HILL_LO, SCRUB.HILL_HI, hill) * SCRUB.HILL_W);

        const inRiverZ = z > RIVER.z0 && z < RIVER.z1;
        const dr = inRiverZ ? Math.abs(x - riverCenterX(z)) : 1e9;
        const nearWater = inRiverZ && dr < RIVER.out + SCRUB.RIVER_BAND;
        if (nearWater) {
          base = Math.max(base, SCRUB.RIVER_W * (1 - sstep(RIVER.out + 0.4, RIVER.out + SCRUB.RIVER_BAND, dr) * 0.55));
        }
        const rgd = ridgeDist(x, z);
        if (rgd > 1.1 && rgd < SCRUB.RIDGE_BAND + 1.1) base = Math.max(base, SCRUB.RIDGE_W);
        const fd = fieldDist(x, z);
        if (fd > SCRUB.FIELD_NEAR && fd < SCRUB.FIELD_FAR) base = Math.max(base, SCRUB.FIELD_W);
        // 村周：房前屋后的空地，但 openness 会把院内与路边再压掉
        base = Math.max(base, SCRUB.VILLAGE_W * sstep(SCRUB.VILLAGE_OUT, SCRUB.VILLAGE_IN, Math.hypot(x, z)));

        // 3) 先按 密度×斑块 抽一次，过了再做昂贵的排除判定
        if (R() > base * (0.25 + 0.75 * patch)) continue;
        if (inField(x, z) || inRoad(x, z) || inProduction(x, z) || inCivic(x, z)) continue;
        if (inRiverZ && dr < RIVER.out + 0.4) continue;       // 不泡在水里
        if (rgd < 1.1) continue;                              // 不占田埂路面
        if (R() > openness(x, z)) continue;                   // 靠近路建处稀疏

        const y = heightAt(x, z);
        const hgt = rand(SCRUB.SHRUB_H[0], SCRUB.SHRUB_H[1]);
        const wid = hgt * rand(SCRUB.SHRUB_W[0], SCRUB.SHRUB_W[1]);
        slopeQuat(q, rand(0, Math.PI * 2));
        // 下沉 0.12 m：坡面上灌木的迎坡侧不会露出悬空的根
        m4.compose(new THREE.Vector3(x, y - 0.12, z), q, new THREE.Vector3(wid, hgt, wid));
        im.setMatrixAt(n, m4);
        const shade = rand(0.78, 1.18);
        tmpC.setRGB(shade * rand(0.92, 1.06), shade, shade * rand(0.86, 1.02));
        im.setColorAt(n, tmpC);
        n++;
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      root.add(im);
      scrubState.shrubMesh = im;
      scrubState.count = n;
    }

    // ---- 杂草 ----
    {
      const geo = buildWeedGeo();
      const mat = makeScrubMat([99998, 99999, SCRUB.WEED_FADE_FAR, SCRUB.WEED_FADE_END], 0, false, 'weed');
      patchWind(mat, '0.020', '0.220', true);   // 细茎：摆幅比灌木大，走廉价分支
      const im = new THREE.InstancedMesh(geo, mat, SCRUB.WEED_N);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const UP = new THREE.Vector3(0, 1, 0);
      const tmpC = new THREE.Color();
      let n = 0, guard = 0;
      while (n < SCRUB.WEED_N && guard++ < SCRUB.WEED_N * 40) {
        const x = rand(SCRUB.WEED_X0, SCRUB.WEED_X1);
        const z = rand(SCRUB.WEED_Z0, SCRUB.WEED_Z1);

        const patch = sstep(0.34, 0.70, fbm(x * 0.055 + 13.7, z * 0.055 - 8.1, 3));
        if (patch < 0.02) continue;

        const slope = slopeAt(x, z);
        let base = 0.08 + sstep(0.02, 0.12, slope) * 0.30;

        const inRiverZ = z > RIVER.z0 && z < RIVER.z1;
        const dr = inRiverZ ? Math.abs(x - riverCenterX(z)) : 1e9;
        if (inRiverZ && dr > RIVER.out + 0.3 && dr < RIVER.out + 14) base = Math.max(base, 0.70);
        const rgd = ridgeDist(x, z);
        if (rgd > 0.55 && rgd < 2.6) base = Math.max(base, 0.78);
        // 村内空地：0.22 的底噪，让房前屋后也有几丛高的
        base = Math.max(base, 0.22 * sstep(110, 30, Math.hypot(x, z)));

        if (R() > base * (0.20 + 0.80 * patch)) continue;
        if (inField(x, z) || inRoad(x, z) || inProduction(x, z) || inCivic(x, z)) continue;
        if (inRiverZ && dr < RIVER.out + 0.3) continue;
        if (rgd < 0.55) continue;                             // 不占田埂路面
        if (R() > openness(x, z) * 1.25) continue;

        const y = heightAt(x, z);
        const hgt = rand(SCRUB.WEED_H[0], SCRUB.WEED_H[1]);
        const wid = hgt * rand(0.85, 1.35);
        q.setFromAxisAngle(UP, rand(0, Math.PI * 2));
        m4.compose(new THREE.Vector3(x, y - 0.02, z), q, new THREE.Vector3(wid, hgt, wid));
        im.setMatrixAt(n, m4);
        const shade = rand(0.80, 1.20);
        tmpC.setRGB(shade * rand(0.94, 1.08), shade, shade * rand(0.84, 1.00));
        im.setColorAt(n, tmpC);
        n++;
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      root.add(im);
      scrubState.weedMesh = im;
      scrubState.weedCount = n;
    }
  }

  /* ================= 降水：雨丝 / 雪片 =================
   * 放在独立 Scene 里、主渲染之后叠加绘制。不进主场景是因为 GTAOPass 会用
   * overrideMaterial 重渲染整个场景做深度/法线预通道，半透明粒子会把预通道打花。
   * 粒子全部由 shader 按 uTime 循环下落，CPU 每帧只更新几个 uniform。 */
  const weatherScene = new THREE.Scene();
  const weatherTime = { value: 0 };
  const RAIN_N = 1300, SNOW_N = 900, SPAN = 30, RADIUS = 34;
  let rainMesh = null, snowMesh = null, rainGeo = null, snowGeo = null;

  {
    const rp = new Float32Array(RAIN_N * 2 * 3);
    const rs = new Float32Array(RAIN_N * 2);
    const re = new Float32Array(RAIN_N * 2);
    for (let i = 0; i < RAIN_N; i++) {
      const x = (Math.random() * 2 - 1) * RADIUS;
      const z = (Math.random() * 2 - 1) * RADIUS;
      const y = Math.random() * SPAN;
      const s = Math.random();
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        rp[k * 3] = x; rp[k * 3 + 1] = y; rp[k * 3 + 2] = z;
        rs[k] = s; re[k] = e;
      }
    }
    rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(rs, 1));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
    rainGeo.setDrawRange(0, 0);

    const rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: weatherTime, uColor: { value: new THREE.Color(0xbfd0de) },
        uOpacity: { value: 0.36 }, uSpan: { value: SPAN },
        uWindDir: windUniforms.uWindDir, uWindSpeed: windUniforms.uWindSpeed,
      },
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `
        uniform float uTime, uSpan, uWindSpeed;
        uniform vec2 uWindDir;
        attribute float aSeed; attribute float aEnd;
        varying float vFade;
        void main(){
          vec3 p = position;
          float sp = 19.0 * (0.72 + aSeed * 0.56);
          float yy = mod(p.y - uTime * sp, uSpan);
          p.y = yy - uSpan * 0.5;
          // 风把雨丝整体吹偏；wl 与旧的 uWind 同量级（0..4），保持原有视觉尺度
          float wl = min(4.0, uWindSpeed * 0.45);
          p.xz += uWindDir * (wl * (uSpan - yy) * 0.018);
          p.y -= aEnd * (1.05 + aSeed * 0.85);
          // 尾迹方向必须与速度矢量同向：水平偏移 = 风向 × 风速，静风时雨丝竖直
          p.xz -= uWindDir * (aEnd * wl * 0.02);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dep = -mv.z;
          vFade = smoothstep(1.0, 4.0, dep) * (1.0 - smoothstep(40.0, 72.0, dep));
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying float vFade;
        void main(){ gl_FragColor = vec4(uColor, uOpacity * vFade); }`,
    });
    rainMesh = new THREE.LineSegments(rainGeo, rainMat);
    rainMesh.frustumCulled = false;
    rainMesh.visible = false;
    weatherScene.add(rainMesh);

    const sp2 = new Float32Array(SNOW_N * 3);
    const ss = new Float32Array(SNOW_N);
    for (let i = 0; i < SNOW_N; i++) {
      sp2[i * 3] = (Math.random() * 2 - 1) * RADIUS;
      sp2[i * 3 + 1] = Math.random() * SPAN;
      sp2[i * 3 + 2] = (Math.random() * 2 - 1) * RADIUS;
      ss[i] = Math.random();
    }
    snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(sp2, 3));
    snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(ss, 1));
    snowGeo.setDrawRange(0, 0);

    const snowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: weatherTime, uColor: { value: new THREE.Color(0xf4f8ff) },
        uSpan: { value: SPAN },
        uWindDir: windUniforms.uWindDir, uWindSpeed: windUniforms.uWindSpeed,
      },
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `
        uniform float uTime, uSpan, uWindSpeed;
        uniform vec2 uWindDir;
        attribute float aSeed;
        varying float vFade;
        void main(){
          vec3 p = position;
          float sp = 1.9 * (0.65 + aSeed * 0.7);
          float yy = mod(p.y - uTime * sp, uSpan);
          p.y = yy - uSpan * 0.5;
          // 自身飘摆（沿风方向 + 侧向各一层），再叠风场平移
          float wl = min(4.0, uWindSpeed * 0.45);
          vec2 swirl = vec2(sin(uTime * 0.9 + aSeed * 31.4) * 0.85,
                            cos(uTime * 0.7 + aSeed * 17.7) * 0.55);
          p.xz += swirl + uWindDir * (wl * (uSpan - yy) * 0.016);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dep = -mv.z;
          gl_PointSize = clamp((1.6 + aSeed * 2.4) * 26.0 / max(2.0, dep), 1.0, 6.0);
          vFade = smoothstep(1.0, 4.0, dep) * (1.0 - smoothstep(42.0, 74.0, dep));
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * 0.86 * vFade;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    snowMesh = new THREE.Points(snowGeo, snowMat);
    snowMesh.frustumCulled = false;
    snowMesh.visible = false;
    weatherScene.add(snowMesh);
  }

  /** 由真实气象记录驱动降水强度；粒子盒跟随相机，第一人称/上帝视角都有雨雪
   *  playing：时间轴是否在走。炊烟的时间只在播放时累加，暂停即冻结。 */
  function updateWeather(wx, camera, dt, playing = true) {
    weatherTime.value += dt;
    const isSnow = wx.isSnow;
    const rainAmt = Math.min(1, (wx.rainRate || 0) / 5.5);
    const snowAmt = Math.min(1, (wx.snowRate || 0) / 0.5 + (wx.rainRate || 0) * 0.12);

    rainMesh.visible = !isSnow && rainAmt > 0.02;
    snowMesh.visible = isSnow && snowAmt > 0.02;
    rainGeo.setDrawRange(0, Math.floor(RAIN_N * rainAmt) * 2);
    snowGeo.setDrawRange(0, Math.floor(SNOW_N * snowAmt));
    // 风向/风速不在这里写：rainMat / snowMat 的 uniform 与草、旗共用同一组对象，
    // 每帧由 environment.js 统一写入，避免两处各写一次产生一帧的错位
    weatherScene.position.copy(camera.position);
    weatherScene.position.y -= 5;

    /* ---- 炊烟：按作息表逐户算生火强度，写进预分配数组 ----
     * 强度 0..1 决定这户烟团的透明度；不建对象、不 concat、不 map。 */
    if (smokeState.mesh) {
      if (playing) smokeTime.value += dt;      // 暂停时定住，不继续漂移
      const day = wx.doy ?? 0;
      const hod = wx.hourOfDay ?? 0;
      const lv = smokeState.level;
      let lit = 0;
      for (let i = 0; i < chimneys.length; i++) {
        const c = chimneys[i];
        const v = cookingIntensity(c.idx, day, hod, c.residents);
        if (v > 0.03) lit++;
        const base = i * SMOKE_PER;
        for (let k = 0; k < SMOKE_PER; k++) lv[base + k] = v;
      }
      smokeState.lit = lit;
      smokeState.levelAttr.needsUpdate = true;
      const u = smokeState.uniforms;
      u.uLight.value = wx.dayF ?? 1;
      u.uSnow.value = isSnow ? 1 : 0;
      u.uViewH.value = wx.viewHeightPx ?? 720;
    }

    // 农事随时令：秋收季（9 月中—12 月中）晾药材，其余月份挂辣椒串
    const doy = wx.doy ?? 0;
    const harvest = doy >= 255 || doy <= 15;
    for (const grp of yardAutumn) grp.visible = harvest;
    for (const grp of yardSummer) grp.visible = !harvest;
  }

  /* ================= 教学视图：标注层 + 河谷剖面（默认全关） =================
   * 标注层：24 个标签（地名 10 + 地块编号 L-01…L-14）画进一张 canvas 图集，
   *         1 个 InstancedMesh 广告牌面片（顶点着色器内 billboard）= 1 draw call；
   *         等高线在地形 shader 内实现（uContour，2 m 间隔）= 0 draw call。
   * 剖面视图：裁剪平面 z = −60（法线 (0,0,1)，保留南半村域，切面垂直于河道流向），
   *         开启时给场景材质挂 clippingPlanes、关闭全部还原 null（无残留）；
   *         剖面填充面 1 个 quad：CanvasTexture 按 heightAt(x, −60) 逐列采样画河床轮廓、
   *         表土 / 心土 / 基岩三层填充与水体，尺寸标注直接读 RIVER 常量——
   *         下切 2.2 m（bedY）、水位 −0.6 m（waterY）、水面宽 8 m（常水位与岸坡交线 |d|≈3.88 m）。
   * 相机机位的保存 / 恢复由 main.js 负责（rig 归 main 所有）。 */
  const teachState = { labels: false, section: false, clippedMats: 0 };
  {
    /* ---- 1) 标签图集：6 列 × 4 行，槽位 256×96，四边留 6px ---- */
    const LBL = {
      cols: 6, rows: 4, slotW: 256, slotH: 96,
      items: [
        ...FACILITIES.filter((f) => ['F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06'].includes(f.id))
          .map((f) => ({ text: f.name, x: f.pos[0], z: f.pos[2] })),
        ...CIVIC.map((c) => ({ text: c.name, x: c.pos[0], z: c.pos[2] })),
        ...FIELDS.map((f) => ({ text: `${f.id} ${f.name}`, x: f.pos[0], z: f.pos[2] })),
      ],
    };
    const atlas = document.createElement('canvas');
    atlas.width = LBL.cols * LBL.slotW;
    atlas.height = LBL.rows * LBL.slotH;
    {
      const g = atlas.getContext('2d');
      g.font = '600 30px system-ui, "PingFang SC", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      LBL.items.forEach((it, i) => {
        const gx = (i % LBL.cols) * LBL.slotW, gy = Math.floor(i / LBL.cols) * LBL.slotH;
        const w = Math.min(LBL.slotW - 10, g.measureText(it.text).width + 26);
        // 圆角药丸底
        g.fillStyle = 'rgba(10, 14, 16, 0.66)';
        g.beginPath();
        g.roundRect(gx + (LBL.slotW - w) / 2, gy + 18, w, LBL.slotH - 36, 14);
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.28)';
        g.stroke();
        g.fillStyle = '#eaf6f2';
        g.fillText(it.text, gx + LBL.slotW / 2, gy + LBL.slotH / 2 + 1);
      });
    }
    const labelTex = new THREE.CanvasTexture(atlas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    // 图集 1536×384 非二次幂：实测开 mipmap 会得到一张空纹理（采样全透明、标签整层不可见，
    // 疑似 ANGLE-on-Metal 对该 NPOT 组合的 mipmap 生成缺陷）。关 mipmap + 线性过滤即可，
    // 标签最大 3.6 m 宽、多数时候远小于屏幕，不用 mip 也够清晰。
    labelTex.generateMipmaps = false;
    labelTex.minFilter = THREE.LinearFilter;
    // 面片直接按世界尺寸建（3.6 × 1.35 m），锚点在面片底部中心上方 0.3 m；
    // 朝向固定 +z（南）——默认视角 / 剖面 / 俯瞰都在南侧，可读；背面 DoubleSide 镜像可接受。
    // 走标准实例化投影（与灌木叶卡同款管线），不自写 project_vertex。
    const labelGeo = new THREE.PlaneGeometry(3.6, 1.35);
    labelGeo.translate(0, 0.675 + 0.15, 0);
    const nLbl = LBL.items.length;
    const uvRect = new Float32Array(nLbl * 4);
    const labelMesh = new THREE.InstancedMesh(labelGeo,
      new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      nLbl);
    {
      const mtx = new THREE.Matrix4();
      LBL.items.forEach((it, i) => {
        const col = i % LBL.cols, row = Math.floor(i / LBL.cols);
        // 槽位 → 0..1 UV（注意 canvas y 向下、纹理 v 向上）
        const u0 = (col * LBL.slotW + 4) / atlas.width, u1 = ((col + 1) * LBL.slotW - 4) / atlas.width;
        const v1 = 1 - (row * LBL.slotH + 4) / atlas.height, v0 = 1 - ((row + 1) * LBL.slotH - 4) / atlas.height;
        uvRect[i * 4] = u0; uvRect[i * 4 + 1] = v0; uvRect[i * 4 + 2] = u1; uvRect[i * 4 + 3] = v1;
        mtx.makeTranslation(it.x, heightAt(it.x, it.z) + 2.6, it.z);   // 锚点：地面上方 2.6 m
        labelMesh.setMatrixAt(i, mtx);
      });
    }
    labelGeo.setAttribute('aUvRect', new THREE.BufferAttribute(uvRect, 4));
    const lblMat = labelMesh.material;
    lblMat.onBeforeCompile = (shader) => {
      // UV 从图集槽位取；投影走默认管线（instanceMatrix 由 project_vertex 自带）
      shader.vertexShader = 'attribute vec4 aUvRect;\nvarying vec2 vLblUv;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLblUv = vec2(mix(aUvRect.x, aUvRect.z, uv.x), mix(aUvRect.y, aUvRect.w, uv.y));`
      );
      shader.fragmentShader = 'varying vec2 vLblUv;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        'diffuseColor *= texture2D(map, vLblUv);'
      );
    };
    labelMesh.frustumCulled = false;             // 24 个实例散布全村，整体包围球不划算
    labelMesh.visible = false;
    labelMesh.renderOrder = 5;                   // 透明标签最后画
    root.add(labelMesh);

    /* ---- 2) 剖面填充面：z = −60 切线上的河谷横截面 ---- */
    const SECTION_Z = -60;
    const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SECTION_Z);  // 保留 z > −60（南半）
    const cxS = riverCenterX(SECTION_Z);
    const yTop = 2.6, yBot = -3.4, secW = 24, secH = yTop - yBot;
    const secCanvas = document.createElement('canvas');
    secCanvas.width = 1024; secCanvas.height = Math.round(1024 * secH / secW);
    {
      const g = secCanvas.getContext('2d');
      const W = secCanvas.width, H = secCanvas.height;
      const pxPerM = W / secW;
      const mapY = (wy) => 6 + (yTop - wy) * (H - 12) / secH;   // 世界 y → 画布 y
      const wx = (px) => cxS - secW / 2 + (px / W) * secW;
      // 水面半宽：数值解 riverHeight(cx+d, z) == waterY（约 3.88 m），箭头与标注用
      const waterY = RIVER.waterY;
      let half = 3;
      for (let d = 3.0; d <= 4.5; d += 0.002) {
        if (heightAt(cxS + d, SECTION_Z) >= waterY) { half = d; break; }
      }
      // 土层：逐列从地形线往下填（表土 / 心土 / 基岩，按绝对标高分界）
      for (let px = 0; px < W; px++) {
        const h = heightAt(wx(px), SECTION_Z);
        for (let py = Math.max(0, Math.floor(mapY(h))); py < H; py++) {
          const wy = yTop - ((py - 6) / (H - 12)) * secH;
          if (wy > h) continue;
          g.fillStyle = wy > -0.45 ? '#6b4f33'            // 表土
            : wy > -1.35 ? '#8a6d46'                       // 心土（母质）
            : (Math.floor(wy / 0.4) % 2 === 0 ? '#75726a' : '#6d6a62');  // 基岩（微层理）
          g.fillRect(px, py, 1, 1);
        }
        // 地表描边
        g.fillStyle = '#3c2f1e';
        g.fillRect(px, Math.max(0, Math.floor(mapY(h)) - 1), 1, 2);
      }
      // 水体：bed 到水位，半透明蓝
      g.fillStyle = 'rgba(74, 128, 178, 0.55)';
      const wl = mapY(waterY);
      for (let px = 0; px < W; px++) {
        const d = Math.abs(wx(px) - cxS);
        if (d >= half) continue;
        const bed = mapY(heightAt(wx(px), SECTION_Z));
        g.fillRect(px, Math.max(0, Math.floor(wl)), 1, Math.max(1, Math.floor(bed) - Math.floor(wl)));
      }
      // 水位虚线
      g.strokeStyle = 'rgba(180, 214, 240, 0.9)';
      g.setLineDash([7, 5]);
      g.beginPath(); g.moveTo(0, wl); g.lineTo(W, wl); g.stroke();
      g.setLineDash([]);
      // 标注（数值全部读 RIVER 常量，单位 m）
      g.font = '600 26px system-ui, "PingFang SC", sans-serif';
      g.textAlign = 'center';
      const arrow = (x0, y0, x1, y1, color) => {
        g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2.5;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        const a = Math.atan2(y1 - y0, x1 - x0);
        g.beginPath(); g.moveTo(x1, y1);
        g.lineTo(x1 - 9 * Math.cos(a - 0.42), y1 - 9 * Math.sin(a - 0.42));
        g.lineTo(x1 - 9 * Math.cos(a + 0.42), y1 - 9 * Math.sin(a + 0.42));
        g.fill();
      };
      const bedYpx = mapY(RIVER.bedY);
      // 下切 2.2 m：岸顶(0) → 河床(bedY)
      const ax = W / 2;
      arrow(ax, mapY(0), ax, bedYpx + 4, '#ffd489');
      g.fillStyle = '#ffd489';
      g.fillText(`下切 ${RIVER.depth.toFixed(1)} m`, ax + 96, (mapY(0) + bedYpx) / 2);
      // 水位 −0.6 m
      g.fillStyle = '#b4d6f0';
      g.fillText(`水位 ${waterY.toFixed(1)} m`, W - 118, wl - 12);
      // 水面宽 8 m（常水位与岸坡交线，|d|≈3.88 m 两侧合计）
      arrow(W / 2 - half * pxPerM, wl - 30, W / 2 + half * pxPerM, wl - 30, '#9fd489');
      g.fillStyle = '#9fd489';
      g.fillText(`水面宽 ${(half * 2).toFixed(0)} m`, W / 2, wl - 44);
      // 层名
      g.font = '500 20px system-ui, "PingFang SC", sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.72)';
      g.textAlign = 'left';
      g.fillText('表土', 10, mapY(-0.2));
      g.fillText('心土', 10, mapY(-0.95));
      g.fillText('基岩', 10, mapY(-2.9));
    }
    const secTex = new THREE.CanvasTexture(secCanvas);
    secTex.colorSpace = THREE.SRGBColorSpace;
    const sectionMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(secW, secH),
      new THREE.MeshBasicMaterial({ map: secTex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    sectionMesh.position.set(cxS, (yTop + yBot) / 2, SECTION_Z + 0.02);
    sectionMesh.visible = false;
    sectionMesh.renderOrder = 4;
    root.add(sectionMesh);

    /* ---- 3) 裁剪挂 / 卸：遍历场景材质，关闭时全部还原 null ---- */
    let clippedMats = [];
    function applySectionClip(on) {
      if (on) {
        clippedMats = [];
        root.traverse((o) => {
          if (o === labelMesh || o === sectionMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m || m.clippingPlanes || clippedMats.includes(m)) continue;
            m.clippingPlanes = [sectionPlane];
            clippedMats.push(m);
          }
        });
        teachState.clippedMats = clippedMats.length;
      } else {
        for (const m of clippedMats) m.clippingPlanes = null;
        clippedMats = [];
        teachState.clippedMats = 0;
      }
    }

    /* ---- 4) 对外开关（相机机位由 main.js 保存 / 恢复） ---- */
    teachState.setLabels = (on) => {
      teachState.labels = on;
      labelMesh.visible = on;
      ground.material.userData.terrainUniforms.uContour.value = on ? 1 : 0;
    };
    teachState.setSection = (on) => {
      teachState.section = on;
      sectionMesh.visible = on;
      applySectionClip(on);
    };
    teachState.closeAll = () => {
      if (teachState.labels) teachState.setLabels(false);
      if (teachState.section) teachState.setSection(false);
    };
    teachState.cam = { x: cxS, y: -0.3, z: SECTION_Z };   // 剖面观察位的目标点（main.js 用）
  }

  /* ================= 每帧动画 ================= */
  const clock = new THREE.Clock();
  // 家畜避雨状态：wet 是雨雪目标（0/1），wetK 是平滑因子（0..1），lastT 上帧实时秒；
  // animals 供 ?qa=1 与验收脚本逐只读取位置（只读，不修改）
  const animalState = { wet: 0, wetK: 0, lastT: 0, animals };
  function update(hour = 0, climate = null, playing = true) {
    const t = performance.now() / 1000;
    // 草、作物、旗面共用这一条时间轴（不受时间轴暂停影响，属环境动画）
    windTime.value = t;
    // 作物物候：每帧只写 14 块地的生长进度到 uniform 数组，不遍历实例
    updateCropGrowth(climate, hour);
    // 家畜活动量由作息表给出：出圈后正常踱步吃草，入夜完全静止。
    // 与炊烟、窗灯读的是同一张表（js/schedule.js），不另写一套时间。
    const herd = herdActivity(((hour % 24) + 24) % 24);
    // 法线贴图沿流向（uv 的 v）缓慢滚动：约 6.2m 一个波纹周期、77 秒走完一格
    if (waterState.normal) waterState.normal.offset.y = -((t * 0.013) % 1);
    skyUniforms.uTime.value = t;
    animalUniforms.uTime.value = t;

    /* ---- 雨雪避檐（v1.2 牲畜微动作轮）----
     * 判定与 updateWeather 同口径（雪量 > 0.01 或降雨 > 0.05 mm/h 量级）；
     * wet 目标由时间轴当前小时的气候数据给出，时间轴暂停时目标冻结；
     * 过渡因子 wetK 以实时秒推进、约 8 s 走完，playing=false 时不推进（同炊烟的暂停口径：
     * 暂停即定住）。摆尾/啄食/呼吸等微动作走实时钟 uTime，暂停时继续——环境动画口径，
     * 与草、旗面、水面法线一致。 */
    if (climate) {
      const s = climate.sample(hour);
      animalState.wet = (s.snow > 0.01 || s.precip > 0.05) ? 1 : 0;
    }
    if (playing) {
      const dtA = Math.min(0.25, t - animalState.lastT);
      const step = (dtA / 8) * (animalState.wet >= animalState.wetK ? 1 : -1);
      animalState.wetK = Math.min(1, Math.max(0, animalState.wetK + step));
    }
    animalState.lastT = t;
    const wetK = animalState.wetK;

    for (const a of animals) {
      const p = a.phase;
      if (a.kind === '狗') {
        /* 看门狗：白天卧在赵宅大门旁。偶尔抬头张望（约 48 s 一个周期、抬头 4~5 s，
         * 抬头 0.55 rad + 左右看 0.18 rad）；呼吸整只 ±1.2%；摇尾走顶点着色器
         * （几何属性 aFreq 2.6 Hz × aWag 0.35）。雨雪天沿 wetK 挪到自家屋檐下。 */
        const lift = Math.pow(Math.max(0, Math.sin(t * 0.13 + p)), 5);
        a.head.rotation.z = lift * 0.55;
        a.head.rotation.y = Math.sin(t * 0.35 + p) * 0.18 * lift;
        a.group.scale.y = 1 + Math.sin(t * 1.3 + p) * 0.012;
        a.group.position.lerpVectors(a.base, a.shelter, wetK);
        continue;
      }
      const dry = herd * (1 - wetK);   // 白天且不淋雨才有踱步与吃草
      const pace = (a.kind === '鸡' ? 1.6 : 0.7) * dry;
      // 轻微踱步（公式与 v1.1 相同），再按 wetK 混合到避雨点
      const px = a.base.x + Math.sin(t * 0.22 + p) * pace;
      const pz = a.base.z + Math.cos(t * 0.17 + p * 1.7) * pace;
      a.group.position.x = px + (a.shelter.x - px) * wetK;
      a.group.position.z = pz + (a.shelter.z - pz) * wetK;
      a.group.position.y = a.base.y + (a.shelter.y - a.base.y) * wetK;
      a.group.rotation.y += Math.sin(t * 0.1 + p) * 0.0015 * dry;

      /* 低头吃草：牛/羊约 24 s 一个慢周期；鸡改成「双啄一停」的锐脉冲
       *（pow 4 锐化，约 2.4 s 一啄、啄程 0.3 s），身体同步前倾 0.06 rad。
       * 雨雪中站立不动、头抬起缓慢环视（0.4 Hz、0.22 rad）。 */
      const graze = Math.max(0, Math.sin(t * (a.kind === '鸡' ? 2.6 : 0.26) + p * 1.3)) * dry;
      const amp = a.kind === '鸡' ? 1.05 : a.kind === '牛' ? 0.95 : 1.0;
      if (a.kind === '鸡') {
        const peck = Math.pow(graze, 4);
        a.head.rotation.z = -peck * amp;
        a.group.rotation.x = peck * 0.06;
      } else {
        a.head.rotation.z = -Math.pow(graze, 0.7) * amp;
      }
      a.head.rotation.y = Math.sin(t * 0.4 + p) * 0.22 * wetK * (1 - graze);
      // 牛的反刍：不吃草时头微抬、颌部水平慢摆（0.5 Hz、0.05 rad），夜里也会倒嚼
      a.head.rotation.x = a.kind === '牛'
        ? Math.sin(t * 0.5 + p * 0.7) * 0.05 * (1 - graze)
        : 0;
      // 羊低头时的侧向拉草（0.4 Hz、0.10 rad）
      if (a.kind === '羊') {
        a.head.rotation.y += Math.sin(t * 0.4 + p * 0.5) * 0.10 * graze;
      }
    }
  }

  return { root, pickables, sun, hemi, bounce, moon, skyUniforms, seasonUniform, glassMat: matGlass,
    weatherUniforms, weatherScene, lampLights, lampGlowMat: matLampGlow, updateWeather,
    yardAutumn, yardSummer,
    // 风场：草/作物/雨雪/旗面共用这一组 uniform，由 environment.js 每帧写入
    windUniforms, windTime, flagMesh, flagMounts,
    // 电线杆线：杆位、档距、导线段数（单位 m / 段）
    powerLine,
    // 生产性空间：16 条档案 / 4 个合批 Mesh / 场院占位圆（供 ?qa=1 与落位校验）
    production: PRODUCTION, productionMeshes: prodMeshes, prodFoots,
    // 公共核心：4 条新档案 / 5 个合批 Mesh / 建筑占位圆（供 ?qa=1 与落位校验）
    civic: CIVIC, civicMeshes, civicFoots,
    // 地形材质：三层混合材质本体 + 世界尺度 + 权重属性（供 main.js 调档位、?qa=1 与校验脚本读）
    terrainMat: ground.material, terrainMesh: ground, terrainGeo: groundGeo,
    terrainLayers: {
      grassTile: (EXT * 2) / gRepeat,
      soilTile: TERRAIN.SOIL_TILE,
      rockTile: TERRAIN.ROCK_TILE,
    },
    // 道路：三类路面合批成 1 个 Mesh（顶点数与各类条数供 ?qa=1 与 tools/verify-road.mjs 读）
    roadMesh, roadVerts, roadStats,
    // 树木：棵数 / 四种形态分布 / 干枝叶实例数 / 柳树垂枝段数（供 ?qa=1 与 verify-tree.mjs 读）
    treeStats,
    // 野性层：灌木 / 杂草株数、两组实例、淡出距离（供 ?qa=1 与 verify-scrub.mjs 读）
    scrub: scrubState,
    // 家畜微动作状态：17 只、避雨目标 wet、平滑因子 wetK（供 ?qa=1 与验收读取）
    livestock: animalState,
    // 旱作元素：田埂/地膜/篱笆合并 Mesh 与计数（供 ?qa=1 与验收读取）
    farm: farmState,
    // 教学视图：标注层 / 剖面开关与状态（相机机位由 main.js 保存恢复）
    teach: teachState,
    // 炊烟：chimneys 是烟囱口世界坐标，smoke.lit 是当前生火户数（自检用）
    chimneys, smoke: smokeState,
    cropMesh: cropMeshes[0] || null, cropMeshes, fieldState, cropSpec: CROP_SPEC,
    getCropCount: () => cropCount, updateCropGrowth, update, heightAt, walkHeightAt,
    // 河道自证接口：probe.mjs 沿河取样 / 截图脚本定位都走这里
    river: {
      ...RIVER, bridge: BRIDGE,
      centerX: riverCenterX,
      dist: (x, z) => Math.abs(x - riverCenterX(z)),
      bedAt: (z) => heightAt(riverCenterX(z), z),
      bankAt: (z) => rawHeight(riverCenterX(z), z),
      // 开河后实测的岸顶（d=half 处）：河床相对它的下切严格等于 depth
      bankEdgeAt: (z) => heightAt(riverCenterX(z) + RIVER.half, z),
      // 某点被河谷挖掉多少米（0 = 完全没受影响），落位检查直接用它
      cut: (x, z) => rawHeight(x, z) - riverHeight(x, z),
    },
    water: waterState, grassState };
}
