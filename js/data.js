/**
 * 村庄数据：布局 + 每个物体的档案
 * 村子是虚构的，但布局遵循西北河谷村落的真实规律：
 * 一条主路穿村，院落沿路两侧坐北朝南，村口有风水树，村外是梯田，河边有畜圈。
 */

/* 固定种子，保证每次打开布局一致 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261105);
const between = (a, b) => a + rnd() * (b - a);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

export const VILLAGE = {
  name: '柳树沟村',
  subtitle: '甘肃省定西市岷县 · 岷山北麓川地聚落',
  bounds: { half: 130 },
  season: '2025 年 11 月 · 初冬',
};

/* ---------------- 道路 ----------------
 * 三类路面，全部由 world.js 的 addRibbon() 推进同一组合批缓冲，最后只有 1 个
 * Mesh、1 个材质、1 个 draw call（v1.2 之前是主路 1 + 5 条巷道各 1 = 6）。
 *
 * 层级与宽度（单位 m，坐标为世界坐标，x 东 / z 南）：
 *   main   水泥主路：路面宽 ROAD.width = 6.2，两侧各再加 shoulder = 0.45 的路肩，
 *          路肩比路面低 0.035、土石色、粗糙度 0.98，是三类里唯一带路肩的。
 *   lane   土质巷道：宽 2.8~3.0，两侧各 0.18 的倒角压下去 0.03，不设路肩。
 *   ridge  田埂小路：宽 0.90，中间拱起 0.12（中心比田面高 0.28）、两侧顶点直接给草色没进草里。
 *
 * 抬升（相对 heightAt，单位 m）：主路 +0.080 / 巷道 +0.060 / 田埂边缘 +0.160、
 * 中心 +0.280。三档互不相等，且都高于耕地田面的 +0.050，靠 polygonOffset 压住，
 * 不会出现 z-fighting。数值口径见 CHANGELOG 的「三类路面参数表」。
 */
export const ROAD = {
  width: 6.2,
  shoulder: 0.45,      // 路肩宽，m；只在 main 上出现
  points: [
    [-2, -128], [-1, -86], [0, -40], [1, 4], [2, 52], [2.5, 96], [3, 128],
  ],
};

/* 土质巷道：a 端接主路中线附近，b 端伸进民居之间通到户门口。
 * w 为路面宽（m），不含 0.18 的倒角。5 条合计 91.1 m。 */
export const LANES = [
  { id: 'LN-1', a: [1, -46], b: [-17, -52], w: 3.0 },
  { id: 'LN-2', a: [1, -14], b: [17, -20], w: 3.0 },
  { id: 'LN-3', a: [2, 18], b: [-18, 24], w: 3.0 },
  { id: 'LN-4', a: [2, 62], b: [19, 68], w: 2.8 },
  { id: 'LN-5', a: [1, -78], b: [-14, -84], w: 2.8 },
];

/* 田埂小路：全部落在 |x| ≥ 40 的田区（民居在 |x| < 25、场院在 |x| ≈ 24~36），
 * 与民居、场院、设施、水窖、杆脚零冲突；最近障碍是树干，净空 0.37~6.23 m。
 * 5+4 横、2 纵，11 条合计 576.5 m；横向埂在纵向埂前 1.65 m 处收头，不交叉、
 * 不会在交汇处出现共面闪烁。w 为路面宽（m），统一 0.90。 */
export const RIDGES = [
  // 西侧田区的横向埂，沿相邻地块之间的 z 向缝隙走
  { id: 'RG-W1', a: [-96, -75.0], b: [-50, -75.0], w: 0.90 },
  { id: 'RG-W2', a: [-90, -28.5], b: [-50, -28.5], w: 0.90 },
  { id: 'RG-W3', a: [-86, 13.0], b: [-50, 13.0], w: 0.90 },
  { id: 'RG-W4', a: [-78, 54.0], b: [-40, 54.0], w: 0.90 },
  { id: 'RG-W5', a: [-88, 82.0], b: [-30, 82.0], w: 0.90 },
  // 西侧纵向主埂，把上面 5 条串起来
  { id: 'RG-WV', a: [-48, -78.0], b: [-48, 16.0], w: 0.90 },
  // 东侧田区
  { id: 'RG-E1', a: [42, -74.0], b: [74, -74.0], w: 0.90 },
  { id: 'RG-E2', a: [42.5, -29.5], b: [102, -29.5], w: 0.90 },
  { id: 'RG-E3', a: [34, 44.0], b: [69, 44.0], w: 0.90 },
  { id: 'RG-E4', a: [12, 84.0], b: [49, 84.0], w: 0.90 },
  { id: 'RG-EV', a: [40, -75.0], b: [40, 26.0], w: 0.90 },
];

/** 主路中线按 z 反查 x，单位 m。ROAD.points 的 z 单调递增，相邻两点线性插值；
 *  出界取端点。树木按区位分配树种、落位校验算路距都走这里。 */
export function roadX(z) {
  const p = ROAD.points;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    if (z >= a[1] && z <= b[1]) return a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]);
  }
  return z < p[0][1] ? p[0][0] : p[p.length - 1][0];
}

/* ---------------- 主路电线杆与架空线 ----------------
 * 全部长度单位 m，角度 rad，坐标为世界坐标（x 东 / z 南；与 climate.js 的
 * dirZ=+cosθ 一致，θ=0 北风吹向 +z 即南）。此前写成「z 北」是笔误。
 *
 * 位置：zs 是 8 根杆的世界 z，沿路等距 **34.0 m**（任务要求 30–40 m、8–12 根）。
 *       side/offset 决定横向位置：相对主路中线向**西**偏 4.4 m。
 *       这个偏距不是随手取的：路面半宽 3.1 m（边缘再毛 ±0.36 m），行道树落在
 *       ±7.5~10.5 m，4.4 m 正好在两者之间的路肩上，是全线唯一一条不与树冠打架的走廊。
 *
 * 高度：shaftTop 9.90 m（杆身顶），arm 9.95 m（横担中心），
 *       wireY 10.15 m（绝缘子顶 = 导线挂点）。比常规村线高，
 *       原因是行道树最高 16.9 m、冠底多在 6~8 m，8 m 杆挂的线会从树冠里穿过去。
 *
 * 导线：spread 是相邻两根导线的半间距（横担全长 1.7 m），
 *       sag 是档距中央的下垂量 0.62 m（任务要求 0.6–0.8 m），
 *       wireR 是导线管半径 0.028 m —— 比真实 10 kV 裸导线（约 0.017 m）略粗，
 *       否则第一人称近处只有几个像素、远处直接被抗锯齿吃掉，
 *       这就是任务里"线的粗细在近处不能消失"那一条。
 */
export const POWER_LINE = {
  zs: [-118, -84, -50, -16, 18, 52, 86, 120],
  side: -1,
  offset: 4.4,
  shaftTop: 9.90,
  arm: 9.95,
  armLen: 1.70,
  spread: 0.70,
  wireY: 10.15,
  sag: 0.62,
  wireR: 0.028,
  guy: 4.60,        // 两端拉线的水平投影长度，m
};

/* ---------------- 村西小河 ----------------
 * 近南北走向，端点严格落在 (-105,-130) → (-98,130)。中段用两个不同频率的正弦
 * 叠加做轻微摆动，外面乘 sin²(πt)：摆动在两端归零、导数也为 0，
 * 所以端点位置精确，接进/接出村子时不会出现折角，也不会笔直得像水渠。
 * 河槽半宽 half=6m 处回到岸顶，out=9m 之外完全是原地形；
 * 河床是恒定标高 -2.2m（沿河 5 点数值一致），常水位 -0.6m。
 */
export const RIVER = {
  x0: -105, z0: -130, x1: -98, z1: 130,
  half: 6,        // 到岸顶的半宽，m
  out: 9,         // 河谷影响半宽，之外完全是原地形，m
  depth: 2.2,     // 河床比两岸低，m
  water: 1.6,     // 水位比河床高，m
};
RIVER.bedY = -RIVER.depth;
RIVER.waterY = RIVER.bedY + RIVER.water;

/** 给定 z，返回河道中心线的 x（河道近南北，横向距离直接用 |x-cx(z)| 足够准） */
export function riverCenterX(z) {
  const t = Math.min(1, Math.max(0, (z - RIVER.z0) / (RIVER.z1 - RIVER.z0)));
  const env = Math.sin(Math.PI * t) ** 2;
  const wob = (3.4 * Math.sin(z * 0.019 + 0.7) + 1.5 * Math.sin(z * 0.047 - 0.4)) * env;
  return RIVER.x0 + (RIVER.x1 - RIVER.x0) * t + wob;
}

/* ---------------- 民居 ---------------- */
const SURNAME = ['张', '李', '王', '刘', '赵', '陈', '杨', '马'];
const STRUCT = ['砖木', '土木', '砖混'];
const ROOF = ['青瓦', '红瓦'];

/* ---------------- 户型档案数据（手写，不是现算） ----------------
 * 这 6 项是**卡片上显示的数**，与场景里的实例分开存放，再由 tools/verify-cards.mjs
 * 按 ownerId 从 FIELDS / ANIMAL_LIST 重新聚合后逐户比对 —— 这样改了某块地的亩数
 * 却忘了同步卡片，脚本会直接报错。若改成渲染时现算，两边永远相等，校验就成了空转。
 *
 * 单位：farmland 亩；livestock 头/只；income 万元/年。
 * 分配（尽量平均、且空置户不种地不养畜）：
 *   - H-09 空置：0 亩 0 畜；
 *   - 其余 13 户各 1 块地，多出的 1 块（L-14 梁上地）给人口最多的 H-06（6 口）；
 *   - 16 头生产畜按「当前最少者优先」分 13 户：3 户各 2 头、10 户各 1 头；
 *     另有 1 只看门狗（A-17，v1.2 微动作轮）归赵宅 H-05，不计养殖收入。
 * 两块菜地（L-05 / L-13）档案里写「各家自种」，这里按就近登记记在一户名下，
 * 只影响记账归属，不影响场景里那两块地的位置与作物。
 */
const HOUSE_CARDS = [
  { head: '张守业', farmland: 62, livestock: 2, cropMain: '当归',   income: 20.3 },
  { head: '李长顺', farmland: 48, livestock: 2, cropMain: '党参',   income: 13.9 },
  { head: '王秀兰', farmland: 55, livestock: 2, cropMain: '玉米',   income: 8.2 },
  { head: '刘德海', farmland: 34, livestock: 1, cropMain: '小麦',   income: 4.5 },
  { head: '赵建国', farmland: 8,  livestock: 2, cropMain: '蔬菜',   income: 1.7 },   // 第 2 头是看门狗，收入口径不计
  { head: '陈志强', farmland: 61, livestock: 1, cropMain: '小麦',   income: 8.4 },
  { head: '杨永福', farmland: 41, livestock: 1, cropMain: '当归',   income: 13.2 },
  { head: '马文贵', farmland: 52, livestock: 1, cropMain: '黄芪',   income: 13.6 },
  { head: '张万山', farmland: 0,  livestock: 0, cropMain: '—',      income: 0 },
  { head: '李秀英', farmland: 33, livestock: 1, cropMain: '马铃薯', income: 5.4 },
  { head: '王海军', farmland: 37, livestock: 1, cropMain: '玉米',   income: 5.3 },
  { head: '刘全福', farmland: 44, livestock: 1, cropMain: '党参',   income: 12.3 },
  { head: '赵玉梅', farmland: 29, livestock: 1, cropMain: '柴胡',   income: 7.0 },
  { head: '陈国栋', farmland: 9,  livestock: 1, cropMain: '蔬菜',   income: 1.8 },
];

/* 年收入估算口径（元）：
 *   种植 = Σ(该户地块亩数 × 亩均净收益)；养殖 = Σ(牲畜头数 × 单头年净收益)。
 * 亩均净收益按岷县药材/粮食的常见量级取，只用于演示，不是统计数据。 */
export const INCOME_RATES = {
  crop: { 当归: 3200, 党参: 2800, 黄芪: 2600, 柴胡: 2400, 马铃薯: 1600, 蔬菜: 2000, 玉米: 1400, 小麦: 1200 },
  animal: { 牛: 4500, 羊: 800, 鸡: 60, 狗: 0 },   // 狗是看门狗，不进养殖收入口径
};

/**
 * 按作物亩数与牲畜头数估算年收入。
 * 单位：返回「万元/年」，保留 1 位小数。
 * 数据层与校验脚本共用这一个函数，保证口径只有一处。
 */
export function estimateIncome(fields, animals) {
  let yuan = 0;
  for (const f of fields) yuan += f.area * (INCOME_RATES.crop[f.crop] ?? 0);
  for (const a of animals) yuan += INCOME_RATES.animal[a.kind] ?? 0;
  // 元 → 万元，保留 1 位小数（与卡片上显示的口径一致）
  return Math.round(yuan / 1000) / 10;
}

export const HOUSES = [];
for (let i = 0; i < 14; i++) {
  const side = i % 2 === 0 ? -1 : 1;         // 左 / 右
  const idx = Math.floor(i / 2);
  const z = -78 + idx * 23 + between(-2.5, 2.5);
  const x = side * (16 + between(-1.2, 1.8));
  const built = Math.round(between(1986, 2018));
  const residents = Math.round(between(0, 6));
  const area = Math.round(between(88, 168));

  HOUSES.push({
    id: `H-${String(i + 1).padStart(2, '0')}`,
    type: 'house',
    name: `${SURNAME[i % SURNAME.length]}宅`,
    pos: [x, 0, z],
    rot: side * between(-0.05, 0.05),
    door: `${idx + 1} 号`,
    side,
    area,
    structure: pick(STRUCT),
    built,
    roof: pick(ROOF),
    residents,
    vacant: residents === 0,
    yard: { w: between(12.5, 15.5), d: between(16, 20) },
    hasWall: rnd() > 0.25,
    note: residents === 0 ? '长期空置，亲属代管' : `${residents} 口人常年居住`,
    ...HOUSE_CARDS[i],
  });
}

/* ---------------- 树木 ---------------- */
export const SPECIES = [
  { kind: '杨树', h: [11, 17], c: [4.2, 6.8], dbh: [38, 62], leaf: [128, 112, 62] },
  { kind: '柳树', h: [8, 13], c: [5.0, 7.6], dbh: [32, 55], leaf: [140, 126, 74] },
  { kind: '杏树', h: [4.5, 7.5], c: [3.4, 5.2], dbh: [18, 30], leaf: [150, 114, 66] },
  { kind: '槐树', h: [9, 14], c: [5.6, 8.2], dbh: [34, 58], leaf: [112, 98, 58] },
  { kind: '榆树', h: [8, 13], c: [4.6, 7.0], dbh: [30, 52], leaf: [122, 106, 60] },
];

/** 按区位分配树种（纯函数，**不消耗随机数**）。
 *  规则：河边以柳为主、主路行道以杨为主、院落周边槐榆为主。
 *  为什么不在这里取随机数：树的坐标、民居、场院、作物全都串在同一条全局随机
 *  序列上，这里多取一个就会把后面所有布局整体推移。seq 用树序号，同一区位内
 *  也有个体变化，且完全可复现。 */
function pickSpeciesFor(x, z, seq) {
  const dRiver = Math.abs(x - riverCenterX(z));
  const dRoad = Math.abs(x - roadX(z));
  if (dRiver < 26) {
    // 河边：柳为主，每 6 棵留 1 棵杨（河滩上杨树也常见）
    return seq % 6 === 0 ? SPECIES[0] : SPECIES[1];
  }
  if (dRoad < 14) {
    // 主路行道：杨 70% / 榆 20% / 槐 10%
    const m = seq % 10;
    return m < 7 ? SPECIES[0] : m < 9 ? SPECIES[4] : SPECIES[3];
  }
  // 院落周边：槐 40% / 榆 40% / 杏 10% / 杨 10%
  const m = seq % 10;
  return m < 4 ? SPECIES[3] : m < 8 ? SPECIES[4] : m < 9 ? SPECIES[2] : SPECIES[0];
}

export const TREES = [];
let treeSeq = 0;
function addTree(x, z, opts = {}) {
  // 与原来 pick(SPECIES) 消耗的 1 次随机数对齐：树种改成按区位确定性分配之后，
  // 这里仍取一次并丢弃，保证后面民居 / 场院 / 作物的随机序列一个元素都不动。
  const sp = opts.species || (rnd(), pickSpeciesFor(x, z, treeSeq + 1));
  const h = opts.height || between(sp.h[0], sp.h[1]);
  const c = opts.canopy || between(sp.c[0], sp.c[1]);
  const dbh = opts.dbh || Math.round(between(sp.dbh[0], sp.dbh[1]));
  treeSeq++;
  const health = rnd() > 0.9 ? '一般' : rnd() > 0.96 ? '较差' : '良好';

  TREES.push({
    id: `T-${String(treeSeq).padStart(3, '0')}`,
    type: 'tree',
    name: opts.name || `${sp.kind}（${String(treeSeq).padStart(3, '0')}）`,
    kind: sp.kind,
    pos: [x, 0, z],
    height: +h.toFixed(1),
    canopy: +c.toFixed(1),
    dbh,
    age: Math.round(dbh / 1.5 + between(-3, 4)),
    leaf: sp.leaf,
    health,
    lastPrune: rnd() > 0.7 ? `2025-${String(Math.ceil(between(10, 12))).padStart(2, '0')}-${String(Math.ceil(between(1, 28))).padStart(2, '0')}` : '近三年未修剪',
    note: opts.note || '',
  });
  return TREES[TREES.length - 1];
}

/* 村口两棵大树，是村子的地标 */
addTree(-7.5, -104, { species: SPECIES[0], height: 16.8, canopy: 7.4, dbh: 64, name: '村口老杨树', note: '村口地标，树下有石墩，夏天村人乘凉' });
addTree(8.2, -101, { species: SPECIES[3], height: 13.4, canopy: 7.0, dbh: 58, name: '村口老槐', note: '树下曾挂铁钟，旧时召集村民所用' });

/* 沿主路两侧行道树 */
for (let z = -86; z <= 106; z += 9.5) {
  for (const side of [-1, 1]) {
    if (rnd() > 0.72) continue;
    const x = side * between(7.5, 10.5);
    addTree(x, z + between(-2, 2));
  }
}

/* 院落周边散树 */
for (const h of HOUSES) {
  const n = Math.round(between(2, 4));
  for (let k = 0; k < n; k++) {
    const x = h.pos[0] + (h.side * -1) * between(5, 12) * (rnd() > 0.5 ? 1 : -1);
    const z = h.pos[2] + between(-10, 10);
    if (Math.abs(x) < 6) continue;
    addTree(x, z);
  }
}

/* 村外成片林带 */
for (let i = 0; i < 44; i++) {
  let x = between(-118, 118);
  const z = between(-124, 124);
  if (Math.abs(x) < 14) continue;
  if (Math.abs(x) < 36 && Math.abs(z) < 92) continue;
  // 河道避让：随机撒点原本有两棵树正落在河心和岸坡上，树根会泡进水里。
  // 只把 x 推到东岸以外，不额外消耗随机数，后面的布局与既有编号全部保持不变。
  const c = riverCenterX(z), safe = RIVER.out + 3;
  if (Math.abs(x - c) < safe) x = c + safe + (x - (c - safe)) * 0.22;
  addTree(x, z);
}

/* 山神庙旁边的老槐：树龄比庙前的台阶还长，村里人说建庙前就有它 */
addTree(147, 28, {
  species: SPECIES[3], height: 12.6, canopy: 6.6, dbh: 52,
  name: '庙前老槐',
  note: '长在庙东侧的坡上，树冠搭着庙檐；树干朝下坡一侧歪，是常年被山风吹的',
});

/* 河岸柳：岷县河滩上的风柳，沿东岸成排。
 * 坐标 = riverCenterX(z) + 10.5 m（河岸 out = 9 m 之外，不泡在水里），
 * 与既有树最小间距 5.9 m，全部避开耕地。height/canopy 走柳树区间，
 * 个体差异由随机数给出；这里已经排在所有既有树之后，不影响任何既有随机序列。 */
const RIVER_WILLOWS = [
  { z: -105, name: '河湾老柳', note: '河湾拐角处，树根一半露在岸坡上，夏天牛羊在树荫下饮水' },
  { z: -72, name: '河滩柳', note: '河滩上独一棵，枝条垂到水面，村里人叫它「水帘柳」' },
  { z: -40, name: '水磨柳', note: '旧水磨坊上游，磨坊拆了以后只剩这棵柳' },
  { z: -8, name: '桥头柳', note: '漫水桥东桥头，过桥的人都在它下面歇脚' },
  { z: 16, name: '河沿柳', note: '河沿地界上，树冠歪向水面，是常年西风推的' },
  { z: 68, name: '下河柳', note: '下游河滩，全村最矮的一棵柳，年年被洪水冲、年年又发新枝' },
];
for (const w of RIVER_WILLOWS) {
  addTree(riverCenterX(w.z) + 10.5, w.z, { species: SPECIES[1], name: w.name, note: w.note });
}

/* ---------------- 家畜 ---------------- */
const ANIMALS = [];
const HERD = [
  { kind: '牛', breed: '秦川牛', weight: [380, 560], months: [18, 60], n: 4 },
  { kind: '羊', breed: '小尾寒羊', weight: [38, 72], months: [8, 34], n: 6 },
  { kind: '鸡', breed: '当地土鸡', weight: [1.6, 2.8], months: [4, 16], n: 6 },
];
let anSeq = 0;
for (const herd of HERD) {
  for (let i = 0; i < herd.n; i++) {
    anSeq++;
    const isBird = herd.kind === '鸡';
    const x = isBird ? between(-30, 30) : between(38, 62);
    const z = isBird ? between(-40, 60) : between(14, 62);
    ANIMALS.push({
      id: `A-${String(anSeq).padStart(2, '0')}`,
      type: 'animal',
      kind: herd.kind,
      name: `${herd.breed} ${String(i + 1).padStart(2, '0')} 号`,
      pos: [x, 0, z],
      earTag: `${herd.kind === '鸡' ? '禽' : '甘D'}-${2100 + anSeq * 7}`,
      breed: herd.breed,
      months: Math.round(between(herd.months[0], herd.months[1])),
      weight: +between(herd.weight[0], herd.weight[1]).toFixed(1),
      vaccine: `口蹄疫 / 小反刍 2026-${String(Math.ceil(between(3, 9))).padStart(2, '0')}`,
      owner: `${SURNAME[anSeq % SURNAME.length]}姓`,
      status: rnd() > 0.88 ? '需观察' : '健康',
      note: '',
    });
  }
}
export const ANIMAL_LIST = ANIMALS;

/* 看门狗（v1.2 牲畜微动作轮追加，A-17）：
 * - 唯一一头「非生产」牲畜：INCOME_RATES.animal.狗 = 0，不进任何收入口径；
 * - 落位从 HOUSES[4]（赵宅 H-05）推导：大门旁、面向巷道卧着，单位 m；
 * - 字段全部写死，不调用 between/rnd——全局随机序列一bit都不动，
 *   其后生成的公共设施等随机细节与上一版逐位一致（同任务 05 treeRng 的教训）。 */
{
  const h = HOUSES[4];   // H-05 赵宅：side = -1，大门朝村中巷道（+x 方向）
  ANIMALS.push({
    id: 'A-17', type: 'animal', kind: '狗',
    name: '中华田园犬 · 大黄',
    pos: [h.pos[0] + h.yard.w * 0.5 + 1.3, 0, h.pos[2] + 5],
    earTag: '犬-2026', breed: '中华田园犬', months: 30, weight: 18.5,
    vaccine: '狂犬 / 犬瘟热 2026-04',
    ownerId: 'H-05', owner: '赵宅（3 号）',
    status: '健康',
    note: '白天卧在赵宅大门旁看家，雨雪天挪到屋檐底下。生人进巷会抬头，熟人老远尾巴就摇起来。',
  });
}

/* 牲畜归属：按「当前最少者优先」把 17 头分给 13 户在住户（空置的 H-09 不养畜），
 * 16 头生产畜 3 户各 2 头、10 户各 1 头；看门狗 A-17 单独记在赵宅 H-05 名下
 * （4 户各 2 头、9 户各 1 头）。顺序显式写死，方便和卡片上的「牲畜数量」逐户对照。
 * 原来家畜的 owner 只是一个随机姓氏（"李姓"），与任何一户都对不上，也没法聚合。 */
const ANIMAL_OWNERS = [
  'H-01', 'H-02', 'H-03', 'H-04', 'H-05', 'H-06', 'H-07', 'H-08',
  'H-10', 'H-11', 'H-12', 'H-13', 'H-14', 'H-01', 'H-02', 'H-03',
  'H-05',
];
{
  const houseById = new Map(HOUSES.map((h) => [h.id, h]));
  ANIMALS.forEach((a, i) => {
    const h = houseById.get(ANIMAL_OWNERS[i]);
    a.ownerId = h.id;
    a.owner = `${h.name}（${h.door}）`;
  });
}

/* ---------------- 公共设施 ---------------- */
export const FACILITIES = [
  { id: 'F-01', type: 'facility', kind: 'well', name: '村中老井',
    pos: [-4, 0, 6], built: 1972, depth: 18.4, waterLevel: 11.2,
    use: '生活取水（备用）', status: '可用', note: '井台为整石凿成，井绳痕深' },

  { id: 'F-02', type: 'facility', kind: 'committee', name: '村委会',
    pos: [26, 0, -6], built: 2008, area: 186, structure: '砖混',
    use: '村务办公', status: '在用', note: '二层，院内有一根旗杆，门前新立了村务公示栏',
    /* 全村口径（v1.2 公共核心）：卡片上写死，由 tools/verify-cards.mjs 从
     * HOUSES.residents / FIELDS.area 重新聚合并逐项比对，口径与任务 03 一致。
     * 43 人 = Σ 14 户常住人口；513 亩 = Σ 14 块耕地面积。单位：人 / 亩。 */
    population: 43, farmlandTotal: 513 },

  { id: 'F-03', type: 'facility', kind: 'barn', name: '东头畜圈',
    pos: [46, 0, 34], built: 2014, area: 240, structure: '轻钢',
    use: '集中养殖', status: '在用', note: '存栏牛 4 头、羊 6 只' },

  { id: 'F-04', type: 'facility', kind: 'yard', name: '晒场',
    pos: [-34, 0, 30], built: 1996, area: 420, structure: '水泥',
    use: '晾晒药材与粮食', status: '在用', note: '秋收后晒当归、党参' },

  { id: 'F-05', type: 'facility', kind: 'mill', name: '水磨坊',
    pos: [-88, 0, 62], built: 1965, area: 48, structure: '土木',
    use: '粮食加工（已停用）', status: '闲置', note: '临河西岸，水轮残缺，仅存石磨' },

  { id: 'F-06', type: 'facility', kind: 'plaza', name: '村口广场',
    pos: [2, 0, -92], built: 2019, area: 560, structure: '水泥',
    use: '集会、健身', status: '在用', note: '装有两盏太阳能路灯' },

  /* 主路太阳能路灯：夜里会亮，点击可查档案 */
  { id: 'F-07', type: 'facility', kind: 'streetlight', name: '1 号路灯',
    pos: [-5.4, 0, -70], built: 2019, structure: '热镀锌钢杆 + 单晶硅板',
    use: '主路夜间照明', status: '在用', note: '30W LED，光控 + 时控，天黑自动点亮' },
  { id: 'F-08', type: 'facility', kind: 'streetlight', name: '2 号路灯',
    pos: [5.4, 0, -30], built: 2019, structure: '热镀锌钢杆 + 单晶硅板',
    use: '主路夜间照明', status: '在用', note: '30W LED，光控 + 时控，天黑自动点亮' },
  { id: 'F-09', type: 'facility', kind: 'streetlight', name: '3 号路灯',
    pos: [-5.4, 0, 10], built: 2019, structure: '热镀锌钢杆 + 单晶硅板',
    use: '主路夜间照明', status: '在用', note: '30W LED，光控 + 时控，天黑自动点亮' },
  { id: 'F-10', type: 'facility', kind: 'streetlight', name: '4 号路灯',
    pos: [5.4, 0, 50], built: 2021, structure: '热镀锌钢杆 + 单晶硅板',
    use: '主路夜间照明', status: '在用', note: '后期补装，蓄电池 2024 年更换' },
  { id: 'F-11', type: 'facility', kind: 'streetlight', name: '5 号路灯',
    pos: [-5.4, 0, 90], built: 2021, structure: '热镀锌钢杆 + 单晶硅板',
    use: '主路夜间照明', status: '在用', note: '后期补装，蓄电池 2024 年更换' },
  { id: 'F-12', type: 'facility', kind: 'streetlight', name: '6 号路灯',
    pos: [5.4, 0, -88], built: 2019, structure: '热镀锌钢杆 + 单晶硅板',
    use: '村口广场夜间照明', status: '在用', note: '与广场同期建设，灯杆略高' },

  { id: 'F-13', type: 'facility', kind: 'signboard', name: '村务宣传栏',
    pos: [-9.5, 0, -88], built: 2019, structure: '钢架 + 铝塑板',
    use: '政策宣传、药材收购信息', status: '在用', note: '每月更新一次，秋收季张贴药材收购价' },
];

/* ---------------- 地块 ----------------
 * 河西四块地原先都压进新开的河谷里。田面是刚性平面（按中心高度摆放），
 * 河谷一挖就会有几米悬空，所以西缘统一东缩到岸顶以东：
 * L-01 / L-09 是落位检查查出来的，L-06「河滩地」是本次点名要改的，
 * L-07 只擦到过渡带（下切已归零），保持不动。 */
export const FIELDS = [
  { id: 'L-01', ownerId: 'H-01', type: 'field', name: '东坡梯田', crop: '当归', area: 62, pos: [-70, 0, -52], size: [42, 40], rot: 0.12, stage: '已采收', note: '岷县当归道地产区核心田块，10 月下旬采挖；7 月抽薹开伞形白花，旁边留了半分种田' },
  { id: 'L-02', ownerId: 'H-02', type: 'field', name: '南川地', crop: '党参', area: 48, pos: [-64, 0, 34], size: [46, 34], rot: -0.06, stage: '根膨大末期', note: '预计 11 月中旬采挖' },
  { id: 'L-03', ownerId: 'H-03', type: 'field', name: '西梁地', crop: '玉米', area: 55, pos: [66, 0, -52], size: [50, 38], rot: -0.18, stage: '已收', note: '旱作雨养，玉米株高过人，秋分前后掰棒子' },
  { id: 'L-04', ownerId: 'H-04', type: 'field', name: '北湾地', crop: '小麦', area: 34, pos: [70, 0, 66], size: [40, 30], rot: 0.2, stage: '已收', note: '春小麦，3 月中旬播、7 月上旬收，收后秋翻' },
  { id: 'L-05', ownerId: 'H-05', type: 'field', name: '门前菜地', crop: '蔬菜', area: 8, pos: [-16, 0, 78], size: [22, 16], rot: 0.05, stage: '收尾', note: '各家自种，白菜萝卜为主' },
  { id: 'L-06', ownerId: 'H-06', type: 'field', name: '河滩地', crop: '马铃薯', area: 26, pos: [-76, 0, 96], size: [20, 24], rot: -0.1, stage: '已收', note: '东岸沙壤土，薯形好' },
  { id: 'L-07', ownerId: 'H-07', type: 'field', name: '下川地', crop: '当归', area: 41, pos: [-78, 0, -92], size: [36, 28], rot: 0.08, stage: '已采收', note: '村南主产田，当归道地产区；二年生留种，7 月开伞形白花' },
  { id: 'L-08', ownerId: 'H-08', type: 'field', name: '东塬地', crop: '黄芪', area: 52, pos: [52, 0, -92], size: [42, 30], rot: -0.14, stage: '已采收', note: '坡地，排水好' },
  { id: 'L-09', ownerId: 'H-10', type: 'field', name: '西沟地', crop: '马铃薯', area: 33, pos: [-66, 0, -8], size: [32, 34], rot: 0.16, stage: '已收', note: '二年轮作，防土传病害' },
  { id: 'L-10', ownerId: 'H-11', type: 'field', name: '中腰地', crop: '玉米', area: 37, pos: [52, 0, 12], size: [34, 28], rot: -0.05, stage: '已收', note: '水浇条件好，玉米长到两米多，田埂边套种豆角' },
  { id: 'L-11', ownerId: 'H-12', type: 'field', name: '陈家湾', crop: '党参', area: 44, pos: [-52, 0, 62], size: [40, 32], rot: 0.1, stage: '根膨大末期', note: '11 月中旬采挖' },
  { id: 'L-12', ownerId: 'H-13', type: 'field', name: '北坡地', crop: '柴胡', area: 29, pos: [30, 0, 92], size: [36, 26], rot: 0.22, stage: '越冬准备', note: '阴坡，墒情好' },
  { id: 'L-13', ownerId: 'H-14', type: 'field', name: '门前园子', crop: '蔬菜', area: 9, pos: [-12, 0, 104], size: [44, 30], rot: 0.04, stage: '收尾', note: '各家自种白菜、萝卜' },
  { id: 'L-14', ownerId: 'H-06', type: 'field', name: '梁上地', crop: '小麦', area: 35, pos: [86, 0, -14], size: [30, 24], rot: -0.2, stage: '已收', note: '新垦地土层薄，种一季春小麦倒茬' },
];

/* ---------------- 院内生活物件 ----------------
 * 跟随所属民居的局部坐标，避免与主路、院墙、院门穿插。
 * 前院可用区：x∈[-w/2, w/2]、z∈[3.6, d/2-1.6]；院门在 x≈-4、z≈d/2-1.6。
 * 侧院可用区：|x|∈[5.0, w/2]，z∈[-3, 3]。 */
export const YARD_DETAILS = [];
function addYard(houseIdx, kind, name, local, info) {
  const h = HOUSES[houseIdx];
  YARD_DETAILS.push({
    id: `Y-${String(YARD_DETAILS.length + 1).padStart(2, '0')}`,
    type: 'yarditem', kind, name,
    houseId: h.id, local, owner: `${h.name}（${h.door}）`,
    ...info,
  });
}

addYard(0, 'drying', '张家晾晒架', [3.0, 5.3], {
  category: '晾晒架', use: '晾晒当归、党参', contents: '秋收药材 / 夏季辣椒',
  season: '全年（挂晒物随时令更换）', structure: '竹木', status: '在用',
  note: '竹竿搭成，秋收后铺满药材，夏天改挂辣椒串',
});
addYard(0, 'woodpile', '张家柴垛', [5.6, -1.2], {
  category: '柴垛', use: '做饭、取暖备柴', contents: '劈柴约 2 立方',
  season: '常年', structure: '果木/杨木', status: '在用',
  note: '码在东墙根，上覆旧塑料布防雨',
});
addYard(2, 'waterjar', '李家水缸', [1.6, 5.4], {
  category: '水缸', use: '储水、浇院中菜畦', contents: '容量约 0.6 立方',
  season: '常年', structure: '陶缸', status: '在用',
  note: '自来水入户后留作备用，冬天缸口包草防冻',
});
addYard(2, 'cart', '李家架子车', [-5.6, -1.0], {
  category: '农具', use: '拉运药材、土肥', contents: '架子车一辆',
  season: '常年', structure: '木车板 + 橡胶轮', status: '在用',
  note: '车轮为后期改装，车帮有修补痕迹',
});
addYard(5, 'drying', '刘家晾晒架', [2.8, 5.6], {
  category: '晾晒架', use: '晾晒黄芪片', contents: '秋收药材 / 夏季辣椒',
  season: '全年（挂晒物随时令更换）', structure: '竹木', status: '在用',
  note: '靠南墙，日照时间最长',
});
addYard(5, 'grain', '刘家粮囤', [-5.6, 2.4], {
  category: '粮囤', use: '存放马铃薯、小麦', contents: '约 1.5 吨',
  season: '秋收入囤，春夏见底', structure: '荆条编囤抹泥', status: '在用',
  note: '囤底垫石块防潮，顶上盖草苫',
});
addYard(9, 'woodpile', '赵家柴垛', [-5.6, -1.4], {
  category: '柴垛', use: '做饭、取暖备柴', contents: '劈柴约 1.5 立方',
  season: '常年', structure: '果木/杨木', status: '在用',
  note: '贴西墙码放，垛顶压旧瓦防风吹',
});
addYard(11, 'waterjar', '马家水缸', [-1.4, 5.2], {
  category: '水缸', use: '储水、和泥、饮畜', contents: '容量约 0.5 立方',
  season: '常年', structure: '陶缸', status: '在用',
  note: '缸沿磨得发亮，用了三十多年',
});
addYard(12, 'cart', '陈家架子车', [5.6, 1.0], {
  category: '农具', use: '拉运药材、土肥', contents: '架子车一辆',
  season: '常年', structure: '木车板 + 橡胶轮', status: '闲置',
  note: '长期空置户，车胎已瘪',
});

/* ---------------- 村口树下：石墩、石碾 ----------------
 * 村口老杨树 (-7.5,-104)、老槐 (8.2,-101) 的档案里写着「树下有石墩，夏天村人乘凉」
 * 和「树下曾挂铁钟」，这次把石墩与石碾补进场景。石墩位置按树冠投影下 2.2~2.9m
 * 摆成不规则一圈，避开东侧主路；每只坐高、歪斜、磨损都不同，档案逐只记。
 */
export const STONES = [
  { id: 'D-01', type: 'stone', name: '村口石墩 · 一', pos: [-7.77, -101.46],
    radius: 0.32, seatHeight: 0.46, rotY: 0.35,
    era: '清末', craft: '整石凿制，八棱，坐面微凹',
    original: 8, remain: 5, condition: '座面磨得发亮，棱角尚全', owner: '村集体',
    note: '清末凿制，原有一套八只，围着老杨树摆一圈。现存五只，另外三只 1958 年修渠时挪去垫桥，后来没找回来。' },

  { id: 'D-02', type: 'stone', name: '村口石墩 · 二', pos: [-9.87, -102.52],
    radius: 0.30, seatHeight: 0.42, rotY: 1.85,
    era: '清末', craft: '整石凿制，八棱，坐面微凹',
    original: 8, remain: 5, condition: '西侧崩了一角，用水泥补过', owner: '村集体',
    note: '比旁边几只矮半指，老人说原来就是给娃娃坐的。崩角是 1974 年拖拉机倒车撞的，补的水泥已经磨圆。' },

  { id: 'D-03', type: 'stone', name: '村口石墩 · 三', pos: [-9.76, -104.96],
    radius: 0.34, seatHeight: 0.50, rotY: 0.95,
    era: '清末', craft: '整石凿制，八棱，坐面微凹',
    original: 8, remain: 5, condition: '最高的一只，底下垫了半块青砖', owner: '村集体',
    note: '五只里最高的一只，坐着要踮脚。树根把地面顶得不平，底下垫了半块青砖找平，砖已经陷进土里。' },

  { id: 'D-04', type: 'stone', name: '村口石墩 · 四', pos: [-8.05, -106.59],
    radius: 0.31, seatHeight: 0.44, rotY: 2.60,
    era: '清末', craft: '整石凿制，八棱，坐面微凹',
    original: 8, remain: 5, condition: '北面凿痕清晰，坐面有一道细裂纹', owner: '村集体',
    note: '北面朝着河风，凿痕没被衣裳磨掉，还看得清錾子走过的路子。坐面那道裂纹是冻裂的，不影响坐。' },

  { id: 'D-05', type: 'stone', name: '村口石墩 · 五', pos: [-5.53, -105.28],
    radius: 0.33, seatHeight: 0.48, rotY: 4.10,
    era: '清末', craft: '整石凿制，八棱，坐面微凹',
    original: 8, remain: 5, condition: '被挪过两次，棱线略歪', owner: '村集体',
    note: '离主路最近的一只。修广场时挪过两回，棱线已经和另外几只对不齐；夏天傍晚坐这儿的人最多。' },
];

export const MILLSTONE = {
  id: 'N-01', type: 'millstone', name: '村口石碾', pos: [10.45, -100.35],
  era: '清末', disc: 2.4, roller: '直径 0.72 m，长 1.35 m', weight: 320,
  use: '碾谷、碾药、压苇篾', condition: '碾盘边缘磨出 2~3 cm 凹槽，碾磙一端崩角',
  owner: '村集体',
  note: '清末凿制。1958 年大炼钢铁时，碾磙被卸下来想砸碎炼铁，村里老人拦下，只崩了一个角；木架 1976 年换过一次，2019 年又换了推杆。',
};

/* ---------------- 水窖 ----------------
 * 陇中缺水，院里院外都有水窖：地面留一个内凹圆口，铸铁盖加锁，
 * 旁边支简易辘轳架。三处都选在院墙外 1.9~4.4m 的空地，避开树、田与主路。
 */
export const CISTERNS = [
  { id: 'W-01', type: 'cistern', name: '村南水窖', pos: [-24, -66],
    depth: 8.6, capacity: 24, cover: '铸铁盖，加铁锁', use: '集蓄雨水，供人畜饮用',
    condition: '在用，窖台水泥抹面', owner: '王宅（3 号）',
    note: '窖口比院子低半尺，雨水从场院经沉淀池流进来。旱年这一窖能撑到第二年开春，窖绳磨断过两回。' },

  { id: 'W-02', type: 'cistern', name: '村东水窖', pos: [26, -24],
    depth: 7.8, capacity: 19, cover: '铸铁盖，盖沿压砖', use: '集蓄雨水，浇院中菜畦',
    condition: '在用，窖口加过滤网', owner: '陈宅（6 号）',
    note: '窖口加了铁丝过滤网，防树叶和麻雀掉进去。盖沿那两块砖是压风用的，刮白毛风时盖子不会响。' },

  { id: 'W-03', type: 'cistern', name: '村北水窖', pos: [-24, 48],
    depth: 9.2, capacity: 27, cover: '铸铁盖，加锁', use: '集蓄雨水，旱季备用',
    condition: '在用，辘轳绳 2024 年换过', owner: '王宅（11 号）',
    note: '三处里最深的一口，窖壁用红黏土捶过。辘轳绳 2024 年换成尼龙绳，木轴还是老的，转起来吱呀响。' },
];

/* ---------------- 旗杆与旗面 ----------------
 * 两根旗杆在 v1.1 就已经立着（村委会院内、村口广场东侧），但只有杆、没有旗布。
 * 旗面几何在 world.js 里合成一个 Mesh（两面旗只占 1 个 draw call）；
 * 这里只提供档案内容与落位锚点 mount —— 世界坐标由 world.js 按 mount 从杆上换算，
 * 避免把杆位在两处各写一遍、改一处忘一处。
 */
export const FLAGS = [
  {
    id: 'G-01', type: 'flag', name: '村口广场旗',
    mount: 'plaza',
    location: '村口广场东侧', poleHeight: 9.0,
    cloth: [1.80, 1.20],              // 旗面 长 × 高，m
    fabric: '涤纶素布，四边双层包边', color: '靛蓝',
    raised: 2019, owner: '柳树沟村', use: '集会、节庆',
    status: '在用',
    note: '广场铺水泥那年一起立的杆，杆底那圈混凝土墩是后来补的——原先直接埋土里，2019 年冬天冻涨，杆歪过一次。旗面一年换一面；起白毛风的年份，秋天就得换。',
  },
  {
    id: 'G-02', type: 'flag', name: '村委会院内旗',
    mount: 'committee',
    location: '村委会院内南侧', poleHeight: 9.5,
    cloth: [1.44, 0.96],
    fabric: '涤纶素布，四边双层包边', color: '靛蓝',
    raised: 2008, owner: '柳树沟村村委会', use: '村务活动',
    status: '在用',
    note: '杆比广场那根高半米，是当年按"院里的杆要高过屋脊"专门定的——不然旗布会蹭到屋面。杆顶的滑轮换过两回，绳子还是老式的麻绳。',
  },
];

/* ---------------- 生产性空间（院外场院） ----------------
 * 六类、共 16 个可点对象，编号 P-01 ~ P-16。全部是静态物件，不随时间轴变化。
 *
 * 单位口径（代码注释与 CHANGELOG 各写一份，改数值时两处一起改）：
 *   - pos：世界坐标 [x, y, z]，m，y 恒为 0（实际标高由 world.js 的 heightAt() 取地形）。
 *   - radius：落位校验用的水平占位半径，m（圆盘半径或长方体半对角线，含边石/锥顶外挑）。
 *   - 麦场：圆盘半径 3.60 m（⌀7.20 m）、面厚 0.06 m；16 块边石，
 *           每块 0.24 × 0.18 × 0.40 m（宽 × 高 × 长），石心落在半径 3.45 m 上。
 *   - 草垛：圆台底半径 1.10 m / 顶半径 0.75 m、高 1.60 m，上加锥顶高 0.70 m，通高 2.30 m。
 *   - 柴垛：2.40 × 1.20 × 1.30 m（长 × 宽 × 高），5 层码放，顶覆旧篷布。
 *   - 粪堆：底半径 1.60 m、高 0.90 m 缓坡堆。
 *   - 鸡窝：1.60 × 1.20 × 1.10 m，贴院墙外侧。
 *   - 猪圈：3.20 × 2.60 m 围栏、栏高 0.95 m，贴院墙外侧。
 *
 * 分布：13 户在住户编成 6 处共享场院（5 处 × 2 户 + 1 处 × 3 户），
 *       H-09 长期空置（卡片 0 亩 0 畜）不设场院。场院一律在院外背街一侧
 *       |x| = 29 ~ 31 m：主路中线半宽 3.10 m，行道树在 |x| = 7.5 ~ 10.5 m，
 *       院墙外缘约 |x| = 23 ~ 24 m，耕地内缘最近约 |x| = 35 m —— 只这一条走廊可用。
 *       落位由 tools/verify-production.mjs 逐项复核：旋转矩形耕地、院墙、设施、
 *       水窖、树干、主路走廊、电线杆脚、彼此间距，任一项不过即退出码 1。
 * 鸡窝/猪圈按所属民居的院墙局部坐标 + 该户 rot 换算成世界坐标贴墙摆放，
 *       局部 z 取负值（后院半侧），避开院门（门在 z = d/2 - 1.6 的前墙上）。
 */
export const PRODUCTION = [
  { id: 'P-01', type: 'production', kind: 'floor', category: '麦场', name: '西头共用麦场',
    pos: [-31.00, 0, -67.23], radius: 3.60, yardId: 'Y1', sharedBy: ['H-01', 'H-03'],
    scope: '张宅（1 号）、王宅（2 号）共用', size: '⌀7.2 m',
    use: '小麦脱粒、药材晾晒', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '村西最早的一处场面，两家合着碾，边石是 1983 年从河滩拉上来的。秋收时先摊当归，麦收那几天才轮到小麦。' },

  { id: 'P-02', type: 'production', kind: 'floor', category: '麦场', name: '西腰共用麦场',
    pos: [-31.00, 0, -22.66], radius: 3.60, yardId: 'Y2', sharedBy: ['H-05', 'H-07'],
    scope: '赵宅（3 号）、杨宅（4 号）共用', size: '⌀7.2 m',
    use: '脱粒、晾晒、临时堆场', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '场面朝南，日照比西头那处长半天。边石缺了两块，用土坯临时补着，雨天要先拿草苫盖住场心。' },

  { id: 'P-03', type: 'production', kind: 'floor', category: '麦场', name: '北头共用麦场',
    pos: [-29.00, 0, 46.54], radius: 3.60, yardId: 'Y3', sharedBy: ['H-11', 'H-13'],
    scope: '王宅（6 号）、赵宅（7 号）共用', size: '⌀7.2 m',
    use: '脱粒、晾晒马铃薯与当归', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '离水窖近，和泥补场方便。场边那圈石头比别处高一点，是怕秋天山上下来的水把场心冲出沟。' },

  { id: 'P-04', type: 'production', kind: 'floor', category: '麦场', name: '南头共用麦场',
    pos: [31.00, 0, -68.74], radius: 3.60, yardId: 'Y4', sharedBy: ['H-02', 'H-04'],
    scope: '李宅（1 号）、刘宅（2 号）共用', size: '⌀7.2 m',
    use: '小麦脱粒、党参晾晒', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '紧挨村口进村的那段路，早年是全村公用的场面，后来分到这两家。收秋时过路的三轮车常借半边场卸货。' },

  { id: 'P-05', type: 'production', kind: 'floor', category: '麦场', name: '东腰共用麦场',
    pos: [31.00, 0, -18.92], radius: 3.60, yardId: 'Y5', sharedBy: ['H-06', 'H-08'],
    scope: '陈宅（3 号）、马宅（4 号）共用', size: '⌀7.2 m',
    use: '脱粒、晾晒、临时堆场', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '陈宅人口最多，场面用得最勤。场东头留了一块不铺石的空地，是给架子车调头用的。' },

  { id: 'P-06', type: 'production', kind: 'floor', category: '麦场', name: '东头三家麦场',
    pos: [30.00, 0, 36.13], radius: 3.60, yardId: 'Y6', sharedBy: ['H-10', 'H-12', 'H-14'],
    scope: '李宅（5 号）、刘宅（6 号）、陈宅（7 号）共用', size: '⌀7.2 m',
    use: '三家轮流脱粒、晾晒', structure: '夯实黄土，青石压边', season: '夏收 7 月、秋收 10 月',
    status: '在用', note: '全场唯一三家合用的场面，按抽签排日子。1998 年整过一次场底，往下挖了半尺换的红黏土。' },

  { id: 'P-07', type: 'production', kind: 'straw', category: '草垛', name: '西头麦草垛',
    pos: [-35.90, 0, -64.53], radius: 1.15, yardId: 'Y1', sharedBy: ['H-01', 'H-03'],
    scope: '西头共用麦场配套', size: '⌀2.2 × 2.3 m',
    use: '存麦草，喂畜、垫圈、引火', structure: '麦草，两道草绳束腰', season: '常年，夏收后最满',
    status: '在用', note: '垛底垫了一层树枝防潮，顶上扣个草帽状的尖，雨水顺着斜面走。开春见底，夏天重新垛起来。' },

  { id: 'P-08', type: 'production', kind: 'straw', category: '草垛', name: '南头麦草垛',
    pos: [35.90, 0, -66.04], radius: 1.15, yardId: 'Y4', sharedBy: ['H-02', 'H-04'],
    scope: '南头共用麦场配套', size: '⌀2.2 × 2.3 m',
    use: '存麦草，冬季垫圈', structure: '麦草，两道草绳束腰', season: '常年，夏收后最满',
    status: '在用', note: '两家各垛半边，中间用一道草绳分界。小孩爱从背风那面掏窝，开春以前总得补一次垛脚。' },

  { id: 'P-09', type: 'production', kind: 'wood', category: '柴垛', name: '西腰柴垛',
    pos: [-35.90, 0, -25.36], radius: 1.35, yardId: 'Y2', sharedBy: ['H-05', 'H-07'],
    scope: '西腰共用麦场配套', size: '2.4 × 1.2 × 1.3 m',
    use: '做饭、烧炕备柴', structure: '杨木 / 果木劈柴，顶覆旧篷布', season: '常年，入冬前码足',
    status: '在用', note: '劈柴一律朝里码，断面朝外容易淋雨。垛顶那块篷布压着两块青瓦，白毛风也掀不走。' },

  { id: 'P-10', type: 'production', kind: 'wood', category: '柴垛', name: '东腰柴垛',
    pos: [35.90, 0, -21.62], radius: 1.35, yardId: 'Y5', sharedBy: ['H-06', 'H-08'],
    scope: '东腰共用麦场配套', size: '2.4 × 1.2 × 1.3 m',
    use: '做饭、烧炕备柴', structure: '杨木 / 果木劈柴，顶覆旧篷布', season: '常年，入冬前码足',
    status: '在用', note: '比院里那两处柴垛大得多，是专为过冬码的。每年正月里见底，开春再上山拾一茬。' },

  { id: 'P-11', type: 'production', kind: 'dung', category: '粪堆', name: '西头粪堆',
    pos: [-32.20, 0, -61.43], radius: 1.65, yardId: 'Y1', sharedBy: ['H-01', 'H-03'],
    scope: '西头共用麦场配套', size: '⌀3.2 × 0.9 m',
    use: '积肥，开春上地', structure: '厩肥掺土，表面拍实', season: '冬积、春施',
    status: '在用', note: '离场面留了够一架车走的距离，味儿不往晒着的药材上飘。开春起完肥，底下那层黑土最壮。' },

  { id: 'P-12', type: 'production', kind: 'dung', category: '粪堆', name: '东腰粪堆',
    pos: [32.20, 0, -13.12], radius: 1.65, yardId: 'Y5', sharedBy: ['H-06', 'H-08'],
    scope: '东腰共用麦场配套', size: '⌀3.2 × 0.9 m',
    use: '积肥，开春上地', structure: '厩肥掺土，表面拍实', season: '冬积、春施',
    status: '在用', note: '堆在场院下风处，边上压了一圈土埂挡雨水。陈宅地里当归用肥重，年年这堆最先见底。' },

  { id: 'P-13', type: 'production', kind: 'coop', category: '鸡窝', name: '赵宅墙外鸡窝',
    pos: [-26.12, 0, -35.47], radius: 1.05, yardId: null, sharedBy: ['H-05'],
    scope: '赵宅（3 号）西院墙外', size: '1.6 × 1.2 × 1.1 m', rot: HOUSES[4].rot,
    use: '夜间圈鸡、避雨', structure: '土坯墙、木门、草顶', season: '常年',
    status: '在用', note: '贴着西院墙根的背风处，窝门朝里开。天黑前自家鸡会认路回来，清早开门放出去。' },

  { id: 'P-14', type: 'production', kind: 'coop', category: '鸡窝', name: '刘宅墙外鸡窝',
    pos: [25.77, 0, 32.69], radius: 1.05, yardId: null, sharedBy: ['H-12'],
    scope: '刘宅（6 号）东院墙外', size: '1.6 × 1.2 × 1.1 m', rot: HOUSES[11].rot,
    use: '夜间圈鸡、避雨', structure: '土坯墙、木门、草顶', season: '常年',
    status: '在用', note: '前年翻修院墙时顺手重砌的，比旧窝高半尺，黄鼠狼进不去了。窝顶每年入秋换一遍新草。' },

  { id: 'P-15', type: 'production', kind: 'sty', category: '猪圈', name: '王宅墙外猪圈',
    pos: [-24.79, 0, -56.31], radius: 2.05, yardId: null, sharedBy: ['H-03'],
    scope: '王宅（2 号）西院墙外', size: '3.2 × 2.6 × 0.95 m', rot: HOUSES[2].rot,
    use: '圈养生猪，连着粪坑积肥', structure: '石砌矮墙、木栅门、食槽', season: '常年',
    status: '在用', note: '圈门朝院墙开，添食不用绕到背街。矮墙只有齐腰高，冬天搭几块草帘挡北风。' },

  { id: 'P-16', type: 'production', kind: 'sty', category: '猪圈', name: '赵宅墙外猪圈',
    pos: [-25.67, 0, 59.21], radius: 2.05, yardId: null, sharedBy: ['H-13'],
    scope: '赵宅（7 号）西院墙外', size: '3.2 × 2.6 × 0.95 m', rot: HOUSES[12].rot,
    use: '圈养生猪，连着粪坑积肥', structure: '石砌矮墙、木栅门、食槽', season: '常年',
    status: '在用', note: '靠村北，离菜地近，淘剩下的菜叶子直接倒进圈里。石墙缝里长了几丛野蒿，没人特意去拔。' },
];

/* ---------------- 公共核心（村中心主路两侧） ----------------
 * 四处新建场所，编号 C-01 ~ C-04；另有 F-02 村委会原址升级（补公示栏与全村口径），
 * 合计 5 处可辨认的公共场所。全部是静态建筑，不随时间轴变化、不做高模、不做动画。
 *
 * 单位口径（代码注释与 CHANGELOG 各写一份，改数值时两处一起改）：
 *   - pos：世界坐标 [x, y, z]，m；y 恒为 0，实际标高由 world.js 的 heightAt() 取地形。
 *          +x 东 / +z 南，与 climate.js 的 dirZ=+cosθ 一致。
 *   - footprint：建筑占地 [x 方向长, z 方向宽]，m；台基按此尺寸外扩 0.30 m 收边。
 *   - radius：落位校验用的水平占位半径，m = √( (长/2)² + (宽/2)² )，含屋顶外挑余量。
 *   - area：档案卡占地面积，㎡；size 字段为 footprint 的可读写法。
 *
 * 分布：村中心 z ∈ [-31, 12]、主路两侧 |x| = 33 ~ 40 m。这个带不是随手选的：
 *       主路中线半宽 3.10 m、行道树 |x|=7.5~10.5 m、14 户院墙 |x|≈8~24 m、
 *       上一轮场院 |x|=29~36 m、耕地内缘 |x|≈35 m —— 只有院外背街这一条走廊
 *       容得下 7~10 m 见方的建筑。四处由 tools/verify-civic.mjs 逐项复核：
 *       主路折线走廊、巡游镜头路径、旋转矩形耕地与院墙、场院、水窖、树、杆脚、
 *       彼此边缘净距；任一项不过即退出码 1。
 * 彼此边缘净距最小 8.8 m（C-03 戏台 ↔ C-04 文化广场），不挤在一处。
 */
export const CIVIC = [
  { id: 'C-01', type: 'civic', kind: 'shop', category: '小卖部', name: '村中小卖部',
    pos: [40.00, 0, -13.00], footprint: [7.00, 5.00], radius: 4.30,
    size: '7.0 × 5.0 m', built: 2005, area: 35, structure: '砖木平房，红瓦，木门板',
    use: '日用杂货、农资代销、代收快递', scope: '全村 14 户', status: '在用',
    note: '门脸上那块「小卖部」是老校长写的，笔画歪，日晒褪色也没舍得换。窗台常年摆着两只塑料筐，收药材那阵子捎带代收快递。' },

  { id: 'C-02', type: 'civic', kind: 'clinic', category: '卫生室', name: '村卫生室',
    pos: [33.00, 0, -31.00], footprint: [8.00, 6.00], radius: 5.00,
    size: '8.0 × 6.0 m', built: 2012, area: 48, structure: '砖混平房，铝合金门窗',
    use: '常见病诊疗、防疫接种、慢病随访', scope: '全村 43 位常住人口', status: '在用',
    note: '山墙上刷的白底红十字，隔一条主路就能看见。村医一周来四天，量血压、换药、给娃打疫苗都在这间屋。' },

  { id: 'C-03', type: 'civic', kind: 'stage', category: '戏台', name: '村中戏台',
    pos: [-36.00, 0, -4.00], footprint: [9.00, 6.50], radius: 5.55,
    size: '9.0 × 6.5 m', built: 1998, area: 58.5, structure: '砖砌台基、木柱、青瓦顶',
    use: '社火、秦腔演出、村民集会', scope: '全村及邻村', season: '正月社火、秋收后唱戏', status: '在用',
    note: '台口朝东对着主路，正月里唱三天大戏，台下站满了人。台基是 1998 年全村出工砌的，木柱每年开春补一遍桐油。' },

  { id: 'C-04', type: 'civic', kind: 'culture', category: '文化广场', name: '村中文化广场',
    pos: [-34.00, 0, 12.00], footprint: [10.00, 8.00], radius: 6.40,
    size: '10.0 × 8.0 m', built: 2019, area: 80, structure: '水泥硬化，青石收边',
    use: '健身、晒粮、红白事摆席', scope: '全村 14 户', season: '常年，秋收与正月最热闹', status: '在用',
    note: '和戏台隔着一块空地，唱戏时这里就是天然的观众席。平时几副石桌凳，秋天摊开晒当归，谁家办事就在这里支灶摆席。' },
];

/* ---------------- 汇总 ---------------- */
export const ALL_OBJECTS = [
  ...HOUSES, ...TREES, ...ANIMAL_LIST, ...FACILITIES, ...FIELDS, ...YARD_DETAILS,
  ...STONES, MILLSTONE, ...CISTERNS, ...FLAGS, ...PRODUCTION, ...CIVIC,
];

export const STATS = {
  houses: HOUSES.length,
  trees: TREES.length,
  animals: ANIMAL_LIST.length,
  fields: FIELDS.length,
  facilities: FACILITIES.length,
  flags: FLAGS.length,
  // 生产性空间：16 个可点物件 / 6 处共享场院（计数供文档与 tools/verify-production.mjs 核对）
  production: PRODUCTION.length,
  yards: new Set(PRODUCTION.filter((p) => p.yardId).map((p) => p.yardId)).size,
  // 公共核心：4 处新建 + F-02 村委会原址升级 = 5 处公共场所
  civic: CIVIC.length,
  civicSites: CIVIC.length + 1,
  // 全村口径：43 人 / 513 亩，与 tools/verify-cards.mjs 的重算结果一致
  residents: HOUSES.reduce((a, h) => a + h.residents, 0),
  farmland: FIELDS.reduce((a, f) => a + f.area, 0),
  vacant: HOUSES.filter((h) => h.vacant).length,
};
