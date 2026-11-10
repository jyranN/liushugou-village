/**
 * 同机位 A/B 对比
 *
 * 做法上有一个关键的取舍：**A 不是"第二台相机再渲染一遍"，而是一帧抓下来的位图**。
 *
 *   - 进入对比时，在渲染完成的那一帧把 `renderer.domElement` 的内容 drawImage 到一张
 *     2D canvas（覆盖层），这一帧就是 A。
 *   - 之后时间怎么改，主画面就是 B；覆盖层按滑杆宽度裁切，左 A 右 B。
 *   - 改裁切宽度只是改一条 CSS 变量，**不触发任何渲染**，所以既没有第二个渲染通道，
 *     也不会掉帧；切换响应就是一次样式重排。
 *
 * 代价是 A 会过期：只要相机一动，A 就不是"同一机位"了。所以对比期间 main.js 会跳过
 * rig / tour 的 update，把相机钉住；`afterRender()` 每帧把当前 `camera.matrixWorld`
 * 的 16 个 float 与抓帧时存下的那份逐位比对，不一致会计数（?qa=1 面板能看到）。
 *
 * 抓帧时机很关键：必须在 `composer.render()`（以及雨雪的第二次叠加）之后、同一帧内
 * 完成，否则 WebGL 的绘制缓冲已经被浏览器合成清空，拿到的会是空白图。
 */

const el = (id) => document.getElementById(id);

export class Compare {
  constructor({ renderer, camera, onState = null }) {
    this.renderer = renderer;
    this.camera = camera;
    this.onState = onState;

    this.active = false;        // 对比模式是否开启
    this.ready = false;         // A 帧是否已经抓到
    this.split = 50;            // 分割位置，百分比
    this.matrixDiff = 0;        // 相机矩阵与抓帧时不一致的浮点数个数（应为 0）

    this._hold = false;         // 是否按住 Tab 全屏看 A
    this._wantCapture = false;
    // 必须用 Float64：Matrix4.elements 是双精度，存进 Float32Array 会被截断，
    // 逐位比较就永远不相等（实测 16 个里有 11 个对不上，全是精度截断造成的假差异）
    this._matrix = new Float64Array(16);

    this.canvas = el('abCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.btn = el('abBtn');
    this.slider = el('abSlider');
    this.info = el('abInfo');
    this.root = document.documentElement;

    this._bind();
  }

  /* ---------- 交互 ---------- */
  _bind() {
    this.btn.addEventListener('click', () => {
      if (this.active) this.exit();
      else this.enter();
    });
    el('abClose').addEventListener('click', () => this.exit());
    el('abRecapture').addEventListener('click', () => this.capture());

    this.slider.addEventListener('input', () => this.setSplit(Number(this.slider.value)));

    // Tab 全屏闪回 A：只在对比模式下接管，其它时候 Tab 照常走焦点导航
    this._onKeyDown = (e) => {
      if (!this.active || e.key !== 'Tab' || this._hold) return;
      e.preventDefault();
      this._hold = true;
      this.root.style.setProperty('--ab-split', '100%');
    };
    this._onKeyUp = (e) => {
      if (!this.active || e.key !== 'Tab') return;
      e.preventDefault();
      this._hold = false;
      this.root.style.setProperty('--ab-split', `${this.split}%`);
    };
    // 窗口失焦时 keyup 可能收不到，Tab 卡在按下状态就回不去了
    this._onBlur = () => {
      if (!this.active || !this._hold) return;
      this._hold = false;
      this.root.style.setProperty('--ab-split', `${this.split}%`);
    };
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    window.addEventListener('blur', this._onBlur);

    // 尺寸一变，A 的位图就会拉伸，直接退出对比，让用户重记
    window.addEventListener('resize', () => {
      // 留一份尺寸变更日志：对比被 resize 判废时，这里是唯一的线索
      (window.__abResizeLog || (window.__abResizeLog = [])).push([
        Math.round(performance.now()), window.innerWidth, window.innerHeight,
        this.renderer.domElement.width, this.renderer.domElement.height,
        this.canvas.width, this.canvas.height,
      ]);
      if (this.active) {
        this.exit('resize');
        if (this.info) this.info.textContent = '窗口尺寸变了，已退出对比，请重新记 A';
      }
    });
  }

  setSplit(pct) {
    const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 50));
    this.split = p;
    if (!this._hold) this.root.style.setProperty('--ab-split', `${p}%`);
    if (this.slider && Number(this.slider.value) !== Math.round(p)) this.slider.value = String(Math.round(p));
  }

  /* ---------- 状态 ---------- */
  enter() {
    if (this.active) return;
    this.active = true;
    this.ready = false;
    this.matrixDiff = 0;
    this._hold = false;
    document.body.classList.add('comparing');
    this.btn.classList.add('on');
    this.btn.textContent = '对比中';
    this.setSplit(this.split);
    if (this.info) this.info.textContent = '正在记录 A…';
    this.capture();
    if (this.onState) this.onState(true);
  }

  exit(reason = 'user') {
    if (!this.active) return;
    window.__abLastExit = reason;
    this.active = false;
    this.ready = false;
    this._hold = false;
    document.body.classList.remove('comparing');
    this.btn.classList.remove('on');
    this.btn.textContent = '对比';
    this.root.style.removeProperty('--ab-split');
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.onState) this.onState(false);
  }

  /** 请求在下一帧渲染完成后重新抓 A */
  capture() {
    this._wantCapture = true;
  }

  /* ---------- 每帧（渲染之后调用） ---------- */
  afterRender() {
    if (!this.active) return;
    if (this._wantCapture) this._grab();
    if (this.ready) this.matrixDiff = this._diffMatrix();
  }

  _grab() {
    this._wantCapture = false;
    const gl = this.renderer.domElement;
    if (!gl.width || !gl.height) return;
    if (this.canvas.width !== gl.width || this.canvas.height !== gl.height) {
      this.canvas.width = gl.width;
      this.canvas.height = gl.height;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 同一帧内直接把绘制缓冲拷过来：尺寸相同，是 1:1 的像素复制，不经过缩放
    this.ctx.drawImage(gl, 0, 0, this.canvas.width, this.canvas.height);
    this.camera.updateMatrixWorld();
    this._matrix.set(this.camera.matrixWorld.elements);
    this.ready = true;
    if (this.info) this.info.textContent = '左 A（已缓存） · 右 B（实时） · 按住 Tab 全屏看 A';
  }

  _diffMatrix() {
    const e = this.camera.matrixWorld.elements;
    let bad = 0;
    for (let i = 0; i < 16; i++) if (e[i] !== this._matrix[i]) bad++;
    return bad;
  }
}
