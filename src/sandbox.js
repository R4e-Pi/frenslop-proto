// Each mod runs in its own QuickJS (WASM) runtime with memory + time limits.
// The mod never touches the host: API calls inside the sandbox only record
// "ops" (plain JSON), which the room validates and applies afterwards.
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const QJS = await getQuickJS();

const LOAD_MS = 250;   // time budget for a mod's top-level code
const CALL_MS = 15;    // time budget per handler call (tick, use, interact...)
const MEMORY = 16 * 1024 * 1024;

// Runs inside the sandbox before the mod's code. Everything here is the mod API.
const PRELUDE = (modId, ctx) => `
'use strict';
const __ops = [];
const __handlers = {};
const __ents = {};
let __hid = 0, __eid = 0, __players = [];
const __MOD = ${JSON.stringify(modId)};
const here = ${JSON.stringify(ctx.here)};
const author = ${JSON.stringify(ctx.author)};

function __h(fn) {
  if (typeof fn !== 'function') return null;
  const id = 'h' + (++__hid);
  __handlers[id] = fn;
  return id;
}
function __v(a, d) {
  if (!Array.isArray(a)) return d.slice();
  return [0, 1, 2].map(i => (typeof a[i] === 'number' && isFinite(a[i])) ? a[i] : d[i]);
}

const world = {
  spawn(o) {
    o = o || {};
    const id = __MOD + ':' + (++__eid);
    const e = {
      op: 'spawn', id,
      name: String(o.name || 'thing'),
      parts: Array.isArray(o.parts) && o.parts.length ? o.parts : [{ shape: 'box' }],
      position: __v(o.position, [0, 0, 0]),
      rotation: __v(o.rotation, [0, 0, 0]),
      solid: o.solid !== false,
      physics: o.physics === 'dynamic' || o.physics === 'kinematic' ? o.physics : 'static',
      velocity: __v(o.velocity, [0, 0, 0]),
      spin: __v(o.spin, [0, 0, 0]),
      material: o.material ? String(o.material) : null,
      mass: Number(o.mass) || 0,
      friction: o.friction === undefined ? null : Number(o.friction),
      bounciness: o.bounciness === undefined ? null : Number(o.bounciness),
      bullet: !!o.bullet,
    };
    __checkGround(e);
    __ents[id] = { position: e.position.slice(), rotation: e.rotation.slice(), velocity: e.velocity.slice() };
    __ops.push(e);
    return id;
  },
  // live state: dynamic bodies report their simulated position/rotation/velocity
  get(id) { const e = __ents[id]; return e ? { position: e.position.slice(), rotation: e.rotation.slice(), velocity: (e.velocity || [0, 0, 0]).slice() } : null; },
  move(id, position) { if (!__ents[id]) return; __ents[id].position = __v(position, __ents[id].position); __ops.push({ op: 'update', id, position: __ents[id].position }); },
  rotate(id, rotation) { if (!__ents[id]) return; __ents[id].rotation = __v(rotation, __ents[id].rotation); __ops.push({ op: 'update', id, rotation: __ents[id].rotation }); },
  push(id, velocity) { __ops.push({ op: 'push', id, velocity: __v(velocity, [0, 0, 0]) }); },
  // physics (SI units): impulse N·s (instant kick), force N (this tick; call from onTick to keep
  // pushing), spin rad/s (angular velocity)
  impulse(id, j) { __ops.push({ op: 'impulse', id, value: __v(j, [0, 0, 0]) }); },
  force(id, F) { __ops.push({ op: 'force', id, value: __v(F, [0, 0, 0]) }); },
  spin(id, w) { __ops.push({ op: 'spin', id, value: __v(w, [0, 0, 0]) }); },
  // joints connect two bodies at a world-space anchor; b = null attaches a to the fixed world
  hinge(a, b, o) { return __joint('hinge', a, b, o); },
  slider(a, b, o) { return __joint('slider', a, b, o); },
  ball(a, b, o) { return __joint('ball', a, b, o); },
  weld(a, b, o) { return __joint('weld', a, b, o); },
  rope(a, b, o) { return __joint('rope', a, b, o); },
  unjoin(jid) { __ops.push({ op: 'unjoint', id: jid }); },
  // impacts: fn(otherId, speed m/s, point) — otherId is an entity id, a player id or 'ground'
  onHit(id, fn) { __ops.push({ op: 'hit', id, h: __h(fn) }); },
  remove(id) { delete __ents[id]; __ops.push({ op: 'remove', id }); },
  setGravity(g) { __ops.push({ op: 'world', key: 'gravity', value: Number(g) }); },
  setSky(color) { __ops.push({ op: 'world', key: 'sky', value: String(color) }); },
  setFog(color, near, far) { __ops.push({ op: 'world', key: 'fog', value: [String(color), Number(near), Number(far)] }); },
  onTick(fn) { __ops.push({ op: 'tick', h: __h(fn) }); },
  onEnter(id, radius, fn) { __ops.push({ op: 'enter', id, radius: Number(radius) || 2, h: __h(fn) }); },
  broadcast(text) { __ops.push({ op: 'msg', to: null, text: String(text) }); },
};

// Errors thrown here go back to the model as feedback for its retry, so they say what to do.
function __checkGround(e) {
  const flat = r => !Array.isArray(r) || r.every(v => Math.abs(Number(v) || 0) < 0.01);
  if (!flat(e.rotation) || !e.parts.every(p => flat(p && p.rotation))) return; // rotated: can't judge cheaply
  let low = Infinity;
  for (const p of e.parts) {
    const sy = Array.isArray(p.size) ? Number(p.size[1]) : Number(p.size);
    const oy = Array.isArray(p.offset) ? Number(p.offset[1]) || 0 : 0;
    low = Math.min(low, oy - (isFinite(sy) && sy > 0 ? sy : 1) / 2);
  }
  const depth = -(e.position[1] + low);
  if (depth > 0.1) throw new Error(e.name + ' starts ' + depth.toFixed(2) + ' m below the ground: spawn at y = 0 and build parts upward (a part of height h resting on the ground has offset y = h/2)');
}

let __jid = 0;
function __joint(kind, a, b, o) {
  o = o || {};
  if (!__ents[a]) throw new Error('world.' + kind + ': the first argument must be an id returned by world.spawn in this code');
  if (b && !__ents[b]) throw new Error('world.' + kind + ': the second argument must be an id from world.spawn, or null for the fixed world');
  if (!b) {
    if (kind === 'rope' && !Array.isArray(o.anchorB)) throw new Error('world.rope(' + 'thing, null, ...) hangs from the fixed world, so give anchorB: the fixed point it hangs from, above the thing (for example [x, 4, z] on a frame or post)');
    if (kind !== 'rope' && !Array.isArray(o.anchor)) throw new Error('world.' + kind + '(thing, null, ...) is pinned to the fixed world, so give anchor: the pivot point in world space');
  }
  if (kind === 'rope' && !b) {
    const top = __v(o.anchorB, [0, 0, 0]), bottom = __v(o.anchorA, __ents[a].position);
    if (top[1] <= bottom[1]) throw new Error('world.rope: the fixed point anchorB (y = ' + top[1] + ') must be above the point it holds, anchorA (y = ' + bottom[1] + ')');
  }
  const id = __MOD + ':j' + (++__jid);
  __ops.push({
    op: 'joint', id, kind, a, b: b || null,
    anchor: __v(o.anchor, (__ents[a] && __ents[a].position) || [0, 0, 0]),
    anchorA: o.anchorA ? __v(o.anchorA, [0, 0, 0]) : null, anchorB: o.anchorB ? __v(o.anchorB, [0, 0, 0]) : null,
    axis: __v(o.axis, kind === 'slider' ? [1, 0, 0] : [0, 1, 0]),
    limits: Array.isArray(o.limits) ? [Number(o.limits[0]) || 0, Number(o.limits[1]) || 0] : null,
    motorSpeed: Number(o.motorSpeed) || 0, maxTorque: Number(o.maxTorque) || 0, maxForce: Number(o.maxForce) || 0,
    length: Number(o.length) || 0, spring: !!o.spring, stiffness: Number(o.stiffness) || 0, damping: o.damping === undefined ? 0.3 : Number(o.damping),
  });
  return id;
}

function interact(id, o) {
  o = o || {};
  __ops.push({ op: 'interact', id, prompt: String(o.prompt || 'use'), h: __h(o.onInteract) });
}

const items = {
  register(o) {
    o = o || {};
    __ops.push({ op: 'item', name: String(o.name || 'item'), icon: String(o.icon || '?'), h: __h(o.onUse) });
  },
};

const vehicles = {
  make(id, o) {
    o = o || {};
    __ops.push({ op: 'vehicle', id, speed: Number(o.speed) || 8, prompt: o.prompt ? String(o.prompt) : null });
  },
};

const players = {
  list() { return __players.map(p => ({ ...p })); },
  teleport(pid, position) { __ops.push({ op: 'teleport', pid, position: __v(position, [0, 2, 0]) }); },
  launch(pid, velocity) { __ops.push({ op: 'launch', pid, velocity: __v(velocity, [0, 10, 0]) }); },
  message(pid, text) { __ops.push({ op: 'msg', to: pid, text: String(text) }); },
};

const console = { log(...a) { __ops.push({ op: 'log', text: a.map(String).join(' ') }); } };

function __call(h, args, ps, sync) {
  __players = ps || [];
  // fresh simulated state for this mod's moving bodies: [id, position, rotation, velocity]
  if (sync) for (const [id, p, r, v] of sync) if (__ents[id]) { __ents[id].position = p; __ents[id].rotation = r; __ents[id].velocity = v; }
  const f = __handlers[h];
  if (f) f(...args);
}
function __drain() { return JSON.stringify(__ops.splice(0)); }
`;

export class ModSandbox {
  constructor(modId, ctx) {
    this.modId = modId;
    this.rt = QJS.newRuntime();
    this.rt.setMemoryLimit(MEMORY);
    this.rt.setMaxStackSize(512 * 1024);
    this.vm = this.rt.newContext();
    this.errors = 0;
    this.disposed = false;
    this.#eval(PRELUDE(modId, ctx), LOAD_MS);
  }

  #eval(src, ms) {
    this.rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ms));
    const r = this.vm.evalCode(src, `mod-${this.modId}.js`);
    if (r.error) {
      const err = this.vm.dump(r.error);
      r.error.dispose();
      const msg = typeof err === 'object' && err ? `${err.name || 'Error'}: ${err.message || JSON.stringify(err)}` : String(err);
      const e = new Error(msg);
      const at = String(err?.stack || '').match(/mod-[^:]+\.js:(\d+)/);
      if (at) e.line = Number(at[1]);
      throw e;
    }
    const v = this.vm.dump(r.value);
    r.value.dispose();
    return v;
  }

  #drain() {
    return JSON.parse(this.#eval('__drain()', CALL_MS));
  }

  // Run the mod's top-level code. Throws on syntax/runtime error or timeout.
  load(code) {
    try {
      this.#eval(`(function () {\n${code}\n})();`, LOAD_MS);
    } catch (e) {
      // point the model at the offending line of ITS code (wrapper adds 1 line)
      const n = e.line ? e.line - 1 : 0;
      const src = n > 0 ? code.split('\n')[n - 1] : null;
      if (src != null) e.message += ` — at line ${n}: ${src.trim().slice(0, 120)}`;
      throw e;
    }
    return this.#drain();
  }

  // Call a registered handler. Errors are counted, never thrown to the room.
  call(h, args, players, sync = null) {
    if (this.disposed) return [];
    try {
      this.#eval(`__call(${JSON.stringify(h)}, ${JSON.stringify(args)}, ${JSON.stringify(players)}, ${JSON.stringify(sync)})`, CALL_MS);
    } catch (e) {
      this.errors++;
      this.lastError = e.message;
    }
    try { return this.#drain(); } catch { return []; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.vm.dispose();
    this.rt.dispose();
  }
}

// Strip markdown fences / imports a model might add around the code.
export function cleanModCode(text) {
  // 1) first complete ```js block; 2) an opened block the model never closed
  //    (take everything after the opening line); 3) otherwise the raw text.
  const closed = text.match(/```[a-z]*[^\S\n]*\n([\s\S]*?)```/i);
  const open = !closed && text.match(/```[a-z]*[^\S\n]*\n([\s\S]*)$/i);
  let code = closed ? closed[1] : open ? open[1] : text;
  code = code
    .replace(/^\s*import\s.*$/gm, '')                 // imports can't work in the sandbox
    .replace(/^(\s*)export\s+(default\s+)?/gm, '$1'); // keep the code, drop the keyword
  return code.trim();
}

// Small models often get brackets wrong, e.g. `world.spawn({ … parts: [ … ]);` (missing `}`).
// After a SyntaxError, balance (), [] and {} outside strings and comments: insert closers a
// later closer skips over, drop stray closers, append missing ones at the end. Only used when
// the original code didn't parse, and the result still has to load and do something.
export function repairBrackets(src) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let out = '', i = 0;
  const n = src.length;
  const copyUntil = j => { out += src.slice(i, j); i = j; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); copyUntil(j < 0 ? n : j); continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); copyUntil(j < 0 ? n : j + 2); continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      copyUntil(Math.min(n, j + 1)); continue;
    }
    if (c === '`') { // template literal, including ${ … } expressions
      let j = i + 1, depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '{') depth++;
        if (depth > 0 && src[j] === '}') depth--;
        j++;
      }
      copyUntil(Math.min(n, j + 1)); continue;
    }
    if (pairs[c]) { stack.push(c); out += c; i++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (stack.some(o => pairs[o] === c)) {
        while (pairs[stack[stack.length - 1]] !== c) out += pairs[stack.pop()]; // close what it skipped
        stack.pop();
        out += c;
      } // else: a closer with no opener at all, drop it
      i++; continue;
    }
    out += c; i++;
  }
  while (stack.length) out += pairs[stack.pop()];
  return out;
}
