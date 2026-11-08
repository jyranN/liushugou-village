/**
 * 场景装配：地形、天空、光照、道路、民居、树木、家畜、公共设施、田块
 * 所有可点选物体都挂一个不可见代理盒，射线只打代理，保证拾取精准且省性能
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TEX from './textures.js';
import { HOUSES, TREES, ANIMAL_LIST, FACILITIES, FIELDS, YARD_DETAILS, ROAD, VILLAGE,
  RIVER, riverCenterX, STONES, MILLSTONE, CISTERNS } from './data.js';

/* ---------- 地形噪声 ---------- */
const hash = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f); f *= 2; amp *= 0.5; }
  return v;
}

/** 地面底板高度：村所在的川地平坦，向外抬升为岷山北麓的丘陵 */
function baseHeight(x, z) {
  const d = Math.hypot(x * 0.85, z * 1.0);
  const flat = Math.min(1, Math.max(0, (d - 100) / 155));
  const ridge = (fbm(x * 0.0055, z * 0.0055, 4) - 0.42) * 96;
  const ripple = (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 2.4;
  return ridge * flat * flat + ripple * Math.min(1, flat * 3);
}

/* ================= 村东山：一座孤山 =================
 * 位置是算过的：中心 (170,20)，山脚半径 75 → 西缘落在 x≈95，
 * 最东侧的田（L-14「梁上地」）东北角伸到 x≈103，但那一带山脚只抬起十几厘米，
 * 不会真的压住田面。半径不要放大，放大就会啃进田里。
 */
const HILL = { x: 170, z: 20, rx: 75, rz: 68, rot: -0.10, top: 58 };

const sm01 = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** 山顶要落在绝对高度 58 m，所以抬升量按"58 − 当地底板"折算 */
const HILL_LIFT = HILL.top - baseHeight(HILL.x, HILL.z);

/** 山体抬升量（米）。返回 0 表示这一点不在山上 */
function hillLift(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  if (dx * dx + dz * dz > HILL.rx * HILL.rx) return 0;   // 粗筛，绝大多数点不进三角函数
  const c = Math.cos(HILL.rot), s = Math.sin(HILL.rot);
  const lx = dx * c + dz * s;                            // 转到山的局部坐标（略压成椭圆）
  const lz = -dx * s + dz * c;
  const r = Math.hypot(lx / HILL.rx, lz / HILL.rz);
  if (r >= 1) return 0;
  const t = 1 - r;                                       // 0=山脚，1=山顶
  // 二次衰减：山脚平缓、山腰最陡、山顶收圆；两端斜率为 0，与川地无缝接上
  const prof = sm01(t);

  // 等高线扰动只加在高度上，且在峰、脚两处都衰减到 0：
  // 山顶仍精确等于 HILL.top，山脚半径仍是 75（半径不能改）
  const ang = Math.atan2(lz, lx);
  const lobe = Math.sin(ang * 2 + 0.7) * 1.05
    + Math.sin(ang * 3 - 2.1) * 0.72
    + Math.sin(ang * 5 + 1.2) * 0.34;
  let h = HILL_LIFT * (prof + t * t * (1 - t) * (1 - t) * lobe * 2.2);

  // 坡面起伏：整座山不该是抛光过的曲面，峰和脚同样衰减到 0
  h += (fbm(x * 0.05, z * 0.05, 3) - 0.5) * 2.8 * (t * (1 - t) * 4);
  // 放射状冲沟：七道浅沟从山顶挂下来，侧光时能看出坡面是"有沟壑的"
  h += Math.sin(ang * 7 + 0.4) * 1.7 * (t * (1 - t) * 4);

  // 北侧伸出一道小山梁（长在主体内，不影响山脚半径），破掉对称的圆锥感
  const sx = x - 152, sz = z + 24;
  h += 9.5 * Math.exp(-(sx * sx + sz * sz) / (2 * 21 * 21)) * (t * (1 - t) * 4);

  // 西麓耕地让位：数据里 L-14「梁上地」东北角实际到 (103.1, -5.2)，
  // 比「最东的田到 x=91」这个设计前提更靠东，山脚西缘 x≈95 会擦到田角约 0.35 m。
  // 山脚半径按设计不动，只在这块田的占地内把抬升削到 4 cm 以内（田面是刚性平面，
  // 超过 8 cm 就会被山脚顶穿）；出田界 6 m 内平滑接回。
  // x=95 的山脚零点、(170,20) 的 58 m 山顶都不在这块窗口里，不受影响。
  const kx = Math.max(68 - x, x - 104, 0), kz = Math.max(-30 - z, z - 2, 0);
  const kd = Math.hypot(kx, kz);
  if (kd < 6) {
    const w = 1 - sm01(kd / 6);
    h += (Math.min(h, 0.04) - h) * w;
  }
  return h;
}

/* 山腰上的两块人工台地：庙基 + 庙前老槐的树盘。
 * r 以内完全压平，到 blend 处平滑接回山坡，免得屋基和树根一半悬空。 */
const PAD = { x: 140, z: 20, r: 4.8, blend: 14 };       // 庙基（下面搭庙时用）
const TREE_PAD = { x: 147, z: 28, r: 2.6, blend: 7 };   // 老槐树盘
const rawHeight = (x, z) => baseHeight(x, z) + hillLift(x, z);

// 台地标高取「上游台地处理完之后」的地形，避免两块台地叠出一个鼓包
const PADS = [];
for (const p of [PAD, TREE_PAD]) {
  let y = rawHeight(p.x, p.z);
  for (const q of PADS) {
    const pd = Math.hypot(p.x - q.x, p.z - q.z);
    if (pd >= q.blend) continue;
    const w = 1 - sm01((pd - q.r) / (q.blend - q.r));
    y += (q.y - y) * w;
  }
  PADS.push({ ...p, y });
}

/* ================= 村西小河：河谷横截面 =================
 * 河床是恒定标高 RIVER.bedY(-2.2m)，沿河 5 个取样点数值完全一致；
 * 从中心到 half=6m 用 sm01 把 2.2m 抬回岸顶，两端导数都是 0，
 * 所以谷底圆、岸坡平滑、与川地无缝，不会出现断崖；
 * 6~9m 这一段再接回原始大地形（村外两端的高差在这里被吸收）。
 * 常水位 waterY=-0.6m，与坡面的交线落在 |d|≈3.88m，
 * 也就是"河宽 8 米"读的是常水位水面宽，岸上还留着干河滩。
 */
function riverHeight(x, z) {
  if (z < RIVER.z0 - 12 || z > RIVER.z1 + 12) return rawHeight(x, z);
  const d = Math.abs(x - riverCenterX(z));
  if (d >= RIVER.out) return rawHeight(x, z);
  const groove = RIVER.bedY + RIVER.depth * sm01(Math.min(1, d / RIVER.half));
  const t = sm01((d - RIVER.half) / (RIVER.out - RIVER.half));
  return groove * (1 - t) + rawHeight(x, z) * t;
}

/** 漫水桥：桥面只比常水位高 0.30m，汛期水直接从桥上漫过去，不设栏杆 */
const BRIDGE = {
  z: 18,
  x: riverCenterX(18),
  halfL: 8.0, halfW: 1.7,
  deckY: RIVER.waterY + 0.30,
};

export function heightAt(x, z) {
  let h = riverHeight(x, z);
  // 两处台地的影响范围都在 x∈[126,154]、z∈[6,35]，村内绝大多数顶点直接跳过
  if (x < 120 || x > 160 || z < 4 || z > 40) return h;
  for (const p of PADS) {
    const pd = Math.hypot(x - p.x, z - p.z);
    if (pd >= p.blend) continue;
    const w = 1 - sm01((pd - p.r) / (p.blend - p.r));
    h += (p.y - h) * w;
  }
  return h;
}

/** 只给第一人称用：桥面范围内把落脚高度抬到桥板上，边缘 0.6m 平滑接回地面 */
export function walkHeightAt(x, z) {
  const h = heightAt(x, z);
  const dx = BRIDGE.halfL - Math.abs(x - BRIDGE.x);
  const dz = BRIDGE.halfW - Math.abs(z - BRIDGE.z);
  if (dx <= 0 || dz <= 0) return h;
  return h + (BRIDGE.deckY - h) * Math.min(1, Math.min(dx, dz) / 0.6);
}

const rnd = Math.random;
const between = (a, b) => a + rnd() * (b - a);

export function buildWorld(scene, assets = null) {
  const pickables = [];
  // 季节绿度：0 = 枯黄，1 = 盛夏浓绿；由外部按日期驱动
  const seasonUniform = { value: 0.0 };
  // 天气地表状态：地面积雪 / 地面湿润，由 environment.js 按真实降水记录驱动
  const weatherUniforms = {
    wet: { value: 0 },
    snow: { value: 0 },
  };

  const patchSeason = (mat, opts = {}) => {
    const include = opts.include || '#include <map_fragment>';
    const macro = opts.macro || null;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      shader.uniforms.uGreen = seasonUniform;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.uniforms.uSnow = weatherUniforms.snow;
      if (!shader.fragmentShader.includes('uniform float uGreen')) {
        shader.fragmentShader = 'uniform float uGreen;\nuniform float uWet;\nuniform float uSnow;\n'
          + shader.fragmentShader;
      }

      // 大尺度色斑：同一张贴图在不同尺度再采一次，打散平铺规律
      let macroFrag = '', macroVert = '';
      if (macro) {
        shader.uniforms.uMacro = { value: macro };
        shader.vertexShader = 'varying vec2 vMacroUv;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n         vMacroUv = uv;'
        );
        shader.fragmentShader = 'uniform sampler2D uMacro;\nvarying vec2 vMacroUv;\n'
          + shader.fragmentShader;
        // 三层尺度互不成整数比（3.7 / 11.3 / 28.9），靠叠加打散平铺的周期
        macroFrag = `
         float _mA = texture2D(uMacro, vMacroUv * 3.70).g;
         float _mB = texture2D(uMacro, vMacroUv * 11.30 + vec2(0.37, 0.61)).g;
         float _mC = texture2D(uMacro, vMacroUv * 28.90 + vec2(0.13, 0.29)).g;
         float _mv = _mA * 0.52 + _mB * 0.31 + _mC * 0.17;
         // 用亮度调制而不是乘色，避免把地面染脏
         diffuseColor.rgb *= mix(vec3(0.88, 0.89, 0.86), vec3(1.10, 1.10, 1.08), _mv);`;
      }

      shader.fragmentShader = shader.fragmentShader.replace(
        include,
        `${include}${macroFrag}
         float _lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summer = vec3(0.175, 0.235, 0.108) * (0.62 + _lum * 1.05);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summer, uGreen * 0.46);
         // 草地整体压暗一档，让立体的草浮起来，不至于和地面糊成一片
         diffuseColor.rgb *= 0.80;
         // 真实天气：降雪积白、降雨压暗（湿润）
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.75, 0.79), uSnow * 0.86);
         diffuseColor.rgb *= 1.0 - uWet * 0.20;`
      );
    };
    mat.needsUpdate = true;
    return mat;
  };
  const root = new THREE.Group();
  scene.add(root);

  /* ================= 天空 ================= */
  const cloudTex = TEX.cloudLayer();
  const skyUniforms = {
    topColor: { value: new THREE.Color(0x6b88a4) },
    botColor: { value: new THREE.Color(0xb9c2c2) },
    uCloud: { value: cloudTex.map },
    uTime: { value: 0 },
    uCoverage: { value: 0.44 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.88) },
    uSunI: { value: 1 },
  };

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 botColor;
      uniform sampler2D uCloud;
      uniform float uTime;
      uniform float uCoverage;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunI;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float t = clamp(h * 1.5 + 0.14, 0.0, 1.0);
        vec3 base = mix(botColor, topColor, t);

        // 云：用球面坐标采样。
        // 之前用 d.xz/h 的平面投影，低仰角处 uv 会爆掉，采样频率过高 → 混叠成一条灰带。
        float cloud = 0.0;
        {
          float phi = atan(d.z, d.x);
          float theta = acos(clamp(d.y, -1.0, 1.0));
          vec2 uv = vec2(phi * 0.15915, theta * 0.31831);   // 1/2π, 1/π
          uv = uv * vec2(7.0, 4.0) + vec2(uTime * 0.004, uTime * 0.0016);
          vec4 s1 = texture2D(uCloud, uv);
          vec4 s2 = texture2D(uCloud, uv * 0.41 + vec2(0.37, 0.71));
          cloud = clamp(s1.a * 0.72 + s2.a * 0.55, 0.0, 1.0);
          cloud *= smoothstep(0.015, 0.26, h);
          // 覆盖度 1.0 时阈值必须高于 1，否则晴天还留着一层云
          float thresh = mix(0.02, 1.12, uCoverage);
          cloud *= smoothstep(thresh, thresh + 0.22, cloud);
        }

        vec3 cloudCol = mix(vec3(0.74, 0.77, 0.80), vec3(0.95, 0.96, 0.97), smoothstep(0.2, 0.9, cloud));
        vec3 col = mix(base, cloudCol, cloud * 0.92);

        // 地平线大气雾化。
        // 范围必须拉宽：原来在 h=0.16 处收尾，正好落在画面顶部，
        // 形成一条亮度突变的横带。雾带颜色必须与场景雾色(=botColor)一致，
        // 否则远山会在亮带前形成一条突兀的断层。
        col = mix(botColor, col, smoothstep(-0.10, 0.46, h));

        // 落日方向的地平线暖光：西边天幕泛橙、背面仍是冷蓝，这是黄昏最像黄昏的地方
        vec3 hd = normalize(vec3(d.x, 0.0, d.z));
        vec3 sd = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
        float azF = max(dot(hd, sd), 0.0);
        float lowSky = exp(-max(h, 0.0) * 5.5);
        col = mix(col, uSunColor * vec3(1.0, 0.52, 0.22), lowSky * pow(azF, 2.5) * uSunI * 0.55);

        // 太阳本体与光晕：位置逐帧连续，日出日落时能看见它压着山脊走
        float sd2 = max(dot(d, normalize(uSunDir)), 0.0);
        float glow = pow(sd2, 620.0) * 0.55 + pow(sd2, 34.0) * 0.14;
        float disc = smoothstep(0.99962, 0.99986, sd2);
        col += uSunColor * (disc * 2.8 + glow) * uSunI;

        gl_FragColor = vec4(col, 1.0);
      }`,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
  scene.add(sky);

  scene.fog = new THREE.FogExp2(0xbcc4c6, 0.0018);

  /* ================= 光照 ================= */
  const hemi = new THREE.HemisphereLight(0xa6bccd, 0x6b6047, 0.86);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.5);
  sun.position.set(118, 58, 124);
  sun.castShadow = true;
  // 阴影范围要同时盖住村子（x −105…105）和东边的孤山（x 95…245）：
  // 正交框中心挪到 x=70、半宽 180 → 覆盖 x −110…250、z ±180。
  // 代价是每像素覆盖的地面变宽（2048 / 360m ≈ 5.7 px/m），村内影子会比之前软一点。
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 60;
  sun.shadow.camera.far = 520;
  const S = 180;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  // 改了正交范围必须重算投影矩阵，否则阴影相机还停在默认的 10m 盒子里
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.045;
  // 光照方向仍以太阳矢量定义，只把"看着哪儿"的靶点挪到 70，见 environment.js
  sun.userData.shadowCenter = { x: 70, z: 0 };
  sun.target.position.set(70, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  const bounce = new THREE.DirectionalLight(0x9fb8c8, 0.30);
  bounce.position.set(-80, 40, -90);
  scene.add(bounce);

  // 月光：只在夜里生效的冷色补光，不投影（省一遍 shadow pass）
  const moon = new THREE.DirectionalLight(0xa8c2e6, 0);
  moon.position.set(-120, 150, -70);
  scene.add(moon);

  /* ================= 地形 ================= */
  // 有实景素材就用实景（画质分水岭），没有则回退程序化
  const gTex = assets?.grass || TEX.grass();
  // 密到远处 mipmap 直接抹平，就不再有可辨的方格
  const gRepeat = assets?.grass ? 300 : 96;
  // 河谷只有 12m 宽，原来 3.26m 一格的均匀网格在岸坡上只剩两三个采样点，
  // 再平滑的剖面也会被插值成折线。这里只在河道带 [-118,-82] 内把 x 方向
  // 加密到 0.54m，其余区域维持原密度：约多 1 万个顶点，draw call 不变。
  const EXT = 310, NZ = 190, STEP = (EXT * 2) / NZ;
  const zs = Array.from({ length: NZ + 1 }, (_, j) => -EXT + STEP * j);
  const xs = [];
  for (let i = 0; i <= NZ; i++) {
    const x0 = -EXT + STEP * i;
    xs.push(x0);
    if (i < NZ && x0 >= -118 && x0 < -82) {
      for (let k = 1; k < 6; k++) xs.push(x0 + STEP * k / 6);
    }
  }
  const NX = xs.length;
  const groundGeo = new THREE.BufferGeometry();
  {
    const vp = new Float32Array(NX * (NZ + 1) * 3);
    const uv = new Float32Array(NX * (NZ + 1) * 2);
    const idx = [];
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const n = j * NX + i, x = xs[i], z = zs[j];
        vp[n * 3] = x; vp[n * 3 + 1] = heightAt(x, z); vp[n * 3 + 2] = z;
        uv[n * 2] = (x + EXT) / (EXT * 2);
        uv[n * 2 + 1] = (EXT - z) / (EXT * 2);   // 与 PlaneGeometry.rotateX 后的 v 方向一致
      }
    }
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = (j + 1) * NX + i;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    groundGeo.setAttribute('position', new THREE.BufferAttribute(vp, 3));
    groundGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    groundGeo.setIndex(idx);
  }
  groundGeo.computeVertexNormals();

  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
    map: gTex.map,
    normalMap: gTex.normalMap,
    roughnessMap: gTex.roughnessMap || null,
    normalScale: new THREE.Vector2(assets?.grass ? 1.35 : 0.8, assets?.grass ? 1.35 : 0.8),
    roughness: gTex.roughnessMap ? 1 : 0.96,
    metalness: 0,
  }));
  patchSeason(ground.material, { macro: TEX.groundMacro().map });
  ground.receiveShadow = true;
  root.add(ground);

  // 地面放大后加密贴图平铺
  gTex.map.repeat.set(gRepeat, gRepeat);
  gTex.normalMap.repeat.set(gRepeat, gRepeat);
  if (gTex.roughnessMap) gTex.roughnessMap.repeat.set(gRepeat, gRepeat);

  // 按海拔压暗 + 山体分层上色（草 → 土黄 → 岩石），一次遍历搞定：
  // 山顶、山脚各要一次高度判断，分成两遍遍历纯属浪费
  {
    const col = [];
    const p2 = groundGeo.attributes.position;
    const GRASS = [1, 1, 1];
    // 底色贴图本身偏橄榄绿，纯乘法压不出灰；要让山顶读成岩石，
    // 只能反过来抬蓝、压绿，把贴图的绿调中和掉
    const SOIL = [1.52, 1.18, 0.72];    // 土黄：抬红压蓝
    const ROCK = [0.92, 0.98, 1.95];    // 岩石：贴图本身偏橄榄绿，蓝要抬到接近 2 倍才压得出冷灰
    const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let i = 0; i < p2.count; i++) {
      const x = p2.getX(i), z = p2.getZ(i), y = p2.getY(i);

      // 新增：按"离山脚多高"分带。f 用山体自身的抬升量算，
      // 不受村内微起伏影响；分界线加一点噪声，免得山坡上出现完美等高线
      const f = Math.min(1, Math.max(0,
        hillLift(x, z) / HILL_LIFT + (fbm(x * 0.055, z * 0.055, 2) - 0.5) * 0.07));

      // 原有的"高处偏冷偏暗"是给远处山脊用的；孤山有自己的调色板，
      // 再叠这层压暗会把山顶压回深橄榄色，岩石就看不出来了，所以按 f 让它退出
      const k = Math.min(1, Math.max(0, (y - 10) / 46));
      const shade = 1 - k * 0.30 * (1 - Math.min(1, f * 1.5));

      let c = GRASS;
      if (f > 0.001) {
        c = mix3(GRASS, SOIL, Math.min(1, f / 0.30));
        c = mix3(c, ROCK, Math.min(1, Math.max(0, (f - 0.30) / 0.32)));
      }
      // 河床不能是绿草地：顶点色乘成偏沙砾的土黄，透过浅水能读到河底。
      // 与山体着色共用一次遍历，不额外建网格、不增加 draw call。
      let rt = 0;
      if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12) {
        const rd = Math.abs(x - riverCenterX(z));
        if (rd < RIVER.out) rt = 1 - sm01((rd - RIVER.half * 0.55) / (RIVER.out - RIVER.half * 0.55));
      }
      const rc = [c[0] * (1 + rt * 0.42), c[1] * (1 + rt * 0.02), c[2] * (1 - rt * 0.42)];
      col.push(shade * rc[0], shade * 0.97 * rc[1], shade * 0.9 * rc[2]);
    }
    groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    ground.material.vertexColors = true;
    ground.material.needsUpdate = true;
  }

  /* ================= 村西小河：水面层 =================
   * 单独一层水平带，绝对不做实时反射（Reflector/SSR 那种昂贵的东西一律不碰）：
   * 天光反射全部来自 scene.environment 里的 HDRI（Poly Haven 阴天开阔田野），
   * 流水感只靠程序化法线贴图沿流向缓慢滚动。
   * 带子铺到 |d|=4.2m，比岸坡与水位线的交线（≈3.88m）略宽，
   * 多出来的部分被地形深度遮住，所以水面边缘是自然裁出来的，不会悬空一条缝。 */
  const waterState = { mat: null, normal: null, mesh: null };
  {
    const W = 4.2, Z0 = RIVER.z0 - 12, Z1 = RIVER.z1 + 12, M = 16, N = 280;
    const wPos = [], wUv = [], wIdx = [];
    for (let j = 0; j <= N; j++) {
      const z = Z0 + (Z1 - Z0) * j / N;
      const c = riverCenterX(z);
      for (let i = 0; i <= M; i++) {
        wPos.push(c + W * (-1 + 2 * i / M), RIVER.waterY, z);
        wUv.push(i / M * 2, j / N * 46);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < M; i++) {
        const a = j * (M + 1) + i, b = (j + 1) * (M + 1) + i;
        wIdx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const wGeo = new THREE.BufferGeometry();
    wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
    wGeo.setIndex(wIdx);
    wGeo.computeVertexNormals();

    const nTex = TEX.water().normalMap.clone();
    nTex.needsUpdate = true;
    nTex.wrapS = nTex.wrapT = THREE.RepeatWrapping;
    nTex.repeat.set(1, 1);          // 重复次数已编进 uv，滚动只动 offset

    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x4c7078,
      normalMap: nTex,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.075,             // 低粗糙度，HDRI 天光能成片地铺在水面上
      metalness: 0.34,
      envMapIntensity: 2.8,
      transparent: true,
      opacity: 0.70,
      depthWrite: false,            // 半透明层，不写深度，免得挡住后面的河床
      side: THREE.DoubleSide,
    });
    if (scene.environment) waterMat.envMap = scene.environment;
    // 掠射角补一层天光：纯视角项，不采样场景、不做任何实时反射。
    // 用的法线是 normalMap 扰动后的，所以这层高光会跟着滚动的波纹一起流动；
    // 颜色直接引用天空 uniform，阴天/黄昏/雪天会和天色一起变，不会白天亮夜里还亮。
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSkyColor = skyUniforms.topColor;
      shader.vertexShader = 'varying vec3 vRiverView;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n         vRiverView = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;'
      );
      shader.fragmentShader = 'uniform vec3 uSkyColor;\nvarying vec3 vRiverView;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         float _fres = pow(1.0 - abs(dot(normalize(vRiverView), normal)), 3.0);
         gl_FragColor.rgb += uSkyColor * _fres * 0.68;
         gl_FragColor.a = min(1.0, gl_FragColor.a + _fres * 0.22);`
      );
    };
    const water = new THREE.Mesh(wGeo, waterMat);
    water.name = 'river-water';
    water.renderOrder = 2;
    root.add(water);
    waterState.mat = waterMat;
    waterState.normal = nTex;
    waterState.mesh = water;
  }

  /* ================= 远景山体：给村子一圈纵深 ================= */
  // 原来地形只有 620 m 见方，边缘之外直接接天，远处看去就是一条灰带。
  {
    const g = new THREE.PlaneGeometry(3200, 3200, 160, 160);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const col = [];
    const sm = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const d = Math.hypot(x, z);
      // 内圈沿用地形高度场，与 620m 地形边缘无缝衔接；
      // 但地形网格覆盖范围内必须压低藏在下面，否则共面 z-fighting 会打成迷彩斑块
      // 这里只取底板高度、不含孤山：远山网格 20m 一格，采样 58m 的山会顶出地形，形成斑块
      const local = baseHeight(x, z);
      const dx = Math.max(0, Math.abs(x) - 306);
      const dz = Math.max(0, Math.abs(z) - 306);
      const edge = Math.hypot(dx, dz);        // 0 = 仍在地形网格覆盖内
      // 远山网格 20m 一格、地形 3.26m 一格，同样取 heightAt 但插值曲率不同，
      // 误差可达数米：下潜太浅山面会从地形里顶出来，形成一片片不规则斑块。
      // 出边界后 sink 归零，衔接仍然无高差。
      const sink = 4.0 * (1 - sm(edge / 70));
      // 中圈：快速隆起盖住地形边界；外圈：升为岷山北麓高山
      const rise = sm((d - 330) / 620);
      const rise2 = sm((d - 820) / 900);
      const ridge = 0.58 + 0.42 * fbm(x * 0.0016, z * 0.0016, 4);
      const spur = (fbm(x * 0.0061 + 11, z * 0.0061 + 5, 3) - 0.5) * 34 * rise;
      const mtn = (70 + 240 * rise2) * ridge + spur + rise * 42;
      const k = sm(edge / 240);
      const h = (local - sink) * (1 - k) + mtn * k;
      p.setY(i, h);

      // 空气透视：内圈贴近地形草色，越远越偏冷灰蓝，让山往后退
      const kc = sm((d - 340) / 1300);
      const hi = Math.min(1, Math.max(0, h / 320)) * 0.04;
      const r0 = 0.47 + (0.54 - 0.47) * kc + hi;
      const g0 = 0.51 + (0.58 - 0.51) * kc + hi;
      const b0 = 0.36 + (0.52 - 0.36) * kc + hi;
      col.push(r0, g0, b0);
    }

    g.computeVertexNormals();
    // 把坡面明暗预烘进顶点色：远山不该跟着近景的强直射光走，
    // 否则晴天向阳坡过曝成白斑、背阴坡塌成黑斑，像贴了一层云影
    {
      const nrm = g.attributes.normal;
      for (let i = 0; i < nrm.count; i++) {
        const s = 0.84 + 0.16 * Math.max(0, nrm.getY(i));
        col[i * 3] *= s; col[i * 3 + 1] *= s; col[i * 3 + 2] *= s;
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));

    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, fog: true, side: THREE.DoubleSide,
    }));
    m.material.userData.isMountain = true;   // 由 environment.js 按昼夜调色
    m.receiveShadow = false;
    m.castShadow = false;
    root.add(m);
  }

  /* ================= 道路 ================= */
  {
    const curve = new THREE.CatmullRomCurve3(
      ROAD.points.map(([x, z]) => new THREE.Vector3(x, 0, z))
    );
    const N = 160, halfW = ROAD.width / 2;
    const verts = [], uvs = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = curve.getPoint(t);
      const tan = curve.getTangent(t);
      const nx = -tan.z, nz = tan.x;
      for (const s of [-1, 1]) {
        // 路缘不能是直线：真实土路被踩、被水冲，边缘是毛的
        const wob = (fbm(p.z * 0.26 + s * 37, t * 8.5, 3) - 0.5) * 0.72;
        const x = p.x + nx * (halfW + wob) * s;
        const z = p.z + nz * (halfW + wob) * s;
        verts.push(x, heightAt(x, z) + 0.06, z);
        // 实景泥地贴图约 3 米一个周期：横向铺 2 次（路宽 6.2 m），纵向按路长
        uvs.push((s * 0.5 + 0.5) * (assets?.road ? 2.05 : 1), t * (assets?.road ? 86 : 26));
      }
      if (i < N) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const rTex = assets?.road || TEX.road();
    const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: rTex.map,
      // 泥土地不该反光：压暗并拉高粗糙度
      color: assets?.road ? new THREE.Color(0.56, 0.44, 0.31) : new THREE.Color(0xffffff),
      normalMap: rTex.normalMap,
      normalScale: new THREE.Vector2(assets?.road ? 0.55 : 1.0, assets?.road ? 0.55 : 1.0),
      roughness: 0.97,
      metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2,
    }));
    // 路面同样要积雪/打湿，否则雪天中间会留一条突兀的黑带
    road.material.onBeforeCompile = (shader) => {
      shader.uniforms.uSnow = weatherUniforms.snow;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.fragmentShader = 'uniform float uSnow;\nuniform float uWet;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         // 车辙处积雪比路肩薄，留一点泥土色透出来
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.66, 0.70), uSnow * 0.74);
         diffuseColor.rgb *= 1.0 - uWet * 0.26;`
      );
    };
    road.receiveShadow = true;
    root.add(road);
  }

  /* ================= 代理盒工具 ================= */
  const proxyMat = new THREE.MeshBasicMaterial();
  proxyMat.visible = false;

  function proxy(data, size, center = [0, 0, 0], parentY = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), proxyMat);
    m.position.set(center[0], center[1] + parentY, center[2]);
    m.userData.objectId = data.id;
    pickables.push(m);
    return m;
  }

  /* ================= 民居 ================= */
  const brickT = TEX.brick();
  const plasterT = TEX.plaster([216, 206, 186]);
  const roofT = TEX.tile();
  const woodT = TEX.wood([122, 88, 58]);
  const stoneT = TEX.stone();

  // 有实景素材优先：砖、瓦都用扫描件，看不出规律性重复
  const rep = (t, x, y) => {
    const c = t.clone();
    c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(x, y);
    return c;
  };

  const matBrick = assets?.brick
    ? new THREE.MeshStandardMaterial({
        map: rep(assets.brick.map, 3.0, 1.9),
        normalMap: rep(assets.brick.normalMap, 3.0, 1.9),
        normalScale: new THREE.Vector2(1.25, 1.25),
        roughness: 0.92,
        metalness: 0,
      })
    : new THREE.MeshStandardMaterial({
        map: brickT.map, normalMap: brickT.normalMap,
        normalScale: new THREE.Vector2(1.9, 1.9), roughness: 0.94,
      });

  const matPlaster = new THREE.MeshStandardMaterial({ map: plasterT.map, normalMap: plasterT.normalMap,
    normalScale: new THREE.Vector2(1.4, 1.4), roughness: 0.95 });

  // 檐下软遮蔽：直接烘进墙材质本身。
  // 不能用半透明贴片去叠——那会污染 GTAO 的深度/法线预通道，整片墙会黑白花掉。
  // 村内民居地势基本齐平（heightAt≈0），按世界高度 2.45→3.40m 渐暗即可。
  const addEaveAO = (mat) => {
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'varying float vEaveY;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vEaveY = (modelMatrix * vec4(transformed, 1.0)).y;`
      );
      shader.fragmentShader = 'varying float vEaveY;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _eave = smoothstep(2.45, 3.40, vEaveY) * (1.0 - smoothstep(3.46, 4.05, vEaveY));
         diffuseColor.rgb *= 1.0 - _eave * 0.40;`
      );
    };
    mat.needsUpdate = true;
  };
  addEaveAO(matBrick);
  addEaveAO(matPlaster);

  const matRoof = assets?.roof
    ? new THREE.MeshStandardMaterial({
        map: rep(assets.roof.map, 5.0, 3.4),
        normalMap: rep(assets.roof.normalMap, 5.0, 3.4),
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.78,
        side: THREE.DoubleSide,
      })
    : new THREE.MeshStandardMaterial({ map: roofT.map, normalMap: roofT.normalMap,
        normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.8, side: THREE.DoubleSide });
  // 远处瓦面 mipmap 会被抹成一片死橙色：按世界坐标叠一层低频色差，
  // 让每户屋顶的深浅/老化程度略有不同
  {
    const roofMacro = TEX.groundMacro().map;
    matRoof.onBeforeCompile = (shader) => {
      shader.uniforms.uRoofMacro = { value: roofMacro };
      shader.uniforms.uSnow = weatherUniforms.snow;
      shader.uniforms.uWet = weatherUniforms.wet;
      shader.vertexShader = 'varying vec3 vRoofWorld;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRoofWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
      shader.fragmentShader = 'uniform sampler2D uRoofMacro;\nuniform float uSnow;\nuniform float uWet;\nvarying vec3 vRoofWorld;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _rm = texture2D(uRoofMacro, vRoofWorld.xz * 0.021 + 0.37).g;
         float _rm2 = texture2D(uRoofMacro, vRoofWorld.xz * 0.083 + vec2(0.61, 0.12)).g;
         diffuseColor.rgb *= mix(vec3(0.78, 0.75, 0.71), vec3(1.14, 1.10, 1.04), _rm * 0.72 + _rm2 * 0.28);
         // 坡屋顶积雪比平地薄，雨天窗面变暗
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.74, 0.78, 0.81), uSnow * 0.68);
         diffuseColor.rgb *= 1.0 - uWet * 0.16;`
      );
    };
  }
  const matWood = new THREE.MeshStandardMaterial({ map: woodT.map, normalMap: woodT.normalMap, roughness: 0.78 });
  const matStone = new THREE.MeshStandardMaterial({ map: stoneT.map, normalMap: stoneT.normalMap, roughness: 0.9 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.9 });
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x3d4e58, roughness: 0.18, metalness: 0.55 });
  // 院墙：夯土墙。纯色最假，必须有抹面的颗粒与雨痕
  const matMud = new THREE.MeshStandardMaterial({
    map: rep(plasterT.map, 14.0, 4.2),
    normalMap: rep(plasterT.normalMap, 14.0, 4.2),
    normalScale: new THREE.Vector2(0.75, 0.75),
    color: 0xa08b6e,
    roughness: 0.97,
    vertexColors: true,
  });
  // 世界坐标驱动的大尺度雨痕/泛碱：同一张抹面贴图贴到十几户院墙上，
  // 只靠 UV 相位还是会看出「同一块脏迹」在每户重复，必须按世界坐标取纹理
  {
    const wallMacro = TEX.groundMacro().map;
    matMud.onBeforeCompile = (shader) => {
      shader.uniforms.uWallMacro = { value: wallMacro };
      shader.vertexShader = 'varying vec3 vWallWorld;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWallWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
      shader.fragmentShader = 'uniform sampler2D uWallMacro;\nvarying vec3 vWallWorld;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         vec2 _wuv = vec2(vWallWorld.x * 0.041 + vWallWorld.z * 0.033,
                          vWallWorld.y * 0.13 + vWallWorld.z * 0.012);
         float _dirt = texture2D(uWallMacro, _wuv).g;
         float _rain = texture2D(uWallMacro, _wuv * 2.7 + vec2(0.31, 0.67)).g;
         float _m = _dirt * 0.66 + _rain * 0.34;
         diffuseColor.rgb *= mix(vec3(0.80, 0.79, 0.75), vec3(1.10, 1.08, 1.03), _m);`
      );
    };
  }
  const matSkirt = new THREE.MeshStandardMaterial({ color: 0x6a6055, roughness: 0.97 });
  const matTrim = new THREE.MeshStandardMaterial({ color: 0x6a5640, roughness: 0.82 });
  const matDoor = new THREE.MeshStandardMaterial({
    map: rep(woodT.map, 1.4, 2.2),
    normalMap: rep(woodT.normalMap, 1.4, 2.2),
    color: 0xc9a87a, roughness: 0.84,
  });
  const matWallCap = new THREE.MeshStandardMaterial({ color: 0x585650, roughness: 0.9 });

  // 院内是踩实的夯土地，不该和村外草坡一样长满草
  const yardGroundT = TEX.soil();
  const matYardGround = new THREE.MeshStandardMaterial({
    map: rep(yardGroundT.map, 3.2, 4.0),
    normalMap: rep(yardGroundT.normalMap, 3.2, 4.0),
    normalScale: new THREE.Vector2(0.55, 0.55),
    color: 0xc0b49a, roughness: 0.98,
  });

  /** 双坡屋顶：三角截面沿 Z 拉伸 */
  function gableRoof(w, d, h) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    shape.lineTo(0, h);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    geo.translate(0, 0, -d / 2);
    return geo;
  }

  /* ================= 院内生活物件 ================= */
  // 秋收后晾药材、夏天挂辣椒：两组挂晒物按真实日期切换可见性
  const yardAutumn = [], yardSummer = [];
  const detailMats = {
    wood: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }),
    pole: new THREE.MeshStandardMaterial({ color: 0x9a8158, roughness: 0.88 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0x5d4438, roughness: 0.62 }),
    water: new THREE.MeshStandardMaterial({ color: 0x25333a, roughness: 0.24, metalness: 0.18 }),
    straw: new THREE.MeshStandardMaterial({ color: 0xb69a63, roughness: 0.96 }),
    chili: new THREE.MeshStandardMaterial({ color: 0xa8362a, roughness: 0.8 }),
    tarp: new THREE.MeshStandardMaterial({ color: 0x6c787b, roughness: 0.94 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x242422, roughness: 0.92 }),
  };

  function buildYardDetail(d, g) {
    const [x, z] = d.local;
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const put = (geo, mat, px, py, pz, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
      return m;
    };
    let boxSize, boxCenter;

    if (d.kind === 'drying') {
      for (const sx of [-1.15, 1.15]) {
        put(new THREE.CylinderGeometry(0.055, 0.07, 2.05, 6), detailMats.pole, sx, 1.02, 0);
        put(new THREE.BoxGeometry(0.055, 0.85, 0.055), detailMats.pole,
          sx * 0.86, 1.55, 0, 0, 0, sx * 0.55);
      }
      put(new THREE.BoxGeometry(2.9, 0.085, 0.085), detailMats.pole, 0, 2.02, 0);

      const mkStrings = (mat, geo) => {
        const im = new THREE.InstancedMesh(geo, mat, 40);
        const mx = new THREE.Matrix4(), q = new THREE.Quaternion();
        let n = 0;
        for (let i = 0; i < 8; i++) {
          const bx = -1.05 + i * 0.30;
          for (let j = 0; j < 5; j++) {
            const wob = Math.sin(i * 2.3 + j * 1.7) * 0.018;
            mx.compose(new THREE.Vector3(bx + wob, 1.88 - j * 0.16, wob * 0.6),
              q, new THREE.Vector3(1, 1, 1));
            im.setMatrixAt(n++, mx);
          }
        }
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true;
        const wrap = new THREE.Group();
        wrap.add(im);
        grp.add(wrap);
        return wrap;
      };
      yardAutumn.push(mkStrings(detailMats.straw, new THREE.BoxGeometry(0.13, 0.17, 0.13)));
      yardSummer.push(mkStrings(detailMats.chili, new THREE.BoxGeometry(0.055, 0.21, 0.055)));
      boxSize = [3.0, 2.3, 0.9]; boxCenter = [x, 1.15, z];
    }
    else if (d.kind === 'woodpile') {
      put(new THREE.BoxGeometry(2.0, 0.14, 1.1), matStone, 0, 0.07, 0);
      const logs = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.95, 6), detailMats.wood, 24);
      const mx = new THREE.Matrix4(), q = new THREE.Quaternion();
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      let n = 0;
      for (let layer = 0; layer < 4; layer++) {
        for (let k = 0; k < 6; k++) {
          mx.compose(new THREE.Vector3(-0.62 + k * 0.25 + (layer % 2) * 0.06,
            0.25 + layer * 0.17, (k % 2 ? 0.22 : -0.22)), q, new THREE.Vector3(1, 1, 1));
          logs.setMatrixAt(n++, mx);
        }
      }
      logs.instanceMatrix.needsUpdate = true;
      logs.castShadow = true; logs.receiveShadow = true;
      grp.add(logs);
      put(new THREE.BoxGeometry(2.1, 0.04, 1.2), detailMats.tarp, 0, 1.0, 0, 0, 0, 0.05);
      boxSize = [2.3, 1.2, 1.4]; boxCenter = [x, 0.6, z];
    }
    else if (d.kind === 'waterjar') {
      put(new THREE.CylinderGeometry(0.52, 0.39, 0.92, 14), detailMats.ceramic, 0, 0.46, 0);
      put(new THREE.TorusGeometry(0.52, 0.045, 8, 18), detailMats.ceramic, 0, 0.92, 0, Math.PI / 2);
      put(new THREE.CircleGeometry(0.47, 18), detailMats.water, 0, 0.87, 0, -Math.PI / 2);
      put(new THREE.CylinderGeometry(0.10, 0.08, 0.06, 10), detailMats.wood, 0.64, 0.06, 0.24);
      put(new THREE.BoxGeometry(0.30, 0.035, 0.035), detailMats.wood, 0.82, 0.09, 0.24);
      boxSize = [1.4, 1.1, 1.4]; boxCenter = [x, 0.55, z];
    }
    else if (d.kind === 'cart') {
      put(new THREE.BoxGeometry(1.7, 0.09, 0.95), detailMats.wood, 0, 0.62, 0);
      for (const sz of [-0.47, 0.47]) {
        put(new THREE.BoxGeometry(1.7, 0.26, 0.055), detailMats.wood, 0, 0.78, sz);
      }
      for (const sz of [-0.55, 0.55]) {
        put(new THREE.TorusGeometry(0.32, 0.07, 8, 14), detailMats.rubber, 0, 0.33, sz);
      }
      for (const sx of [-0.38, 0.38]) {
        put(new THREE.BoxGeometry(0.06, 0.06, 1.35), detailMats.pole, sx, 0.6, 1.35);
      }
      boxSize = [1.6, 1.0, 2.8]; boxCenter = [x, 0.6, z + 0.6];
    }
    else if (d.kind === 'grain') {
      put(new THREE.CylinderGeometry(0.90, 0.90, 0.16, 12), matStone, 0, 0.08, 0);
      put(new THREE.CylinderGeometry(0.74, 0.82, 1.45, 12), detailMats.straw, 0, 0.88, 0);
      put(new THREE.ConeGeometry(0.94, 0.55, 12), detailMats.straw, 0, 1.88, 0);
      for (const hy of [0.55, 1.25]) {
        put(new THREE.TorusGeometry(0.79, 0.022, 6, 14), detailMats.wood, 0, hy, 0, Math.PI / 2);
      }
      boxSize = [1.9, 2.3, 1.9]; boxCenter = [x, 1.15, z];
    }

    g.add(grp);
    if (boxSize) g.add(proxy(d, boxSize, boxCenter));
  }

  function buildHouse(h) {
    const g = new THREE.Group();
    const y = heightAt(h.pos[0], h.pos[2]);
    g.position.set(h.pos[0], y, h.pos[2]);
    g.rotation.y = h.rot;

    const W = 9.6, D = 7.2, WH = 3.1, RH = 2.0;
    const baseY = 0.34;                       // 台基高度，所有构件抬这么高
    const wallMat = h.structure === '土木' ? matPlaster : matBrick;

    // 院内夯土地面：略高于地形，压住草，留出被踩实的土色
    {
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(h.yard.w - 0.7, h.yard.d - 0.7), matYardGround);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.055;
      floor.receiveShadow = true;
      g.add(floor);
    }

    // 石砌台基
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, baseY, D + 0.7), matStone);
    plinth.position.y = baseY / 2;
    plinth.castShadow = plinth.receiveShadow = true;
    g.add(plinth);

    // 墙裙（防潮的深色抹面）
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.9, D + 0.1), matSkirt);
    skirt.position.y = baseY + 0.45;
    skirt.castShadow = skirt.receiveShadow = true;
    g.add(skirt);

    // 墙体
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, WH, D), wallMat);
    body.position.y = baseY + WH / 2;
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // 双坡屋顶
    const roof = new THREE.Mesh(gableRoof(W + 1.1, D + 1.2, RH), matRoof);
    roof.position.y = baseY + WH;
    roof.castShadow = roof.receiveShadow = true;
    g.add(roof);

    // 前檐挑出
    const eave = new THREE.Mesh(new THREE.BoxGeometry(W + 1.3, 0.16, 0.62), matWallCap);
    eave.position.set(0, baseY + WH + 0.05, D / 2 + 0.56);
    eave.castShadow = true;
    g.add(eave);

    // 檐下椽头：一排深色方木，檐口不再是平板一条
    {
      const nR = 23;
      const rim = new THREE.InstancedMesh(new THREE.BoxGeometry(0.10, 0.15, 0.72), matTrim, nR);
      const mx = new THREE.Matrix4();
      for (let i = 0; i < nR; i++) {
        mx.makeTranslation(-W / 2 - 0.36 + (i + 0.5) * (W + 0.72) / nR,
          baseY + WH - 0.05, D / 2 + 0.30);
        rim.setMatrixAt(i, mx);
      }
      rim.instanceMatrix.needsUpdate = true;
      rim.castShadow = true;
      g.add(rim);
    }


    // 屋脊
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.22, 0.34), matDark);
    ridge.position.y = baseY + WH + RH - 0.05;
    ridge.castShadow = true;
    g.add(ridge);

    // 门：门框、门楣、门槛（比原来外凸、加粗，站在院里能看出是一套门套）
    for (const sx of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.20, 2.46, 0.26), matTrim);
      jamb.position.set(sx * 0.80, baseY + 1.23, D / 2 + 0.07);
      jamb.castShadow = true;
      g.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.24, 0.30), matTrim);
    lintel.position.set(0, baseY + 2.55, D / 2 + 0.07);
    lintel.castShadow = true;
    g.add(lintel);

    // 门洞暗背景：一层薄片贴在门板后面。原来做成 0.26m 厚的实心黑盒，
    // 把门板和压条整个包在里面，所以门看起来永远是一块黑。
    const doorHole = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.36, 0.02), matDark);
    doorHole.position.set(0, baseY + 1.18, D / 2 - 0.18);
    g.add(doorHole);

    const door = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.26, 0.08), matDoor);
    door.position.set(0, baseY + 1.14, D / 2 - 0.04);
    door.castShadow = true;
    g.add(door);

    // 门板压条：两横一竖，老木门的样子
    for (const py of [0.55, 1.75]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.10, 0.035), matTrim);
      strip.position.set(0, baseY + py, D / 2 - 0.005);
      g.add(strip);
    }
    const stripV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.12, 0.03), matTrim);
    stripV.position.set(0, baseY + 1.14, D / 2 - 0.005);
    g.add(stripV);

    const sill = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.42), matStone);
    sill.position.set(0, baseY + 0.07, D / 2 + 0.14);
    sill.receiveShadow = true;
    g.add(sill);

    // 窗：洞壁 + 玻璃 + 空心窗框 + 窗棂 + 外挑窗台
    // 关键是做出进深：贴一层面片在墙上，永远像贴纸
    for (const dx of [-3.1, 3.1]) {
      // 窗洞暗背景：同样改成薄片。原来 0.30m 厚的黑盒把玻璃和窗棂全挡住了
      const hole = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.42, 0.02), matDark);
      hole.position.set(dx, baseY + 2.0, D / 2 - 0.20);
      hole.receiveShadow = true;
      g.add(hole);

      // 玻璃往里退，窗框才能显出厚度
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 0.06), matGlass);
      win.position.set(dx, baseY + 2.0, D / 2 - 0.05);
      g.add(win);

      // 空心窗框：四条边，中间留空看到玻璃（比原来宽 3cm，暗处也能读出窗套）
      const fw = 1.76, fh = 1.56, ft = 0.13, fd = 0.15;
      const bars = [
        [fw, ft, 0, fh / 2 - ft / 2],
        [fw, ft, 0, -fh / 2 + ft / 2],
        [ft, fh, -fw / 2 + ft / 2, 0],
        [ft, fh, fw / 2 - ft / 2, 0],
      ];
      for (const [bw, bh, bx, by] of bars) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, fd), matTrim);
        b.position.set(dx + bx, baseY + 2.0 + by, D / 2 + 0.02);
        b.castShadow = true;
        g.add(b);
      }

      // 窗棂：十字，压在玻璃表面
      const barV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.34, 0.045), matTrim);
      barV.position.set(dx, baseY + 2.0, D / 2 - 0.015);
      g.add(barV);
      const barH = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.045), matTrim);
      barH.position.set(dx, baseY + 2.0, D / 2 - 0.015);
      g.add(barH);

      // 外挑窗台，底下一圈滴水线
      const sillW = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.11, 0.34), matStone);
      sillW.position.set(dx, baseY + 1.18, D / 2 + 0.10);
      sillW.castShadow = true;
      g.add(sillW);

      const drip = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.05, 0.06), matWallCap);
      drip.position.set(dx, baseY + 1.11, D / 2 + 0.25);
      g.add(drip);
    }

    // 院墙 + 墙帽
    if (h.hasWall) {
      const { w, d } = h.yard;
      const wh = 1.9, thick = 0.28;
      const segs = [
        { s: [w, wh, thick], p: [0, wh / 2, d / 2 - 1.6] },
        { s: [w, wh, thick], p: [0, wh / 2, -d / 2] },
        { s: [thick, wh, d], p: [-w / 2, wh / 2, 0] },
        { s: [thick, wh, d], p: [w / 2, wh / 2, 0] },
      ];
      for (const sg of segs) {
        const wallGeo = new THREE.BoxGeometry(...sg.s);
        // 每段墙随机 UV 相位/镜像 + 逐墙色差，配合世界坐标污渍打散重复
        const wuv = wallGeo.attributes.uv;
        const uOff = Math.random(), vOff = Math.random();
        const flip = Math.random() < 0.5 ? -1 : 1;
        const tint = 0.93 + Math.random() * 0.14;
        const warm = 0.97 + Math.random() * 0.06;
        const wcol = [];
        for (let i = 0; i < wuv.count; i++) {
          wuv.setXY(i, wuv.getX(i) * flip + uOff, wuv.getY(i) + vOff);
          wcol.push(tint * warm, tint, tint * (2 - warm));
        }
        wuv.needsUpdate = true;
        wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wcol, 3));
        const m = new THREE.Mesh(wallGeo, matMud);
        m.position.set(...sg.p);
        m.castShadow = m.receiveShadow = true;
        g.add(m);

        const cap = new THREE.Mesh(new THREE.BoxGeometry(sg.s[0] + 0.16, 0.12, sg.s[2] + 0.16), matWallCap);
        cap.position.set(sg.p[0], sg.p[1] + wh / 2 + 0.06, sg.p[2]);
        cap.castShadow = true;
        g.add(cap);

        // 墙根潮气痕：贴着地面发深，是老墙最明显的痕迹
        const stain = new THREE.Mesh(
          new THREE.BoxGeometry(sg.s[0] + 0.03, 0.40, sg.s[2] + 0.03), matSkirt);
        stain.position.set(sg.p[0], sg.p[1] - wh / 2 + 0.20, sg.p[2]);
        stain.receiveShadow = true;
        g.add(stain);
      }

      // 院门：门柱 + 小门楼
      const gz = d / 2 - 1.6, gx = -w / 2 + 2.6;
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 2.5, 0.32), matBrick);
        post.position.set(gx + sx * 1.05, 1.25, gz);
        post.castShadow = true;
        g.add(post);
      }
      const gateLintel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.24, 0.4), matTrim);
      gateLintel.position.set(gx, 2.55, gz);
      gateLintel.castShadow = true;
      g.add(gateLintel);

      const gateRoof = new THREE.Mesh(gableRoof(2.9, 1.0, 0.5), matRoof);
      gateRoof.rotation.y = Math.PI / 2;
      gateRoof.position.set(gx, 2.67, gz);
      gateRoof.castShadow = true;
      g.add(gateRoof);

      const gate = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.1, 0.14), matWood);
      gate.position.set(gx, 1.05, gz + 0.02);
      gate.castShadow = true;
      g.add(gate);
    }

    // 烟囱
    if (h.structure !== '砖混') {
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.5, 0.55), matBrick);
      ch.position.set(W / 2 - 1.4, baseY + WH + RH * 0.72, -D / 2 + 1.6);
      ch.castShadow = true;
      g.add(ch);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.1, 0.68), matWallCap);
      cap.position.set(W / 2 - 1.4, baseY + WH + RH * 0.72 + 0.78, -D / 2 + 1.6);
      g.add(cap);
    }

    g.add(proxy(h, [W + 1.4, WH + RH + baseY, D + 1.4], [0, (WH + RH + baseY) / 2, 0]));
    for (const d of YARD_DETAILS) if (d.houseId === h.id) buildYardDetail(d, g);
    root.add(g);
    return g;
  }

  HOUSES.forEach(buildHouse);

  /* ---- 民居构件补强：门板竖纹、加密窗棂、门前三级台阶 ----
   * 每户加 10 条门/窗木条 + 3 级石阶。若按户建 Mesh 是 14×13=182 个 draw call；
   * 这里把「一套构件」合并成一个几何，再用 14 个实例矩阵复用 → 只加 2 个 draw call。 */
  {
    const DD = 7.2, baseY = 0.34;
    const woodParts = [], stoneParts = [];
    // 门板竖纹：两条深色凹槽，压在门板前
    for (const sx of [-0.27, 0.27]) {
      const g = new THREE.BoxGeometry(0.035, 2.10, 0.018);
      g.translate(sx, baseY + 1.14, DD / 2 + 0.008);
      woodParts.push(g);
    }
    // 窗棂加密：每窗 2 竖 2 横，压在玻璃前（与原有十字棂错开 2mm，避免共面）
    for (const dx of [-3.1, 3.1]) {
      for (const sx of [-0.43, 0.43]) {
        const g = new THREE.BoxGeometry(0.04, 1.34, 0.03);
        g.translate(dx + sx, baseY + 2.0, DD / 2 - 0.010);
        woodParts.push(g);
      }
      for (const sy of [-0.36, 0.36]) {
        const g = new THREE.BoxGeometry(1.5, 0.04, 0.03);
        g.translate(dx, baseY + 2.0 + sy, DD / 2 - 0.010);
        woodParts.push(g);
      }
    }
    // 门前三级台阶：从门槛石外沿开始，逐级落到院内地面
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BoxGeometry(1.9, 0.11, 0.30);
      g.translate(0, 0.11 + i * 0.09, DD / 2 + 0.50 + i * 0.30);
      stoneParts.push(g);
    }
    const mkInst = (geo, mat, name) => {
      const im = new THREE.InstancedMesh(geo, mat, HOUSES.length);
      const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      HOUSES.forEach((h, i) => {
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(h.pos[0], heightAt(h.pos[0], h.pos[2]), h.pos[2]),
          q.setFromAxisAngle(up, h.rot),
          new THREE.Vector3(1, 1, 1));
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = im.receiveShadow = true;
      im.name = name;
      root.add(im);
    };
    mkInst(mergeGeometries(woodParts, false), matTrim, 'house-joinery');
    mkInst(mergeGeometries(stoneParts, false), matStone, 'house-steps');
  }

  /* ================= 山神庙：山腰平台上的小庙 + 上山石阶 =================
   * 按材质合批：所有石构件合成一个几何、所有木构件合成一个，
   * 整座庙（含香炉、匾、40 级台阶）总共只占 6 个绘制调用。
   */
  {
    const padY = heightAt(PAD.x, PAD.z);
    const g = new THREE.Group();
    g.position.set(PAD.x, padY, PAD.z);
    root.add(g);

    const W = 5.0;   // 进深（x，东西向）
    const D = 6.0;   // 面阔（z，南北向）
    const WH = 2.9;  // 檐口高
    const baseY = 0.42;

    const bags = new Map();
    const add = (geo, mat, x, y, z, ry = 0) => {
      if (ry) geo.rotateY(ry);
      geo.translate(x, y, z);
      if (!bags.has(mat)) bags.set(mat, []);
      bags.get(mat).push(geo);
    };

    // 台基（比房子略高：山坡上要压住地面）
    add(new THREE.BoxGeometry(W + 0.9, baseY, D + 0.9), matStone, 0, baseY / 2, 0);
    // 墙体
    add(new THREE.BoxGeometry(W, WH, D), matBrick, 0, baseY + WH / 2, 0);
    // 硬山顶：屋脊沿 z（南北向），门开在西面山墙一侧
    add(gableRoof(W + 1.3, D + 1.0, 1.55), matRoof, 0, baseY + WH, 0);
    // 前后檐口压条
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.16, 0.14, D + 1.1), matWallCap, sx * (W / 2 + 0.67), baseY + WH + 0.02, 0);
    }

    // 门洞：西面正中，宽 1.5 高 2.15
    const doorW = 1.5, doorH = 2.15;
    add(new THREE.BoxGeometry(0.10, doorH, doorW), matWood, -W / 2 - 0.03, baseY + doorH / 2, 0);
    // 门框：两竖一横
    for (const sz of [-1, 1]) {
      add(new THREE.BoxGeometry(0.16, doorH + 0.18, 0.12), matTrim,
        -W / 2 - 0.05, baseY + (doorH + 0.18) / 2, sz * (doorW / 2 + 0.06));
    }
    add(new THREE.BoxGeometry(0.16, 0.14, doorW + 0.36), matTrim, -W / 2 - 0.05, baseY + doorH + 0.19, 0);

    // 小匾：门楣上方一块横匾（深色匾心 + 木框），不引入新素材
    add(new THREE.BoxGeometry(0.08, 0.44, 1.34), matWood, -W / 2 - 0.10, baseY + doorH + 0.60, 0);
    add(new THREE.BoxGeometry(0.05, 0.32, 1.14), matDark, -W / 2 - 0.14, baseY + doorH + 0.60, 0);

    // 门前香炉：石座 + 炉身 + 炉口 + 三足
    const cx = -W / 2 - 1.55;
    add(new THREE.BoxGeometry(1.0, 0.16, 1.0), matStone, cx, 0.08, 0);
    add(new THREE.CylinderGeometry(0.34, 0.42, 0.56, 12), matStone, cx, 0.44, 0);
    {
      const rim = new THREE.TorusGeometry(0.40, 0.055, 8, 16);
      rim.rotateX(-Math.PI / 2);                       // 炉口是平躺的一圈
      add(rim, matStone, cx, 0.72, 0);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      add(new THREE.CylinderGeometry(0.05, 0.06, 0.30, 6), matStone,
        cx + Math.cos(a) * 0.30, 0.22, Math.sin(a) * 0.30);
    }

    // 合批落地
    for (const [mat, geos] of bags) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      geos.forEach((gg) => { if (gg !== merged) gg.dispose(); });
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }

    /* ---------- 上山石阶：40 级，每级顶面按地形落地 ---------- */
    {
      const N = 40, x0 = 95.5, x1 = PAD.x - 2.5;
      const tread = (x1 - x0) / N;
      const stepGeos = [];
      for (let i = 0; i < N; i++) {
        const fx = x0 + i * tread;                       // 这一级的下沿
        const top = heightAt(fx, 20) + 0.06;             // 踏面高度：取地形，略抬以免陷进草里
        const h = 2.2;                                   // 石条厚度，埋进坡里，侧面看是实心台阶
        const geo = new THREE.BoxGeometry(tread + 0.10, h, 2.3);
        geo.translate(fx + tread / 2, top - h / 2, 20);
        stepGeos.push(geo);
      }
      const merged = mergeGeometries(stepGeos, false);
      stepGeos.forEach((gg) => gg.dispose());
      const stairs = new THREE.Mesh(merged, matStone);
      stairs.castShadow = stairs.receiveShadow = true;
      root.add(stairs);
    }
  }

  /* ================= 树木：干 / 枝 / 叶 三组实例化，共 3 个绘制调用 ================= */
  const barkT = TEX.bark();
  const matBark = new THREE.MeshStandardMaterial({
    map: barkT.map, normalMap: barkT.normalMap, roughness: 0.92, metalness: 0,
    color: 0xb8a894,
    // 树冠内部几乎照不到直射光，纯 PBR 会把枝条压成黑棍；给一点暖色底光
    emissive: 0x6b5540, emissiveIntensity: 0.32,
  });
  // 树干单独一份材质：在顶点着色器里按高度平方做弯曲，越往上越偏。
  // 偏移在 instanceMatrix 之后加，是绝对米数，不会被树干半径的缩放压扁成几厘米。
  const matBarkTrunk = matBark.clone();
  matBarkTrunk.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4(transformed, 1.0);
       #ifdef USE_INSTANCING
         mvPosition = instanceMatrix * mvPosition;
       #endif
       float _bh = clamp(transformed.y, 0.0, 1.0);
       float _seed = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.4;
       mvPosition.x += pow(_bh, 2.0) * (0.35 + 0.25 * sin(_seed));
       mvPosition.z += pow(_bh, 2.0) * (0.20 * cos(_seed * 1.3));
       mvPosition = modelViewMatrix * mvPosition;
       gl_Position = projectionMatrix * mvPosition;`
    );
  };

  {
    const unitGeo = new THREE.CylinderGeometry(0.38, 1, 1, 10, 1);
    unitGeo.translate(0, 0.5, 0);

    const leafNeutral = TEX.leafCard([238, 236, 226]);
    const matLeaf = new THREE.MeshStandardMaterial({
      map: leafNeutral.map,
      // 法线贴图一直生成了却没用上，白白丢掉叶片的立体感
      normalMap: leafNeutral.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      alphaTest: 0.22,
      side: THREE.DoubleSide,
      roughness: 0.88,
      metalness: 0,
    });
    // 叶片没有 map_fragment 之外的 diffuse 修改点，用 emissive 曲线近似季节色偏
    matLeaf.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.vertexShader = 'uniform float uGreen;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // 春夏舒展变大、入冬收缩；远处按距离补偿，避免叶片小到被采样吃掉
         float _dLeaf = -(modelViewMatrix * vec4(transformed, 1.0)).z;
         float _growLeaf = 1.0 + smoothstep(30.0, 170.0, _dLeaf) * 3.2;
         transformed *= _growLeaf * (0.72 + uGreen * 0.72);`
      );
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _lum2 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summerL = vec3(0.205, 0.375, 0.132) * (0.62 + _lum2 * 1.18);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summerL, uGreen * 0.84);`
      );
      // 叶片透光：真实叶子是薄的，逆光时会透出黄绿光。
      // MeshStandardMaterial 没有次表面项，用背光方向的 emissive 近似，
      // 与几何弯曲的法线配合，近看才不像一块平板贴纸。
        shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         #if NUM_DIR_LIGHTS > 0
           vec3 _sunDirV = directionalLights[0].direction;
           // 透光量必须跟太阳强度走：太阳落山后光强为 0，
           // 否则夜里每片叶子还在自己发绿光，树冠会像灯泡一样亮着
           float _sunI = clamp(dot(directionalLights[0].color, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
           float _backLit = max(0.0, dot(-normal, _sunDirV));
           vec3 _trans = vec3(0.30, 0.46, 0.13) * (0.34 + uGreen * 0.36);
           totalEmissiveRadiance += diffuseColor.rgb * _trans * pow(_backLit, 1.4) * 1.5 * _sunI;
         #endif`
      );
    };
    // 叶片做成横向微卷、叶尖下垂的曲面，而不是一张纸片
    const leafGeo = new THREE.PlaneGeometry(1, 1, 4, 4);
    {
      const lp = leafGeo.attributes.position, luv = leafGeo.attributes.uv;
      for (let i = 0; i < lp.count; i++) {
        const u = luv.getX(i), v = luv.getY(i);
        const cup = -Math.pow((u - 0.5) * 2, 2) * 0.085;   // 沿主脉微微对折
        const droop = -Math.pow(Math.max(0, v - 0.42), 2) * 0.16; // 叶尖下垂
        const ripple = Math.sin(v * Math.PI * 2 + u * 3.0) * 0.012;
        lp.setZ(i, cup + droop + ripple);
      }
      lp.needsUpdate = true;
      leafGeo.computeVertexNormals();
    }

    const trunkM = [], branchM = [], leafM = [], leafC = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);

    for (const t of TREES) {
      const y = heightAt(t.pos[0], t.pos[2]);
      const base = new THREE.Vector3(t.pos[0], y, t.pos[2]);
      const trunkH = t.height * 0.5;
      const rBot = Math.max(0.11, t.dbh / 100 / 2);
      const rTop = rBot * 0.42;
      const rotY = between(0, Math.PI * 2);
      // 与 shader 同一套弯曲参数：树干在 0.88 高度处偏 0.774 倍，枝条从这里长出去，
      // 否则树干弯了、树冠还留在直线上，接口会错开
      const seed = t.pos[0] * 0.7 + t.pos[2] * 0.4;
      const bendX = 0.35 + 0.25 * Math.sin(seed);
      const bendZ = 0.20 * Math.cos(seed * 1.3);
      const crownBX = bendX * 0.774, crownBZ = bendZ * 0.774;

      m4.compose(base, new THREE.Quaternion().setFromAxisAngle(UP, rotY),
        new THREE.Vector3(rBot, trunkH, rBot));
      trunkM.push(m4.clone());

      const nb = 3;                       // 三根主枝，分叉更清楚
      const crownY = y + trunkH * 0.88;
      for (let i = 0; i < nb; i++) {
        const a = rotY + (i / nb) * Math.PI * 2 + between(-0.35, 0.35);
        const tilt = between(0.42, 0.88);
        const dir = new THREE.Vector3(
          Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)
        ).normalize();
        const len = t.canopy * between(0.58, 0.82);
        const start = new THREE.Vector3(base.x + crownBX, crownY, base.z + crownBZ);
        const br = rTop * 1.95;
        q.setFromUnitVectors(UP, dir);
        m4.compose(start, q, new THREE.Vector3(br, len, br));
        branchM.push(m4.clone());

        // 二级枝：从主枝中上段再分出去。三根主枝各分三叉，树冠下不再是光棍
        for (let k = 0; k < 3; k++) {
          const seg = between(0.45, 0.72);
          const mid = start.clone().addScaledVector(dir, len * seg);
          const a2 = a + (k === 0 ? between(0.6, 1.0) : between(-1.0, -0.6));
          const tilt2 = Math.min(1.2, Math.max(0.12, tilt - between(0.15, 0.42)));
          const dir2 = new THREE.Vector3(
            Math.sin(a2) * Math.sin(tilt2), Math.cos(tilt2), Math.cos(a2) * Math.sin(tilt2)
          ).normalize();
          const len2 = len * between(0.42, 0.66);
          q.setFromUnitVectors(UP, dir2);
          m4.compose(mid, q, new THREE.Vector3(br * 0.58, len2, br * 0.58));
          branchM.push(m4.clone());
        }
      }

      // 叶簇：先定团簇中心，再在团簇内撒叶 —— 真实树冠是成团的，不是均匀撒开的
      const cy = crownY + t.canopy * 0.34;
      const baseCol = new THREE.Color(t.leaf[0] / 255, t.leaf[1] / 255, t.leaf[2] / 255).multiplyScalar(1.28);
      const nClusters = Math.round(Math.min(42, Math.max(14, t.canopy * 3.6)));

      for (let ci = 0; ci < nClusters; ci++) {
        const cu = Math.random() * Math.PI * 2;
        const cv = Math.acos(2 * Math.random() - 1);
        const cr = Math.pow(Math.random(), 0.5);
        const ccx = base.x + crownBX + Math.sin(cv) * Math.cos(cu) * t.canopy * 0.74 * cr;
        const ccz = base.z + crownBZ + Math.sin(cv) * Math.sin(cu) * t.canopy * 0.74 * cr;
        const ccy = cy + Math.cos(cv) * t.canopy * 0.52 * cr;

        const per = Math.round(between(12, 24));
        for (let k = 0; k < per; k++) {
          const spread = t.canopy * 0.185;
          const px = ccx + between(-spread, spread);
          const pz = ccz + between(-spread, spread);
          const py = ccy + between(-spread * 0.8, spread * 0.8);
          const sc = between(0.46, 0.86);
          q.setFromEuler(new THREE.Euler(
            between(-Math.PI, Math.PI), between(-Math.PI, Math.PI), between(-Math.PI, Math.PI)
          ));
          m4.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(sc, sc, sc));
          leafM.push(m4.clone());
          leafC.push(baseCol.clone().offsetHSL(
            between(-0.02, 0.02), between(-0.1, 0.05), between(-0.09, 0.11)
          ));
        }
      }

      root.add(proxy(t,
        [t.canopy * 0.9, t.height * 0.86, t.canopy * 0.9],
        [t.pos[0], y + t.height * 0.46, t.pos[2]]));
    }

    const mkInst = (geo, mat, list, colors) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mx, i) => im.setMatrixAt(i, mx));
      if (colors) colors.forEach((c, i) => im.setColorAt(i, c));
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      root.add(im);
      return im;
    };

    mkInst(unitGeo, matBarkTrunk, trunkM);
    mkInst(unitGeo, matBark, branchM);
    mkInst(leafGeo, matLeaf, leafM, leafC);
  }

  /* ================= 家畜 =================
   * 低模动物：躯干/脖子/头/口鼻/耳/角/眼/两段腿/尾巴+毛球全部程序化拼出来，
   * 但每只只留「身体 1 Mesh + 头 1 Mesh」两个网格，16 只共 32 个 draw call。
   * 毛色用顶点色做背深腹浅；尾巴的 aTail 属性在顶点着色器里缓慢摆动；
   * 头是独立 Mesh，pivot 在脖子根，每帧绕 z 轴低头吃草。 */
  const animalUniforms = { uTime: { value: 0 } };
  const matHide = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  matHide.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = animalUniforms.uTime;
    shader.vertexShader = 'attribute float aTail;\nuniform float uTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // 尾巴：越靠末端权重越大；相位按世界位置错开，16 只不会同步摆
       float _ph = modelMatrix[3].x * 0.73 + modelMatrix[3].z * 0.51;
       float _sw = sin(uTime * 1.15 + _ph) * aTail;
       transformed.z += _sw * 0.11;
       transformed.y += abs(_sw) * 0.02;`
    );
  };

  const animals = [];
  const animalGeoCache = new Map();

  function paintGeo(geo, fn) {
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      fn(p.getX(i), p.getY(i), p.getZ(i), c);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }
  function setTail(geo, rootX, tipX) {
    const p = geo.attributes.position;
    const arr = new Float32Array(p.count);
    const span = rootX - tipX || 1;
    for (let i = 0; i < p.count; i++) {
      arr[i] = Math.min(1, Math.max(0, (rootX - p.getX(i)) / span));
    }
    geo.setAttribute('aTail', new THREE.BufferAttribute(arr, 1));
    return geo;
  }
  function noTail(geo) {
    const p = geo.attributes.position;
    geo.setAttribute('aTail', new THREE.BufferAttribute(new Float32Array(p.count), 1));
    return geo;
  }
  const put = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    if (rx) geo.rotateX(rx);
    if (ry) geo.rotateY(ry);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    return geo;
  };

  const HIDE = {
    '牛': { dark: 0x54331f, light: 0x916741, face: 0x6b4a30, leg: 0x4d2f1c, horn: 0xcfc0a0 },
    '羊': { dark: 0xc9c2b2, light: 0xefeae0, face: 0xb3a795, leg: 0x9d9282, horn: 0x8e8272 },
    '鸡': { dark: 0x8f552c, light: 0xd59a5c, face: 0xc23b2e, leg: 0xb98a3f, horn: 0xd8a94a },
  };

  /** 一种动物的两套几何：身体（躯干+腿+尾）与头（脖子+头+口鼻+耳+角/冠+眼） */
  function makeAnimalGeo(kind) {
    const S = kind === '牛' ? 1 : kind === '羊' ? 0.62 : 0.22;
    const L = 1.7 * S, H = 0.78 * S, W = 0.7 * S;
    const C = HIDE[kind];
    const dark = new THREE.Color(C.dark), light = new THREE.Color(C.light);
    const faceC = new THREE.Color(C.face), legC = new THREE.Color(C.leg);
    const hornC = new THREE.Color(C.horn);
    const body = [], head = [];

    /* ---- 躯干：椭球；牛有肩峰，羊有轻微背弓 ---- */
    const torso = new THREE.SphereGeometry(1, 18, 13);
    torso.scale(L * 0.5, H * 0.55, W * 0.50);
    {
      const p = torso.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const up = Math.max(0, y / (H * 0.5));
        if (kind === '牛') {
          // 肩峰：长在前腿上方（x≈0.55），窄而缓；背线再加一点起伏
          const hump = Math.exp(-((x - 0.55) ** 2) / 0.05) * up * 0.085;
          const spine = Math.exp(-(z * z) / 0.03) * up * 0.018 * Math.sin(x * 5.5);
          p.setY(i, y + hump + spine);
        } else if (kind === '羊') {
          p.setY(i, y + Math.exp(-((x - 0.16) ** 2) / 0.08) * up * 0.05);
        }
      }
      torso.computeVertexNormals();
    }
    paintGeo(torso, (x, y, z, c) => {
      const t = Math.min(1, Math.max(0, (y / (H * 0.5) + 1) * 0.5)); // 0 腹 1 背
      c.copy(light).lerp(dark, t * t);
      const spine = Math.exp(-(z * z) / (W * W * 0.05)) * 0.08 * t;
      c.offsetHSL(0, 0, -spine);
    });
    noTail(torso);
    torso.translate(0, H * 1.14, 0);
    body.push(torso);

    /* ---- 四条腿：上段粗、下段细、中间一个关节球 ---- */
    const legH = H * 0.78;
    const rU = kind === '牛' ? 0.12 : kind === '羊' ? 0.062 : 0.020;
    for (const [lx, lz] of [[-0.55, -0.24], [-0.55, 0.24], [0.55, -0.24], [0.55, 0.24]]) {
      const x = lx * L, z = lz * W * 1.6;
      const up = new THREE.CylinderGeometry(rU, rU * 0.78, legH * 0.55, 6);
      paintGeo(up, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, py < 0 ? -0.05 : 0.02); });
      noTail(up);
      body.push(put(up, x, legH * 0.72, z));
      const lo = new THREE.CylinderGeometry(rU * 0.72, rU * 0.5, legH * 0.5, 6);
      paintGeo(lo, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, py < 0 ? -0.07 : 0); });
      noTail(lo);
      body.push(put(lo, x, legH * 0.25, z));
      const knee = new THREE.SphereGeometry(rU * 0.95, 7, 5);
      paintGeo(knee, (px, py, pz, c) => { c.copy(legC).offsetHSL(0, 0, -0.03); });
      noTail(knee);
      body.push(put(knee, x, legH * 0.47, z));
    }

    /* ---- 尾巴：牛/羊是细尾 + 末端毛球；鸡是尾羽丛 ---- */
    if (kind === '鸡') {
      const rootX = -L * 0.42, rootY = H * 1.35;
      for (let i = 0; i < 3; i++) {
        const f = new THREE.ConeGeometry(0.045, 0.30, 4);
        f.scale(1, 1, 0.42);
        paintGeo(f, (px, py, pz, c) => { c.set(0x33402a).offsetHSL(0, 0, (i - 1) * 0.02); });
        put(f, rootX, rootY, (i - 1) * 0.045, 0, 0, 1.15 + (i - 1) * 0.16);
        setTail(f, rootX, rootX - 0.25);
        body.push(f);
      }
      const tuft = new THREE.SphereGeometry(0.028, 7, 5);
      paintGeo(tuft, (px, py, pz, c) => { c.set(0x2b3622); });
      put(tuft, rootX - 0.24, rootY + 0.10, 0);
      setTail(tuft, rootX, rootX - 0.25);
      body.push(tuft);
    } else {
      const tailLen = (kind === '牛' ? 0.72 : 0.46) * S;
      const dx = -0.93, dy = -0.37;
      const rx = -L * 0.48, ry = H * 0.96;
      const tail = new THREE.CylinderGeometry(0.040 * S, 0.026 * S, tailLen, 5);
      paintGeo(tail, (px, py, pz, c) => { c.copy(dark).offsetHSL(0, 0, -0.04); });
      put(tail, rx + dx * tailLen * 0.5, ry + dy * tailLen * 0.5, 0, 0, 0, 1.95);
      setTail(tail, rx, rx + dx * tailLen);
      body.push(tail);
      const ball = new THREE.SphereGeometry(0.075 * S, 8, 6);
      paintGeo(ball, (px, py, pz, c) => { c.copy(dark).offsetHSL(0, 0, -0.07); });
      put(ball, rx + dx * tailLen, ry + dy * tailLen, 0);
      setTail(ball, rx, rx + dx * tailLen);
      body.push(ball);
    }

    /* ---- 头：pivot 在脖子根，低头时整段脖子跟着转 ---- */
    const pivotX = L * 0.33, pivotY = H * 1.14;
    const neckLen = kind === '牛' ? 0.55 * S : kind === '羊' ? 0.55 * S : 0.95 * S;
    const tilt = kind === '牛' ? 0.38 : kind === '羊' ? 0.72 : 0.55;   // 牛粗短平伸，羊细长上举
    const nR = kind === '牛' ? 0.21 * S : kind === '羊' ? 0.10 * S : 0.055 * S;
    const neck = new THREE.CylinderGeometry(nR * 0.82, nR, neckLen, 7);
    paintGeo(neck, (px, py, pz, c) => { c.copy(faceC).lerp(dark, 0.45); });
    noTail(neck);
    put(neck, Math.cos(tilt) * neckLen * 0.5, Math.sin(tilt) * neckLen * 0.5, 0, 0, 0, -Math.PI / 2 + tilt);
    head.push(neck);

    const headR = kind === '牛' ? 0.26 : kind === '羊' ? 0.16 : 0.08;
    const hx = Math.cos(tilt) * neckLen + headR * 0.55;
    const hy = Math.sin(tilt) * neckLen + headR * 0.15;
    const skull = new THREE.SphereGeometry(1, 14, 10);
    skull.scale(headR * 1.05, headR * 0.95, headR * 0.85);
    paintGeo(skull, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, 0.03); });
    noTail(skull);
    head.push(put(skull, hx, hy, 0));

    const muzzle = new THREE.SphereGeometry(1, 10, 8);
    muzzle.scale(headR * 0.72, headR * 0.55, headR * 0.62);
    paintGeo(muzzle, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, 0.07); });
    noTail(muzzle);
    head.push(put(muzzle, hx + headR * 0.82, hy - headR * 0.30, 0));

    for (const s of [-1, 1]) {
      if (kind === '鸡') {
        // 鸡耳只是头侧一小撮，不做外扩
        const ear = new THREE.SphereGeometry(headR * 0.22, 6, 4);
        paintGeo(ear, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, -0.05); });
        noTail(ear);
        head.push(put(ear, hx - headR * 0.25, hy + headR * 0.15, s * headR * 0.78));
        continue;
      }
      const ear = new THREE.SphereGeometry(1, 8, 6);
      ear.scale(headR * 0.55, headR * 0.22, headR * 0.32);
      paintGeo(ear, (px, py, pz, c) => { c.copy(faceC).offsetHSL(0, 0, -0.03); });
      noTail(ear);
      // 牛耳横伸，羊耳下垂
      const earRz = kind === '羊' ? s * 1.05 : s * 0.42;
      head.push(put(ear, hx - headR * 0.02, hy + headR * 0.50, s * headR * 0.86, 0, 0, earRz));
    }

    if (kind === '牛' || kind === '羊') {
      for (const s of [-1, 1]) {
        const horn = new THREE.ConeGeometry(headR * (kind === '牛' ? 0.26 : 0.16),
          headR * (kind === '牛' ? 1.25 : 0.55), 5);
        paintGeo(horn, (px, py, pz, c) => { c.copy(hornC); });
        noTail(horn);
        if (kind === '牛') {
          head.push(put(horn, hx - headR * 0.15, hy + headR * 0.82, s * headR * 0.60, 0, 0, s * 0.95));
        } else {
          // 羊角向后弯，贴着耳后
          head.push(put(horn, hx - headR * 0.42, hy + headR * 0.42, s * headR * 0.52, 0, 0, s * 1.95));
        }
      }
    } else {
      // 鸡冠：三颗红球；肉垂一颗
      for (const [cx, cy, cr] of [[-0.30, 0.42, 0.32], [0.0, 0.52, 0.40], [0.30, 0.42, 0.30]]) {
        const comb = new THREE.SphereGeometry(headR * cr, 7, 5);
        paintGeo(comb, (px, py, pz, c) => { c.set(0xb8342a); });
        noTail(comb);
        head.push(put(comb, hx + headR * cx, hy + headR * cy, 0));
      }
      const wattle = new THREE.SphereGeometry(headR * 0.30, 7, 5);
      paintGeo(wattle, (px, py, pz, c) => { c.set(0xa82f26); });
      noTail(wattle);
      head.push(put(wattle, hx + headR * 0.72, hy - headR * 0.62, 0));
      const beak = new THREE.ConeGeometry(headR * 0.30, headR * 0.72, 4);
      paintGeo(beak, (px, py, pz, c) => { c.copy(hornC); });
      noTail(beak);
      head.push(put(beak, hx + headR * 1.08, hy - headR * 0.10, 0, 0, 0, -Math.PI / 2));
    }

    // 眼睛：两侧各一颗小黑球
    for (const s of [-1, 1]) {
      const eye = new THREE.SphereGeometry(headR * (kind === '鸡' ? 0.16 : 0.13), 7, 5);
      paintGeo(eye, (px, py, pz, c) => { c.set(0x14100c); });
      noTail(eye);
      head.push(put(eye, hx + headR * 0.42, hy + headR * 0.20, s * headR * 0.72));
    }

    return {
      bodyGeo: mergeGeometries(body, false),
      headGeo: mergeGeometries(head, false),
      pivotX, pivotY,
    };
  }

  function buildAnimal(a) {
    const g = new THREE.Group();
    const y = heightAt(a.pos[0], a.pos[2]);
    g.position.set(a.pos[0], y, a.pos[2]);
    g.rotation.y = between(0, Math.PI * 2);

    if (!animalGeoCache.has(a.kind)) animalGeoCache.set(a.kind, makeAnimalGeo(a.kind));
    const G = animalGeoCache.get(a.kind);

    const bodyMesh = new THREE.Mesh(G.bodyGeo, matHide);
    bodyMesh.castShadow = true;
    g.add(bodyMesh);

    const headMesh = new THREE.Mesh(G.headGeo, matHide);
    headMesh.position.set(G.pivotX, G.pivotY, 0);
    headMesh.castShadow = true;
    g.add(headMesh);

    const scale = a.kind === '牛' ? 1 : a.kind === '羊' ? 0.62 : 0.22;
    const bodyLen = 1.7 * scale, bodyH = 0.78 * scale, bodyW = 0.7 * scale;
    g.add(proxy(a, [bodyLen * 1.5, bodyH * 2.4, bodyW * 2.4], [0, bodyH * 1.1, 0]));
    root.add(g);
    animals.push({ group: g, head: headMesh, base: g.position.clone(), phase: rnd() * 10, kind: a.kind });
    return g;
  }
  ANIMAL_LIST.forEach(buildAnimal);

  /* ================= 公共设施 ================= */
  // 路灯：灯罩自发光 + 有限半径点光源，夜里由 environment.js 按昼夜点亮
  const matLampGlow = new THREE.MeshStandardMaterial({
    color: 0x2b2a27, emissive: 0xffd39a, emissiveIntensity: 0, roughness: 0.42,
  });
  const matLampPole = new THREE.MeshStandardMaterial({ color: 0x8d938f, metalness: 0.65, roughness: 0.42 });
  const matSolar = new THREE.MeshStandardMaterial({ color: 0x1d2634, metalness: 0.35, roughness: 0.28 });
  const lampLights = [];

  function buildFacility(f) {
    const g = new THREE.Group();
    const y = heightAt(f.pos[0], f.pos[2]);
    g.position.set(f.pos[0], y, f.pos[2]);

    if (f.kind === 'well') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.75, 16), matStone);
      base.position.y = 0.38; base.castShadow = base.receiveShadow = true; g.add(base);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.16, 8, 20), matStone);
      rim.rotation.x = Math.PI / 2; rim.position.y = 0.78; g.add(rim);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.92, 16), new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.3 }));
      hole.rotation.x = -Math.PI / 2; hole.position.y = 0.66; g.add(hole);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.0, 0.16), matWood);
        post.position.set(s * 0.95, 1.75, 0); post.castShadow = true; g.add(post);
      }
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.0, 8), matWood);
      beam.rotation.z = Math.PI / 2; beam.position.y = 2.6; g.add(beam);
      g.add(proxy(f, [2.8, 3.0, 2.8], [0, 1.4, 0]));
    }
    else if (f.kind === 'committee') {
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(13, 3.4, 8.4), matBrick);
      b1.position.y = 1.7; b1.castShadow = b1.receiveShadow = true; g.add(b1);
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(13, 3.2, 8.4), matPlaster);
      b2.position.y = 5.0; b2.castShadow = true; g.add(b2);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.34, 9.0), matRoof);
      roof.position.y = 6.78; roof.castShadow = true; g.add(roof);
      for (let i = -2; i <= 2; i++) {
        const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 0.1), matGlass);
        win.position.set(i * 2.4, 4.9, 4.24); g.add(win);
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 8, 8), new THREE.MeshStandardMaterial({ color: 0xcfd6da, metalness: 0.8, roughness: 0.3 }));
      pole.position.set(-4, 4, 7); g.add(pole);
      g.add(proxy(f, [14, 7.2, 9.4], [0, 3.6, 0]));
    }
    else if (f.kind === 'barn') {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(22, 0.2, 13), new THREE.MeshStandardMaterial({ color: 0x8c8577, roughness: 1 }));
      floor.position.y = 0.1; floor.receiveShadow = true; g.add(floor);
      const roof = new THREE.Mesh(gableRoof(13, 22, 2.6), new THREE.MeshStandardMaterial({ color: 0x6f7a80, roughness: 0.7, metalness: 0.3 }));
      roof.rotation.y = Math.PI / 2; roof.position.set(0, 3.0, 0); roof.castShadow = true; g.add(roof);
      for (const s of [-1, 1]) {
        for (let i = -3; i <= 3; i++) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.0, 6), new THREE.MeshStandardMaterial({ color: 0x8d949a, metalness: 0.6, roughness: 0.5 }));
          post.position.set(i * 3, 1.5, s * 6.2); post.castShadow = true; g.add(post);
        }
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(22, 0.12, 0.12), matWood);
      rail.position.set(0, 1.1, 6.2); g.add(rail);
      g.add(proxy(f, [23, 5.4, 14], [0, 2.7, 0]));
    }
    else if (f.kind === 'yard' || f.kind === 'plaza') {
      const mat = new THREE.MeshStandardMaterial({ color: 0x9d998e, roughness: 0.95 });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(f.kind === 'plaza' ? 30 : 26, 0.16, f.kind === 'plaza' ? 20 : 17), mat);
      slab.position.y = 0.08; slab.receiveShadow = true; g.add(slab);
      if (f.kind === 'plaza') {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 9, 8), new THREE.MeshStandardMaterial({ color: 0xdfe4e6, metalness: 0.7, roughness: 0.35 }));
        pole.position.set(-9, 4.5, 6); pole.castShadow = true; g.add(pole);
      } else {
        for (let i = 0; i < 5; i++) {
          const heap = new THREE.Mesh(new THREE.ConeGeometry(between(0.8, 1.4), between(0.5, 0.9), 10), new THREE.MeshStandardMaterial({ color: 0x8a7050, roughness: 1 }));
          heap.position.set(between(-9, 9), 0.3, between(-5, 5));
          heap.castShadow = true; g.add(heap);
        }
      }
      g.add(proxy(f, [f.kind === 'plaza' ? 31 : 27, 1.2, f.kind === 'plaza' ? 21 : 18], [0, 0.6, 0]));
    }
    else if (f.kind === 'mill') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.2, 5.4), matPlaster);
      body.position.y = 1.6; body.castShadow = body.receiveShadow = true; g.add(body);
      const roof = new THREE.Mesh(gableRoof(7.2, 6.2, 1.9), matRoof);
      roof.position.y = 3.2; roof.castShadow = true; g.add(roof);
      // 河在磨坊西侧：水轮挂在朝河那一面，轮面法线沿 x（正对河），
      // 轮缘下沿落在常水位附近，从河西看过去是"轮子泡在水边"。
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.16, 8, 18), matWood);
      wheel.position.set(-5.2, 1.45, 0); wheel.rotation.y = Math.PI / 2;
      wheel.castShadow = true; g.add(wheel);
      const axle = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 0.18), matWood);
      axle.name = 'mill-axle';
      axle.position.set(-4.1, 1.45, 0); axle.castShadow = true; g.add(axle);
      g.add(proxy(f, [11, 5.2, 6.4], [-1.5, 2.4, 0]));
    }
    else if (f.kind === 'streetlight') {
      const side = f.pos[0] < 0 ? 1 : -1;      // 灯臂一律伸向路中心
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.24, 0.26, 10), matStone);
      base.position.y = 0.13; base.castShadow = true; g.add(base);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, 4.6, 8), matLampPole);
      pole.position.y = 2.3; pole.castShadow = true; g.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.075, 0.075), matLampPole);
      arm.position.set(side * 0.5, 4.52, 0); arm.castShadow = true; g.add(arm);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.30), matLampGlow);
      head.position.set(side * 0.98, 4.44, 0); g.add(head);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.56), matSolar);
      panel.position.set(-side * 0.22, 4.78, 0);
      panel.rotation.z = side * 0.30; panel.castShadow = true; g.add(panel);
      const pl = new THREE.PointLight(0xffd8a4, 0, 18, 2);
      pl.position.set(side * 0.98, 4.28, 0);
      g.add(pl);
      lampLights.push(pl);
      g.add(proxy(f, [1.9, 5.0, 1.2], [side * 0.35, 2.5, 0]));
    }
    else if (f.kind === 'signboard') {
      const sign = TEX.signBoard().map;
      const matSign = new THREE.MeshStandardMaterial({ map: sign, roughness: 0.9, metalness: 0 });
      for (const sx of [-1.5, 1.5]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 2.3, 8), matLampPole);
        post.position.set(sx, 1.15, 0); post.castShadow = true; g.add(post);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.32), matStone);
        foot.position.set(sx, 0.11, 0); g.add(foot);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.6, 0.10), matLampPole);
      frame.position.set(0, 2.0, 0); frame.castShadow = true; g.add(frame);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(3.42, 1.42), matSign);
      face.position.set(0, 2.0, 0.056); g.add(face);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.09, 0.34), matWallCap);
      hood.position.set(0, 2.86, 0.02); hood.castShadow = true; g.add(hood);
      g.add(proxy(f, [4.0, 3.0, 0.8], [0, 1.5, 0]));
    }

    root.add(g);
    return g;
  }
  FACILITIES.forEach(buildFacility);

  /* ================= 田块 ================= */
  const soilT = TEX.soil();
  for (const f of FIELDS) {
    const g = new THREE.Group();
    const y = heightAt(f.pos[0], f.pos[2]);
    g.position.set(f.pos[0], y, f.pos[2]);
    g.rotation.y = f.rot;

    const geo = new THREE.PlaneGeometry(f.size[0], f.size[1], 1, 1);
    geo.rotateX(-Math.PI / 2);

    // 每块地按自身尺寸铺垄：垄距固定约 0.75 m，不随地块大小变形
    const fMap = soilT.map.clone();
    fMap.needsUpdate = true;
    fMap.repeat.set(Math.max(0.6, f.size[0] / 11), Math.max(2, f.size[1] / 3.2));
    const fNrm = soilT.normalMap.clone();
    fNrm.needsUpdate = true;
    fNrm.repeat.copy(fMap.repeat);
    fNrm.wrapS = fNrm.wrapT = THREE.RepeatWrapping;

    const fieldMat = new THREE.MeshStandardMaterial({
      map: fMap, normalMap: fNrm, normalScale: new THREE.Vector2(2.2, 2.2),
      roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -1,
    });
    // 远处一株作物只有几个像素，靠田面自身泛绿表达"这块地种着东西"
    fieldMat.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float _fl = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _cropTone = vec3(0.155, 0.205, 0.088) * (0.72 + _fl * 1.24);
         diffuseColor.rgb = mix(diffuseColor.rgb, _cropTone, uGreen * 0.58);
         // 田面整体压暗一档，否则在强光下像刷了白漆
         diffuseColor.rgb *= 0.74;`
      );
    };
    const m = new THREE.Mesh(geo, fieldMat);
    m.position.y = 0.05;
    m.receiveShadow = true;
    g.add(m);

    // 田埂
    const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x6f6047, roughness: 1 });
    for (const [w, d, px, pz] of [
      [f.size[0], 0.5, 0, f.size[1] / 2], [f.size[0], 0.5, 0, -f.size[1] / 2],
      [0.5, f.size[1], f.size[0] / 2, 0], [0.5, f.size[1], -f.size[0] / 2, 0],
    ]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.34, d), ridgeMat);
      r.position.set(px, 0.17, pz);
      r.castShadow = r.receiveShadow = true;
      g.add(r);
    }

    g.add(proxy(f, [f.size[0], 1.0, f.size[1]], [0, 0.5, 0]));
    root.add(g);
  }

  /* ================= 村口树下：石墩、石碾、水窖 =================
   * 石头全部复用 TEX.stone() 的石材贴图（只 clone 改 repeat，不新建贴图素材）。
   * 控制 draw call：石墩 5 只合并成 1 个 Mesh；石碾石件/木架各 1；
   * 3 处水窖按石/铁/木各合并 1 个。合计 +6，预算 15。
   * 每只石墩、石碾、每处水窖各挂一个 invisible proxy，射线只打代理。 */
  {
    // 石墩与碾盘用同一套放大后的石纹：repeat 调小，砌块缝消失，读成整石凿面
    const seatMap = stoneT.map.clone();
    seatMap.needsUpdate = true;
    seatMap.wrapS = seatMap.wrapT = THREE.RepeatWrapping;
    seatMap.repeat.set(0.90, 0.75);
    const seatNrm = stoneT.normalMap.clone();
    seatNrm.needsUpdate = true;
    seatNrm.wrapS = seatNrm.wrapT = THREE.RepeatWrapping;
    seatNrm.repeat.copy(seatMap.repeat);
    const matSeatStone = new THREE.MeshStandardMaterial({
      map: seatMap, normalMap: seatNrm,
      normalScale: new THREE.Vector2(1.35, 1.35), roughness: 0.96,
    });
    const matWellStone = matSeatStone.clone();
    matWellStone.side = THREE.DoubleSide;          // 窖壁从上面看是内表面
    const matIron = new THREE.MeshStandardMaterial({
      color: 0x3b4144, metalness: 0.72, roughness: 0.44,
    });

    /** 凿痕：沿周向的低频起伏把圆柱侧面揉得不规整（顶/底中心点跳过） */
    const roughen = (geo, seed, amp) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const r = Math.hypot(x, z);
        if (r < 1e-4) continue;
        const a = Math.atan2(z, x);
        const d = (Math.sin(a * 7 + seed) * 0.62 + Math.sin(a * 17 + y * 11 + seed * 2) * 0.38) * amp;
        const f = 1 + d / Math.max(r, 0.12);
        p.setX(i, x * f); p.setZ(i, z * f);
      }
      geo.computeVertexNormals();
    };

    /* ---- 一、老杨树下的五只八棱石墩 ---- */
    // 坐面单独用“整石凿平”的材质：只有石材法线、没有砌块缝，免得顶面读成井盖；
    // 侧面仍带 stone 的石纹与凿痕。两只 Mesh 各合并一次，draw call +2。
    const seatTopNrm = stoneT.normalMap.clone();
    seatTopNrm.needsUpdate = true;
    seatTopNrm.wrapS = seatTopNrm.wrapT = THREE.RepeatWrapping;
    seatTopNrm.repeat.set(1.5, 1.5);
    const matSeatTop = new THREE.MeshStandardMaterial({
      color: 0x948d81, normalMap: seatTopNrm,
      normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.98,
    });

    const seatParts = [];
    for (let i = 0; i < STONES.length; i++) {
      const s = STONES[i];
      const yBase = heightAt(s.pos[0], s.pos[1]) - 0.010;
      const place = (g) => {
        g.rotateY(s.rotY);
        // 每只略微歪一点：倾斜量不同，底下再压 1cm 免得翘角
        g.rotateX(-0.032 + (i % 3) * 0.026);
        g.rotateZ(0.022 - (i % 2) * 0.036);
        // CylinderGeometry 以几何中心为原点，必须整体抬到「柱底 + 半个坐高」，
        // 否则一半会埋在地面以下，露出来的坐高只剩 0.2m。
        g.translate(s.pos[0], yBase + s.seatHeight / 2, s.pos[1]);
        return g;
      };
      // 侧面：开口八棱柱（不封顶，坐面单独铺）
      const side = new THREE.CylinderGeometry(s.radius * 0.94, s.radius * 1.05, s.seatHeight, 8, 3, true);
      roughen(side, i * 2.3 + 0.7, 0.010);
      seatParts.push(place(side));
      // 坐面：整石凿平的一块，比柱顶低 1.2cm（磨凹），略大于开口盖住缝
      const top = new THREE.CircleGeometry(s.radius * 0.95, 8);
      top.rotateX(-Math.PI / 2);
      top.translate(0, s.seatHeight / 2 - 0.012, 0);
      const uv = top.attributes.uv, tp = top.attributes.position;
      for (let k = 0; k < uv.count; k++) {
        uv.setXY(k, tp.getX(k) / (s.radius * 2.0) + 0.5, tp.getZ(k) / (s.radius * 2.0) + 0.5);
      }
      uv.needsUpdate = true;
      seatParts.push(place(top));
    }
    // 侧面与坐面合成一个 Mesh，统一用“整石凿面”材质；顶点色带一点石料色差，
    // 避免纯色发死。这样 5 只石墩只占 1 个 draw call。
    const seatGeo = mergeGeometries(seatParts, false);
    {
      const p = seatGeo.attributes.position, col = [];
      for (let k = 0; k < p.count; k++) {
        const n = 0.93 + 0.07 * (0.5 + 0.5 * Math.sin(
          p.getX(k) * 9.1 + p.getZ(k) * 7.3 + p.getY(k) * 11.7));
        col.push(n, n * 0.995, n * 0.97);
      }
      seatGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    matSeatTop.vertexColors = true;
    const seatMesh = new THREE.Mesh(seatGeo, matSeatTop);
    seatMesh.name = 'village-stone-seats';
    seatMesh.castShadow = seatMesh.receiveShadow = true;
    root.add(seatMesh);
    for (const s of STONES) {
      root.add(proxy(s, [s.radius * 2.6, s.seatHeight + 0.16, s.radius * 2.6],
        [s.pos[0], s.seatHeight * 0.5, s.pos[1]]));
    }

    /* ---- 二、老槐树下的石碾：碾盘 2.4m + 碾磙 + 木架 ---- */
    {
      const M = MILLSTONE;
      const base = heightAt(M.pos[0], M.pos[1]);
      const stoneParts = [], woodParts = [];

      const disc = new THREE.CylinderGeometry(1.2, 1.2, 0.18, 30, 1, false);
      roughen(disc, 1.7, 0.013);                       // 边缘磨得不圆
      disc.translate(0, 0.09, 0);
      stoneParts.push(disc);
      // 外缘磨圆的亮边（比盘面高 1cm，侧光时能看出 2~3cm 的凹槽）
      const rim = new THREE.TorusGeometry(1.185, 0.028, 6, 30);
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 0.145, 0);
      stoneParts.push(rim);
      // 中心立轴
      const post = new THREE.CylinderGeometry(0.095, 0.11, 1.05, 10);
      post.translate(0, 0.62, 0);
      stoneParts.push(post);
      // 碾磙：横躺，轴线沿 x，压在盘面 z=+0.55
      const roller = new THREE.CylinderGeometry(0.36, 0.36, 1.35, 20);
      roller.rotateZ(Math.PI / 2);
      roller.translate(0, 0.54, 0.55);
      stoneParts.push(roller);

      // 木架：立轴横担 + 两根连杆 + 推杆 + 碾磙木轴
      const beam = new THREE.BoxGeometry(1.55, 0.12, 0.12);
      beam.translate(0, 1.03, 0);
      woodParts.push(beam);
      for (const sx of [-0.56, 0.56]) {
        const link = new THREE.BoxGeometry(0.09, 0.09, 0.62);
        link.translate(sx, 0.99, 0.27);
        woodParts.push(link);
      }
      const handle = new THREE.BoxGeometry(0.075, 0.075, 1.55);
      handle.translate(0, 1.03, -0.80);
      woodParts.push(handle);
      const axle = new THREE.CylinderGeometry(0.045, 0.045, 1.72, 8);
      axle.rotateZ(Math.PI / 2);
      axle.translate(0, 0.54, 0.55);
      woodParts.push(axle);

      const ms = new THREE.Mesh(mergeGeometries(stoneParts, false), matSeatStone);
      ms.name = 'village-millstone-stone';
      ms.position.set(M.pos[0], base, M.pos[1]);
      ms.castShadow = ms.receiveShadow = true;
      root.add(ms);
      const mw = new THREE.Mesh(mergeGeometries(woodParts, false), matWood);
      mw.name = 'village-millstone-wood';
      mw.position.set(M.pos[0], base, M.pos[1]);
      mw.castShadow = mw.receiveShadow = true;
      root.add(mw);
      root.add(proxy(M, [2.7, 1.45, 2.7], [M.pos[0], base + 0.72, M.pos[1]]));
    }

    /* ---- 三、三处水窖：内凹窖口 + 铸铁盖 + 简易辘轳 ---- */
    {
      const stoneParts = [], ironParts = [], woodParts = [];
      for (const c of CISTERNS) {
        const base = heightAt(c.pos[0], c.pos[1]);
        const at = (geo) => geo.translate(c.pos[0], base, c.pos[1]);

        // 石砌窖台：一圈石环，顶面略高于地面
        const collar = new THREE.TorusGeometry(0.74, 0.12, 8, 22);
        collar.rotateX(Math.PI / 2);
        collar.translate(0, 0.10, 0);
        stoneParts.push(at(collar));
        // 内凹的窖壁（上大下小），DoubleSide 保证从上面看得到内表面
        const wall = new THREE.CylinderGeometry(0.62, 0.54, 0.95, 18, 1, true);
        wall.translate(0, -0.375, 0);
        stoneParts.push(at(wall));
        // 窖底：压到 -0.845，从口部看下去是暗的
        const bottom = new THREE.CircleGeometry(0.535, 18);
        bottom.rotateX(-Math.PI / 2);
        bottom.translate(0, -0.845, 0);
        stoneParts.push(at(bottom));

        // 铸铁盖挪到窖台南侧地上，窖口完全露出（打水时的常态）
        const lid = new THREE.CylinderGeometry(0.60, 0.60, 0.05, 20);
        lid.rotateZ(0.08);
        lid.translate(0, 0.028, 1.02);
        ironParts.push(at(lid));
        const ring = new THREE.TorusGeometry(0.10, 0.018, 6, 12);
        ring.rotateZ(0.08);
        ring.translate(0, 0.115, 1.12);
        ironParts.push(at(ring));

        // 辘轳：两根立柱 + 横轴 + 摇柄
        for (const sx of [-0.78, 0.78]) {
          const post = new THREE.BoxGeometry(0.09, 1.30, 0.09);
          post.translate(sx, 0.65, 0);
          woodParts.push(at(post));
        }
        const shaft = new THREE.CylinderGeometry(0.05, 0.05, 1.72, 8);
        shaft.rotateZ(Math.PI / 2);
        shaft.translate(0, 1.22, 0);
        woodParts.push(at(shaft));
        const crank = new THREE.BoxGeometry(0.06, 0.06, 0.42);
        crank.translate(0.86, 1.22, 0.21);
        woodParts.push(at(crank));
        const grip = new THREE.BoxGeometry(0.07, 0.26, 0.07);
        grip.translate(0.86, 1.08, 0.42);
        woodParts.push(at(grip));

        root.add(proxy(c, [1.9, 1.55, 1.9], [c.pos[0], base + 0.78, c.pos[1]]));
      }
      const cs = new THREE.Mesh(mergeGeometries(stoneParts, false), matWellStone);
      cs.name = 'village-cistern-stone';
      cs.castShadow = cs.receiveShadow = true;
      root.add(cs);
      const ci = new THREE.Mesh(mergeGeometries(ironParts, false), matIron);
      ci.name = 'village-cistern-iron';
      ci.castShadow = true;
      root.add(ci);
      const cw = new THREE.Mesh(mergeGeometries(woodParts, false), matWood);
      cw.name = 'village-cistern-wood';
      cw.castShadow = true;
      root.add(cw);
    }
  }

  /* ================= 田里作物：一行行种在垄上，随季节生长与枯死 ================= */
  let cropMesh = null;
  let cropCount = 0;
  if (!new URLSearchParams(location.search).has('nocrop')) {
    const cropT = TEX.cropPlant();
    const mat = new THREE.MeshStandardMaterial({
      map: cropT.map,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.92,
      metalness: 0,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGreen = seasonUniform;
      shader.vertexShader = 'uniform float uGreen;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // 冬天归零（收完了），夏天满高
         float _cg = smoothstep(0.06, 0.5, uGreen);
         float _dc = -(modelViewMatrix * vec4(transformed, 1.0)).z;
         float _zoom = 1.0 + smoothstep(16.0, 85.0, _dc) * 2.4;
         transformed.y *= _cg * 0.96;
         transformed.xz *= (0.55 + _cg * 0.45) * _zoom;`
      );
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         // 苗期偏嫩黄，盛期转深绿
         diffuseColor.rgb *= mix(vec3(1.12, 1.06, 0.72), vec3(0.86, 1.02, 0.80),
                                 smoothstep(0.25, 0.85, uGreen));`
      );
    };

    const c1 = new THREE.PlaneGeometry(1, 1);
    c1.translate(0, 0.5, 0);
    const c2 = c1.clone();
    c2.rotateY(Math.PI / 2);
    const cropGeo = mergeGeometries([c1, c2]);

    // 作物档案：色相 / 株高 / 行距
    const SPEC = {
      当归: { col: [0.30, 0.44, 0.19], h: 0.46, row: 0.80, gap: 0.52 },
      黄芪: { col: [0.33, 0.41, 0.22], h: 0.40, row: 0.78, gap: 0.50 },
      马铃薯: { col: [0.23, 0.37, 0.16], h: 0.56, row: 0.86, gap: 0.44 },
      党参: { col: [0.36, 0.47, 0.21], h: 0.28, row: 0.72, gap: 0.46 },
      柴胡: { col: [0.31, 0.40, 0.19], h: 0.38, row: 0.70, gap: 0.40 },
      蔬菜: { col: [0.26, 0.46, 0.19], h: 0.30, row: 0.60, gap: 0.40 },
    };

    const jobs = [];
    let total = 0;
    for (const f of FIELDS) {
      const sp = SPEC[f.crop] || SPEC.当归;
      const nx = Math.max(2, Math.floor(f.size[0] / sp.gap));
      const nz = Math.max(2, Math.floor(f.size[1] / sp.row));
      // 已采收的地留茬，只种稀疏的边角
      const thin = f.stage === '已采收' ? 0.34 : 1;
      jobs.push({ f, sp, nx, nz, thin });
      total += nx * nz;
    }

    const im = new THREE.InstancedMesh(cropGeo, mat, total);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const v3 = new THREE.Vector3();
    const sc = new THREE.Vector3();
    let idx = 0;

    for (const { f, sp, nx, nz } of jobs) {
      const y = heightAt(f.pos[0], f.pos[2]);
      const halfW = f.size[0] / 2, halfD = f.size[1] / 2;
      const cth = Math.cos(f.rot), sth = Math.sin(f.rot);
      const stepX = f.size[0] / nx, stepZ = f.size[1] / nz;
      const base = new THREE.Color(sp.col[0], sp.col[1], sp.col[2]);

      for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
          const lx = -halfW + (ix + 0.5) * stepX + between(-0.07, 0.07);
          const lz = -halfD + (iz + 0.5) * stepZ + between(-0.06, 0.06);
          const wx = f.pos[0] + lx * cth + lz * sth;
          const wz = f.pos[2] - lx * sth + lz * cth;

          const hs = sp.h * between(0.78, 1.18);
          const ws = hs * between(0.85, 1.15);
          q.setFromAxisAngle(UP, between(0, Math.PI));
          v3.set(wx, y + 0.04, wz);
          sc.set(ws, hs, ws);
          m4.compose(v3, q, sc);
          im.setMatrixAt(idx, m4);

          const shade = between(0.82, 1.16);
          im.setColorAt(idx, base.clone().multiplyScalar(shade));
          idx++;
        }
      }
    }

    im.count = idx;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = true;
    root.add(im);
    cropMesh = im;
    cropCount = idx;
  }

  /* ================= 村内支路与杂物 ================= */
  {
    const laneTex = assets?.road || TEX.road();
    const laneMat = new THREE.MeshStandardMaterial({
      map: laneTex.map, normalMap: laneTex.normalMap,
      color: laneTex.roughnessMap ? new THREE.Color(0.56, 0.44, 0.31) : new THREE.Color(0xffffff),
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.99,
      metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    // 支路砖纹按世界坐标叠一层低频色差：每条路、每一段深浅都不一样，
    // 不再是一张 0..1 的贴图从这头铺到那头。地面 macro 图与院墙共用，不新增素材。
    {
      const laneMacro = TEX.groundMacro().map;
      laneMat.onBeforeCompile = (shader) => {
        shader.uniforms.uLaneMacro = { value: laneMacro };
        shader.vertexShader = 'varying vec3 vLaneWorld;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vLaneWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
        shader.fragmentShader = 'uniform sampler2D uLaneMacro;\nvarying vec3 vLaneWorld;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           float _seg = texture2D(uLaneMacro, vLaneWorld.xz * 0.0075).g;
           float _fine = texture2D(uLaneMacro, vLaneWorld.xz * 0.031 + vec2(0.37, 0.61)).g;
           float _m = _seg * 0.68 + _fine * 0.32;
           // 低频：整段路的干湿/新旧；高频：碎石颗粒的明暗
           diffuseColor.rgb *= mix(vec3(0.74, 0.72, 0.68), vec3(1.18, 1.15, 1.07), _m);
           diffuseColor.rgb *= mix(vec3(0.95, 0.96, 0.97), vec3(1.0), _fine);`
        );
      };
    }

    const LANES = [
      { a: [1, -46], b: [-17, -52], w: 3.0 },
      { a: [1, -14], b: [17, -20], w: 3.0 },
      { a: [2, 18], b: [-18, 24], w: 3.0 },
      { a: [2, 62], b: [19, 68], w: 2.8 },
      { a: [1, -78], b: [-14, -84], w: 2.8 },
    ];

    for (const L of LANES) {
      const dx = L.b[0] - L.a[0], dz = L.b[1] - L.a[1];
      const len = Math.hypot(dx, dz);
      const geo = new THREE.PlaneGeometry(L.w, len, 1, 4);
      geo.rotateX(-Math.PI / 2);
      // 贴图本身 repeat=10。按世界尺寸重排 UV：不管路多长，砖纹都约 2m 一个周期，
      // 长路不会被拉成广场大砖，短路也不会挤成一团。
      {
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, uv.getX(i) * (L.w / 20), uv.getY(i) * (len / 20));
        }
        uv.needsUpdate = true;
      }
      const cx = (L.a[0] + L.b[0]) / 2, cz = (L.a[1] + L.b[1]) / 2;
      const y = heightAt(cx, cz);
      const m = new THREE.Mesh(geo, laneMat);
      m.position.set(cx, y + 0.05, cz);
      m.rotation.y = Math.atan2(dx, dz);
      m.receiveShadow = true;
      root.add(m);
    }

    // 草垛、柴堆、篱笆：只做背景，不参与拾取
    const hayMat = new THREE.MeshStandardMaterial({ color: 0xb99a5c, roughness: 0.98 });
    const hayTopMat = new THREE.MeshStandardMaterial({ color: 0x8e7340, roughness: 1 });
    const logMat = new THREE.MeshStandardMaterial({ color: 0x6f5638, roughness: 0.95 });
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x7a6242, roughness: 0.95 });

    const spots = [];
    for (let i = 0; i < 34; i++) {
      const x = between(-72, 72);
      const z = between(-96, 104);
      if (Math.abs(x) < 7) continue;              // 避开主路
      if (HOUSES.some((h) => Math.hypot(h.pos[0] - x, h.pos[2] - z) < 14)) continue;
      spots.push([x, z]);
    }

    spots.forEach(([x, z], i) => {
      const y = heightAt(x, z);
      if (i % 3 === 0) {
        // 草垛
        const r = between(1.1, 1.6), h = between(1.4, 2.1);
        const bale = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, h, 12), hayMat);
        bale.position.set(x, y + h / 2, z);
        bale.castShadow = bale.receiveShadow = true;
        root.add(bale);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 1.02, 0.6, 12), hayTopMat);
        cap.position.set(x, y + h + 0.28, z);
        cap.castShadow = true;
        root.add(cap);
      } else if (i % 3 === 1) {
        // 柴堆
        for (let k = 0; k < 5; k++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, between(1.8, 2.6), 6), logMat);
          log.position.set(x + between(-0.5, 0.5), y + 0.16 + k * 0.24, z + between(-0.4, 0.4));
          log.rotation.z = Math.PI / 2;
          log.rotation.y = between(-0.2, 0.2);
          log.castShadow = true;
          root.add(log);
        }
      } else {
        // 篱笆段
        const ang = between(0, Math.PI);
        const seg = new THREE.Group();
        const n = 5;
        for (let k = 0; k < n; k++) {
          const px = (k - n / 2) * 0.9;
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 1.15, 5), fenceMat);
          post.position.set(px, 0.58, 0);
          post.castShadow = true;
          seg.add(post);
        }
        const rail = new THREE.Mesh(new THREE.BoxGeometry(n * 0.9, 0.07, 0.07), fenceMat);
        rail.position.y = 0.86;
        seg.add(rail);
        seg.position.set(x, y, z);
        seg.rotation.y = ang;
        root.add(seg);
      }
    });
  }

  /* ================= 漫水桥 =================
   * 西北旱地小河上常见的低平石桥：桥面只比常水位高 0.30m，汛期水直接从桥上
   * 漫过去，不设栏杆。所有构件共用一种石材并合并成一个 Mesh，只占 1 个 draw call；
   * 第一人称能踏上桥面（walkHeightAt 在桥板范围内抬到 deckY）。 */
  {
    const parts = [];
    const put = (geo, x, y, z) => { geo.translate(x, y, z); parts.push(geo); };
    const { x: bx, z: bz, deckY } = BRIDGE;
    put(new THREE.BoxGeometry(16, 0.28, 3.4), bx, deckY - 0.14, bz);
    for (const s of [-1, 1]) {
      put(new THREE.BoxGeometry(1.4, 0.50, 3.8), bx + s * 8.2, deckY - 0.25, bz);
      put(new THREE.BoxGeometry(4.6, 0.16, 3.0), bx + s * 10.9, -0.06, bz);
    }
    for (let i = -1.5; i <= 1.5; i++) {
      put(new THREE.BoxGeometry(0.55, 1.62, 3.0), bx + i * 3.6, RIVER.bedY + 0.81, bz);
    }
    const bridgeGeo = mergeGeometries(parts, false);
    // 石材贴图默认是细密小方砖，桥面太大时会糊成一片网格；把 uv 收小，读成大块石板
    const buv = bridgeGeo.attributes.uv;
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i) * 0.24, buv.getY(i) * 0.24);
    buv.needsUpdate = true;
    const bridge = new THREE.Mesh(bridgeGeo, matStone);
    bridge.name = 'river-bridge';
    bridge.castShadow = true; bridge.receiveShadow = true;
    root.add(bridge);
  }

  /* ================= 几何草：每一根都是实体，带风动 ================= */
  const grassState = { mat: null, riverSkipped: 0, count: 0 };

  {
    // 单根草叶：底部宽、向上收窄、带自然弯曲；根部深、尖端浅
    const SEG = 4;
    const buildBlade = () => {
      const pos = [], idx = [], col = [], uv = [];
      const W = 0.0115;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const w = W * (1 - t * 0.92);
        const bend = t * t * 0.34;
        pos.push(-w, t, bend, w, t, bend);
        const c = 0.46 + t * 0.52;
        col.push(0.43 * c, 0.41 * c, 0.21 * c, 0.43 * c, 0.41 * c, 0.21 * c);
        uv.push(0, t, 1, t);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };

    const bladeGeo = buildBlade();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uGreen = seasonUniform;
      shader.fragmentShader = 'uniform float uGreen;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float _lum3 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         vec3 _summerG = vec3(0.185, 0.320, 0.105) * (0.62 + _lum3 * 1.15);
         diffuseColor.rgb = mix(diffuseColor.rgb, _summerG, uGreen * 0.86);
         // 季节染绿之后，把每株自己的色相（枯黄/青绿）找补回来；
         // 但不能再把亮度归一化掉，否则根深尖浅的渐变会变成一刀切
         vec3 _tint = vColor / max(0.05, dot(vColor, vec3(0.333)));
         float _vl = clamp(dot(vColor, vec3(0.333)), 0.0, 1.0);
         diffuseColor.rgb *= mix(vec3(1.0), _tint, 0.62) * mix(0.84, 1.10, _vl);`
      );
      shader.vertexShader = 'uniform float uTime;\nuniform float uGreen;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float bladeH = position.y;
         float seed = instanceMatrix[3][0] * 0.8 + instanceMatrix[3][2] * 1.7;
         float gust = sin(uTime * 0.7 + seed * 0.06) * 0.5 + 0.5;
         float sway = sin(uTime * 1.9 + seed) * (0.05 + gust * 0.16) * pow(bladeH, 1.7);
         transformed.x += sway;
         transformed.z += sway * 0.55;
         transformed.y *= 0.82 + uGreen * 0.5;`
      );
      grassState.mat = shader;
    };

    // 只在村子核心区铺实体草，外围继续靠贴图
    const R = 46;
    const N = new URLSearchParams(location.search).has('nograss') ? 0 : 150000;
    const im = new THREE.InstancedMesh(bladeGeo, mat, N);
    const arr = im.instanceMatrix.array;

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const UP = new THREE.Vector3(0, 1, 0);
    const tmpColor = new THREE.Color();

    let n = 0, guard = 0;
    while (n < N && guard++ < N * 14) {
      const x = between(-R, R);
      const z = between(-R, R);
      if (x * x + z * z > R * R) continue;
      // 路边软过渡：越靠近路面中心，长草概率越低（踩踏效应）
      const rd = Math.abs(x);
      const keep = rd < 2.6 ? 0.05 : rd < 4.2 ? 0.35 : rd < 5.4 ? 0.72 : 1;
      if (Math.random() > keep) continue;
      if (HOUSES.some((h) => Math.abs(h.pos[0] - x) < 7.5 && Math.abs(h.pos[2] - z) < 9.5)) continue;
      if (FIELDS.some((f) => Math.abs(f.pos[0] - x) < f.size[0] / 2 && Math.abs(f.pos[2] - z) < f.size[1] / 2)) continue;
      // 河道带内一根草都不留：水面是半透明层，草叶浮在水上会直接穿帮。
      // 现有撒点半径只有 46m、河在 x≈-100，物理上到不了，这里仍是显式保证，
      // 万一以后把草铺到村外也不会失效；计数可供 probe 核对。
      if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12 &&
          Math.abs(x - riverCenterX(z)) < RIVER.out + 2) {
        grassState.riverSkipped++;
        continue;
      }

      const y = heightAt(x, z);
      // 加大形态差异：高矮、粗细、倒伏角度都不同，避免"一片同款绿条"
      const hgt = between(0.10, 0.58);
      const wid = between(0.55, 1.65);
      q.setFromEuler(new THREE.Euler(
        between(-0.34, 0.34), between(0, Math.PI * 2), between(-0.34, 0.34)
      ));
      m4.compose(
        new THREE.Vector3(x, y - 0.01, z),
        q,
        new THREE.Vector3(wid, hgt, wid)
      );
      m4.toArray(arr, n * 16);

      // 固有色：一部分是枯草（偏黄褐），一部分青绿，各自还有深浅
      const dryness = Math.pow(Math.random(), 1.6);       // 多数偏绿，少数枯
      const shade = between(0.78, 1.22);
      const cr = (0.86 + dryness * 0.62) * shade;
      const cg = (1.08 - dryness * 0.16) * shade;
      const cb = (0.82 - dryness * 0.34) * shade;
      im.setColorAt(n, tmpColor.setRGB(cr, cg, cb));
      n++;
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = true;
    im.frustumCulled = false;
    root.add(im);

    grassState.mesh = im;
    grassState.count = n;

    /* 近景加密层：村内 34m 核心区再叠一层更矮更密的短草。
     * 与基础层共用材质（uTime 自然同步），单独一个 InstancedMesh 只占 1 个 draw call；
     * 相机在村里时近处密度接近翻倍，走到村外这层自然落在身后。 */
    {
      const SEG = 3, pos = [], idx = [], col = [], uv = [];
      const BW = 0.0135;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const w = BW * (1 - t * 0.92);
        const bend = t * t * 0.30;
        pos.push(-w, t, bend, w, t, bend);
        const c = 0.40 + t * 0.60;      // 根深尖浅，比基础层再拉开一点
        col.push(0.43 * c, 0.43 * c, 0.21 * c, 0.43 * c, 0.43 * c, 0.21 * c);
        uv.push(0, t, 1, t);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const nearGeo = new THREE.BufferGeometry();
      nearGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      nearGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      nearGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      nearGeo.setIndex(idx);
      nearGeo.computeVertexNormals();

      const NN = 50000, RN = 34;
      const nim = new THREE.InstancedMesh(nearGeo, mat, NN);
      const narr = nim.instanceMatrix.array;
      let nn = 0, nguard = 0;
      while (nn < NN && nguard++ < NN * 14) {
        const x = between(-RN, RN);
        const z = between(-RN, RN);
        if (x * x + z * z > RN * RN) continue;
        if (HOUSES.some((h) => Math.abs(h.pos[0] - x) < 7.5 && Math.abs(h.pos[2] - z) < 9.5)) continue;
        if (FIELDS.some((f) => Math.abs(f.pos[0] - x) < f.size[0] / 2 && Math.abs(f.pos[2] - z) < f.size[1] / 2)) continue;
        if (z > RIVER.z0 - 12 && z < RIVER.z1 + 12 &&
            Math.abs(x - riverCenterX(z)) < RIVER.out + 2) continue;
        const y = heightAt(x, z);
        const hgt = between(0.07, 0.34);
        const wid = between(0.60, 1.50);
        q.setFromEuler(new THREE.Euler(
          between(-0.30, 0.30), between(0, Math.PI * 2), between(-0.30, 0.30)
        ));
        m4.compose(
          new THREE.Vector3(x, y - 0.008, z),
          q,
          new THREE.Vector3(wid, hgt, wid)
        );
        m4.toArray(narr, nn * 16);
        const dryness = Math.pow(Math.random(), 2.1);
        const shade = between(0.80, 1.16);
        nim.setColorAt(nn, tmpColor.setRGB(
          (0.82 + dryness * 0.55) * shade,
          (1.10 - dryness * 0.14) * shade,
          (0.80 - dryness * 0.30) * shade
        ));
        nn++;
      }
      nim.count = nn;
      nim.instanceMatrix.needsUpdate = true;
      if (nim.instanceColor) nim.instanceColor.needsUpdate = true;
      nim.castShadow = false;
      nim.receiveShadow = true;
      nim.frustumCulled = false;
      root.add(nim);
      grassState.near = nim;
      grassState.nearCount = nn;
    }
  }

  /* ================= 降水：雨丝 / 雪片 =================
   * 放在独立 Scene 里、主渲染之后叠加绘制。不进主场景是因为 GTAOPass 会用
   * overrideMaterial 重渲染整个场景做深度/法线预通道，半透明粒子会把预通道打花。
   * 粒子全部由 shader 按 uTime 循环下落，CPU 每帧只更新几个 uniform。 */
  const weatherScene = new THREE.Scene();
  const weatherTime = { value: 0 };
  const RAIN_N = 1300, SNOW_N = 900, SPAN = 30, RADIUS = 34;
  let rainMesh = null, snowMesh = null, rainGeo = null, snowGeo = null;

  {
    const rp = new Float32Array(RAIN_N * 2 * 3);
    const rs = new Float32Array(RAIN_N * 2);
    const re = new Float32Array(RAIN_N * 2);
    for (let i = 0; i < RAIN_N; i++) {
      const x = (Math.random() * 2 - 1) * RADIUS;
      const z = (Math.random() * 2 - 1) * RADIUS;
      const y = Math.random() * SPAN;
      const s = Math.random();
      for (let e = 0; e < 2; e++) {
        const k = i * 2 + e;
        rp[k * 3] = x; rp[k * 3 + 1] = y; rp[k * 3 + 2] = z;
        rs[k] = s; re[k] = e;
      }
    }
    rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(rs, 1));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(re, 1));
    rainGeo.setDrawRange(0, 0);

    const rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: weatherTime, uWind: { value: 0 }, uColor: { value: new THREE.Color(0xbfd0de) },
        uOpacity: { value: 0.36 }, uSpan: { value: SPAN },
      },
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `
        uniform float uTime, uWind, uSpan;
        attribute float aSeed; attribute float aEnd;
        varying float vFade;
        void main(){
          vec3 p = position;
          float sp = 19.0 * (0.72 + aSeed * 0.56);
          float yy = mod(p.y - uTime * sp, uSpan);
          p.y = yy - uSpan * 0.5;
          p.x += uWind * (uSpan - yy) * 0.018;
          p.y -= aEnd * (1.05 + aSeed * 0.85);
          p.x -= aEnd * (uWind * 0.02 + 0.16);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dep = -mv.z;
          vFade = smoothstep(1.0, 4.0, dep) * (1.0 - smoothstep(40.0, 72.0, dep));
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying float vFade;
        void main(){ gl_FragColor = vec4(uColor, uOpacity * vFade); }`,
    });
    rainMesh = new THREE.LineSegments(rainGeo, rainMat);
    rainMesh.frustumCulled = false;
    rainMesh.visible = false;
    weatherScene.add(rainMesh);

    const sp2 = new Float32Array(SNOW_N * 3);
    const ss = new Float32Array(SNOW_N);
    for (let i = 0; i < SNOW_N; i++) {
      sp2[i * 3] = (Math.random() * 2 - 1) * RADIUS;
      sp2[i * 3 + 1] = Math.random() * SPAN;
      sp2[i * 3 + 2] = (Math.random() * 2 - 1) * RADIUS;
      ss[i] = Math.random();
    }
    snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(sp2, 3));
    snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(ss, 1));
    snowGeo.setDrawRange(0, 0);

    const snowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: weatherTime, uWind: { value: 0 }, uColor: { value: new THREE.Color(0xf4f8ff) },
        uSpan: { value: SPAN },
      },
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `
        uniform float uTime, uWind, uSpan;
        attribute float aSeed;
        varying float vFade;
        void main(){
          vec3 p = position;
          float sp = 1.9 * (0.65 + aSeed * 0.7);
          float yy = mod(p.y - uTime * sp, uSpan);
          p.y = yy - uSpan * 0.5;
          p.x += sin(uTime * 0.9 + aSeed * 31.4) * 0.85 + uWind * (uSpan - yy) * 0.016;
          p.z += cos(uTime * 0.7 + aSeed * 17.7) * 0.55;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dep = -mv.z;
          gl_PointSize = clamp((1.6 + aSeed * 2.4) * 26.0 / max(2.0, dep), 1.0, 6.0);
          vFade = smoothstep(1.0, 4.0, dep) * (1.0 - smoothstep(42.0, 74.0, dep));
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * 0.86 * vFade;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    snowMesh = new THREE.Points(snowGeo, snowMat);
    snowMesh.frustumCulled = false;
    snowMesh.visible = false;
    weatherScene.add(snowMesh);
  }

  /** 由真实气象记录驱动降水强度；粒子盒跟随相机，第一人称/上帝视角都有雨雪 */
  function updateWeather(wx, camera, dt) {
    weatherTime.value += dt;
    const wind = Math.min(4, (wx.wind || 0) * 0.12);
    const isSnow = wx.isSnow;
    const rainAmt = Math.min(1, (wx.rainRate || 0) / 5.5);
    const snowAmt = Math.min(1, (wx.snowRate || 0) / 0.5 + (wx.rainRate || 0) * 0.12);

    rainMesh.visible = !isSnow && rainAmt > 0.02;
    snowMesh.visible = isSnow && snowAmt > 0.02;
    rainGeo.setDrawRange(0, Math.floor(RAIN_N * rainAmt) * 2);
    snowGeo.setDrawRange(0, Math.floor(SNOW_N * snowAmt));
    rainMesh.material.uniforms.uWind.value = wind;
    snowMesh.material.uniforms.uWind.value = wind;
    weatherScene.position.copy(camera.position);
    weatherScene.position.y -= 5;

    // 农事随时令：秋收季（9 月中—12 月中）晾药材，其余月份挂辣椒串
    const doy = wx.doy ?? 0;
    const harvest = doy >= 255 || doy <= 15;
    for (const grp of yardAutumn) grp.visible = harvest;
    for (const grp of yardSummer) grp.visible = !harvest;
  }

  /* ================= 每帧动画 ================= */
  const clock = new THREE.Clock();
  function update() {
    const t = performance.now() / 1000;
    if (grassState.mat) grassState.mat.uniforms.uTime.value = t;
    // 法线贴图沿流向（uv 的 v）缓慢滚动：约 6.2m 一个波纹周期、77 秒走完一格
    if (waterState.normal) waterState.normal.offset.y = -((t * 0.013) % 1);
    skyUniforms.uTime.value = t;
    animalUniforms.uTime.value = t;
    for (const a of animals) {
      // 轻微踱步，避免整排死物
      const p = a.phase;
      a.group.position.x = a.base.x + Math.sin(t * 0.22 + p) * (a.kind === '鸡' ? 1.6 : 0.7);
      a.group.position.z = a.base.z + Math.cos(t * 0.17 + p * 1.7) * (a.kind === '鸡' ? 1.6 : 0.7);
      a.group.rotation.y += Math.sin(t * 0.1 + p) * 0.0015;

      // 低头吃草：牛/羊约 24 秒一个慢周期，鸡快得多，像啄食
      const spd = a.kind === '鸡' ? 1.9 : 0.26;
      const amp = a.kind === '鸡' ? 1.05 : a.kind === '牛' ? 0.95 : 1.0;
      const graze = Math.max(0, Math.sin(t * spd + p * 1.3));
      a.head.rotation.z = -Math.pow(graze, 0.7) * amp;
    }
  }

  return { root, pickables, sun, hemi, bounce, moon, skyUniforms, seasonUniform, glassMat: matGlass,
    weatherUniforms, weatherScene, lampLights, lampGlowMat: matLampGlow, updateWeather,
    yardAutumn, yardSummer,
    cropMesh, getCropCount: () => cropCount, update, heightAt, walkHeightAt,
    // 河道自证接口：probe.mjs 沿河取样 / 截图脚本定位都走这里
    river: {
      ...RIVER, bridge: BRIDGE,
      centerX: riverCenterX,
      dist: (x, z) => Math.abs(x - riverCenterX(z)),
      bedAt: (z) => heightAt(riverCenterX(z), z),
      bankAt: (z) => rawHeight(riverCenterX(z), z),
      // 开河后实测的岸顶（d=half 处）：河床相对它的下切严格等于 depth
      bankEdgeAt: (z) => heightAt(riverCenterX(z) + RIVER.half, z),
      // 某点被河谷挖掉多少米（0 = 完全没受影响），落位检查直接用它
      cut: (x, z) => rawHeight(x, z) - riverHeight(x, z),
    },
    water: waterState, grassState };
}
