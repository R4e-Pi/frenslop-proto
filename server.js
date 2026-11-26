// frenslop-proto: type anything, a local LLM builds it into a shared world.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// tiny .env loader (no dependency); real env vars win
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { WebSocketServer } = await import('ws');
const { Room } = await import('./src/room.js');
const { generateMod, checkLLM, llmConfig } = await import('./src/llm.js');
const { physicsStatus } = await import('./src/physics.js');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.join(ROOT, 'data', 'rooms');

const rooms = new Map();
const getRoom = id => {
  if (!rooms.has(id)) rooms.set(id, new Room(id, { generate: generateMod, dataDir: DATA }));
  return rooms.get(id);
};
const roomId = s => (String(s || '').toLowerCase().match(/^[a-z0-9-]{1,40}$/) || [null])[0];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}
// resolve a URL path under a base dir without letting ../ escape it
const under = (base, p) => { const f = path.join(base, path.normalize(p).replace(/^(\.\.[/\\])+/, '')); return f.startsWith(base) ? f : null; };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/') { res.writeHead(302, { location: '/r/lobby' }).end(); return; }
  if (/^\/r\/[^/]+\/?$/.test(p)) return serveFile(res, path.join(ROOT, 'public', 'index.html'));
  if (p === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rooms: [...rooms.values()].map(r => ({ id: r.id, players: r.clients.size, mods: r.mods.size, physics: r.physics.name })), provider: llmConfig.provider, model: llmConfig.model }));
    return;
  }
  if (p.startsWith('/vendor/three/')) {
    const f = under(path.join(ROOT, 'node_modules', 'three', 'build'), p.slice('/vendor/three/'.length));
    return f ? serveFile(res, f) : res.writeHead(404).end();
  }
  const f = under(path.join(ROOT, 'public'), p);
  return f ? serveFile(res, f) : res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const id = roomId(url.searchParams.get('room'));
  if (!id) { ws.close(1008, 'bad room'); return; }
  const room = getRoom(id);
  const client = room.join(ws, url.searchParams.get('name'));
  let budget = 60; // simple flood guard: ~60 msgs/sec
  const refill = setInterval(() => { budget = 60; }, 1000);
  ws.on('message', data => {
    if (--budget < 0) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg.t === 'string') room.handle(client, msg);
  });
  ws.on('close', () => { clearInterval(refill); room.leave(client); });
});

server.listen(PORT, HOST, async () => {
  console.log(`frenslop-proto on http://${HOST}:${PORT}/r/lobby`);
  console.log(`llm: ${await checkLLM()}`);
  console.log(`physics: ${physicsStatus()}`);
});
