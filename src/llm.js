// Turns a player's prompt into mod code.
//   LLM_PROVIDER=ollama (default) -> your local Ollama (/api/chat)
//   LLM_PROVIDER=mock             -> canned mods, for testing without a model
import { SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { cleanModCode } from './sandbox.js';
import { mockMod } from './mock.js';

const cfg = {
  provider: process.env.LLM_PROVIDER || 'ollama',
  url: (process.env.OLLAMA_URL || 'http://192.168.1.213:11434').replace(/\/$/, ''),
  model: process.env.OLLAMA_MODEL || 'qwen2.5:3b',
  attempts: Number(process.env.LLM_ATTEMPTS || 3),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 240000),
  numCtx: Number(process.env.OLLAMA_NUM_CTX || 4096),
  // "-1" = never unload (pinned model); any Ollama duration like "30m" also works.
  // Must match the server's OLLAMA_KEEP_ALIVE or each request resets the timer.
  keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
};
// leave room in the context for the ~1.5k-token system prompt
cfg.numPredict = Number(process.env.OLLAMA_NUM_PREDICT || Math.min(2048, Math.floor(cfg.numCtx * 0.35)));
const keepAliveValue = v => (/^-?\d+$/.test(v) ? Number(v) : v);
export const llmConfig = cfg;

async function ollamaChat(messages) {
  const res = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(cfg.timeoutMs),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: false,
      keep_alive: keepAliveValue(cfg.keepAlive),
      options: { temperature: 0.4, num_ctx: cfg.numCtx, num_predict: cfg.numPredict },
    }),
  }).catch(e => { throw new Error(`can't reach Ollama at ${cfg.url} (${e.cause?.code || e.message})`); });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.message?.content || '';
}

// generate(prompt, ctx, tryInstall) -> code
// tryInstall(code) returns null if the code loaded and did something, else an
// error string. Errors go back to the model so it can fix its own code.
export async function generateMod(prompt, ctx, tryInstall) {
  if (cfg.provider === 'mock') {
    const code = mockMod(prompt);
    const err = tryInstall(code);
    if (err) throw new Error(err);
    return code;
  }

  let lastErr = 'no attempts made';
  for (let i = 1; i <= cfg.attempts; i++) {
    // Each attempt is a fresh 2-message chat so it always fits small contexts;
    // a retry carries only the previous error, not the whole failed reply.
    const retryNote = i > 1 ? `\n\nYour previous attempt failed with: ${lastErr}\nAvoid that mistake. Use only the documented API.` : '';
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(prompt) + retryNote },
    ];
    const t0 = Date.now();
    console.log(`[llm] "${prompt}" attempt ${i}: sending to ${cfg.url} (${cfg.model}, ctx ${cfg.numCtx})…`);
    const reply = await ollamaChat(messages);
    const code = cleanModCode(reply);
    console.log(`[llm] "${prompt}" attempt ${i}: ${code.length} chars in ${Date.now() - t0}ms`);
    const err = code ? tryInstall(code) : 'empty reply';
    if (!err) return code;
    lastErr = err;
    console.log(`[llm]   rejected: ${err}`);
  }
  throw new Error(`model couldn't produce working code (${lastErr})`);
}

export async function checkLLM() {
  if (cfg.provider === 'mock') return 'mock provider (canned mods, no model)';
  try {
    const res = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const { models = [] } = await res.json();
    const names = models.map(m => m.name);
    const has = names.some(n => n === cfg.model || n === `${cfg.model}:latest`);
    return has ? `ollama ${cfg.url} · ${cfg.model} ✓`
      : `ollama ${cfg.url} reachable, but model "${cfg.model}" not pulled (have: ${names.join(', ') || 'none'})`;
  } catch (e) {
    return `⚠ can't reach ollama at ${cfg.url} (${e.cause?.code || e.message}) — set OLLAMA_URL or LLM_PROVIDER=mock`;
  }
}
