// Physics accuracy: mods written against the mod API, simulated by Box3D,
// compared with textbook results. Skips if physics/physics_server isn't built.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../src/room.js';
import { PHYSICS_BIN } from '../src/physics.js';

if (!fs.existsSync(PHYSICS_BIN) || process.env.PHYSICS === 'simple') {
  console.log('skip physics accuracy tests (Box3D not built: npm run build:physics)');
  process.exit(0);
}

let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${detail}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const g = 9.8;

// a room with one connected (fake) player far away, so the world ticks
// build(code) installs mod code directly (prompts are capped at 240 chars, code isn't)
function makeRoom(name) {
  let next = '';
  const room = new Room(name, {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'phys-')),
    generate: async (p, ctx, tryInstall) => { const e = tryInstall(next); if (e) throw new Error(e); return next; },
  });
  room.build = (client, code) => { next = code; return room.requestMod(client, name); };
  const c = room.join({ readyState: 1, send() {} }, 'observer');
  room.handle(c, { t: 'state', p: [200, 0, 200], look: [0, 0, -1], ry: 0 });
  return { room, c };
}
const ent = (room, name) => [...room.entities.values()].find(e => e.name === name);
// sample an entity's y over time (real-time 20 Hz ticks)
async function trace(room, name, seconds) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const e = ent(room, name);
    if (e) out.push([(Date.now() - t0) / 1000, [...e.position], [...(e.velocity || [0, 0, 0])]]);
    await sleep(10);
  }
  return out;
}

// 1. free fall + 2. bounce heights from restitution (h' = e² h)
{
  const { room, c } = makeRoom('fall');
  await room.build(c, `
    world.spawn({ name: 'steel', physics: 'dynamic', material: 'steel', position: [0, 5.25, 0], parts: [{ shape: 'sphere', size: [0.5, 0.5, 0.5] }] });
    world.spawn({ name: 'rubber', physics: 'dynamic', material: 'rubber', position: [4, 2.25, 0], parts: [{ shape: 'sphere', size: [0.5, 0.5, 0.5] }] });`);
  const steel = trace(room, 'steel', 1.6);
  const rubber = await trace(room, 'rubber', 2.0);
  const s = await steel;
  // first sample moving up again = the bounce
  const up = s.findIndex(([, , v], i) => i > 0 && v[1] > 0 && s[i - 1][2][1] < -1);
  // total fall time from one mid-air snapshot (height y, velocity v): time already fallen |v|/g plus
  // time left to reach the ground, solved exactly with gravity: sqrt(v² + 2g·d)/g in total. Independent
  // of sample rate and of the delay between building the mod and the first physics step.
  const [, pm, vm] = s.find(([, p, v]) => p[1] < 4 && p[1] > 1.5 && v[1] < 0) || [0, [0, NaN, 0], [0, 0, 0]];
  const fall = Math.sqrt(vm[1] * vm[1] + 2 * g * (pm[1] - 0.25)) / g;
  const theory = Math.sqrt((2 * 5) / g);
  check('free fall 5 m', Math.abs(fall - theory) < 0.03, `fall time ${fall.toFixed(3)} s (from mid-air state), theory √(2h/g) = ${theory.toFixed(3)} s`);
  const steelPeak = Math.max(...s.slice(up).map(([, p]) => p[1] - 0.25));
  check('steel rebound (e=0.3, from 5 m)', Math.abs(steelPeak - 0.45) < 0.12, `peak ${steelPeak.toFixed(2)} m, theory e²h = 0.45 m`);
  // rebound peak after the first impact
  const firstLand = rubber.findIndex(([, p]) => p[1] <= 0.27);
  const peak = Math.max(...rubber.slice(firstLand).map(([, p]) => p[1] - 0.25));
  const expect = 0.8 * 0.8 * 2;
  check('rubber rebound (e=0.8, from 2 m)', Math.abs(peak - expect) < 0.35, `peak ${peak.toFixed(2)} m, theory e²h = ${expect.toFixed(2)} m`);
  room.close();
}

// 3. momentum: impulse J on mass m gives Δv = J / m
{
  const { room, c } = makeRoom('impulse');
  await room.build(c, `
    const b = world.spawn({ name: 'puck', physics: 'dynamic', material: 'ice', mass: 2, position: [0, 0.1, 0], parts: [{ shape: 'cylinder', size: [0.6, 0.2, 0.6] }] });
    let done = false;
    world.onTick(() => { if (!done) { done = true; world.impulse(b, [10, 0, 0]); } });`);
  const tr = await trace(room, 'puck', 0.4);
  const v = Math.max(...tr.map(([, , v]) => v[0]));
  check('impulse 10 N·s on 2 kg puck', Math.abs(v - 5) < 0.2, `peak vx ${v.toFixed(2)} m/s, theory J/m = 5.00 m/s`);
  const late = tr.at(-1)[2][0];
  check('ice still slides (μ≈0.15 vs asphalt)', late > 3.5 && late < v, `vx after 0.4 s: ${late.toFixed(2)} m/s`);
  room.close();
}

// 4. pendulum period T = 2π √(L/g) (small swing, point-like bob)
{
  const { room, c } = makeRoom('pendulum');
  const L = 2, a0 = 0.15;
  await room.build(c, `
    const L = ${L}, a = ${a0};
    const bob = world.spawn({ name: 'bob', physics: 'dynamic', material: 'steel', position: [L * Math.sin(a), 5 - L * Math.cos(a), 0], parts: [{ shape: 'sphere', size: [0.1, 0.1, 0.1] }] });
    world.hinge(bob, null, { anchor: [0, 5, 0], axis: [0, 0, 1] });`);
  const tr = await trace(room, 'bob', 4.2);
  // consecutive crossings of x = 0 are half a period apart (interpolated between samples)
  const cross = [];
  for (let i = 1; i < tr.length; i++) {
    const [t0, a] = tr[i - 1], [t1, b] = tr[i];
    if ((a[0] > 0) !== (b[0] > 0)) cross.push(t0 + (t1 - t0) * (a[0] / (a[0] - b[0])));
  }
  const T = cross.length >= 3 ? cross[2] - cross[0] : NaN;
  const theory = 2 * Math.PI * Math.sqrt(L / g);
  check('pendulum period (L = 2 m)', Math.abs(T - theory) < 0.12, `measured ${T.toFixed(2)} s, theory ${theory.toFixed(2)} s`);
  room.close();
}

// 4b. the same pendulum written the way qwen2.5:3b writes joints: by name, 'ground' for the world,
//     anchorA for the pivot, no stored id. It must hang and swing just the same.
{
  const { room, c } = makeRoom('pendulum3b');
  const L = 2, a0 = 0.15;
  await room.build(c, `
    world.spawn({ name: 'pendulum', physics: 'dynamic', material: 'steel', position: [${L * Math.sin(a0)}, ${5 - L * Math.cos(a0)}, 0], parts: [{ shape: 'sphere', size: [0.1, 0.1, 0.1] }] });
    world.hinge('pendulum', 'ground', { anchorA: [0, 5, 0], axis: [0, 0, 1] });`);
  const tr = await trace(room, 'pendulum', 4.2);
  const cross = [];
  for (let i = 1; i < tr.length; i++) {
    const [t0, a] = tr[i - 1], [t1, b] = tr[i];
    if ((a[0] > 0) !== (b[0] > 0)) cross.push(t0 + (t1 - t0) * (a[0] / (a[0] - b[0])));
  }
  const T = cross.length >= 3 ? cross[2] - cross[0] : NaN;
  const theory = 2 * Math.PI * Math.sqrt(L / g);
  check('pendulum written by name swings', Math.abs(T - theory) < 0.12, `measured ${T.toFixed(2)} s, theory ${theory.toFixed(2)} s`);
  room.close();
}

// 5. motor hinge holds its speed; 6. players push things; 7. moved platforms don't drift
{
  const { room, c } = makeRoom('motors');
  await room.build(c, `
    const wheel = world.spawn({ name: 'wheel', physics: 'dynamic', material: 'wood', position: [0, 2, 0], parts: [{ shape: 'cylinder', size: [1, 0.2, 1], rotation: [1.5708, 0, 0] }] });
    world.hinge(wheel, null, { anchor: [0, 2, 0], axis: [0, 0, 1], motorSpeed: 3, maxTorque: 500 });
    world.spawn({ name: 'ball', physics: 'dynamic', material: 'rubber', position: [20, 0.3, 0], parts: [{ shape: 'sphere', size: [0.6, 0.6, 0.6] }] });
    const plat = world.spawn({ name: 'platform', position: [40, 1, 0], parts: [{ shape: 'box', size: [3, 0.3, 3] }] });
    let n = 0;
    world.onTick(() => { if (n++ < 10) world.move(plat, [40 + n * 0.2, 1, 0]); });`);
  const before = [...ent(room, 'ball').position];
  // the observer walks through the ball
  for (let i = 0; i <= 20; i++) { room.handle(c, { t: 'state', p: [18.5 + i * 0.15, 0, 0], look: [1, 0, 0], ry: 0 }); await sleep(50); }
  await sleep(600);
  const after = ent(room, 'ball').position;
  check('walking into a ball pushes it', after[0] - before[0] > 0.5, `ball moved ${(after[0] - before[0]).toFixed(2)} m`);
  const turned = ent(room, 'wheel').rotation;
  check('motor hinge turns the wheel', ent(room, 'wheel').quat != null, `wheel orientation ${turned.map(v => v.toFixed(2)).join(', ')}`);
  const p1 = ent(room, 'platform').position[0];
  await sleep(500);
  const p2 = ent(room, 'platform').position[0];
  check('moved platform stops when the mod stops', Math.abs(p2 - p1) < 0.01 && Math.abs(p1 - 42) < 0.05, `x ${p1.toFixed(2)} → ${p2.toFixed(2)} (target 42.00)`);
  room.close();
}

// 8. onHit reports impact speed (from 3.2 m: v = √(2gh) ≈ 7.9 m/s)
{
  const { room, c } = makeRoom('hits');
  await room.build(c, `
    const rock = world.spawn({ name: 'rock', physics: 'dynamic', material: 'stone', position: [0, 3.45, 0], parts: [{ shape: 'box', size: [0.5, 0.5, 0.5] }] });
    world.onHit(rock, (other, speed) => { if (other === 'ground') world.broadcast('hit ' + speed); });`);
  const msgs = [];
  [...room.clients.values()][0].ws.send = s => { const m = JSON.parse(s); if (m.t === 'msg' && /^hit /.test(m.text)) msgs.push(+m.text.slice(4)); };
  await sleep(1400);
  const theory = Math.sqrt(2 * g * 3.2);
  check('onHit impact speed', msgs.length > 0 && Math.abs(msgs[0] - theory) < 0.6, `reported ${msgs[0]?.toFixed(2)} m/s, theory ${theory.toFixed(2)} m/s`);
  room.close();
}

process.exit(fail ? 1 : 0);
