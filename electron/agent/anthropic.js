'use strict';
// Anthropic Messages API adapter (also used for Anthropic-compatible gateways such as Z.ai).
const { readSSE, joinUrl, readErrorBody, netErr } = require('./sse');
const { authHeaders, redactHeaders, deepMerge, parseToolArgs, genId, withQuery } = require('./util');

const EFFORT_BUDGET = { minimal: 2048, low: 4096, medium: 10000, high: 24000, xhigh: 32000, max: 48000 };

function convertMessages(messages, provider) {
  const out = [];
  const push = (role, content) => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
      }
      push('user', blocks);
    } else if (m.role === 'assistant') {
      const same = m.meta && m.meta.providerId === provider.id;
      const blocks = [];
      for (const b of m.content || []) {
        if (b.type === 'reasoning') {
          if (!same) continue;
          if (b.redacted) blocks.push({ type: 'redacted_thinking', data: b.redacted });
          else if (b.signature || b.text) blocks.push({ type: 'thinking', thinking: b.text || '', signature: b.signature || '' });
        } else if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'tool_call') {
          blocks.push({ type: 'tool_use', id: safeId(b.id), name: b.name, input: b.args && !b.args.__parseError ? b.args : {} });
        }
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const blocks = [];
      for (const b of m.content || []) {
        if (b.type !== 'tool_result') continue;
        const content = [];
        if (b.output) content.push({ type: 'text', text: String(b.output) });
        for (const img of b.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        blocks.push({ type: 'tool_result', tool_use_id: safeId(b.id), content: content.length ? content : [{ type: 'text', text: '(empty)' }], ...(b.isError ? { is_error: true } : {}) });
      }
      push('user', blocks);
    }
  }
  return out;
}

function safeId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return s || genId('toolu');
}

function buildRequest({ provider, model, system, messages, tools, reasoning, maxTokens }) {
  const caching = !!provider.promptCaching;
  let max_tokens = maxTokens || model.maxOutput || 8192;
  const body = { model: model.id, max_tokens, stream: true, messages: convertMessages(messages, provider) };
  if (system) body.system = [{ type: 'text', text: system, ...(caching ? { cache_control: { type: 'ephemeral' } } : {}) }];
  if (tools && tools.length && model.tools !== false) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
    if (caching) body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
  }
  if (caching) {
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const blk = lastUser && [...lastUser.content].reverse().find((b) => ['text', 'tool_result', 'image'].includes(b.type));
    if (blk) blk.cache_control = { type: 'ephemeral' };
  }
  const style = model.reasoningStyle;
  const on = reasoning && reasoning.enabled;
  let thinkingOn = false;
  const headers = {};
  if (style === 'anthropic-adaptive') {
    if (on) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      if (reasoning.effort) body.output_config = { effort: reasoning.effort };
      thinkingOn = true;
    } else {
      body.thinking = { type: 'disabled' };
    }
  } else if (style === 'anthropic-budget' && on) {
    const budget = Math.max(1024, (reasoning.effort && EFFORT_BUDGET[reasoning.effort]) || model.reasoningBudget || 8000);
    body.thinking = { type: 'enabled', budget_tokens: budget };
    if (body.max_tokens <= budget) body.max_tokens = budget + 4096;
    thinkingOn = true;
    if (provider.preset === 'anthropic') headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }
  if (model.temperature != null && !thinkingOn) body.temperature = model.temperature;
  deepMerge(body, model.extraBody);
  return { body, headers };
}

async function* stream(opts) {
  const { provider, apiKey, model, signal, fetchImpl, onRequest, onResponse } = opts;
  const f = fetchImpl || fetch;
  const { body, headers: extraHeaders } = buildRequest(opts);
  const url = withQuery(joinUrl(provider.baseUrl, '/v1/messages'), provider.query);
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    ...authHeaders(provider, apiKey),
    ...extraHeaders,
    ...(provider.headers || {}),
  };
  if (onRequest) onRequest({ url, method: 'POST', headers: redactHeaders(headers), body });
  const t0 = Date.now();
  const res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(netErr(url));
  if (onResponse) onResponse({ status: res.status, ms: Date.now() - t0 });
  if (!res.ok) throw await readErrorBody(res);

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    // Gateway ignored stream:true — replay the full message as events.
    const j = await res.json();
    yield* replayMessage(j);
    return;
  }

  const blocks = new Map();
  for await (const ev of readSSE(res.body, signal)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d;
    try { d = JSON.parse(ev.data); } catch { continue; }
    const type = d.type || ev.event;
    switch (type) {
      case 'message_start': {
        const u = (d.message && d.message.usage) || {};
        yield { type: 'usage', usage: { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 } };
        break;
      }
      case 'content_block_start': {
        const cb = d.content_block || {};
        blocks.set(d.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
        if (cb.type === 'thinking') {
          yield { type: 'reasoning_start' };
          if (cb.thinking) yield { type: 'reasoning', text: cb.thinking };
        } else if (cb.type === 'redacted_thinking') {
          yield { type: 'reasoning_redacted', data: cb.data };
        } else if (cb.type === 'text' && cb.text) {
          yield { type: 'text', text: cb.text };
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          yield { type: 'tool_call_start', id: cb.id, name: cb.name };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = d.delta || {};
        const b = blocks.get(d.index);
        if (delta.type === 'text_delta') yield { type: 'text', text: delta.text };
        else if (delta.type === 'thinking_delta') { if (delta.thinking) yield { type: 'reasoning', text: delta.thinking }; }
        else if (delta.type === 'signature_delta') yield { type: 'reasoning_signature', signature: delta.signature };
        else if (delta.type === 'input_json_delta' && b) {
          b.json += delta.partial_json || '';
          yield { type: 'tool_call_delta', id: b.id, name: b.name, partial: b.json };
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks.get(d.index);
        if (b && b.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, args: parseToolArgs(b.json) };
        if (b && b.type === 'thinking') yield { type: 'reasoning_end' };
        break;
      }
      case 'message_delta': {
        const u = d.usage || {};
        if (u.output_tokens != null || u.input_tokens != null) {
          yield { type: 'usage', usage: { output: u.output_tokens || 0, ...(u.input_tokens ? { input: u.input_tokens } : {}), ...(u.output_tokens_details && u.output_tokens_details.thinking_tokens ? { reasoning: u.output_tokens_details.thinking_tokens } : {}) } };
        }
        if (d.delta && d.delta.stop_reason) yield { type: 'stop', reason: d.delta.stop_reason };
        break;
      }
      case 'error': {
        const e = new Error((d.error && d.error.message) || 'Stream error');
        e.status = (d.error && d.error.type) || 'stream_error';
        throw e;
      }
      default: break;
    }
  }
}

function* replayMessage(j) {
  const u = j.usage || {};
  yield { type: 'usage', usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 } };
  for (const b of j.content || []) {
    if (b.type === 'thinking') { yield { type: 'reasoning_start' }; yield { type: 'reasoning', text: b.thinking || '' }; if (b.signature) yield { type: 'reasoning_signature', signature: b.signature }; yield { type: 'reasoning_end' }; }
    else if (b.type === 'redacted_thinking') yield { type: 'reasoning_redacted', data: b.data };
    else if (b.type === 'text') yield { type: 'text', text: b.text };
    else if (b.type === 'tool_use') yield { type: 'tool_call', id: b.id, name: b.name, args: b.input || {} };
  }
  if (j.stop_reason) yield { type: 'stop', reason: j.stop_reason };
}

module.exports = { stream, buildRequest, convertMessages };
