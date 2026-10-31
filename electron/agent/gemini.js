'use strict';
// Google Gemini native API adapter (generateContent streaming) with thought summaries
// and thought-signature round-tripping for tool calls.
const { readSSE, joinUrl, readErrorBody, netErr } = require('./sse');
const { authHeaders, redactHeaders, deepMerge, genId, sanitizeSchemaForGemini, withQuery } = require('./util');

function convertMessages(messages, provider) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const names = new Map();
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', (m.content || []).map((b) => (b.type === 'image'
        ? { inlineData: { mimeType: b.mediaType, data: b.data } }
        : { text: b.text || '' })).filter((p) => p.inlineData || p.text));
    } else if (m.role === 'assistant') {
      const same = m.meta && m.meta.providerId === provider.id;
      const parts = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text, ...(same && b.signature ? { thoughtSignature: b.signature } : {}) });
        else if (b.type === 'tool_call') {
          names.set(b.id, b.name);
          parts.push({
            functionCall: { name: b.name, args: b.args && !b.args.__parseError ? b.args : {}, ...(b.nativeId ? { id: b.nativeId } : {}) },
            ...(same && b.signature ? { thoughtSignature: b.signature } : {}),
          });
        }
      }
      push('model', parts);
    } else if (m.role === 'tool') {
      const parts = [];
      for (const b of m.content || []) {
        if (b.type !== 'tool_result') continue;
        parts.push({
          functionResponse: {
            name: b.name || names.get(b.id) || 'tool',
            ...(b.nativeId ? { id: b.nativeId } : {}),
            response: b.isError ? { error: String(b.output || '') } : { result: String(b.output || '') },
          },
        });
        for (const img of b.images || []) parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
      }
      push('user', parts);
    }
  }
  return contents;
}

function buildRequest({ provider, model, system, messages, tools, reasoning, maxTokens }) {
  const body = { contents: convertMessages(messages, provider), generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools && tools.length && model.tools !== false) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || '', parameters: sanitizeSchemaForGemini(t.parameters || { type: 'object', properties: {} }) })) }];
  }
  const mt = maxTokens || model.maxOutput;
  if (mt) body.generationConfig.maxOutputTokens = mt;
  if (model.temperature != null) body.generationConfig.temperature = model.temperature;
  if (model.reasoningStyle === 'gemini') {
    const on = reasoning && reasoning.enabled;
    const legacy = /gemini-(1|2)\./.test(model.id);
    if (on) {
      body.generationConfig.thinkingConfig = { includeThoughts: true };
      if (legacy) body.generationConfig.thinkingConfig.thinkingBudget = -1;
      else if (reasoning.effort) body.generationConfig.thinkingConfig.thinkingLevel = ['high', 'xhigh', 'max'].includes(reasoning.effort) ? 'high' : 'low';
    } else if (legacy && /flash/.test(model.id)) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }
  deepMerge(body, model.extraBody);
  return { body };
}

async function* stream(opts) {
  const { provider, apiKey, model, signal, fetchImpl, onRequest, onResponse } = opts;
  const f = fetchImpl || fetch;
  const { body } = buildRequest(opts);
  const url = withQuery(joinUrl(provider.baseUrl, `/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`), provider.query);
  const headers = { 'content-type': 'application/json', ...authHeaders(provider, apiKey), ...(provider.headers || {}) };
  if (onRequest) onRequest({ url, method: 'POST', headers: redactHeaders(headers), body });
  const t0 = Date.now();
  const res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(netErr(url));
  if (onResponse) onResponse({ status: res.status, ms: Date.now() - t0 });
  if (!res.ok) throw await readErrorBody(res);

  let reasoningOpen = false;
  const handle = function* (j) {
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const um = j.usageMetadata;
    if (um) yield { type: 'usage', usage: { input: um.promptTokenCount || 0, output: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0), reasoning: um.thoughtsTokenCount || 0, cacheRead: um.cachedContentTokenCount || 0 } };
    const cand = (j.candidates || [])[0];
    if (!cand) return;
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p.thought && p.text != null) {
        if (!reasoningOpen) { reasoningOpen = true; yield { type: 'reasoning_start' }; }
        yield { type: 'reasoning', text: p.text };
        continue;
      }
      if (reasoningOpen) { reasoningOpen = false; yield { type: 'reasoning_end' }; }
      if (p.functionCall) {
        const id = genId('call');
        yield { type: 'tool_call', id, nativeId: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {}, signature: p.thoughtSignature };
      } else if (p.text != null) {
        if (p.text) yield { type: 'text', text: p.text };
        if (p.thoughtSignature) yield { type: 'text_signature', signature: p.thoughtSignature };
      } else if (p.thoughtSignature) {
        yield { type: 'text_signature', signature: p.thoughtSignature };
      }
    }
    if (cand.finishReason) yield { type: 'stop', reason: cand.finishReason };
  };

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const j = await res.json();
    for (const item of Array.isArray(j) ? j : [j]) yield* handle(item);
  } else {
    for await (const ev of readSSE(res.body, signal)) {
      if (!ev.data) continue;
      let j;
      try { j = JSON.parse(ev.data); } catch { continue; }
      yield* handle(j);
    }
  }
  if (reasoningOpen) yield { type: 'reasoning_end' };
}

module.exports = { stream, buildRequest, convertMessages };
