// Motion tracking and spell matching. Mirrors bridge/openwand/motion.py and matcher.py.

export const SAMPLE_PERIOD_S = 1 / 230;
const MAHONY_GAIN = 0.6;
const START_RATE = 2.2, END_RATE = 0.8, END_HOLD_S = 0.22, PRE_ROLL_S = 0.12;
const MIN_DURATION_S = 0.25, MAX_DURATION_S = 6.0, MIN_EXTENT_DEG = 18.0, SMOOTHING = 0.18;
export const DEFAULT_TIP_AXIS = [0, 1, 0]; // measured on MCW-B695 by calibration

const deg = r => r * 180 / Math.PI;
const clamp1 = v => Math.max(-1, Math.min(1, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const n = Math.hypot(...v) || 1; return v.map(c => c / n); };
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
export const rotate = (q, v) => qmul(qmul(q, [0, ...v]), [q[0], -q[1], -q[2], -q[3]]).slice(1);

class Orientation {
  constructor() { this.q = [1, 0, 0, 0]; this.settled = false; }
  levelFrom(accel) {
    const a = norm(accel), axis = cross(a, [0, 0, 1]), s = Math.hypot(...axis), angle = Math.atan2(s, a[2]);
    if (s < 1e-9) this.q = angle < 1 ? [1, 0, 0, 0] : [0, 1, 0, 0];
    else this.q = [Math.cos(angle / 2), ...axis.map(c => c / s * Math.sin(angle / 2))];
  }
  step(gyro, accel, dt = SAMPLE_PERIOD_S) {
    if (!this.settled && accel.some(c => c)) { this.levelFrom(accel); this.settled = true; }
    let [gx, gy, gz] = gyro;
    const an = Math.hypot(...accel);
    if (an > 0.7 && an < 1.3) { // only trust gravity while not being flung about
      const [ax, ay, az] = accel.map(c => c / an), [w, x, y, z] = this.q;
      const ux = 2 * (x * z - w * y), uy = 2 * (w * x + y * z), uz = w * w - x * x - y * y + z * z;
      gx += MAHONY_GAIN * (ay * uz - az * uy); gy += MAHONY_GAIN * (az * ux - ax * uz); gz += MAHONY_GAIN * (ax * uy - ay * ux);
    }
    const [w, x, y, z] = this.q, h = 0.5 * dt;
    const q = [w + h * (-x * gx - y * gy - z * gz), x + h * (w * gx + y * gz - z * gy), y + h * (w * gy - x * gz + z * gx), z + h * (w * gz + x * gy - y * gx)];
    const n = Math.hypot(...q);
    this.q = n > 0 && isFinite(n) ? q.map(c => c / n) : [1, 0, 0, 0];
    return this.q;
  }
}

export class Tracker {
  constructor(tipAxis = DEFAULT_TIP_AXIS) {
    this.tipAxis = tipAxis; this.orientation = new Orientation(); this.rate = 0; this.recording = false; this.padsHeld = false;
    this.history = []; this.quats = []; this.quiet = 0; this.gripped = false;
    this.historyLen = Math.floor(PRE_ROLL_S / SAMPLE_PERIOD_S) + 1;
  }
  // sample: [gx, gy, gz (rad/s), ax, ay, az (g)]. Returns {points, durationS, gripped} when a gesture ends.
  feed([gx, gy, gz, ax, ay, az]) {
    const q = this.orientation.step([gx, gy, gz], [ax, ay, az]);
    this.rate += SMOOTHING * (Math.hypot(gx, gy, gz) - this.rate);
    this.history.push(q); if (this.history.length > this.historyLen) this.history.shift();
    if (!this.recording) {
      if (this.rate > START_RATE) { this.recording = true; this.quats = [...this.history]; this.quiet = 0; this.gripped = this.padsHeld; }
      return null;
    }
    this.quats.push(q);
    this.gripped = this.gripped || this.padsHeld; // grips shift mid-cast; any pad at any point counts
    this.quiet = this.rate < END_RATE ? this.quiet + 1 : 0;
    const tooLong = this.quats.length * SAMPLE_PERIOD_S > MAX_DURATION_S;
    if (this.quiet * SAMPLE_PERIOD_S < END_HOLD_S && !tooLong) return null;
    this.recording = false;
    const quats = tooLong ? this.quats : this.quats.slice(0, this.quats.length - this.quiet);
    if (quats.length * SAMPLE_PERIOD_S < MIN_DURATION_S || tooLong) return null;
    const points = this.project(quats);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < MIN_EXTENT_DEG) return null;
    return { points, durationS: quats.length * SAMPLE_PERIOD_S, gripped: this.gripped };
  }
  livePoints() { return this.recording && this.quats.length > 2 ? this.project(this.quats) : []; }
  project(quats) {
    const up = [0, 0, 1], d0 = norm(rotate(quats[0], this.tipAxis));
    const heading = Math.hypot(d0[0], d0[1]) > 0.15 ? norm([d0[0], d0[1], 0]) : [1, 0, 0];
    const right = cross(heading, up), pitch0 = deg(Math.asin(clamp1(d0[2])));
    return quats.map(q => {
      const d = norm(rotate(q, this.tipAxis));
      return [deg(Math.atan2(dot(d, right), dot(d, heading))), deg(Math.asin(clamp1(dot(d, up)))) - pitch0];
    });
  }
}

// Wand held still pointing straight up: gravity reads along the tip axis.
export function tipAxisFromStill(accels) {
  if (accels.length < 50) return null;
  const mean = [0, 1, 2].map(i => accels.reduce((s, a) => s + a[i], 0) / accels.length);
  const spread = Math.max(...accels.map(a => Math.hypot(a[0] - mean[0], a[1] - mean[1], a[2] - mean[2])));
  const mag = Math.hypot(...mean);
  if (spread > 0.25 || mag < 0.8 || mag > 1.2) return null;
  const i = [0, 1, 2].reduce((b, k) => Math.abs(mean[k]) > Math.abs(mean[b]) ? k : b, 0);
  if (Math.abs(mean[i]) < 0.85) return null;
  const axis = [0, 0, 0]; axis[i] = mean[i] > 0 ? 1 : -1; return axis;
}

// ── Matching ──
const N_POINTS = 48;
export const ACCEPT_SCORE = 0.16, MARGIN = 1.2, MAX_TEMPLATES = 8;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function resample(points, n = N_POINTS) {
  let total = 0; for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  if (total === 0) return Array(n).fill(points[0]);
  const step = total / (n - 1), out = [points[0]]; let acc = 0, i = 1, prev = points[0];
  while (out.length < n - 1 && i < points.length) {
    const d = dist(prev, points[i]);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d; prev = [prev[0] + t * (points[i][0] - prev[0]), prev[1] + t * (points[i][1] - prev[1])];
      out.push(prev); acc = 0;
    } else { acc += d; prev = points[i]; i++; }
  }
  while (out.length < n) out.push(points[points.length - 1]);
  return out;
}

export function normalise(points) {
  const pts = resample(points);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const cx = xs.reduce((a, b) => a + b) / pts.length, cy = ys.reduce((a, b) => a + b) / pts.length;
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return size < 1e-6 ? null : pts.map(([x, y]) => [(x - cx) / size, (y - cy) / size]);
}

export const score = (a, b) => a.reduce((s, p, i) => s + dist(p, b[i]), 0) / a.length;

// store: {load(): object|null, save(object)} — localStorage on the iPad, a plain object in tests.
export class Matcher {
  constructor(store) { this.store = store; this.raw = {}; this.tipAxis = null; this.prepared = {}; this.load(); }
  load() {
    const data = this.store.load() || {};
    this.raw = data.spells || {}; this.tipAxis = data.tipAxis || null;
    this.prepared = Object.fromEntries(Object.entries(this.raw).map(([k, ts]) => [k, ts.map(normalise).filter(Boolean)]));
  }
  save() {
    const r = v => Math.round(v * 100) / 100;
    this.store.save({ tipAxis: this.tipAxis, spells: Object.fromEntries(Object.entries(this.raw).map(([k, ts]) => [k, ts.map(t => t.map(([x, y]) => [r(x), r(y)]))])) });
  }
  get trained() { return Object.fromEntries(Object.entries(this.raw).filter(([, v]) => v.length).map(([k, v]) => [k, v.length])); }
  add(key, points) {
    const ts = (this.raw[key] = [...(this.raw[key] || []), points].slice(-MAX_TEMPLATES));
    this.prepared[key] = ts.map(normalise).filter(Boolean); this.save(); return ts.length;
  }
  forget(key) { delete this.raw[key]; delete this.prepared[key]; this.save(); }
  match(points) {
    const shape = normalise(points);
    const ranked = Object.entries(this.prepared).filter(([, ts]) => ts.length)
      .map(([k, ts]) => [Math.min(...ts.map(t => score(shape, t))), k]).sort((a, b) => a[0] - b[0]);
    if (!shape || !ranked.length) return { key: null, closest: null, score: null };
    const [top, key] = ranked[0], runner = ranked[1] ? ranked[1][0] : Infinity;
    const ok = top < ACCEPT_SCORE && runner >= top * MARGIN;
    return { key: ok ? key : null, closest: key, score: Math.round(top * 1000) / 1000 };
  }
}
