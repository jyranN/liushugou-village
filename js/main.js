/**
 * 入口：初始化渲染、场景、交互、主循环
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildWorld } from './world.js';
import { Climate, Clock, DEFAULT_SPEED, findWeatherPresets } from './climate.js';
import { Assets } from './assets.js';
import { updateEnvironment } from './environment.js';
import { Rig } from './controls.js';
import { Tour } from './tour.js';
import * as UI from './ui.js';
import { ALL_OBJECTS } from './data.js';

const canvas = document.getElementById('scene');

/* ---------- 渲染器 ---------- */
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});

/* ---------- 画质三档 ----------
 * 每档决定四件事：渲染像素比、GTAO 开关、泛光开关、阴影贴图边长。
 * 阴影边长换了必须丢掉旧贴图才会重建，见 setShadowSize()。
 */
const QUALITY = {
  low:  { key: 'low',  label: '流畅', scale: 1.0,  ao: false, bloom: false, shadow: 1024 },
  mid:  { key: 'mid',  label: '均衡', scale: 1.25, ao: false, bloom: true,  shadow: 2048 },
  high: { key: 'high', label: '精致', scale: 1.5,  ao: true,  bloom: true,  shadow: 3072 },
};
const QUALITY_KEY = 'liushugou.quality';
const readQuality = () => {
  try { return QUALITY[localStorage.getItem(QUALITY_KEY)] ? localStorage.getItem(QUALITY_KEY) : 'mid'; }
  catch { return 'mid'; }
};

const QS = new URLSearchParams(location.search);
// 调试：?quality=low|mid|high 临时覆盖（不写回 localStorage）
let qualityKey = QUALITY[QS.get('quality')] ? QS.get('quality') : readQuality();
let quality = QUALITY[qualityKey];

// 分辨率不再固定 2 倍：先给一个保守值，运行中按帧率自动升降
// 上限跟着画质档走：2 倍屏上 1.5 的像素数是 1.0 的 2.25 倍
let maxScale = Math.min(window.devicePixelRatio || 1, quality.scale);
const MIN_SCALE = 0.62;
// 档位即实值：用户选「均衡」就按 1.25 渲染，自适应不许私自降档；
// 只有帧率崩到 20 以下（明显卡顿）时才在档位的 90% 处兜一下
let minScale = Math.max(MIN_SCALE, maxScale * 0.9);
let renderScale = maxScale;
// 调试：?fixedscale=1 关掉自适应，?scale=1.2 直接指定倍率
const FIXED_SCALE = QS.has('fixedscale') || QS.has('scale');
if (QS.has('scale')) renderScale = Math.max(0.5, Math.min(2, Number(QS.get('scale')) || 1));

renderer.setPixelRatio(renderScale);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 1.16 → 1.20：关掉 GTAO 后暗部少了压暗，稍抬曝光把层次补回来
renderer.toneMappingExposure = 1.20;
renderer.shadowMap.enabled = true;
// PCFSoft 每个采样点要做 5 次双线性插值，PCF 只做 1 次；贴图缩到 2048 后 PCFSoft 的
// 额外柔化几乎看不出，换成 PCF 省下的是实打实的片元开销
renderer.shadowMap.type = THREE.PCFShadowMap;
// 阴影只在太阳明显移动时重算，不然每帧都要把整个村子重画一遍
renderer.shadowMap.autoUpdate = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3400);

/* ---------- 后处理：环境光遮蔽 + 微泛光 + 色调输出 ---------- */
const rt = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  type: THREE.HalfFloatType,
  samples: 2,
});
const composer = new EffectComposer(renderer, rt);
composer.setSize(window.innerWidth, window.innerHeight);

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// GTAO：屏幕空间的地面环境光遮蔽。
// 换掉 SSAOPass 的原因：SSAO 会自己重渲染一遍场景，丢掉色调映射，整幅画面发灰。
//
// 只有「精致」档才用它（?ao=1 可强制打开做对比）。它每帧要多跑一遍法线/深度
// 预通道 + 一次去噪 + 一次合成（三次全屏 pass），是低端机上掉帧的头号开销；
// 而村落这种开阔场景里真正被遮蔽的只有墙角、屋檐下几处。
// 平时连它的渲染目标都不创建，从「精致」切走时只关 enabled，不销毁，切回来是零成本。
let gtaoPass = null;
function ensureGtao() {
  if (gtaoPass) return gtaoPass;
  gtaoPass = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  // radius 太大会把路面两侧的草和地形当成遮挡物，在路中间压出一条假沟
  gtaoPass.updateGtaoMaterial({
    radius: 0.19, distanceExponent: 2.0, thickness: 0.6,
    scale: 0.9, samples: 8, distanceFallOff: 1.6, screenSpaceRadius: false,
  });
  // depthPhi 收紧：天空在深度上是最远平面，原值会让 GTAO 跨边缘采样，在天上压出一条带
  gtaoPass.updatePdMaterial({
    lumaPhi: 10, depthPhi: 0.45, normalPhi: 1.2, radius: 3,
    radiusExponent: 1, rings: 2, samples: 12,
  });
  // 紧跟 RenderPass，顺序与原来一致：RenderPass → GTAO → Bloom → Output
  // insertPass 内部会按当前像素比给这个 pass 分配渲染目标
  composer.insertPass(gtaoPass, 1);
  return gtaoPass;
}
const FORCE_AO = QS.get('ao') === '1';

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.22,   // 强度：只让天空与高光轻微溢出
  0.55,   // 半径
  0.94    // 阈值
);
composer.addPass(bloomPass);

composer.addPass(new OutputPass());

let world = null;
let rig = null;
let boxHelper = null;
let climate = null;
let clock = null;
let tour = null;
const NO_POST = new URLSearchParams(location.search).has('nopost');

/* ---------- 拾取 ---------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const objectById = new Map(ALL_OBJECTS.map((o) => [o.id, o]));
let hovered = null;

function pickAt(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(world.pickables, false);
  if (!hits.length) return null;
  const id = hits[0].object.userData.objectId;
  return { id, obj: objectById.get(id), hit: hits[0] };
}

/* ---------- 选中高亮 ---------- */
function setHighlight(proxyMesh) {
  if (boxHelper) { scene.remove(boxHelper); boxHelper.dispose(); boxHelper = null; }
  if (!proxyMesh) return;
  boxHelper = new THREE.BoxHelper(proxyMesh, 0x7fe3c0);
  boxHelper.material.depthTest = false;
  boxHelper.material.transparent = true;
  boxHelper.material.opacity = 0.9;
  boxHelper.renderOrder = 999;
  scene.add(boxHelper);
}

/* ---------- 事件 ---------- */
let downAt = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  downAt.x = e.clientX;
  downAt.y = e.clientY;
});

canvas.addEventListener('pointerup', (e) => {
  const dist = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  if (dist > 6) return;                    // 拖动过，视为旋转而非点击

  const hit = pickAt(e.clientX, e.clientY);
  if (hit) {
    UI.showCard(hit.obj);
    setHighlight(world.pickables.find((p) => p.userData.objectId === hit.id));
    if (!rig.isWalk) rig.focus(hit.hit.point, 44);
  } else {
    UI.hideCard();
    setHighlight(null);
  }
});

let hoverAt = null;
let hoverTimer = 0;
/** 悬停拾取：不跟鼠标事件同步跑，每 90ms 至多一次，避免移动鼠标时掉帧 */
function updateHover(dt) {
  if (!hoverAt) return;
  hoverTimer += dt;
  if (hoverTimer < 0.09) return;
  hoverTimer = 0;
  const hit = pickAt(hoverAt.x, hoverAt.y);
  hovered = hit ? hit.obj : null;
  canvas.style.cursor = hit ? 'pointer' : 'grab';
}

canvas.addEventListener('pointermove', (e) => {
  if (rig && rig.dragging) { canvas.style.cursor = 'grabbing'; hoverAt = null; return; }
  hoverAt = { x: e.clientX, y: e.clientY };
});

window.addEventListener('keydown', (e) => {
  // 巡游中：Esc 中断，其余键全部吞掉（controls.js 也会因 locked 忽略）
  if (tour && tour.active) {
    if (e.code === 'Escape') tour.stop();
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape') {
    if (UI.isCardOpen()) { UI.hideCard(); setHighlight(null); }
    else if (rig.isWalk) { rig.exitWalk(); UI.setMode('orbit'); }
  }
  if (e.code === 'KeyF') {
    if (rig.isWalk) { rig.exitWalk(); UI.setMode('orbit'); }
    else { rig.enterWalk(); UI.setMode('walk'); }
  }
  // 空格：播放 / 暂停时间
  if (e.code === 'Space' && clock && !e.repeat) {
    clock.playing = !clock.playing;
  }
});

/* ---------- 模式按钮 ---------- */
document.querySelectorAll('.mode-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (m === 'walk') { rig.enterWalk(); UI.setMode('walk'); }
    else { rig.exitWalk(); UI.setMode('orbit'); }
  });
});

document.getElementById('btnReset').addEventListener('click', () => {
  rig.reset();
  UI.hideCard();
  setHighlight(null);
});

/* ---------- 自适应分辨率 ---------- */
function applyRenderScale(s) {
  if (Math.abs(s - renderScale) < 0.001) return;
  renderScale = s;
  renderer.setPixelRatio(s);
  // 后处理的目标缓冲必须跟着走，否则 GTAO/Bloom 还停在旧分辨率上
  composer.setPixelRatio(s);
}

/* ---------- 画质档位：切换时逐项落地 ---------- */
/** 阴影贴图边长。three 只在 shadow.map 为 null 时新建，所以换尺寸必须先丢掉旧贴图 */
function setShadowSize(px) {
  const sun = world && world.sun;
  if (!sun) return;
  const sh = sun.shadow;
  if (sh.mapSize.x === px) return;
  sh.mapSize.set(px, px);
  if (sh.map) { sh.map.dispose(); sh.map = null; }
  renderer.shadowMap.needsUpdate = true;
}

function applyQuality(key, { persist = true } = {}) {
  qualityKey = QUALITY[key] ? key : 'mid';
  quality = QUALITY[qualityKey];

  maxScale = Math.min(window.devicePixelRatio || 1, quality.scale);
  minScale = Math.max(MIN_SCALE, maxScale * 0.9);
  if (!FIXED_SCALE) {
    // 换档直接落到该档的像素比，不留在自适应过程中间值上
    applyRenderScale(maxScale);
  }

  if (quality.ao || FORCE_AO) ensureGtao().enabled = true;
  else if (gtaoPass) gtaoPass.enabled = false;

  bloomPass.enabled = quality.bloom;
  setShadowSize(quality.shadow);

  // 换档这一两帧有卡顿（重建阴影贴图、分配后处理目标），不能让它算进帧率统计，
  // 否则会被自适应误判成"太慢"而把像素比压到下限，且要等回到 57 FPS 才升得回来
  perfAcc = 0; perfN = 0; perfCheck = 0; perfWarm = 0; lastScaleChange = performance.now();

  if (persist) { try { localStorage.setItem(QUALITY_KEY, qualityKey); } catch { /* 隐私模式忽略 */ } }
  UI.setQuality(qualityKey);
}

/* ---------- 窗口尺寸 ---------- */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(renderScale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------- 主循环 ---------- */
let lastFrame = performance.now();
let frames = 0, fpsTime = 0;
let perfAcc = 0, perfN = 0, perfCheck = 0, perfWarm = 0, lastScaleChange = 0;
let shadowTimer = 0, shadowAlt = 999, shadowDirty = true;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  // rawDt 用来量帧率，dt 做钳制避免切标签页回来时世界一下子跳很远
  const realDt = (now - lastFrame) / 1000;
  const rawDt = Math.min(realDt, 0.25);
  const perfDt = Math.min(realDt, 1.5);   // 量帧率用真实间隔，否则低于 4fps 时永远显示 4 FPS
  lastFrame = now;
  const dt = Math.min(rawDt, 0.05);

  // 巡游接管相机时不跑 orbit/walk 的阻尼，结束后 rig 参数已同步，不会跳
  if (tour && tour.active) tour.update(dt);
  else if (rig) rig.update(dt);
  if (world) world.update();

  if (clock && climate) {
    clock.advance(dt);
    const wx = updateEnvironment(world, climate, clock.hour, renderer, camera.position.y);
    UI.updateTimebar(clock, wx);
    window.__wx = wx;
    world.updateWeather(wx, camera, dt);

    /* 阴影按需重算：太阳转过约 0.09° 才重画一次 shadow map，
     * 每秒最多 5 次。省下的是一整遍全场景深度渲染，手感差别很明显。 */
    shadowTimer += dt;
    const sunUp = wx.sunAlt > 0.015;
    if (sunUp && (shadowDirty || (shadowTimer > 0.2 && Math.abs(wx.sunAlt - shadowAlt) > 0.0015))) {
      renderer.shadowMap.needsUpdate = true;
      shadowAlt = wx.sunAlt;
      shadowTimer = 0;
      shadowDirty = false;
    }
  }

  updateHover(dt);

  if (boxHelper) boxHelper.update();
  if (NO_POST) renderer.render(scene, camera);
  else composer.render();

  // 雨雪单独叠加：不进主场景，避免污染 GTAO 的深度/法线预通道
  if (world.weatherScene) {
    renderer.autoClear = false;
    renderer.render(world.weatherScene, camera);
    renderer.autoClear = true;
  }

  frames++;
  fpsTime += perfDt;
  if (fpsTime > 0.5) {
    document.getElementById('fps').textContent = `${Math.round(frames / fpsTime)} FPS`;
    frames = 0; fpsTime = 0;
  }

  /* 自适应分辨率：兜底用。
   * 画质档位是用户明确选的，正常情况下不插手——私自降档等于把画质偷走。
   * 只有帧率崩到 20 以下（明显卡顿）才在档位的 90% 内降一点，恢复后升回档位值。 */
  perfWarm += perfDt;
  if (!FIXED_SCALE && perfWarm > 2.5) {
    perfAcc += perfDt; perfN++; perfCheck += perfDt;
    if (perfCheck > 0.8) {
      const avg = perfN / perfAcc;
      perfAcc = 0; perfN = 0; perfCheck = 0;
      const t = performance.now();
      if (!document.hidden && t - lastScaleChange > 1000) {
        if (avg < 20 && renderScale > minScale + 0.001) {
          applyRenderScale(Math.max(minScale, renderScale - 0.12));
          lastScaleChange = t;
        } else if (avg > 45 && renderScale < maxScale - 0.01) {
          applyRenderScale(Math.min(maxScale, renderScale + 0.07));
          lastScaleChange = t;
        }
      }
    }
  }
}

/* ---------- 启动 ---------- */
UI.initHud();
UI.initLoader('正在生成地形与材质…');

async function boot() {
  try {
    climate = await Climate.load();
    await Assets.load(renderer);
    if (Assets.env) {
      scene.environment = Assets.env;
      scene.environmentIntensity = 0.22;
    }

    world = buildWorld(scene, Assets);
    // 落脚高度用 walkHeightAt：与 heightAt 一致，额外把桥面算进去
    rig = new Rig(camera, canvas, world.walkHeightAt);
    // 开场从稍高处缓降下来，第一帧就在正确位置，不会先跳一下
    rig.radius = 300;
    rig.radiusGoal = 190;
    clock = new Clock(climate);
    // 起步时间：可用 ?day=131&hour=10 指定，默认 5 月中旬上午
    const qp = new URLSearchParams(location.search);
    const dParam = Number(qp.get('day'));
    const hParam = Number(qp.get('hour'));
    const day = Number.isFinite(dParam) && dParam > 0 ? dParam : 131;
    const hh = Number.isFinite(hParam) && hParam >= 0 ? hParam : 10;
    clock.hour = (day - 1) * 24 + hh;
    clock.setSpeed(qp.has('speed') ? Number(qp.get('speed')) : DEFAULT_SPEED);
    if (qp.get('pause') === '1') { clock.playing = false; clock._rate = 0; }

    // 首帧必须把阴影烘出来（贴图尺寸由画质档决定，等 world 建好后才能设）
    applyQuality(qualityKey, { persist: false });
    renderer.shadowMap.needsUpdate = true;

    UI.bindJoystick(rig);
    UI.bindTimebar(clock);
    UI.bindQuality((k) => applyQuality(k));
    UI.bindWxPresets(findWeatherPresets(climate), (p) => {
      // 直接跳到实测时刻并停住，否则时间条一走就离开那一刻了
      clock.hour = p.index;
      clock.playing = false;
      clock._rate = 0;
      UI.syncPlayBtn(clock);
    });
    tour = new Tour({
      camera, rig, world,
      layer: document.getElementById('tourLayer'),
      caption: document.getElementById('tourCaption'),
      onState: (on) => {
        const b = document.getElementById('tourBtn');
        b.classList.toggle('on', on);
        b.textContent = on ? '结束巡游' : '巡游';
        if (on) UI.hideCard();
      },
    });
    document.getElementById('tourBtn').addEventListener('click', () => {
      if (!tour) return;
      if (tour.active) { tour.stop(); return; }
      // 与第一人称互斥：先退出来再巡游
      if (rig.isWalk) { rig.exitWalk(); UI.setMode('orbit'); }
      tour.start();
    });

    UI.setMode('orbit');
    animate();

    // 调试用：?tx=&tz=&r=&phi= 直接把相机对准某个位置
    if (qp.has('tx')) {
      const tx = Number(qp.get('tx')) || 0;
      const tz = Number(qp.get('tz')) || 0;
      const r = Number(qp.get('r')) || 14;
      const phi = Number(qp.get('phi')) || 1.36;
      const ty = Number(qp.get('ty')) || 0;
      rig.target.set(tx, ty, tz);
      rig.targetGoal.set(tx, ty, tz);
      rig.radius = rig.radiusGoal = r;
      rig.theta = rig.thetaGoal = Number(qp.get('theta')) || 0;
      rig.phi = rig.phiGoal = phi;
    }

    UI.hideLoader();

    window.__app = { world, rig, scene, camera, renderer, UI, objectById, climate, clock, tour,
      getRenderScale: () => renderScale, applyRenderScale, applyQuality,
      // 画质档位的真实运行态（自证/排查用）
      getQuality: () => ({
        key: qualityKey,
        label: quality.label,
        目标像素比: quality.scale,
        实际像素比: +renderer.getPixelRatio().toFixed(3),
        自适应上限: +maxScale.toFixed(3),
        GTAO: !!gtaoPass && gtaoPass.enabled,
        泛光: bloomPass.enabled,
        阴影贴图声明: world.sun.shadow.mapSize.x,
        阴影贴图实体: world.sun.shadow.map ? world.sun.shadow.map.width : null,
      }),
      getPerf: () => ({ warm: +perfWarm.toFixed(2), check: +perfCheck.toFixed(2), n: perfN, acc: +perfAcc.toFixed(2), scale: renderScale }) };

    if (new URLSearchParams(location.search).has('qa')) {
      window.__qaErrors = [];
      window.addEventListener('error', (e) => window.__qaErrors.push(e.message));
      {
        const out = [];
        try {
          rig.radius = 190; rig.radiusGoal = 190; rig.update(0.016);
          out.push(`pickables   ${world.pickables.length}`);
          out.push(`objects     ${objectById.size}`);
          out.push(`climate     ${climate.n} h`);
          out.push(`date        ${window.__wx?.date} ${clock.label.slice(11, 16)}`);
          out.push(`speed       ${clock.secondsPerDay}s/day  rate ${clock.rate.toFixed(3)} h/s`);
          out.push(`renderScale ${renderScale.toFixed(2)}  shadows ${renderer.shadowMap.autoUpdate ? '每帧' : '按需'}`);
          out.push(`temp/cloud  ${window.__wx?.temp.toFixed(1)}℃ / ${Math.round(window.__wx?.cloud)}%`);
          out.push(`cover       ${world.skyUniforms.uCoverage.value.toFixed(2)}`);
          out.push(`sunPower    ${world.sun.intensity.toFixed(2)}`);
          out.push(`fog         ${scene.fog ? scene.fog.density.toFixed(5) : 'NULL'}`);
          out.push(`green uni   ${world.seasonUniform?.value?.toFixed(3)}  wx.green ${window.__wx?.green?.toFixed(3)}`);
          out.push(`sky cover   ${world.skyUniforms.uCoverage.value.toFixed(2)}`);
          out.push(`crops       ${world.getCropCount()}  groundY ${world.cropMesh ? world.cropMesh.count : '-'}`);
          if (world.cropMesh) {
            const cm = world.cropMesh.material;
            const img = cm.map?.image;
            let alphaInfo = 'no-image';
            if (img && img.getContext) {
              const c2 = img.getContext('2d');
              const d = c2.getImageData(0, 0, img.width, img.height).data;
              let zero = 0, full = 0;
              for (let i = 3; i < d.length; i += 4) { if (d[i] < 8) zero++; else if (d[i] > 240) full++; }
              const total = d.length / 4;
              alphaInfo = `透明 ${(zero / total * 100).toFixed(0)}% 实心 ${(full / total * 100).toFixed(0)}%`;
            }
            out.push(`cropMat     map:${cm.map ? 'yes' : 'NULL'} aTest:${cm.alphaTest} ${alphaInfo}`);
          }

          const proxy = world.pickables[20];
          const obj = objectById.get(proxy.userData.objectId);
          UI.showCard(obj);
          const card = document.getElementById('card');
          out.push(`card        ${card.classList.contains('open')} / ${card.querySelectorAll('.row').length} 行`);
          UI.hideCard();

          rig.enterWalk();
          rig.update(0.016);
          out.push(`mode        ${rig.mode}  eye ${camera.position.y.toFixed(2)}m`);
          out.push(`errors      ${window.__qaErrors.length}`);
        } catch (e) {
          out.push('QA 异常: ' + e.message);
        }
        const box = document.createElement('pre');
        box.style.cssText = 'position:fixed;left:24px;top:132px;z-index:9999;'
          + 'background:rgba(0,0,0,.86);color:#7fe3c0;font:12px/1.9 "SF Mono",monospace;'
          + 'padding:16px 20px;border-radius:6px;border:1px solid rgba(127,227,192,.35);white-space:pre';
        box.textContent = out.join('\n');
        document.body.appendChild(box);
      }
    }
  } catch (err) {
    console.error(err);
    document.getElementById('loaderText').textContent =
      `构建失败：${err.message}（详见控制台）`;
    const ring = document.querySelector('.ring');
    if (ring) ring.style.display = 'none';
  }
}

boot();
