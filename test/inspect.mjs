// Inspect a saved mod: show its code, what it spawned, its joints, and 3 s of physics.
// usage: node test/inspect.mjs <room> [part of the prompt]      (default: the room's latest mod)
//        node test/inspect.mjs lobby pendulum
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModSandbox } from '../src/sandbox.js';
import { Room } from '../src/room.js';

const [room = 'lobby', match = ''] = process.argv.slice(2);
const file = path.join('data', 'rooms', `${room}.json`);
if (!fs.existsSync(file)) { console.log(`no saved mods for room "${room}" (${file})`); process.exit(1); }
const mods = JSON.parse(fs.readFileSync(file, 'utf8')).mods;
const mod = [...mods].reverse().find(m => m.prompt.toLowerCase().includes(match.toLowerCase()));
if (!mod) { console.log(`no mod matching "${match}". saved: ${mods.map(m => `"${m.prompt}"`).join(', ')}`); process.exit(1); }

const r2 = v => (Array.isArray(v) ? `[${v.map(n => (+n).toFixed(2)).join(', ')}]` : v);
console.log(`=== "${mod.prompt}" (room ${room}, built at here = ${r2(mod.here)}) ===\n`);
mod.code.split('\n').forEach((l, i) => console.log(String(i + 1).padStart(3), l));

// 1. what the code asked for (raw ops from the sandbox)
const sb = new ModSandbox('inspect', { here: mod.here, author: mod.author });
let ops;
try { ops = sb.load(mod.code); } catch (e) {
  console.log(`\n=== rejected ===\nThis code no longer loads, so the model would be asked to fix it:\n  ${e.message}`);
  sb.dispose();
  process.exit(0);
}
sb.dispose();
const notes = [];
const spawns = new Map();
console.log('\n=== what it builds ===');
for (const o of ops) {
  if (o.op === 'spawn') {
    let lo = Infinity, hi = -Infinity;
    for (const p of o.parts) { const oy = (p.offset || [0, 0, 0])[1], sy = (p.size || [1, 1, 1])[1]; lo = Math.min(lo, oy - sy / 2); hi = Math.max(hi, oy + sy / 2); }
    const bottom = o.position[1] + lo, top = o.position[1] + hi;
    spawns.set(o.id, { ...o, bottom, top });
    console.log(`spawn ${o.id} "${o.name}" ${o.physics}${o.material ? ' ' + o.material : ''}${o.mass ? ' ' + o.mass + ' kg' : ''} at ${r2(o.position)} rot ${r2(o.rotation)} · ${o.parts.length} part(s): ${o.parts.map(p => `${p.shape || 'box'} ${r2(p.size || [1, 1, 1])}${p.offset ? ' @' + r2(p.offset) : ''}${p.rotation ? ' rot' + r2(p.rotation) : ''}`).join('; ')}`);
    console.log(`      spans y ${bottom.toFixed(2)} → ${top.toFixed(2)} m${o.solid === false ? ' · not solid' : ''}`);
    if (bottom < -0.05) notes.push(`"${o.name}" starts ${(-bottom).toFixed(2)} m below the ground`);
  } else if (o.op === 'joint') {
    console.log(`joint ${o.kind}: ${o.a} ↔ ${o.b || 'fixed world'} · anchor ${r2(o.anchor)}${o.kind === 'hinge' || o.kind === 'slider' ? ' axis ' + r2(o.axis) : ''}${o.anchorA ? ' anchorA ' + r2(o.anchorA) : ''}${o.anchorB ? ' anchorB ' + r2(o.anchorB) : ''}${o.length ? ' length ' + o.length : ''}`);
  } else if (!['log'].includes(o.op)) {
    console.log(`${o.op}${o.id ? ' ' + o.id : ''}${o.value ? ' ' + r2(o.value) : ''}${o.key ? ' ' + o.key + '=' + JSON.stringify(o.value) : ''}${o.h ? ' (handler)' : ''}`);
  }
}
const joints = ops.filter(o => o.op === 'joint');
for (const [id, s] of spawns) {
  const js = joints.filter(j => j.a === id || j.b === id);
  if (s.physics === 'dynamic' && js.length === 0) notes.push(`"${s.name}" is dynamic but nothing holds it (no joint), so it just falls`);
  if (s.physics !== 'dynamic' && js.some(j => j.a === id)) notes.push(`"${s.name}" is jointed but ${s.physics}: only dynamic bodies move on joints`);
  for (const j of js) {
    const anchor = j.kind === 'rope' ? (j.anchorB || j.anchor) : j.anchor;
    if (!j.b && anchor[1] < 0.3) notes.push(`${j.kind} on "${s.name}" is pinned at ground level (anchor y = ${anchor[1].toFixed(2)})`);
    if (j.a === id && j.kind !== 'rope') {
      const d = Math.hypot(anchor[0] - s.position[0], anchor[1] - s.position[1], anchor[2] - s.position[2]);
      if (d < 0.05 && s.physics === 'dynamic' && j.kind === 'hinge') notes.push(`hinge anchor is at the centre of "${s.name}", so it can only spin in place, not swing`);
    }
  }
}
for (const j of joints) if (!spawns.has(j.a) || (j.b && !spawns.has(j.b))) notes.push(`a ${j.kind} joint refers to an entity this code didn't spawn`);

// 2. simulate it in a throwaway room (Box3D if built)
let next = mod.code;
const sim = new Room('inspect', { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-')), generate: async (p, c, t) => { const e = t(next); if (e) throw new Error(e); return next; } });
const c = sim.join({ readyState: 1, send() {} }, 'observer');
sim.handle(c, { t: 'state', p: [mod.here[0] + 150, 0, mod.here[2] + 150], look: [0, 0, -1], ry: 0 });
// rebuild at the same spot the mod originally used
sim.handle(c, { t: 'state', p: [mod.here[0], 0, mod.here[2] + 8], look: [0, 0, -1], ry: 0 });
await sim.requestMod(c, 'inspect');
sim.handle(c, { t: 'state', p: [mod.here[0] + 150, 0, mod.here[2] + 150], look: [0, 0, -1], ry: 0 });
const m = [...sim.mods.values()][0];
console.log(`\n=== 3 s of physics (${sim.physics.name}) — built: ${m.status}${m.error ? ' · ' + m.error : ''} ===`);
const start = new Map([...sim.entities.values()].map(e => [e.id, [...e.position]]));
const samples = [0.5, 1, 2, 3];
let t = 0;
const rows = new Map([...sim.entities.values()].map(e => [e.id, []]));
for (const at of samples) {
  await new Promise(r => setTimeout(r, (at - t) * 1000)); t = at;
  for (const e of sim.entities.values()) rows.get(e.id)?.push(`${at}s ${r2(e.position)}`);
}
for (const e of sim.entities.values()) {
  const s = start.get(e.id), end = e.position;
  console.log(`${e.id} "${e.name}" (${e.physics}${sim.physics.typeOf?.(e.id) ? ', body ' + sim.physics.typeOf(e.id) : ', no body'}) start ${r2(s)}  ${rows.get(e.id).join('  ')}`);
  const drop = s[1] - end[1];
  if (e.physics === 'dynamic' && drop > 0.5 && !joints.some(j => j.a === e.id || j.b === e.id)) notes.push(`"${e.name}" fell ${drop.toFixed(2)} m and came to rest on the ground`);
}
for (const id of start.keys()) if (!sim.entities.has(id)) notes.push(`${id} left the world during the simulation`);
console.log(`joints created in the physics world: ${sim.physics.joints?.size ?? 0} of ${joints.length} requested`);
if ((sim.physics.joints?.size ?? 0) < joints.length) notes.push(`${joints.length - (sim.physics.joints?.size ?? 0)} joint(s) were rejected (their bodies didn't exist or weren't owned by this mod)`);
sim.close();

console.log('\n=== findings ===');
console.log(notes.length ? notes.map(n => '• ' + n).join('\n') : '• nothing obviously wrong');
process.exit(0);
