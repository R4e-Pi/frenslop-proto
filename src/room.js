// A room = shared world state + the mods running in it.
// Mods emit ops from their sandbox; the room validates them, applies them to
// state, and broadcasts the result to every connected client.
import fs from 'node:fs';
import path from 'node:path';
import { ModSandbox } from './sandbox.js';

const TICK_HZ = 20;
const LIMITS = {
  promptChars: 240,
  modsPerRoom: 30,
  entitiesPerMod: 300,
  dynamicPerMod: 40,
  entitiesPerRoom: 2000,
  partsPerEntity: 80,
  itemsPerRoom: 8,
  modErrors: 25,
  worldRadius: 400,
};
const SHAPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule']);
const DEFAULT_WORLD = { gravity: 9.8, sky: '#232325', fog: ['#232325', 120, 340] }; // Bitmap district night

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (a, d, lo, hi) => [0, 1, 2].map(i => clamp(num(a?.[i], d[i]), lo, hi));
const colorOk = c => typeof c === 'string' && c.length < 32 && /^[#a-z0-9(),.% ]+$/i.test(c);
const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

function cleanPart(p) {
  p = p && typeof p === 'object' ? p : {};
  return {
    shape: SHAPES.has(p.shape) ? p.shape : 'box',
    size: vec(Array.isArray(p.size) ? p.size : [num(p.size, 1), num(p.size, 1), num(p.size, 1)], [1, 1, 1], 0.02, 80),
    offset: vec(p.offset, [0, 0, 0], -80, 80),
    rotation: vec(p.rotation, [0, 0, 0], -10, 10),
    color: colorOk(p.color) ? p.color : '#cccccc',
    emissive: !!p.emissive,
    opacity: clamp(num(p.opacity, 1), 0.05, 1),
    tube: clamp(num(p.tube, 0.12), 0.01, 0.5),
  };
}

// Rough half-height of an entity, for resting dynamic bodies on the ground.
function halfHeight(parts) {
  let lo = Infinity, hi = -Infinity;
  for (const p of parts) {
    lo = Math.min(lo, p.offset[1] - p.size[1] / 2);
    hi = Math.max(hi, p.offset[1] + p.size[1] / 2);
  }
  return { bottom: Number.isFinite(lo) ? lo : -0.5, radius: Number.isFinite(hi) ? (hi - lo) / 2 : 0.5 };
}

export class Room {
  constructor(id, { generate, dataDir }) {
    this.id = id;
    this.generate = generate;
    this.file = path.join(dataDir, `${id}.json`);
    this.clients = new Map();   // pid -> client
    this.entities = new Map();  // eid -> entity
    this.mods = new Map();      // modId -> mod
    this.items = [];
    this.world = { ...DEFAULT_WORLD };
    this.dirty = new Set();
    this.seq = 0;
    this.t = 0;
    this.#restore();
    this.timer = setInterval(() => this.#tick(1 / TICK_HZ), 1000 / TICK_HZ);
  }

  // ---------- clients ----------
  join(ws, name) {
    const id = 'p' + (++this.seq) + Math.random().toString(36).slice(2, 5);
    const client = { ws, id, name: text(name, 20) || 'fren', position: [0, 0, 8], look: [0, 0, -1], ry: 0 };
    this.clients.set(id, client);
    this.#send(client, {
      t: 'hello', you: { id, name: client.name }, room: this.id, world: this.world,
      entities: [...this.entities.values()].map(e => this.#publicEntity(e)),
      items: this.#publicItems(), mods: this.#publicMods(),
    });
    this.#system(`${client.name} joined`);
    return client;
  }

  leave(client) {
    this.clients.delete(client.id);
    for (const e of this.entities.values()) if (e.driver === client.id) e.driver = null;
    this.#broadcast({ t: 'gone', id: client.id });
    this.#system(`${client.name} left`);
  }

  handle(client, msg) {
    switch (msg.t) {
      case 'state':
        client.position = vec(msg.p, client.position, -LIMITS.worldRadius, LIMITS.worldRadius);
        client.look = vec(msg.look, client.look, -1, 1);
        client.ry = num(msg.ry, 0);
        break;
      case 'name':
        client.name = text(msg.name, 20) || client.name;
        break;
      case 'chat': {
        const s = text(msg.text, 200).trim();
        if (s) this.#broadcast({ t: 'msg', from: client.name, text: s });
        break;
      }
      case 'mod': this.requestMod(client, msg.prompt); break;
      case 'unmod': this.removeMod(msg.id, client); break;
      case 'interact': this.#interact(client, msg.id); break;
      case 'use': this.#use(client, msg.key); break;
      case 'drive': {
        const e = this.entities.get(msg.id);
        if (!e || e.driver !== client.id) break;
        e.position = vec(msg.p, e.position, -LIMITS.worldRadius, LIMITS.worldRadius);
        e.rotation = vec(msg.r, e.rotation, -10, 10);
        this.dirty.add(e.id);
        break;
      }
      case 'unmount': {
        const e = this.entities.get(msg.id);
        if (e && e.driver === client.id) e.driver = null;
        break;
      }
    }
  }

  // ---------- mods ----------
  async requestMod(client, prompt) {
    prompt = text(prompt, LIMITS.promptChars).trim();
    if (!prompt) return;
    if (this.mods.size >= LIMITS.modsPerRoom) return this.#tell(client, `room is full of mods (${LIMITS.modsPerRoom}) — remove one first`);
    if ([...this.mods.values()].some(m => m.author.id === client.id && m.status === 'building')) {
      return this.#tell(client, 'one mod at a time — yours is still building');
    }
    const modId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    const fwd = [client.look[0], 0, client.look[2]];
    const len = Math.hypot(fwd[0], fwd[2]) || 1;
    const here = [client.position[0] + (fwd[0] / len) * 8, 0, client.position[2] + (fwd[2] / len) * 8].map(v => Math.round(v * 10) / 10);
    const mod = { id: modId, prompt, author: { id: client.id, name: client.name }, here, status: 'building', error: null, code: null, ticks: [], enters: [], worldSet: {} };
    this.mods.set(modId, mod);
    this.#broadcastMods();
    this.#system(`${client.name} is building: "${prompt}"`);

    const started = Date.now();
    try {
      const code = await this.generate(prompt, { here, author: mod.author }, c => this.#tryInstall(mod, c));
      if (!this.mods.has(modId)) return; // removed while building
      if (!code) throw new Error('model returned no usable code');
      mod.status = 'live';
      mod.ms = Date.now() - started;
      this.#system(`built "${prompt}" in ${(mod.ms / 1000).toFixed(1)}s`);
      this.#save();
    } catch (e) {
      mod.status = 'failed';
      mod.error = text(e.message, 300);
      console.warn(`[${this.id}] build failed "${prompt}": ${mod.error}`);
      this.#teardown(mod);
      this.#system(`couldn't build "${prompt}": ${mod.error}`);
    }
    this.#broadcastMods();
  }

  // Load code into a fresh sandbox. Returns null on success or an error string
  // that the LLM layer feeds back to the model for a retry.
  #tryInstall(mod, code) {
    this.#teardown(mod);
    let sb;
    try {
      sb = new ModSandbox(mod.id, { here: mod.here, author: mod.author });
      const ops = sb.load(code);
      if (!ops.some(o => ['spawn', 'world', 'item', 'tick'].includes(o.op))) {
        sb.dispose();
        return 'the code ran but did nothing visible — it must call world.spawn, world.setGravity, items.register or similar';
      }
      Object.assign(mod, { sandbox: sb, code, ticks: [], enters: [], worldSet: {} });
      this.#apply(mod, ops);
      return null;
    } catch (e) {
      sb?.dispose();
      return e.message;
    }
  }

  removeMod(modId, client) {
    const mod = this.mods.get(modId);
    if (!mod) return;
    this.#teardown(mod);
    this.mods.delete(modId);
    this.#recomputeWorld();
    this.#save();
    this.#broadcastMods();
    if (client) this.#system(`${client.name} removed "${mod.prompt}"`);
  }

  #teardown(mod) {
    for (const e of [...this.entities.values()]) if (e.mod === mod.id) this.#removeEntity(e.id);
    const before = this.items.length;
    this.items = this.items.filter(i => i.mod !== mod.id);
    if (this.items.length !== before) this.#broadcast({ t: 'items', items: this.#publicItems() });
    mod.sandbox?.dispose();
    mod.sandbox = null;
    mod.ticks = [];
    mod.enters = [];
    if (mod.worldSet && Object.keys(mod.worldSet).length) { mod.worldSet = {}; this.#recomputeWorld(); }
  }

  // ---------- applying sandbox ops ----------
  #apply(mod, ops) {
    for (const o of ops) {
      try { this.#applyOne(mod, o); } catch (e) { console.warn(`[${this.id}] bad op from ${mod.id}:`, e.message); }
    }
  }

  #applyOne(mod, o) {
    const ent = o.id && this.entities.get(o.id);
    const owns = ent && ent.mod === mod.id;
    switch (o.op) {
      case 'spawn': {
        if (this.entities.size >= LIMITS.entitiesPerRoom) return;
        const mine = [...this.entities.values()].filter(e => e.mod === mod.id);
        if (mine.length >= LIMITS.entitiesPerMod) return;
        const dynamic = o.physics === 'dynamic';
        if (dynamic) {
          const dyn = mine.filter(e => e.physics === 'dynamic');
          if (dyn.length >= LIMITS.dynamicPerMod) this.#removeEntity(dyn[0].id);
        }
        const parts = (Array.isArray(o.parts) ? o.parts : []).slice(0, LIMITS.partsPerEntity).map(cleanPart);
        const e = {
          id: o.id, mod: mod.id, name: text(o.name, 40),
          parts: parts.length ? parts : [cleanPart({})],
          position: vec(o.position, [0, 0, 0], -LIMITS.worldRadius, LIMITS.worldRadius),
          rotation: vec(o.rotation, [0, 0, 0], -10, 10),
          solid: !!o.solid,
          physics: dynamic ? 'dynamic' : 'static',
          velocity: vec(o.velocity, [0, 0, 0], -80, 80),
          prompt: null, interactH: null, vehicle: null, driver: null,
        };
        e.shape = halfHeight(e.parts);
        this.entities.set(e.id, e);
        this.#broadcast({ t: 'ent+', e: this.#publicEntity(e) });
        break;
      }
      case 'update':
        if (!owns) return;
        if (o.position) ent.position = vec(o.position, ent.position, -LIMITS.worldRadius, LIMITS.worldRadius);
        if (o.rotation) ent.rotation = vec(o.rotation, ent.rotation, -1e4, 1e4);
        this.dirty.add(ent.id);
        break;
      case 'push':
        if (ent && ent.physics === 'dynamic') ent.velocity = vec(o.velocity, [0, 0, 0], -80, 80);
        break;
      case 'remove':
        if (owns) this.#removeEntity(ent.id);
        break;
      case 'world': {
        if (o.key === 'gravity') mod.worldSet.gravity = clamp(num(o.value, 9.8), -20, 50);
        else if (o.key === 'sky' && colorOk(o.value)) mod.worldSet.sky = o.value;
        else if (o.key === 'fog' && Array.isArray(o.value) && colorOk(o.value[0])) {
          mod.worldSet.fog = [o.value[0], clamp(num(o.value[1], 70), 0, 2000), clamp(num(o.value[2], 320), 1, 4000)];
        } else return;
        this.#recomputeWorld();
        break;
      }
      case 'tick': if (o.h) mod.ticks.push(o.h); break;
      case 'enter':
        if (owns && o.h) mod.enters.push({ id: o.id, radius: clamp(num(o.radius, 2), 0.2, 50), h: o.h, inside: new Set() });
        break;
      case 'interact':
        if (!owns) return;
        ent.prompt = text(o.prompt, 40);
        ent.interactH = o.h;
        this.#broadcast({ t: 'ent+', e: this.#publicEntity(ent) });
        break;
      case 'vehicle':
        if (!owns) return;
        ent.vehicle = { speed: clamp(num(o.speed, 8), 1, 40) };
        ent.prompt = text(o.prompt || `ride the ${ent.name}`, 40);
        this.#broadcast({ t: 'ent+', e: this.#publicEntity(ent) });
        break;
      case 'item': {
        if (this.items.length >= LIMITS.itemsPerRoom) return;
        this.items.push({ key: `${mod.id}:${this.items.length}:${Math.random().toString(36).slice(2, 5)}`, mod: mod.id, name: text(o.name, 24), icon: text(o.icon, 4), h: o.h });
        this.#broadcast({ t: 'items', items: this.#publicItems() });
        break;
      }
      case 'teleport': {
        const c = this.clients.get(o.pid);
        if (c) this.#send(c, { t: 'teleport', p: vec(o.position, [0, 2, 0], -LIMITS.worldRadius, LIMITS.worldRadius) });
        break;
      }
      case 'launch': {
        const c = this.clients.get(o.pid);
        if (c) this.#send(c, { t: 'launch', v: vec(o.velocity, [0, 10, 0], -60, 60) });
        break;
      }
      case 'msg': {
        const from = mod.prompt.length > 24 ? mod.prompt.slice(0, 23) + '…' : mod.prompt;
        const payload = { t: 'msg', from, text: text(o.text, 200), mod: true };
        if (o.to) { const c = this.clients.get(o.to); if (c) this.#send(c, payload); } else this.#broadcast(payload);
        break;
      }
      case 'log': console.log(`[${this.id}/${mod.id}]`, text(o.text, 300)); break;
    }
  }

  #removeEntity(id) {
    if (!this.entities.delete(id)) return;
    this.dirty.delete(id);
    this.#broadcast({ t: 'ent-', id });
  }

  #recomputeWorld() {
    const w = { ...DEFAULT_WORLD };
    for (const m of this.mods.values()) Object.assign(w, m.worldSet || {});
    this.world = w;
    this.#broadcast({ t: 'world', world: w });
  }

  // ---------- interactions ----------
  #playersForMods() {
    return [...this.clients.values()].map(c => ({ id: c.id, name: c.name, position: c.position, look: c.look }));
  }

  #callMod(modId, h, args) {
    const mod = this.mods.get(modId);
    if (!mod?.sandbox || mod.status !== 'live') return;
    const ops = mod.sandbox.call(h, args, this.#playersForMods());
    this.#apply(mod, ops);
    if (mod.sandbox.errors > LIMITS.modErrors) {
      mod.status = 'crashed';
      mod.error = mod.sandbox.lastError;
      mod.ticks = [];
      this.#system(`"${mod.prompt}" crashed: ${mod.error}`);
      this.#broadcastMods();
    }
  }

  #interact(client, id) {
    const e = this.entities.get(id);
    if (!e) return;
    const d = Math.hypot(e.position[0] - client.position[0], e.position[2] - client.position[2]);
    if (d > 8) return;
    if (e.vehicle) {
      if (!e.driver) { e.driver = client.id; this.#send(client, { t: 'mount', id: e.id, speed: e.vehicle.speed }); }
      else if (e.driver === client.id) { e.driver = null; this.#send(client, { t: 'unmount', id: e.id }); }
      else this.#tell(client, 'someone is already driving that');
    }
    if (e.interactH) this.#callMod(e.mod, e.interactH, [this.#playerView(client), e.id]);
  }

  #use(client, key) {
    const item = this.items.find(i => i.key === key);
    if (item?.h) this.#callMod(item.mod, item.h, [this.#playerView(client)]);
  }

  #playerView(c) { return { id: c.id, name: c.name, position: c.position, look: c.look }; }

  // ---------- simulation ----------
  #tick(dt) {
    try { this.#step(dt); } catch (e) { console.error(`[${this.id}] tick error:`, e); }
  }

  #step(dt) {
    this.t += dt;
    if (this.clients.size === 0) return; // pause empty rooms

    for (const mod of this.mods.values()) {
      if (mod.status !== 'live') continue;
      for (const h of mod.ticks) this.#callMod(mod.id, h, [dt, this.t]);
      for (const en of mod.enters) {
        const e = this.entities.get(en.id);
        if (!e) continue;
        for (const c of this.clients.values()) {
          const d = Math.hypot(e.position[0] - c.position[0], e.position[1] - (c.position[1] + 0.9), e.position[2] - c.position[2]);
          const inside = d < en.radius;
          if (inside && !en.inside.has(c.id)) { en.inside.add(c.id); this.#callMod(mod.id, en.h, [this.#playerView(c), e.id]); }
          else if (!inside) en.inside.delete(c.id);
        }
      }
    }

    // very small physics for dynamic bodies: gravity, ground bounce, player kicks
    const g = this.world.gravity;
    for (const e of this.entities.values()) {
      if (e.physics !== 'dynamic') continue;
      const v = e.velocity;
      v[1] -= g * dt;
      for (const c of this.clients.values()) {
        const dx = e.position[0] - c.position[0], dz = e.position[2] - c.position[2];
        const dy = e.position[1] - (c.position[1] + 0.8);
        const d = Math.hypot(dx, dz);
        if (d < e.shape.radius + 0.45 && Math.abs(dy) < e.shape.radius + 1) {
          const n = d || 1;
          v[0] = (dx / n) * 7; v[2] = (dz / n) * 7; v[1] = Math.max(v[1], 4);
        }
      }
      for (let i = 0; i < 3; i++) e.position[i] += v[i] * dt;
      const floor = -e.shape.bottom;
      if (e.position[1] < floor) {
        e.position[1] = floor;
        v[1] = Math.abs(v[1]) > 1 ? -v[1] * 0.55 : 0;
        v[0] *= 0.9; v[2] *= 0.9;
      }
      if (Math.abs(e.position[0]) > LIMITS.worldRadius || Math.abs(e.position[2]) > LIMITS.worldRadius) { this.#removeEntity(e.id); continue; }
      if (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]) > 0.01) this.dirty.add(e.id);
    }

    const ents = [];
    for (const id of this.dirty) {
      const e = this.entities.get(id);
      if (e) ents.push([id, e.position.map(r3), e.rotation.map(r3)]);
    }
    this.dirty.clear();
    const players = [...this.clients.values()].map(c => [c.id, c.name, c.position.map(r3), r3(c.ry)]);
    this.#broadcast({ t: 'tick', ents, players });
  }

  // ---------- persistence ----------
  #save() {
    const mods = [...this.mods.values()].filter(m => m.status === 'live' && m.code)
      .map(({ id, prompt, author, here, code }) => ({ id, prompt, author, here, code }));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ mods }, null, 1));
  }

  #restore() {
    if (!fs.existsSync(this.file)) return;
    try {
      const { mods } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const m of mods) {
        const mod = { ...m, status: 'building', error: null, ticks: [], enters: [], worldSet: {} };
        this.mods.set(m.id, mod);
        const err = this.#tryInstall(mod, m.code);
        mod.status = err ? 'failed' : 'live';
        mod.error = err;
      }
      console.log(`[${this.id}] restored ${mods.length} mod(s)`);
    } catch (e) { console.warn(`[${this.id}] restore failed:`, e.message); }
  }

  // ---------- messaging ----------
  #publicEntity(e) {
    return { id: e.id, mod: e.mod, name: e.name, parts: e.parts, position: e.position, rotation: e.rotation, solid: e.solid, physics: e.physics, prompt: e.prompt, vehicle: e.vehicle };
  }
  #publicItems() { return this.items.map(({ key, name, icon }) => ({ key, name, icon })); }
  #publicMods() {
    return [...this.mods.values()].map(m => ({ id: m.id, prompt: m.prompt, author: m.author.name, status: m.status, error: m.error, ms: m.ms }));
  }
  #broadcastMods() { this.#broadcast({ t: 'mods', mods: this.#publicMods() }); }
  #system(s) { this.#broadcast({ t: 'msg', from: null, text: s, sys: true }); }
  #tell(c, s) { this.#send(c, { t: 'msg', from: null, text: s, sys: true }); }
  #send(c, m) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
  #broadcast(m) { const s = JSON.stringify(m); for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(s); }

  close() { clearInterval(this.timer); for (const m of this.mods.values()) m.sandbox?.dispose(); }
}

const r3 = v => Math.round(v * 1000) / 1000;
