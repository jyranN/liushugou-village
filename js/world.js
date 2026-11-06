/**
 * 场景装配：地形、天空、光照、道路、民居、树木、家畜、公共设施、田块
 * 所有可点选物体都挂一个不可见代理盒，射线只打代理，保证拾取精准且省性能
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as TEX from './textures.js';
import { HOUSES, TREES, ANIMAL_LIST, FACILITIES, FIELDS, YARD_DETAILS, ROAD, VILLAGE } from './data.js';

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

/** 地面高度：村所在的川地平坦，向外抬升为岷山北麓的丘陵 */
export function heightAt(x, z) {
  const d = Math.hypot(x * 0.85, z * 1.0);
  const flat = Math.min(1, Math.max(0, (d - 100) / 155));
  const ridge = (fbm(x * 0.0055, z * 0.0055, 4) - 0.42) * 96;
  const ripple = (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 2.4;
  return ridge * flat * flat + ripple * Math.min(1, flat * 3);
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
  // 3072 覆盖 208m 见方的村子（约 15 px/m），够看清院墙上的树影；
  // 再往上加分辨率肉眼收益很小，阴影 pass 的填充率却翻倍
  sun.shadow.mapSize.set(3072, 3072);
  sun.shadow.camera.near = 110;
  sun.shadow.camera.far = 430;
  const S = 104;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  // 改了正交范围必须重算投影矩阵，否则阴影相机还停在默认的 10m 盒子里
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.045;
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
  const groundGeo = new THREE.PlaneGeometry(620, 620, 190, 190);
  groundGeo.rotateX(-Math.PI / 2);
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
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

  // 按海拔压暗：低处（川地）正常，高处（山坡）偏冷偏暗，拉开纵深
  {
    const col = [];
    const p2 = groundGeo.attributes.position;
    for (let i = 0; i < p2.count; i++) {
      const y = p2.getY(i);
      const k = Math.min(1, Math.max(0, (y - 10) / 46));
      const shade = 1 - k * 0.30;
      col.push(shade, shade * 0.97, shade * 0.9);
    }
    groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    ground.material.vertexColors = true;
    ground.material.needsUpdate = true;
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
      const local = heightAt(x, z);
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
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x2d3a42, roughness: 0.18, metalness: 0.55 });
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
  const matTrim = new THREE.MeshStandardMaterial({ color: 0x4a3d31, roughness: 0.82 });
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
      const nR = 17;
      const rim = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.13, 0.68), matTrim, nR);
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

    // 门：门框、门楣、门槛
    for (const sx of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.42, 0.2), matTrim);
      jamb.position.set(sx * 0.78, baseY + 1.21, D / 2 + 0.04);
      jamb.castShadow = true;
      g.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.2, 0.24), matTrim);
    lintel.position.set(0, baseY + 2.52, D / 2 + 0.04);
    lintel.castShadow = true;
    g.add(lintel);

    // 门洞内壁：让门退进去，和窗一个道理
    const doorHole = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.36, 0.26), matDark);
    doorHole.position.set(0, baseY + 1.18, D / 2 - 0.11);
    g.add(doorHole);

    const door = new THREE.Mesh(new THREE.BoxGeometry(1.36, 2.26, 0.08), matWood);
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
      // 窗洞（深色的内壁，制造凹进去的错觉）
      const hole = new THREE.Mesh(new THREE.BoxGeometry(1.62, 1.42, 0.30), matDark);
      hole.position.set(dx, baseY + 2.0, D / 2 - 0.13);
      hole.receiveShadow = true;
      g.add(hole);

      // 玻璃往里退，窗框才能显出厚度
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 0.06), matGlass);
      win.position.set(dx, baseY + 2.0, D / 2 - 0.05);
      g.add(win);

      // 空心窗框：四条边，中间留空看到玻璃
      const fw = 1.76, fh = 1.56, ft = 0.10, fd = 0.12;
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
      const barV = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.3, 0.035), matTrim);
      barV.position.set(dx, baseY + 2.0, D / 2 - 0.015);
      g.add(barV);
      const barH = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.045, 0.035), matTrim);
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

  /* ================= 树木：干 / 枝 / 叶 三组实例化，共 3 个绘制调用 ================= */
  const barkT = TEX.bark();
  const matBark = new THREE.MeshStandardMaterial({
    map: barkT.map, normalMap: barkT.normalMap, roughness: 0.92, metalness: 0,
    color: 0xb8a894,
    // 树冠内部几乎照不到直射光，纯 PBR 会把枝条压成黑棍；给一点暖色底光
    emissive: 0x6b5540, emissiveIntensity: 0.32,
  });

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

      m4.compose(base, new THREE.Quaternion().setFromAxisAngle(UP, rotY),
        new THREE.Vector3(rBot, trunkH, rBot));
      trunkM.push(m4.clone());

      const nb = 5;
      const crownY = y + trunkH * 0.88;
      for (let i = 0; i < nb; i++) {
        const a = rotY + (i / nb) * Math.PI * 2 + between(-0.4, 0.4);
        const tilt = between(0.45, 0.9);
        const dir = new THREE.Vector3(
          Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)
        ).normalize();
        const len = t.canopy * between(0.46, 0.70);
        const start = new THREE.Vector3(base.x, crownY, base.z);
        const br = rTop * 1.55;
        q.setFromUnitVectors(UP, dir);
        m4.compose(start, q, new THREE.Vector3(br, len, br));
        branchM.push(m4.clone());

        // 二级枝：从主枝中上段再分出去。没有这一层，树冠就是几根光棍顶着叶子
        for (let k = 0; k < 2; k++) {
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
        const ccx = base.x + Math.sin(cv) * Math.cos(cu) * t.canopy * 0.74 * cr;
        const ccz = base.z + Math.sin(cv) * Math.sin(cu) * t.canopy * 0.74 * cr;
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

    mkInst(unitGeo, matBark, trunkM);
    mkInst(unitGeo, matBark, branchM);
    mkInst(leafGeo, matLeaf, leafM, leafC);
  }

  /* ================= 家畜 ================= */
  const matHide = {
    '牛': new THREE.MeshStandardMaterial({ color: 0x7a5236, roughness: 0.88 }),
    '羊': new THREE.MeshStandardMaterial({ color: 0xded8cc, roughness: 0.95 }),
    '鸡': new THREE.MeshStandardMaterial({ color: 0xb4783c, roughness: 0.9 }),
  };
  const animals = [];

  function buildAnimal(a) {
    const g = new THREE.Group();
    const y = heightAt(a.pos[0], a.pos[2]);
    g.position.set(a.pos[0], y, a.pos[2]);
    g.rotation.y = between(0, Math.PI * 2);

    const mat = matHide[a.kind] || matHide['羊'];
    const scale = a.kind === '牛' ? 1 : a.kind === '羊' ? 0.62 : 0.22;

    const bodyLen = 1.7 * scale, bodyH = 0.78 * scale, bodyW = 0.7 * scale;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(bodyW / 2, bodyLen - bodyW, 6, 10), mat);
    body.rotation.z = Math.PI / 2;
    body.position.y = bodyH * 1.25;
    body.castShadow = true;
    g.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42 * scale, 0.42 * scale, 0.62 * scale), mat);
    head.position.set(bodyLen / 2 + 0.18 * scale, bodyH * 1.7, 0);
    head.castShadow = true;
    g.add(head);

    for (const [dx, dz] of [[-0.5, -0.22], [-0.5, 0.22], [0.5, -0.22], [0.5, 0.22]]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07 * scale, 0.06 * scale, bodyH * 1.25, 5),
        mat
      );
      leg.position.set(dx * bodyLen, bodyH * 0.62, dz * bodyW * 1.6);
      leg.castShadow = true;
      g.add(leg);
    }

    if (a.kind === '牛') {
      for (const s of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.28, 5), new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.6 }));
        horn.position.set(bodyLen / 2 + 0.18, bodyH * 1.98, s * 0.16);
        horn.rotation.z = s * 0.5;
        g.add(horn);
      }
    }

    g.add(proxy(a, [bodyLen * 1.5, bodyH * 2.4, bodyW * 2.4], [0, bodyH * 1.1, 0]));
    root.add(g);
    animals.push({ group: g, base: g.position.clone(), phase: rnd() * 10, kind: a.kind });
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
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.16, 8, 18), matWood);
      wheel.position.set(3.6, 1.9, 0); wheel.rotation.y = Math.PI / 2; wheel.castShadow = true; g.add(wheel);
      g.add(proxy(f, [8, 5.2, 6.4], [0, 2.4, 0]));
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
      roughness: 0.97,
      metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2,
    });

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

  /* ================= 几何草：每一根都是实体，带风动 ================= */
  const grassState = { mat: null };

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
         // 季节染绿之后，把每株自己的色相（枯黄/青绿）找补回来
         vec3 _tint = vColor / max(0.05, dot(vColor, vec3(0.333)));
         diffuseColor.rgb *= mix(vec3(1.0), _tint, 0.72);`
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
    skyUniforms.uTime.value = t;
    for (const a of animals) {
      // 轻微踱步，避免整排死物
      const p = a.phase;
      a.group.position.x = a.base.x + Math.sin(t * 0.22 + p) * (a.kind === '鸡' ? 1.6 : 0.7);
      a.group.position.z = a.base.z + Math.cos(t * 0.17 + p * 1.7) * (a.kind === '鸡' ? 1.6 : 0.7);
      a.group.rotation.y += Math.sin(t * 0.1 + p) * 0.0015;
    }
  }

  return { root, pickables, sun, hemi, bounce, moon, skyUniforms, seasonUniform, glassMat: matGlass,
    weatherUniforms, weatherScene, lampLights, lampGlowMat: matLampGlow, updateWeather,
    yardAutumn, yardSummer,
    cropMesh, getCropCount: () => cropCount, update, heightAt };
}
