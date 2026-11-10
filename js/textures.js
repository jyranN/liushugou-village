/**
 * 程序化贴图：用 Canvas 现场画出草地、砖墙、瓦片、木纹等材质
 * 目的：不依赖任何外部素材文件，同时保留足够的表面细节
 */

import * as THREE from 'three';

const SIZE = 256;

/* ---------- 基础噪声 ---------- */
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

/* ---------- 画布工具 ---------- */
function makeCanvas(size = SIZE) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  return cv;
}

/** 逐像素填充：fn(x, y) 返回 [r,g,b] 或 [r,g,b,a] */
function paint(cv, fn) {
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);
  const d = img.data;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const p = fn(x, y);
      const i = (y * cv.width + x) * 4;
      d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; d[i + 3] = p[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** 由亮度生成切线空间法线贴图，让平面产生凹凸感 */
function toNormalMap(cv, strength = 2.0) {
  const ctx = cv.getContext('2d');
  const src = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const w = cv.width, h = cv.height;
  const out = makeCanvas(w);
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  const at = (x, y) => src[((y + h) % h * w + (x + w) % w) * 4] / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

const cache = new Map();
const tex = (canvas, repeat, srgb = true) => {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/* ---------- 各类材质 ---------- */

/** 草地：深浅绿斑块 + 细碎杂色 */
export function grass() {
  if (cache.has('grass')) return cache.get('grass');
  const base = paint(makeCanvas(), (x, y) => {
    const n = fbm(x / 26, y / 26, 4);
    const m = fbm(x / 5, y / 5, 2);
    const dry = Math.max(0, fbm(x / 60, y / 60, 3) - 0.55) * 2.6;
    const g = 116 + n * 26 + m * 10 - dry * 22;
    const r = 124 + n * 28 + m * 12 + dry * 26;
    const b = 76 + n * 18 + m * 8;
    return [r, g, b];
  });

  // 在噪声底上叠细密草叶笔触：远看的草地质感靠贴图，不靠实例堆
  const ctx = base.getContext('2d');
  ctx.lineCap = 'round';
  for (let i = 0; i < 4600; i++) {
    const x = Math.random() * SIZE;
    const y = Math.random() * SIZE;
    const h = 2.2 + Math.random() * 5.4;
    const lean = (Math.random() - 0.5) * 2.4;
    const v = 0.70 + Math.random() * 0.66;
    ctx.strokeStyle = `rgba(${136 * v | 0},${130 * v | 0},${74 * v | 0},${0.30 + Math.random() * 0.42})`;
    ctx.lineWidth = 0.7 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + lean * 0.5, y - h * 0.6, x + lean, y - h);
    ctx.stroke();
  }

  const out = {
    map: tex(base, 52),
    normalMap: tex(toNormalMap(base, 1.5), 52, false),
  };
  cache.set('grass', out);
  return out;
}

/** 耕作土：垄沟纹理，用于田块 */
export function soil() {
  if (cache.has('soil')) return cache.get('soil');
  const base = paint(makeCanvas(), (x, y) => {
    // 垄：一个周期一条，垄背亮、垄沟暗，并带一点被踩塌的不规则
    const wob = fbm(x / 40, y / 90, 2) - 0.5;
    const ph = (y / 9.5) + wob * 1.6;
    const furrow = Math.sin(ph) * 0.5 + 0.5;
    const crest = Math.pow(furrow, 0.7);
    const n = fbm(x / 14, y / 14, 4);
    const clod = fbm(x / 3.4, y / 3.4, 2) - 0.5;
    const v = 0.52 + n * 0.34 + crest * 0.62 + clod * 0.16;
    // 沟底偏冷（存水），垄背偏暖（晒干）
    const cool = (1 - crest) * 0.16;
    return [122 * v, (104 + cool * 40) * v, (74 + cool * 34) * v];
  });
  const out = {
    map: tex(base, 1),
    normalMap: tex(toNormalMap(base, 3.4), 1, false),
  };
  cache.set('soil', out);
  return out;
}

/** 夯土路面：车辙 + 碎石 */
export function road() {
  if (cache.has('road')) return cache.get('road');
  const base = paint(makeCanvas(), (x, y) => {
    const n = fbm(x / 30, y / 30, 4);
    const grit = fbm(x / 3, y / 3, 2);
    const rut = Math.exp(-((y - SIZE * 0.33) ** 2) / 300)
              + Math.exp(-((y - SIZE * 0.67) ** 2) / 300);
    const v = 0.78 + n * 0.34 + grit * 0.16 - rut * 0.16;
    return [146 * v, 128 * v, 104 * v];
  });
  const out = {
    map: tex(base, 10),
    normalMap: tex(toNormalMap(base, 1.8), 10, false),
  };
  cache.set('road', out);
  return out;
}

/** 青砖墙：错缝砌法 */
export function brick() {
  if (cache.has('brick')) return cache.get('brick');
  const bw = 32, bh = 14, mortar = 3;
  const base = paint(makeCanvas(), (x, y) => {
    const row = Math.floor(y / (bh + mortar));
    const offset = (row % 2) * (bw / 2);
    const bx = Math.floor((x + offset) / (bw + mortar));
    const inX = (x + offset) % (bw + mortar);
    const inY = y % (bh + mortar);
    const isMortar = inX > bw || inY > bh;
    const id = hash(bx, row);
    const n = fbm(x / 8, y / 8, 3);
    if (isMortar) {
      const v = 0.86 + n * 0.12;
      return [196 * v, 192 * v, 184 * v];
    }
    const v = 0.74 + id * 0.40 + n * 0.20;
    return [156 * v, 92 * v, 68 * v];
  });
  const out = {
    map: tex(base, 6),
    normalMap: tex(toNormalMap(base, 3.6), 6, false),
  };
  cache.set('brick', out);
  return out;
}

/** 夯土墙 / 白灰墙 */
export function plaster(tint = [214, 205, 188]) {
  const key = `plaster-${tint.join('_')}`;
  if (cache.has(key)) return cache.get(key);
  const base = paint(makeCanvas(), (x, y) => {
    const n = fbm(x / 20, y / 20, 4);
    const streak = fbm(x / 70, y / 12, 3) * 0.3;
    const v = 0.80 + n * 0.30 - streak;
    return [tint[0] * v, tint[1] * v, tint[2] * v];
  });
  const out = {
    map: tex(base, 4),
    normalMap: tex(toNormalMap(base, 1.2), 4, false),
  };
  cache.set(key, out);
  return out;
}

/** 屋顶瓦：鱼鳞状排列 */
export function tile() {
  if (cache.has('tile')) return cache.get('tile');
  const tw = 22, th = 16;
  const base = paint(makeCanvas(), (x, y) => {
    const row = Math.floor(y / th);
    const offset = (row % 2) * (tw / 2);
    const inX = ((x + offset) % tw) / tw;
    const inY = (y % th) / th;
    const curve = Math.sin(inX * Math.PI) * Math.sin(inY * Math.PI);
    const id = hash(Math.floor((x + offset) / tw), row);
    const n = fbm(x / 9, y / 9, 3);
    const v = 0.68 + curve * 0.46 + id * 0.14 + n * 0.1;
    return [138 * v, 128 * v, 122 * v];
  });
  const out = {
    map: tex(base, 7),
    normalMap: tex(toNormalMap(base, 3.0), 7, false),
  };
  cache.set('tile', out);
  return out;
}

/** 木纹：门板、梁柱 */
export function wood(tint = [122, 88, 58]) {
  const key = `wood-${tint.join('_')}`;
  if (cache.has(key)) return cache.get(key);
  const base = paint(makeCanvas(), (x, y) => {
    const grain = Math.sin(x / 3.4 + fbm(x / 40, y / 90, 3) * 9) * 0.5 + 0.5;
    const n = fbm(x / 12, y / 40, 4);
    const v = 0.68 + grain * 0.30 + n * 0.22;
    return [tint[0] * v, tint[1] * v, tint[2] * v];
  });
  const out = {
    map: tex(base, 3),
    normalMap: tex(toNormalMap(base, 1.8), 3, false),
  };
  cache.set(key, out);
  return out;
}

/** 树皮：竖向裂纹 */
export function bark() {
  if (cache.has('bark')) return cache.get('bark');
  const base = paint(makeCanvas(), (x, y) => {
    const crag = fbm(x / 5, y / 60, 4);
    const n = fbm(x / 16, y / 16, 3);
    const v = 0.60 + crag * 0.62 + n * 0.16;
    return [86 * v, 74 * v, 60 * v];
  });
  const out = {
    map: tex(base, 3),
    normalMap: tex(toNormalMap(base, 3.2), 3, false),
  };
  cache.set('bark', out);
  return out;
}

/** 树叶卡片：带透明通道，用于树冠面片 */
export function leafCard(tint = [72, 104, 52]) {
  const key = `leaf-${tint.join('_')}`;
  if (cache.has(key)) return cache.get(key);

  // 512 而非 256：一片叶在世界上约 5 cm，256 下只有四五个像素，只能看到圆点
  const S = 512;
  const cv = makeCanvas(S);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  const leaf = (cx, cy, len, wid, rot, shade) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    const col = `rgba(${tint[0] * shade | 0},${tint[1] * shade | 0},${tint[2] * shade | 0},0.97)`;

    // 尖头叶形：两条对称的二次曲线，比椭圆像叶子
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.quadraticCurveTo(wid, -len * 0.25, 0, len);
    ctx.quadraticCurveTo(-wid, -len * 0.25, 0, -len);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();

    // 中脉：一条比叶身略深的线，让叶片有结构
    if (len > 7) {
      ctx.strokeStyle = `rgba(${tint[0] * shade * 0.62 | 0},${tint[1] * shade * 0.66 | 0},${tint[2] * shade * 0.58 | 0},0.85)`;
      ctx.lineWidth = Math.max(0.7, wid * 0.12);
      ctx.beginPath();
      ctx.moveTo(0, -len * 0.92);
      ctx.lineTo(0, len * 0.92);
      ctx.stroke();

      // 侧脉
      if (len > 11) {
        ctx.lineWidth = Math.max(0.5, wid * 0.07);
        for (let k = -2; k <= 2; k++) {
          const y = k * len * 0.22;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(wid * 0.62, y + len * 0.18);
          ctx.moveTo(0, y);
          ctx.lineTo(-wid * 0.62, y + len * 0.18);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  };

  // 叶片更大更少，才看得出形状；着色靠 shade 做深浅，避免一片死色
  for (let i = 0; i < 300; i++) {
    const cx = Math.random() * S;
    const cy = Math.random() * S;
    const len = 8 + Math.random() * 15;
    const wid = len * (0.30 + Math.random() * 0.18);
    leaf(cx, cy, len, wid, Math.random() * Math.PI * 2, 0.58 + Math.random() * 0.68);
  }

  const out = {
    map: tex(cv, 1),
    normalMap: tex(toNormalMap(cv, 1.4), 1, false),
  };
  out.map.wrapS = out.map.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, out);
  return out;
}

/** 石块：挡墙、台阶 */
export function stone() {
  if (cache.has('stone')) return cache.get('stone');
  const base = paint(makeCanvas(), (x, y) => {
    const cell = 34;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const id = hash(gx, gy);
    const edgeX = Math.min(x % cell, cell - (x % cell));
    const edgeY = Math.min(y % cell, cell - (y % cell));
    const gap = Math.min(edgeX, edgeY) < 2 ? 0.55 : 1;
    const n = fbm(x / 10, y / 10, 4);
    const v = (0.56 + id * 0.4 + n * 0.3) * gap;
    return [124 * v, 120 * v, 112 * v];
  });
  const out = {
    map: tex(base, 5),
    normalMap: tex(toNormalMap(base, 2.8), 5, false),
  };
  cache.set('stone', out);
  return out;
}

/**
 * 地形裸岩：给地形第三层用，**不要砌块网格**。
 * stone() 是照着挡墙/台阶画的，34px 一个规则砌块 + 2px 暗缝；
 * 铺到几十米周期的山坡上，远处会混叠成一整片棋盘格（夜间和雪天尤其明显）。
 * 这里改成纯多尺度噪声 + 细裂隙，没有任何规则格子，色相偏灰褐。
 */
export function terrainRock() {
  if (cache.has('terrainRock')) return cache.get('terrainRock');
  const base = paint(makeCanvas(), (x, y) => {
    const n = fbm(x / 48, y / 48, 4);        // 大块岩石斑
    const m = fbm(x / 11, y / 11, 3);        // 碎石颗粒
    const crack = Math.abs(fbm(x / 72 + 3, y / 72 + 7, 3) - 0.5);
    // 裂隙：噪声过零点附近压暗，宽度很窄，避免形成可辨的网格
    const ck = Math.max(0, 0.035 - crack) * 4.6;
    const v = 0.58 + n * 0.32 + m * 0.14 - ck;
    return [126 * v, 120 * v, 110 * v];
  });
  const out = {
    map: tex(base, 1),
    normalMap: tex(toNormalMap(base, 2.0), 1, false),
  };
  cache.set('terrainRock', out);
  return out;
}

/** 水面法线：轻微波纹 */
export function water() {
  if (cache.has('water')) return cache.get('water');
  const base = paint(makeCanvas(), (x, y) => {
    const n = fbm(x / 22, y / 22, 4) * 0.6 + fbm(x / 7, y / 7, 2) * 0.4;
    const v = 128 + n * 90;
    return [v, v, v];
  });
  const out = { normalMap: tex(toNormalMap(base, 1.1), 6, false) };
  cache.set('water', out);
  return out;
}

/** 草叶：透明底上的细长禾草，用于地被草簇 */
export function grassBlade() {
  if (cache.has('grassBlade')) return cache.get('grassBlade');
  const cv = makeCanvas(128);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);

  for (let i = 0; i < 46; i++) {
    const x0 = 2 + Math.random() * 124;
    const h = 52 + Math.random() * 70;
    const bend = (Math.random() - 0.5) * 30;
    const w = 1.8 + Math.random() * 2.6;
    const shade = 0.62 + Math.random() * 0.55;
    const g = ctx.createLinearGradient(0, 128, 0, 128 - h);
    g.addColorStop(0, `rgba(${96 * shade | 0},${102 * shade | 0},${56 * shade | 0},1)`);
    g.addColorStop(1, `rgba(${188 * shade | 0},${178 * shade | 0},${104 * shade | 0},0.92)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, 128);
    ctx.quadraticCurveTo(x0 + bend * 0.45, 128 - h * 0.62, x0 + bend, 128 - h);
    ctx.stroke();
  }

  const out = { map: tex(cv, 1) };
  out.map.wrapS = out.map.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('grassBlade', out);
  return out;
}

/** 云层：可平铺的 fbm 云图，白色带 alpha，用于高空云平面 */
export function cloudLayer() {
  if (cache.has('cloud')) return cache.get('cloud');
  const S = 512;
  const cv = makeCanvas(S);
  const img = cv.getContext('2d').createImageData(S, S);
  const d = img.data;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 环形采样保证四边可无缝平铺
      const u = (x / S) * Math.PI * 2;
      const v = (y / S) * Math.PI * 2;
      const fx = Math.cos(u) * 2.2 + Math.cos(v) * 1.55 + 19;
      const fy = Math.sin(u) * 2.2 + Math.sin(v) * 1.55 + 19;
      // 域扰动：打散 fbm 的方向性，避免出现条带状
      const wx = fbm(fx * 0.55 + 3, fy * 0.55 + 9, 2) - 0.5;
      const wy = fbm(fx * 0.55 + 27, fy * 0.55 + 15, 2) - 0.5;
      let n = fbm(fx + wx * 2.6, fy + wy * 2.6, 6) * 0.8
            + fbm((fx + wx * 2.6) * 2.4 + 5, (fy + wy * 2.6) * 2.4 + 11, 3) * 0.2;
      const a = Math.min(1, Math.max(0, (n - 0.335) * 2.5));
      const shade = 234 + (1 - a) * 20;
      const i = (y * S + x) * 4;
      d[i] = shade;
      d[i + 1] = shade;
      d[i + 2] = shade - 4;
      d[i + 3] = a * 236;
    }
  }
  cv.getContext('2d').putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(9, 9);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;

  const out = { map: t };
  cache.set('cloud', out);
  return out;
}

/** 地面宏观色斑：低频噪声图，用来打散单色与平铺规律（可无缝平铺） */
export function groundMacro() {
  if (cache.has('groundMacro')) return cache.get('groundMacro');
  const S = 512;
  const cv = makeCanvas(S);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 环形坐标保证四边接缝连续
      const u = (x / S) * Math.PI * 2;
      const v = (y / S) * Math.PI * 2;
      const nx = Math.cos(u) * 2.7 + Math.cos(v) * 2.1 + 13;
      const ny = Math.sin(u) * 2.7 + Math.sin(v) * 2.1 + 5;
      const base = fbm(nx, ny, 4);
      const detail = fbm(nx * 3.4 + 8, ny * 3.4 + 2, 3);
      const t = base * 0.74 + detail * 0.26;

      // 冷暖交替：低处偏黄褐（干土），高处偏青灰（湿草）
      const i = (y * S + x) * 4;
      d[i]     = 96 + t * 132;
      d[i + 1] = 104 + t * 118;
      d[i + 2] = 74 + t * 84;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;

  const out = { map: t };
  cache.set('groundMacro', out);
  return out;
}

/** 作物植株：透明底画一丛向上发散的叶片，颜色偏中性，实际色相由实例色控制 */
export function cropPlant() {
  if (cache.has('cropPlant')) return cache.get('cropPlant');
  const S = 128;
  const cv = makeCanvas(S);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2, cy = S - 4;

  // 叶片：淡白偏绿，靠明暗区分正反面
  const nLeaf = 9;
  for (let i = 0; i < nLeaf; i++) {
    const a = -Math.PI / 2 + (i / (nLeaf - 1) - 0.5) * Math.PI * 1.45
      + (Math.random() - 0.5) * 0.24;
    const len = S * (0.42 + Math.random() * 0.42);
    const w = 3.4 + Math.random() * 4.2;
    const tipX = cx + Math.cos(a) * len;
    const tipY = cy + Math.sin(a) * len;
    const shade = 0.68 + Math.random() * 0.42;

    const g = ctx.createLinearGradient(cx, cy, tipX, tipY);
    g.addColorStop(0, `rgba(${118 * shade | 0},${132 * shade | 0},${92 * shade | 0},1)`);
    g.addColorStop(1, `rgba(${206 * shade | 0},${214 * shade | 0},${172 * shade | 0},1)`);
    ctx.fillStyle = g;

    // 一片叶：从根部到尖端的细长四边形，带弯曲
    const mx = (cx + tipX) / 2 + (Math.random() - 0.5) * 8;
    const my = (cy + tipY) / 2 + (Math.random() - 0.5) * 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(mx - w, my, tipX, tipY);
    ctx.quadraticCurveTo(mx + w, my, cx, cy);
    ctx.closePath();
    ctx.fill();
  }

  const out = { map: tex(cv, 1, true) };
  out.map.wrapS = out.map.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('cropPlant', out);
  return out;
}

/**
 * 当归的伞形花序：细花葶 + 放射状伞辐 + 末端小白花。
 * 128×128，透明底，与 cropPlant 同一套 alphaTest 用法。
 * 当归是岷县道地药材，7 月抽薹开复伞形白花 —— 这是它在田里最好认的特征，
 * 所以单独画一张，而不是拿叶片贴图凑。
 */
export function cropUmbel() {
  if (cache.has('cropUmbel')) return cache.get('cropUmbel');
  const S = 128;
  const cv = makeCanvas(S);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2;
  const baseY = S - 2;
  const hubY = S * 0.44;          // 伞心高度

  // 花葶：从底部微微弯向伞心
  ctx.strokeStyle = 'rgba(116,132,82,1)';
  ctx.lineWidth = 3.0;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.quadraticCurveTo(cx + 3.5, (baseY + hubY) / 2, cx, hubY);
  ctx.stroke();

  // 伞辐：7 根，末端略上翘
  const n = 7;
  const R = S * 0.36;
  const tips = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * Math.PI * 1.18;
    const tx = cx + Math.cos(a) * R;
    const ty = hubY + Math.sin(a) * R * 0.70;
    tips.push([tx, ty]);
    ctx.strokeStyle = 'rgba(122,138,88,0.95)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, hubY);
    ctx.quadraticCurveTo((cx + tx) / 2, (hubY + ty) / 2 - 3.5, tx, ty);
    ctx.stroke();
  }

  // 每根伞辐末端一簇小白花（5 个小瓣 + 中心一点淡黄）
  for (const [tx, ty] of tips) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.4;
      const px = tx + Math.cos(a) * 2.8;
      const py = ty + Math.sin(a) * 2.3;
      ctx.fillStyle = 'rgba(240,244,230,0.95)';
      ctx.beginPath();
      ctx.arc(px, py, 2.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(214,226,182,0.95)';
    ctx.beginPath();
    ctx.arc(tx, ty, 1.9, 0, Math.PI * 2);
    ctx.fill();
  }

  const out = { map: tex(cv, 1, true) };
  out.map.wrapS = out.map.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('cropUmbel', out);
  return out;
}

/** 村务宣传栏：中文标语 + 药材收购信息，给村口一点真实的乡土标识 */
export function signBoard() {
  if (cache.has('signBoard')) return cache.get('signBoard');
  const cv = document.createElement('canvas');
  cv.width = 768; cv.height = 320;
  const c = cv.getContext('2d');
  const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  c.fillStyle = '#eee7d7';
  c.fillRect(0, 0, 768, 320);
  // 日晒褪色的斑驳
  for (let i = 0; i < 2400; i++) {
    const x = Math.random() * 768, y = Math.random() * 320;
    c.fillStyle = `rgba(120,105,80,${Math.random() * 0.05})`;
    c.fillRect(x, y, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  c.strokeStyle = '#9e2b20';
  c.lineWidth = 9;
  c.strokeRect(14, 14, 740, 292);
  c.lineWidth = 2;
  c.strokeRect(28, 28, 712, 264);

  c.textAlign = 'center';
  c.fillStyle = '#a22c20';
  c.font = `bold 82px ${FONT}`;
  c.fillText('乡村振兴', 384, 132);
  c.fillStyle = '#3c3a33';
  c.font = `38px ${FONT}`;
  c.fillText('药材产业 · 当归  党参  黄芪', 384, 206);
  c.font = `26px ${FONT}`;
  c.fillText('柳树沟村村民委员会   宣', 384, 268);

  const t = tex(cv, 1, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const out = { map: t };
  cache.set('signBoard', out);
  return out;
}

/**
 * 公共核心标识图集（v1.2）：一张 1024×512 的 canvas，分 4 格，每格 512×256。
 *   col,row = (0,0) 小卖部手写招牌 | (1,0) 卫生室红十字
 *             (0,1) 村委会村务公示栏 | (1,1) 戏台匾额
 * 四处标识合用这一张贴图 + 一个合批 Mesh，只占 1 个 draw call；
 * 与 signBoard() 一样是现场画出来的，**不新增任何贴图文件**。
 * UV 分区由 world.js 的 civicSignQuad() 按同一格序写入。
 */
export function civicSigns() {
  if (cache.has('civicSigns')) return cache.get('civicSigns');
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const c = cv.getContext('2d');
  const W = 512, H = 256;
  const HAND = '"Kaiti SC", "STKaiti", "KaiTi", "楷体", serif';
  const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  const cell = (col, row, bg) => {
    c.save();
    c.translate(col * W, row * H);
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    // 日晒褪色 / 木纹斑驳：与 signBoard() 同一套做法
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(90,75,55,${Math.random() * 0.06})`;
      c.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 5, 2 + Math.random() * 4);
    }
  };
  /** 手写感：逐字给一点高低错落与倾角，不做规整排版 */
  const handText = (chars, cx, cy, size, color, tilt = 0.055) => {
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `${size}px ${HAND}`;
    c.fillStyle = color;
    const step = size * 1.16;
    const x0 = cx - (chars.length - 1) * step / 2;
    [...chars].forEach((ch, i) => {
      c.save();
      c.translate(x0 + i * step, cy + Math.sin(i * 2.3) * 3);
      c.rotate((i - (chars.length - 1) / 2) * tilt);
      c.fillText(ch, 0, 0);
      c.restore();
    });
  };
  const smallText = (txt, cx, cy, size, color, font = SANS) => {
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `${size}px ${font}`; c.fillStyle = color;
    c.fillText(txt, cx, cy);
  };

  /* (0,0) 小卖部：米黄木牌 + 手写三字 */
  cell(0, 0, '#e9dcbc');
  c.strokeStyle = '#8a6b42'; c.lineWidth = 8; c.strokeRect(12, 12, W - 24, H - 24);
  c.lineWidth = 2; c.strokeRect(24, 24, W - 48, H - 48);
  handText('小卖部', 256, 108, 84, '#33291d');
  smallText('烟 酒  ·  百 货  ·  农 资  ·  代 收 快 递', 256, 196, 23, '#6a5136');
  c.restore();

  /* (1,0) 卫生室：白底红十字 + 机构名 */
  cell(1, 0, '#f2f0e9');
  c.fillStyle = '#c22a24';
  c.fillRect(74, 42, 48, 172);      // 竖
  c.fillRect(26, 104, 144, 48);     // 横（与竖条同轴）
  smallText('村卫生室', 336, 104, 58, '#a52a22');
  smallText('常见病 · 防疫接种 · 慢病随访', 336, 178, 22, '#4a4a44');
  c.restore();

  /* (0,1) 村委会公示栏：红框 + 村务公开 */
  cell(0, 1, '#eee7d7');
  c.strokeStyle = '#9e2b20'; c.lineWidth = 9; c.strokeRect(14, 14, W - 28, H - 28);
  c.lineWidth = 2; c.strokeRect(28, 28, W - 56, H - 56);
  smallText('村 务 公 开', 256, 98, 66, '#a22c20');
  smallText('药材收购价 · 低保公示 · 一事一议', 256, 166, 23, '#3c3a33');
  smallText('柳树沟村村民委员会   每月更新', 256, 212, 21, '#6a6252');
  c.restore();

  /* (1,1) 戏台匾额：深褐木底 + 描金字 */
  cell(1, 1, '#3b2c1e');
  c.strokeStyle = '#d9b46a'; c.lineWidth = 10; c.strokeRect(16, 16, W - 32, H - 32);
  c.lineWidth = 2; c.strokeRect(30, 30, W - 60, H - 60);
  handText('同乐台', 256, 112, 80, '#e8c77a', 0.03);
  smallText('一九九八年  全村出工共建', 256, 200, 22, '#c9ab76', HAND);
  c.restore();

  const t = tex(cv, 1, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const out = { map: t };
  cache.set('civicSigns', out);
  return out;
}
