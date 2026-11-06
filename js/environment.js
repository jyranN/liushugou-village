/**
 * 环境驱动：把真实气象数据翻译成场景参数
 * 数据 → 太阳位置/强度/色温、天空色、云量、雾、曝光
 *
 * 全部输入都是连续的（太阳用天文公式逐帧解算），
 * 所以日出日落是一条平滑的曲线，不是逐小时跳一格。
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const C = {
  dayTop: [0x6b / 255, 0x88 / 255, 0xa4 / 255],
  dayBot: [0xb9 / 255, 0xc2 / 255, 0xc2 / 255],
  duskTop: [0x30 / 255, 0x3a / 255, 0x5e / 255],
  duskBot: [0xe8 / 255, 0x8e / 255, 0x4e / 255],
  nightTop: [0x06 / 255, 0x0a / 255, 0x16 / 255],
  nightBot: [0x14 / 255, 0x1a / 255, 0x24 / 255],
};

function blend(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

export function updateEnvironment(ctx, climate, hour, renderer, cameraY = 6) {
  const scene = ctx.scene || ctx.root?.parent;
  const s = climate.sample(hour);
  const sunInfo = climate.sunAt(hour);

  const sinAlt = sunInfo.sinAlt;        // -1 .. 1，连续的太阳高度正弦
  const alt = Math.max(0, sinAlt);      // 太阳在地平线以上时的“力”
  const dir = sunInfo.dir;

  /* ---------- 太阳 ---------- */
  const cloudF = clamp(s.cloud / 100, 0, 1);
  // 指数放软：太阳贴地时仍有一段明亮的金色时刻，不会刚落到 5° 就黑掉
  const sunPower = Math.pow(alt, 0.45) * 3.4 * (1 - cloudF * 0.72);

  const dist = 260;
  ctx.sun.position.set(
    dir.x * dist,
    Math.max(1.5, dir.y * dist),
    dir.z * dist
  );
  ctx.sun.intensity = sunPower;
  ctx.sun.target.position.set(0, 0, 0);
  ctx.sun.target.updateMatrixWorld();

  // 色温：贴地时橙红，升高后转白。用 sinAlt 而不是分档，颜色是连续变化的
  const warm = clamp(1 - alt / 0.26, 0, 1);
  const sc = ctx.sun.color;
  sc.setRGB(1.0, mix(1.0, 0.64, warm), mix(0.96, 0.38, warm));

  /* ---------- 天空 ----------
   * dayF：从天文暮光（-6°）到太阳升高 11° 之间连续过渡
   * skyF：天空比地面“晚一点黑”，日落时天幕还亮着，地面先暗下去，才有剪影感 */
  const dayF = smoothstep(-0.10, 0.20, sinAlt);
  const skyF = smoothstep(-0.17, 0.12, sinAlt);
  let top = blend(C.nightTop, C.dayTop, skyF);
  let bot = blend(C.nightBot, C.dayBot, skyF);

  // 地平线附近的暖调（晚霞/朝霞），峰值正好落在太阳贴地的那一刻
  const duskF = Math.exp(-Math.pow((sinAlt - 0.015) / 0.11, 2)) * (1 - cloudF * 0.45);
  top = blend(top, C.duskTop, duskF * 0.55);
  bot = blend(bot, C.duskBot, duskF * 0.78);

  // 云多时压低天色
  const grey = cloudF * 0.28;
  top = [top[0] * (1 - grey), top[1] * (1 - grey), top[2] * (1 - grey)];
  bot = [bot[0] * (1 - grey * 0.6), bot[1] * (1 - grey * 0.6), bot[2] * (1 - grey * 0.6)];

  ctx.skyUniforms.topColor.value.setRGB(top[0], top[1], top[2]);
  ctx.skyUniforms.botColor.value.setRGB(bot[0], bot[1], bot[2]);
  ctx.skyUniforms.uCoverage.value = clamp(1.02 - cloudF * 0.84, 0.12, 1.0);

  // 太阳圆盘：云厚时被遮住，落到地平线以下就收掉
  ctx.skyUniforms.uSunDir.value.set(dir.x, dir.y, dir.z);
  ctx.skyUniforms.uSunColor.value.copy(ctx.sun.color);
  ctx.skyUniforms.uSunI.value = smoothstep(-0.025, 0.015, sinAlt) * (1 - cloudF * 0.82);

  /* ---------- 环境光与补光 ---------- */
  // twi：贴着地平线时的“暮光补偿”。日落后天光仍然是主光源，
  // 这一段如果只按太阳高度线性衰减，画面会在半小时内从白天直接掉进黑夜。
  const twi = Math.exp(-Math.pow(sinAlt / 0.13, 2));
  ctx.hemi.intensity = mix(0.13, 0.34, dayF) * (1 - cloudF * 0.18) + twi * 0.24;
  ctx.hemi.color.setRGB(
    mix(mix(0.10, 0.65, dayF), 0.66, twi * 0.85),
    mix(mix(0.13, 0.74, dayF), 0.50, twi * 0.85),
    mix(mix(0.22, 0.80, dayF), 0.38, twi * 0.85)
  );
  ctx.bounce.intensity = mix(0.01, 0.12, dayF) + twi * 0.03;

  /* 月光：入夜后接手主光，冷蓝色、从太阳的反方向斜上方打下来。
   * 没有这盏灯，夜里除了窗灯就是纯黑，什么也看不到。 */
  if (ctx.moon) {
    const nightF = 1 - smoothstep(-0.17, -0.015, sinAlt);
    ctx.moon.intensity = nightF * 0.95 * (1 - cloudF * 0.45);
    ctx.moon.position.set(-dir.x * 150, 130, -dir.z * 150);
    ctx.moon.color.setRGB(0.60, 0.70, 0.95);
  }

  /* ---------- 雾：湿度高 / 有降水时更浓 ---------- */
  const humidFog = clamp((s.humi - 78) / 22, 0, 1);
  // 基础雾不可为 0：没有空气散射，画面会显得又平又薄。
  // 但高空俯瞰时必须减雾 —— 否则 200 米视距下整个村子会被雾吃掉。
  const heightFade = clamp(1 - (cameraY - 10) / 130, 0.14, 1);
  const fogDensity = (0.0022 + humidFog * 0.0030 + clamp(s.precip * 0.02, 0, 0.0028)) * heightFade;
  if (scene?.fog) {
    scene.fog.density = fogDensity;
    scene.fog.color.setRGB(bot[0], bot[1], bot[2]);
  }

  /* ---------- 物候：返青 → 盛绿 → 枯黄 ---------- */
  const doy = s.dayOfYear;
  const green = clamp(smoothstep(72, 132, doy) * (1 - smoothstep(282, 328, doy)), 0, 1);
  if (ctx.seasonUniform) ctx.seasonUniform.value = green;

  /* ---------- 曝光 ---------- */
  // 没有自动测光，就人工补一段“眼睛适应”：日落后曝光抬上去，画面不会突然黑掉
  const exposure = mix(0.74, 0.94, dayF) + twi * 0.22;
  renderer.toneMappingExposure = exposure;

  /* ---------- HDRI 环境光强度 ----------
   * three r160 没有 scene.environmentIntensity（r163 才加入），
   * HDRI 的间接光在深夜也会全开，必须按昼夜驱动材质的 envMapIntensity。
   * 材质集合在首帧后缓存，避免每帧遍历整个场景图。 */
  const envI = mix(0.075, 0.24, dayF) * (1 - cloudF * 0.35) + twi * 0.05;
  if (!scene.__envMats) {
    scene.__envMats = new Set();
    scene.traverse((o) => { if (o.material) scene.__envMats.add(o.material); });
  }
  for (const m of scene.__envMats) {
    if ('envMapIntensity' in m) m.envMapIntensity = envI;
    // 远山用 MeshBasic + 预烘明暗，昼夜亮度靠这里调，避免夜里还亮着
    if (m.userData?.isMountain) {
      const f = mix(0.22, 1.0, dayF);
      // 基础反射率与地形同一档，远山才不会过曝成一片片白斑
      m.color.setRGB(f * 0.42, f * 0.45, f * 0.40);
    }
  }
  scene.environmentIntensity = envI;

  /* ---------- 降水：类型、地面积雪、地面湿润 ----------
   * 全部来自岷县 2025 逐小时实测：snowfall(cm) / precipitation(mm) / temperature。
   * 积雪按最近 72 小时累计降雪估算，气温高于 2.5℃ 时逐步消融，
   * 所以拖动时间轴时雪会随真实天气过程堆积、化掉，不是固定贴图。
   * 这两项变化很慢，按 1/12 小时缓存，省掉每帧 28 次取样的开销。 */
  const wxKey = Math.round(hour * 12);
  if (ctx.__wxKey !== wxKey) {
    ctx.__wxKey = wxKey;
    let snowAcc = 0;
    for (let k = 0; k < 24; k++) {
      const p = climate.at(hour - k * 3);
      if (p.snow > 0) snowAcc += p.snow * 3;
      else if (p.temp > 2.5) snowAcc *= 0.90;
    }
    let wetAcc = 0;
    for (let k = 0; k < 4; k++) wetAcc += climate.at(hour - k).precip;
    ctx.__wx = { snowAcc, wetAcc };
  }
  const snowCover = clamp(ctx.__wx.snowAcc / 3.2, 0, 1) * (s.temp > 4 ? 0.25 : 1);
  const wet = clamp(ctx.__wx.wetAcc / 5, 0, 1) * (snowCover > 0.3 ? 0.15 : 1);
  const isSnow = s.snow > 0.01 || (s.precip > 0.02 && s.temp < 0.5);
  if (ctx.weatherUniforms) {
    ctx.weatherUniforms.snow.value = snowCover;
    ctx.weatherUniforms.wet.value = wet;
  }

  /* ---------- 夜间照明：路灯、窗灯 ----------
   * 用光敏开关式的曲线：日落后渐亮，日出后 6° 左右才熄灭 */
  const lampF = 1 - smoothstep(-0.03, 0.10, sinAlt);
  if (ctx.lampGlowMat) ctx.lampGlowMat.emissiveIntensity = lampF * 4.2;
  if (ctx.lampLights) for (const l of ctx.lampLights) l.intensity = lampF * 26;
  if (ctx.glassMat) {
    ctx.glassMat.emissive.setRGB(1.0, 0.68, 0.38);
    ctx.glassMat.emissiveIntensity = lampF * 1.5;
  }

  return {
    date: s.time.slice(0, 10),
    hourOfDay: s.hourOfDay,
    temp: s.temp,
    humi: s.humi,
    cloud: s.cloud,
    precip: s.precip,
    snow: s.snow,
    wind: s.wind,
    code: s.code,
    isDay: sinAlt > 0,
    sunAlt: sinAlt,
    sunElevation: sunInfo.elevation,
    green,
    doy,
    isSnow,
    snowCover,
    wet,
    rainRate: isSnow ? 0 : s.precip,
    snowRate: isSnow ? Math.max(s.snow, s.precip * 0.12) : 0,
  };
}
