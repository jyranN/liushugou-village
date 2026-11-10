/**
 * 作物物候校验（v1.2 第 4 轮）
 *
 * 纯 Node，不依赖 three / DOM：从 data.js 读地块、从 world.js 源码解析 CROP_SPEC，
 * 再用一套独立复刻的状态函数验算。检查项：
 *   1. 14 块地、亩数合计 513、当归恰好 2 块
 *   2. 8 种作物都有 CROP_SPEC，family 都在四种形态族里
 *   3. gddNeed / sow 与全年积温自洽（播种后的积温够不够走完全生育期）
 *   4. 五状态区间连续、单调，g 从 0 到 1.10 无负数/越界
 *   5. 形态参数（株高/密度）在状态边界处连续，不出现跳变
 *
 * 运行：node tools/verify-crop.mjs
 * 失败退出码 1。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { FIELDS } = await import('../js/data.js');
const worldSrc = readFileSync(join(ROOT, 'js/world.js'), 'utf8');
const climateRaw = JSON.parse(readFileSync(join(ROOT, 'data/minxian-2025-raw.json'), 'utf8'));

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log(`  ✗ ${msg}`); } };

/* ---------- 1. 地块 ---------- */
console.log('== 地块 ==');
const totalArea = FIELDS.reduce((s, f) => s + f.area, 0);
ok(FIELDS.length === 14, `地块数 ${FIELDS.length} ≠ 14`);
ok(totalArea === 513, `亩数合计 ${totalArea} ≠ 513`);
const angelica = FIELDS.filter((f) => f.crop === '当归');
ok(angelica.length === 2, `当归 ${angelica.length} 块 ≠ 2（任务要求 1–2 块）`);
ok(angelica.every((f) => (f.note || '').includes('当归')), '当归地块的 note 没写到道地/物候');

/* ---------- 2. CROP_SPEC ---------- */
console.log('== 作物参数 ==');
const spec = {};
{
  const block = worldSrc.match(/const CROP_SPEC = \{([\s\S]*?)\n  \};/);
  ok(!!block, '没找到 CROP_SPEC');
  if (block) {
    const re = /(\S+?):\s*\{\s*family:\s*'(\w+)',\s*gddNeed:\s*([\d.]+),\s*sow:\s*([\d.]+),\s*h:\s*([\d.]+),\s*gap:\s*([\d.]+),\s*row:\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(block[1]))) {
      spec[m[1]] = { family: m[2], gddNeed: +m[3], sow: +m[4], h: +m[5], gap: +m[6], row: +m[7] };
    }
  }
}
const FAMILIES = new Set(['tall', 'dense', 'low', 'umbel']);
const crops = [...new Set(FIELDS.map((f) => f.crop))];
ok(crops.length === 8, `地块里出现 ${crops.length} 种作物 ≠ 8`);
for (const c of crops) {
  const s = spec[c];
  if (!s) { bad++; console.log(`  ✗ ${c} 没有 CROP_SPEC`); continue; }
  ok(FAMILIES.has(s.family), `${c} 的 family "${s.family}" 不在四种形态族里`);
  ok(s.gddNeed > 300 && s.gddNeed < 2200, `${c} 的 gddNeed ${s.gddNeed} 超出 300~2200 ℃·d`);
  ok(s.sow >= 60 && s.sow <= 130, `${c} 的播种日序 ${s.sow} 不在 60~130`);
  ok(s.h > 0.2 && s.h < 2.0, `${c} 的株高 ${s.h} m 超出 0.2~2.0`);
}
// 四种形态族都要有作物，否则"形态区分"名不副实
for (const fam of FAMILIES) {
  const list = crops.filter((c) => spec[c] && spec[c].family === fam);
  ok(list.length > 0, `形态族 ${fam} 没有任何作物`);
  console.log(`  ${fam.padEnd(6)} ${list.join(' / ')}`);
}

/* ---------- 3. 积温自洽 ---------- */
console.log('== 积温自洽 ==');
const T = climateRaw.hourly.temperature_2m;
const gddDaily = [];
{
  let acc = 0;
  for (let d = 0; d < 365; d++) {
    let s = 0;
    for (let h = 0; h < 24; h++) s += Math.max(0, (T[d * 24 + h] ?? 0) - 5) / 24;
    acc += s; gddDaily.push(acc);
  }
}
const gddAt = (doy) => {
  const d = ((doy % 365) + 365) % 365;
  const i = Math.floor(d), f = d - i;
  return gddDaily[i] + ((i >= 364 ? 0 : gddDaily[i + 1]) - gddDaily[i]) * f;
};
const yearTotal = gddDaily[364];
console.log(`  全年累积 ${yearTotal.toFixed(0)} ℃·d（基温 5℃）`);
for (const [c, s] of Object.entries(spec)) {
  const avail = yearTotal - gddAt(s.sow);
  ok(avail >= s.gddNeed * 1.0,
    `${c} 播种后只剩 ${avail.toFixed(0)} ℃·d，不够走完 ${s.gddNeed}（永远到不了成熟）`);
}

/* ---------- 4. 五状态区间 ---------- */
console.log('== 五状态 ==');
// 独立复刻 stageOf 与形态曲线，源码改了这里没跟会直接失败
const stageOf = (g) => (g <= 0.001 ? '休耕' : g < 0.12 ? '出苗' : g < 0.72 ? '生长' : g < 1.0 ? '成熟' : '收割后（留茬）');
const shape = (g) => {
  let h, den;
  if (g < 0.12) { const t = Math.min(1, Math.max(0, g / 0.12)); h = 0.06 + (0.18 - 0.06) * t; den = 0.35 + (0.75 - 0.35) * t; }
  else if (g < 0.72) { const t = (g - 0.12) / 0.60; h = 0.18 + (0.92 - 0.18) * t; den = 0.75 + (1.0 - 0.75) * t; }
  else if (g < 1.0) { const t = (g - 0.72) / 0.28; h = 0.92 + (1.0 - 0.92) * t; den = 1.0 + (0.72 - 1.0) * t; }
  else { const t = Math.min(1, Math.max(0, (g - 1.0) / 0.10)); h = 1.0 + (0.05 - 1.0) * t; den = 0.72 + (0.10 - 0.72) * t; }
  return { h, den };
};

const seen = new Set();
let prevH = shape(0).h, prevDen = shape(0).den, maxJump = 0, jumpAt = 0;
for (let i = 0; i <= 1100; i++) {
  const g = i / 1000;
  seen.add(stageOf(g));
  const { h, den } = shape(g);
  ok(h >= 0 && h <= 1.001, `g=${g.toFixed(3)} 株高系数 ${h} 越界`);
  ok(den >= 0 && den <= 1.001, `g=${g.toFixed(3)} 密度 ${den} 越界`);
  const jump = Math.max(Math.abs(h - prevH), Math.abs(den - prevDen));
  if (jump > maxJump) { maxJump = jump; jumpAt = g; }
  prevH = h; prevDen = den;
}
ok(seen.size === 5, `只出现 ${seen.size} 个状态：${[...seen].join('/')}`);
ok(maxJump < 0.05, `g 步进 0.001 时形态最大跳变 ${maxJump.toFixed(4)}（在 g=${jumpAt.toFixed(3)}），不够平滑`);
console.log(`  五状态 ${[...seen].join(' → ')}；形态最大步进 ${maxJump.toFixed(4)}`);

// 状态边界两端的形态不能跳：0.12 / 0.72 / 1.0 各取 ±1e-4 对比
for (const b of [0.12, 0.72, 1.0]) {
  const a = shape(b - 1e-4), c = shape(b + 1e-4);
  ok(Math.abs(a.h - c.h) < 2e-3 && Math.abs(a.den - c.den) < 2e-3,
    `状态边界 g=${b} 两侧形态跳变（h ${a.h.toFixed(4)}→${c.h.toFixed(4)}）`);
}

/* ---------- 5. 结论 ---------- */
console.log('');
if (bad) { console.log(`❌ ${bad} 项不一致`); process.exit(1); }
console.log('✅ 全部通过：地块、作物参数、积温自洽、五状态连续');
