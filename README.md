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
npm start                   # → http://<pi-ip>:8090/r/lobby
```

On the Jetson, make sure the model is pulled. Ollama is already bound to `0.0.0.0:11434`:

```bash
ollama pull qwen2.5:7b             # default
ollama pull qwen2.5-coder:7b       # optional, usually writes cleaner mod code → set OLLAMA_MODEL
```

At startup the server checks that Ollama is reachable and the model is pulled:
`llm: ollama http://192.168.1.213:11434 · qwen2.5:7b ✓`

No GPU handy? Run `npm run mock` to use canned mods so you can test the game itself.

Rooms are just URLs: `/r/anything` creates a room. Share the link with friends on your LAN, or over your tailnet with `tailscale serve`. Mods are saved to `data/rooms/<room>.json` and reloaded on restart.

## Controls

WASD move · shift sprint · space jump · C crouch · mouse look · LMB use item · 1–8 / wheel pick item · E interact / ride · **K make a mod** · enter chat · tab players · esc menu

## How a mod gets built

1. A player presses K and types a prompt. The server works out `here`, a spot 8 m in front of them.
2. `src/llm.js` sends the system prompt (`src/prompt.js`: the API reference plus 4 worked examples) and the prompt to Ollama.
3. The reply's code block is loaded into a fresh QuickJS sandbox. If it throws, does nothing, or times out, the error goes **back to the model** ("TypeError: not a function — at line 2: world.spawnn({})") for up to `LLM_ATTEMPTS` tries.
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
- There's no auth or per-user rate limiting beyond "one building mod per player". Keep it on your LAN or tailnet. Don't put it on the open internet as is.

## Files

| file | what |
|---|---|
| `server.js` | HTTP (static + `/r/:room`) and WebSocket server, `.env` loader |
| `src/room.js` | room state, op validation, tick loop (20 Hz), tiny physics for dynamic bodies, persistence |
| `src/sandbox.js` | QuickJS runtime per mod, the mod API prelude |
| `src/llm.js` | Ollama provider with error-feedback retries, plus the mock provider |
| `src/prompt.js` | the system prompt the model sees |
| `src/mock.js` | canned mods for `LLM_PROVIDER=mock` |
| `public/` | Three.js client: FPS controller, AABB collisions, vehicles, hotbar, mod panel |
| `test/` | sandbox, mock and multiplayer tests, and the headless screenshot script |

## Tests

```bash
npm test                                   # sandbox limits + every mock mod loads
node test/multi.test.mjs 8090              # two clients in room "demo" (server must be running)
python3 test/demo-screenshots.py           # headless browser run → demo/*.png (needs playwright)
```

## Ideas for next steps

- Stream Ollama tokens to the mod panel so players watch it "think".
- Let a player edit an existing mod ("make the mower faster") by sending the old code plus the request.
- Move solid collision to the server, or fold it into your box3d physics server, for real authority.
- GLB assets: add a `model: 'mower.glb'` part type backed by a local asset library or text-to-3D on the Jetson.
- Voice push-to-talk over WebRTC, using the existing WebSocket for signalling.
