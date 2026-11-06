/**
 * 把村庄布局与气象数据导出成引擎（UE / Unity）能直接读的格式
 *
 * 跑法：node tools/export-engine.mjs
 * 产物：engine-export/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from '../js/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, '..', 'engine-export');
fs.mkdirSync(path.join(out, 'ue'), { recursive: true });
fs.mkdirSync(path.join(out, 'unity'), { recursive: true });

/* ---------- 1. 布局 ---------- */
const clean = (arr) => arr.map((o) => {
  const { leaf, ...rest } = o;             // leaf 是渲染用色，引擎里不需要
  return rest;
});

const layout = {
  meta: {
    village: D.VILLAGE,
    exportedAt: new Date().toISOString(),
    // 坐标系说明：源数据为 Three.js 右手系（X 东 / Y 上 / Z 南），单位米
    source: 'Three.js, Y-up, meters',
    counts: {
      houses: D.HOUSES.length,
      trees: D.TREES.length,
      fields: D.FIELDS.length,
      animals: D.ANIMAL_LIST.length,
      facilities: D.FACILITIES.length,
    },
  },
  road: D.ROAD,
  houses: clean(D.HOUSES),
  trees: clean(D.TREES),
  fields: clean(D.FIELDS),
  animals: clean(D.ANIMAL_LIST),
  facilities: clean(D.FACILITIES),
};

fs.writeFileSync(
  path.join(out, 'village-layout.json'),
  JSON.stringify(layout, null, 2),
  'utf8'
);

/* ---------- 1.5 Unity 专用格式 ----------
   Unity 的 JsonUtility 不支持把数组反序列化成 Vector3，
   所以单独导一份 pos/size 用 {x,y,z} 对象形式写的。 */
const toObj = (arr) => ({ x: arr[0], y: arr[1], z: arr[2] });
const unityFix = (o) => {
  const r = { ...o };
  if (Array.isArray(r.pos)) r.pos = toObj(r.pos);
  if (Array.isArray(r.size)) r.size = { x: r.size[0], y: r.size[1] };
  return r;
};

const unityLayout = {
  houses: D.HOUSES.map(unityFix),
  trees: D.TREES.map(unityFix),
  fields: D.FIELDS.map(unityFix),
  animals: D.ANIMAL_LIST.map(unityFix),
  facilities: D.FACILITIES.map(unityFix),
};
fs.writeFileSync(
  path.join(out, 'village-layout-unity.json'),
  JSON.stringify(unityLayout, null, 2),
  'utf8'
);

/* ---------- 2. 气象 CSV ---------- */
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/minxian-2025-raw.json'), 'utf8'));
const H = raw.hourly;
const cols = ['time', 'temperature_2m', 'relative_humidity_2m', 'precipitation',
  'cloud_cover', 'weather_code', 'wind_speed_10m', 'snowfall', 'is_day'];

const lines = [cols.join(',')];
for (let i = 0; i < H.time.length; i++) {
  lines.push(cols.map((c) => H[c][i] ?? '').join(','));
}
fs.writeFileSync(path.join(out, 'climate-minxian-2025.csv'), lines.join('\n'), 'utf8');

/* ---------- 3. 摘要 ---------- */
console.log(`导出目录：${out}`);
console.log(`  布局        ${D.ALL_OBJECTS.length} 个物体`);
console.log(`  气象        ${H.time.length} 小时`);
console.log(`  日级日出日落 ${raw.daily.time.length} 天`);
