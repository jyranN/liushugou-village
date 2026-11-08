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

/* ---------------- 道路 ---------------- */
export const ROAD = {
  width: 6.2,
  points: [
    [-2, -128], [-1, -86], [0, -40], [1, 4], [2, 52], [2.5, 96], [3, 128],
  ],
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
  });
}

/* ---------------- 树木 ---------------- */
const SPECIES = [
  { kind: '杨树', h: [11, 17], c: [4.2, 6.8], dbh: [38, 62], leaf: [128, 112, 62] },
  { kind: '柳树', h: [8, 13], c: [5.0, 7.6], dbh: [32, 55], leaf: [140, 126, 74] },
  { kind: '杏树', h: [4.5, 7.5], c: [3.4, 5.2], dbh: [18, 30], leaf: [150, 114, 66] },
  { kind: '槐树', h: [9, 14], c: [5.6, 8.2], dbh: [34, 58], leaf: [112, 98, 58] },
  { kind: '榆树', h: [8, 13], c: [4.6, 7.0], dbh: [30, 52], leaf: [122, 106, 60] },
];

export const TREES = [];
let treeSeq = 0;
function addTree(x, z, opts = {}) {
  const sp = opts.species || pick(SPECIES);
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

/* ---------------- 公共设施 ---------------- */
export const FACILITIES = [
  { id: 'F-01', type: 'facility', kind: 'well', name: '村中老井',
    pos: [-4, 0, 6], built: 1972, depth: 18.4, waterLevel: 11.2,
    use: '生活取水（备用）', status: '可用', note: '井台为整石凿成，井绳痕深' },

  { id: 'F-02', type: 'facility', kind: 'committee', name: '村委会',
    pos: [26, 0, -6], built: 2008, area: 186, structure: '砖混',
    use: '村务办公', status: '在用', note: '二层，院内有一根旗杆' },

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
  { id: 'L-01', type: 'field', name: '东坡梯田', crop: '当归', area: 62, pos: [-70, 0, -52], size: [42, 40], rot: 0.12, stage: '已采收', note: '10 月下旬采挖完毕，正在回茬' },
  { id: 'L-02', type: 'field', name: '南川地', crop: '党参', area: 48, pos: [-64, 0, 34], size: [46, 34], rot: -0.06, stage: '根膨大末期', note: '预计 11 月中旬采挖' },
  { id: 'L-03', type: 'field', name: '西梁地', crop: '黄芪', area: 55, pos: [66, 0, -52], size: [50, 38], rot: -0.18, stage: '已采收', note: '旱作雨养，产量略低' },
  { id: 'L-04', type: 'field', name: '北湾地', crop: '柴胡', area: 34, pos: [70, 0, 66], size: [40, 30], rot: 0.2, stage: '越冬准备', note: '二年生，明年秋采' },
  { id: 'L-05', type: 'field', name: '门前菜地', crop: '蔬菜', area: 8, pos: [-16, 0, 78], size: [22, 16], rot: 0.05, stage: '收尾', note: '各家自种，白菜萝卜为主' },
  { id: 'L-06', type: 'field', name: '河滩地', crop: '马铃薯', area: 26, pos: [-76, 0, 96], size: [20, 24], rot: -0.1, stage: '已收', note: '东岸沙壤土，薯形好' },
  { id: 'L-07', type: 'field', name: '下川地', crop: '当归', area: 41, pos: [-78, 0, -92], size: [36, 28], rot: 0.08, stage: '已采收', note: '村南主产田' },
  { id: 'L-08', type: 'field', name: '东塬地', crop: '黄芪', area: 52, pos: [52, 0, -92], size: [42, 30], rot: -0.14, stage: '已采收', note: '坡地，排水好' },
  { id: 'L-09', type: 'field', name: '西沟地', crop: '马铃薯', area: 33, pos: [-66, 0, -8], size: [32, 34], rot: 0.16, stage: '已收', note: '二年轮作，防土传病害' },
  { id: 'L-10', type: 'field', name: '中腰地', crop: '当归', area: 37, pos: [52, 0, 12], size: [34, 28], rot: -0.05, stage: '已采收', note: '水浇条件好' },
  { id: 'L-11', type: 'field', name: '陈家湾', crop: '党参', area: 44, pos: [-52, 0, 62], size: [40, 32], rot: 0.1, stage: '根膨大末期', note: '11 月中旬采挖' },
  { id: 'L-12', type: 'field', name: '北坡地', crop: '柴胡', area: 29, pos: [30, 0, 92], size: [36, 26], rot: 0.22, stage: '越冬准备', note: '阴坡，墒情好' },
  { id: 'L-13', type: 'field', name: '门前园子', crop: '蔬菜', area: 9, pos: [-12, 0, 104], size: [44, 30], rot: 0.04, stage: '收尾', note: '各家自种白菜、萝卜' },
  { id: 'L-14', type: 'field', name: '梁上地', crop: '当归', area: 35, pos: [86, 0, -14], size: [30, 24], rot: -0.2, stage: '已采收', note: '新垦地，土层薄' },
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

/* ---------------- 汇总 ---------------- */
export const ALL_OBJECTS = [
  ...HOUSES, ...TREES, ...ANIMAL_LIST, ...FACILITIES, ...FIELDS, ...YARD_DETAILS,
  ...STONES, MILLSTONE, ...CISTERNS,
];

export const STATS = {
  houses: HOUSES.length,
  trees: TREES.length,
  animals: ANIMAL_LIST.length,
  fields: FIELDS.length,
  facilities: FACILITIES.length,
  residents: HOUSES.reduce((a, h) => a + h.residents, 0),
  vacant: HOUSES.filter((h) => h.vacant).length,
};
