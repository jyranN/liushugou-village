/**
 * 补齐逐小时风向 wind_direction_10m
 *
 * 背景：data/minxian-2025-raw.json 初始只取了 8 个变量，没有风向，
 * 而「风向可视化」需要真实来向。本脚本从**与原始数据同一条 Open-Meteo 档案查询**
 * 补取风向，不换数据源、不换模型。
 *
 * 用法：
 *   node tools/fetch-wind-direction.mjs          # 补取并写入（已存在则只校验）
 *   node tools/fetch-wind-direction.mjs --check   # 只校验，不写文件
 *
 * 安全约束（脚本会自己检查，不通过就退出）：
 *   1. 时间轴必须逐条一致（8760 条、起点 2025-01-01T00:00、时区 Asia/Shanghai）；
 *   2. 同一次返回里的 wind_speed_10m 必须与工程内已有的逐值吻合（容差 0.05 km/h）。
 *      这条是「同一份档案」的硬证据：换模型或换分辨率都会让风速对不上。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, 'data/minxian-2025-raw.json');
const CHECK_ONLY = process.argv.includes('--check');

const KEY_SPEED = '"wind_speed_10m":[';
const KEY_DIR = '"wind_direction_10m":[';      // 用于「是否已存在」检测
const KEY_DIR_INS = ',"wind_direction_10m":';  // 用于插入（数组由 JSON.stringify 自己带括号）
const UNIT_ANCHOR = '"wind_speed_10m":"km/h"';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const raw = fs.readFileSync(dataFile, 'utf8');
const json = JSON.parse(raw);
const H = json.hourly;
const n = H.time.length;

/** 从 key 起始位置向后做括号配平，返回数组结束 ']' 的下标 */
function matchArray(text, startKey) {
  const i = text.indexOf(startKey);
  if (i < 0) return null;
  let p = i + startKey.length - 1;   // 指向 '['
  let depth = 0;
  for (; p < text.length; p++) {
    const c = text[p];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return p; }
  }
  return null;
}

/* ---------- 已存在：只校验 ---------- */
if (raw.includes(KEY_DIR)) {
  const dir = H.wind_direction_10m;
  if (!Array.isArray(dir) || dir.length !== n) fail(`风向条数 ${dir?.length} ≠ 时间轴 ${n}`);
  const bad = dir.filter((v) => !Number.isFinite(v) || v < 0 || v > 360).length;
  if (bad) fail(`有 ${bad} 条风向越界或非数值`);
  console.log(`✓ 风向已存在：${n} 条，范围 ${Math.min(...dir)}°–${Math.max(...dir)}°，无需补取`);
  process.exit(0);
}
if (CHECK_ONLY) fail('数据里没有 wind_direction_10m');

/* ---------- 拉取 ---------- */
const lat = json.latitude;
const lon = json.longitude;
const url = 'https://archive-api.open-meteo.com/v1/archive'
  + `?latitude=${lat}&longitude=${lon}`
  + '&start_date=2025-01-01&end_date=2025-12-31'
  + '&hourly=wind_speed_10m,wind_direction_10m'
  + '&timezone=Asia%2FShanghai&models=best_match';

console.log(`取数：${lat}, ${lon} · 2025 全年 · 与原始数据同一条 query`);
const res = await fetch(url);
if (!res.ok) fail(`接口返回 ${res.status} ${res.statusText}`);
const got = await res.json();
const g = got.hourly;

if (!g?.wind_direction_10m) fail('返回里没有 wind_direction_10m');

/* ---------- 校验 1：时间轴逐条一致 ---------- */
if (g.time.length !== n) fail(`返回 ${g.time.length} 条，工程 ${n} 条`);
for (let i = 0; i < n; i++) {
  if (g.time[i] !== H.time[i]) fail(`第 ${i} 条时间不一致：${g.time[i]} ≠ ${H.time[i]}`);
}

/* ---------- 校验 2：同次返回的风速必须与工程一致 ---------- */
let maxDiff = 0, diffCount = 0;
for (let i = 0; i < n; i++) {
  const d = Math.abs((g.wind_speed_10m[i] ?? 0) - (H.wind_speed_10m[i] ?? 0));
  if (d > maxDiff) maxDiff = d;
  if (d > 0.05) diffCount++;
}
if (diffCount) fail(`风速有 ${diffCount} 处不一致（最大差 ${maxDiff.toFixed(2)}），说明不是同一份档案，已中止`);
console.log(`✓ 时间轴 ${n} 条逐条吻合；风速最大差 ${maxDiff.toFixed(3)} km/h（同源）`);

/* ---------- 缺口补值：null 用前值顺延 ---------- */
const dir = g.wind_direction_10m.slice(0, n).map((v, i, arr) => {
  if (Number.isFinite(v)) return Math.round(v);
  for (let k = i - 1; k >= 0; k--) if (Number.isFinite(arr[k])) return Math.round(arr[k]);
  return 0;
});

/* ---------- 文本级插入：其余字节原样保留 ---------- */
const endSpeed = matchArray(raw, KEY_SPEED);
if (endSpeed == null) fail('找不到 wind_speed_10m 数组');
if (!raw.includes(UNIT_ANCHOR)) fail('找不到 wind_speed_10m 的单位锚点');

let out = raw;
// 1) 单位表加一项（风向单位是度）
out = out.replace(UNIT_ANCHOR, `${UNIT_ANCHOR},"wind_direction_10m":"°"`);
// 2) 数组紧跟风速数组之后（之前的偏移量不变，因为单位表在更前面，
//    所以重新定位一次再插）
const endSpeed2 = matchArray(out, KEY_SPEED);
out = out.slice(0, endSpeed2 + 1)
  + `${KEY_DIR_INS}${JSON.stringify(dir)}`
  + out.slice(endSpeed2 + 1);

const re = JSON.parse(out);
if (re.hourly.wind_direction_10m.length !== n) fail('写回后校验失败：条数不符');
if (re.hourly.time.join() !== H.time.join()) fail('写回后校验失败：时间轴被破坏');
if (re.hourly.wind_speed_10m.join() !== H.wind_speed_10m.join()) fail('写回后校验失败：风速被改动');

fs.writeFileSync(dataFile, out);
const before = Buffer.byteLength(raw), after = Buffer.byteLength(out);
console.log(`✓ 已写入 ${n} 条风向`);
console.log(`  范围 ${Math.min(...dir)}°–${Math.max(...dir)}°（气象来向，0=北 90=东）`);
console.log(`  文件 ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB（+${((after - before) / 1024).toFixed(1)} KB）`);
