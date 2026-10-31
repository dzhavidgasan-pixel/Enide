'use strict';
// The agent loop: send → stream (text, reasoning, tool calls) → approve → run tools → repeat.
// Plus: context compaction, hooks, subagents (task tool, run in parallel), model router.
const fsp = require('fs').promises;
const os = require('os');
const { adapterFor, normalizeModel } = require('./providers');
const tools = require('./tools');
const { buildSystemPrompt, memoryPaths, DEFAULT_PROMPTS } = require('./prompt');
const { newId } = require('./chats');
const { resolvePath } = require('../lib/fsutil');
const { hunks } = require('../lib/diff');
const { truncate } = require('./util');
const { loadHooks, runHooks } = require('./hooks');

const DEFAULT_POLICY = {
  write: 'auto',          // edits inside the workspace: auto (with checkpoints) | ask
  writeOutside: 'ask',    // edits outside the workspace
  readOutside: 'auto',
  command: 'ask',         // ask | auto
  allowList: ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'rg', 'grep', 'find', 'which', 'node -v', 'npm -v', 'python3 --version', 'npm test', 'npm run test', 'npm run lint', 'npm run build', 'pnpm test', 'yarn test', 'cargo check', 'cargo test', 'go test', 'pytest', 'swift build', 'tsc --noEmit', 'npx tsc --noEmit'],
  denyList: ['rm -rf /', 'rm -rf ~', 'sudo ', 'mkfs', ':(){', 'dd if=', 'git push --force', 'git push -f', 'shutdown', 'reboot', 'diskutil erase'],
  allowChained: false,
  network: 'auto',
  computer: 'ask',        // ask (screenshots are free) | ask-all | auto
  mcp: 'ask',
  plugins: 'ask',
};

const AUTO_POLICY = { write: 'auto', writeOutside: 'auto', command: 'auto', network: 'auto', computer: 'auto', mcp: 'auto', plugins: 'auto' };

function estimateTokens(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  // base64 images are billed by pixels, not characters — count them roughly
  return Math.ceil(s.replace(/"data":"[A-Za-z0-9+/=]{200,}"/g, '"data":"img"').length / 3.6) + (s.match(/"type":"image"/g) || []).length * 1500;
}

// The messages the model actually sees: compaction summary + everything after it.
function effectiveMessages(chat) {
  const msgs = chat.messages || [];
  const c = chat.compaction;
  if (!c || !c.summary) return msgs;
  const idx = c.untilId ? msgs.findIndex((m) => m.id === c.untilId) : msgs.length;
  const tail = idx >= 0 ? msgs.slice(idx) : msgs;
  return [{ id: 'summary', role: 'user', content: [{ type: 'text', text: `<conversation-summary>\nThe earlier part of this conversation was compressed. Summary:\n\n${c.summary}\n</conversation-summary>` }], meta: { summary: true } }, ...tail];
}

// Keep the conversation inside the model's context window. Never splits a tool call
// from its result: whole turns are dropped from the start, old tool output is trimmed first.
function fitContext(messages, budget, keepImages = 3) {
  let msgs = messages.map((m) => ({ ...m, content: (m.content || []).map((b) => ({ ...b })) }));
  let seen = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'tool') continue;
    for (const b of msgs[i].content) {
      if (b.type === 'tool_result' && b.images && b.images.length) {
        if (seen >= keepImages) { b.images = []; b.output = String(b.output || '') + ' [older screenshot removed]'; }
        seen++;
      }
    }
  }
  let size = estimateTokens(msgs);
  if (size <= budget) return { messages: msgs, trimmed: false };
  const keepTail = 8;
  for (let i = 0; i < msgs.length - keepTail && size > budget; i++) {
    const m = msgs[i];
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && String(b.output || '').length > 1200) {
        b.output = String(b.output).slice(0, 800) + '\n… [older tool output trimmed to save context]';
        b.images = [];
      }
    }
    size = estimateTokens(msgs);
  }
  while (size > budget) {
    const nextUser = msgs.findIndex((m, i) => i > 0 && m.role === 'user');
    if (nextUser <= 0 || nextUser >= msgs.length - 1) break;
    msgs = msgs.slice(nextUser);
    size = estimateTokens(msgs);
  }
  return { messages: msgs, trimmed: true };
}

// Plain-text transcript used as input for the compaction summary.
function renderTranscript(messages, maxChars = 400000) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(`USER:\n${(m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')}`);
    else if (m.role === 'assistant') {
      const parts = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) parts.push(b.text);
        else if (b.type === 'tool_call') parts.push(`[tool ${b.name} ${JSON.stringify(b.args || {}).slice(0, 600)}]`);
      }
      if (parts.length) out.push(`ASSISTANT:\n${parts.join('\n')}`);
    } else if (m.role === 'tool') {
      for (const b of m.content || []) if (b.type === 'tool_result') out.push(`TOOL RESULT (${b.name || ''}${b.isError ? ', error' : ''}):\n${truncate(String(b.output || ''), 1500)}`);
    }
  }
  let text = out.join('\n\n');
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}

function attachmentBlocks(attachments) {
  const blocks = [];
  for (const a of attachments || []) {
    if (a.type === 'image') blocks.push({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name });
    else if (a.type === 'file') blocks.push({ type: 'text', text: `<file path="${a.path}">\n${a.content}\n</file>`, attachment: { kind: 'file', path: a.path } });
    else if (a.type === 'folder') blocks.push({ type: 'text', text: `<folder path="${a.path}">\n${a.content}\n</folder>`, attachment: { kind: 'folder', path: a.path } });
    else if (a.type === 'selection') blocks.push({ type: 'text', text: `<selection path="${a.path}" lines="${a.startLine}-${a.endLine}">\n${a.text}\n</selection>`, attachment: { kind: 'selection', path: a.path, startLine: a.startLine, endLine: a.endLine } });
    else if (a.type === 'terminal') blocks.push({ type: 'text', text: `<terminal>\n${a.text}\n</terminal>`, attachment: { kind: 'terminal' } });
    else if (a.type === 'text') blocks.push({ type: 'text', text: a.text, attachment: { kind: a.kind || 'text', label: a.label, path: a.path } });
  }
  return blocks;
}

class AgentRunner {
  constructor(deps) {
    // { getSettings, getApiKey, chats, checkpoints, toolHost, fetchImpl, emit, trash, logRequest,
    //   onFileChanged, rememberApproval, recordUsage, services, userDir }
    this.d = deps;
    this.runs = new Map();
  }

  resolveModel(settings, ref) {
    const providers = settings.providers || [];
    const provider = providers.find((p) => p.id === (ref && ref.providerId)) || providers.find((p) => p.enabled !== false && (p.models || []).length);
    if (!provider) throw new Error('No provider configured. Open Settings → Providers and add one.');
    const m = (provider.models || []).find((x) => x.id === (ref && ref.modelId)) || (ref && ref.modelId && provider.id === (ref && ref.providerId) ? { id: ref.modelId } : (provider.models || [])[0]);
    if (!m) throw new Error(`Provider "${provider.name}" has no models. Add or fetch models in Settings.`);
    return { provider, model: normalizeModel(m, provider) };
  }

  // "Auto" model: pick from the router's fast / smart / vision slots.
  route(settings, params) {
    const r = settings.router || {};
    const text = String(params.text || '');
    const atts = params.attachments || [];
    const hasImages = atts.some((a) => a.type === 'image');
    const big = text.length > 600 || atts.some((a) => a.type !== 'image');
    let slot = 'smart';
    let why = 'default';
    if (hasImages && r.vision) { slot = 'vision'; why = 'images attached'; }
    else if (!big && r.fast && (params.mode === 'ask' || /^(what|why|how|explain|что|почему|как|объясни|где)\b/i.test(text.trim()) || text.length < 120)) { slot = 'fast'; why = 'short question'; }
    if (/\b(refactor|architecture|migrate|rewrite|debug|рефактор|архитектур|перепиши|отладь)/i.test(text) && r.smart) { slot = 'smart'; why = 'complex task'; }
    const ref = r[slot] || r.smart || settings.defaultModel;
    return { ref, slot, why };
  }

  isRunning(chatId) { return [...this.runs.values()].some((r) => r.chatId === chatId); }
  // Live runs, with any approval still waiting for an answer (so a re-opened chat can show it).
  active() { return [...this.runs.values()].map((r) => ({ runId: r.runId, chatId: r.chatId, pending: [...(r.pending || new Map()).values()] })); }

  async start(params) {
    const runId = newId('run');
    const ac = new AbortController();
    const run = { runId, chatId: params.chatId, ac, approvals: new Map(), pending: new Map(), stopped: false, todos: [], unattended: !!params.unattended };
    this.runs.set(runId, run);
    this._loop(run, params).catch((e) => {
      this.d.emit(runId, { type: 'error', message: e.message || String(e) });
      run.error = e.message;
    }).finally(() => {
      this.runs.delete(runId);
      this.d.emit(runId, { type: 'done', chatId: run.chatId, error: run.error || null });
      if (params.onDone) { try { params.onDone({ chatId: run.chatId, error: run.error || null, stopped: run.stopped }); } catch {} }
    });
    return runId;
  }

  stop(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.stopped = true;
    run.ac.abort();
    for (const [, res] of run.approvals) res({ action: 'stop' });
    run.approvals.clear();
    return true;
  }

  stopAll() { for (const id of [...this.runs.keys()]) this.stop(id); }

  approve(runId, callId, decision) {
    const run = this.runs.get(runId);
    const res = run && run.approvals.get(callId);
    if (!res) return false;
    run.approvals.delete(callId);
    res(decision || { action: 'allow' });
    return true;
  }

  async _loop(run, params) {
    const { d } = this;
    const emit = (ev) => d.emit(run.runId, ev);
    const settings = d.getSettings();
    const policy = { ...DEFAULT_POLICY, ...((settings.agent && settings.agent.policy) || {}), ...(params.policy || {}) };
    const maxSteps = (settings.agent && settings.agent.maxSteps) || 80;
    const mode = params.mode || 'agent';
    const root = params.root || null;
    const extraRoots = params.extraRoots || [];

    let chat = params.chatId ? await d.chats.get(params.chatId) : null;
    if (!chat) chat = await d.chats.create({ root });
    run.chatId = chat.id;
    if (!chat.root && root) chat.root = root;
    closeOrphans(chat.messages);

    let modelRef = params.modelRef;
    if (modelRef && modelRef.providerId === 'auto') {
      if (params.resume && chat.lastModel) modelRef = chat.lastModel;
      else {
        const r = this.route(settings, params);
        modelRef = r.ref;
        emit({ type: 'router', slot: r.slot, why: r.why, modelRef });
      }
    }
    const { provider, model } = this.resolveModel(settings, modelRef);
    const apiKey = await d.getApiKey(provider.id);
    const adapter = adapterFor(provider);
    const hooks = await loadHooks(settings, root).catch(() => []);
    const ctxBase = { chat, mode, root, extraRoots, settings, policy, maxSteps, provider, model, apiKey, adapter, params, emit, hooks };

    // ----- user message (or resume after an error / stop) -----
    if (params.resume) {
      const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) throw new Error('Nothing to resume.');
      emit({ type: 'run_start', chatId: chat.id, resumed: true, userMessage: lastUser, title: chat.title, provider: { id: provider.id, name: provider.name }, model: { id: model.id, name: model.name } });
      return this._steps(run, { ...ctxBase, userMsg: lastUser });
    }
    let text = params.text || '';
    if (hooks.length) {
      const hr = await runHooks(hooks, 'UserPromptSubmit', { payload: { prompt: text }, root, chatId: chat.id, signal: run.ac.signal, onRun: (e) => emit({ type: 'hook', ...e }) });
      if (hr.block) throw new Error(`Blocked by UserPromptSubmit hook: ${hr.reason}`);
      if (hr.context.length) text += `\n\n<hook-context>\n${hr.context.join('\n')}\n</hook-context>`;
    }
    const userMsg = {
      id: newId('msg'), role: 'user', created: Date.now(),
      content: [...attachmentBlocks(params.attachments), ...(text ? [{ type: 'text', text }] : [])],
      meta: { mode, providerId: provider.id, modelId: model.id, reasoning: params.reasoning || null },
    };
    if (!userMsg.content.length) throw new Error('Empty message.');
    chat.messages.push(userMsg);
    if (!chat.title) chat.title = (params.title || params.text || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60);
    chat.lastModel = { providerId: provider.id, modelId: model.id };
    await d.chats.save(chat);
    emit({ type: 'run_start', chatId: chat.id, userMessage: userMsg, title: chat.title, provider: { id: provider.id, name: provider.name }, model: { id: model.id, name: model.name } });
    return this._steps(run, { ...ctxBase, userMsg });
  }

  toolDefsFor(mode, settings, model, opts = {}) {
    const a = settings.agent || {};
    const docs = this.d.services && this.d.services.docsNames ? this.d.services.docsNames() : [];
    let defs = tools.definitions(mode, a.tools, {
      computerUse: !!a.computerUse && model.vision !== false,
      subagents: a.subagents !== false && !opts.noTask,
      docs, memory: !(settings.memory && settings.memory.enabled === false),
    });
    if (opts.noTask) defs = defs.filter((t) => t.name !== 'task');
    return defs;
  }

  async _steps(run, c) {
    const { d } = this;
    const { chat, userMsg, mode, root, settings, policy, maxSteps, provider, model, apiKey, adapter, params, emit, hooks } = c;
    const checkpoint = d.checkpoints ? await d.checkpoints.begin(chat.id, userMsg.id).init() : null;
    const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, requests: 0 };
    const sessionAllow = new Set(); // "allow for this run"
    let stopHookRounds = 0;
    const memFiles = memoryPaths(root, d.userDir);

    for (let step = 0; step < maxSteps; step++) {
      if (run.stopped) break;
      const sys = await buildSystemPrompt({ mode, settings, root, extraRoots: c.extraRoots, userDir: d.userDir });
      const builtin = this.toolDefsFor(mode, settings, model);
      const external = d.toolHost ? await d.toolHost.list(mode) : [];
      const toolDefs = model.tools === false ? [] : [...builtin, ...external];
      const budget = Math.max(4000, (model.contextWindow || 128000) - (model.maxOutput || 8192) - estimateTokens(sys.text) - estimateTokens(toolDefs) - 1000);

      // automatic compaction before the window overflows
      const a = settings.agent || {};
      // estimates are calibrated with the real token counts the provider reported last time
      const ratio = (chat.ctx && chat.ctx.ratio) || 1;
      if (a.autoCompact !== false && estimateTokens(effectiveMessages(chat)) * ratio > budget * (a.compactAt || 0.8)) {
        try { await this._compact(run, { chat, provider, model, apiKey, adapter, settings, budget, emit, keepTail: true }); }
        catch (e) { emit({ type: 'notice', level: 'warn', code: 'compact_failed', message: e.message }); }
      }
      const fitted = fitContext(effectiveMessages(chat), Math.floor(budget / Math.max(1, (chat.ctx && chat.ctx.ratio) || 1)));
      if (fitted.trimmed) emit({ type: 'notice', level: 'info', code: 'context_trimmed' });

      const s1 = await this._streamOnce(run, { provider, model, apiKey, adapter, system: sys.text, messages: fitted.messages, toolDefs, reasoning: params.reasoning, emit, chatId: chat.id, kind: 'agent' });
      totals.requests++;
      for (const k of ['input', 'output', 'reasoning', 'cacheRead']) totals[k] += s1.usage[k] || 0;
      // Real context size from the provider's own token count for this request.
      const promptReal = (s1.usage.input || 0) + (s1.usage.cacheRead || 0) + (s1.usage.cacheWrite || 0);
      if (promptReal > 0) {
        const est = estimateTokens(sys.text) + estimateTokens(toolDefs) + estimateTokens(fitted.messages);
        const ratio = est > 0 ? Math.max(0.4, Math.min(3, promptReal / est)) : 1;
        chat.ctx = { used: promptReal + (s1.usage.output || 0), prompt: promptReal, output: s1.usage.output || 0, window: model.contextWindow || 128000, ratio: +ratio.toFixed(3), model: model.id, at: Date.now(), real: true };
        emit({ type: 'context', ...chat.ctx });
      }
      if (s1.asst.content.length) chat.messages.push(s1.asst);
      if (s1.error) {
        closeOrphans(chat.messages);
        await d.chats.save(chat);
        if (run.stopped || s1.error.name === 'AbortError') { emit({ type: 'stopped' }); return; }
        throw s1.error;
      }
      await d.chats.save(chat);
      emit({ type: 'assistant_end', messageId: s1.asst.id, usage: s1.usage, ms: s1.asst.meta.ms, stopReason: s1.stopReason });

      if (run.stopped) { closeOrphans(chat.messages); await d.chats.save(chat); emit({ type: 'stopped' }); break; }
      if (!s1.calls.length) {
        if (s1.stopReason === 'max_tokens' || s1.stopReason === 'length') emit({ type: 'notice', level: 'warn', code: 'max_tokens' });
        // Stop hooks may send the agent back to work (exit code 2)
        if (hooks.length && stopHookRounds < 3) {
          const hr = await runHooks(hooks, 'Stop', { payload: { stop_hook_active: stopHookRounds > 0 }, root, chatId: chat.id, signal: run.ac.signal, onRun: (e) => emit({ type: 'hook', ...e }) });
          if (hr.block) {
            stopHookRounds++;
            chat.messages.push({ id: newId('msg'), role: 'user', created: Date.now(), content: [{ type: 'text', text: `<stop-hook-feedback>\n${hr.reason}\n</stop-hook-feedback>` }], meta: { hook: true } });
            await d.chats.save(chat);
            emit({ type: 'notice', level: 'info', code: 'stop_hook', message: hr.reason });
            continue;
          }
        }
        break;
      }

      // ----- tool execution: subagents run in parallel, everything else in order -----
      const toolMsg = { id: newId('msg'), role: 'tool', created: Date.now(), content: [] };
      const shared = { root, extraRoots: c.extraRoots, settings, policy, mode, model, provider, apiKey, adapter, checkpoint, sessionAllow, emit, hooks, chatId: chat.id, memFiles, params };
      const results = new Array(s1.calls.length);
      const parallel = [];
      for (let i = 0; i < s1.calls.length; i++) {
        const call = s1.calls[i];
        if (call.name === 'task') parallel.push(this._runTool(run, { ...shared, call }).then((r) => { results[i] = r; }));
      }
      for (let i = 0; i < s1.calls.length; i++) {
        const call = s1.calls[i];
        if (call.name === 'task') continue;
        if (run.stopped) { results[i] = { output: 'Cancelled: the user stopped the run.', isError: true }; continue; }
        results[i] = await this._runTool(run, { ...shared, call });
      }
      await Promise.all(parallel);
      s1.calls.forEach((call, i) => toolMsg.content.push({ type: 'tool_result', id: call.id, nativeId: call.nativeId, name: call.name, ...(results[i] || { output: 'Cancelled.', isError: true }) }));
      chat.messages.push(toolMsg);
      await d.chats.save(chat);
      if (run.stopped) { emit({ type: 'stopped' }); break; }
      if (step === maxSteps - 1) emit({ type: 'notice', level: 'warn', code: 'max_steps', maxSteps });
    }
    emit({ type: 'run_totals', totals, todos: run.todos });
  }

  // One model request with streaming. Emits UI events through `emit`; never throws —
  // returns { asst, calls, usage, stopReason, error }.
  async _streamOnce(run, { provider, model, apiKey, adapter, system, messages, toolDefs, reasoning, emit, chatId, kind }) {
    const { d } = this;
    const asst = { id: newId('msg'), role: 'assistant', created: Date.now(), content: [], meta: { providerId: provider.id, protocol: provider.protocol, modelId: model.id, usage: null } };
    emit({ type: 'assistant_start', messageId: asst.id });
    const usage = {};
    let stopReason = null;
    let reqLogId = null;
    const calls = [];
    let curReasoning = null;
    let curText = null;
    const t0 = Date.now();
    let error = null;
    try {
      const it = adapter.stream({
        provider, apiKey, model, system, messages,
        tools: (toolDefs || []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        reasoning: reasoning || { enabled: false },
        signal: run.ac.signal, fetchImpl: d.fetchImpl,
        onRequest: (r) => { reqLogId = d.logRequest ? d.logRequest({ ...r, chatId, runId: run.runId, provider: provider.name, model: model.id, kind }) : null; },
        onResponse: (r) => { if (d.logRequest && reqLogId) d.logRequest({ id: reqLogId, status: r.status, ttfbMs: r.ms }); },
      });
      for await (const ev of it) {
        if (run.stopped) break;
        switch (ev.type) {
          case 'reasoning_start':
            curReasoning = { type: 'reasoning', text: '', started: Date.now() };
            asst.content.push(curReasoning); curText = null;
            emit({ type: 'reasoning_start', messageId: asst.id });
            break;
          case 'reasoning':
            if (!curReasoning) { curReasoning = { type: 'reasoning', text: '', started: Date.now() }; asst.content.push(curReasoning); curText = null; emit({ type: 'reasoning_start', messageId: asst.id }); }
            curReasoning.text += ev.text;
            emit({ type: 'reasoning_delta', messageId: asst.id, text: ev.text });
            break;
          case 'reasoning_signature':
            if (curReasoning) curReasoning.signature = (curReasoning.signature || '') + ev.signature;
            else { curReasoning = { type: 'reasoning', text: '', signature: ev.signature, started: Date.now() }; asst.content.push(curReasoning); }
            break;
          case 'reasoning_redacted':
            asst.content.push({ type: 'reasoning', text: '', redacted: ev.data });
            emit({ type: 'reasoning_redacted', messageId: asst.id });
            break;
          case 'reasoning_end':
            if (curReasoning) { curReasoning.ms = Date.now() - curReasoning.started; emit({ type: 'reasoning_end', messageId: asst.id, ms: curReasoning.ms }); }
            curReasoning = null;
            break;
          case 'text':
            if (curReasoning) { curReasoning.ms = Date.now() - curReasoning.started; emit({ type: 'reasoning_end', messageId: asst.id, ms: curReasoning.ms }); curReasoning = null; }
            if (!curText) { curText = { type: 'text', text: '' }; asst.content.push(curText); }
            curText.text += ev.text;
            emit({ type: 'text_delta', messageId: asst.id, text: ev.text });
            break;
          case 'text_signature':
            if (curText) curText.signature = ev.signature;
            else asst.content.push({ type: 'text', text: '', signature: ev.signature });
            break;
          case 'tool_call_start':
            emit({ type: 'tool_preparing', messageId: asst.id, callId: ev.id, name: ev.name });
            break;
          case 'tool_call_delta':
            emit({ type: 'tool_args_delta', messageId: asst.id, callId: ev.id, name: ev.name, partial: ev.partial.length > 4000 ? ev.partial.slice(-4000) : ev.partial });
            break;
          case 'tool_call': {
            if (curReasoning) { curReasoning.ms = Date.now() - curReasoning.started; curReasoning = null; }
            const call = { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args, ...(ev.nativeId ? { nativeId: ev.nativeId } : {}), ...(ev.signature ? { signature: ev.signature } : {}) };
            asst.content.push(call); curText = null;
            calls.push(call);
            emit({ type: 'tool_call', messageId: asst.id, call });
            break;
          }
          case 'usage':
            for (const [k, v] of Object.entries(ev.usage || {})) usage[k] = Math.max(usage[k] || 0, v || 0);
            emit({ type: 'usage', messageId: asst.id, usage });
            break;
          case 'stop':
            stopReason = ev.reason;
            break;
          default: break;
        }
      }
    } catch (e) {
      error = e;
    }
    if (curReasoning && !curReasoning.ms) curReasoning.ms = Date.now() - curReasoning.started;
    asst.meta.usage = usage;
    asst.meta.ms = Date.now() - t0;
    asst.meta.stopReason = stopReason;
    if (d.logRequest && reqLogId) d.logRequest({ id: reqLogId, usage, ms: asst.meta.ms, stopReason, ...(error ? { error: error.message } : { response: summarize(asst) }) });
    if (d.recordUsage && (usage.input || usage.output)) d.recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind, usage, chatId });
    return { asst, calls, usage, stopReason, error };
  }

  // Summarize the older part of a chat; the summary replaces it in what the model sees.
  async _compact(run, { chat, provider, model, apiKey, adapter, settings, budget, emit, keepTail, instructions }) {
    const msgs = chat.messages;
    const startIdx = chat.compaction && chat.compaction.untilId ? Math.max(0, msgs.findIndex((m) => m.id === chat.compaction.untilId)) : 0;
    let cut = msgs.length;
    if (keepTail) {
      // keep the most recent turns (starting at a user message) within ~35% of the budget
      const userIdx = msgs.map((m, i) => (m.role === 'user' && !m.meta?.hook ? i : -1)).filter((i) => i > startIdx);
      cut = -1;
      for (let k = userIdx.length - 1; k >= 0; k--) {
        const tailSize = estimateTokens(msgs.slice(userIdx[k]));
        if (tailSize > budget * 0.35 && k < userIdx.length - 1) break;
        cut = userIdx[k];
      }
      if (cut <= startIdx) return false;
    }
    const older = msgs.slice(startIdx, cut);
    if (!older.length) return false;
    emit({ type: 'compacting' });
    const prompts = { ...DEFAULT_PROMPTS, ...((settings && settings.prompts) || {}) };
    const prev = chat.compaction && chat.compaction.summary ? `PREVIOUS SUMMARY:\n${chat.compaction.summary}\n\n` : '';
    const transcript = renderTranscript(older, Math.max(20000, Math.floor(budget * 2.5)));
    const sub = { ...run, ac: run.ac };
    const quiet = () => {};
    const r = await this._streamOnce(sub, {
      provider, model, apiKey, adapter, system: prompts.compactSystem,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${prev}CONVERSATION TO SUMMARIZE:\n${transcript}${instructions ? `\n\nFocus: ${instructions}` : ''}\n\nWrite the summary now.` }] }],
      toolDefs: [], reasoning: { enabled: false }, emit: quiet, chatId: chat.id, kind: 'compact',
    });
    if (r.error) throw r.error;
    const summary = r.asst.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!summary) throw new Error('Empty summary');
    const untilId = cut < msgs.length ? msgs[cut].id : null;
    chat.compaction = { summary, untilId, created: Date.now(), coveredMessages: cut, tokensBefore: estimateTokens(older) };
    if (chat.ctx) chat.ctx = { ...chat.ctx, real: false, used: null }; // keep the calibration, drop the stale size
    await this.d.chats.save(chat);
    emit({ type: 'compacted', summary, untilId, coveredMessages: cut });
    return true;
  }

  // Manual /compact from the UI.
  async compact(chatId, { modelRef, instructions } = {}) {
    const settings = this.d.getSettings();
    const chat = await this.d.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (this.isRunning(chatId)) throw new Error('Stop the agent first');
    const { provider, model } = this.resolveModel(settings, modelRef && modelRef.providerId !== 'auto' ? modelRef : chat.lastModel || settings.defaultModel);
    const apiKey = await this.d.getApiKey(provider.id);
    const run = { runId: newId('run'), ac: new AbortController(), approvals: new Map() };
    const budget = Math.max(4000, (model.contextWindow || 128000) - (model.maxOutput || 8192));
    const ok = await this._compact(run, { chat, provider, model, apiKey, adapter: adapterFor(provider), settings, budget, emit: () => {}, keepTail: false, instructions });
    return ok ? chat.compaction : null;
  }

  // Token estimate per part of the next request — the "what fills my context" view.
  async contextBreakdown(chatId, { mode = 'agent', modelRef, root, extraRoots } = {}) {
    const settings = this.d.getSettings();
    const chat = chatId ? await this.d.chats.get(chatId) : null;
    let ref = modelRef;
    if (!ref || ref.providerId === 'auto') ref = (chat && chat.lastModel) || settings.defaultModel;
    const { provider, model } = this.resolveModel(settings, ref);
    const sys = await buildSystemPrompt({ mode, settings, root, extraRoots, userDir: this.d.userDir });
    const builtin = this.toolDefsFor(mode, settings, model);
    const external = this.d.toolHost ? await this.d.toolHost.list(mode) : [];
    const rulesT = estimateTokens(sys.rules.map((r) => r.text).join('\n'));
    const memT = estimateTokens(sys.memory.map((m) => m.text).join('\n'));
    const parts = { system: Math.max(0, estimateTokens(sys.text) - rulesT - memT), rules: rulesT, memory: memT, tools: estimateTokens(builtin), mcpPlugins: estimateTokens(external), summary: 0, messages: 0, attachments: 0, toolResults: 0, images: 0 };
    for (const m of chat ? effectiveMessages(chat) : []) {
      if (m.meta && m.meta.summary) { parts.summary += estimateTokens(m.content); continue; }
      for (const b of m.content || []) {
        if (b.type === 'image') parts.images += 1500;
        else if (b.type === 'tool_result') { parts.toolResults += estimateTokens(String(b.output || '')); parts.images += (b.images || []).length * 1500; }
        else if (b.type === 'text' && b.attachment) parts.attachments += estimateTokens(b.text);
        else parts.messages += estimateTokens(b.type === 'tool_call' ? JSON.stringify(b.args || {}) : b.text || '');
      }
    }
    // scale the per-part estimate by the real/estimated ratio measured on the last request
    const ratio = (chat && chat.ctx && chat.ctx.ratio) || 1;
    if (ratio !== 1) for (const k of Object.keys(parts)) parts[k] = Math.round(parts[k] * ratio);
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    const real = chat && chat.ctx && chat.ctx.real && chat.ctx.model === model.id ? chat.ctx : null;
    return { window: model.contextWindow || 128000, maxOutput: model.maxOutput || 8192, total, parts, model: model.id, compacted: !!(chat && chat.compaction), calibrated: ratio !== 1, real };
  }

  async _runTool(run, s) {
    const { d } = this;
    const { call, root, settings, policy, mode, model, checkpoint, sessionAllow, emit, hooks, chatId, memFiles, params } = s;
    const name = call.name;
    const args = call.args || {};
    const fail = (output, extra = {}) => { const r = { output, isError: true, ...extra }; emit({ type: 'tool_result', callId: call.id, ...r }); return r; };
    if (args.__parseError) return fail(`Could not parse tool arguments as JSON. Raw: ${String(args.__raw).slice(0, 500)}`);
    const isBuiltin = !!tools.DEFS[name];
    const external = !isBuiltin && d.toolHost ? d.toolHost.find(name) : null;
    if (!isBuiltin && !external) return fail(`Unknown tool: ${name}`);
    if ((mode === 'ask' || mode === 'plan') && isBuiltin && !tools.READ_ONLY.has(name)) return fail(`Tool ${name} is not available in ${mode} mode.`);
    const ctx = {
      root: root || os.homedir(), hasWorkspace: !!root, extraRoots: s.extraRoots || [], signal: run.ac.signal, fetchImpl: d.fetchImpl,
      checkpoint: settings.agent && settings.agent.checkpoints === false ? null : checkpoint,
      trash: d.trash, vision: model.vision, services: d.services, memoryFiles: memFiles,
      emitOutput: (text) => emit({ type: 'tool_output', callId: call.id, text }),
      todos: (list) => { run.todos = list; emit({ type: 'todos', todos: list }); },
    };

    // PreToolUse hooks run before the permission check, like in Claude Code
    let hookAllow = false;
    if (hooks && hooks.length) {
      const hr = await runHooks(hooks, 'PreToolUse', { toolName: name, payload: { tool_name: name, tool_input: args }, root, chatId, signal: run.ac.signal, onRun: (e) => emit({ type: 'hook', callId: call.id, ...e }) });
      if (hr.block) return fail(`Blocked by PreToolUse hook: ${hr.reason}`, { blockedByHook: true });
      if (hr.permission === 'allow') hookAllow = true;
    }

    // approval
    let needs;
    if (name === 'task') needs = { needs: false };
    else if (isBuiltin) needs = tools.approvalFor(name, args, ctx, policy);
    else needs = { needs: !(external.autoApprove || (external.source === 'mcp' ? policy.mcp === 'auto' : external.source === 'browser' ? policy.network !== 'ask' : policy.plugins === 'auto')), reason: external.source };
    const allowKey = name === 'run_command' ? `run_command:${String(args.command || '').trim().split(/\s+/).slice(0, 2).join(' ')}` : name;
    if (hookAllow && needs.reason !== 'deny') needs = { needs: false };
    if (needs.needs && needs.reason !== 'deny' && sessionAllow.has(allowKey)) needs = { needs: false };
    if (needs.needs) {
      if (run.unattended) return fail(`Not allowed in an unattended run (needs approval: ${needs.reason}). Use only actions that do not need confirmation.`, { rejected: true });
      const preview = isBuiltin ? await previewFor(name, args, ctx) : null;
      const req = { type: 'approval_request', callId: call.id, name, args, reason: needs.reason, preview, allowKey };
      if (run.pending && !s.parentCallId) run.pending.set(call.id, req);
      emit(req);
      const decision = await new Promise((res) => run.approvals.set(call.id, res));
      if (run.pending) run.pending.delete(call.id);
      if (decision.action === 'stop') { run.stopped = true; run.ac.abort(); return fail('Cancelled: the user stopped the run.'); }
      if (decision.action === 'reject') return fail(`The user rejected this tool call.${decision.message ? ' Their note: ' + decision.message : ''}`, { rejected: true });
      if (decision.args && typeof decision.args === 'object' && (decision.action === 'allow' || decision.action === 'always')) {
        Object.assign(args, decision.args); // the user edited the command/arguments before allowing
        emit({ type: 'tool_args', callId: call.id, args });
      }
      if (decision.action === 'always') {
        sessionAllow.add(allowKey);
        if (d.rememberApproval) d.rememberApproval({ name, args, allowKey });
      }
    }

    emit({ type: 'tool_running', callId: call.id, name });
    const t0 = Date.now();
    try {
      let r;
      if (name === 'task') r = await this._subagent(run, { ...s, args });
      else if (isBuiltin) r = await tools.EXEC[name](args, ctx);
      else r = await d.toolHost.call(name, args, ctx);
      r = r || { output: '' };
      if (r.changedFile && d.onFileChanged) d.onFileChanged(r.changedFile);
      let output = r.output == null ? '' : String(r.output);
      if (hooks && hooks.length && !r.isError) {
        const hr = await runHooks(hooks, 'PostToolUse', { toolName: name, payload: { tool_name: name, tool_input: args, tool_response: { output: output.slice(0, 20000) } }, root, chatId, signal: run.ac.signal, onRun: (e) => emit({ type: 'hook', callId: call.id, ...e }) });
        if (hr.feedback.length) output += `\n\n<hook-feedback>\n${hr.feedback.join('\n')}\n</hook-feedback>`;
        if (hr.context.length) output += `\n\n<hook-context>\n${hr.context.join('\n')}\n</hook-context>`;
      }
      const out = { output: truncate(output, 100000), isError: !!r.isError, ...(r.images && r.images.length ? { images: r.images } : {}), ...(r.display ? { display: r.display } : {}), ms: Date.now() - t0 };
      const img = r.images && r.images[0] && r.images[0].data.length < 900000 ? r.images[0] : null;
      emit({ type: 'tool_result', callId: call.id, output: out.output.slice(0, 20000), isError: out.isError, display: out.display, ms: out.ms, hasImages: !!(r.images && r.images.length), ...(img ? { preview: { mediaType: img.mediaType, data: img.data } } : {}) });
      return out;
    } catch (e) {
      const aborted = run.ac.signal.aborted;
      const out = { output: aborted ? 'Cancelled: the user stopped the run.' : `Error: ${e.message}`, isError: true, ms: Date.now() - t0 };
      emit({ type: 'tool_result', callId: call.id, ...out });
      return out;
    }
  }

  // A subagent: fresh context, its own loop, events tagged with the parent call id.
  async _subagent(run, s) {
    const { d } = this;
    const { args, call, settings, mode, model, provider, apiKey, adapter, root, emit } = s;
    const type = mode === 'ask' || mode === 'plan' ? 'explore' : (args.type === 'general' ? 'general' : 'explore');
    const subMode = type === 'explore' ? 'ask' : 'agent';
    const subEmit = (ev) => emit({ ...ev, parent: call.id });
    const sys = await buildSystemPrompt({
      mode: 'subagent', settings, root, extraRoots: s.extraRoots, userDir: d.userDir,
      vars: { subagentType: type, subagentHint: type === 'explore' ? 'read-only: search and read, no edits or commands' : 'may edit files and run commands' },
    });
    const toolDefs = model.tools === false ? [] : [...this.toolDefsFor(subMode, settings, model, { noTask: true }), ...(d.toolHost ? await d.toolHost.list(subMode) : [])];
    const messages = [{ role: 'user', content: [{ type: 'text', text: String(args.prompt || args.description || '') }] }];
    const maxSteps = (settings.agent && settings.agent.subagentMaxSteps) || 30;
    let finalText = '';
    let toolCount = 0;
    const usage = { input: 0, output: 0 };
    for (let step = 0; step < maxSteps; step++) {
      if (run.stopped) break;
      const budget = Math.max(4000, (model.contextWindow || 128000) - (model.maxOutput || 8192) - estimateTokens(sys.text) - estimateTokens(toolDefs) - 1000);
      const fitted = fitContext(messages, budget);
      const r = await this._streamOnce(run, { provider, model, apiKey, adapter, system: sys.text, messages: fitted.messages, toolDefs, reasoning: s.params && s.params.reasoning, emit: subEmit, chatId: s.chatId, kind: 'subagent' });
      usage.input += r.usage.input || 0; usage.output += r.usage.output || 0;
      if (r.asst.content.length) messages.push(r.asst);
      if (r.error) throw r.error;
      const text = r.asst.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) finalText = text;
      if (!r.calls.length) break;
      const toolMsg = { role: 'tool', content: [] };
      for (const c of r.calls) {
        toolCount++;
        const res = await this._runTool(run, { ...s, call: c, mode: subMode, emit: subEmit, parentCallId: call.id });
        toolMsg.content.push({ type: 'tool_result', id: c.id, nativeId: c.nativeId, name: c.name, ...res });
      }
      messages.push(toolMsg);
    }
    return { output: finalText || '(the subagent finished without a written report)', display: { kind: 'subagent', type, description: args.description, toolCount, usage } };
  }
}

// Any tool call without a result (run stopped / crashed mid-way) gets a synthetic
// "cancelled" result so the next request is valid for every provider.
function closeOrphans(messages) {
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const calls = (m.content || []).filter((b) => b.type === 'tool_call');
    if (!calls.length) continue;
    const next = messages[i + 1];
    const have = new Set(next && next.role === 'tool' ? next.content.map((b) => b.id) : []);
    const missing = calls.filter((c) => !have.has(c.id));
    if (!missing.length) continue;
    const results = missing.map((c) => ({ type: 'tool_result', id: c.id, nativeId: c.nativeId, name: c.name, output: 'Cancelled: the run was stopped before this tool ran.', isError: true }));
    if (next && next.role === 'tool') next.content.push(...results);
    else messages.splice(i + 1, 0, { id: newId('msg'), role: 'tool', created: Date.now(), content: results });
    changed = true;
  }
  return changed;
}

function summarize(asst) {
  const text = asst.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const reasoning = asst.content.filter((b) => b.type === 'reasoning').map((b) => b.text || '').join('');
  const toolCalls = asst.content.filter((b) => b.type === 'tool_call').map((b) => ({ name: b.name, args: b.args }));
  return { text: text.slice(0, 20000), reasoning: reasoning.slice(0, 20000), toolCalls };
}

async function previewFor(name, args, ctx) {
  try {
    if (name === 'edit_file' || name === 'write_file') {
      const file = resolvePath(ctx.root, args.path);
      let before = '';
      try { before = await fsp.readFile(file, 'utf8'); } catch {}
      let after;
      if (name === 'write_file') after = String(args.content || '');
      else if (!args.old_string) after = String(args.new_string || '');
      else after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
      const h = hunks(before, after);
      return { kind: 'diff', path: file, added: h.added, removed: h.removed, hunks: h.hunks, truncated: h.truncated };
    }
    if (name === 'run_command') return { kind: 'command', command: args.command, cwd: resolvePath(ctx.root, args.cwd || '.') };
    if (name === 'delete_file') return { kind: 'delete', path: resolvePath(ctx.root, args.path) };
  } catch {}
  return null;
}

module.exports = { AgentRunner, DEFAULT_POLICY, AUTO_POLICY, fitContext, estimateTokens, attachmentBlocks, closeOrphans, effectiveMessages, renderTranscript };
