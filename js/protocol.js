// Magic Caster Wand BLE protocol: bytes only, no I/O. Mirrors bridge/openwand/protocol.py.
// Sources: OpenCaster docs/protocol.md and hass-magic-caster-wand (MIT). Factory-unlock and
// calibration opcodes are deliberately left out.

export const WAND_NAME_PREFIX = 'MCW';
export const SERVICE_UUID = '57420001-587e-48a0-974c-544d6163c577';
export const COMMAND_UUID = '57420002-587e-48a0-974c-544d6163c577';
export const NOTIFY_UUID = '57420003-587e-48a0-974c-544d6163c577';
export const BATTERY_SERVICE = 'battery_service';
export const BATTERY_LEVEL = 'battery_level';

export const KEEPALIVE_REPLY = Uint8Array.of(0x01);
export const IMU_START = Uint8Array.of(0x30, 0x00, 0x80);
export const IMU_STOP = Uint8Array.of(0x31);
export const LIGHTS_OFF = Uint8Array.of(0x40);
export const EFFECT_PREFIX = Uint8Array.of(0x60);
const FRAME_START = 0x68, OP_DELAY = 0x10, OP_CHANGE_LED = 0x22, OP_BUZZ = 0x50;
export const MIN_FADE_MS = 80; // below ~80 ms the wand (firmware 0.3) shows white instead of the colour
const LED_GAMMA = 2.2;

// Sent once per connection, ~40 ms apart; without it the vibration motor stays silent.
export const HW_INIT = [
  [0x00], [0x08], [0x09], [0x0e, 0x02], [0x0e, 0x04], [0x0e, 0x08], [0x0e, 0x09], [0x0e, 0x01],
  [0xdd, 0x00], [0xdd, 0x04], [0xdd, 0x01], [0xdd, 0x05], [0xdd, 0x02], [0xdd, 0x06], [0xdd, 0x03], [0xdd, 0x07],
  [0xdc, 0x00, 0x07], [0xdc, 0x04, 0x0a], [0xdc, 0x01, 0x07], [0xdc, 0x05, 0x0a],
  [0xdc, 0x02, 0x07], [0xdc, 0x06, 0x0a], [0xdc, 0x03, 0x07], [0xdc, 0x07, 0x0a],
  [0xdd, 0x00], [0xdd, 0x04], [0xdd, 0x01], [0xdd, 0x05], [0xdd, 0x02], [0xdd, 0x06], [0xdd, 0x03], [0xdd, 0x07],
].map(c => Uint8Array.from(c));
export const HW_INIT_GAP_MS = 40;

export const LedGroup = { TIP: 0, MID_UPPER: 1, MID_LOWER: 2, POMMEL: 3 };
const GROUPS = [0, 1, 2, 3];
const ACCEL_G = 1 / 2048, GYRO_RAD_S = 0.0010908308;

const u16 = v => { v = Math.max(0, Math.min(Math.round(v), 0xffff)); return [v & 0xff, v >> 8]; };

export function parseHex(colour) {
  const c = colour.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(c)) throw new Error(`Colour must be #RRGGBB, got ${colour}`);
  return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
}

// Screen colours to LED brightness: LEDs are linear, so small tinting channels would show too strongly.
export const toLed = ch => Math.round(255 * (ch / 255) ** LED_GAMMA);

export class Effect {
  constructor() { this.steps = []; }
  led(group, colour, fadeMs = 0) {
    const [r, g, b] = parseHex(colour).map(toLed);
    this.steps.push([OP_CHANGE_LED, group, r, g, b, ...u16(Math.max(fadeMs, MIN_FADE_MS))]);
    return this;
  }
  allLeds(colour, fadeMs = 0) { GROUPS.forEach(g => this.led(g, colour, fadeMs)); return this; }
  delay(ms) { this.steps.push([OP_DELAY, ...u16(ms)]); return this; }
  buzz(ms) { this.steps.push([OP_BUZZ, ...u16(Math.min(ms, 32767))]); return this; }
  // Split into 0x68 frames no longer than maxLen, breaking only between commands.
  frames(maxLen = 20) {
    const out = []; let cur = [FRAME_START];
    for (const step of this.steps) {
      if (cur.length + step.length > maxLen && cur.length > 1) { out.push(Uint8Array.from(cur)); cur = [FRAME_START]; }
      cur.push(...step);
    }
    if (cur.length > 1) out.push(Uint8Array.from(cur));
    return out;
  }
}

// Notifications → plain objects: {kind: 'keepalive' | 'buttons' | 'spell' | 'imu' | 'firmware' | 'other', ...}
export function parseNotification(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  if (!d.length) return { kind: 'other', hex: '' };
  const op = d[0], view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if ((op === 0x01 || op === 0x02) && d.length <= 3) return { kind: 'keepalive' };
  if (op === 0x10 && d.length >= 2) return { kind: 'buttons', pressed: [0, 1, 2, 3].map(i => !!(d[1] & (1 << i))) };
  if (op === 0x24 && d.length >= 5) {
    const name = new TextDecoder().decode(d.slice(4, 4 + d[3])).replace(/\0/g, '').trim();
    if (name) return { kind: 'spell', name, key: name.toLowerCase().replace(/ /g, '_'), display: name.replace(/_/g, ' ') };
  }
  if (op === 0x2c && d.length >= 4) {
    const count = d[3];
    if (d.length >= 4 + 12 * count) {
      const samples = [];
      for (let i = 0; i < count; i++) {
        const o = 4 + 12 * i, s = k => view.getInt16(o + 2 * k, true);
        samples.push([s(0) * GYRO_RAD_S, s(1) * GYRO_RAD_S, s(2) * GYRO_RAD_S, s(3) * ACCEL_G, s(4) * ACCEL_G, s(5) * ACCEL_G]);
      }
      return { kind: 'imu', seq: view.getUint16(1, true), samples };
    }
  }
  if (op === 0x00 && d.length >= 2) return { kind: 'firmware', version: [...d.slice(1)].join('.') };
  return { kind: 'other', hex: [...d].map(b => b.toString(16).padStart(2, '0')).join('') };
}

// ── Spell light patterns (mirrors bridge/openwand/effects.py) ──
const dim = (colour, f) => '#' + parseHex(colour).map(c => Math.floor(c * f).toString(16).padStart(2, '0')).join('');

export function effectFor(style, colour) {
  const e = new Effect(), { TIP, MID_UPPER, MID_LOWER, POMMEL } = LedGroup;
  switch (style) {
    case 'glow': e.buzz(150).led(TIP, colour, 400).led(MID_UPPER, dim(colour, 0.5), 600).delay(2500); break;
    case 'fade': e.buzz(100).allLeds(dim(colour, 0.3), 300).delay(400).allLeds('#000000', 900).delay(900); break;
    case 'flash': e.buzz(300).allLeds(colour, 0).delay(120).allLeds('#000000', 0).delay(80).allLeds(colour, 0).delay(500); break;
    case 'flicker':
      e.buzz(250);
      for (const s of [1, 0.55, 0.9, 0.4, 1, 0.6]) e.led(TIP, dim(colour, s), 90).led(MID_UPPER, dim(colour, s * 0.6), 90).delay(110);
      break;
    case 'rise': e.buzz(120); for (const g of [POMMEL, MID_LOWER, MID_UPPER, TIP]) e.led(g, colour, 200).delay(180); e.delay(800); break;
    case 'drop': e.buzz(120); for (const g of [TIP, MID_UPPER, MID_LOWER, POMMEL]) e.led(g, colour, 200).delay(180); e.delay(800); break;
    case 'sweep': e.buzz(150); for (const g of GROUPS) e.led(g, colour, 150).delay(120).led(g, '#000000', 300); e.led(TIP, colour, 300).delay(900); break;
    case 'pull': e.buzz(200).allLeds(dim(colour, 0.25), 0).led(TIP, colour, 500).delay(1200); break;
    case 'rainbow': e.buzz(150); for (const c of ['#ff3b4e', '#ff9b2f', '#ffe14a', '#54d36a', '#42aaff', '#b05cff']) e.allLeds(c, 150).delay(200); break;
    default: e.buzz(200); for (let i = 0; i < 2; i++) e.allLeds(colour, 250).delay(300).allLeds(dim(colour, 0.15), 250).delay(300); e.allLeds(colour, 250).delay(800);
  }
  return e.allLeds('#000000', 600);
}

export const successEffect = () => new Effect().buzz(120).delay(150).buzz(120).led(LedGroup.TIP, '#ffe08a', 200).delay(600).allLeds('#000000', 400);
