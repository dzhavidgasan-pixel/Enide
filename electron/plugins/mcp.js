'use strict';
// Model Context Protocol client (stdio + streamable HTTP) and server manager.
const { spawn } = require('child_process');
const crypto = require('crypto');
const { readSSE } = require('../agent/sse');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'Enide', version: '0.1.0' };

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'server'; }

class McpClient {
  constructor(cfg, { root, onChange, log } = {}) {
    this.cfg = cfg;
    this.root = root;
    this.onChange = onChange || (() => {});
    this.logFn = log || (() => {});
    this.status = 'stopped';
    this.error = null;
    this.tools = [];
    this.serverInfo = null;
    this.stderr = [];
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
  }

  log(line) {
    this.stderr.push(String(line).slice(0, 2000));
    if (this.stderr.length > 300) this.stderr.splice(0, this.stderr.length - 300);
  }

  async start() {
    this.status = 'starting'; this.error = null; this.onChange();
    try {
      if ((this.cfg.type || 'stdio') === 'stdio') await this._spawn();
      const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: CLIENT_INFO }, 60000);
      this.serverInfo = init && init.serverInfo;
      this.instructions = init && init.instructions;
      await this.notify('notifications/initialized', {});
      await this.refreshTools();
      this.status = 'ready';
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.log(`[enide] ${e.message}`);
      this.stop();
      this.status = 'error';
    }
    this.onChange();
  }

  async refreshTools() {
    const all = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, 30000);
      all.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
      if (!cursor) break;
    }
    this.tools = all;
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {}, cwd } = this.cfg;
      if (!command) return reject(new Error('No command configured'));
      let child;
      try {
        child = spawn(command, args, { cwd: cwd || this.root || process.env.HOME, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { return reject(e); }
      this.child = child;
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { this.log(line); continue; }
          this._onMessage(msg);
        }
      });
      child.stderr.on('data', (d) => { for (const l of d.toString().split('\n')) if (l.trim()) this.log(l); });
      child.on('error', (e) => { this.log(`[spawn] ${e.message}`); this._failAll(e); if (this.status === 'starting') reject(new Error(`Could not start "${command}": ${e.message}`)); });
      child.on('exit', (code, sig) => {
        this.log(`[exit] code=${code} signal=${sig || ''}`);
        this._failAll(new Error(`MCP server exited (code ${code})`));
        if (this.status === 'ready') { this.status = 'error'; this.error = `Exited with code ${code}`; this.onChange(); }
      });
      // resolve on next tick; failures surface via initialize timeout or error
      setImmediate(resolve);
    });
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _onMessage(msg) {
    if (Array.isArray(msg)) { msg.forEach((m) => this._onMessage(m)); return; }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      // server → client request
      let result = null;
      let error = null;
      if (msg.method === 'ping') result = {};
      else if (msg.method === 'roots/list') result = { roots: this.root ? [{ uri: 'file://' + this.root, name: require('path').basename(this.root) }] : [] };
      else error = { code: -32601, message: `Method not supported by Enide: ${msg.method}` };
      this._send(error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result }).catch(() => {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') {
      this.refreshTools().then(() => this.onChange()).catch(() => {});
    } else if (msg.method === 'notifications/message' && msg.params) {
      this.log(`[${msg.params.level || 'log'}] ${typeof msg.params.data === 'string' ? msg.params.data : JSON.stringify(msg.params.data)}`);
    }
  }

  async _send(obj) {
    if ((this.cfg.type || 'stdio') === 'stdio') {
      if (!this.child || !this.child.stdin.writable) throw new Error('MCP server is not running');
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return null;
    }
    return this._post(obj);
  }

  async _post(obj) {
    const f = this.cfg.fetchImpl || globalThis.fetch;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, ...(this.cfg.headers || {}) };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await f(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(obj) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      for await (const ev of readSSE(res.body)) {
        if (!ev.data) continue;
        try { this._onMessage(JSON.parse(ev.data)); } catch {}
      }
    } else {
      const text = await res.text();
      if (text.trim()) { try { this._onMessage(JSON.parse(text)); } catch {} }
    }
    return null;
  }

  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        if (this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(e); }
      });
    });
  }

  notify(method, params) { return this._send({ jsonrpc: '2.0', method, params }).catch(() => {}); }

  async callTool(name, args, signal) {
    const p = this.request('tools/call', { name, arguments: args || {} }, (this.cfg.timeoutSec || 600) * 1000);
    if (signal) {
      const abort = new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('Cancelled')), { once: true }));
      return Promise.race([p, abort]);
    }
    return p;
  }

  stop() {
    this._failAll(new Error('MCP server stopped'));
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      const c = this.child;
      setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, 300);
      this.child = null;
    }
    this.status = 'stopped';
  }
}

class McpManager {
  constructor({ onChange, root } = {}) {
    this.onChange = onChange || (() => {});
    this.root = root;
    this.clients = new Map();
    this.nameMap = new Map();
  }

  setRoot(root) { this.root = root; for (const c of this.clients.values()) c.root = root; }

  async configure(servers) {
    const wanted = new Map((servers || []).filter((s) => s.enabled !== false).map((s) => [s.id, s]));
    for (const [id, c] of this.clients) {
      const w = wanted.get(id);
      if (!w || JSON.stringify(stripRuntime(w)) !== JSON.stringify(stripRuntime(c.cfg))) { c.stop(); this.clients.delete(id); }
    }
    const starts = [];
    for (const [id, cfg] of wanted) {
      if (this.clients.has(id)) { this.clients.get(id).cfg = cfg; continue; }
      const c = new McpClient(cfg, { root: this.root, onChange: () => this.onChange() });
      this.clients.set(id, c);
      starts.push(c.start());
    }
    await Promise.all(starts);
    this._rebuildNames();
    this.onChange();
  }

  async restart(id) {
    const c = this.clients.get(id);
    if (!c) return;
    c.stop();
    await c.start();
    this._rebuildNames();
  }

  _rebuildNames() {
    this.nameMap.clear();
    for (const [id, c] of this.clients) {
      if (c.status !== 'ready') continue;
      const s = slug(c.cfg.name || id).slice(0, 20);
      for (const t of c.tools) {
        let name = `mcp__${s}__${String(t.name).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (name.length > 64) name = name.slice(0, 55) + '_' + crypto.createHash('md5').update(name).digest('hex').slice(0, 8);
        this.nameMap.set(name, { serverId: id, tool: t });
      }
    }
  }

  async list(mode) {
    this._rebuildNames();
    const out = [];
    for (const [name, { serverId, tool }] of this.nameMap) {
      const c = this.clients.get(serverId);
      const disabled = new Set(c.cfg.disabledTools || []);
      if (disabled.has(tool.name)) continue;
      const readOnly = !!(tool.annotations && tool.annotations.readOnlyHint);
      if ((mode === 'ask' || mode === 'plan') && !readOnly) continue;
      out.push({
        name,
        description: `[MCP · ${c.cfg.name || serverId}] ${tool.description || tool.title || tool.name}`.slice(0, 4000),
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        source: 'mcp', server: c.cfg.name || serverId, serverId, readOnly,
        autoApprove: !!c.cfg.autoApprove || (c.cfg.autoApproveTools || []).includes(tool.name),
      });
    }
    return out;
  }

  find(name) {
    const e = this.nameMap.get(name);
    if (!e) return null;
    const c = this.clients.get(e.serverId);
    return { source: 'mcp', serverId: e.serverId, autoApprove: !!(c && (c.cfg.autoApprove || (c.cfg.autoApproveTools || []).includes(e.tool.name))) };
  }

  async call(name, args, ctx) {
    const e = this.nameMap.get(name);
    if (!e) throw new Error(`Unknown MCP tool ${name}`);
    const c = this.clients.get(e.serverId);
    if (!c || c.status !== 'ready') throw new Error(`MCP server ${e.serverId} is not running`);
    const r = await c.callTool(e.tool.name, args, ctx && ctx.signal);
    const texts = [];
    const images = [];
    for (const part of (r && r.content) || []) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'image') images.push({ mediaType: part.mimeType, data: part.data });
      else if (part.type === 'resource' && part.resource) texts.push(part.resource.text || `[resource ${part.resource.uri}]`);
      else if (part.type === 'resource_link') texts.push(`[resource ${part.uri}] ${part.name || ''}`);
      else texts.push(JSON.stringify(part));
    }
    if (r && r.structuredContent && !texts.length) texts.push(JSON.stringify(r.structuredContent, null, 2));
    return { output: texts.join('\n') || '(no output)', isError: !!(r && r.isError), images };
  }

  status() {
    return [...this.clients.entries()].map(([id, c]) => ({
      id, name: c.cfg.name || id, status: c.status, error: c.error,
      tools: c.tools.map((t) => ({ name: t.name, description: t.description, readOnly: !!(t.annotations && t.annotations.readOnlyHint) })),
      serverInfo: c.serverInfo, log: c.stderr.slice(-80),
    }));
  }

  async shutdown() { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }
}

function stripRuntime(cfg) {
  const { disabledTools, autoApprove, autoApproveTools, enabled, ...rest } = cfg || {};
  return rest;
}

// One-click catalog. "Install" just adds the config; servers run through npx/uvx on first start.
const CATALOG = [
  { key: 'filesystem', name: 'Filesystem', description: 'Read/write files in folders you allow', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{{workspace}}'] },
  { key: 'memory', name: 'Memory', description: 'Knowledge-graph memory across chats', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { key: 'sequential-thinking', name: 'Sequential Thinking', description: 'Structured step-by-step reasoning tool', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { key: 'playwright', name: 'Playwright', description: 'Drive a real browser: open pages, click, screenshot', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { key: 'context7', name: 'Context7', description: 'Up-to-date library documentation', type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  { key: 'fetch', name: 'Fetch', description: 'Fetch web pages as markdown (needs uv)', type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
  { key: 'git', name: 'Git', description: 'Git repository tools (needs uv)', type: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '{{workspace}}'] },
  { key: 'github', name: 'GitHub', description: 'Issues, PRs, code search (remote, needs a token)', type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer YOUR_GITHUB_TOKEN' } },
];

module.exports = { McpClient, McpManager, CATALOG, slug };
