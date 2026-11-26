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

// Theme: Bitmap district (from Bitmap Parcel World). Asphalt night, chalk light,
// parcel-orange land. Colors only; all gameplay is unchanged.
const THEME = {
  sky: '#232325', fog: ['#232325', 120, 340],
  asphalt: '#2c2c2f', asphalt2: '#303034',
  parcel: 0xd8722f, parcelSide: 0x6e250b,
  chalk: '#ece7e0', btc: '#f7931a',
  people: [0xc9c7c4, 0xd08a4f, 0xb7a89a, 0x6f7377],
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(THEME.sky);
scene.fog = new THREE.Fog(THEME.fog[0], THEME.fog[1], THEME.fog[2]);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 2500);
scene.add(camera);

// warm-white sky over a cool asphalt bounce, plain white key light
scene.add(new THREE.HemisphereLight(0xfff3e6, 0x404046, 1.25));
const sun = new THREE.DirectionalLight(0xffffff, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 260 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const SUN_OFF = new THREE.Vector3(-34, 70, -40);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- scenery
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function asphaltTexture() {
  // 8 m tiles of road asphalt: two-tone checker plus faint colored grit
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = rng(7);
  g.fillStyle = THEME.asphalt; g.fillRect(0, 0, 128, 128);
  g.fillStyle = THEME.asphalt2; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},0.025)`;
    g.fillRect(r() * 128, r() * 128, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2400 / 8, 2400 / 8);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

{ // Bitmap district: orange parcels packed Mondrian-style (biggest first, first free
  // slot), 12 m grid cells with 5 m roads between. Decoration only: the slabs are a
  // few cm thick, so the ground stays flat at y = 0 for players and mods.
  const U = 12, GAP = 5, SLAB = 0.06;
  const r = rng(800000);
  const sizes = [];
  for (let i = 0; i < 260; i++) { const v = r(); sizes.push(v < 0.55 ? 1 : v < 0.82 ? 2 : v < 0.95 ? 3 : 4); }
  sizes.sort((a, b) => b - a);
  const area = sizes.reduce((n, k) => n + k * k, 0);
  const GW = Math.ceil(Math.sqrt(area * 1.06));
  const occ = [];
  const row = y => { while (occ.length <= y) occ.push(new Uint8Array(GW)); return occ[y]; };
  const fits = (x, y, k) => { for (let j = 0; j < k; j++) { const rw = row(y + j); for (let i = 0; i < k; i++) if (rw[x + i]) return false; } return true; };
  const placed = [];
  for (const k of sizes) {
    let done = false;
    for (let y = 0; !done; y++) for (let x = 0; x + k <= GW && !done; x++) {
      if (!fits(x, y, k)) continue;
      for (let j = 0; j < k; j++) row(y + j).fill(1, x, x + k);
      placed.push([x, y, k]); done = true;
    }
  }
  const ox = -GW * U / 2, oz = -occ.length * U / 2;
  const top = new THREE.MeshStandardMaterial({ color: THEME.parcel, roughness: 0.93 });
  const side = new THREE.MeshStandardMaterial({ color: THEME.parcelSide, roughness: 0.95 });
  const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, SLAB, 1), [side, side, top, side, side, side], placed.length);
  const m = new THREE.Matrix4();
  placed.forEach(([x, y, k], i) => {
    const w = k * U - GAP;
    slabs.setMatrixAt(i, m.makeScale(w, 1, w).setPosition(ox + (x + k / 2) * U, SLAB / 2, oz + (y + k / 2) * U));
  });
  slabs.receiveShadow = true;
  slabs.frustumCulled = false;
  scene.add(slabs);
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
  const rec = { data: e, group, tp: group.position.clone(), tr: group.rotation.clone(), tq: null, delta: new THREE.Vector3(), boxes: [] };
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

const angleDiff = (to, from) => { const d = (to - from) % (Math.PI * 2); return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d; };
function updateEntities(dt) {
  const k = 1 - Math.exp(-dt * 14);
  for (const [id, rec] of ents) {
    if (drive?.id === id) { rec.delta.set(0, 0, 0); continue; }
    const g = rec.group;
    tmpV.copy(g.position);
    g.position.lerp(rec.tp, k);
    let dr = 0;
    if (rec.tq) {
      // physics bodies tumble freely: interpolate their orientation as a quaternion
      dr = 1 - Math.abs(g.quaternion.dot(rec.tq));
      if (dr > 1e-7) g.quaternion.slerp(rec.tq, k);
    } else {
      // angles arrive wrapped to (-π, π], so turn the short way around
      const ax = angleDiff(rec.tr.x, g.rotation.x), ay = angleDiff(rec.tr.y, g.rotation.y), az = angleDiff(rec.tr.z, g.rotation.z);
      dr = Math.abs(ax) + Math.abs(ay) + Math.abs(az);
      if (dr > 1e-4) g.rotation.set(g.rotation.x + ax * k, g.rotation.y + ay * k, g.rotation.z + az * k);
    }
    rec.delta.subVectors(g.position, tmpV);
    if (rec.boxes.length && (rec.delta.lengthSq() > 1e-10 || dr > 1e-4)) computeBoxes(rec);
  }
}

// ---------------------------------------------------------------- ropes (rope joints)
const ropes = new Map(); // id -> { data, mesh }
const ropeGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
ropeGeo.translate(0, 0.5, 0);
const ropeMat = new THREE.MeshStandardMaterial({ color: '#3a3a3e', roughness: 0.6, metalness: 0.4 });
const UP = new THREE.Vector3(0, 1, 0), ra = new THREE.Vector3(), rb = new THREE.Vector3(), rd = new THREE.Vector3();
function setRopes(list) {
  for (const r of ropes.values()) scene.remove(r.mesh);
  ropes.clear();
  for (const data of list || []) {
    const mesh = new THREE.Mesh(ropeGeo, ropeMat);
    mesh.castShadow = true;
    scene.add(mesh);
    ropes.set(data.id, { data, mesh });
  }
}
function updateRopes() {
  for (const { data, mesh } of ropes.values()) {
    const A = ents.get(data.a);
    if (!A) { mesh.visible = false; continue; }
    ra.fromArray(data.la).applyQuaternion(A.group.quaternion).add(A.group.position);
    const B = data.b && ents.get(data.b);
    if (B) rb.fromArray(data.lb).applyQuaternion(B.group.quaternion).add(B.group.position); else rb.fromArray(data.lb);
    rd.subVectors(rb, ra);
    const len = rd.length();
    mesh.visible = len > 0.01;
    mesh.position.copy(ra);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(UP, rd.divideScalar(len || 1));
  }
}

// ---------------------------------------------------------------- other players
const others = new Map();
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function nameSprite(name) {
  // dark pill, bitcoin-orange dot, chalk text (Bitmap Parcel World name tag)
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '600 30px Archivo, system-ui, sans-serif';
  g.font = font;
  const w = Math.min(512, Math.ceil(g.measureText(name).width) + 36);
  c.width = w; c.height = 48;
  g.font = font;
  g.fillStyle = 'rgba(20,20,22,0.82)';
  g.beginPath(); g.roundRect(0, 0, w, 48, 10); g.fill();
  g.fillStyle = THEME.btc; g.fillRect(14, 20, 8, 8);
  g.fillStyle = THEME.chalk; g.textBaseline = 'middle';
  g.fillText(name, 28, 26, w - 36);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  s.scale.set(0.32 * w / 48, 0.32, 1);
  s.position.y = 2.18;
  s.renderOrder = 9;
  return s;
}
function makeMannequin(hex) {
  // jointed mannequin from Bitmap Parcel World (static pose)
  const mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.58, metalness: 0.04 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x232325, roughness: 0.7 });
  const body = new THREE.Group();
  const add = (p, geo, m, x, y, z) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.castShadow = true; p.add(me); return me; };
  const cyl = (rt, rb, h) => new THREE.CylinderGeometry(rt, rb, h, 12);
  add(body, new THREE.BoxGeometry(0.32, 0.17, 0.2), mat, 0, 0.98, 0);
  const torso = add(body, cyl(0.19, 0.145, 0.52), mat, 0, 1.3, 0); torso.scale.z = 0.66;
  add(body, new THREE.BoxGeometry(0.34, 0.06, 0.215), dark, 0, 1.06, 0);
  add(body, cyl(0.05, 0.06, 0.1), mat, 0, 1.6, 0);
  const head = add(body, new THREE.SphereGeometry(0.12, 16, 12), mat, 0, 1.76, 0); head.scale.set(0.95, 1.32, 1.05);
  add(body, new THREE.BoxGeometry(0.075, 0.016, 0.03), dark, 0, 1.705, 0.118);
  const limb = (x, y, l1, l2, r1, r2) => {
    const p = new THREE.Group(); p.position.set(x, y, 0); body.add(p);
    add(p, cyl(r1, r1 * 0.82, l1), mat, 0, -l1 / 2, 0);
    const k = new THREE.Group(); k.position.y = -l1; p.add(k);
    add(k, cyl(r2, r2 * 0.78, l2), mat, 0, -l2 / 2, 0);
    return { p, k };
  };
  const lArm = limb(-0.25, 1.52, 0.3, 0.28, 0.05, 0.043), rArm = limb(0.25, 1.52, 0.3, 0.28, 0.05, 0.043);
  add(lArm.k, new THREE.SphereGeometry(0.048, 8, 6), mat, 0, -0.31, 0);
  add(rArm.k, new THREE.SphereGeometry(0.048, 8, 6), mat, 0, -0.31, 0);
  const lLeg = limb(-0.1, 0.93, 0.46, 0.44, 0.078, 0.062), rLeg = limb(0.1, 0.93, 0.46, 0.44, 0.078, 0.062);
  add(lLeg.k, new THREE.BoxGeometry(0.1, 0.07, 0.24), mat, 0, -0.47, 0.05);
  add(rLeg.k, new THREE.BoxGeometry(0.1, 0.07, 0.24), mat, 0, -0.47, 0.05);
  lArm.p.rotation.z = -0.12; rArm.p.rotation.z = 0.12;
  return body;
}
function makeAvatar(id, name) {
  const g = new THREE.Group();
  const body = makeMannequin(THEME.people[hue(name + id) % THEME.people.length]);
  body.rotation.y = Math.PI; // the mannequin faces +z; players look down -z at yaw 0
  g.add(body, nameSprite(name));
  scene.add(g);
  return { group: g, name, tp: new THREE.Vector3(), ry: 0 };
}

// ---------------------------------------------------------------- local player
const spawnPoint = () => new THREE.Vector3((Math.random() - 0.5) * 8, 0, 8 + Math.random() * 4);
const me = { id: null, name: 'fren', pos: spawnPoint(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, onGround: true, standingOn: null, crouch: false };
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
  if (me.pos.y < -60 || !Number.isFinite(me.pos.y)) { me.pos.copy(spawnPoint()); me.vel.set(0, 0, 0); }

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
  g.rotation.y = Math.atan2(Math.sin(g.rotation.y), Math.cos(g.rotation.y)); // keep heading within one turn
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
      setRopes(m.ropes);
      setStatus(`room <b>${escapeHtml(m.room)}</b> · connected`);
      break;
    case 'ent+': addEntity(m.e); break;
    case 'ent-': removeEntity(m.id); break;
    case 'ropes': setRopes(m.ropes); break;
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
      for (const [id, p, r, q] of m.ents) {
        const rec = ents.get(id);
        if (!rec || drive?.id === id) continue;
        rec.tp.fromArray(p);
        rec.tr.set(r[0], r[1], r[2]);
        if (q) (rec.tq ??= new THREE.Quaternion()).set(q[0], q[1], q[2], q[3]);
        else rec.tq = null;
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
    o.group.visible = Math.hypot(o.group.position.x - me.pos.x, o.group.position.z - me.pos.z) > 0.8;
    o.group.rotation.y = o.ry;
  }
  sun.position.copy(me.pos).add(SUN_OFF);
  sun.target.position.copy(me.pos);
  updateTarget();
  updateRopes();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// debug/automation hook (used by the headless demo script)
window.__game = { me, ents, send, setMode, keys, get items() { return items; }, set slot(v) { slot = v; renderHotbar(); }, get mode() { return mode; } };
