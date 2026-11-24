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
      physics: o.physics === 'dynamic' ? 'dynamic' : 'static',
      velocity: __v(o.velocity, [0, 0, 0]),
    };
    __ents[id] = { position: e.position.slice(), rotation: e.rotation.slice() };
    __ops.push(e);
    return id;
  },
  get(id) { const e = __ents[id]; return e ? { position: e.position.slice(), rotation: e.rotation.slice() } : null; },
  move(id, position) { if (!__ents[id]) return; __ents[id].position = __v(position, __ents[id].position); __ops.push({ op: 'update', id, position: __ents[id].position }); },
  rotate(id, rotation) { if (!__ents[id]) return; __ents[id].rotation = __v(rotation, __ents[id].rotation); __ops.push({ op: 'update', id, rotation: __ents[id].rotation }); },
  push(id, velocity) { __ops.push({ op: 'push', id, velocity: __v(velocity, [0, 0, 0]) }); },
  remove(id) { delete __ents[id]; __ops.push({ op: 'remove', id }); },
  setGravity(g) { __ops.push({ op: 'world', key: 'gravity', value: Number(g) }); },
  setSky(color) { __ops.push({ op: 'world', key: 'sky', value: String(color) }); },
  setFog(color, near, far) { __ops.push({ op: 'world', key: 'fog', value: [String(color), Number(near), Number(far)] }); },
  onTick(fn) { __ops.push({ op: 'tick', h: __h(fn) }); },
  onEnter(id, radius, fn) { __ops.push({ op: 'enter', id, radius: Number(radius) || 2, h: __h(fn) }); },
  broadcast(text) { __ops.push({ op: 'msg', to: null, text: String(text) }); },
};

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

function __call(h, args, ps) {
  __players = ps || [];
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
  call(h, args, players) {
    if (this.disposed) return [];
    try {
      this.#eval(`__call(${JSON.stringify(h)}, ${JSON.stringify(args)}, ${JSON.stringify(players)})`, CALL_MS);
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
  const fence = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/i);
  let code = fence ? fence[1] : text;
  code = code.replace(/^\s*(import|export)\s.*$/gm, '');
  return code.trim();
}
