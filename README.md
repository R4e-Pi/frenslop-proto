# frenslop-proto ("slopfield")

Type anything, and **your own local LLM** writes a mod that builds it into a shared multiplayer 3D world. It's a self-hosted take on frenslop.io: Three.js in the browser, Node + WebSockets for rooms, Ollama for the model, and QuickJS (WASM) as the sandbox that runs the generated code.

```
browser (Three.js)  ──ws──▶  server.js (Node, on the Pi)
  K → "a lawn mower I can ride"     │
                                    ├─▶ Ollama /api/chat (Jetson, qwen2.5:7b)
                                    │      ↳ returns a JS mod written against the mod API
                                    ├─▶ QuickJS sandbox per mod (16 MB, 250 ms load / 15 ms per call)
                                    │      ↳ mod emits JSON ops: spawn, move, setGravity, item, vehicle…
                                    └─▶ room validates + applies ops → broadcasts to every player
```

## Run it

On the Pi (or anywhere with Node ≥ 18.17):

```bash
cd ~/frenslop-proto
npm install
cp .env.example .env        # OLLAMA_URL already points at the Jetson (192.168.1.213:11434)
npm start                   # → http://<pi-ip>:8090/r/lobby  (your Pi uses PORT=8095)
```

On the Jetson, make sure the model is pulled. Ollama is already bound to `0.0.0.0:11434`:

```bash
ollama pull qwen2.5:3b             # default: proven at 100% GPU on the Orin Nano at ctx 4096
```

At startup the server checks that Ollama is reachable and the model is pulled:
`llm: ollama http://192.168.1.213:11434 · qwen2.5:3b ✓`

**About the 7B on an 8 GB Jetson:** `qwen2.5:7b` needs one 4.1 GB GPU allocation. After days of uptime,
memory fragments and that allocation fails (`NvMap … error 12`, `cudaMalloc failed: out of memory`) even
with plenty of RAM free. It loads after a reboot, at ctx 4096 only (8192 doesn't fit). To use it reliably, pin it:
load it at boot and never unload it (`OLLAMA_KEEP_ALIVE=-1` on the Jetson **and** in this `.env`).

Check the whole chain any time with `node test/trace.mjs "a red trampoline"`.

No GPU handy? Run `npm run mock` to use canned mods so you can test the game itself.

Rooms are just URLs: `/r/anything` creates a room. Share the link with friends on your LAN, or over your tailnet with `tailscale serve`. Mods are saved to `data/rooms/<room>.json` and reloaded on restart.

## Physics: Box3D

Rooms run real rigid-body physics with **Box3D v0.1.0** (Erin Catto, the Box2D author; MIT), the same
engine as box3d-net-demo. It uses the same split too: `physics/physics_server` is a small C program
that owns the simulation, and Node drives it over a pipe, with one world per room at 60 Hz and 4 substeps.

```bash
npm run build:physics                    # clones Box3D v0.1.0 into physics/vendor/, builds, compiles the server
BOX3D_DIR=~/box3d npm run build:physics  # or reuse an existing Box3D checkout
```

At startup the server prints `physics: Box3D v0.1.0 (physics/physics_server)`. If the program isn't built
(or `PHYSICS=simple`), rooms fall back to the original tiny integrator: gravity, bounces and kicks, but
no joints or object-vs-object collisions.

What it simulates:
- **Bodies:** solid things are static colliders; `physics:'dynamic'` things are simulated, with mass from
  their real volume and **material** (`wood steel stone concrete rubber ice plastic glass gold foam inflatable`)
  or an explicit `mass` in kg. Things a mod moves become kinematic and push what they touch.
- **Players** are kinematic capsules, so walking into a ball kicks it.
- **Forces** in SI units: `world.impulse` (N·s), `world.force` (N), `world.spin` (rad/s).
- **Joints:** `world.hinge`, `rope`, `ball`, `weld` and `slider`, with motors and limits. Ropes are drawn as cables.
- **Impacts:** `world.onHit(id, (other, speed, point) => …)`, with impact speed in m/s.
- Shapes match the visuals: boxes, spheres, capsules, convex hulls for cylinders, cones and ellipsoids,
  and tori as rings of capsules, so hoops stay open.

**Mistakes become feedback.** The sandbox rejects code that can't work physically, and the error goes back to
the model for its retry: building more than 10 cm underground, a joint pinned to the world without saying where
(`anchorB` for a rope, `anchor` for a hinge), or a rope hanging from a point below what it holds.

**Syntax errors:** if the code fails only because brackets don't balance (a 3B classic: `]);` for `] });`), the
server repairs the brackets itself and installs it, with no model round trip. Otherwise the retry shows the model its own
failed code (up to `LLM_RETRY_CODE_CHARS`, default 1600) plus the error, so it can fix the exact line. Retries sample
a little hotter (temperature 0.4 → 0.6 → 0.8) so a small model doesn't repeat the same answer.

**How small models write joints:** the 3B tends to refer to things by the name it gave them (`'pendulum'`) rather
than the id `world.spawn` returns, to write `'ground'` for the fixed world, to swap the arguments, and to call the
pivot `anchorA`. All of those are accepted, because each means one thing. A pivot underground, or a part that
starts underground (even next to a rotated part), is rejected with an error that says how to fix it.

**Inspect a mod:** run `node test/inspect.mjs <room> [part of the prompt]` in a second terminal (tmux `Ctrl-b %`)
while the server runs. For a built mod it prints the code, what it spawned, its joints, 3 s of simulated motion, and
findings (for example "nothing holds it, so it just falls"). For a failed build it prints every attempt's code and
error (the last 10 failures per room are kept in `data/rooms/<room>.failed.json`).

`test/physics.test.mjs` checks mods against textbook results:

| check | measured | theory |
|---|---|---|
| free fall from 5 m | 1.009 s | √(2h/g) = 1.010 s |
| steel ball rebound (e = 0.3) from 5 m | 0.44 m | e²h = 0.45 m |
| rubber ball rebound (e = 0.8) from 2 m | 1.26 m | e²h = 1.28 m |
| 10 N·s impulse on 2 kg | 4.93 m/s | J/m = 5.00 m/s |
| pendulum, L = 2 m | 2.85 s | 2π√(L/g) = 2.84 s |
| impact speed from 3.2 m | 8.00 m/s | √(2gh) = 7.92 m/s |

## Theme

The look is the **Bitmap district** from Bitmap Parcel World: asphalt roads, orange parcels packed
Mondrian-style on a 12 m grid, a dark sky, jointed mannequin players, and Archivo + IBM Plex Mono type.
The parcels are a few cm thick, so the ground stays flat at y = 0 for players and mods. The theme
colors live in `THEME` at the top of `public/client.js` and in the `:root` variables in `public/style.css`.

## Controls

WASD move · shift sprint · space jump · C crouch · mouse look · LMB use item · 1–8 / wheel pick item · E interact / ride · **K make a mod** · enter chat · tab players · esc menu

## How a mod gets built

1. A player presses K and types a prompt. The server works out `here`, a spot 8 m in front of them.
2. `src/llm.js` sends the system prompt (`src/prompt.js`: the API reference plus 4 worked examples) and the prompt to Ollama.
3. The reply's code block is loaded into a fresh QuickJS sandbox. If it throws, does nothing, or times out, the error goes **back to the model** ("TypeError: not a function — at line 2: world.spawnn({})") for up to `LLM_ATTEMPTS` tries. Each retry is a fresh, short chat (instructions + request + the error only), so it always fits a 4096 context. When retries piled up in one conversation, Ollama trimmed away the request and the model pasted its examples instead.
4. Once it loads, the mod's ops are applied and broadcast. Its handlers (`onTick`, `onUse`, `onInteract`, `onEnter`) keep running in the sandbox. A mod that keeps erroring is marked `crashed` and stopped.

### Mod API (what the model writes against)

```js
world.spawn({ name, position, rotation, parts: [{ shape, size, offset, rotation, color, emissive, opacity, tube }],
              solid, physics: 'static' | 'dynamic', velocity })      // → id
world.move / rotate / remove / push / get
world.setGravity(g)  world.setSky(c)  world.setFog(c, near, far)
world.onTick(fn(dt, t))  world.onEnter(id, radius, fn(player))  world.broadcast(text)
interact(id, { prompt, onInteract(player) })
vehicles.make(id, { speed, prompt })
items.register({ name, icon, onUse(player) })
players.list() / teleport(id, pos) / launch(id, vel) / message(id, text)
```

Shapes: box, sphere, cylinder, cone, torus, capsule. Each is a unit shape scaled by `size`. Adding a capability means adding an op in `src/sandbox.js` (the prelude), handling it in `Room.#applyOne`, documenting it in `src/prompt.js`, and rendering it in `public/client.js` if it's visual.

## Safety model

- Generated code never runs in the browser or in Node. It runs only in QuickJS, with no `process`, `require`, network or filesystem, plus memory, stack and time limits.
- Mods can only *ask* for things through ops. The room clamps every value: positions, sizes, colors, part counts, entities per mod/room, dynamic bodies, and items.
- A mod can only move or remove entities it created itself.
- At most `MAX_ROOMS` rooms (default 12) can be open at once, since each runs a physics process. Rooms with nobody in
  them close after `ROOM_IDLE_MINUTES` (default 10); their mods are saved and come back when someone opens the URL.
- There's no auth or per-user rate limiting beyond "one building mod per player". Keep it on your LAN or tailnet. Don't put it on the open internet as is.

## Files

| file | what |
|---|---|
| `server.js` | HTTP (static + `/r/:room`) and WebSocket server, `.env` loader |
| `src/room.js` | room state, op validation, tick loop (20 Hz), physics integration, persistence |
| `src/physics.js` | Box3D driver (shapes, materials, joints, players), plus the simple fallback |
| `physics/` | `physics_server.c` (Box3D world over a line protocol) and `build.sh` |
| `src/sandbox.js` | QuickJS runtime per mod, the mod API prelude |
| `src/llm.js` | Ollama provider with error-feedback retries, plus the mock provider |
| `src/prompt.js` | the system prompt the model sees |
| `src/mock.js` | canned mods for `LLM_PROVIDER=mock` |
| `public/` | Three.js client: FPS controller, AABB collisions, vehicles, hotbar, mod panel |
| `test/` | sandbox, mock and multiplayer tests, and the headless screenshot script |

## Tests

```bash
npm test                                   # sandbox limits, mock mods, slow-model + robustness regressions
node test/multi.test.mjs 8090              # two clients in room "demo" (server must be running)
python3 test/demo-screenshots.py           # headless browser run → demo/*.png (needs playwright)
```

## Ideas for next steps

- Stream Ollama tokens to the mod panel so players watch it "think".
- Let a player edit an existing mod ("make the mower faster") by sending the old code plus the request.
- Move solid collision to the server, or fold it into your box3d physics server, for real authority.
- GLB assets: add a `model: 'mower.glb'` part type backed by a local asset library or text-to-3D on the Jetson.
- Voice push-to-talk over WebRTC, using the existing WebSocket for signalling.
