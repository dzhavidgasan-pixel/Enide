'use strict';
// Enide plugins: folders with enide-plugin.json + a CommonJS entry exporting activate(api).
// Plugins can add agent tools, command-palette commands and slash commands.
// They run with your user permissions — only install code you trust.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const MANIFEST = 'enide-plugin.json';

function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

class PluginManager {
  constructor({ dir, getSettings, onChange, getRoot }) {
    this.dir = dir;
    this.getSettings = getSettings || (() => ({}));
    this.onChange = onChange || (() => {});
    this.getRoot = getRoot || (() => null);
    this.plugins = new Map();
    this.tools = new Map();
    this.commands = new Map();
    this.slash = new Map();
  }

  disabledSet() { return new Set(((this.getSettings().plugins || {}).disabled) || []); }

  async load() {
    for (const p of this.plugins.values()) { try { if (p.module && p.module.deactivate) await p.module.deactivate(); } catch {} }
    this.plugins.clear(); this.tools.clear(); this.commands.clear(); this.slash.clear();
    await fsp.mkdir(this.dir, { recursive: true });
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const disabled = this.disabledSet();
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const folder = path.join(this.dir, e.name);
      let manifest;
      try { manifest = JSON.parse(await fsp.readFile(path.join(folder, MANIFEST), 'utf8')); } catch { continue; }
      const id = sanitize(manifest.id || e.name);
      const rec = { id, folder, manifest, enabled: !disabled.has(id), error: null, logs: [], module: null };
      this.plugins.set(id, rec);
      if (!rec.enabled) continue;
      try {
        const entry = path.join(folder, manifest.main || 'index.js');
        delete require.cache[require.resolve(entry)];
        rec.module = require(entry);
        if (typeof rec.module.activate === 'function') await rec.module.activate(this._api(rec));
      } catch (err) {
        rec.error = err.message;
      }
    }
    this.onChange();
  }

  _api(rec) {
    const self = this;
    return {
      id: rec.id,
      log: (...a) => { rec.logs.push(a.map(String).join(' ')); if (rec.logs.length > 200) rec.logs.shift(); },
      workspace: () => self.getRoot(),
      registerTool(def) {
        if (!def || !def.name || typeof def.run !== 'function') throw new Error('registerTool needs { name, description, parameters, run }');
        let name = `plugin__${sanitize(rec.id)}__${sanitize(def.name)}`.slice(0, 64);
        self.tools.set(name, { pluginId: rec.id, def });
      },
      registerCommand(def) {
        if (!def || !def.id || typeof def.run !== 'function') throw new Error('registerCommand needs { id, title, run }');
        self.commands.set(`${rec.id}.${def.id}`, { pluginId: rec.id, def });
      },
      registerSlashCommand(def) {
        if (!def || !def.name || !def.prompt) throw new Error('registerSlashCommand needs { name, description, prompt }');
        self.slash.set(def.name, { pluginId: rec.id, def });
      },
    };
  }

  list(mode) {
    const out = [];
    for (const [name, { pluginId, def }] of this.tools) {
      if ((mode === 'ask' || mode === 'plan') && !def.readOnly) continue;
      out.push({
        name, description: `[Plugin · ${pluginId}] ${def.description || def.name}`,
        parameters: def.parameters || { type: 'object', properties: {} },
        source: 'plugin', pluginId, readOnly: !!def.readOnly, autoApprove: !!def.autoApprove,
      });
    }
    return out;
  }

  find(name) {
    const t = this.tools.get(name);
    return t ? { source: 'plugin', pluginId: t.pluginId, autoApprove: !!t.def.autoApprove } : null;
  }

  async call(name, args, ctx) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Unknown plugin tool ${name}`);
    const r = await t.def.run(args || {}, { root: ctx && ctx.root, signal: ctx && ctx.signal });
    if (r == null) return { output: '' };
    if (typeof r === 'string') return { output: r };
    return { output: String(r.output == null ? '' : r.output), isError: !!r.isError, images: r.images };
  }

  listCommands() {
    return [...this.commands.entries()].map(([id, { pluginId, def }]) => ({ id, title: def.title || def.id, pluginId }));
  }

  async runCommand(id) {
    const c = this.commands.get(id);
    if (!c) throw new Error(`Unknown command ${id}`);
    const r = await c.def.run({ root: this.getRoot() });
    return r == null ? null : typeof r === 'string' ? { message: r } : r;
  }

  listSlash() {
    return [...this.slash.entries()].map(([name, { pluginId, def }]) => ({ name, description: def.description || '', prompt: def.prompt, source: `plugin:${pluginId}` }));
  }

  status() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id, name: p.manifest.name || p.id, version: p.manifest.version || '', description: p.manifest.description || '',
      folder: p.folder, enabled: p.enabled, error: p.error, logs: p.logs.slice(-40),
      tools: [...this.tools.entries()].filter(([, t]) => t.pluginId === p.id).map(([n, t]) => ({ name: n, description: t.def.description })),
      commands: this.listCommands().filter((c) => c.pluginId === p.id),
    }));
  }

  async install(source) {
    await fsp.mkdir(this.dir, { recursive: true });
    const src = String(source || '').trim();
    if (!src) throw new Error('Nothing to install');
    let target;
    if (/^(https?:\/\/|git@)/.test(src) || src.endsWith('.git')) {
      const name = sanitize(path.basename(src).replace(/\.git$/, ''));
      target = path.join(this.dir, name);
      if (fs.existsSync(target)) throw new Error(`A plugin folder named ${name} already exists`);
      await new Promise((res, rej) => execFile('git', ['clone', '--depth', '1', src, target], { env: process.env }, (err, _o, se) => (err ? rej(new Error(se || err.message)) : res())));
    } else {
      const from = path.resolve(src.replace(/^~(?=\/)/, process.env.HOME || ''));
      const manifest = JSON.parse(await fsp.readFile(path.join(from, MANIFEST), 'utf8'));
      target = path.join(this.dir, sanitize(manifest.id || path.basename(from)));
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(from, target, { recursive: true, filter: (p) => !/node_modules|\.git(\/|$)/.test(path.relative(from, p)) });
    }
    try { JSON.parse(await fsp.readFile(path.join(target, MANIFEST), 'utf8')); }
    catch { await fsp.rm(target, { recursive: true, force: true }); throw new Error(`No valid ${MANIFEST} found — not an Enide plugin.`); }
    await this.load();
    return target;
  }

  async remove(id) {
    const p = this.plugins.get(id);
    if (!p) return;
    await fsp.rm(p.folder, { recursive: true, force: true });
    await this.load();
  }

  async scaffold(name) {
    const id = sanitize(name || 'my-plugin').toLowerCase();
    const folder = path.join(this.dir, id);
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, MANIFEST), JSON.stringify({ id, name: name || 'My plugin', version: '0.1.0', description: 'Example Enide plugin', main: 'index.js' }, null, 2));
    await fsp.writeFile(path.join(folder, 'index.js'), PLUGIN_TEMPLATE);
    await this.load();
    return folder;
  }
}

const PLUGIN_TEMPLATE = `// Enide plugin. Runs in the app's main process with full Node.js access.
// Docs: README.md → "Plugins".

exports.activate = (api) => {
  // A tool the agent can call. Its description is sent to the model as-is.
  api.registerTool({
    name: 'word_count',
    description: 'Count words in a piece of text.',
    readOnly: true,          // allowed in Ask/Plan mode
    autoApprove: true,       // no confirmation needed
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => String((text.match(/\\S+/g) || []).length),
  });

  // A command in the command palette (⌘⇧P).
  api.registerCommand({
    id: 'hello',
    title: 'Say hello from my plugin',
    run: async ({ root }) => 'Hello! Workspace: ' + (root || 'none'),
  });

  // A slash command: typing /explain-simply in chat inserts this prompt.
  api.registerSlashCommand({
    name: 'explain-simply',
    description: 'Explain the selected code like I am new to it',
    prompt: 'Explain this code simply, step by step, with a small example: $ARGUMENTS',
  });
};

exports.deactivate = () => {};
`;

module.exports = { PluginManager, MANIFEST };
