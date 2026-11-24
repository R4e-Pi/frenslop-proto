import asyncio, json, sys
from playwright.async_api import async_playwright
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'demo')
URL = 'http://127.0.0.1:8090/r/demo'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1600, 'height': 900})
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL); await pg.wait_for_timeout(2500)
        await pg.fill('#name', 'john')
        await pg.screenshot(path=f'{OUT}/01-menu.png')
        await pg.evaluate("__game.send({t:'name',name:'john'}); __game.me.name='john'; __game.setMode('play')")

        async def build(prompt, at):
            # mods build 8m in front of the player, so stand 8m behind the target spot facing -z
            await pg.evaluate(f"__game.me.pos.set({at[0]},0,{at[1]+8}); __game.me.yaw=0; __game.me.pitch=0")
            await pg.wait_for_timeout(250)
            await pg.evaluate(f"__game.send({{t:'mod', prompt:{json.dumps(prompt)}}})")
            await pg.wait_for_timeout(700)
        await build('a parkour course spiraling into the sky', (0, -4))
        await build('a lawn mower I can ride', (-7, 18))
        await build('a spinning portal that launches you into the sky', (11, 12))
        await build('a trampoline', (-18, 4))
        await build('a stone tower with stairs', (24, -14))
        await build('a beach ball item', (0, 30))
        print('entities:', await pg.evaluate("__game.ents.size"), 'items:', await pg.evaluate("__game.items.map(i=>i.name)"))

        # main scene shot: stand back and look at everything
        await pg.evaluate("__game.me.pos.set(-2,0,36); __game.me.yaw=0.04; __game.me.pitch=0.16")
        await pg.wait_for_timeout(1200)
        print('fps', await pg.evaluate("window.__fps"))
        await pg.screenshot(path=f'{OUT}/02-world.png')

        # throw some beach balls
        await pg.evaluate("__game.slot=0")
        for i in range(4):
            await pg.evaluate(f"__game.me.yaw={0.25 - i*0.15}; __game.me.pitch=0.25")
            await pg.wait_for_timeout(120)
            await pg.evaluate("__game.send({t:'use', key: __game.items[0].key})")
            await pg.wait_for_timeout(250)
        await pg.evaluate("__game.me.yaw=0.05; __game.me.pitch=0.05")
        await pg.wait_for_timeout(700)
        await pg.screenshot(path=f'{OUT}/03-beach-balls.png')

        # open the mod panel with a prompt typed
        await pg.evaluate("__game.setMode('mods')")
        await pg.fill('#modinput', 'moon gravity')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f'{OUT}/04-mod-panel.png')
        await pg.evaluate("__game.setMode('play')")

        # walk up to the mower and look at it -> "ride the mower [E]"
        mower = await pg.evaluate("[...__game.ents.values()].find(r=>r.data.vehicle).data")
        mx, _, mz = mower['position']
        await pg.evaluate(f"__game.me.pos.set({mx+0.5},0,{mz+3.2}); __game.me.yaw=0.15; __game.me.pitch=-0.42")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f'{OUT}/05-ride-prompt.png')
        await pg.evaluate(f"__game.send({{t:'interact', id:{json.dumps(mower['id'])}}})")
        await pg.wait_for_timeout(300)
        await pg.evaluate("__game.keys.add('KeyW'); __game.keys.add('KeyD'); __game.me.pitch=-0.12")
        await pg.wait_for_timeout(1500)
        await pg.evaluate("__game.keys.delete('KeyD')")
        await pg.wait_for_timeout(900)
        await pg.evaluate("__game.keys.clear()")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'{OUT}/06-driving.png')
        moved = await pg.evaluate(f"__game.ents.get({json.dumps(mower['id'])}).group.position.toArray()")
        print('mower from', mower['position'], 'to', [round(v,2) for v in moved])
        await pg.evaluate(f"__game.send({{t:'interact', id:{json.dumps(mower['id'])}}})")
        await pg.wait_for_timeout(300)

        # stand on the top of the parkour course (tests standing on solids)
        goal = await pg.evaluate("[...__game.ents.values()].find(r=>r.data.name==='goal').data.position")
        await pg.evaluate(f"__game.me.pos.set({goal[0]},{goal[1]+3},{goal[2]}); __game.me.vel.set(0,0,0)")
        await pg.wait_for_timeout(1500)
        y = await pg.evaluate("__game.me.pos.y")
        print('goal top y', goal[1] + 0.2, 'player y', round(y, 3))
        await pg.evaluate("__game.me.yaw=2.6; __game.me.pitch=-0.35")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=f'{OUT}/07-top-of-course.png')

        # moon gravity: jump height check
        await pg.evaluate("__game.me.pos.set(-8,0,40); __game.me.vel.set(0,0,0)")
        await pg.evaluate("__game.send({t:'mod', prompt:'moon gravity'})")
        await pg.wait_for_timeout(800)
        await pg.evaluate("__game.keys.add('Space')")
        await pg.wait_for_timeout(100)
        await pg.evaluate("__game.keys.delete('Space')")
        peak = 0
        for i in range(30):
            await pg.wait_for_timeout(100)
            peak = max(peak, await pg.evaluate("__game.me.pos.y"))
        print('moon jump peak', round(peak, 2), 'm')
        await pg.evaluate("__game.me.pos.set(-1,0,36); __game.me.yaw=0.02; __game.me.pitch=0.15")
        await pg.wait_for_timeout(900)
        await pg.screenshot(path=f'{OUT}/08-moon-gravity.png')
        print('errors:', errs[:5])
        await b.close()
asyncio.run(main())
