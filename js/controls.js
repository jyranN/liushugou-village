/**
 * 相机控制：上帝视角（环绕）与第一人称（行走）两套，可平滑切换
 *
 * 手感要点：
 *  - 旋转/缩放/移动全部走“带阻尼的跟随”，且用 exp(-dt*k) 归一化，
 *    帧率高低都是同一个时间常数，不会出现高刷屏发飘、低帧率发涩。
 *  - 滚轮按 deltaMode 归一化，触控板的小增量不会被放大成跳变。
 */

import * as THREE from 'three';
import { HOUSES, TREES, FACILITIES, STONES, MILLSTONE, CISTERNS, CIVIC } from './data.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
/** 与帧率无关的指数趋近系数 */
const damp = (dt, k) => 1 - Math.exp(-dt * k);

/** 行走时的碰撞体（用圆近似，够用且便宜） */
const OBSTACLES = [
  ...HOUSES.map((h) => ({ x: h.pos[0], z: h.pos[2], r: Math.max(h.yard.w, h.yard.d) * 0.42 })),
  ...TREES.map((t) => ({ x: t.pos[0], z: t.pos[2], r: Math.max(0.35, t.dbh / 220) })),
  ...FACILITIES.filter((f) => ['committee', 'barn', 'mill'].includes(f.kind))
    .map((f) => ({ x: f.pos[0], z: f.pos[2], r: 7 })),
  // 山腰上的山神庙：不在 data.js 里，手工补一个，免得能穿墙
  { x: 140, z: 20, r: 4.2 },
  // 村口石墩、石碾与水窖：矮，但人不该从中间穿过去
  ...STONES.map((s) => ({ x: s.pos[0], z: s.pos[1], r: 0.10 })),
  { x: MILLSTONE.pos[0], z: MILLSTONE.pos[1], r: 0.80 },
  ...CISTERNS.map((c) => ({ x: c.pos[0], z: c.pos[1], r: 0.40 })),
  /* 公共核心（v1.2）：C-01 ~ C-04 的占位圆 = footprint 半对角线，单位 m，
   * 数值写在 data.js 的 radius 字段里，与 tools/verify-civic.mjs 同一口径。
   * 四处都在 |x| = 33 ~ 40 m 的院外背街带，不吃主路走廊，也不挡巡游镜头。 */
  ...CIVIC.map((c) => ({ x: c.pos[0], z: c.pos[2], r: c.radius })),
];

export class Rig {
  constructor(camera, dom, heightAt) {
    this.camera = camera;
    this.dom = dom;
    this.heightAt = heightAt;

    this.mode = 'orbit';

    /* 上帝视角参数 */
    this.target = new THREE.Vector3(0, 0, -10);
    this.targetGoal = this.target.clone();
    this.theta = -0.55;
    this.thetaGoal = -0.55;
    this.phi = 0.92;
    this.phiGoal = 0.92;
    this.radius = 190;
    this.radiusGoal = 190;

    /* 行走参数 */
    this.walk = new THREE.Vector3(0, 0, -60);
    this.yaw = 0;
    this.pitch = -0.08;
    this.vel = new THREE.Vector2(0, 0);
    this.eye = 1.68;
    this.speed = 3.6;

    this.keys = new Set();
    this.joy = { x: 0, y: 0, active: false };
    this.dragging = false;
    this.locked = false;          // 自动巡游期间接管相机，屏蔽一切输入
    this.last = { x: 0, y: 0 };
    this.moved = 0;

    this._dir = new THREE.Vector3();
    this._look = new THREE.Vector3();

    this._bind();
  }

  _bind() {
    const el = this.dom;

    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      if (this.locked) return;
      this.dragging = true;
      this.moved = 0;
      this.last.x = e.clientX;
      this.last.y = e.clientY;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (this.locked || !this.dragging) return;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last.x = e.clientX;
      this.last.y = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);

      if (this.mode === 'orbit') {
        this.thetaGoal -= dx * 0.005;
        this.phiGoal = clamp(this.phiGoal - dy * 0.004, 0.12, 1.46);
      } else {
        this.yaw -= dx * 0.0032;
        this.pitch = clamp(this.pitch - dy * 0.0026, -0.9, 0.55);
      }
    });

    const up = () => { this.dragging = false; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('wheel', (e) => {
      if (this.locked) return;
      e.preventDefault();
      if (this.mode !== 'orbit') return;
      // 行/页模式换算成像素；触控板一次只有几个像素，不会突然拉近半条街
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const d = clamp(e.deltaY * unit, -260, 260);
      this.radiusGoal = clamp(this.radiusGoal * Math.exp(d * 0.0015), 6, 330);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (this.locked) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get isWalk() { return this.mode === 'walk'; }

  /** 切到第一人称，落在当前注视点附近 */
  enterWalk() {
    if (this.mode === 'walk') return;
    const t = this.target;
    this.walk.set(t.x, 0, t.z + 14);
    this.walk.x += 0.01;
    this.yaw = Math.atan2(t.x - this.walk.x, t.z - this.walk.z);
    this.pitch = -0.05;
    this.vel.set(0, 0);
    this.mode = 'walk';
    this.camera.fov = 68;
    this.camera.updateProjectionMatrix();
  }

  /** 回到上帝视角，从当前站立处拉高 */
  exitWalk() {
    if (this.mode === 'orbit') return;
    this.targetGoal.set(this.walk.x, 0, this.walk.z - 6);
    this.target.copy(this.targetGoal);
    this.radiusGoal = 74;
    this.radius = 30;
    this.theta = this.thetaGoal = this.yaw + Math.PI;
    this.phi = this.phiGoal = 1.02;
    this.mode = 'orbit';
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  /** 复位到默认机位 */
  reset() {
    if (this.isWalk) this.exitWalk();
    this.targetGoal.set(0, 0, -10);
    this.radiusGoal = 190;
    this.theta = this.thetaGoal = -0.55;
    this.phi = this.phiGoal = 0.92;
  }

  /** 聚焦某个物体 */
  focus(pos, radius = 46) {
    if (this.mode === 'walk') return;
    this.targetGoal.set(pos.x, 0, pos.z);
    this.radiusGoal = radius;
  }

  setJoystick(x, y) {
    this.joy.x = x;
    this.joy.y = y;
  }

  update(dt) {
    if (this.mode === 'orbit') this._updateOrbit(dt);
    else this._updateWalk(dt);
  }

  _updateOrbit(dt) {
    // 旋转：快跟手（约 50ms 时间常数），但不会硬切
    const kr = damp(dt, 20);
    this.theta += (this.thetaGoal - this.theta) * kr;
    this.phi += (this.phiGoal - this.phi) * kr;

    // 注视点：稍慢，拖动/聚焦时画面有推进感
    this.target.lerp(this.targetGoal, damp(dt, 5.5));
    // 缩放：约 110ms 跟到位，滚一下就有反应又不突兀
    this.radius = lerp(this.radius, this.radiusGoal, damp(dt, 9));

    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sp * Math.sin(this.theta),
      this.target.y + this.radius * cp,
      this.target.z + this.radius * sp * Math.cos(this.theta)
    );
    this.camera.lookAt(this.target);
  }

  _updateWalk(dt) {
    const k = this.keys;
    let ix = 0, iz = 0;

    if (k.has('KeyW') || k.has('ArrowUp')) iz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) iz += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) ix -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) ix += 1;

    if (this.joy.active) { ix += this.joy.x; iz += this.joy.y; }

    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }

    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const spd = this.speed * (sprint ? 2.1 : 1);

    // 以朝向为基准的移动
    // 水平前向量 F = (sin yaw, 0, cos yaw)
    // 右向量 R = F × 世界上向量(0,1,0) = (-cos yaw, 0, sin yaw)
    // 位移 = R * ix + F * (-iz)，iz 为负代表前进
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = -ix * cos - iz * sin;
    const wz = ix * sin - iz * cos;

    const targetVx = wx * spd;
    const targetVz = wz * spd;
    // 起步约 110ms、收步约 80ms：站定不飘，走起来不拖
    const accel = damp(dt, len > 0.01 ? 9 : 12);
    this.vel.x = lerp(this.vel.x, targetVx, accel);
    this.vel.y = lerp(this.vel.y, targetVz, accel);

    let nx = this.walk.x + this.vel.x * dt;
    let nz = this.walk.z + this.vel.y * dt;

    // 碰撞：碰到就沿切向滑动，不硬顶
    for (const o of OBSTACLES) {
      const dx = nx - o.x, dz = nz - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + 0.55;
      if (d < min && d > 0.0001) {
        const push = (min - d) / d;
        nx += dx * push;
        nz += dz * push;
      }
    }

    // 限制在村子与东山范围内（地形 620m 见方，别走出网格）
    nx = clamp(nx, -240, 240);
    nz = clamp(nz, -240, 240);

    this.walk.x = nx;
    this.walk.z = nz;

    const gy = this.heightAt(nx, nz) + this.eye;
    this.walk.y = lerp(this.walk.y || gy, gy, damp(dt, 11));

    this.camera.position.copy(this.walk);
    const dir = this._dir.set(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    this.camera.lookAt(this._look.copy(this.camera.position).add(dir));

    // 疾跑时轻微推镜，速度感更明确
    const fovGoal = sprint && len > 0.01 ? 74 : 68;
    if (Math.abs(this.camera.fov - fovGoal) > 0.01) {
      this.camera.fov = lerp(this.camera.fov, fovGoal, damp(dt, 6));
      this.camera.updateProjectionMatrix();
    }
  }
}
