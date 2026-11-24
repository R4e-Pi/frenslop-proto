// Every canned mock mod must load cleanly in the sandbox and emit ops.
import { ModSandbox } from '../src/sandbox.js';
import { mockMod } from '../src/mock.js';
const prompts = ['moon gravity', 'a go kart', 'portal', 'beach ball', 'trampoline', 'parkour obby', 'sunset sky', 'a castle tower', 'a dancing hotdog'];
let fail = 0;
for (const p of prompts) {
  const sb = new ModSandbox('t', { here: [0, 0, 0], author: { id: 'p', name: 'x' } });
  try { const ops = sb.load(mockMod(p)); console.log('ok  ', p.padEnd(16), ops.length, 'ops'); }
  catch (e) { fail++; console.log('FAIL', p, e.message); }
  sb.dispose();
}
process.exit(fail ? 1 : 0);
