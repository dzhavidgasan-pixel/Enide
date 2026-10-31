'use strict';
// OpenAI Chat Completions adapter — covers OpenAI, OpenRouter, DeepSeek, Kimi, GLM, Qwen,
// xAI, Mistral, Groq, Together, Fireworks, Ollama, LM Studio and any compatible gateway.
const { readSSE, joinUrl, readErrorBody, netErr } = require('./sse');
const { authHeaders, redactHeaders, deepMerge, parseToolArgs, genId, ThinkTagSplitter, withQuery } = require('./util');

function convertMessages(messages, provider, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  let lastUserIdx = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUserIdx = i; });
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      const parts = m.content || [];
      const hasImage = parts.some((b) => b.type === 'image');
      if (!hasImage) {
        const text = parts.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        if (text) out.push({ role: 'user', content: text });
      } else {
        out.push({
          role: 'user',
          content: parts.map((b) => (b.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } }
            : { type: 'text', text: b.text || '' })),
        });
      }
    } else if (m.role === 'assistant') {
      const text = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = (m.content || []).filter((b) => b.type === 'tool_call');
      if (!text && !calls.length) return;
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.args && !c.args.__parseError ? JSON.stringify(c.args) : (c.args && c.args.__raw) || '{}' },
        }));
      }
      const same = m.meta && m.meta.providerId === provider.id;
      if (provider.echoReasoning && same && i > lastUserIdx) {
        const r = (m.content || []).filter((b) => b.type === 'reasoning').map((b) => b.text || '').join('');
        if (r) msg.reasoning_content = r;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const imgs = [];
      for (const b of m.content || []) {
        if (b.type !== 'tool_result') continue;
        let content = String(b.output == null ? '' : b.output);
        if (b.images && b.images.length) { content += `\n[${b.images.length} image(s) attached in the next message]`; imgs.push(...b.images); }
        out.push({ role: 'tool', tool_call_id: b.id, content: content || '(empty)' });
      }
      // Chat Completions tool messages are text-only: deliver images as a follow-up user turn.
      if (imgs.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: 'Image output from the tool call(s) above:' }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } }))] });
      }
    }
  });
  return out;
}

function buildRequest({ provider, model, system, messages, tools, reasoning, maxTokens }) {
  const body = { model: model.id, messages: convertMessages(messages, provider, system), stream: true };
  if (provider.streamUsage) body.stream_options = { include_usage: true };
  if (tools && tools.length && model.tools !== false) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }));
  }
  const mt = maxTokens || model.maxOutput;
  if (mt && provider.maxTokensField !== 'none') body[provider.maxTokensField || 'max_tokens'] = mt;
  const on = reasoning && reasoning.enabled;
  const effort = (reasoning && reasoning.effort) || 'medium';
  switch (model.reasoningStyle) {
    case 'openai-effort': if (on) body.reasoning_effort = effort === 'max' ? 'high' : effort; break;
    case 'openrouter': body.reasoning = on ? { effort: effort === 'max' ? 'high' : effort } : { enabled: false }; break;
    // Kimi K3: thinking is always on; reasoning_effort takes low | high | max.
    case 'kimi-effort': body.reasoning_effort = !on || effort === 'low' ? 'low' : effort === 'max' ? 'max' : 'high'; break;
    case 'thinking-object': body.thinking = { type: on ? 'enabled' : 'disabled' }; break;
    case 'enable-thinking': body.enable_thinking = !!on; break;
    default: break;
  }
  if (model.temperature != null) body.temperature = model.temperature;
  deepMerge(body, model.extraBody);
  return { body };
}

function usageFrom(u) {
  if (!u) return null;
  // prompt_tokens already includes cached tokens: split them so nothing is counted twice.
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || u.cached_tokens || 0;
  const prompt = u.prompt_tokens || u.input_tokens || 0;
  return {
    input: Math.max(0, prompt - cached),
    output: u.completion_tokens || u.output_tokens || 0,
    cacheRead: Math.min(cached, prompt || cached),
    reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
  };
}

function reasoningText(delta) {
  if (!delta) return '';
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details.map((r) => r.text || r.summary || '').join('');
  }
  return '';
}

async function* stream(opts) {
  const { provider, apiKey, signal, fetchImpl, onRequest, onResponse } = opts;
  const f = fetchImpl || fetch;
  const { body } = buildRequest(opts);
  const url = withQuery(joinUrl(provider.baseUrl, '/chat/completions'), provider.query);
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...authHeaders(provider, apiKey),
    ...(provider.headers || {}),
  };
  if (onRequest) onRequest({ url, method: 'POST', headers: redactHeaders(headers), body });
  const t0 = Date.now();
  const res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(netErr(url));
  if (onResponse) onResponse({ status: res.status, ms: Date.now() - t0 });
  if (!res.ok) throw await readErrorBody(res);

  const splitter = new ThinkTagSplitter();
  const calls = new Map();
  let reasoningOpen = false;
  const emitText = function* (chunk) {
    for (const p of splitter.push(chunk)) {
      if (p.type === 'reasoning') {
        if (!reasoningOpen) { reasoningOpen = true; yield { type: 'reasoning_start' }; }
        yield p;
      } else {
        if (reasoningOpen && p.text.trim()) { reasoningOpen = false; yield { type: 'reasoning_end' }; }
        yield p;
      }
    }
  };
  const handleChunk = function* (j) {
    if (j.error) {
      const e = new Error(j.error.message || JSON.stringify(j.error));
      e.status = j.error.code || 'stream_error';
      throw e;
    }
    const u = usageFrom(j.usage);
    if (u && (u.input || u.output)) yield { type: 'usage', usage: u };
    const choice = (j.choices || [])[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    const r = reasoningText(delta);
    if (r) {
      if (!reasoningOpen) { reasoningOpen = true; yield { type: 'reasoning_start' }; }
      yield { type: 'reasoning', text: r };
    }
    if (typeof delta.content === 'string' && delta.content) yield* emitText(delta.content);
    else if (Array.isArray(delta.content)) {
      for (const part of delta.content) if (part && part.text) yield* emitText(part.text);
    }
    if (Array.isArray(delta.tool_calls)) {
      if (reasoningOpen) { reasoningOpen = false; yield { type: 'reasoning_end' }; }
      delta.tool_calls.forEach((tc) => {
        let idx = tc.index;
        if (idx == null) {
          const found = tc.id ? [...calls.entries()].find(([, c]) => c.id === tc.id) : null;
          if (found) idx = found[0];
          else if (tc.id || !calls.size) idx = calls.size ? Math.max(...calls.keys()) + 1 : 0;
          else idx = Math.max(...calls.keys()); // continuation chunk without index/id
        }
        let c = calls.get(idx);
        if (!c) { c = { id: tc.id || '', name: '', args: '', announced: false }; calls.set(idx, c); }
        if (tc.id) c.id = tc.id;
        if (tc.function) {
          if (tc.function.name) c.name += tc.function.name;
          if (tc.function.arguments != null) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        }
      });
      for (const c of calls.values()) {
        if (!c.announced && c.name) { c.announced = true; if (!c.id) c.id = genId('call'); yield { type: 'tool_call_start', id: c.id, name: c.name }; }
        if (c.announced) yield { type: 'tool_call_delta', id: c.id, name: c.name, partial: c.args };
      }
    }
    if (choice.finish_reason) yield { type: 'stop', reason: choice.finish_reason };
  };

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const j = await res.json();
    yield* handleChunk(j);
  } else {
    for await (const ev of readSSE(res.body, signal)) {
      const data = (ev.data || '').trim();
      if (!data) continue;
      if (data === '[DONE]') break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      yield* handleChunk(j);
    }
  }
  for (const p of splitter.flush()) yield p;
  if (reasoningOpen) yield { type: 'reasoning_end' };
  const sorted = [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  for (const c of sorted) {
    if (!c.name) continue;
    yield { type: 'tool_call', id: c.id || genId('call'), name: c.name, args: parseToolArgs(c.args) };
  }
}

module.exports = { stream, buildRequest, convertMessages };
