// Checks the iPad (JavaScript) version against the Mac bridge (Python), which was tested on a real wand.
// Run: node --test ipad/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../js/protocol.js';
import { Tracker, Matcher, tipAxisFromStill, SAMPLE_PERIOD_S } from '../js/recognition.js';

const here = new URL('.', import.meta.url);
const python = JSON.parse(readFileSync(new URL('python-effects.json', here)));
const book = JSON.parse(readFileSync(new URL('../spells.json', here))).spells;
const hex = frames => frames.map(f => Buffer.from(f).toString('hex'));

test('every spell effect sends the same bytes as the Mac bridge', () => {
  for (const s of book) assert.deepEqual(hex(P.effectFor(s.effect, s.colour).frames(20)), python[s.key], s.key);
  assert.deepEqual(hex(P.successEffect().frames(20)), python._success);
  assert.deepEqual(hex(new P.Effect().allLeds('#ff3b4e', 300).frames(20)), python._red_swatch);
});

test('notifications parse like the Mac bridge', () => {
  const spell = P.parseNotification(Buffer.from('2400000750726f7465676f', 'hex'));
  assert.equal(spell.kind, 'spell'); assert.equal(spell.key, 'protego');
  assert.equal(P.parseNotification(Uint8Array.of(0x01)).kind, 'keepalive');
  assert.deepEqual(P.parseNotification(Uint8Array.of(0x10, 0x05)).pressed, [true, false, true, false]);
  const imu = new Uint8Array(16); imu.set([0x2c, 1, 0, 1]); new DataView(imu.buffer).setInt16(12, 2048, true);
  assert.equal(P.parseNotification(imu).samples[0][4], 1);
});

// ── Recognition, same synthetic movements as bridge/tests/test_recognition.py ──
const HZ = 1 / SAMPLE_PERIOD_S, LEVEL = [0, 0, 1];
const still = s => Array(Math.floor(s * HZ)).fill([0, 0, 0, ...LEVEL]);
// Tip along +X here (as in the Python tests): right is -gz, up is -gy.
const turn = (s, right = 0, up = 0) => Array(Math.floor(s * HZ)).fill([0, -up, -right, 0, 0, 0]);
const run = samples => { const t = new Tracker([1, 0, 0]); t.padsHeld = true; return samples.map(s => t.feed(s)).filter(Boolean); };
const lumos = () => [...still(0.3), ...turn(0.35, 3, 4), ...turn(0.35, 3, -4), ...still(0.6)];
const expelliarmus = () => [...still(0.3), ...turn(0.4, 4), ...turn(0.4, 0, -4), ...still(0.6)];
const memory = () => { let v = null; return { load: () => v, save: x => { v = JSON.parse(JSON.stringify(x)); } }; };

test('still wand is not a gesture; Lumos traces up then down to the right', () => {
  assert.equal(run(still(2)).length, 0);
  const [g] = run(lumos()), ys = g.points.map(p => p[1]), peak = ys.indexOf(Math.max(...ys));
  assert.ok(g.points.at(-1)[0] > g.points[0][0] + 40);
  assert.ok(ys[peak] > 40 && ys.at(-1) < ys[peak] - 40);
});

test('trained spells are told apart and kept', () => {
  const store = memory(), m = new Matcher(store);
  m.add('lumos', run(lumos())[0].points); m.add('expelliarmus', run(expelliarmus())[0].points);
  assert.equal(m.match(run(lumos())[0].points).key, 'lumos');
  assert.equal(m.match(run(expelliarmus())[0].points).key, 'expelliarmus');
  assert.deepEqual(new Matcher(store).trained, { lumos: 1, expelliarmus: 1 });
});

test('calibration finds the tip axis', () => {
  assert.deepEqual(tipAxisFromStill(Array(100).fill([0.02, 0.98, 0.05])), [0, 1, 0]);
  assert.equal(tipAxisFromStill(Array(100).fill([0.6, 0, 0.7])), null);
});
