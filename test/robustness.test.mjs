// Regression tests for bugs found in review (2026-11-23).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanModCode } from '../src/sandbox.js';
import { Room } from '../src/room.js';

let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); if (!ok) fail++; };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'robust-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fakeWs = () => ({ readyState: 1, send() {} });

// 1. code fences: closed, never closed (seen live: attempt 1 rejected at "```js"), none, export
check('fence: closed block', cleanModCode('Sure!\n```js\nworld.setGravity(2);\n```\nEnjoy') === 'world.setGravity(2);');
check('fence: unclosed block', cleanModCode('Here:\n```js\nworld.setGravity(2);\nworld.setSky("#000");') === 'world.setGravity(2);\nworld.setSky("#000");');
check('fence: none', cleanModCode('world.setGravity(2);') === 'world.setGravity(2);');
check('fence: export keyword kept code', cleanModCode('```js\nexport const g = 2;\nworld.setGravity(g);\n```') === 'const g = 2;\nworld.setGravity(g);');

// 2. a mod removed while the model is still writing must not install afterwards
{
  const code = `world.spawn({ name: 'late box', position: here });`;
  const room = new Room('rmtest', {
    dataDir: tmpDir(),
    generate: async (p, ctx, tryInstall) => { await sleep(300); const e = tryInstall(code); if (e) throw new Error(e); return code; },
  });
  const c = room.join(fakeWs(), 'tester');
  const pending = room.requestMod(c, 'a box');
  await sleep(50);
  const id = [...room.mods.keys()][0];
  room.removeMod(id, c);
  await pending;
  check('removed while building leaves no entities', room.entities.size === 0, `${room.entities.size} entities left`);
  check('removed while building leaves no mod', room.mods.size === 0, `${room.mods.size} mods left`);
  room.close();
}

// 3. rotations wrap instead of hitting a clamp (spinning mods froze after ~80 min)
{
  const code = `const b = world.spawn({ name: 'spinner', position: here }); world.rotate(b, [0, 10000.5, 0]);`;
  const room = new Room('rottest', { dataDir: tmpDir(), generate: async (p, ctx, t) => { const e = t(code); if (e) throw new Error(e); return code; } });
  const c = room.join(fakeWs(), 'tester');
  await room.requestMod(c, 'a spinner');
  const e = [...room.entities.values()][0];
  const y = e?.rotation[1];
  check('rotation wraps into (-π, π]', y > -Math.PI && y <= Math.PI && Math.abs(Math.sin(y) - Math.sin(10000.5)) < 1e-9, `got ${y}`);
  room.close();
}

// 4. LLM retries stay small: fresh 2-message chat carrying only the error
{
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const content = calls.length === 1 ? '```js\nworld.spawnn({});\n```' : '```js\nworld.setGravity(3);\n```';
    return { ok: true, json: async () => ({ message: { content } }) };
  };
  const { generateMod } = await import('../src/llm.js');
  const room = new Room('llmtest', { dataDir: tmpDir(), generate: generateMod });
  const c = room.join(fakeWs(), 'tester');
  await room.requestMod(c, 'low gravity');
  const mod = [...room.mods.values()][0];
  check('retry built the mod', mod?.status === 'live', `status ${mod?.status}: ${mod?.error}`);
  check('retry is a fresh 2-message chat', calls[1]?.messages.length === 2, `${calls[1]?.messages.length} messages`);
  check('retry carries the error, not the failed reply', /previous attempt failed/.test(calls[1]?.messages[1].content) && !/spawnn\(\{\}\);\n/.test(calls[1]?.messages[1].content.split('failed with:')[0]));
  check('reply length capped to fit the context', calls[0]?.options.num_predict <= calls[0]?.options.num_ctx * 0.4, JSON.stringify(calls[0]?.options));
  room.close();
}

process.exit(fail ? 1 : 0);
