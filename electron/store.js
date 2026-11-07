'use strict';
// Settings (JSON in userData) and API keys (encrypted with macOS Keychain via safeStorage).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DEFAULT_POLICY } = require('./agent/agent');

function defaults() {
  return {
    version: 1,
    language: 'auto',
    theme: 'dark',
    starfield: false,
    providers: [], // models the user adds: ID + endpoint + key
    iconOverrides: {}, // vendor -> data URL picked by the user
    defaultModel: null,
    reasoning: { enabled: true, effort: 'medium' },
    autocomplete: { enabled: false, nextEdit: true, model: null, debounceMs: 350, maxPrefix: 4000, maxSuffix: 1500, maxTokens: 256 },
    inlineEdit: { model: null },
    commitModel: null,
    agent: { maxSteps: 80, checkpoints: true, autoOpenEdits: true, policy: { ...DEFAULT_POLICY, write: 'ask', computer: 'ask-all' }, tools: {}, subagents: true, subagentMaxSteps: 30, autoCompact: true, compactAt: 0.8, browser: true, browserVisible: true, lintAfterEdit: true },
    prompts: {},
    rules: { global: '', useProjectFiles: true, disabledFiles: [] },
    editor: { theme: null, semanticDiagnostics: false, fontSize: 13, fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace', tabSize: 2, wordWrap: 'off', minimap: false, autoSave: 'off', lineHeight: 20, renderWhitespace: 'selection', stickyScroll: true },
    terminal: { fontSize: 12, shell: '' },
    mcpServers: [],
    plugins: { disabled: [] },
    network: { proxy: '' },
    voice: { providerId: null, model: '', language: '' },
    router: { fast: null, smart: null, vision: null },
    index: { enabled: false, providerId: null, model: '', autoIndex: true },
    memory: { enabled: true },
    hooks: { enabled: true, importClaude: true, config: { hooks: {} } },
    automations: [],
    extraRoots: {},
    keybindings: {},
    updates: { repo: 'dzhavidgasan-pixel/Enide', auto: true },
    reviewModel: null,
    recent: [],
    layout: { sidebar: true, panel: false, agent: true, sidebarWidth: 260, agentWidth: 440, panelHeight: 260 },
    lastWorkspace: null,
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, patch) {
  if (!isObj(patch)) return patch === undefined ? base : patch;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = merge(defaults(), saved);
      // arrays replace wholesale; keep provider list as saved
      if (Array.isArray(saved.providers)) this.data.providers = saved.providers;
    } catch {}
    this.timer = null;
  }
  get() { return this.data; }
  set(patch, { replaceArrays = true } = {}) {
    this.data = merge(this.data, patch);
    this.scheduleSave();
    return this.data;
  }
  replace(key, value) { this.data[key] = value; this.scheduleSave(); return this.data; }
  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('settings save failed', e); }
  }
}

class SecretStore {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'secrets.json');
    this.safe = safeStorage;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  encryptionAvailable() { try { return !!(this.safe && this.safe.isEncryptionAvailable()); } catch { return false; } }
  async set(id, value) {
    if (!value) { delete this.data[id]; }
    else if (this.encryptionAvailable()) this.data[id] = { enc: this.safe.encryptString(value).toString('base64') };
    else this.data[id] = { plain: value };
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
  get(id) {
    const e = this.data[id];
    if (!e) return '';
    try {
      if (e.enc) return this.safe.decryptString(Buffer.from(e.enc, 'base64'));
      return e.plain || '';
    } catch { return ''; }
  }
  has(id) { return !!this.data[id]; }
  hint(id) {
    const v = this.get(id);
    if (!v) return '';
    return v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••';
  }
}

module.exports = { SettingsStore, SecretStore, defaults, merge };
