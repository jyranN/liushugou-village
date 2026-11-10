#!/usr/bin/env node
/**
 * 牲畜微动作（v1.2 第九轮）校验（纯 Node，不依赖 three / DOM / 网络）
 *
 * 用法：
 *   node tools/verify-livestock.mjs              正常校验，退出码 0 = 全部通过
 *   node tools/verify-livestock.mjs --self-test  负向自测：在内存里破坏三份源码副本
 *                                               （暂停口径失效 / 狗摇尾退化 / 避雨判定失效），
 *                                               确认检查会报错（不改动任何源文件）
 *
 * 检查口径（单位 m / rad / Hz，与 world.js 家畜段注释一致）：
 *   1. 计数与档案：ANIMAL_LIST 17 头（牛 4 / 羊 6 / 鸡 6 / 看门狗 1）；
 *      A-17 狗归 H-05 赵宅，卡片牲畜 2、狗收入口径 0（看门狗不计收入）
 *   2. draw call 预算 +2：每只仍是「身体 1 Mesh + 头 1 Mesh」共用 matHide；
 *      没有逐头 AnimationMixer / AnimationClip（全部走顶点着色器与 CPU 旋转）
 *   3. 种类动作：牛反刍（颌部 0.5 Hz × 0.05 rad）、鸡双啄一停（pow4 + 前倾 0.06 rad）、
 *      羊低头侧拉（0.10 rad）、狗抬头（0.55 rad）/ 呼吸（±1.2%）/ 摇尾（2.6 Hz × 0.35）
 *   4. 雨雪避檐：climate.sample(hour) 判定（雪 > 0.01 或降雨 > 0.05），
 *      wetK 约 8 s 实时平滑；牛羊→东头畜圈 [46,34] 檐下、鸡→就近鸡窝、狗→自家屋檐
 *   5. 暂停口径：微动作走实时钟（暂停继续，同草/旗面）；避雨过渡受 playing 门控（暂停定住）
 *   6. 随机序列零消耗：狗的朝向/相位写死，不调用 between/rnd——
 *      其后公共设施等随机细节与上一版逐位一致
 *   7. main.js ?qa=1 有 animals 汇总行
 */
import { readFileSync } from 'node:fs';

const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'string' ? rest[0] : rest[0]?.code;
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON' || String(warning).includes('MODULE_TYPELESS_PACKAGE_JSON')) return;
  return origEmitWarning.call(process, warning, ...rest);
};

const SRC = readFileSync(new URL('../js/world.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const DATAJS = readFileSync(new URL('../js/data.js', import.meta.url), 'utf8');

/* 把全部检查写成闭包，负向自测时对破坏后的副本重跑一遍 */
async function runChecks(src, main, datajs) {
  let bad = 0;
  const problems = [];
  const ok = (cond, msg) => { if (!cond) { bad++; problems.push(msg); } };

  /* ---------------- 1. 计数与档案（直接 import data.js 重算） ---------------- */
  const D = await import(new URL('../js/data.js', import.meta.url) + `?t=${Date.now()}`);
  // 注意：data.js 是真实文件，这里只读不破坏；破坏自测只针对 world/data.js 的文本副本，
  // 计数项在自测模式下跳过（避免缓存污染）
  const selfTest = process.argv.includes('--self-test');
  if (!selfTest) {
    const A = D.ANIMAL_LIST;
    const nOf = (k) => A.filter((a) => a.kind === k).length;
    ok(A.length === 17, `ANIMAL_LIST 总数 ${A.length} ≠ 17（牛 4 / 羊 6 / 鸡 6 / 看门狗 1）`);
    ok(nOf('牛') === 4 && nOf('羊') === 6 && nOf('鸡') === 6 && nOf('狗') === 1,
      `种类计数不对：牛 ${nOf('牛')} 羊 ${nOf('羊')} 鸡 ${nOf('鸡')} 狗 ${nOf('狗')}`);
    const dog = A.find((a) => a.id === 'A-17');
    ok(!!dog && dog.kind === '狗' && dog.ownerId === 'H-05', 'A-17 看门狗缺失或归属不是 H-05 赵宅');
    ok(D.HOUSES[4].livestock === 2, 'H-05 卡片牲畜数量应为 2（鸡窝户 + 看门狗）');
    ok((D.INCOME_RATES.animal['狗'] ?? -1) === 0, '看门狗必须不计收入（INCOME_RATES.animal.狗 = 0）');
    // 落位：赵宅大门旁（面向巷道 +x 侧），单位 m
    if (dog) {
      const h = D.HOUSES[4];
      ok(Math.abs(dog.pos[0] - (h.pos[0] + h.yard.w * 0.5 + 1.3)) < 1e-6
        && Math.abs(dog.pos[2] - (h.pos[2] + 5)) < 1e-6, '狗的落位公式与注释口径不一致');
    }
  }

  /* ---------------- 2. draw call 预算与零混合器 ---------------- */
  const bStart = src.indexOf('function buildAnimal');
  const bEnd = src.indexOf('ANIMAL_LIST.forEach(buildAnimal)');
  ok(bStart > 0 && bEnd > bStart, '找不到 buildAnimal 段');
  const BSEG = bStart > 0 && bEnd > bStart ? src.slice(bStart, bEnd) : '';
  ok((BSEG.match(/new THREE\.Mesh\(/g) || []).length === 2, '每只牲畜应只有身体 + 头 2 个 Mesh（狗 +2 draw call 上限）');
  ok(!/AnimationMixer|AnimationClip|KeyframeTrack|SkinnedMesh/.test(src),
    '用了动画混合器或骨骼（任务要求顶点着色器 / 极简方案，不允许逐头 mixer）');
  // 狗与牛羊鸡共用 matHide（同一材质实例，shader 程序不增）
  ok((BSEG.match(/matHide/g) || []).length === 2, '身体与头必须共用 matHide（材质实例唯一）');
  // 尾巴顶点着色器：aFreq / aWag 属性 + 频率幅度走几何属性
  ok(/attribute float aFreq;/.test(src) && /attribute float aWag;/.test(src),
    '尾巴着色器缺 aFreq / aWag 属性（摇尾频率与幅度不可按种类配置）');
  ok(/sin\(uTime \* aFreq \+ _ph\) \* aTail \* aWag/.test(src), '尾巴摆动公式没有走 aFreq × aWag');

  /* ---------------- 3. 种类动作 ---------------- */
  const uStart = src.indexOf('const animalState = ');
  const uEnd = src.indexOf('return { root, pickables');
  ok(uStart > 0 && uEnd > uStart, '找不到 update() 家畜动画段');
  const USEG = uStart > 0 && uEnd > uStart ? src.slice(uStart, uEnd) : '';
  // 牛反刍：颌部水平慢摆 0.5 Hz、0.05 rad
  ok(/a\.kind === '牛'/.test(USEG) && /Math\.sin\(t \* 0\.5 \+ p \* 0\.7\) \* 0\.05 \* \(1 - graze\)/.test(USEG),
    '牛缺少反刍动作（颌部 0.5 Hz × 0.05 rad，不吃草时）');
  // 鸡啄食：pow4 锐脉冲 + 身体前倾 0.06 rad
  ok(/Math\.pow\(graze, 4\)/.test(USEG) && /peck \* 0\.06/.test(USEG),
    '鸡缺少「双啄一停」锐脉冲与啄食前倾');
  // 羊侧拉
  ok(/0\.10 \* graze/.test(USEG), '羊低头吃草缺少侧向拉草（0.10 rad）');
  // 狗：抬头 / 呼吸 / 避檐
  ok(/lift \* 0\.55/.test(USEG) && /Math\.sin\(t \* 1\.3 \+ p\) \* 0\.012/.test(USEG),
    '狗缺少抬头张望（0.55 rad）与呼吸（±1.2%）');
  ok(/a\.group\.position\.lerpVectors\(a\.base, a\.shelter, wetK\)/.test(USEG),
    '狗雨雪天没有向屋檐挪动');
  // 狗摇尾：几何属性 2.6 Hz × 0.35
  const gStart = src.indexOf("if (kind === '狗')");
  const gEnd = src.indexOf('/* ---- 躯干：椭球');
  ok(gStart > 0, 'makeAnimalGeo 缺少狗的卧姿分支');
  const GSEG = gStart > 0 ? src.slice(gStart, gEnd > gStart ? gEnd : src.length) : '';
  ok(/setTail\(tail, -0\.42, -0\.70, 2\.6, 0\.35\)/.test(GSEG) && /setTail\(tip, -0\.42, -0\.70, 2\.6, 0\.35\)/.test(GSEG),
    '狗尾巴摇动参数应为 2.6 Hz × 0.35（尾杆 + 毛球各一处）');
  // 牛羊鸡尾巴基准不变：默认参数 1.15 Hz × 1.0
  ok(/setTail\(geo, rootX, tipX, freq = 1\.15, wag = 1\)/.test(src), 'setTail 默认频率/幅度应保持 1.15 Hz × 1.0（牛羊与 v1.1 一致）');

  /* ---------------- 4. 雨雪避檐 ---------------- */
  ok(/climate\.sample\(hour\)/.test(USEG) && /s\.snow > 0\.01 \|\| s\.precip > 0\.05/.test(USEG),
    '雨雪判定必须来自 climate.sample(hour)（跟时间轴），口径与 updateWeather 一致');
  ok(/const dry = herd \* \(1 - wetK\)/.test(USEG), '踱步/吃草没有乘 (1 - wetK)（雨中应站着不动）');
  ok(/a\.shelter\.x - px\) \* wetK/.test(USEG) && /a\.shelter\.y - a\.base\.y\) \* wetK/.test(USEG),
    '牛羊鸡的位置没有按 wetK 混合到避雨点');
  const sStart = src.indexOf('const SHELTER = {');
  const sEnd = src.indexOf('function buildAnimal');
  const SSEG = sStart > 0 && sEnd > sStart ? src.slice(sStart, sEnd) : '';
  ok(/barn: \[46, 34\]/.test(SSEG), '牛羊避雨点应为东头畜圈 F-03（[46, 34]）');
  ok(/coops: \[\[-26\.12, -35\.47\], \[25\.77, 32\.69\]\]/.test(SSEG), '鸡避雨点应为 P-13 / P-14 两处鸡窝');
  ok(/h\.pos\[0\] \+ h\.yard\.w \* 0\.5 \+ 0\.65/.test(SSEG), '狗避雨点应为自家院墙根 0.65 m（屋檐下）');
  ok(/heightAt\(/.test(SSEG), '避雨点必须用 heightAt 贴地（雨中不悬空）');
  // animals.push 带 shelter
  ok(/shelter: new THREE\.Vector3\(sh\[0\], sh\[1\], sh\[2\]\)/.test(BSEG), 'animals 数组缺 shelter 字段');

  /* ---------------- 5. 暂停口径 ---------------- */
  ok(/function update\(hour = 0, climate = null, playing = true\)/.test(src),
    'update() 签名必须有 playing 参数（避雨过渡的暂停门控）');
  ok(/if \(playing\) \{\n      const dtA/.test(USEG), '避雨过渡 wetK 没有受 playing 门控（暂停必须定住）');
  ok(/微动作用实时钟|暂停时继续——环境动画口径|暂停时继续/.test(USEG),
    '缺少暂停口径注释（微动作实时钟继续 / 避雨过渡暂停定住，需写明并保持一致）');
  ok(/world\.update\(clock \? clock\.hour : 0, climate, clock \? clock\.playing : true\)/.test(main),
    'main.js 调用 update 时没有传 clock.playing');

  /* ---------------- 6. 随机序列零消耗 ---------------- */
  ok(/g\.rotation\.y = dog \? -0\.12 : between\(0, Math\.PI \* 2\)/.test(BSEG),
    '狗的朝向必须写死（不消耗 between），否则公共设施随机细节会位移');
  ok(/phase: dog \? 3\.3 : rnd\(\) \* 10/.test(BSEG), '狗的相位必须写死（不消耗 rnd）');
  // data.js 狗档案段：不调用 between / rnd
  const dStart = datajs.indexOf('看门狗（v1.2 牲畜微动作轮追加');
  const dEnd = datajs.indexOf('/* 牲畜归属');
  ok(dStart > 0 && dEnd > dStart, 'data.js 找不到狗档案段');
  const DSEG = dStart > 0 && dEnd > dStart ? datajs.slice(dStart, dEnd) : '';
  ok(!/between\(|rnd\(\)/.test(DSEG), 'data.js 狗档案字段必须写死（不消耗随机序列）');

  /* ---------------- 7. QA 行 ---------------- */
  ok(/world\.livestock/.test(main) && /避檐/.test(main), 'main.js ?qa=1 缺少 animals 汇总行');

  return { bad, problems };
}

let { bad, problems } = await runChecks(SRC, MAIN, DATAJS);

/* ---------------- 负向自测 ---------------- */
if (process.argv.includes('--self-test')) {
  let caught = 0, total = 3;
  // 破坏 1：拿掉 playing 门控（暂停时避雨过渡继续走 → 暂停口径检查应报错）
  const m1 = SRC.replace('if (playing) {\n      const dtA', 'if (true) {\n      const dtA');
  const r1 = await runChecks(m1, MAIN, DATAJS);
  if (r1.bad > 0) caught++; else console.log('✗ 破坏 1 未被抓到：暂停门控失效后检查仍通过');
  // 破坏 2：狗摇尾参数退化成牛尾基准（1.15 Hz × 1.0 → 看门狗甩大尾巴）
  const m2 = SRC.replaceAll('setTail(tail, -0.42, -0.70, 2.6, 0.35)', 'setTail(tail, -0.42, -0.70, 1.15, 1)')
    .replaceAll('setTail(tip, -0.42, -0.70, 2.6, 0.35)', 'setTail(tip, -0.42, -0.70, 1.15, 1)');
  const r2 = await runChecks(m2, MAIN, DATAJS);
  if (r2.bad > 0) caught++; else console.log('✗ 破坏 2 未被抓到：狗摇尾退化后检查仍通过');
  // 破坏 3：雨雪判定恒为 0（牲畜永远淋雨不避檐）
  const m3 = SRC.replace('animalState.wet = (s.snow > 0.01 || s.precip > 0.05) ? 1 : 0;', 'animalState.wet = 0;');
  const r3 = await runChecks(m3, MAIN, DATAJS);
  if (r3.bad > 0) caught++; else console.log('✗ 破坏 3 未被抓到：避雨判定失效后检查仍通过');
  console.log(`\n负向自测：${caught}/${total} 项破坏被检查抓到`);
  if (caught < total) { console.log('✗ 负向自测失败'); process.exit(1); }
  console.log('✓ 负向自测通过：脚本确实会报错');
}

/* ---------------- 汇总 ---------------- */
console.log('牲畜：17 头（牛 4 / 羊 6 / 鸡 6 / 看门狗 1），每只身体+头 2 Mesh 共用 matHide，draw call +2');
console.log('动作：牛反刍 0.5 Hz、鸡双啄一停、羊侧拉、狗抬头/呼吸/摇尾 2.6 Hz；全部实时钟，暂停继续（环境动画口径）');
console.log('避檐：雨雪判定走 climate.sample（跟时间轴），wetK 约 8 s 实时平滑、暂停定住；牛羊→畜圈、鸡→鸡窝、狗→屋檐');

if (bad) {
  console.log(`\n✗ ${bad} 项不合格：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log('\n✅ 全部通过');
process.exit(0);
