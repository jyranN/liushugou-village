/**
 * 住户作息表
 *
 * 全项目只有这一张表：炊烟（world.js）、窗灯（environment.js）、家畜活动（world.js）
 * 三处都从它取值，不再各写一套时间。
 *
 * 时间口径：全部用「当天小时」的连续值（0–24，带小数），由时间轴给出（15 分钟一格，
 * 但这里是连续实数，拖时间轴不会跳格）。不写死任何日期。
 *
 * 可复现性：某户某天某顿饭做不做，由 householdRoll 的整数哈希决定 ——
 * 同一户 + 同一天 + 同一餐永远得到同一个结果，重开页面、重跑构建都不变；
 * 换一天会重新洗牌，但不会逐帧抖动。
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 三餐时段（当天小时）：start 起火、peak 最旺、end 撤火；chance 是当天生火的概率 */
export const MEALS = [
  { key: 'morning', label: '早饭', start: 6.5, peak: 7.1, end: 8.0, chance: 0.92 },
  { key: 'noon', label: '午饭', start: 11.5, peak: 12.1, end: 13.0, chance: 0.72 },
  { key: 'evening', label: '晚饭', start: 17.5, peak: 18.2, end: 19.0, chance: 0.95 },
];

/** 窗灯：天黑点灯 → 睡前熄灯（当天小时） */
export const LIGHTS = { on: 18.4, off: 23.0 };

/** 家畜：出圈 → 归圈（当天小时） */
export const HERD = { out: 6.6, in: 18.8 };

export const ROUTINE = { meals: MEALS, lights: LIGHTS, herd: HERD };

/**
 * 整数哈希 → [0,1)。纯数学、无状态，所以「同一户同一天」在任何机器上都得到同一个数。
 * 三个种子分别取户序、日序、餐次，乘的都是大奇数，散得开。
 */
function hash01(a, b, c) {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(b + 0x165667b1, 0xc2b2ae35);
  h ^= Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** 一段「起火上汽 → 最旺 → 撤火」的平滑窗，窗外为 0 */
function mealWindow(x, a, b, c) {
  if (x <= a || x >= c) return 0;
  return x < b ? smoothstep(a, b, x) : 1 - smoothstep(b, c, x);
}

/**
 * 某户此刻的生火强度 0..1。
 *
 * @param {number} idx       户序 1..14（稳定，作哈希种子；不要每帧从字符串解析）
 * @param {number} day       年内日序（可带小数）
 * @param {number} hod       当天小时 0..24
 * @param {number} residents 常住人口；0 表示空置户，不点火
 * @returns {number} 0 = 没生火，1 = 火最旺
 */
export function cookingIntensity(idx, day, hod, residents) {
  if (residents <= 0) return 0;
  const d = Math.floor(day);
  // 人口多的户火更旺（按 4 口封顶），独居老人一样会做饭但烟细
  const sizeF = 0.55 + 0.45 * Math.min(1, residents / 4);
  let v = 0;
  for (let i = 0; i < MEALS.length; i++) {
    const m = MEALS[i];
    const w = mealWindow(hod, m.start, m.peak, m.end);
    if (w <= 0) continue;
    if (hash01(idx, d, i * 7919 + 13) > m.chance) continue;   // 今天这顿不生火
    v = Math.max(v, w * sizeF);
  }
  return v;
}

/** 窗灯亮度系数 0..1：点灯 0.35 h 渐亮，熄灯 0.7 h 渐暗，其余时间为 0 */
export function lightLevel(hod) {
  if (hod <= LIGHTS.on || hod >= LIGHTS.off) return 0;
  return Math.min(
    smoothstep(LIGHTS.on, LIGHTS.on + 0.35, hod),
    1 - smoothstep(LIGHTS.off - 0.7, LIGHTS.off, hod)
  );
}

/** 家畜活动量 0..1：出圈后正常踱步吃草，入夜后完全静止 */
export function herdActivity(hod) {
  const out = smoothstep(HERD.out, HERD.out + 1.1, hod);
  const back = 1 - smoothstep(HERD.in - 1.0, HERD.in, hod);
  return Math.min(out, back);
}

/** 自检用：描述当前时段，便于在 ?qa=1 面板里一眼看出是否落在饭点 */
export function routineLabel(hod) {
  for (const m of MEALS) {
    if (hod >= m.start && hod < m.end) return m.label;
  }
  if (hod >= LIGHTS.on && hod < LIGHTS.off) return '点灯';
  if (hod < HERD.out) return '夜里';
  return '白天';
}
