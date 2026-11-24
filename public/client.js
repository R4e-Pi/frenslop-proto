import * as THREE from 'three';

const $ = id => document.getElementById(id);
const ROOM = (location.pathname.split('/')[2] || 'lobby').toLowerCase();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('game').append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#7fb3e6');
scene.fog = new THREE.Fog('#b8d3ea', 70, 320);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 2500);
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xe3f1ff, 0x48652a, 1.2));
const sun = new THREE.DirectionalLight(0xfff1d8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 260 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- scenery
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = rng(7);
  g.fillStyle = '#4e8d2f';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 7000; i++) {
    const l = 30 + r() * 12, s = 45 + r() * 15, h = 86 + r() * 14;
    g.fillStyle = `hsl(${h} ${s}% ${l}%)`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 2 + r() * 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(260, 260);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

{ // grass tufts
  const r = rng(11);
  const geo = new THREE.ConeGeometry(0.08, 0.4, 3);
  geo.translate(0, 0.2, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true }), 5000);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < mesh.count; i++) {
    const a = r() * Math.PI * 2, d = 4 + Math.sqrt(r()) * 170;
    p.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4));
    const k = 0.5 + r() * 0.6;
    s.set(k, k * (0.7 + r() * 0.8), k);
    mesh.setMatrixAt(i, m.compose(p, q, s));
    mesh.setColorAt(i, col.setHSL(0.25 + r() * 0.05, 0.5, 0.26 + r() * 0.12));
  }
  scene.add(mesh);
}

{ // hills + snowy mountains ring (outside the play area)
  const r = rng(23);
  // distant mountains skip fog so they read as a backdrop, tinted for haze instead
  const rock = new THREE.MeshStandardMaterial({ color: '#8d97a8', roughness: 1, flatShading: true, fog: false });
  const snow = new THREE.MeshStandardMaterial({ color: '#f2f5fb', roughness: 0.9, flatShading: true, fog: false });
  const hill = new THREE.MeshStandardMaterial({ color: '#4c8a33', roughness: 1, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = 230 + r() * 90, w = 50 + r() * 70;
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), hill);
    m.scale.set(w, w * (0.18 + r() * 0.15), w);
    m.position.set(Math.cos(a) * d, -2, Math.sin(a) * d);
    scene.add(m);
  }
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2 + r() * 0.1, d = 380 + r() * 200;
    const h = 80 + r() * 150, w = 55 + r() * 70;
    const mtn = new THREE.Mesh(new THREE.ConeGeometry(w, h, 6 + Math.floor(r() * 3)), rock);
    mtn.position.set(Math.cos(a) * d, h / 2 - 4, Math.sin(a) * d);
    mtn.rotation.y = r() * 6;
    const capH = h * (0.3 + r() * 0.12);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(w * (capH / h) * 1.04, capH, mtn.geometry.parameters.radialSegments), snow);
    cap.position.y = h / 2 - capH / 2 + 0.5;
    mtn.add(cap);
    scene.add(mtn);
  }
}

// ---------------------------------------------------------------- shapes
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 28, 18),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  cone: new THREE.ConeGeometry(0.5, 1, 24),
  capsule: (() => { const g = new THREE.CapsuleGeometry(0.5, 1, 8, 18); g.scale(1, 0.5, 1); return g; })(),
};
const torusCache = new Map();
function torusGeo(tube) {
  const t = Math.round(tube * 100) / 100;
  if (!torusCache.has(t)) { const tr = t * 0.5; torusCache.set(t, new THREE.TorusGeometry(0.5 - tr, tr, 14, 48)); }
  return torusCache.get(t);
}
const matCache = new Map();
function material(p) {
  const key = `${p.color}|${p.emissive}|${p.opacity}`;
  if (!matCache.has(key)) {
    const c = new THREE.Color();
    try { c.setStyle(p.color); } catch { c.set('#cccccc'); }
    matCache.set(key, new THREE.MeshStandardMaterial({
      color: c, roughness: 0.75, metalness: 0.05,
      emissive: p.emissive ? c : 0x000000, emissiveIntensity: p.emissive ? 0.9 : 0,
      transparent: p.opacity < 1, opacity: p.opacity, depthWrite: p.opacity >= 1,
    }));
  }
  return matCache.get(key);
}

// ---------------------------------------------------------------- entities
const ents = new Map();
const tmpV = new THREE.Vector3();

function buildGroup(e) {
  const g = new THREE.Group();
  for (const p of e.parts) {
    const m = new THREE.Mesh(p.shape === 'torus' ? torusGeo(p.tube) : GEO[p.shape] || GEO.box, material(p));
    m.position.fromArray(p.offset);
    m.rotation.set(...p.rotation);
    m.scale.fromArray(p.size);
    m.castShadow = p.opacity >= 1;
    m.receiveShadow = true;
    m.userData.eid = e.id;
    g.add(m);
  }
  g.position.fromArray(e.position);
  g.rotation.set(...e.rotation);
  return g;
}

function computeBoxes(rec) {
  rec.group.updateMatrixWorld(true);
  rec.boxes = rec.data.solid && rec.data.physics !== 'dynamic'
    ? rec.group.children.map(m => new THREE.Box3().setFromObject(m)) : [];
}

function addEntity(e) {
  const old = ents.get(e.id);
  if (old && JSON.stringify(old.data.parts) === JSON.stringify(e.parts)) {
    old.data = e; // prompt / vehicle changed only
    computeBoxes(old);
    return;
  }
  if (old) removeEntity(e.id);
  const group = buildGroup(e);
  scene.add(group);
  const rec = { data: e, group, tp: group.position.clone(), tr: group.rotation.clone(), delta: new THREE.Vector3(), boxes: [] };
  computeBoxes(rec);
  ents.set(e.id, rec);
}

function removeEntity(id) {
  const rec = ents.get(id);
  if (!rec) return;
  scene.remove(rec.group);
  ents.delete(id);
  if (drive?.id === id) endDrive();
}

function updateEntities(dt) {
  const k = 1 - Math.exp(-dt * 14);
  for (const [id, rec] of ents) {
    if (drive?.id === id) { rec.delta.set(0, 0, 0); continue; }
    const g = rec.group;
    tmpV.copy(g.position);
    g.position.lerp(rec.tp, k);
    const dr = Math.abs(rec.tr.x - g.rotation.x) + Math.abs(rec.tr.y - g.rotation.y) + Math.abs(rec.tr.z - g.rotation.z);
    if (dr > 1e-4) g.rotation.set(g.rotation.x + (rec.tr.x - g.rotation.x) * k, g.rotation.y + (rec.tr.y - g.rotation.y) * k, g.rotation.z + (rec.tr.z - g.rotation.z) * k);
    rec.delta.subVectors(g.position, tmpV);
    if (rec.boxes.length && (rec.delta.lengthSq() > 1e-10 || dr > 1e-4)) computeBoxes(rec);
  }
}

// ---------------------------------------------------------------- other players
const others = new Map();
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 360) / 360; }
function nameSprite(name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 34px system-ui, sans-serif';
  const w = Math.min(248, g.measureText(name).width + 28);
  g.fillStyle = 'rgba(10,16,22,0.65)';
  g.beginPath(); g.roundRect((256 - w) / 2, 8, w, 48, 24); g.fill();
  g.fillStyle = '#f3efe6'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, 128, 33, 230);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(1.6, 0.4, 1);
  s.position.y = 2.15;
  return s;
}
function makeAvatar(id, name) {
  const g = new THREE.Group();
  const col = new THREE.Color().setHSL(hue(name + id), 0.6, 0.55);
  const body = new THREE.Mesh(GEO.capsule, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }));
  body.scale.set(0.7, 1.4, 0.7); body.position.y = 0.75; body.castShadow = true;
  const head = new THREE.Mesh(GEO.sphere, new THREE.MeshStandardMaterial({ color: '#f1d2b0', roughness: 0.8 }));
  head.scale.setScalar(0.5); head.position.y = 1.65; head.castShadow = true;
  const visor = new THREE.Mesh(GEO.box, new THREE.MeshStandardMaterial({ color: '#1b1f27', roughness: 0.3 }));
  visor.scale.set(0.36, 0.12, 0.1); visor.position.set(0, 1.68, -0.24);
  g.add(body, head, visor, nameSprite(name));
  scene.add(g);
  return { group: g, name, tp: new THREE.Vector3(), ry: 0 };
}

// ---------------------------------------------------------------- local player
const me = { id: null, name: 'fren', pos: new THREE.Vector3(0, 0, 8), vel: new THREE.Vector3(), yaw: 0, pitch: 0, onGround: true, standingOn: null, crouch: false };
const world = { gravity: 9.8 };
const keys = new Set();
let mode = 'menu';   // menu | play | mods | chat
let drive = null;    // { id, speed, v }
let items = [], slot = 0, lastUse = 0;
const R = 0.35;
const JUMP_V = 5.2;

function solids() {
  const out = [];
  for (const [id, rec] of ents) {
    if (drive?.id === id || !rec.boxes.length) continue;
    if (rec.group.position.distanceToSquared(me.pos) > 120 * 120 && rec.boxes.length < 4) continue;
    for (const b of rec.boxes) out.push([id, b]);
  }
  return out;
}

function overlaps(b, H) {
  return me.pos.x + R > b.min.x && me.pos.x - R < b.max.x &&
         me.pos.z + R > b.min.z && me.pos.z - R < b.max.z &&
         me.pos.y + H > b.min.y && me.pos.y < b.max.y;
}

function stepPlayer(dt) {
  if (drive) return stepDrive(dt);
  const H = me.crouch ? 1.1 : 1.7;
  const playing = mode === 'play';
  const f = playing ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0;
  const s = playing ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0;
  me.crouch = playing && keys.has('KeyC');
  const speed = me.crouch ? 3 : keys.has('ShiftLeft') || keys.has('ShiftRight') ? 10 : 6;
  const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
  const wish = new THREE.Vector3(-sin * f + cos * s, 0, -cos * f - sin * s);
  if (wish.lengthSq() > 1) wish.normalize();
  const a = 1 - Math.exp(-dt * (me.onGround ? 12 : 2.5));
  me.vel.x += (wish.x * speed - me.vel.x) * a;
  me.vel.z += (wish.z * speed - me.vel.z) * a;
  if (playing && keys.has('Space') && me.onGround) { me.vel.y = JUMP_V; me.onGround = false; }
  me.vel.y = Math.max(me.vel.y - world.gravity * dt, -60);

  // ride along with moving platforms
  if (me.standingOn) { const rec = ents.get(me.standingOn); if (rec) me.pos.add(rec.delta); }

  const boxes = solids();
  for (const axis of ['x', 'z']) {
    me.pos[axis] += me.vel[axis] * dt;
    for (const [, b] of boxes) {
      if (!overlaps(b, H)) continue;
      if (b.max.y - me.pos.y <= 0.5 && me.onGround) { me.pos.y = b.max.y; continue; } // step up
      me.pos[axis] = me.vel[axis] > 0 ? b.min[axis] - R - 1e-3 : b.max[axis] + R + 1e-3;
      me.vel[axis] = 0;
    }
  }
  me.pos.y += me.vel.y * dt;
  me.onGround = false;
  me.standingOn = null;
  for (const [id, b] of boxes) {
    if (!overlaps(b, H)) continue;
    if (me.vel.y <= 0 && me.pos.y > b.max.y - 0.6) { me.pos.y = b.max.y; me.vel.y = 0; me.onGround = true; me.standingOn = id; }
    else if (me.vel.y > 0) { me.pos.y = b.min.y - H - 1e-3; me.vel.y = 0; }
  }
  if (me.pos.y <= 0) { me.pos.y = 0; me.vel.y = Math.max(0, me.vel.y); me.onGround = true; }
  if (me.pos.y < -60 || !Number.isFinite(me.pos.y)) { me.pos.set(0, 0, 8); me.vel.set(0, 0, 0); }

  camera.position.set(me.pos.x, me.pos.y + (me.crouch ? 1.0 : 1.6), me.pos.z);
}

function stepDrive(dt) {
  const rec = ents.get(drive.id);
  if (!rec) return endDrive();
  const g = rec.group;
  const playing = mode === 'play';
  const throttle = playing ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0;
  const steer = playing ? (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) : 0;
  drive.v += (throttle * drive.speed - drive.v) * (1 - Math.exp(-dt * 2.5));
  g.rotation.y += steer * 1.9 * dt * Math.sign(drive.v || 1) * Math.min(1, Math.abs(drive.v) / 2 + 0.3);
  g.position.x += -Math.sin(g.rotation.y) * drive.v * dt;
  g.position.z += -Math.cos(g.rotation.y) * drive.v * dt;
  rec.tp.copy(g.position);
  rec.tr.copy(g.rotation);
  me.pos.copy(g.position);
  camera.position.set(g.position.x, g.position.y + 1.75, g.position.z);
}

function startDrive(id, speed) {
  drive = { id, speed, v: 0 };
  $('driving').hidden = false;
}
function endDrive() {
  const rec = drive && ents.get(drive.id);
  if (rec) {
    const g = rec.group;
    me.pos.set(g.position.x + Math.cos(g.rotation.y) * 1.6, g.position.y, g.position.z - Math.sin(g.rotation.y) * 1.6);
    computeBoxes(rec);
  }
  drive = null;
  me.vel.set(0, 0, 0);
  $('driving').hidden = true;
}

// ---------------------------------------------------------------- held item viewmodel
const held = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
held.position.set(0.5, -0.36, -0.9);
held.scale.setScalar(0.2);
held.renderOrder = 10;
camera.add(held);
const emojiTex = new Map();
function emojiTexture(e) {
  if (!emojiTex.has(e)) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '100px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(e, 64, 70);
    emojiTex.set(e, new THREE.CanvasTexture(c));
  }
  return emojiTex.get(e);
}
function updateHeld() {
  const it = items[slot];
  held.visible = !!it && !drive;
  if (it) { held.material.map = emojiTexture(it.icon); held.material.needsUpdate = true; }
}

// ---------------------------------------------------------------- interaction raycast
const ray = new THREE.Raycaster();
ray.far = 5;
let target = null;
function updateTarget() {
  target = null;
  if (mode !== 'play') { $('prompt').hidden = true; return; }
  if (drive) {
    const rec = ents.get(drive.id);
    target = rec ? { id: drive.id, prompt: 'get off' } : null;
  } else {
    const meshes = [];
    for (const rec of ents.values()) if (rec.data.prompt) meshes.push(...rec.group.children);
    if (meshes.length) {
      ray.setFromCamera({ x: 0, y: 0 }, camera);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) { const rec = ents.get(hit.object.userData.eid); if (rec) target = { id: rec.data.id, prompt: rec.data.prompt }; }
    }
  }
  $('prompt').hidden = !target;
  if (target) $('prompt').querySelector('.prompt-text').textContent = target.prompt;
}

// ---------------------------------------------------------------- network
let ws, sendTimer, retry = 0;
const send = m => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(ROOM)}&name=${encodeURIComponent(me.name)}`);
  ws.onopen = () => { retry = 0; };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus('disconnected — retrying…');
    setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      me.id = m.you.id;
      for (const id of [...ents.keys()]) removeEntity(id);
      for (const o of others.values()) scene.remove(o.group);
      others.clear();
      m.entities.forEach(addEntity);
      applyWorld(m.world);
      setItems(m.items);
      renderMods(m.mods);
      setStatus(`room <b>${escapeHtml(m.room)}</b> · connected`);
      break;
    case 'ent+': addEntity(m.e); break;
    case 'ent-': removeEntity(m.id); break;
    case 'world': applyWorld(m.world); break;
    case 'items': setItems(m.items); break;
    case 'mods': renderMods(m.mods); break;
    case 'msg': feed(m.from, m.text, m.sys ? 'sys' : m.mod ? 'mod' : ''); break;
    case 'teleport': if (drive) endDrive(); me.pos.fromArray(m.p); me.vel.set(0, 0, 0); break;
    case 'launch': if (!drive) { me.vel.fromArray(m.v); me.onGround = false; me.pos.y += 0.05; } break;
    case 'mount': startDrive(m.id, m.speed); break;
    case 'unmount': if (drive?.id === m.id) endDrive(); break;
    case 'gone': { const o = others.get(m.id); if (o) { scene.remove(o.group); others.delete(m.id); } break; }
    case 'tick':
      for (const [id, p, r] of m.ents) {
        const rec = ents.get(id);
        if (!rec || drive?.id === id) continue;
        rec.tp.fromArray(p);
        rec.tr.set(r[0], r[1], r[2]);
      }
      for (const [id, name, p, ry] of m.players) {
        if (id === me.id) continue;
        let o = others.get(id);
        if (!o || o.name !== name) { if (o) scene.remove(o.group); o = makeAvatar(id, name); o.group.position.fromArray(p); others.set(id, o); }
        o.tp.fromArray(p); o.ry = ry;
      }
      break;
  }
}

function startSending() {
  clearInterval(sendTimer);
  sendTimer = setInterval(() => {
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    send({ t: 'state', p: me.pos.toArray(), look: look.toArray(), ry: me.yaw });
    if (drive) { const rec = ents.get(drive.id); if (rec) send({ t: 'drive', id: drive.id, p: rec.group.position.toArray(), r: [rec.group.rotation.x, rec.group.rotation.y, rec.group.rotation.z] }); }
  }, 1000 / 15);
}

function applyWorld(w) {
  world.gravity = w.gravity;
  scene.background.set(w.sky);
  scene.fog.color.set(w.fog[0]);
  scene.fog.near = w.fog[1];
  scene.fog.far = w.fog[2];
}

// ---------------------------------------------------------------- UI
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(html) { $('status').innerHTML = html; }

function feed(from, text, cls = '') {
  const el = document.createElement('div');
  el.className = `line ${cls}`;
  el.innerHTML = (from ? `<b>${escapeHtml(from)}</b>` : '') + escapeHtml(text);
  $('feed').append(el);
  while ($('feed').children.length > 8) $('feed').firstChild.remove();
  setTimeout(() => el.classList.add('fade'), 14000);
  setTimeout(() => el.remove(), 15500);
}

function setItems(list) {
  items = list;
  slot = Math.min(slot, Math.max(0, items.length - 1));
  renderHotbar();
}
function renderHotbar() {
  const bar = $('hotbar');
  bar.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const it = items[i];
    const el = document.createElement('div');
    el.className = 'slot' + (i === slot && it ? ' on' : '');
    el.innerHTML = `<span class="n">${i + 1}</span>${it ? escapeHtml(it.icon) : ''}${it ? `<span class="label">${escapeHtml(it.name)}</span>` : ''}`;
    bar.append(el);
  }
  updateHeld();
}

function renderMods(mods) {
  const ul = $('modlist');
  ul.innerHTML = '';
  for (const m of [...mods].reverse()) {
    const li = document.createElement('li');
    const meta = m.status === 'failed' || m.status === 'crashed' ? escapeHtml(m.error || '') : `by ${escapeHtml(m.author)}${m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}`;
    li.innerHTML = `<span class="what"><span class="p" title="${escapeHtml(m.prompt)}">${escapeHtml(m.prompt)}</span><span class="meta">${meta}</span></span>
      <span class="state ${m.status}">${m.status === 'building' ? 'building…' : m.status}</span>
      <button title="remove" aria-label="remove mod">×</button>`;
    li.querySelector('button').onclick = () => send({ t: 'unmod', id: m.id });
    ul.append(li);
  }
}

function lock() { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); }

function setMode(next) {
  mode = next;
  $('menu').hidden = next !== 'menu';
  $('hud').hidden = next === 'menu';
  $('modpanel').hidden = next !== 'mods';
  $('chatform').hidden = next !== 'chat';
  if (next === 'mods') { setTimeout(() => $('modinput').focus(), 0); }
  if (next === 'chat') { setTimeout(() => $('chatinput').focus(), 0); }
  if (next !== 'play') keys.clear();
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement) setMode('play');
  else if (mode === 'play') setMode('menu');
});

addEventListener('mousemove', e => {
  if (mode !== 'play') return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * 0.0022));
});

addEventListener('mousedown', e => {
  if (mode !== 'play' || e.button !== 0) return;
  const it = items[slot];
  if (it && performance.now() - lastUse > 180) { lastUse = performance.now(); send({ t: 'use', key: it.key }); }
});
addEventListener('wheel', e => {
  if (mode !== 'play' || !items.length) return;
  slot = (slot + (e.deltaY > 0 ? 1 : -1) + items.length) % items.length;
  renderHotbar();
});

addEventListener('keydown', e => {
  if (mode === 'mods' || mode === 'chat') {
    if (e.key === 'Escape') { e.preventDefault(); lock(); }
    return;
  }
  if (mode !== 'play') return;
  if (e.code === 'Tab') { e.preventDefault(); showScores(true); return; }
  if (e.code === 'KeyK') { e.preventDefault(); setMode('mods'); document.exitPointerLock(); return; }
  if (e.code === 'Enter') { e.preventDefault(); setMode('chat'); document.exitPointerLock(); return; }
  if (e.code === 'KeyE' && target) { send({ t: 'interact', id: target.id }); return; }
  if (/^Digit[1-8]$/.test(e.code)) { const n = +e.code.slice(5) - 1; if (items[n]) { slot = n; renderHotbar(); } return; }
  keys.add(e.code);
});
addEventListener('keyup', e => {
  keys.delete(e.code);
  if (e.code === 'Tab') showScores(false);
});
addEventListener('blur', () => keys.clear());

function showScores(on) {
  $('scores').hidden = !on;
  if (!on) return;
  const names = [`${me.name} (you)`, ...[...others.values()].map(o => o.name)];
  $('scorelist').innerHTML = names.map(n => `<li>${escapeHtml(n)}</li>`).join('');
}

$('modform').onsubmit = e => {
  e.preventDefault();
  const prompt = $('modinput').value.trim();
  if (!prompt) return;
  send({ t: 'mod', prompt });
  $('modinput').value = '';
  lock();
};
$('chatform').onsubmit = e => {
  e.preventDefault();
  const text = $('chatinput').value.trim();
  if (text) send({ t: 'chat', text });
  $('chatinput').value = '';
  lock();
};

$('name').value = store.get('name') || '';
$('play').onclick = () => {
  const n = $('name').value.trim().slice(0, 20);
  if (n && n !== me.name) { me.name = n; store.set('name', n); send({ t: 'name', name: n }); }
  lock();
};
$('invite').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('invite').textContent = 'copied!'; }
  catch { $('invite').textContent = location.href; }
  setTimeout(() => { $('invite').textContent = 'copy invite link'; }, 1800);
};

fetch('/api/status').then(r => r.json()).then(s => {
  $('llm-chip').textContent = s.provider === 'mock' ? 'mock model' : `local · ${s.model}`;
}).catch(() => {});

// ---------------------------------------------------------------- loop
me.name = store.get('name') || 'fren';
connect();
startSending();
renderHotbar();

const clock = new THREE.Clock();
let frames = 0;
setInterval(() => { window.__fps = frames; frames = 0; }, 1000);
function frame() {
  // fixed 60 Hz physics steps so game time keeps pace with real time even at low fps
  const dt = Math.min(clock.getDelta(), 0.25);
  for (let acc = dt; acc > 1e-6; acc -= 1 / 60) {
    const h = Math.min(acc, 1 / 60);
    updateEntities(h);
    stepPlayer(h);
  }
  frames++;
  camera.rotation.set(me.pitch, me.yaw, 0, 'YXZ');
  const k = 1 - Math.exp(-dt * 12);
  for (const o of others.values()) {
    o.group.position.lerp(o.tp, k);
    o.group.rotation.y = o.ry;
  }
  sun.position.set(me.pos.x + 45, 90, me.pos.z + 30);
  sun.target.position.copy(me.pos);
  updateTarget();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// debug/automation hook (used by the headless demo script)
window.__game = { me, ents, send, setMode, keys, get items() { return items; }, set slot(v) { slot = v; renderHotbar(); }, get mode() { return mode; } };
