/**
 * 界面层：物体档案卡、模式切换、虚拟摇杆、顶部信息条
 */

import { STATS, VILLAGE } from './data.js';

const el = (id) => document.getElementById(id);

/* ---------- 各类物体的字段表 ---------- */
const SCHEMA = {
  house: {
    label: '民居',
    color: '#c8a06a',
    fields: [
      ['door', '门牌'],
      ['use', '用途', null, () => '住宅'],
      ['area', '建筑面积', '㎡'],
      ['structure', '结构'],
      ['roof', '屋面'],
      ['built', '建成年份', '年'],
      ['residents', '常住人口', '人'],
      ['vacant', '状态', null, (v) => (v ? '空置' : '在住')],
    ],
  },
  tree: {
    label: '树木',
    color: '#7fa85a',
    fields: [
      ['kind', '树种'],
      ['age', '树龄', '年'],
      ['dbh', '胸径', 'cm'],
      ['height', '树高', 'm'],
      ['canopy', '冠幅', 'm'],
      ['health', '健康状况'],
      ['lastPrune', '上次修剪'],
    ],
  },
  animal: {
    label: '家畜',
    color: '#b8836a',
    fields: [
      ['breed', '品种'],
      ['earTag', '耳标号'],
      ['months', '月龄', '月'],
      ['weight', '体重', 'kg'],
      ['vaccine', '免疫记录'],
      ['owner', '归属农户'],
      ['status', '健康状态'],
    ],
  },
  facility: {
    label: '公共设施',
    color: '#7f9ab0',
    fields: [
      ['use', '用途'],
      ['built', '建成年份', '年'],
      ['area', '占地面积', '㎡'],
      ['structure', '结构'],
      ['status', '状态'],
    ],
  },
  yarditem: {
    label: '院落物件',
    color: '#b08b5e',
    fields: [
      ['category', '类别'],
      ['use', '用途'],
      ['contents', '存放/晾晒'],
      ['season', '使用时令'],
      ['structure', '材质'],
      ['owner', '所属农户'],
      ['status', '状态'],
    ],
  },
  field: {
    label: '地块',
    color: '#a08a5a',
    fields: [
      ['crop', '种植作物'],
      ['area', '面积', '亩'],
      ['stage', '当前生育期'],
    ],
  },
  stone: {
    label: '石墩',
    color: '#9aa3a0',
    fields: [
      ['era', '年代'],
      ['craft', '工艺'],
      ['seatHeight', '坐高', 'm'],
      ['original', '原有', '只'],
      ['remain', '现存', '只'],
      ['condition', '保存状况'],
      ['owner', '归属'],
    ],
  },
  millstone: {
    label: '石碾',
    color: '#9c948a',
    fields: [
      ['era', '年代'],
      ['disc', '碾盘直径', 'm'],
      ['roller', '碾磙'],
      ['weight', '碾磙重量', 'kg'],
      ['use', '用途'],
      ['condition', '保存状况'],
      ['owner', '归属'],
    ],
  },
  cistern: {
    label: '水窖',
    color: '#7f8c92',
    fields: [
      ['depth', '窖深', 'm'],
      ['capacity', '蓄水量', 'm³'],
      ['cover', '窖盖'],
      ['use', '用途'],
      ['condition', '保存状况'],
      ['owner', '归属'],
    ],
  },
};

const KIND_LABEL = {
  well: '水井', committee: '村委会', barn: '畜圈',
  yard: '晒场', mill: '磨坊', plaza: '广场', streetlight: '路灯', signboard: '宣传栏',
};

let onClose = null;
let current = null;

/* ---------- 档案卡 ---------- */
export function showCard(obj) {
  current = obj;
  const card = el('card');
  const s = SCHEMA[obj.type] || SCHEMA.facility;

  const rows = s.fields.map(([key, label, unit, fmt]) => {
    let v = obj[key];
    if (v === undefined || v === null || v === '') return '';
    if (fmt) v = fmt(v, obj);
    else if (unit) v = `${v} ${unit}`;
    return `<div class="row"><span class="k">${label}</span><span class="v">${v}</span></div>`;
  }).join('');

  const sub = obj.type === 'facility'
    ? (KIND_LABEL[obj.kind] || '设施')
    : obj.type === 'tree' ? obj.kind
    : obj.type === 'animal' ? obj.kind
    : obj.type === 'yarditem' ? (obj.category || '院落物件')
    : obj.type === 'field' ? '耕地'
    : obj.type === 'stone' ? '村口坐具'
    : obj.type === 'millstone' ? '粮食加工'
    : obj.type === 'cistern' ? '雨水集蓄'
    : (obj.structure || '民居');

  card.style.setProperty('--accent', s.color);
  card.innerHTML = `
    <div class="card-head">
      <div class="card-tag">${s.label}<i>${sub}</i></div>
      <button class="card-close" id="cardClose" aria-label="关闭">×</button>
    </div>
    <h2 class="card-title">${obj.name}</h2>
    <div class="card-id">编号 ${obj.id}</div>
    <div class="card-body">${rows}</div>
    ${obj.note ? `<div class="card-note">${obj.note}</div>` : ''}
  `;

  card.classList.add('open');
  el('cardClose').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCard();
  });
}

export function hideCard() {
  const card = el('card');
  if (!card.classList.contains('open')) return;
  card.classList.remove('open');
  current = null;
  if (onClose) onClose();
}

export function isCardOpen() {
  return el('card').classList.contains('open');
}

export function setCloseHandler(fn) { onClose = fn; }

/* ---------- 模式切换 ---------- */
export function setMode(mode) {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  document.body.classList.toggle('walking', mode === 'walk');
  el('crosshair').style.opacity = mode === 'walk' ? '1' : '0';
  el('joystick').style.display = mode === 'walk' ? 'block' : 'none';
  setHint(mode === 'walk'
    ? 'W A S D 移动 · 按住鼠标转头 · Shift 加速 · Esc 返回上帝视角'
    : '拖拽旋转 · 滚轮缩放 · 点击物体看档案 · 拖时间轴看天气 · 空格暂停');
}

export function setHint(text) {
  el('hint').textContent = text;
}

/* ---------- 摇杆 ---------- */
export function bindJoystick(rig) {
  const box = el('joystick');
  const knob = el('joy-knob');
  const R = 44;
  let active = false;

  const move = (e) => {
    const r = box.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx = dx / d * R; dy = dy / d * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    rig.setJoystick(dx / R, dy / R);
  };

  box.addEventListener('pointerdown', (e) => {
    active = true;
    box.setPointerCapture(e.pointerId);
    box.classList.add('active');
    rig.joy.active = true;
    move(e);
    e.stopPropagation();
  });
  box.addEventListener('pointermove', (e) => {
    if (!active) return;
    move(e);
    e.stopPropagation();
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    box.classList.remove('active');
    rig.joy.active = false;
    rig.setJoystick(0, 0);
    knob.style.transform = 'translate(0px, 0px)';
    e.stopPropagation();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

/* ---------- 顶部统计 ---------- */
export function initHud() {
  el('villageName').textContent = VILLAGE.name;
  el('villageSub').textContent = VILLAGE.subtitle;
  el('seasonTag').textContent = VILLAGE.season;

  const items = [
    ['民居', STATS.houses, '户'],
    ['树木', STATS.trees, '棵'],
    ['家畜', STATS.animals, '头'],
    ['地块', STATS.fields, '块'],
    ['常住', STATS.residents, '人'],
  ];
  el('stats').innerHTML = items
    .map(([k, v, u]) => `<div class="stat"><b>${v}</b><span>${k}<i>${u}</i></span></div>`)
    .join('');
}

/* ---------- 加载遮罩 ---------- */
export function hideLoader() {
  const l = el('loader');
  l.style.display = 'none';
}

export function initLoader(text) {
  el('loaderText').textContent = text;
}

/* ---------- 画质档位 ---------- */
let onQualityPick = null;

export function bindQuality(fn) {
  onQualityPick = fn;
  document.querySelectorAll('#qualityBar button').forEach((b) => {
    b.addEventListener('click', () => { if (onQualityPick) onQualityPick(b.dataset.q); });
  });
}

export function setQuality(key) {
  document.querySelectorAll('#qualityBar button').forEach((b) => {
    b.classList.toggle('on', b.dataset.q === key);
  });
}

/* ---------- 天气预设 ---------- */
let wxPresets = [];
let activeWx = null;

export function bindWxPresets(presets, fn) {
  wxPresets = presets;
  document.querySelectorAll('#wxPreset button').forEach((b) => {
    const p = presets.find((x) => x.key === b.dataset.wx);
    if (!p) { b.style.display = 'none'; return; }
    // 悬停就能看到这个预设落到哪天几点、凭什么选出来的
    b.title = `${p.label} · ${p.date} ${p.clock}\n${p.basis}\n气温 ${p.temp.toFixed(1)}℃ · 云 ${p.cloud}%`
      + (p.precip > 0 ? ` · 降水 ${p.precip} mm` : '')
      + (p.snow > 0 ? ` · 降雪 ${p.snow} cm` : '');
    b.addEventListener('click', () => {
      fn(p);
      setWxPreset(p.key);
    });
  });
}

export function setWxPreset(key) {
  activeWx = key;
  document.querySelectorAll('#wxPreset button').forEach((b) => {
    b.classList.toggle('on', b.dataset.wx === key);
  });
}

export function syncPlayBtn(clock) {
  const play = el('playBtn');
  if (!play) return;
  play.textContent = clock.playing ? '暂停' : '播放';
  barCache.play = play.textContent;
}

/* ---------- 时间轴 ---------- */
const WX_LABEL = {
  0: '晴', 1: '少云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 96: '雷阵雨',
};

export function weatherLabel(wx) {
  if (wx.precip > 0.05 || wx.snow > 0.01) {
    if (wx.snow > 0.01 || wx.temp < 0.5) {
      return wx.snow > 0.6 ? '中雪' : '小雪';
    }
    if (wx.precip > 2.5) return '中雨';
    if (wx.precip > 0.6) return '小雨';
    return '毛毛雨';
  }
  const base = WX_LABEL[wx.code] || '多云';
  if (base === '晴' && wx.cloud > 35) return '多云';
  return base;
}

// 时间轴分辨率：15 分钟一格（一年 35040 格），拖动时太阳是连续挪的，不会一次跳几小时
const TIME_STEPS = 35040;

export function bindTimebar(clock) {
  const range = el('timeRange');
  const play = el('playBtn');
  let wasPlaying = false;

  const syncPlay = () => {
    if (play) play.textContent = clock.playing ? '暂停' : '播放';
  };

  // 拖动时先记住原来是不是在播放，松手自动恢复，不用再点一次「播放」
  range.addEventListener('pointerdown', () => {
    wasPlaying = clock.playing;
    clock.dragging = true;
    clock.playing = false;
    syncPlay();
  });
  range.addEventListener('input', () => {
    clock.ratio = Number(range.value) / TIME_STEPS;
  });
  const endDrag = () => {
    if (!clock.dragging) return;
    clock.dragging = false;
    if (wasPlaying) clock.playing = true;
    syncPlay();
  };
  range.addEventListener('pointerup', endDrag);
  range.addEventListener('pointercancel', endDrag);
  range.addEventListener('change', endDrag);
  // 指针拖到滑块外面松手也要恢复播放
  window.addEventListener('pointerup', endDrag);

  if (play) {
    play.addEventListener('click', () => {
      clock.playing = !clock.playing;
      syncPlay();
    });
  }

  /* 速度档位：一天 = 6 分 / 3 分 / 1 分 / 20 秒 */
  const ctl = el('speedCtl');
  if (ctl) {
    const btns = [...ctl.querySelectorAll('button')];
    const sync = () => btns.forEach((b, i) => b.classList.toggle('on', i === clock.speedIndex));
    btns.forEach((b, i) => b.addEventListener('click', () => {
      clock.setSpeed(i);
      sync();
    }));
    sync();
  }
}

/* 时间条每帧都写 DOM 会拖慢主线程，这里限到 ~9Hz，并且只在文字真的变了才写 */
let lastBarAt = 0;
const barCache = { date: '', wx: '', play: '', range: '' };

export function updateTimebar(clock, wx, force = false) {
  const now = performance.now();
  if (!force && now - lastBarAt < 110) return;
  lastBarAt = now;

  // 时间一旦离开预设时刻（拖动、播放、跨天回卷），把高亮的天气按钮取消掉
  if (activeWx) {
    const p = wxPresets.find((x) => x.key === activeWx);
    if (p && Math.abs(clock.hour - p.index) > 0.5) setWxPreset(null);
  }

  const range = el('timeRange');
  if (range && !clock.dragging) {
    const v = String(Math.round(clock.ratio * TIME_STEPS));
    if (v !== barCache.range) { range.value = v; barCache.range = v; }
  }

  const play = el('playBtn');
  if (play) {
    const t = clock.playing ? '暂停' : '播放';
    if (t !== barCache.play) { play.textContent = t; barCache.play = t; }
  }

  const hh = Math.floor(wx.hourOfDay);
  const mm = Math.floor((wx.hourOfDay - hh) * 60);
  const d = el('timeDate');
  if (d) {
    const txt = `${wx.date.slice(5)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (txt !== barCache.date) { d.textContent = txt; barCache.date = txt; }
  }

  const w = el('timeWx');
  if (w) {
    const txt = `${weatherLabel(wx)} ${wx.temp.toFixed(1)}℃ · 云 ${Math.round(wx.cloud)}%`;
    if (txt !== barCache.wx) { w.textContent = txt; barCache.wx = txt; }
  }
}
