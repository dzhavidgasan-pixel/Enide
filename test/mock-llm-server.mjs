// A scripted fake LLM server speaking Anthropic, OpenAI and Gemini streaming formats.
import http from 'node:http';

export function sseAnthropic(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
export function sseData(objs, done = true) {
  return objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
}

// Helpers to build Anthropic message streams
export function anthropicStream({ thinking, signature, text, toolUse, stop = 'end_turn', inputTokens = 100, outputTokens = 20 }) {
  const ev = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 7 } } }];
  let i = 0;
  if (thinking != null) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const part of chunk(thinking, 7)) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: part } });
    if (signature) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature } });
    ev.push({ type: 'content_block_stop', index: i });
    i++;
  }
  if (text) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    for (const part of chunk(text, 5)) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: part } });
    ev.push({ type: 'content_block_stop', index: i });
    i++;
  }
  for (const tu of toolUse || []) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } });
    const json = JSON.stringify(tu.input);
    for (const part of chunk(json, 9)) ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: part } });
    ev.push({ type: 'content_block_stop', index: i });
    i++;
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: toolUse && toolUse.length ? 'tool_use' : stop }, usage: { output_tokens: outputTokens } });
  ev.push({ type: 'message_stop' });
  return sseAnthropic(ev);
}

export function openaiStream({ reasoning, text, toolCalls, usage = { prompt_tokens: 50, completion_tokens: 10 } }) {
  const chunks = [];
  const base = { id: 'c1', object: 'chat.completion.chunk', model: 'x' };
  for (const part of chunk(reasoning || '', 6)) chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: part } }] });
  for (const part of chunk(text || '', 4)) chunks.push({ ...base, choices: [{ index: 0, delta: { content: part } }] });
  (toolCalls || []).forEach((tc, idx) => {
    const args = JSON.stringify(tc.args);
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
    for (const part of chunk(args, 8)) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: part } }] } }] });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls && toolCalls.length ? 'tool_calls' : 'stop' }] });
  chunks.push({ ...base, choices: [], usage });
  return sseData(chunks);
}

export function responsesStream({ summary, encrypted, text, call }) {
  const ev = [];
  const push = (o) => ev.push(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  push({ type: 'response.created', response: { id: 'resp_1' } });
  if (summary != null) {
    push({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } });
    push({ type: 'response.reasoning_summary_part.added', item_id: 'rs_1' });
    for (const part of chunk(summary, 6)) push({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: part });
    push({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', encrypted_content: encrypted || 'ENC', summary: [{ type: 'summary_text', text: summary }] } });
  }
  if (text) for (const part of chunk(text, 5)) push({ type: 'response.output_text.delta', item_id: 'msg_1', delta: part });
  if (call) {
    push({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: call.id, name: call.name, arguments: '' } });
    const a = JSON.stringify(call.args);
    for (const part of chunk(a, 7)) push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: part });
    push({ type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: call.id, name: call.name, arguments: a } });
  }
  push({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, output_tokens: 9, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } } } });
  return ev.join('');
}

export function geminiStream({ thought, text, functionCall, signature }) {
  const objs = [];
  if (thought) objs.push({ candidates: [{ content: { role: 'model', parts: [{ text: thought, thought: true }] } }] });
  if (text) for (const part of chunk(text, 6)) objs.push({ candidates: [{ content: { role: 'model', parts: [{ text: part }] } }] });
  if (functionCall) objs.push({ candidates: [{ content: { role: 'model', parts: [{ functionCall, thoughtSignature: signature }] } }] });
  objs.push({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, thoughtsTokenCount: 5 } });
  return sseData(objs, false);
}

function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

export async function startMockServer() {
  const scripts = { anthropic: [], openai: [], gemini: [], responses: [] };
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const url = req.url;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const proto = url.startsWith('/anthropic') ? 'anthropic' : url.startsWith('/gemini') ? 'gemini' : url.includes('/responses') ? 'responses' : 'openai';
      requests.push({ proto, url, method: req.method, headers: req.headers, body });
      if (url.startsWith('/site/')) {
        const pages = {
          '/site/docs/': '<html><head><title>Widget docs</title></head><body><nav>menu</nav><main><h1>Widgets</h1><p>Create a widget with makeWidget(name). Widgets are blue by default.</p><a href="/site/docs/colors">Colors</a> <a href="/site/other">outside</a></main></body></html>',
          '/site/docs/colors': '<html><head><title>Colors</title></head><body><main><h1>Colors</h1><p>Call widget.paint("red") to change the color of a widget. The flux capacitor setting controls glow intensity.</p></main></body></html>',
        };
        if (pages[url]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[url]); }
        res.writeHead(404); return res.end('nope');
      }
      if (req.method === 'POST' && /\/embeddings$/.test(url)) {
        const vec = (t) => { const v = new Array(32).fill(0); for (const w of String(t).toLowerCase().split(/\W+/)) if (w) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 32] += 1; } return v; };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: vec(t) })), usage: { prompt_tokens: 10 } }));
      }
      if (req.method === 'GET' && /models/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (proto === 'gemini') return res.end(JSON.stringify({ models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 1000000, supportedGenerationMethods: ['generateContent'] }] }));
        return res.end(JSON.stringify({ data: [{ id: `${proto}-model-a` }, { id: `${proto}-model-b`, context_length: 64000 }] }));
      }
      const handler = scripts[proto].shift();
      if (!handler) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'no script left' } })); }
      let out;
      try { out = await handler(body, req); } catch (e) { console.error('  mock handler assertion:', e.message); res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'mock assertion: ' + e.message } })); }
      if (out && out.status) { res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out.json)); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // stream in small pieces to exercise the parser
      const parts = out.match(/[\s\S]{1,37}/g) || [];
      let i = 0;
      const tick = () => { if (i < parts.length) { res.write(parts[i++]); setImmediate(tick); } else res.end(); };
      tick();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    scripts, requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
