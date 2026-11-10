#!/usr/bin/env node
/**
 * 档案卡数据校验
 *
 * 做法：卡片上显示的「耕地亩数 / 牲畜数量 / 主要作物 / 年收入」是 data.js 里手写的
 * HOUSE_CARDS；本脚本按 ownerId 从场景对象（FIELDS / ANIMAL_LIST）**重新聚合一遍**，
 * 逐户比对。改了某块地的亩数、或把牲畜挪给别的户而忘了同步卡片，这里就会报错。
 *
 * 用法：
 *   node tools/verify-cards.mjs
 *   退出码 0 = 全部一致；1 = 有差异（逐条列出）
 *
 * 说明：工程 package.json 没有 "type": "module"，Node 会为 js/data.js 报一条
 * MODULE_TYPELESS_PACKAGE_JSON 警告。下面临时压掉这条警告，免得盖住对照表。
 */

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const { HOUSES, FIELDS, ANIMAL_LIST, FACILITIES, estimateIncome } = await import('../js/data.js');

/* ---------- 1. 按 ownerId 聚合场景侧 ---------- */
const byOwner = new Map(HOUSES.map((h) => [h.id, { fields: [], animals: [] }]));
const orphanFields = [];
const orphanAnimals = [];

for (const f of FIELDS) {
  const bucket = byOwner.get(f.ownerId);
  if (bucket) bucket.fields.push(f);
  else orphanFields.push(f);
}
for (const a of ANIMAL_LIST) {
  const bucket = byOwner.get(a.ownerId);
  if (bucket) bucket.animals.push(a);
  else orphanAnimals.push(a);
}

/** 亩数最大的作物就是「主要作物」；并列时取先出现的 */
function dominantCrop(fields) {
  const area = new Map();
  for (const f of fields) area.set(f.crop, (area.get(f.crop) ?? 0) + f.area);
  let best = null, bestArea = -1;
  for (const [crop, a] of area) {
    if (a > bestArea) { best = crop; bestArea = a; }
  }
  return best ?? '—';
}

/* ---------- 2. 逐户比对 ---------- */
const rows = [];
const problems = [];

for (const h of HOUSES) {
  const scene = byOwner.get(h.id);
  const farm = scene.fields.reduce((s, f) => s + f.area, 0);
  const live = scene.animals.length;
  const crop = dominantCrop(scene.fields);
  const income = estimateIncome(scene.fields, scene.animals);

  const bad = [];
  if (h.farmland !== farm) bad.push(`亩数 卡片${h.farmland} ≠ 场景${farm}`);
  if (h.livestock !== live) bad.push(`牲畜 卡片${h.livestock} ≠ 场景${live}`);
  if (h.cropMain !== crop) bad.push(`作物 卡片${h.cropMain} ≠ 场景${crop}`);
  if (Math.abs((h.income ?? 0) - income) > 1e-6) bad.push(`收入 卡片${h.income} ≠ 重算${income}`);
  if (!h.head) bad.push('缺户主');
  if (h.residents === 0 && (farm !== 0 || live !== 0)) bad.push('空置户却分到了地或畜');

  rows.push({
    户号: h.id, 户主: h.head ?? '—', 常住: h.residents,
    卡片亩: h.farmland, 场景亩: farm,
    卡片畜: h.livestock, 场景畜: live,
    主要作物: h.cropMain, 年收入: h.income, 结果: bad.length === 0 ? '✓' : '✗',
  });
  if (bad.length) problems.push(`${h.id} ${h.name}：${bad.join('；')}`);
}

/* ---------- 3. 全村合计 ---------- */
const totalFarm = FIELDS.reduce((s, f) => s + f.area, 0);
const cardFarm = HOUSES.reduce((s, h) => s + h.farmland, 0);
const totalLive = ANIMAL_LIST.length;
const cardLive = HOUSES.reduce((s, h) => s + h.livestock, 0);
const totalIncome = HOUSES.reduce((s, h) => s + h.income, 0);

if (cardFarm !== totalFarm) problems.push(`全村亩数：卡片合计 ${cardFarm} ≠ 场景合计 ${totalFarm}`);
if (cardLive !== totalLive) problems.push(`全村牲畜：卡片合计 ${cardLive} ≠ 场景合计 ${totalLive}`);
if (orphanFields.length) problems.push(`有 ${orphanFields.length} 块地的 ownerId 找不到对应户：${orphanFields.map((f) => f.id).join(', ')}`);
if (orphanAnimals.length) problems.push(`有 ${orphanAnimals.length} 头畜的 ownerId 找不到对应户：${orphanAnimals.map((a) => a.id).join(', ')}`);

/* ---------- 3b. 公共核心（v1.2）：F-02 村委会卡片上的全村口径 ----------
 * 任务 03 只校验逐户数字；任务「公共核心」要求村委会卡额外写全村人口与耕地
 * 总面积，且必须与本脚本重算的 ΣHOUSES.residents / ΣFIELDS.area 完全一致。
 * 口径：人口 人、耕地 亩。tools/verify-civic.mjs 也会再核一次这两项。 */
const totalPop = HOUSES.reduce((s, h) => s + h.residents, 0);
const committee = FACILITIES.find((f) => f.id === 'F-02');
if (!committee) problems.push('找不到 F-02 村委会');
else {
  if (committee.population !== totalPop) {
    problems.push(`F-02 全村人口 ${committee.population} 人 ≠ ΣHOUSES.residents ${totalPop} 人`);
  }
  if (committee.farmlandTotal !== totalFarm) {
    problems.push(`F-02 耕地总面积 ${committee.farmlandTotal} 亩 ≠ ΣFIELDS.area ${totalFarm} 亩`);
  }
  if (committee.farmlandTotal !== cardFarm) {
    problems.push(`F-02 耕地总面积 ${committee.farmlandTotal} 亩 ≠ ΣHOUSES.farmland ${cardFarm} 亩`);
  }
}

/* ---------- 4. 输出对照表 ---------- */
const width = (str) => [...String(str)].reduce((n, ch) => n + (/[\u2E80-\uFFFF]/.test(ch) ? 2 : 1), 0);
const pad = (str, n, right = false) => {
  const gap = ' '.repeat(Math.max(0, n - width(str)));
  return right ? gap + str : str + gap;
};

const cols = [
  ['户号', 6, false, (v) => v], ['户主', 8, false, (v) => v], ['常住', 5, true, (v) => v],
  ['卡片亩', 7, true, (v) => v], ['场景亩', 7, true, (v) => v],
  ['卡片畜', 7, true, (v) => v], ['场景畜', 7, true, (v) => v],
  ['主要作物', 10, false, (v) => v], ['年收入', 8, true, (v) => Number(v).toFixed(1)],
  ['结果', 5, false, (v) => v],
];
const line = (vals) => cols.map(([, w, right, fmt], i) => pad(fmt(vals[i]), w, right)).join(' ');

const head = cols.map(([t, w, right]) => pad(t, w, right)).join(' ');
console.log(head);
console.log('─'.repeat(width(head) + 1));
for (const r of rows) console.log(line(cols.map(([t]) => r[t])));
console.log('─'.repeat(width(head) + 1));
console.log(line(['合计', '', HOUSES.reduce((s, h) => s + h.residents, 0), cardFarm, totalFarm,
  cardLive, totalLive, '', totalIncome.toFixed(1), '']));
console.log('');
console.log(`场景：${FIELDS.length} 块地 / ${totalFarm} 亩，${ANIMAL_LIST.length} 头畜（`
  + `牛 ${ANIMAL_LIST.filter((a) => a.kind === '牛').length}、`
  + `羊 ${ANIMAL_LIST.filter((a) => a.kind === '羊').length}、`
  + `鸡 ${ANIMAL_LIST.filter((a) => a.kind === '鸡').length}、`
  + `狗 ${ANIMAL_LIST.filter((a) => a.kind === '狗').length}），`
  + `${HOUSES.length} 户（空置 ${HOUSES.filter((h) => h.residents === 0).length} 户）`);
console.log(`村委会卡：${committee ? `${committee.population} 人 / ${committee.farmlandTotal} 亩` : '缺失'}`
  + ` ← 全村重算 ${totalPop} 人 / ${totalFarm} 亩`);

if (problems.length) {
  console.error(`\n✗ 发现 ${problems.length} 处不一致：`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log('\n✓ 全部一致：卡片数字与场景实例逐户吻合，全村合计对得上。');
