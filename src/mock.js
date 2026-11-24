// Canned mods for LLM_PROVIDER=mock. They exercise the same API the model
// writes against, so the whole pipeline can be tested without a GPU.
import { SYSTEM_PROMPT } from './prompt.js';

// Reuse the worked examples from the system prompt.
const examples = {};
for (const m of SYSTEM_PROMPT.matchAll(/EXAMPLE: "([^"]+)"\n```js\n([\s\S]*?)```/g)) examples[m[1]] = m[2];

const MOCKS = [
  [/moon|low grav|gravity/i, examples['moon gravity']],
  [/mower|tractor|car|kart|vehicle|ride/i, examples['a lawn mower I can ride']],
  [/portal|teleport|warp/i, examples['a spinning portal that sends you into the sky']],
  [/ball/i, examples['a beach ball item']],
  [/trampoline|bounce|jump pad|launch/i, `
const [x, , z] = here;
const pad = world.spawn({
  name: 'trampoline', position: [x, 0, z],
  parts: [
    { shape: 'cylinder', size: [3, 0.1, 3], offset: [0, 0.6, 0], color: '#1d1d1d' },
    { shape: 'torus', size: [3.1, 3.1, 3.1], offset: [0, 0.6, 0], rotation: [1.5708, 0, 0], color: '#2f6bff', tube: 0.06 },
    ...[0, 1, 2, 3, 4, 5].map(i => ({ shape: 'cylinder', size: [0.12, 0.6, 0.12], offset: [Math.cos(i * 1.047) * 1.4, 0.3, Math.sin(i * 1.047) * 1.4], color: '#888888' })),
  ],
});
world.onEnter(pad, 1.8, (p) => players.launch(p.id, [p.look[0] * 4, 22, p.look[2] * 4]));
`],
  [/parkour|obby|course|platform|climb/i, `
const [x, , z] = here;
const colors = ['#ff5d73', '#ffb84d', '#ffe66d', '#7ae582', '#4dd0e1', '#7c83fd', '#c77dff'];
let y = 0.8, a = 0;
for (let i = 0; i < 18; i++) {
  a += 0.55; y += 1.0;
  const r = 6 + i * 0.35;
  const p = world.spawn({
    name: 'step', position: [x + Math.cos(a) * r, y, z + Math.sin(a) * r], rotation: [0, -a, 0],
    parts: i % 3 === 0
      ? [{ shape: 'cylinder', size: [2.4, 0.3, 2.4], color: colors[i % colors.length] }]
      : [{ shape: 'box', size: [2.6, 0.3, 1.6], color: colors[i % colors.length] }],
  });
  if (i % 4 === 2) {
    const base = [x + Math.cos(a) * r, y, z + Math.sin(a) * r];
    world.onTick((dt, t) => world.move(p, [base[0], base[1] + Math.sin(t * 1.5 + i) * 0.8, base[2]]));
  }
}
const top = world.spawn({ name: 'goal', position: [x + Math.cos(a + 0.6) * 13, y + 1, z + Math.sin(a + 0.6) * 13],
  parts: [{ shape: 'box', size: [4, 0.4, 4], color: '#ffd700', emissive: true }] });
world.onEnter(top, 2.5, (p) => world.broadcast(p.name + ' reached the top!'));
`],
  [/night|sunset|dark|space|sky/i, `
world.setSky('#ff8c5a');
world.setFog('#f2a07b', 40, 260);
world.broadcast('golden hour');
`],
  [/tower|castle/i, `
const [x, , z] = here;
const stone = '#9a958c', dark = '#6d6962';
const parts = [];
for (let i = 0; i < 8; i++) parts.push({ shape: 'cylinder', size: [5 - i * 0.15, 1.5, 5 - i * 0.15], offset: [0, 0.75 + i * 1.5, 0], color: i % 2 ? stone : dark });
for (let i = 0; i < 8; i++) { const a = i * 0.785; parts.push({ shape: 'box', size: [0.8, 0.9, 0.8], offset: [Math.cos(a) * 2.1, 12.4, Math.sin(a) * 2.1], color: stone }); }
parts.push({ shape: 'cone', size: [4.6, 3.5, 4.6], offset: [0, 14.6, 0], color: '#3c5a99' });
world.spawn({ name: 'tower', position: [x, 0, z], parts });
for (let i = 0; i < 24; i++) {
  const a = i * 0.52, r = 3.4;
  world.spawn({ name: 'stair', position: [x + Math.cos(a) * r, 0.25 + i * 0.5, z + Math.sin(a) * r], rotation: [0, -a, 0],
    parts: [{ shape: 'box', size: [1.4, 0.25, 1.0], color: '#b58a5a' }] });
}
`],
];

function hashColor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return '#' + (h & 0xffffff).toString(16).padStart(6, '0');
}

export function mockMod(prompt) {
  for (const [re, code] of MOCKS) if (re.test(prompt)) return code;
  // Fallback: a "monument" tinted by the prompt, so every prompt shows something.
  const c = hashColor(prompt);
  return `
const [x, , z] = here;
const m = world.spawn({ name: ${JSON.stringify(prompt.slice(0, 40))}, position: [x, 0, z], parts: [
  { shape: 'box', size: [1.6, 0.4, 1.6], offset: [0, 0.2, 0], color: '#555555' },
  { shape: 'capsule', size: [0.9, 2.2, 0.9], offset: [0, 1.6, 0], color: '${c}' },
  { shape: 'sphere', size: [0.7, 0.7, 0.7], offset: [0, 3.0, 0], color: '${c}', emissive: true },
]});
world.onTick((dt, t) => world.rotate(m, [0, t, 0]));
interact(m, { prompt: 'inspect', onInteract(p) { players.message(p.id, 'mock mode: point LLM_PROVIDER at ollama to build "' + ${JSON.stringify(prompt.slice(0, 60))} + '" for real'); } });
`;
}
