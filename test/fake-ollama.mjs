// Stand-in for Ollama's /api/chat + /api/tags. First reply is deliberately broken
// so the retry-with-error-feedback loop gets exercised.
import http from 'node:http';
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }, { name: 'qwen2.5:7b' }] })); return; }
    if (req.url === '/api/ps') { res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 6e9, size_vram: 6e9 }] })); return; }
    const req2 = JSON.parse(body);
    const msgs = req2.messages;
    n++;
    const firstTry = !/previous attempt failed/.test(msgs.at(-1).content);
    const content = firstTry && msgs.length === 2
      ? "Sure! Here's your mod:\n```js\nconst x = here[0];\nworld.spawnn({ name: 'oops' });\n```"
      : "```js\nconst [x,,z] = here;\nconst c = world.spawn({ name: 'giant cube', position: [x, 2, z], parts: [{ shape: 'box', size: [4,4,4], color: '#ff00aa' }] });\nworld.onTick((dt,t)=>world.rotate(c,[0,t,0]));\n```";
    console.error(`[fake-ollama] call ${n}, ${msgs.length} msgs, keep_alive=${JSON.stringify(req2.keep_alive)} num_ctx=${req2.options?.num_ctx} num_predict=${req2.options?.num_predict}, last user msg: ${msgs.at(-1).content.slice(0, 90).replace(/\n/g,' ')}`);
    // answer slowly like a real model would (FAKE_DELAY_MS, default 3s)
    setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content } })), Number(process.env.FAKE_DELAY_MS || 3000));
  });
}).listen(11555);
