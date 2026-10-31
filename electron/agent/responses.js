'use strict';
// OpenAI Responses API adapter (/v1/responses) — needed for models that are Responses-only
// (e.g. codex / pro variants). Streams reasoning summaries and round-trips encrypted reasoning.
const { readSSE, joinUrl, readErrorBody, netErr } = require('./sse');
const { authHeaders, redactHeaders, deepMerge, parseToolArgs, genId, withQuery } = require('./util');

function convertInput(messages, provider) {
  const input = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) content.push({ type: 'input_text', text: b.text });
        else if (b.type === 'image') content.push({ type: 'input_image', image_url: `data:${b.mediaType};base64,${b.data}` });
      }
      if (content.length) input.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const same = m.meta && m.meta.providerId === provider.id;
      for (const b of m.content || []) {
        if (b.type === 'reasoning' && same && b.signature) {
          let meta = null;
          try { meta = JSON.parse(b.signature); } catch {}
          if (meta && meta.encrypted_content) {
            input.push({ type: 'reasoning', ...(meta.id ? { id: meta.id } : {}), summary: b.text ? [{ type: 'summary_text', text: b.text }] : [], encrypted_content: meta.encrypted_content });
          }
        } else if (b.type === 'text' && b.text) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: b.text }] });
        } else if (b.type === 'tool_call') {
          input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: b.args && !b.args.__parseError ? JSON.stringify(b.args) : (b.args && b.args.__raw) || '{}' });
        }
      }
    } else if (m.role === 'tool') {
      const imgs = [];
      for (const b of m.content || []) {
        if (b.type !== 'tool_result') continue;
        input.push({ type: 'function_call_output', call_id: b.id, output: String(b.output == null ? '' : b.output) || '(empty)' });
        if (b.images) imgs.push(...b.images);
      }
      if (imgs.length) input.push({ role: 'user', content: [{ type: 'input_text', text: 'Image output from the tool call(s) above:' }, ...imgs.map((im) => ({ type: 'input_image', image_url: `data:${im.mediaType};base64,${im.data}` }))] });
    }
  }
  return input;
}

function buildRequest({ provider, model, system, messages, tools, reasoning, maxTokens }) {
  const body = { model: model.id, input: convertInput(messages, provider), stream: true, store: false };
  if (system) body.instructions = system;
  if (tools && tools.length && model.tools !== false) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: false }));
  }
  const mt = maxTokens || model.maxOutput;
  if (mt) body.max_output_tokens = mt;
  if (model.reasoningStyle === 'openai-responses' || model.reasoningStyle === 'openai-effort') {
    body.include = ['reasoning.encrypted_content'];
    if (reasoning && reasoning.enabled) body.reasoning = { effort: reasoning.effort === 'max' ? 'high' : reasoning.effort || 'medium', summary: 'auto' };
  }
  if (model.temperature != null) body.temperature = model.temperature;
  deepMerge(body, model.extraBody);
  return { body };
}

async function* stream(opts) {
  const { provider, apiKey, signal, fetchImpl, onRequest, onResponse } = opts;
  const f = fetchImpl || fetch;
  const { body } = buildRequest(opts);
  const url = withQuery(joinUrl(provider.baseUrl, '/responses'), provider.query);
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders(provider, apiKey), ...(provider.headers || {}) };
  if (onRequest) onRequest({ url, method: 'POST', headers: redactHeaders(headers), body });
  const t0 = Date.now();
  const res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(netErr(url));
  if (onResponse) onResponse({ status: res.status, ms: Date.now() - t0 });
  if (!res.ok) throw await readErrorBody(res);

  const calls = new Map(); // item_id -> { call_id, name, args }
  let reasoningOpen = false;
  let summaryParts = 0;
  for await (const ev of readSSE(res.body, signal)) {
    if (!ev.data || ev.data === '[DONE]') continue;
    let d;
    try { d = JSON.parse(ev.data); } catch { continue; }
    const type = d.type || ev.event;
    switch (type) {
      case 'response.output_item.added': {
        const it = d.item || {};
        if (it.type === 'function_call') {
          calls.set(it.id, { call_id: it.call_id || it.id, name: it.name, args: it.arguments || '' });
          yield { type: 'tool_call_start', id: it.call_id || it.id, name: it.name };
        } else if (it.type === 'reasoning') {
          reasoningOpen = true; summaryParts = 0;
          yield { type: 'reasoning_start' };
        }
        break;
      }
      case 'response.reasoning_summary_part.added':
        if (summaryParts++ > 0) yield { type: 'reasoning', text: '\n\n' };
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (!reasoningOpen) { reasoningOpen = true; yield { type: 'reasoning_start' }; }
        if (d.delta) yield { type: 'reasoning', text: d.delta };
        break;
      case 'response.output_text.delta':
        if (reasoningOpen) { reasoningOpen = false; yield { type: 'reasoning_end' }; }
        if (d.delta) yield { type: 'text', text: d.delta };
        break;
      case 'response.function_call_arguments.delta': {
        const c = calls.get(d.item_id);
        if (c) { c.args += d.delta || ''; yield { type: 'tool_call_delta', id: c.call_id, name: c.name, partial: c.args }; }
        break;
      }
      case 'response.output_item.done': {
        const it = d.item || {};
        if (it.type === 'reasoning') {
          if (it.encrypted_content) yield { type: 'reasoning_signature', signature: JSON.stringify({ id: it.id, encrypted_content: it.encrypted_content }) };
          if (reasoningOpen) { reasoningOpen = false; yield { type: 'reasoning_end' }; }
        } else if (it.type === 'function_call') {
          const c = calls.get(it.id) || {};
          yield { type: 'tool_call', id: it.call_id || c.call_id || genId('call'), name: it.name || c.name, args: parseToolArgs(it.arguments != null ? it.arguments : c.args) };
          calls.delete(it.id);
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const r = d.response || {};
        const u = r.usage || {};
        yield { type: 'usage', usage: { input: (u.input_tokens || 0) - ((u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0), cacheRead: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0, output: u.output_tokens || 0, reasoning: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0 } };
        const incomplete = r.incomplete_details && r.incomplete_details.reason;
        yield { type: 'stop', reason: incomplete === 'max_output_tokens' ? 'max_tokens' : (r.status || 'completed') };
        break;
      }
      case 'response.failed':
      case 'error': {
        const err = (d.response && d.response.error) || d.error || d;
        throw new Error(err.message || JSON.stringify(err));
      }
      default: break;
    }
  }
  if (reasoningOpen) yield { type: 'reasoning_end' };
}

module.exports = { stream, buildRequest, convertInput };
