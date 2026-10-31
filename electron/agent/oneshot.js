'use strict';
// Single-request helpers for Cmd+K inline edit, Tab autocomplete and commit messages.
// They use the prompts from Settings → Prompts verbatim.
const { adapterFor, normalizeModel } = require('./providers');

async function* streamText({ provider, model, apiKey, system, user, reasoning, maxTokens, signal, fetchImpl, onRequest, onResponse }) {
  const adapter = adapterFor(provider);
  const m = normalizeModel(typeof model === 'string' ? { id: model } : model, provider);
  const it = adapter.stream({
    provider, apiKey, model: m, system, fetchImpl, signal, onRequest, onResponse,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    tools: [], reasoning: reasoning || { enabled: false }, maxTokens,
  });
  for await (const ev of it) {
    if (ev.type === 'text') yield { type: 'text', text: ev.text };
    else if (ev.type === 'reasoning') yield { type: 'reasoning', text: ev.text };
    else if (ev.type === 'usage') yield ev;
  }
}

async function completeText(opts) {
  let out = '';
  let usage = null;
  for await (const ev of streamText(opts)) {
    if (ev.type === 'text') out += ev.text;
    else if (ev.type === 'usage') usage = { ...(usage || {}), ...ev.usage };
  }
  if (usage && opts.onUsage) { try { opts.onUsage(usage); } catch {} }
  return out;
}

// Models sometimes wrap code in ``` fences despite instructions — unwrap a single fenced block.
function stripFences(s) {
  const t = String(s);
  const m = /^\s*```[\w.+-]*[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  return m ? m[1] : t;
}

module.exports = { streamText, completeText, stripFences };
