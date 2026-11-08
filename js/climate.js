/**
 * 时间引擎 + 气候数据
 * 数据源：Open-Meteo 历史档案，岷县 2025 全年 8760 小时
 *
 * 时间规则：可调速，默认「1 天 = 3 分钟」。
 * 所有环境量（太阳高度、气温、云量…）都在整点之间连续插值，
 * 太阳位置用真实天文公式逐帧求解 —— 这是昼夜不再逐小时跳变的关键。
 */

const YEAR_START = '2025-01-01T00:00';

const DEG = Math.PI / 180;
const LAT = 34.4367 * DEG;      // 岷县纬度
const LON = 104.0417;           // 岷县经度
const MERIDIAN = 120;           // 东八区标准经线

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** 速度档位：数值 = 走完一天需要的现实秒数 */
export const SPEEDS = [
  { label: '6分', secondsPerDay: 360 },
  { label: '3分', secondsPerDay: 180 },
  { label: '1分', secondsPerDay: 60 },
  { label: '20秒', secondsPerDay: 20 },
];
export const DEFAULT_SPEED = 1;   // 默认「1 天 = 3 分钟」

export class Climate {
  constructor(raw) {
    this.hourly = raw.hourly;
    this.daily = raw.daily;
    this.n = raw.hourly.time.length;
    this.dayCount = raw.daily.time.length;
    this.epoch = new Date(`${YEAR_START}:00+08:00`).getTime();
  }

  static async load(url = './data/minxian-2025-raw.json') {
    // 单文件离线版：数据在构建时已内联，避免 file:// 下 fetch 被拦截
    if (typeof window !== 'undefined' && window.__CLIMATE_DATA) {
      return new Climate(window.__CLIMATE_DATA);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`气候数据加载失败：${res.status}`);
    return new Climate(await res.json());
  }

  /** 取某一小时的原始记录（越界自动回卷，一年循环） */
  at(hour) {
    const i = ((Math.floor(hour) % this.n) + this.n) % this.n;
    const h = this.hourly;
    return {
      index: i,
      hour,
      time: h.time[i],
      temp: h.temperature_2m[i] ?? 0,
      humi: h.relative_humidity_2m[i] ?? 60,
      precip: h.precipitation[i] ?? 0,
      cloud: h.cloud_cover[i] ?? 50,
      code: h.weather_code[i] ?? 0,
      wind: h.wind_speed_10m[i] ?? 0,
      snow: h.snowfall[i] ?? 0,
      isDay: (h.is_day[i] ?? 1) === 1,
      dayOfYear: Math.floor(i / 24),
      hourOfDay: i % 24,
    };
  }

  /** 在整点之间做线性插值，避免一小时一跳 */
  sample(hour) {
    const base = Math.floor(hour);
    const a = this.at(base);
    const b = this.at(base + 1);
    const f = hour - base;
    return {
      ...a,
      temp: lerp(a.temp, b.temp, f),
      humi: lerp(a.humi, b.humi, f),
      precip: lerp(a.precip, b.precip, f),
      cloud: lerp(a.cloud, b.cloud, f),
      wind: lerp(a.wind, b.wind, f),
      // 昼夜与物候也跟着连续推进，否则午夜会硬切一次
      dayOfYear: (((base % this.n) + this.n) % this.n) / 24 + f / 24,
      hourOfDay: (((hour % 24) + 24) % 24),
      isDay: f < 0.5 ? a.isDay : b.isDay,
    };
  }

  /** 当天的日出日落（小时数，如 5.9 / 20.33），按天文公式反解 */
  daylight(dayOfYear) {
    const v = this.sunVector(dayOfYear * 24 + 12);
    return { sunrise: v.sunrise, sunset: v.sunset };
  }

  /**
   * 连续的太阳位置（每帧可调用）。
   * 用赤纬 + 时角求解，太阳高度/方位随时间平滑变化，没有整点台阶。
   * dir 为世界坐标方向：x 东、y 天顶、z 南。
   */
  sunVector(hour) {
    const h = ((hour % this.n) + this.n) % this.n;
    const doy = h / 24;                 // 0 .. 365，带小数
    const hourOfDay = h % 24;

    // 赤纬（-23.44° .. +23.44°）
    const dec = 0.409105 * Math.sin(2 * Math.PI * (doy - 80.5) / 365.24);

    // 时差方程（分钟）：让日出日落与气象站记录对得上
    const B = 2 * Math.PI * (doy - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    const noon = 12 + (MERIDIAN - LON) / 15 - eot / 60;

    const H = (hourOfDay - noon) * 15 * DEG;                  // 时角
    const sinAlt = Math.sin(LAT) * Math.sin(dec)
      + Math.cos(LAT) * Math.cos(dec) * Math.cos(H);
    const alt = Math.asin(clamp(sinAlt, -1, 1));

    // 地平坐标 → 世界坐标
    const east = -Math.cos(dec) * Math.sin(H);
    const north = Math.sin(dec) * Math.cos(LAT)
      - Math.cos(dec) * Math.cos(H) * Math.sin(LAT);
    const len = Math.hypot(east, sinAlt, north) || 1;

    // 日出日落（同一套公式反解，和光照完全自洽）
    const H0 = Math.acos(clamp(-Math.tan(LAT) * Math.tan(dec), -1, 1));
    const sunrise = noon - H0 / (15 * DEG);
    const sunset = noon + H0 / (15 * DEG);

    return {
      doy, hourOfDay, sinAlt, alt,
      sunrise, sunset,
      dir: { x: east / len, y: sinAlt / len, z: -north / len },
      progress: clamp((hourOfDay - sunrise) / Math.max(0.1, sunset - sunrise), 0, 1),
      up: sinAlt > 0,
    };
  }

  /** 兼容旧接口：alt 为 0..1 的“太阳力”，elevation 为弧度 */
  sunAt(hour) {
    const v = this.sunVector(hour);
    return {
      up: v.sinAlt > 0,
      alt: Math.max(0, v.sinAlt),
      sinAlt: v.sinAlt,
      elevation: v.alt,
      progress: v.progress,
      dir: v.dir,
      sunrise: v.sunrise,
      sunset: v.sunset,
    };
  }
}

/** 时间轴控制器 */
export class Clock {
  constructor(climate, speedIndex = DEFAULT_SPEED) {
    this.climate = climate;
    this.hour = 0;              // 世界小时（0 .. 8760，带小数）
    this.playing = true;
    this.speedIndex = clamp(speedIndex, 0, SPEEDS.length - 1);
    this.rate = 24 / SPEEDS[this.speedIndex].secondsPerDay;   // 世界小时 / 现实秒
    this._rate = this.rate;      // 平滑后的实际速率，切档不会突然一蹿
    this.dragging = false;
  }

  get total() { return this.climate.n; }
  get ratio() { return this.hour / this.total; }
  get secondsPerDay() { return SPEEDS[this.speedIndex].secondsPerDay; }

  set ratio(r) {
    this.hour = clamp(r, 0, 0.99999) * this.total;
  }

  /** 切换速度档位（0..3） */
  setSpeed(i) {
    this.speedIndex = clamp(i | 0, 0, SPEEDS.length - 1);
    this.rate = 24 / SPEEDS[this.speedIndex].secondsPerDay;
  }

  /** 现实秒 → 世界小时 */
  advance(realSeconds) {
    const target = this.playing ? this.rate : 0;
    // 速度本身也做一点缓动，避免按档位时画面“弹”一下
    this._rate += (target - this._rate) * (1 - Math.exp(-realSeconds * 7));
    if (Math.abs(this._rate) < 1e-6) return;

    this.hour += realSeconds * this._rate;
    if (this.hour >= this.total) this.hour -= this.total;
    if (this.hour < 0) this.hour += this.total;
  }

  get label() {
    const a = this.climate.at(this.hour);
    return `${a.time.replace('T', ' ')}`;
  }

  get dateLabel() {
    const a = this.climate.at(this.hour);
    return a.time.slice(0, 10);
  }
}

/* ---------- 天气预设 ----------
 * 四个时刻全部从当年 8760 条逐小时实测记录里现算，不写死日期。
 * 换一份数据文件，这四条会自动落到新数据里对应的极值时刻上。
 */
export function findWeatherPresets(climate) {
  const h = climate.hourly;
  const n = climate.n;
  const hourOf = (i) => Number(h.time[i].slice(11, 13));
  const monthOf = (i) => Number(h.time[i].slice(5, 7));
  const isSummer = (i) => { const m = monthOf(i); return m >= 6 && m <= 8; };

  /* 晴：云量 <10%、无降水、白天 9–16 点。
   * 这种时刻一年有几百个，规则里要求"优先取夏季"，夏季里再取最热的一刻，
   * 得到的是盛夏正午前后的通透天，比随便挑一个初春晴天更有代表性。 */
  let sunny = -1;
  for (let i = 0; i < n; i++) {
    const hod = hourOf(i);
    if (hod < 9 || hod > 16) continue;
    if ((h.cloud_cover[i] ?? 100) >= 10) continue;
    if ((h.precipitation[i] ?? 0) > 0) continue;
    if ((h.snowfall[i] ?? 0) > 0) continue;
    if (sunny < 0) { sunny = i; continue; }
    const si = isSummer(i), sb = isSummer(sunny);
    if (si !== sb) { if (si) sunny = i; continue; }
    if ((h.temperature_2m[i] ?? -99) > (h.temperature_2m[sunny] ?? -99)) sunny = i;
  }

  /* 阴：云量 >85%、无降水无降雪。
   * 云量 100% 的时刻一年有两千多个，光按最大值取会落到 1 月 1 日凌晨，
   * 所以同级里再按"夏季优先 → 云量更高 → 更接近 13 点"排一次序。 */
  let overcast = -1;
  for (let i = 0; i < n; i++) {
    if ((h.cloud_cover[i] ?? 0) <= 85) continue;
    if ((h.precipitation[i] ?? 0) > 0) continue;
    if ((h.snowfall[i] ?? 0) > 0) continue;
    if (overcast < 0) { overcast = i; continue; }
    const a = [isSummer(i) ? 1 : 0, h.cloud_cover[i] ?? 0, -Math.abs(hourOf(i) - 13)];
    const b = [isSummer(overcast) ? 1 : 0, h.cloud_cover[overcast] ?? 0, -Math.abs(hourOf(overcast) - 13)];
    const better = a[0] !== b[0] ? a[0] > b[0]
      : a[1] !== b[1] ? a[1] > b[1]
      : a[2] > b[2];
    if (better) overcast = i;
  }

  /* 雨：全年降水量最大的那一小时（不做任何时段/季节修饰） */
  let rainiest = 0;
  for (let i = 1; i < n; i++) {
    if ((h.precipitation[i] ?? 0) > (h.precipitation[rainiest] ?? 0)) rainiest = i;
  }

  /* 雪：有降雪且气温 <0℃，取雪量最大的一刻 */
  let snowiest = -1;
  for (let i = 0; i < n; i++) {
    if ((h.snowfall[i] ?? 0) <= 0) continue;
    if ((h.temperature_2m[i] ?? 0) >= 0) continue;
    if (snowiest < 0 || (h.snowfall[i] ?? 0) > (h.snowfall[snowiest] ?? 0)) snowiest = i;
  }

  const pack = (key, label, i, basis) => ({
    key, label, index: i,
    date: i >= 0 ? h.time[i].slice(0, 10) : '—',
    clock: i >= 0 ? h.time[i].slice(11, 16) : '—',
    temp: i >= 0 ? (h.temperature_2m[i] ?? 0) : 0,
    cloud: i >= 0 ? (h.cloud_cover[i] ?? 0) : 0,
    precip: i >= 0 ? (h.precipitation[i] ?? 0) : 0,
    snow: i >= 0 ? (h.snowfall[i] ?? 0) : 0,
    code: i >= 0 ? (h.weather_code[i] ?? 0) : 0,
    basis,
  });

  return [
    pack('sunny', '晴', sunny, '云量<10%、无降水、9–16 点，夏季最热'),
    pack('overcast', '阴', overcast, '云量>85%、无降水，夏季正午前后'),
    pack('rain', '雨', rainiest, '全年降水量最大的一小时'),
    pack('snow', '雪', snowiest, '有降雪且气温<0℃，雪量最大'),
  ].filter((p) => p.index >= 0);
}
