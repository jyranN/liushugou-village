/**
 * 自动巡游：6 个镜头、约 32 秒。
 * 低机位段每帧把相机高度锁在 heightAt(x,z) + 1.8，最后一段才拉高俯瞰；
 * 每段用 easeInOutCubic，不用匀速；段与段之间硬切，靠字幕淡出淡入过渡。
 */
import * as THREE from 'three';
import { HOUSES } from './data.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* 镜头表：from/to 只给 x/z 与看向点；y 在运行时按地形算（lift 段除外） */
const SHOTS = [
  {
    dur: 5.0,
    from: { x: -0.5, z: -116.0, look: [0.5, 2.2, -103.0] },
    to: { x: -2.0, z: -112.5, look: [0.5, 2.1, -103.0] },
    caption: '村口的老杨树与老槐。树下的石墩和石碾，是村人歇脚、碾粮的地方。',
  },
  {
    dur: 5.5,
    from: { x: -2.0, z: -112.5, look: [0.0, 1.6, -85.0] },
    to: { x: 0.0, z: -92.0, look: [1.2, 1.6, -70.0] },
    caption: '沿主路进村。两侧是坐北朝南的院落，院墙用的是就地取的黄土。',
  },
  {
    dur: 5.0,
    from: { x: -20.6, z: -64.5, look: [-20.6, 1.9, -73.05] },
    to: { x: -20.6, z: -67.5, look: [-20.6, 1.9, -73.05] },
    caption: '张宅院门。门楼、院墙和砖砌门柱，是陇中院落最常见的做法。',
  },
  {
    dur: 5.0,
    from: { x: -27.0, z: 39.0, look: [-34.0, 0.6, 30.0] },
    to: { x: -29.0, z: 36.5, look: [-34.0, 0.6, 30.0] },
    caption: '晒场上摊着刚收的当归和党参，秋收后要在这里晾到半干。',
  },
  {
    dur: 6.5,
    from: { x: 133.8, z: 19.4, look: [136.8, 46.1, 20.0] },
    to: { x: 133.8, z: 20.6, look: [136.8, 46.1, 20.0] },
    caption: '村东的孤山，山腰是山神庙；庙前那棵老槐比庙还年长。',
  },
  {
    dur: 6.5, lift: true, toY: 95,
    from: { x: 133.8, z: 20.6, look: [136.8, 46.1, 20.0] },
    to: { x: 60.0, z: 55.0, look: [0.0, 0.0, 0.0] },
    caption: '柳树沟村。岷山北麓川地上的一座小村，十四户人家。',
  },
];

export class Tour {
  constructor({ camera, rig, world, layer, caption, onState }) {
    this.camera = camera;
    this.rig = rig;
    this.world = world;
    this.layer = layer;
    this.caption = caption;
    this.onState = onState || (() => {});

    this.active = false;
    this.t = 0;
    this.shot = 0;
    this.shotStart = 0;
    this.lastLook = new THREE.Vector3();
    this.prevFov = camera.fov;
    this._capTimer = 0;
    this.stats = { minClearance: 1e9, maxHeight: -1e9, houseHits: 0, frames: 0 };

    this.layer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stop(false);
    });
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.shot = 0;
    this.shotStart = 0;
    this.stats = { minClearance: 1e9, maxHeight: -1e9, houseHits: 0, frames: 0 };

    if (this.rig.isWalk) this.rig.exitWalk();
    this.rig.locked = true;
    this.rig.dragging = false;
    this.rig.keys.clear();

    this.prevFov = this.camera.fov;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();

    this.layer.classList.add('on');
    document.body.classList.add('touring');
    this._setCaption(SHOTS[0].caption);
    this.onState(true);
    this.update(0);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.rig.locked = false;
    this.rig.dragging = false;
    this.rig.keys.clear();
    this.layer.classList.remove('on');
    document.body.classList.remove('touring');
    this.caption.classList.remove('show');
    clearTimeout(this._capTimer);

    this.camera.fov = this.prevFov || 50;
    this.camera.updateProjectionMatrix();

    // 把 orbit 参数同步到当前镜头，rig 接管时不会把画面拉回巡游前的旧位置
    const look = this.lastLook.clone();
    const dir = new THREE.Vector3().subVectors(this.camera.position, look);
    const radius = Math.max(4, dir.length());
    this.rig.target.copy(look);
    this.rig.targetGoal.copy(look);
    this.rig.radius = this.rig.radiusGoal = radius;
    this.rig.phi = this.rig.phiGoal = Math.acos(clamp(dir.y / radius, -1, 1));
    this.rig.theta = this.rig.thetaGoal = Math.atan2(dir.x, dir.z);
    this.rig.mode = 'orbit';

    this.onState(false);
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;

    // 跨段：shotStart 按累计时长推进，避免浮点误差多跳
    let guard = 0;
    while (guard++ < 8 && this.t >= this.shotStart + SHOTS[this.shot].dur) {
      this.shotStart += SHOTS[this.shot].dur;
      this.shot++;
      if (this.shot >= SHOTS.length) {
        this.stop();
        return;
      }
      this._setCaption(SHOTS[this.shot].caption);
    }

    const shot = SHOTS[this.shot];
    const raw = clamp((this.t - this.shotStart) / shot.dur, 0, 1);
    const p = easeInOut(raw);

    const x = lerp(shot.from.x, shot.to.x, p);
    const z = lerp(shot.from.z, shot.to.z, p);
    let y;
    if (shot.lift) {
      const y0 = this.world.heightAt(shot.from.x, shot.from.z) + 1.8;
      y = lerp(y0, shot.toY, p);
    } else {
      // 每帧重新贴合地形：绝不穿地，也不悬在半空
      y = this.world.heightAt(x, z) + 1.8;
    }

    const [lx0, ly0, lz0] = shot.from.look;
    const [lx1, ly1, lz1] = shot.to.look;
    const look = this.lastLook.set(
      lerp(lx0, lx1, p), lerp(ly0, ly1, p), lerp(lz0, lz1, p)
    );

    this.camera.position.set(x, y, z);
    this.camera.lookAt(look);

    // 自证统计：净空、最高点、房屋 AABB 命中
    const s = this.stats;
    s.frames++;
    s.minClearance = Math.min(s.minClearance, y - (this.world.heightAt(x, z) + 1.8));
    s.maxHeight = Math.max(s.maxHeight, y);
    for (const h of HOUSES) {
      const dx = x - h.pos[0], dz = z - h.pos[2];
      const c = Math.cos(-h.rot), sn = Math.sin(-h.rot);
      const hx = dx * c - dz * sn, hz = dx * sn + dz * c;
      if (Math.abs(hx) < 5.2 && Math.abs(hz) < 4.0 && y < 5.8) {
        s.houseHits++;
        break;
      }
    }
  }

  _setCaption(text) {
    clearTimeout(this._capTimer);
    this.caption.classList.remove('show');
    this._capTimer = setTimeout(() => {
      if (!this.active) return;
      this.caption.textContent = text;
      this.caption.classList.add('show');
    }, 120);
  }
}
