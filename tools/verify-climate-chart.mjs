#!/usr/bin/env node
/**
 * 气象数据面板（v1.2 第十一轮：全年气温曲线 + 降水柱状，Canvas 2D 自绘）校验
 *
 * 用法：
 *   node tools/verify-climate-chart.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-climate-chart.mjs --self-test  负向自测：内存里破坏两份模块副本
 *                                                   （改成每帧全量重绘 / 删点击跳时刻），
 *                                                   确认检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 ℃ / mm / 小时序 0–8759，与 climate-chart.js 注释一致）：
 *   1. DOM 接线：index.html 有 wxChartBtn / wxPanel / wxPanelClose / wxCanvas
 *   2. 自绘：getContext('2d')，模块 import 零依赖（无 three / 无图表库）
 *   3. 数据源：hourly.temperature_2m / precipitation，365 个日均 / 日合计一次性预算
 *   4. 按屏幕宽度降采样：像素列 → 日序线性插值（x / w × 365），柱状聚合窗口
 *   5. 重绘按需：offscreen 静态层 + 游标 x 像素变化才重绘（lastCursorX 比较）+ redraws 计数
 *   6. 双向同步：点击 / 拖动写 clock.hour 且对齐 15 分钟格（round(h × 4) / 4）
 *   7. main.js：initClimateChart 接线 + animate 里每帧 updateClimateChart
 */
import { readFileSync } from 'node:fs';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const SRC = readFileSync(new URL('../js/climate-chart.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
const selfTest = process.argv.includes('--self-test');

async function runChecks(src, main, html) {
  let bad = 0;
  const problems = [];
  const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

  /* ---------------- 1. DOM 接线 ---------------- */
  ok(/id="wxChartBtn"/.test(html) && /id="wxPanel"/.test(html) && /id="wxCanvas"/.test(html)
    && /id="wxPanelClose"/.test(html), 'index.html 缺 wxChartBtn / wxPanel / wxCanvas / wxPanelClose');
  ok(/#wxPanel\.open/.test(CSS) && /#wxCanvas/.test(CSS), 'style.css 缺面板展开样式');

  /* ---------------- 2. 自绘零依赖 ---------------- */
  ok(/getContext\('2d'\)/.test(src), '没用 Canvas 2D（getContext 2d）');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  ok(imports.length === 0, `模块引入了依赖（应零 import）：${imports.join(', ')}`);
  ok(!/echarts|chart\.js|d3|plotly/i.test(src), '引入了图表库（任务要求自绘）');

  /* ---------------- 3. 数据源与一次性预算 ---------------- */
  ok(/temperature_2m/.test(src) && /precipitation/.test(src), '数据没有取 hourly.temperature_2m / precipitation');
  ok(/new Float32Array\(nd\)/.test(src) && /\/ 24/.test(src), '日均温不是一次性预算（日合计 ÷ 24）');
  ok(/dayCount/.test(src), '没有用 climate.dayCount 定 365 天口径');

  /* ---------------- 4. 按屏幕宽度降采样 ---------------- */
  ok(/\(x \/ w\) \* \(nd - 1\)|\(x \/ w\) \* nd/.test(src), '曲线没有按画布宽度映射日序（降采样缺失）');
  ok(/barPitch/.test(src), '降水柱没有按宽度聚合（barPitch 缺失）');

  /* ---------------- 5. 重绘按需 ---------------- */
  ok(/document\.createElement\('canvas'\)/.test(src) && /drawImage\(off/.test(src),
    '静态层没有走 offscreen canvas（每帧全量重绘）');
  ok(/lastCursorX/.test(src) && /x !== lastCursorX/.test(src),
    '游标没有按 x 像素变化闸门（lastCursorX 缺失，会每帧重绘）');
  ok(/redraws\+\+/.test(src) && /export function climateChartRedraws/.test(src),
    '缺少 redraws 重绘计数（验收「按需重绘」没法客观核对）');

  /* ---------------- 6. 双向同步 ---------------- */
  ok(/clock\.hour = Math\.round\(fx \* climateRef\.n \* 4\) \/ 4/.test(src),
    '点击曲线没有写 clock.hour 且对齐 15 分钟格（round ×4 / 4）');
  ok(/pointerdown/.test(src) && /pointermove/.test(src) && /dragging/.test(src),
    '缺少按住拖动连续跳时刻');
  // 游标位置来自 clock.hour（拖时间轴 → 游标跟随的另一半）
  ok(/clock\.hour \/ climateRef\.n\) \* canvas\.width|clockRef\.hour \/ climateRef\.n\) \* canvas\.width/.test(src.replace(/\n/g, ' ').replace(/ +/g, ' '))
    || /clockRef\.hour \/ climateRef\.n/.test(src), '游标 x 没有从 clock.hour 映射（拖时间轴游标不跟随）');

  /* ---------------- 7. main.js 接线 ---------------- */
  ok(/from '\.\/climate-chart\.js'/.test(main), 'main.js 没有引入 climate-chart 模块');
  ok(/initClimateChart\(climate, clock\)/.test(main), 'main.js 没有初始化 climate-chart');
  ok(/updateClimateChart\(clock, wx\)/.test(main), 'main.js 动画循环没有每帧调 updateClimateChart');

  return { bad, problems };
}

let { bad, problems } = await runChecks(SRC, MAIN, HTML);

/* ---------------- 负向自测 ---------------- */
if (selfTest) {
  let caught = 0, total = 2;
  // 破坏 1：改成每帧全量重绘（拿掉 update 的 x 变化闸门与 redraw 的同值短路）
  const m1 = SRC.replace("if (x !== lastCursorX || lastReadout === '') redraw(false, wx);", 'redraw(false, wx);')
    .replace('if (!force && x === lastCursorX) return;', '');
  const r1 = await runChecks(m1, MAIN, HTML);
  if (r1.bad > 0) caught++; else console.log('✗ 破坏 1 未被抓到：每帧重绘后检查仍通过');
  // 破坏 2：删掉点击跳时刻（pointerdown 只不做事）
  const m2 = SRC.replace(/clock\.hour = Math\.round\(fx \* climateRef\.n \* 4\) \/ 4;/, '/* 已删 */');
  const r2 = await runChecks(m2, MAIN, HTML);
  if (r2.bad > 0) caught++; else console.log('✗ 破坏 2 未被抓到：点击跳时刻被删后检查仍通过');
  console.log(`\n负向自测：${caught}/${total} 项破坏被检查抓到`);
  if (caught < total) { console.log('✗ 负向自测失败'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log('气象面板：Canvas 2D 自绘全年日均线 + 日降水柱（按画布宽度降采样，365 项一次性预算）');
console.log('游标：拖时间轴跟随（x 像素变化才重绘）、点 / 拖曲线跳时刻（对齐 15 分钟格）；offscreen 静态层');

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
