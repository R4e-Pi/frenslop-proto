// Regression: a mod that is still "building" (slow model) must not crash the
// room's tick loop while players are connected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../src/room.js';
const code = `const b = world.spawn({ name: 'box', position: [here[0], 0.5, here[2]] }); world.onTick((dt, t) => world.rotate(b, [0, t, 0]));`;
const slowGenerate = async (prompt, ctx, tryInstall) => {
  await new Promise(r => setTimeout(r, 400)); // ~8 ticks pass while "building"
  const err = tryInstall(code);
  if (err) throw new Error(err);
  return code;
};
const room = new Room('slowtest', { generate: slowGenerate, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'slowtest-')) });
const client = room.join({ readyState: 1, send() {} }, 'tester');
await room.requestMod(client, 'a box');
await new Promise(r => setTimeout(r, 200)); // let the live mod tick a few times
const mod = [...room.mods.values()][0];
room.close();
if (mod.status !== 'live') { console.log('FAIL slow model build:', mod.status, mod.error); process.exit(1); }
console.log('ok   slow model build stays alive and goes live');
