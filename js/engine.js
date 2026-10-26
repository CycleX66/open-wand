// Runs Open Wand entirely in the browser: Web Bluetooth to the wand, recognition, training and
// smart-home calls. Replaces the Mac bridge; request() answers the same /api/... routes it did,
// and on() delivers the same live messages its WebSocket sent.
import * as P from './protocol.js';
import { Matcher, Tracker, tipAxisFromStill } from './recognition.js';

const FIRMWARE_OVERLAP_MS = 3000; // the wand's own verdict arrives 1-3 s after ours for the same movement
const MIN_TRAINING_S = 0.5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const localStore = key => ({
  load() { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  save(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} },
});

function thin(points, n = 60) {
  const step = Math.max(1, Math.floor(points.length / n));
  return [...points.filter((_, i) => i % step === 0), points[points.length - 1]].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export class Engine {
  constructor(spellbook) {
    this.spellbook = spellbook; // key -> spell
    this.listeners = new Set();
    this.matcher = new Matcher(localStore('ow.templates'));
    this.tracker = new Tracker(this.matcher.tipAxis || undefined);
    this.smartConfig = localStore('ow.smarthome');
    this.state = { connected: false, device: null, firmware: null, battery: null, buttons: [false, false, false, false], lastSpell: null, reconnecting: false };
    this.device = null; this.cmd = null; this.writes = Promise.resolve();
    this.manualDisconnect = false; this.training = null; this.calibration = null;
    this.lastMatch = 0; this.lastTrail = 0; this.wakeLock = null;
    this.supported = !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.state.connected) this.keepAwake(); });
  }

  on(fn) { this.listeners.add(fn); }
  emit(msg) { this.listeners.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } }); }
  emitStatus() { this.emit({ type: 'status', state: { ...this.state } }); }

  // ── Bluetooth ──
  async choose() {
    if (!this.supported) throw new Error('This browser has no Bluetooth. On iPad, open this page in the Bluefy app.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: P.WAND_NAME_PREFIX }], optionalServices: [P.SERVICE_UUID, P.BATTERY_SERVICE],
    });
    await this.attach(device);
  }

  // After a reload, browsers that remember permission can reconnect without the picker.
  async resume() {
    if (!this.supported || !navigator.bluetooth.getDevices) return false;
    const devices = (await navigator.bluetooth.getDevices()).filter(d => (d.name || '').startsWith(P.WAND_NAME_PREFIX));
    if (!devices.length) return false;
    this.device = devices[0];
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    this.reconnectLoop();
    return true;
  }

  async attach(device) {
    if (this.device && this.device !== device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.device = device; this.manualDisconnect = false;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    await this.open();
  }

  async open() {
    try { await this.openSteps(); }
    catch (e) { this.note(`Connection failed: ${e.message}`); throw e; }
  }

  async openSteps() {
    this.note(`Connecting to ${this.device.name}…`);
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(P.SERVICE_UUID);
    this.cmd = await svc.getCharacteristic(P.COMMAND_UUID);
    const p = this.cmd.properties || {};
    this.note(`Wand service found. Command supports: ${['write', 'writeWithoutResponse'].filter(k => p[k]).join(', ') || 'unknown'}`);
    const notify = await svc.getCharacteristic(P.NOTIFY_UUID);
    notify.addEventListener('characteristicvaluechanged', e => this.handle(e.target.value));
    await notify.startNotifications();
    this.note('Listening to the wand');
    try {
      const bat = await (await server.getPrimaryService(P.BATTERY_SERVICE)).getCharacteristic(P.BATTERY_LEVEL);
      bat.addEventListener('characteristicvaluechanged', e => this.setBattery(e.target.value.getUint8(0)));
      await bat.startNotifications().catch(() => {});
      this.setBattery((await bat.readValue()).getUint8(0));
    } catch { /* battery is optional */ }
    for (const c of P.HW_INIT) { await this.send(c); await sleep(P.HW_INIT_GAP_MS); }
    this.note('Start-up sequence sent');
    await this.send(P.IMU_STOP); await sleep(100); await this.send(P.IMU_START);
    Object.assign(this.state, { connected: true, reconnecting: false, device: this.device.name });
    this.emitStatus();
    this.keepAwake();
    await this.play(P.successEffect());
    this.note('Connected. Welcome glow sent');
    this.imuSeen = 0;
    setTimeout(() => this.note(this.imuSeen ? `Motion data arriving (${this.imuSeen} packets)` : 'No motion data from the wand yet'), 3000);
  }

  onDisconnected() {
    this.note('Wand disconnected');
    this.cmd = null; this.tracker.recording = false;
    Object.assign(this.state, { connected: false, reconnecting: !this.manualDisconnect });
    this.emitStatus();
    if (!this.manualDisconnect) this.reconnectLoop();
  }

  async reconnectLoop() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (let wait = 1000; !this.manualDisconnect && this.device && !this.state.connected; wait = Math.min(wait * 1.5, 8000)) {
      try { await this.open(); } catch { await sleep(wait); } // wand asleep or out of range: keep trying
    }
    this.reconnecting = false;
  }

  async disconnect() {
    this.manualDisconnect = true;
    if (this.device && this.device.gatt.connected) { await this.send(P.LIGHTS_OFF).catch(() => {}); this.device.gatt.disconnect(); }
    Object.assign(this.state, { connected: false, reconnecting: false }); this.emitStatus();
    this.wakeLock?.release?.().catch(() => {}); this.wakeLock = null;
  }

  async keepAwake() { // the iPad sleeping cuts Bluetooth
    try { if (navigator.wakeLock && !this.wakeLock) { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } } catch {}
  }

  // Connection steps and errors, shown on the Wand connection screen for troubleshooting.
  note(text) {
    const line = `${new Date().toLocaleTimeString()} ${text}`;
    this.log = [...(this.log || []), line].slice(-40);
    this.emit({ type: 'log', lines: this.log });
  }

  send(bytes) {
    if (!this.cmd) return Promise.reject(new HttpError(409, 'No wand connected'));
    const cmd = this.cmd;
    this.writes = this.writes.catch(() => {}).then(() => this.write(cmd, bytes));
    return this.writes;
  }

  // Browsers differ: use write-without-response when it works, otherwise fall back to a plain write.
  async write(cmd, bytes) {
    if (this.writeMode !== 'plain' && cmd.writeValueWithoutResponse) {
      try { return await cmd.writeValueWithoutResponse(bytes); }
      catch (e) { this.note(`Quick write failed (${e.message}); switching to normal writes`); this.writeMode = 'plain'; }
    }
    try { return await (cmd.writeValueWithResponse ? cmd.writeValueWithResponse(bytes) : cmd.writeValue(bytes)); }
    catch (e) { this.note(`Write failed: ${e.message}`); throw e; }
  }

  // 0x60 flushes whatever the wand is playing, so it goes once per effect, never between its frames.
  async play(effect) {
    await this.send(P.EFFECT_PREFIX);
    for (const frame of effect.frames(20)) await this.send(frame);
  }

  setBattery(level) { this.state.battery = level; this.emitStatus(); }

  handle(dataView) {
    const ev = P.parseNotification(new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength));
    if (ev.kind === 'keepalive') { this.send(P.KEEPALIVE_REPLY).catch(() => {}); return; } // unanswered, the wand drops the link
    if (ev.kind === 'imu') {
      this.imuSeen = (this.imuSeen || 0) + 1;
      for (const s of ev.samples) {
        if (this.calibration) this.calibration.push(s.slice(3, 6));
        const g = this.tracker.feed(s);
        if (g) this.onGesture(g);
      }
      const now = Date.now();
      if (this.tracker.recording && now - this.lastTrail > 80) { this.lastTrail = now; this.emit({ type: 'trail', points: thin(this.tracker.livePoints()) }); }
    } else if (ev.kind === 'buttons') {
      this.tracker.padsHeld = ev.pressed.some(Boolean); this.state.buttons = ev.pressed;
      this.emit({ type: 'buttons', pressed: ev.pressed });
    } else if (ev.kind === 'spell') {
      const ours = ev.key in this.matcher.trained || Date.now() - this.lastMatch < FIRMWARE_OVERLAP_MS;
      if (!ours) this.castSpell(ev.key, ev.display, 'wand');
    } else if (ev.kind === 'firmware') {
      this.state.firmware = ev.version;
    }
  }

  async onGesture(g) {
    const path = thin(g.points);
    if (this.training) {
      if (g.durationS < MIN_TRAINING_S || !g.gripped) return;
      const count = this.matcher.add(this.training, g.points);
      this.emit({ type: 'trained', key: this.training, count, path });
      this.play(new P.Effect().buzz(90).led(P.LedGroup.TIP, '#ffffff', 120).delay(250).led(P.LedGroup.TIP, '#000000', 300)).catch(() => {});
      return;
    }
    if (!g.gripped) return;
    const m = this.matcher.match(g.points);
    if (m.key) { this.lastMatch = Date.now(); await this.castSpell(m.key, this.spellbook[m.key]?.name || m.key, 'openwand', path, m.score); }
    else if (Object.keys(this.matcher.trained).length) this.emit({ type: 'miss', closest: this.spellbook[m.closest]?.name || m.closest, score: m.score, path });
  }

  async castSpell(key, name, source, path = null, score = null) {
    const spell = this.spellbook[key];
    this.state.lastSpell = name;
    let wandEffect = false;
    if (this.state.connected) {
      try { await this.play(spell ? P.effectFor(spell.effect, spell.colour) : P.successEffect()); wandEffect = true; } catch {}
    }
    const actions = await this.runSmartHome(key);
    const event = { type: 'spell', key, name, known: !!spell, colour: spell ? spell.colour : '#ffe08a', source, wandEffect, actions, path, score, timestamp: Date.now() / 1000 };
    this.emit(event);
    return event;
  }

  // ── Smart home: only https addresses work from an https page (browsers block http from it) ──
  smartHome() { return this.smartConfig.load() || {}; }
  smartSummary() {
    const d = a => a.type === 'home_assistant' ? `Home Assistant ${a.service} ${a.data?.entity_id || ''}`.trim() : a.type === 'webhook' ? `Webhook ${a.method || 'POST'} ${a.url}` : String(a.type);
    return Object.fromEntries(Object.entries(this.smartHome().spells || {}).map(([k, as]) => [k, as.map(d)]));
  }
  async runSmartHome(key) {
    const cfg = this.smartHome(), results = [];
    for (const a of (cfg.spells || {})[key] || []) {
      const label = this.smartSummary()[key]?.[results.length] || a.type;
      try {
        let r;
        if (a.type === 'home_assistant') {
          const [domain, service] = a.service.split('.');
          r = await fetch(`${cfg.home_assistant.url.replace(/\/$/, '')}/api/services/${domain}/${service}`, {
            method: 'POST', headers: { Authorization: `Bearer ${cfg.home_assistant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(a.data || {}) });
        } else if (a.type === 'webhook') {
          r = await fetch(a.url, { method: a.method || 'POST', headers: a.json ? { 'Content-Type': 'application/json' } : {}, body: a.json ? JSON.stringify(a.json) : undefined });
        } else throw new Error('Unknown action type');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        results.push({ action: label, ok: true });
      } catch (e) { results.push({ action: label, ok: false, error: String(e.message || e).slice(0, 200) }); }
    }
    return results;
  }

  // ── The bridge's API, answered locally ──
  async request(path, method = 'GET', body) {
    const m = (re) => path.match(re);
    let x;
    if (path === '/api/status') return { ...this.state, smartHome: this.smartSummary() };
    if (path === '/api/disconnect') { await this.disconnect(); return { ...this.state }; }
    if ((x = m(/^\/api\/cast\/(.+)$/))) {
      const key = decodeURIComponent(x[1]);
      if (!this.spellbook[key]) throw new HttpError(404, 'Unknown spell');
      return this.castSpell(key, this.spellbook[key].name, 'app');
    }
    if (path === '/api/lights') {
      if (!this.state.connected) throw new HttpError(409, 'No wand connected');
      const e = new P.Effect(), colour = '#' + body.colour.replace(/^#/, '');
      body.group != null ? e.led(body.group, colour, body.fade_ms ?? 300) : e.allLeds(colour, body.fade_ms ?? 300);
      await this.play(e); return { ok: true };
    }
    if (path === '/api/lights/off') { await this.send(P.LIGHTS_OFF); return { ok: true }; }
    if (path === '/api/buzz') { await this.play(new P.Effect().buzz(body?.ms ?? 300)); return { ok: true }; }
    if (path === '/api/training') return { trained: this.matcher.trained, training: this.training, tipAxis: this.matcher.tipAxis };
    if (path === '/api/train/stop') { this.training = null; return { trained: this.matcher.trained }; }
    if ((x = m(/^\/api\/train\/(.+)$/))) {
      const key = decodeURIComponent(x[1]);
      if (method === 'DELETE') { this.matcher.forget(key); return { trained: this.matcher.trained }; }
      if (!this.spellbook[key]) throw new HttpError(404, 'Unknown spell');
      this.training = key; return { training: key, count: this.matcher.trained[key] || 0 };
    }
    if (path === '/api/calibrate') {
      if (!this.state.connected) throw new HttpError(409, 'No wand connected');
      this.calibration = []; await sleep(1500);
      const samples = this.calibration; this.calibration = null;
      const axis = tipAxisFromStill(samples);
      if (!axis) throw new HttpError(422, samples.length ? 'Hold the wand still with the tip pointing straight up, then try again' : 'No motion data from the wand');
      this.matcher.tipAxis = axis; this.matcher.save(); this.tracker.tipAxis = axis;
      this.play(P.successEffect()).catch(() => {});
      return { tipAxis: axis };
    }
    if (path === '/api/smarthome') {
      if (method === 'POST') this.smartConfig.save(body);
      return this.smartHome();
    }
    throw new HttpError(404, 'Not found');
  }
}
