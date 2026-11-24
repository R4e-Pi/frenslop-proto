// Turns a player's prompt into mod code.
//   LLM_PROVIDER=ollama (default) -> your local Ollama (/api/chat)
//   LLM_PROVIDER=mock             -> canned mods, for testing without a model
import { SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { cleanModCode } from './sandbox.js';
import { mockMod } from './mock.js';

const cfg = {
  provider: process.env.LLM_PROVIDER || 'ollama',
  url: (process.env.OLLAMA_URL || 'http://192.168.1.213:11434').replace(/\/$/, ''),
  model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  attempts: Number(process.env.LLM_ATTEMPTS || 3),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 240000),
  numCtx: Number(process.env.OLLAMA_NUM_CTX || 8192),
};
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
      keep_alive: '30m',
      options: { temperature: 0.4, num_ctx: cfg.numCtx, num_predict: 2048 },
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(prompt) },
  ];
  let lastErr = 'no attempts made';
  for (let i = 1; i <= cfg.attempts; i++) {
    const t0 = Date.now();
    console.log(`[llm] "${prompt}" attempt ${i}: sending to ${cfg.url} (${cfg.model}, ctx ${cfg.numCtx})…`);
    const reply = await ollamaChat(messages);
    const code = cleanModCode(reply);
    console.log(`[llm] "${prompt}" attempt ${i}: ${code.length} chars in ${Date.now() - t0}ms`);
    const err = code ? tryInstall(code) : 'empty reply';
    if (!err) return code;
    lastErr = err;
    console.log(`[llm]   rejected: ${err}`);
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: `That code failed: ${err}\nFix it. Use only the documented API. Reply with the full corrected code in one \`\`\`js block.` });
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
