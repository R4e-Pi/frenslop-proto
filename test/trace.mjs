// End-to-end trace: game server -> Ollama -> model -> mod build, with timings.
// usage: node test/trace.mjs [prompt]     (server must be running)
import fs from 'node:fs';
import WebSocket from 'ws';

const env = {};
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2];
}
const PORT = process.env.PORT || env.PORT || 8090;
const OLLAMA = (process.env.OLLAMA_URL || env.OLLAMA_URL || 'http://192.168.1.213:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || 'qwen2.5:7b';
const CTX = Number(process.env.OLLAMA_NUM_CTX || env.OLLAMA_NUM_CTX || 8192);
const PROMPT = process.argv[2] || 'a red trampoline';
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(8);
const ok = (s) => console.log(`${ts()}  ✓ ${s}`);
const bad = (s) => { console.log(`${ts()}  ✗ ${s}`); process.exit(1); };
const info = (s) => console.log(`${ts()}    ${s}`);

console.log(`trace: game :${PORT} · ollama ${OLLAMA} · ${MODEL} · ctx ${CTX}\n`);

// 1. game server up?
try {
  const s = await (await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(3000) })).json();
  ok(`1 game server answering on :${PORT} (provider ${s.provider}, model ${s.model})`);
  if (s.provider !== 'ollama') info('  note: server is NOT using ollama — check LLM_PROVIDER in .env');
} catch (e) { bad(`1 game server not answering on :${PORT} — is npm start running? (${e.cause?.code || e.message})`); }

// 2. ollama reachable + model pulled?
try {
  const { models = [] } = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) })).json();
  const names = models.map(m => m.name);
  names.includes(MODEL) ? ok(`2 ollama reachable, ${MODEL} pulled`) : bad(`2 ollama reachable but ${MODEL} missing (have: ${names.join(', ')})`);
} catch (e) { bad(`2 can't reach ollama at ${OLLAMA} (${e.cause?.code || e.message})`); }

// 3. can the model load + answer at this context size?
info(`3 asking ${MODEL} to "say hi" at ctx ${CTX} (first load can take a while)…`);
try {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', signal: AbortSignal.timeout(300000),
    body: JSON.stringify({ model: MODEL, stream: false, keep_alive: '30m', messages: [{ role: 'user', content: 'say hi in 3 words' }], options: { num_ctx: CTX, num_predict: 20 } }),
  });
  if (!r.ok) bad(`3 ollama returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const sec = ns => (ns / 1e9).toFixed(1);
  ok(`3 model answered: "${(d.message?.content || '').trim().slice(0, 60)}"`);
  if (d.load_duration) info(`  load ${sec(d.load_duration)}s · prompt ${d.prompt_eval_count} tok · ${d.eval_count} tok at ${(d.eval_count / (d.eval_duration / 1e9)).toFixed(1)} tok/s`);
  try {
    const ps = await (await fetch(`${OLLAMA}/api/ps`)).json();
    for (const m of ps.models || []) {
      const gpu = m.size ? Math.round((m.size_vram / m.size) * 100) : 0;
      info(`  loaded: ${m.name} · ${(m.size / 1e9).toFixed(1)} GB · ${gpu}% on GPU${gpu < 100 ? '  ← partly on CPU = slow; lower OLLAMA_NUM_CTX' : ''}`);
    }
  } catch {}
} catch (e) { bad(`3 model call failed (${e.name === 'TimeoutError' ? 'no answer in 5 min' : e.cause?.code || e.message})`); }

// 4. full build through the game server, watching every message
info(`4 joining room "trace" and building "${PROMPT}"…`);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=trace&name=tracer`);
ws.on('error', e => bad(`4 websocket error: ${e.message}`));
ws.on('open', () => {
  ok('4 websocket connected');
  ws.send(JSON.stringify({ t: 'state', p: [0, 0, 0], look: [0, 0, -1], ry: 0 }));
  setTimeout(() => ws.send(JSON.stringify({ t: 'mod', prompt: PROMPT })), 200);
});
let last = '';
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.t === 'msg') info(`  feed: ${m.text}`);
  if (m.t === 'ent+') info(`  entity spawned: ${m.e.name} at [${m.e.position.join(', ')}] (${m.e.parts.length} parts)`);
  if (m.t === 'items') info(`  items: ${m.items.map(i => i.name).join(', ')}`);
  if (m.t === 'mods') {
    const mod = m.mods.find(x => x.prompt === PROMPT);
    if (!mod || mod.status === last) return;
    last = mod.status;
    if (mod.status === 'building') info('  mod status: building…');
    if (mod.status === 'live') { ok(`5 BUILT in ${(mod.ms / 1000).toFixed(1)}s — check room "trace": http://<pi-ip>:${PORT}/r/trace`); process.exit(0); }
    if (mod.status === 'failed') bad(`5 build failed: ${mod.error}`);
  }
});
setTimeout(() => bad('5 no result after 15 min'), 15 * 60 * 1000);
