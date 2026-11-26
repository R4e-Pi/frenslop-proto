// Rigid-body physics for rooms.
//   Box3DPhysics  — Erin Catto's Box3D v0.1.0 in physics/physics_server (C), driven over a pipe
//                   (the same split as box3d-net-demo: Node = game logic, C = simulation).
//   SimplePhysics — the original tiny integrator, used when the C server isn't built
//                   (or PHYSICS=simple). Same interface, fewer features (no joints).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PHYSICS_BIN = path.join(ROOT, 'physics', 'physics_server');
const HZ = 60;

// Real-world materials: density kg/m³, Coulomb friction, restitution (bounce), rolling resistance.
export const MATERIALS = {
  wood:       { density: 600,   friction: 0.5,  restitution: 0.25, rolling: 0.05 },
  steel:      { density: 7850,  friction: 0.4,  restitution: 0.3,  rolling: 0.01 },
  stone:      { density: 2400,  friction: 0.7,  restitution: 0.1,  rolling: 0.05 },
  concrete:   { density: 2400,  friction: 0.8,  restitution: 0.05, rolling: 0.05 },
  rubber:     { density: 1100,  friction: 0.9,  restitution: 0.8,  rolling: 0.02 },
  ice:        { density: 917,   friction: 0.03, restitution: 0.05, rolling: 0.0 },
  plastic:    { density: 950,   friction: 0.35, restitution: 0.45, rolling: 0.02 },
  glass:      { density: 2500,  friction: 0.4,  restitution: 0.35, rolling: 0.01 },
  gold:       { density: 19300, friction: 0.45, restitution: 0.15, rolling: 0.01 },
  foam:       { density: 30,    friction: 0.6,  restitution: 0.3,  rolling: 0.1 },
  inflatable: { density: 12,    friction: 0.5,  restitution: 0.75, rolling: 0.05 }, // air-filled: beach balls
};
export const DEFAULT_MATERIAL = 'plastic';

// ---------- math (three.js conventions: Euler order XYZ) ----------
export function eulerToQuat([x, y, z]) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
export function quatToEuler([x, y, z, w]) {
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  return [Math.atan2(m32, m22), ey, 0];
}
export function rotate([qx, qy, qz, qw], [vx, vy, vz]) {
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}
const f = (n, d = 4) => (Number.isFinite(n) ? +n.toFixed(d) : 0);
const v3 = v => `${f(v[0])} ${f(v[1])} ${f(v[2])}`;
const q4 = q => `${f(q[0], 6)} ${f(q[1], 6)} ${f(q[2], 6)} ${f(q[3], 6)}`;

export function materialOf(e) {
  const base = MATERIALS[e.material] || MATERIALS[DEFAULT_MATERIAL];
  return {
    density: base.density,
    friction: e.friction ?? base.friction,
    restitution: e.bounciness ?? base.restitution,
    rolling: base.rolling,
  };
}

// Part → Box3D primitives in the entity's local frame. Shapes match the client meshes:
// every part is a unit shape (fits a 1×1×1 box) scaled by size, then rotated and offset.
export function partShapes(p) {
  const q = eulerToQuat(p.rotation), o = p.offset, s = p.size;
  const place = v => { const r = rotate(q, [v[0] * s[0], v[1] * s[1], v[2] * s[2]]); return [r[0] + o[0], r[1] + o[1], r[2] + o[2]]; };
  const hull = pts => ({ kind: 'H', pts: pts.map(place) });
  const ring = (y, r, n = 12) => Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * Math.PI * 2), y, r * Math.sin((i / n) * Math.PI * 2)]);
  const ellipsoid = () => {
    const pts = [[0, 0.5, 0], [0, -0.5, 0]];
    for (const y of [-0.35, 0, 0.35]) pts.push(...ring(y, Math.sqrt(0.25 - y * y), 10));
    return hull(pts);
  };
  const uniform = Math.max(...s) / Math.min(...s) < 1.04;
  switch (p.shape) {
    case 'box': return [{ kind: 'B', half: [s[0] / 2, s[1] / 2, s[2] / 2], offset: o, quat: q }];
    case 'sphere': return [uniform ? { kind: 'S', r: s[0] / 2, center: o } : ellipsoid()];
    case 'cylinder': return [hull([...ring(0.5, 0.5), ...ring(-0.5, 0.5)])];
    case 'cone': return [hull([[0, 0.5, 0], ...ring(-0.5, 0.5)])];
    case 'capsule': {
      // client capsule: radius 0.5, total height 1 (scaled by size)
      if (Math.abs(s[0] - s[2]) / Math.max(s[0], s[2]) < 0.05) {
        const r = s[0] / 2, segHalf = s[1] / 2 - r;
        if (segHalf > 0.005) {
          const c1 = rotate(q, [0, segHalf, 0]), c2 = rotate(q, [0, -segHalf, 0]);
          return [{ kind: 'C', r, a: [c1[0] + o[0], c1[1] + o[1], c1[2] + o[2]], b: [c2[0] + o[0], c2[1] + o[1], c2[2] + o[2]] }];
        }
      }
      return [ellipsoid()];
    }
    case 'torus': {
      // a ring of capsules around the tube, so the hole stays open (hoops, portals, wheels)
      const tr = (p.tube ?? 0.12) * 0.5, R = 0.5 - tr, n = 12;
      const r = tr * Math.min(s[0], s[1], s[2]);
      const pts = Array.from({ length: n }, (_, i) => place([R * Math.cos((i / n) * Math.PI * 2), R * Math.sin((i / n) * Math.PI * 2), 0]));
      return pts.map((a, i) => ({ kind: 'C', r: Math.max(r, 0.01), a, b: pts[(i + 1) % n] }));
    }
    default: return [{ kind: 'B', half: [s[0] / 2, s[1] / 2, s[2] / 2], offset: o, quat: q }];
  }
}

// =====================================================================================
export class Box3DPhysics {
  name = 'box3d';
  constructor() {
    this.bodies = new Map();   // key (entity id or player id) -> { h, type }
    this.keyOf = new Map();    // handle -> key
    this.joints = new Map();   // joint id -> handle
    this.nextBody = 0;
    this.nextJoint = 0;
    this.freeBodies = [];      // recycled handles
    this.freeJoints = [];
    this.out = [];
    this.dead = false;
    this.frame = null;
    this.proc = spawn(PHYSICS_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.on('error', e => { console.error(`[physics] can't run ${PHYSICS_BIN}: ${e.message} — using simple physics (rebuild with: npm run build:physics)`); this.dead = true; this.#finish(null); });
    this.proc.on('exit', code => { if (!this.closed) console.error(`[physics] box3d server exited (${code})`); this.dead = true; this.#finish(null); });
    this.proc.stdin.on('error', () => { this.dead = true; });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', l => this.#line(l));
  }

  #send(s) { this.out.push(s); }
  #flush() { if (!this.dead && this.out.length) { this.proc.stdin.write(this.out.join('\n') + '\n'); this.out.length = 0; } }

  #line(l) {
    const fr = this.frame;
    if (!fr) return;
    if (l === '.') return this.#finish(fr.result);
    const t = l.split(' ');
    if (t[0] === 'p') {
      const key = this.keyOf.get(+t[1]);
      if (key && !key.startsWith('player:')) {
        const n = t.slice(2).map(Number);
        fr.result.moved.push([key, n.slice(0, 3), n.slice(3, 7), n.slice(7, 10)]);
      }
    } else if (t[0] === 'z') {
      const key = this.keyOf.get(+t[1]);
      if (key) fr.result.slept.push(key);
    } else if (t[0] === 'c') {
      const name = h => (+h === -1 ? 'ground' : (this.keyOf.get(+h) || 'ground').replace(/^player:/, ''));
      fr.result.hits.push([name(t[1]), name(t[2]), +t[3], [+t[4], +t[5], +t[6]]]);
    }
  }
  #finish(result) {
    const fr = this.frame;
    this.frame = null;
    if (fr) fr.resolve(result || { moved: [], slept: [], hits: [] });
  }

  #shapeLines(parts, mat) {
    const m = `${f(mat.density, 2)} ${f(mat.friction, 3)} ${f(mat.restitution, 3)} ${f(mat.rolling, 3)}`;
    const lines = [];
    for (const p of parts) for (const s of partShapes(p)) {
      if (s.kind === 'B') lines.push(`s B ${v3(s.half)} ${v3(s.offset)} ${q4(s.quat)} ${m}`);
      else if (s.kind === 'S') lines.push(`s S ${f(s.r)} ${v3(s.center)} ${m}`);
      else if (s.kind === 'C') lines.push(`s C ${f(s.r)} ${v3(s.a)} ${v3(s.b)} ${m}`);
      else if (s.kind === 'H') lines.push(`s H ${s.pts.length} ${s.pts.map(v3).join(' ')} ${m}`);
    }
    return lines;
  }

  setGravity(g) { this.#send(`g 0 ${f(-g)} 0`); }

  // type: 'static' | 'kinematic' | 'dynamic'
  #bodyHandle() { return this.freeBodies.length ? this.freeBodies.pop() : this.nextBody++; }
  addEntity(e, type) {
    this.removeEntity(e.id);
    const h = this.#bodyHandle();
    const code = type === 'dynamic' ? 2 : type === 'kinematic' ? 1 : 0;
    const q = eulerToQuat(e.rotation);
    this.#send(`b ${h} ${code} ${v3(e.position)} ${q4(q)} ${v3(e.velocity || [0, 0, 0])} ${v3(e.spin || [0, 0, 0])} ${e.bullet ? 1 : 0}`);
    for (const l of this.#shapeLines(e.parts, materialOf(e))) this.#send(l);
    this.#send(`e ${h} ${f(e.mass || 0, 3)}`);
    this.bodies.set(e.id, { h, type });
    this.keyOf.set(h, e.id);
    return true;
  }
  has(id) { return this.bodies.has(id); }
  typeOf(id) { return this.bodies.get(id)?.type; }
  removeEntity(id) {
    const b = this.bodies.get(id);
    if (!b) return;
    this.#send(`r ${b.h}`);
    this.bodies.delete(id);
    this.keyOf.delete(b.h);
    this.freeBodies.push(b.h);
  }
  // A mod (or a driver) moved an entity. Static bodies become kinematic so they push things.
  moveEntity(e, dt) {
    const b = this.bodies.get(e.id);
    if (!b) return;
    if (b.type === 'static') { this.#send(`k ${b.h} 1`); b.type = 'kinematic'; }
    this.#send(`t ${b.h} ${v3(e.position)} ${q4(eulerToQuat(e.rotation))} ${b.type === 'kinematic' ? f(dt) : 0}`);
    if (b.type === 'kinematic') { b.moved = true; b.moving = true; }
  }
  setVelocity(id, v) { const b = this.bodies.get(id); if (b) this.#send(`v ${b.h} ${v3(v)}`); }
  setSpin(id, w) { const b = this.bodies.get(id); if (b) this.#send(`w ${b.h} ${v3(w)}`); }
  impulse(id, j) { const b = this.bodies.get(id); if (b) this.#send(`i ${b.h} ${v3(j)}`); }
  force(id, F) { const b = this.bodies.get(id); if (b) this.#send(`f ${b.h} ${v3(F)}`); }

  // players are kinematic capsules (feet at position), so walking into things pushes them
  setPlayer(pid, pos, dt) {
    const key = 'player:' + pid;
    let b = this.bodies.get(key);
    if (!b) {
      const h = this.#bodyHandle();
      this.#send(`b ${h} 1 ${v3(pos)} 0 0 0 1 0 0 0 0 0 0 0`);
      this.#send(`s C 0.35 0 0.35 0 0 1.35 0 ${MATERIALS.rubber.density} 0.6 0 0`);
      this.#send(`e ${h} 80`);
      b = { h, type: 'kinematic' };
      this.bodies.set(key, b);
      this.keyOf.set(h, key);
      return;
    }
    this.#send(`t ${b.h} ${v3(pos)} 0 0 0 1 ${f(dt)}`);
  }
  removePlayer(pid) { this.removeEntity('player:' + pid); }

  // kind: hinge | slider | ball | weld | rope ; a, b = entity ids (b may be null = fixed world)
  addJoint(id, kind, a, b, o) {
    const A = this.bodies.get(a), B = b ? this.bodies.get(b) : null;
    if (!A) return false;
    this.removeJoint(id);
    const h = this.freeJoints.length ? this.freeJoints.pop() : this.nextJoint++;
    const hb = B ? B.h : -1;
    const anchor = o.anchor || [0, 0, 0];
    switch (kind) {
      case 'hinge': this.#send(`j ${h} R ${A.h} ${hb} ${v3(anchor)} ${v3(o.axis || [0, 1, 0])} ${f(o.motorSpeed || 0)} ${f(o.maxTorque || 0)} ${f(o.limits?.[0] ?? 0)} ${f(o.limits?.[1] ?? 0)}`); break;
      case 'slider': this.#send(`j ${h} P ${A.h} ${hb} ${v3(anchor)} ${v3(o.axis || [1, 0, 0])} ${f(o.limits?.[0] ?? 0)} ${f(o.limits?.[1] ?? 0)} ${f(o.motorSpeed || 0)} ${f(o.maxForce || 0)}`); break;
      case 'ball': this.#send(`j ${h} S ${A.h} ${hb} ${v3(anchor)}`); break;
      case 'weld': this.#send(`j ${h} W ${A.h} ${hb} ${v3(anchor)}`); break;
      case 'rope': this.#send(`j ${h} D ${A.h} ${hb} ${v3(o.anchorA || anchor)} ${v3(o.anchorB || anchor)} ${f(o.length || 0)} ${o.spring ? 1 : 0} ${f(o.stiffness || 2)} ${f(o.damping ?? 0.3)}`); break;
      default: return false;
    }
    this.joints.set(id, h);
    return true;
  }
  removeJoint(id) {
    const h = this.joints.get(id);
    if (h === undefined) return;
    this.#send(`q ${h}`);
    this.joints.delete(id);
    this.freeJoints.push(h);
  }

  // advance the world by dt seconds (60 Hz steps × 4 substeps each)
  step(dt) {
    if (this.dead) return Promise.resolve({ moved: [], slept: [], hits: [] });
    if (this.frame) return this.frame.promise;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this.frame = { resolve, promise, result: { moved: [], slept: [], hits: [] } };
    // kinematic bodies keep their velocity: stop the ones nobody moved since the last step
    for (const b of this.bodies.values()) {
      if (b.type !== 'kinematic' || !b.moving) continue;
      if (!b.moved) { this.#send(`v ${b.h} 0 0 0`); this.#send(`w ${b.h} 0 0 0`); b.moving = false; }
      b.moved = false;
    }
    this.#send(`x ${f(1 / HZ, 6)} ${Math.max(1, Math.round(dt * HZ))}`);
    this.#flush();
    return promise;
  }

  close() { this.closed = true; this.dead = true; try { this.proc.stdin.end(); this.proc.kill(); } catch {} }
}

// =====================================================================================
// Fallback: the original integrator. Dynamic bodies only: gravity, ground bounce with the
// material's restitution, impulses/forces/velocity, and players kicking things. No joints,
// no body-vs-body collisions.
export class SimplePhysics {
  name = 'simple';
  constructor() { this.gravity = 9.8; this.bodies = new Map(); this.players = new Map(); }
  setGravity(g) { this.gravity = g; }
  addEntity(e, type) {
    if (type !== 'dynamic') { this.bodies.set(e.id, { type, static: true }); return true; }
    let lo = Infinity, hi = -Infinity, vol = 0;
    for (const p of e.parts) {
      lo = Math.min(lo, p.offset[1] - p.size[1] / 2); hi = Math.max(hi, p.offset[1] + p.size[1] / 2);
      vol += p.size[0] * p.size[1] * p.size[2] * (p.shape === 'box' ? 1 : 0.52);
    }
    const mat = materialOf(e);
    this.bodies.set(e.id, {
      type, p: [...e.position], v: [...(e.velocity || [0, 0, 0])], rot: [...e.rotation], w: [...(e.spin || [0, 0, 0])],
      bottom: Number.isFinite(lo) ? lo : -0.5, radius: Number.isFinite(hi) ? (hi - lo) / 2 : 0.5,
      mass: e.mass || Math.max(0.01, vol * mat.density), restitution: mat.restitution, friction: mat.friction, F: [0, 0, 0],
    });
    return true;
  }
  has(id) { return this.bodies.has(id); }
  typeOf(id) { return this.bodies.get(id)?.type; }
  removeEntity(id) { this.bodies.delete(id); }
  moveEntity(e) { const b = this.bodies.get(e.id); if (b && !b.static) { b.p = [...e.position]; b.rot = [...e.rotation]; } }
  setVelocity(id, v) { const b = this.bodies.get(id); if (b && !b.static) b.v = [...v]; }
  setSpin(id, w) { const b = this.bodies.get(id); if (b && !b.static) b.w = [...w]; }
  impulse(id, j) { const b = this.bodies.get(id); if (b && !b.static) for (let i = 0; i < 3; i++) b.v[i] += j[i] / b.mass; }
  force(id, F) { const b = this.bodies.get(id); if (b && !b.static) for (let i = 0; i < 3; i++) b.F[i] += F[i]; }
  setPlayer(pid, pos) { this.players.set(pid, pos); }
  removePlayer(pid) { this.players.delete(pid); }
  addJoint() { return false; }
  removeJoint() {}
  step(dt) {
    const moved = [], hits = [];
    for (const [id, b] of this.bodies) {
      if (b.static) continue;
      const v = b.v;
      for (let i = 0; i < 3; i++) v[i] += (b.F[i] / b.mass) * dt;
      b.F = [0, 0, 0];
      v[1] -= this.gravity * dt;
      for (const p of this.players.values()) {
        const dx = b.p[0] - p[0], dz = b.p[2] - p[2], dy = b.p[1] - (p[1] + 0.8), d = Math.hypot(dx, dz);
        if (d < b.radius + 0.45 && Math.abs(dy) < b.radius + 1) { const n = d || 1; v[0] = (dx / n) * 7; v[2] = (dz / n) * 7; v[1] = Math.max(v[1], 4); }
      }
      for (let i = 0; i < 3; i++) { b.p[i] += v[i] * dt; b.rot[i] += b.w[i] * dt; }
      const floor = -b.bottom;
      if (b.p[1] < floor) {
        if (Math.abs(v[1]) > 0.5) hits.push([id, 'ground', Math.abs(v[1]), [b.p[0], 0, b.p[2]]]);
        b.p[1] = floor;
        v[1] = Math.abs(v[1]) > 1 ? -v[1] * b.restitution : 0;
        const k = Math.max(0, 1 - b.friction * 0.2); v[0] *= k; v[2] *= k;
      }
      if (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]) + Math.abs(b.w[0]) + Math.abs(b.w[1]) + Math.abs(b.w[2]) > 0.01) {
        moved.push([id, [...b.p], eulerToQuat(b.rot), [...v]]);
      }
    }
    return Promise.resolve({ moved, slept: [], hits });
  }
  close() {}
}

export function createPhysics() {
  const want = (process.env.PHYSICS || 'auto').toLowerCase();
  if (want !== 'simple' && fs.existsSync(PHYSICS_BIN)) {
    try { return new Box3DPhysics(); } catch (e) { console.warn('[physics] box3d unavailable:', e.message); }
  } else if (want === 'box3d') {
    console.warn('[physics] PHYSICS=box3d but physics/physics_server is not built — run: npm run build:physics');
  }
  return new SimplePhysics();
}
createPhysics.simple = () => new SimplePhysics();
export const physicsStatus = () =>
  (process.env.PHYSICS || 'auto').toLowerCase() === 'simple' ? 'simple (PHYSICS=simple)'
    : fs.existsSync(PHYSICS_BIN) ? 'Box3D v0.1.0 (physics/physics_server)' : 'simple — build Box3D with: npm run build:physics';
