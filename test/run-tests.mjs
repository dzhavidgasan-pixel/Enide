// Core tests: run with `npm test` (no Electron needed).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockServer, anthropicStream, openaiStream, geminiStream, responsesStream } from './mock-llm-server.mjs';

const require = createRequire(import.meta.url);
const { joinUrl } = require('../electron/agent/sse.js');
const { ThinkTagSplitter, sanitizeSchemaForGemini } = require('../electron/agent/util.js');
const { hunks } = require('../electron/lib/diff.js');
const { globToRegExp } = require('../electron/lib/fsutil.js');
const { AgentRunner, closeOrphans, fitContext } = require('../electron/agent/agent.js');
const { ChatStore } = require('../electron/agent/chats.js');
const { CheckpointStore } = require('../electron/agent/checkpoints.js');
const { providerFromPreset, listModels, testConnection } = require('../electron/agent/providers.js');
const tools = require('../electron/agent/tools.js');
const { McpManager } = require('../electron/plugins/mcp.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enide-test-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });

console.log('\nunits');
await test('joinUrl', () => {
  assert.equal(joinUrl('https://api.z.ai/api/anthropic', '/v1/messages'), 'https://api.z.ai/api/anthropic/v1/messages');
  assert.equal(joinUrl('https://api.anthropic.com/v1', '/v1/messages'), 'https://api.anthropic.com/v1/messages');
  assert.equal(joinUrl('https://api.openai.com/v1/', '/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.z.ai/api/paas/v4', '/chat/completions'), 'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(joinUrl('https://generativelanguage.googleapis.com', '/v1beta/models/x:streamGenerateContent?alt=sse'), 'https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent?alt=sse');
});
await test('think-tag splitter', () => {
  const s = new ThinkTagSplitter();
  const out = [...['<thi', 'nk>reason', 'ing</th', 'ink>Hel', 'lo <think>x'].flatMap((c) => s.push(c)), ...s.flush()];
  const reasoning = out.filter((o) => o.type === 'reasoning').map((o) => o.text).join('');
  const text = out.filter((o) => o.type === 'text').map((o) => o.text).join('');
  assert.equal(reasoning, 'reasoning');
  assert.equal(text, 'Hello <think>x');
});
await test('diff hunks', () => {
  const h = hunks('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nC\nd\ne\nf\ng\nh\ni');
  assert.equal(h.added, 2); assert.equal(h.removed, 1);
  assert.ok(h.hunks.length >= 1);
  const flat = h.hunks.flatMap((x) => x.lines.map((l) => l.t + l.s));
  assert.ok(flat.includes('-c') && flat.includes('+C') && flat.includes('+i'));
  const h2 = hunks('', 'x\ny');
  assert.equal(h2.added, 2); assert.equal(h2.removed, 0);
});
await test('glob', () => {
  assert.ok(globToRegExp('*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y/z.tsx'));
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/z.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
});
await test('gemini schema sanitize', () => {
  const s = sanitizeSchemaForGemini({ type: 'object', additionalProperties: false, $schema: 'x', properties: { a: { type: ['string', 'null'], default: 'q' } } });
  assert.deepEqual(s, { type: 'object', properties: { a: { type: 'string', nullable: true } } });
});
await test('closeOrphans + fitContext', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'x', args: {} }] }];
  assert.equal(closeOrphans(msgs), true);
  assert.equal(msgs[2].role, 'tool');
  const big = [];
  for (let i = 0; i < 30; i++) big.push({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  const f = fitContext(big, 5000);
  assert.ok(f.trimmed && f.messages.length < big.length && f.messages[0].role === 'user');
});

console.log('\ntools');
const ctx = { root: ws, hasWorkspace: true };
await test('write/read/edit/grep/glob/list', async () => {
  await tools.EXEC.write_file({ path: 'src/app.js', content: 'const a = 1;\nconsole.log("hello world");\n' }, ctx);
  const r = await tools.EXEC.read_file({ path: 'src/app.js' }, ctx);
  assert.match(r.output, /1│const a = 1;/);
  const e = await tools.EXEC.edit_file({ path: 'src/app.js', old_string: 'hello world', new_string: 'hello enide' }, ctx);
  assert.equal(e.display.added, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'src/app.js'), 'utf8').includes('hello enide'), true);
  await assert.rejects(tools.EXEC.edit_file({ path: 'src/app.js', old_string: 'nope', new_string: 'x' }, ctx), /not found/);
  const g = await tools.EXEC.grep({ pattern: 'hello\\s+enide' }, ctx);
  assert.match(g.output, /src\/app\.js:2:/);
  const gl = await tools.EXEC.glob({ pattern: '**/*.js' }, ctx);
  assert.match(gl.output, /src\/app\.js/);
  const ls = await tools.EXEC.list_dir({ depth: 2 }, ctx);
  assert.match(ls.output, /src\/\n\s+app\.js/);
});
await test('run_command + background + approval policy', async () => {
  const r = await tools.EXEC.run_command({ command: 'echo hi && echo err 1>&2 && exit 3' }, ctx);
  assert.match(r.output, /Exit code: 3/); assert.match(r.output, /hi/); assert.match(r.output, /err/);
  const b = await tools.EXEC.run_command({ command: 'for i in 1 2 3; do echo tick$i; sleep 0.2; done', background: true }, ctx);
  const id = /as (p\w+)/.exec(b.output)[1];
  await new Promise((res) => setTimeout(res, 800));
  const c = await tools.EXEC.check_process({ id }, ctx);
  assert.match(c.output, /exited|running/);
  const pol = { command: 'ask', allowList: ['git status', 'ls'], denyList: ['sudo '], write: 'auto', writeOutside: 'ask' };
  assert.equal(tools.approvalFor('run_command', { command: 'ls -la' }, ctx, pol).needs, false);
  assert.equal(tools.approvalFor('run_command', { command: 'ls; rm x' }, ctx, pol).needs, true);
  assert.equal(tools.approvalFor('run_command', { command: 'lsof' }, ctx, pol).needs, true);
  assert.equal(tools.approvalFor('edit_file', { path: 'a.js' }, ctx, pol).needs, false);
  assert.equal(tools.approvalFor('edit_file', { path: '/etc/hosts' }, ctx, pol).needs, true);
  assert.equal(tools.approvalFor('run_command', { command: 'sudo ls' }, ctx, { ...pol, command: 'auto' }).needs, true);
});

// ---------- end-to-end agent runs against the mock server ----------
const mock = await startMockServer();
const chats = new ChatStore(path.join(tmp, 'chats'));
const checkpoints = new CheckpointStore(path.join(tmp, 'checkpoints'));

function makeRunner(settings, keyFor = () => 'sk-test-key-1234567890') {
  const events = [];
  const logs = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const runner = new AgentRunner({
    getSettings: () => settings,
    getApiKey: async (id) => keyFor(id),
    chats, checkpoints,
    toolHost: null,
    emit: (runId, ev) => { events.push(ev); if (ev.type === 'done') resolveDone(); if (ev.type === 'approval_request' && settings.__autoApprove) setTimeout(() => runner.approve(runId, ev.callId, { action: settings.__autoApprove }), 10); },
    logRequest: (e) => { logs.push(e); return e.id || 'log' + logs.length; },
  });
  return { runner, events, logs, done };
}

console.log('\nagent · anthropic protocol (Z.ai-style gateway)');
await test('thinking + tool loop + signature round-trip', async () => {
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello world\n');
  const provider = { ...providerFromPreset('zai-anthropic', 'zai'), baseUrl: mock.url + '/anthropic' };
  const settings = { providers: [provider], agent: { maxSteps: 10 } };
  mock.scripts.anthropic.push(
    () => anthropicStream({ thinking: 'Need to read hello.txt first.', signature: 'SIG123', text: 'Reading the file.', toolUse: [{ id: 'toolu_1', name: 'read_file', input: { path: 'hello.txt' } }] }),
    (body) => {
      const last = body.messages[body.messages.length - 1];
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].type, 'tool_result');
      assert.match(last.content[0].content[0].text, /hello world/);
      const asst = body.messages[body.messages.length - 2];
      assert.equal(asst.content[0].type, 'thinking');
      assert.equal(asst.content[0].signature, 'SIG123');
      return anthropicStream({ text: 'Editing.', toolUse: [{ id: 'toolu_2', name: 'edit_file', input: { path: 'hello.txt', old_string: 'world', new_string: 'Enide' } }] });
    },
    () => anthropicStream({ text: 'Готово — заменил world на Enide.' }),
  );
  const { runner, events, logs, done } = makeRunner(settings);
  await runner.start({ text: 'Replace world with Enide in hello.txt', mode: 'agent', root: ws, modelRef: { providerId: 'zai', modelId: 'glm-5.2' }, reasoning: { enabled: true, effort: 'high' } });
  await done;
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, err && err.message);
  assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hello Enide\n');
  const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join('');
  assert.equal(reasoning, 'Need to read hello.txt first.');
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
  assert.ok(text.includes('Готово'));
  const req = mock.requests.filter((r) => r.proto === 'anthropic')[0];
  assert.equal(req.url, '/anthropic/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-test-key-1234567890');
  assert.equal(req.headers['authorization'], 'Bearer sk-test-key-1234567890');
  assert.deepEqual(req.body.thinking, { type: 'enabled', budget_tokens: 24000 });
  assert.ok(req.body.tools.some((t) => t.name === 'edit_file'));
  assert.ok(req.body.system[0].text.includes('You are Enide'));
  assert.equal(logs[0].headers['x-api-key'].includes('…'), true, 'key must be redacted in log');
  const usage = events.filter((e) => e.type === 'usage').pop();
  assert.equal(usage.usage.input, 100);
  // checkpoint restore
  const startEv = events.find((e) => e.type === 'run_start');
  const restored = await checkpoints.restore(startEv.chatId, [startEv.userMessage.id]);
  assert.ok(restored.length === 1);
  assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hello world\n');
});

console.log('\nagent · openai protocol');
await test('reasoning_content + split tool calls + echo', async () => {
  const provider = { ...providerFromPreset('deepseek', 'ds'), baseUrl: mock.url + '/openai/v1' };
  const settings = { providers: [provider], agent: { maxSteps: 10 } };
  mock.scripts.openai.push(
    () => openaiStream({ reasoning: 'Listing the folder.', toolCalls: [{ id: 'call_a', name: 'list_dir', args: { path: '.' } }, { id: 'call_b', name: 'glob', args: { pattern: '*.txt' } }] }),
    (body) => {
      const asst = body.messages.find((m) => m.role === 'assistant');
      assert.equal(asst.tool_calls.length, 2);
      assert.equal(asst.reasoning_content, 'Listing the folder.');
      const toolMsgs = body.messages.filter((m) => m.role === 'tool');
      assert.equal(toolMsgs.length, 2);
      assert.match(toolMsgs[1].content, /hello\.txt/);
      return openaiStream({ text: 'Found hello.txt.' });
    },
  );
  const { runner, events, done } = makeRunner(settings);
  await runner.start({ text: 'what files?', mode: 'agent', root: ws, modelRef: { providerId: 'ds', modelId: 'deepseek-reasoner' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 2);
  const req = mock.requests.filter((r) => r.proto === 'openai')[0];
  assert.equal(req.url, '/openai/v1/chat/completions');
  assert.equal(req.body.stream_options.include_usage, true);
  assert.equal(req.body.messages[0].role, 'system');
});
await test('ask mode exposes read-only tools only', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'co'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push((body) => {
    const names = body.tools.map((t) => t.function.name);
    assert.ok(names.includes('read_file') && !names.includes('edit_file') && !names.includes('run_command'));
    return openaiStream({ text: '<think>hidden?</think>Answer.' });
  });
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'explain', mode: 'ask', root: ws, modelRef: { providerId: 'co', modelId: 'm1' } });
  await done;
  assert.equal(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join(''), 'hidden?');
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Answer.');
});
await test('command approval: request → allow → runs', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'co2'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'echo approved-run' } }] }),
    (body) => { assert.match(body.messages.at(-1).content, /approved-run/); return openaiStream({ text: 'ok' }); },
  );
  const settings = { providers: [provider], __autoApprove: 'allow' };
  const { runner, events, done } = makeRunner(settings);
  await runner.start({ text: 'run it', mode: 'agent', root: ws, modelRef: { providerId: 'co2', modelId: 'm1' } });
  await done;
  assert.ok(events.some((e) => e.type === 'approval_request' && e.preview && e.preview.command === 'echo approved-run'));
  assert.ok(events.some((e) => e.type === 'tool_result' && /approved-run/.test(e.output)));
});
await test('command approval: reject is reported to the model', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'co3'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'touch nope.txt' } }] }),
    (body) => { assert.match(body.messages.at(-1).content, /rejected/); return openaiStream({ text: 'understood' }); },
  );
  const { runner, done } = makeRunner({ providers: [provider], __autoApprove: 'reject' });
  await runner.start({ text: 'x', mode: 'agent', root: ws, modelRef: { providerId: 'co3', modelId: 'm1' } });
  await done;
  assert.equal(fs.existsSync(path.join(ws, 'nope.txt')), false);
});
await test('HTTP error surfaces message', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'co4'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(() => ({ status: 401, json: { error: { message: 'Invalid API key' } } }));
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'x', mode: 'agent', root: ws, modelRef: { providerId: 'co4', modelId: 'm1' } });
  await done;
  const e = events.find((x) => x.type === 'error');
  assert.ok(e && /401/.test(e.message) && /Invalid API key/.test(e.message));
});

console.log('\nagent · gemini protocol');
await test('thoughts + functionCall + thoughtSignature echo', async () => {
  const provider = { ...providerFromPreset('gemini', 'gm'), baseUrl: mock.url + '/gemini', models: [{ id: 'gemini-3-pro' }] };
  mock.scripts.gemini.push(
    () => geminiStream({ thought: 'Check the file.', functionCall: { name: 'read_file', args: { path: 'hello.txt' } }, signature: 'GSIG' }),
    (body) => {
      const model = body.contents.find((c) => c.role === 'model');
      assert.equal(model.parts[0].thoughtSignature, 'GSIG');
      const fr = body.contents.at(-1).parts[0].functionResponse;
      assert.equal(fr.name, 'read_file');
      assert.match(fr.response.result, /hello/);
      assert.ok(body.systemInstruction.parts[0].text.includes('Enide'));
      return geminiStream({ text: 'It says hello world.' });
    },
  );
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'read hello', mode: 'agent', root: ws, modelRef: { providerId: 'gm', modelId: 'gemini-3-pro' }, reasoning: { enabled: true, effort: 'high' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.equal(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join(''), 'Check the file.');
  const req = mock.requests.filter((r) => r.proto === 'gemini')[0];
  assert.equal(req.url, '/gemini/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse');
  assert.deepEqual(req.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' });
});

console.log('\nagent · openai responses protocol');
await test('reasoning summary + encrypted round-trip + function call', async () => {
  const provider = { ...providerFromPreset('openai-responses', 'rsp'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'gpt-5-codex' }] };
  mock.scripts.responses.push(
    () => responsesStream({ summary: 'Look at files.', encrypted: 'ENCRYPTED123', call: { id: 'call_r1', name: 'glob', args: { pattern: '*.txt' } } }),
    (body) => {
      const rs = body.input.find((i) => i.type === 'reasoning');
      assert.equal(rs.encrypted_content, 'ENCRYPTED123');
      assert.equal(rs.id, 'rs_1');
      const fc = body.input.find((i) => i.type === 'function_call');
      assert.equal(fc.call_id, 'call_r1');
      const out = body.input.find((i) => i.type === 'function_call_output');
      assert.match(out.output, /hello\.txt/);
      assert.ok(body.instructions.includes('Enide'));
      assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
      return responsesStream({ text: 'Found it.' });
    },
  );
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'find txt', mode: 'agent', root: ws, modelRef: { providerId: 'rsp', modelId: 'gpt-5-codex' }, reasoning: { enabled: true, effort: 'high' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.equal(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join(''), 'Look at files.');
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'Found it.');
  const req = mock.requests.find((r) => r.proto === 'responses');
  assert.equal(req.url, '/openai/v1/responses');
});
await test('resume after error does not duplicate the user message', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'co5'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(() => ({ status: 500, json: { error: { message: 'boom' } } }), (body) => {
    assert.equal(body.messages.filter((m) => m.role === 'user').length, 1);
    return openaiStream({ text: 'recovered' });
  });
  const r1 = makeRunner({ providers: [provider] });
  await r1.runner.start({ text: 'hi', mode: 'agent', root: ws, modelRef: { providerId: 'co5', modelId: 'm1' } });
  await r1.done;
  const chatId = r1.events.find((e) => e.type === 'run_start').chatId;
  const r2 = makeRunner({ providers: [provider] });
  await r2.runner.start({ chatId, resume: true, mode: 'agent', root: ws, modelRef: { providerId: 'co5', modelId: 'm1' } });
  await r2.done;
  assert.equal(r2.events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'recovered');
});
await test('computer tool only when enabled; screenshots need no approval', () => {
  assert.ok(!tools.definitions('agent').some((t) => t.name === 'computer'));
  assert.ok(tools.definitions('agent', null, { computerUse: true }).some((t) => t.name === 'computer'));
  assert.ok(!tools.definitions('ask', null, { computerUse: true }).some((t) => t.name === 'computer'));
  assert.equal(tools.approvalFor('computer', { action: 'screenshot' }, ctx, { computer: 'ask' }).needs, false);
  assert.equal(tools.approvalFor('computer', { action: 'click', x: 1, y: 2 }, ctx, { computer: 'ask' }).needs, true);
  assert.equal(tools.approvalFor('computer', { action: 'click' }, ctx, { computer: 'auto' }).needs, false);
});

console.log('\nagent · new features');
await test('subagents run in parallel and report back', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'sub'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  let inflight = 0, maxInflight = 0;
  const slow = (fn) => async (body) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 120)); inflight--; return fn(body); };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 't1', name: 'task', args: { description: 'find a', prompt: 'Find A', type: 'explore' } }, { id: 't2', name: 'task', args: { description: 'find b', prompt: 'Find B', type: 'explore' } }] }),
  );
  // two subagent requests (any order), each answers immediately
  mock.scripts.openai.push(slow((b) => { assert.ok(b.messages[0].content.includes('subagent')); assert.ok(!b.tools.some((t) => t.function.name === 'task')); assert.ok(!b.tools.some((t) => t.function.name === 'edit_file')); return openaiStream({ text: 'report-' + b.messages[1].content }); }));
  mock.scripts.openai.push(slow((b) => openaiStream({ text: 'report-' + b.messages[1].content })));
  mock.scripts.openai.push((b) => {
    const tool = b.messages.filter((m) => m.role === 'tool');
    assert.equal(tool.length, 2);
    assert.ok(tool.some((t) => /report-Find A/.test(t.content)) && tool.some((t) => /report-Find B/.test(t.content)));
    return openaiStream({ text: 'merged' });
  });
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'research', mode: 'agent', root: ws, modelRef: { providerId: 'sub', modelId: 'm1' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.equal(maxInflight, 2, 'subagents should overlap');
  assert.ok(events.some((e) => e.parent === 't1' && e.type === 'text_delta'));
});
await test('hooks: PreToolUse blocks, PostToolUse feeds back, Stop continues', async () => {
  fs.mkdirSync(path.join(ws, '.enide'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.enide', 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'if grep -q forbidden; then echo "no forbidden commands" >&2; exit 2; fi' }] }],
    PostToolUse: [{ matcher: 'edit_file|write_file', hooks: [{ type: 'command', command: 'echo "formatted $ENIDE_FILE" >&2; exit 2' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'test -f "$ENIDE_PROJECT_DIR/done.flag" || { touch "$ENIDE_PROJECT_DIR/done.flag"; echo "run the tests first" >&2; exit 2; }' }] }],
  } }));
  const provider = { ...providerFromPreset('custom-openai', 'hk'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'echo forbidden' } }, { id: 'c2', name: 'write_file', args: { path: 'h.txt', content: 'x' } }] }),
    (b) => {
      const tm = b.messages.filter((m) => m.role === 'tool');
      assert.match(tm[0].content, /Blocked by PreToolUse hook: no forbidden commands/);
      assert.match(tm[1].content, /hook-feedback[\s\S]*formatted .*h\.txt/);
      return openaiStream({ text: 'done' });
    },
    (b) => { assert.match(b.messages.at(-1).content, /stop-hook-feedback[\s\S]*run the tests first/); return openaiStream({ text: 'tests ok' }); },
  );
  const { runner, events, done } = makeRunner({ providers: [provider], agent: { policy: { command: 'auto' } } });
  await runner.start({ text: 'go', mode: 'agent', root: ws, modelRef: { providerId: 'hk', modelId: 'm1' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.ok(events.filter((e) => e.type === 'hook').length >= 3);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'donetests ok');
  fs.rmSync(path.join(ws, '.enide', 'hooks.json'));
});
await test('memory tool writes visible file and lands in the system prompt', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'mem'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1' }] };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 'm', name: 'update_memory', args: { action: 'add', scope: 'project', text: 'Uses pnpm, not npm' } }] }),
    (b) => { assert.match(b.messages[0].content, /<memory scope="project">\n- Uses pnpm, not npm/); return openaiStream({ text: 'saved' }); },
  );
  const { runner, done } = makeRunner({ providers: [provider] });
  await runner.start({ text: 'remember', mode: 'agent', root: ws, modelRef: { providerId: 'mem', modelId: 'm1' } });
  await done;
  assert.equal(fs.readFileSync(path.join(ws, '.enide', 'memory.md'), 'utf8'), '- Uses pnpm, not npm\n');
});
await test('auto-compaction summarizes old turns and keeps the tail', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'cmp'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1', contextWindow: 9000, maxOutput: 1000 }] };
  const chat = await chats.create({ root: ws });
  for (let i = 0; i < 6; i++) chat.messages.push({ id: 'u' + i, role: 'user', content: [{ type: 'text', text: `question ${i} ` + 'lorem '.repeat(600) }] }, { id: 'a' + i, role: 'assistant', content: [{ type: 'text', text: 'answer ' + i }] });
  await chats.save(chat);
  mock.scripts.openai.push(
    (b) => { assert.match(b.messages[0].content, /compress a coding conversation/); assert.match(b.messages[1].content, /question 0/); return openaiStream({ text: 'SUMMARY: user asked questions 0..' }); },
    (b) => { assert.match(JSON.stringify(b.messages), /conversation-summary[\s\S]*SUMMARY: user asked/); assert.ok(!JSON.stringify(b.messages).includes('question 0 ')); return openaiStream({ text: 'ok' }); },
  );
  const { runner, events, done } = makeRunner({ providers: [provider] });
  await runner.start({ chatId: chat.id, text: 'next', mode: 'agent', root: ws, modelRef: { providerId: 'cmp', modelId: 'm1' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.ok(events.some((e) => e.type === 'compacted'));
  const saved = await chats.get(chat.id);
  assert.ok(saved.compaction && saved.compaction.untilId);
  const br = await runner.contextBreakdown(chat.id, { root: ws, modelRef: { providerId: 'cmp', modelId: 'm1' } });
  assert.ok(br.parts.summary > 0 && br.total > 0 && br.window === 9000);
});
await test('router picks fast/vision/smart; unattended runs reject approvals', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'rt'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'fast' }, { id: 'smart' }, { id: 'eye', vision: true }] };
  const router = { fast: { providerId: 'rt', modelId: 'fast' }, smart: { providerId: 'rt', modelId: 'smart' }, vision: { providerId: 'rt', modelId: 'eye' } };
  const r = new AgentRunner({ getSettings: () => ({ providers: [provider], router }) });
  assert.equal(r.route({ router }, { text: 'what is x?', mode: 'ask' }).slot, 'fast');
  assert.equal(r.route({ router }, { text: 'look', attachments: [{ type: 'image' }] }).slot, 'vision');
  assert.equal(r.route({ router }, { text: 'refactor the whole auth module and migrate the database layer to the new ORM, keeping the API stable' }).slot, 'smart');
  mock.scripts.openai.push(
    (b) => { assert.equal(b.model, 'fast'); return openaiStream({ toolCalls: [{ id: 'x', name: 'run_command', args: { command: 'touch unattended.txt' } }] }); },
    (b) => { assert.match(b.messages.at(-1).content, /unattended run/); return openaiStream({ text: 'skipped' }); },
  );
  const { runner, events, done } = makeRunner({ providers: [provider], router });
  await runner.start({ text: 'hi', mode: 'agent', root: ws, unattended: true, modelRef: { providerId: 'auto' } });
  await done;
  assert.ok(events.some((e) => e.type === 'router' && e.slot === 'fast'));
  assert.equal(fs.existsSync(path.join(ws, 'unattended.txt')), false);
});
await test('read_lints finds a syntax error with node --check', async () => {
  fs.writeFileSync(path.join(ws, 'broken.js'), 'function (\n');
  const r = await tools.EXEC.read_lints({ paths: ['broken.js'] }, ctx);
  assert.match(r.output, /broken\.js:\d+/);
  assert.equal(r.display.items[0].severity, 'error');
  fs.rmSync(path.join(ws, 'broken.js'));
});

console.log('\nproviders');
await test('listModels for all protocols', async () => {
  const a = await listModels({ provider: { ...providerFromPreset('custom-anthropic'), baseUrl: mock.url + '/anthropic' }, apiKey: 'k' });
  assert.deepEqual(a.map((m) => m.id), ['anthropic-model-a', 'anthropic-model-b']);
  const o = await listModels({ provider: { ...providerFromPreset('custom-openai'), baseUrl: mock.url + '/openai/v1' }, apiKey: 'k' });
  assert.equal(o[1].contextWindow, 64000);
  const g = await listModels({ provider: { ...providerFromPreset('gemini'), baseUrl: mock.url + '/gemini' }, apiKey: 'k' });
  assert.equal(g[0].id, 'gemini-test');
});
await test('testConnection', async () => {
  mock.scripts.anthropic.push(() => anthropicStream({ text: 'pong' }));
  const r = await testConnection({ provider: { ...providerFromPreset('zai-anthropic'), baseUrl: mock.url + '/anthropic' }, apiKey: 'k', model: 'glm-5.2' });
  assert.equal(r.ok, true); assert.equal(r.text, 'pong');
});

console.log('\nplugins · MCP');
await test('stdio MCP server: list + call', async () => {
  const mgr = new McpManager({ onChange: () => {} });
  await mgr.configure([{ id: 'demo', name: 'demo', type: 'stdio', command: process.execPath, args: [path.resolve('test/mock-mcp-server.mjs')], enabled: true }]);
  const tl = await mgr.list('agent');
  const t = tl.find((x) => x.name === 'mcp__demo__add');
  assert.ok(t, 'tool listed: ' + tl.map((x) => x.name).join(','));
  const r = await mgr.call(t.name, { a: 2, b: 3 }, {});
  assert.equal(r.output.trim(), '5');
  await mgr.shutdown();
});

console.log('\nreal context · approvals');
await test('"ask every time": allow-listed command still asks; user edits it; real context reported', async () => {
  const provider = { ...providerFromPreset('custom-openai', 'ctx'), baseUrl: mock.url + '/openai/v1', models: [{ id: 'm1', contextWindow: 100000 }] };
  mock.scripts.openai.push(
    () => openaiStream({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'ls' } }], usage: { prompt_tokens: 5200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 5000 } } }),
    (b) => { assert.match(b.messages.at(-1).content, /edited-ok/); return openaiStream({ text: 'done', usage: { prompt_tokens: 5400, completion_tokens: 10 } }); },
  );
  const { runner, events, done } = makeRunner({ providers: [provider], agent: { policy: { strict: true, command: 'ask', write: 'ask', allowList: ['ls'] } } });
  const origEmit = runner.d.emit;
  let pendingSeen = 0;
  runner.d.emit = (runId, ev) => { origEmit(runId, ev); if (ev.type === 'approval_request') setTimeout(() => { pendingSeen = runner.active().find((r) => r.runId === runId).pending.length; runner.approve(runId, ev.callId, { action: 'allow', args: { command: 'echo edited-ok' } }); }, 5); };
  await runner.start({ text: 'list', mode: 'agent', root: ws, modelRef: { providerId: 'ctx', modelId: 'm1' } });
  await done;
  assert.equal(events.find((e) => e.type === 'error'), undefined, (events.find((e) => e.type === 'error') || {}).message);
  assert.ok(events.some((e) => e.type === 'approval_request' && e.reason === 'command'), 'strict mode asks even for allow-listed ls');
  assert.equal(pendingSeen, 1, 'a re-opened chat can see the waiting approval');
  const usage = events.find((e) => e.type === 'usage').usage;
  assert.equal(usage.input, 200, 'cached tokens are split out of prompt_tokens'); assert.equal(usage.cacheRead, 5000);
  const ctx = events.filter((e) => e.type === 'context');
  assert.equal(ctx.length, 2); assert.equal(ctx[0].prompt, 5200); assert.equal(ctx[1].used, 5410); assert.ok(ctx[1].real && ctx[1].ratio > 0);
});

console.log('\nmodel catalog · vendor icons');
await test('every preset family ships a catalog; Kimi has K2.6, K2.7 Code, K3', async () => {
  const { catalogForProvider } = require('../electron/agent/providers.js');
  const kimi = providerFromPreset('moonshot');
  const ids = kimi.models.map((m) => m.id);
  for (const id of ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro']) assert.ok(ids.includes(id), id);
  assert.ok(kimi.models.every((m) => m.vendor === 'moonshot'));
  assert.equal(kimi.models.find((m) => m.id === 'kimi-k3').reasoningStyle, 'kimi-effort');
  for (const pr of ['anthropic', 'openai', 'gemini', 'zai-anthropic', 'zai-openai', 'moonshot-anthropic', 'deepseek', 'qwen', 'xai', 'mistral', 'minimax', 'openrouter', 'ollama']) {
    assert.ok(providerFromPreset(pr).models.length > 0, pr);
  }
  const zai = providerFromPreset('zai-anthropic');
  assert.ok(zai.models.find((m) => m.id === 'glm-5.2' && m.enabled));
  assert.ok(zai.models.find((m) => m.id === 'glm-4.5-air' && !m.enabled), 'older models come disabled');
  assert.ok(catalogForProvider({ preset: 'custom-openai', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' }).length >= 6, 'guessed from base URL');
  const or = providerFromPreset('openrouter');
  assert.ok(or.models.every((m) => m.id.includes('/')), 'openrouter ids are vendor-prefixed');
});
await test('kimi-effort maps reasoning to low/high/max', async () => {
  const { buildRequest } = require('../electron/agent/openai.js');
  const p = providerFromPreset('moonshot');
  const model = p.models.find((m) => m.id === 'kimi-k3');
  const body = (r) => buildRequest({ provider: p, model, system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], reasoning: r, maxTokens: 10 }).body.reasoning_effort;
  assert.equal(body({ enabled: true, effort: 'medium' }), 'high');
  assert.equal(body({ enabled: true, effort: 'max' }), 'max');
  assert.equal(body({ enabled: false }), 'low');
});
await test('fetched models are enriched with catalog names and prices', async () => {
  const p = { ...providerFromPreset('moonshot'), baseUrl: mock.url + '/kimi' };
  const f = async (url) => ({ ok: true, json: async () => ({ data: [{ id: 'kimi-k2.6' }, { id: 'kimi-k9-future' }] }) });
  const list = await listModels({ provider: p, apiKey: 'k', fetchImpl: f });
  const k = list.find((m) => m.id === 'kimi-k2.6');
  assert.equal(k.name, 'Kimi K2.6'); assert.equal(k.price.input, 0.95); assert.equal(k.contextWindow, 262144);
  assert.equal(list.find((m) => m.id === 'kimi-k9-future').vendor, 'moonshot');
});
await test('vendor icons: real favicon from the vendor site, cached on disk', async () => {
  const { VendorIcons } = require('../electron/icons.js');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const seen = [];
  const f = async (url) => {
    seen.push(url);
    if (url === 'https://kimi.com/') return { ok: true, url, text: async () => '<html><head><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple.png"></head></html>' };
    if (url === 'https://kimi.com/apple.png') return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => png };
    return { ok: false };
  };
  const dir = path.join(tmp, 'icons');
  const vi = new VendorIcons({ dir, fetchImpl: f, vendors: { moonshot: { domain: 'kimi.com' } } });
  const d = await vi.get('moonshot');
  assert.ok(d.startsWith('data:image/png;base64,'), d);
  assert.ok(seen.includes('https://kimi.com/apple.png'), 'picked the touch icon');
  const n = seen.length;
  assert.equal(await vi.get('moonshot'), d); assert.equal(seen.length, n, 'served from cache');
  assert.equal(await vi.get('unknown'), null);
});

await mock.close();
tools.killAll();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
