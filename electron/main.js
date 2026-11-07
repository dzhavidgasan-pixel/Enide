'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net, session, safeStorage, nativeTheme, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { SettingsStore, SecretStore } = require('./store');
const { PRESETS, listModels, testConnection, normalizeModel, providerFromPreset, customModel, VENDORS } = require('./agent/providers');
const { VendorIcons } = require('./icons');
const { AuthStore } = require('./auth');
let auth = null;
const { AgentRunner, DEFAULT_POLICY, AUTO_POLICY } = require('./agent/agent');
const { ChatStore } = require('./agent/chats');
const { CheckpointStore } = require('./agent/checkpoints');
const { DEFAULT_PROMPTS, buildSystemPrompt, loadProjectRules, loadMemory, memoryPaths, fill } = require('./agent/prompt');
const { streamText, completeText, stripFences } = require('./agent/oneshot');
const tools = require('./agent/tools');
const { McpManager, CATALOG } = require('./plugins/mcp');
const { PluginManager } = require('./plugins/plugins');
const { listSlashCommands } = require('./plugins/commands');
const ws = require('./workspace');
const git = require('./git');
const { Terminals, hasPty } = require('./terminal');
const { loadShellEnv } = require('./lib/shellenv');
const { resolvePath } = require('./lib/fsutil');
const { joinUrl, readErrorBody } = require('./agent/sse');
const { authHeaders, withQuery } = require('./agent/util');
const { SemanticIndex } = require('./index/semantic');
const { DocsStore } = require('./index/docs');
const { AgentBrowser } = require('./browser');
const worktrees = require('./worktrees');
const { UsageStore } = require('./usage');
const { Scheduler } = require('./automations');
const importers = require('./importers');
const { runLints } = require('./agent/lints');
const { loadHooks } = require('./agent/hooks');

protocol.registerSchemesAsPrivileged([
  { scheme: 'enide', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const APP_ROOT = path.join(__dirname, '..');
const DEV = !!process.env.ENIDE_DEV;
if (!app.requestSingleInstanceLock()) { app.quit(); }

app.setName('Enide');
const USER = app.getPath('userData');
const settings = new SettingsStore(USER);
let secrets;
const chats = new ChatStore(path.join(USER, 'chats'));
const checkpoints = new CheckpointStore(path.join(USER, 'checkpoints'));

let win = null;
let root = null;          // current workspace folder
let dirty = false;
const pendingOpen = [];

const send = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };
const fetchImpl = (url, opts) => net.fetch(url, opts);
const trash = (p) => shell.trashItem(p);

// ---------- request log (exact bodies, keys redacted, base64 elided) ----------
const requestLog = [];
let logSeq = 0;
function elide(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'string' && v.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(v.slice(0, 2000)) ? `<base64 · ${v.length} chars>` : v)));
}
function logRequest(e) {
  if (e.id) {
    const ex = requestLog.find((x) => x.id === e.id);
    if (ex) { Object.assign(ex, e); send('requestlog:entry', summaryOf(ex)); }
    return e.id;
  }
  const entry = { ...e, id: 'req' + (++logSeq), time: Date.now(), body: elide(e.body) };
  requestLog.push(entry);
  if (requestLog.length > 150) requestLog.shift();
  send('requestlog:entry', summaryOf(entry));
  return entry.id;
}
function summaryOf(e) {
  return { id: e.id, time: e.time, url: e.url, provider: e.provider, model: e.model, status: e.status, ms: e.ms, ttfbMs: e.ttfbMs, error: e.error, usage: e.usage, chatId: e.chatId, kind: e.kind || 'agent' };
}

// ---------- services ----------
const usage = new UsageStore(USER, () => settings.get());
const recordUsage = (e) => { const row = usage.record(e); send('usage:entry', row); };
const semantic = new SemanticIndex({
  dir: path.join(USER, 'index'), getSettings: () => settings.get(), getApiKey: async (id) => keyFor(id), fetchImpl,
  onProgress: (r, st) => { if (r === root) send('index:progress', st); }, logRequest: (e) => logRequest(e), recordUsage,
});
const vendorIcons = new VendorIcons({ dir: path.join(USER, 'icons'), fetchImpl, vendors: VENDORS });
const docs = new DocsStore({ dir: path.join(USER, 'docs'), fetchImpl, onProgress: (e) => send('docs:progress', e) });
docs.refreshNames().catch(() => {});
const browser = new AgentBrowser({ getSettings: () => settings.get() });
const extraRootsFor = (r) => ((settings.get().extraRoots || {})[r || ''] || []).filter((p) => fs.existsSync(p));

// ---------- tool host: MCP + plugins + browser ----------
const mcp = new McpManager({ onChange: () => send('mcp:changed', mcp.status()) });
const plugins = new PluginManager({ dir: path.join(USER, 'plugins'), getSettings: () => settings.get(), getRoot: () => root, onChange: () => send('plugins:changed', plugins.status()) });
const toolHost = {
  async list(mode) { return [...browser.list(mode), ...(await mcp.list(mode)), ...plugins.list(mode)]; },
  find(name) { return browser.find(name) || mcp.find(name) || plugins.find(name); },
  call(name, args, ctx) { return name === 'browser' ? browser.call(name, args, ctx) : name.startsWith('mcp__') ? mcp.call(name, args, ctx) : plugins.call(name, args, ctx); },
};

function expandServer(s) {
  const r = root || os.homedir();
  const sub = (v) => (typeof v === 'string' ? v.replace(/\{\{workspace\}\}/g, r) : v);
  return { ...s, args: (s.args || []).map(sub), env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, sub(v)])), url: sub(s.url), cwd: sub(s.cwd), fetchImpl };
}
function configureMcp() {
  mcp.setRoot(root);
  return mcp.configure((settings.get().mcpServers || []).map(expandServer)).catch(() => {});
}

// ---------- agent ----------
const agent = new AgentRunner({
  getSettings: () => settings.get(),
  getApiKey: async (id) => keyFor(id),
  chats, checkpoints, toolHost, fetchImpl, trash, recordUsage, userDir: USER,
  services: {
    semanticSearch: async (r, q, k) => { const st = await semantic.status(r); if (st.state !== 'ready') return null; return semantic.search(r, q, k); },
    docsSearch: (q, name) => docs.search(q, name),
    docsNames: () => docs.names(),
  },
  emit: (runId, ev) => send('agent:event', runId, ev),
  logRequest,
  onFileChanged: (file) => send('ws:file-changed', file),
  rememberApproval: ({ name, args, allowKey }) => {
    const s = settings.get();
    if (name === 'run_command') {
      const prefix = allowKey.replace(/^run_command:/, '');
      const pol = { ...DEFAULT_POLICY, ...(s.agent.policy || {}) };
      // userAllow = prefixes the user explicitly said "always" to; honoured even in "ask every time" mode
      if (prefix) settings.set({ agent: { policy: { ...pol, allowList: pol.allowList.includes(prefix) ? pol.allowList : [...pol.allowList, prefix], userAllow: [...new Set([...(pol.userAllow || []), prefix])] } } });
    } else if (name.startsWith('mcp__')) {
      const f = mcp.find(name);
      const entry = f && mcp.nameMap.get(name);
      if (entry) {
        const servers = (s.mcpServers || []).map((srv) => (srv.id === f.serverId ? { ...srv, autoApproveTools: [...new Set([...(srv.autoApproveTools || []), entry.tool.name])] } : srv));
        settings.replace('mcpServers', servers);
      }
    }
    send('settings:changed', publicSettings());
  },
});

function resolveRef(ref) {
  const s = settings.get();
  const r = ref && ref.providerId ? ref : s.defaultModel;
  return agent.resolveModel(s, r);
}

function publicSettings() {
  const s = settings.get();
  const keyHints = {};
  if (!auth || auth.isSignedIn()) for (const p of s.providers || []) { const own = secrets.hint(p.id); const k = own ? '' : keyFor(p.id); keyHints[p.id] = own || (k ? `${k.slice(0, 4)}…${k.slice(-4)} ↺` : ''); }
  return { settings: s, keyHints };
}

// ---------- window ----------
function createWindow() {
  const s = settings.get();
  const b = (s.layout && s.layout.bounds) || {};
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 860, minHeight: 560,
    title: 'Enide',
    backgroundColor: '#0b0b0e',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0e0e12', symbolColor: '#f4f4f6', height: 46 }, autoHideMenuBar: true, icon: path.join(APP_ROOT, 'build', 'icon.png') }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadURL('enide://app/renderer/index.html');
  win.once('ready-to-show', () => { win.show(); if (DEV) win.webContents.openDevTools({ mode: 'detach' }); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('enide://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  const saveBounds = () => { if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) settings.set({ layout: { bounds: win.getBounds() } }); };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Cancel', 'Close Without Saving'], defaultId: 0, cancelId: 0, message: 'You have unsaved changes.', detail: 'Close Enide and discard them?' });
    if (r === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

function serveFile(req) {
  const u = new URL(req.url);
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const allowed = rel.startsWith('renderer/') || rel.startsWith('node_modules/monaco-editor/min/') || rel.startsWith('node_modules/@xterm/');
  const file = path.normalize(path.join(APP_ROOT, rel));
  if (!allowed || !file.startsWith(APP_ROOT)) return new Response('Not found', { status: 404 });
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json' };
  return fsp.readFile(file).then(
    (buf) => new Response(buf, { headers: { 'content-type': (types[ext] || 'application/octet-stream') + (/(html|javascript|css)/.test(types[ext] || '') ? '; charset=utf-8' : ''), 'cache-control': 'no-cache' } }),
    () => new Response('Not found', { status: 404 }),
  );
}

function applyProxy() {
  const p = (settings.get().network || {}).proxy;
  session.defaultSession.setProxy(p ? { mode: 'fixed_servers', proxyRules: p } : { mode: 'system' }).catch(() => {});
}

async function openWorkspace(dir) {
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  root = dir;
  watcher.watch(root);
  const s = settings.get();
  const recent = [dir, ...(s.recent || []).filter((r) => r !== dir)].slice(0, 12);
  settings.set({ recent, lastWorkspace: dir });
  app.addRecentDocument(dir);
  configureMcp();
  buildMenu();
  const ix = settings.get().index || {};
  if (ix.enabled && ix.autoIndex !== false && ix.providerId) semantic.build(root).catch((e) => send('index:progress', { state: 'error', error: e.message }));
  return { root, name: path.basename(root) };
}

let reindexTimer = null;
const watcher = new ws.Watcher((paths) => {
  send('ws:changed', paths);
  const ix = settings.get().index || {};
  if (ix.enabled && ix.autoIndex !== false && ix.providerId && root) {
    clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => semantic.build(root).catch(() => {}), 90000);
  }
});
const terminals = new Terminals(send);

// ---------- menu ----------
function buildMenu() {
  const cmd = (id) => () => send('menu', id);
  const kb = settings.get().keybindings || {};
  // every menu item with an id can be rebound in Settings → Shortcuts
  const it = (id, label, acc) => ({ id, label, accelerator: kb[id] !== undefined ? (kb[id] || undefined) : acc, click: cmd(id) });
  const recent = (settings.get().recent || []).slice(0, 10).map((r) => ({ label: r.replace(os.homedir(), '~'), click: () => send('menu', 'open-path', r) }));
  const template = [
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      it('settings', 'Settings…', 'CmdOrCtrl+,'),
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      it('new-file', 'New File', 'CmdOrCtrl+N'),
      it('open-folder', 'Open Folder…', 'CmdOrCtrl+O'),
      { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'No recent folders', enabled: false }] },
      { type: 'separator' },
      it('save', 'Save', 'CmdOrCtrl+S'),
      it('save-all', 'Save All', 'CmdOrCtrl+Alt+S'),
      { type: 'separator' },
      it('close-tab', 'Close Tab', 'CmdOrCtrl+W'),
      it('close-folder', 'Close Folder'),
    ] },
    { label: 'Edit', submenu: [
      // undo/redo/select-all are routed to Monaco when the editor has focus
      it('undo', 'Undo', 'CmdOrCtrl+Z'), it('redo', 'Redo', 'Shift+Cmd+Z'), { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, it('select-all', 'Select All', 'CmdOrCtrl+A'), { type: 'separator' },
      it('search', 'Find in Files', 'CmdOrCtrl+Shift+F'),
    ] },
    { label: 'View', submenu: [
      it('palette', 'Command Palette…', 'CmdOrCtrl+Shift+P'),
      it('quick-open', 'Quick Open…', 'CmdOrCtrl+P'),
      { type: 'separator' },
      it('explorer', 'Explorer', 'CmdOrCtrl+Shift+E'),
      it('git', 'Source Control', 'Ctrl+Shift+G'),
      it('plugins', 'Plugins & MCP', 'CmdOrCtrl+Shift+X'),
      { type: 'separator' },
      it('toggle-sidebar', 'Toggle Sidebar', 'CmdOrCtrl+B'),
      it('toggle-panel', 'Toggle Terminal', 'CmdOrCtrl+J'),
      it('new-terminal', 'New Terminal', 'Ctrl+Shift+`'),
      it('toggle-agent', 'Toggle Agent', 'CmdOrCtrl+Alt+B'),
      it('split-editor', 'Split Editor', 'CmdOrCtrl+\\'),
      it('problems', 'Problems', 'CmdOrCtrl+Shift+M'),
      it('show-browser', 'Agent Browser'),
      it('request-log', 'Request Log'),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => win && win.webContents.toggleDevTools() },
    ] },
    { label: 'Agent', submenu: [
      it('new-chat', 'New Chat', 'CmdOrCtrl+Shift+L'),
      it('focus-chat', 'Focus Chat / Add Selection', 'CmdOrCtrl+L'),
      it('toggle-agent', 'Toggle Agent Panel', 'CmdOrCtrl+I'),
      it('inline-edit', 'Inline Edit', 'CmdOrCtrl+K'),
      { type: 'separator' },
      it('mode-agent', 'Agent Mode', 'CmdOrCtrl+1'),
      it('mode-ask', 'Ask Mode', 'CmdOrCtrl+2'),
      it('mode-plan', 'Plan Mode', 'CmdOrCtrl+3'),
      it('mode-debug', 'Debug Mode', 'CmdOrCtrl+4'),
      { type: 'separator' },
      it('new-chat-tab', 'New Chat Tab', 'CmdOrCtrl+T'),
      it('compact', 'Compact Context'),
      it('review', 'Review Changes with AI'),
      { type: 'separator' },
      it('toggle-autocomplete', 'Toggle Tab Autocomplete'),
      it('context-preview', 'Context Preview (exact prompt)'),
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Enide on GitHub', click: () => shell.openExternal('https://github.com') },
      { label: 'Open Logs Folder', click: () => shell.openPath(USER) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
// API key for a model: its own, or the key of another model on the same endpoint
// (add several models of one provider and paste the key once).
const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
function keyFor(id) {
  const own = secrets.get(id);
  if (own) return own;
  const ps = settings.get().providers || [];
  const p = ps.find((x) => x.id === id);
  if (!p || !p.baseUrl) return '';
  for (const q of ps) if (q.id !== id && normUrl(q.baseUrl) === normUrl(p.baseUrl)) { const k = secrets.get(q.id); if (k) return k; }
  return '';
}

// v1.1: no built-in model lists. Keep only the models the user added or uses by default,
// one entry per model (ID + endpoint + key), copying keys where a provider is split.
async function migrateToCustomModels() {
  const s = settings.get();
  if (s.modelsV2) return;
  const def = s.defaultModel || {};
  const out = [];
  for (const p of s.providers || []) {
    const keep = (p.models || []).filter((m) => m.custom || (def.providerId === p.id && def.modelId === m.id));
    // a provider the user set a key for keeps at least one model, so nothing they use disappears
    if (!keep.length && secrets.has(p.id)) { const first = (p.models || []).find((m) => m.enabled !== false); if (first) keep.push(first); }
    for (let i = 0; i < keep.length; i++) {
      if (i === 0) { out.push({ ...p, preset: 'custom', models: [keep[i]] }); continue; }
      const id = `${p.id}-${i + 1}`;
      const k = secrets.get(p.id);
      if (k) await secrets.set(id, k);
      out.push({ ...p, id, preset: 'custom', name: keep[i].name || keep[i].id, models: [keep[i]] });
    }
  }
  settings.replace('providers', out);
  settings.replace('router', {});
  const okDefault = out.some((p) => p.id === def.providerId && p.models.some((m) => m.id === def.modelId));
  settings.replace('defaultModel', okDefault ? def : out[0] ? { providerId: out[0].id, modelId: out[0].models[0].id } : null);
  settings.set({ modelsV2: true });
}

// v1.2: one API (endpoint + key) and one shared model list — the Cursor families plus any
// model ID the user adds or the API reports. Whether a model answers depends on the API.
const { MODELS: BUILTIN_MODELS } = require('./models');
const { detectProtocol, authFor } = require('./agent/providers');
function apiBase(p = {}) {
  const baseUrl = p.baseUrl || '';
  const protocol = p.protocol || detectProtocol(baseUrl);
  return { id: 'api', preset: 'custom', name: 'API', baseUrl, protocol, authStyle: p.authStyle || authFor(protocol, baseUrl), headers: p.headers || {}, query: '',
    echoReasoning: true, streamUsage: true, promptCaching: p.promptCaching != null ? p.promptCaching : protocol === 'anthropic' && /api\.anthropic\.com/.test(baseUrl),
    maxTokensField: p.maxTokensField || 'max_tokens', defaultReasoning: null, enabled: true };
}
function buildModels(base, extras) {
  const seen = new Set();
  const out = [];
  for (const b of BUILTIN_MODELS) { seen.add(b.id); out.push(normalizeModel({ id: b.id, name: b.name, contextWindow: b.contextWindow, maxOutput: b.maxOutput, vision: b.vision, vendor: b.vendor }, base)); }
  for (const m of extras || []) if (m && m.id && !seen.has(m.id)) { seen.add(m.id); out.push(normalizeModel({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision, custom: true, fetched: !!m.fetched }, base)); }
  return out;
}
function apiProvider() { return (settings.get().providers || []).find((x) => x.id === 'api'); }
function saveApi(patch = {}, extras) {
  const cur = apiProvider() || {};
  const base = apiBase({ ...cur, ...patch, ...(patch.baseUrl !== undefined && patch.protocol === undefined ? { protocol: detectProtocol(patch.baseUrl) } : {}), ...(patch.baseUrl !== undefined || patch.protocol !== undefined ? { authStyle: patch.authStyle } : {}) });
  const keepExtras = extras || (cur.models || []).filter((m) => m.custom);
  const api = { ...base, models: buildModels(base, keepExtras) };
  settings.replace('providers', [api]);
  const def = settings.get().defaultModel;
  if (!def || def.providerId !== 'api' || !api.models.some((m) => m.id === def.modelId)) settings.replace('defaultModel', { providerId: 'api', modelId: (def && api.models.some((m) => m.id === def.modelId) && def.modelId) || 'claude-sonnet-5-5' });
  return api;
}
// From 1.0/1.1 (several providers) to the single API, keeping the endpoint + key in use.
async function migrateToSingleApi() {
  const s = settings.get();
  if (s.apiV3) { saveApi(); return; }
  const list = s.providers || [];
  const def = s.defaultModel || {};
  const main = list.find((p) => p.id === def.providerId) || list.find((p) => p.id !== 'api' && secrets.has(p.id)) || list[0];
  const extras = [];
  if (main) {
    for (const p of list) if (normUrl(p.baseUrl) === normUrl(main.baseUrl)) for (const m of p.models || []) if (!BUILTIN_MODELS.some((b) => b.id === m.id)) extras.push({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision });
    const k = keyFor(main.id);
    if (k && main.id !== 'api') await secrets.set('api', k);
  }
  const defModel = def.modelId;
  saveApi(main ? { baseUrl: main.baseUrl, protocol: main.protocol, authStyle: main.authStyle, headers: main.headers } : {}, extras);
  if (defModel) settings.replace('defaultModel', { providerId: 'api', modelId: defModel });
  saveApi();
  // the one system prompt: carry over 1.1's global rules so nothing applies unseen
  const g = s.rules && s.rules.global && s.rules.global.trim();
  if (g && s.systemPrompt == null) { settings.set({ systemPrompt: `${DEFAULT_PROMPTS.agent.trim()}\n\n${g}` }); settings.set({ rules: { ...s.rules, global: '' } }); }
  settings.set({ apiV3: true, modelsV2: true, starfield: false, theme: settings.get().theme === 'light' ? 'light' : 'dark' });
}

// Channels that work before sign-in (the sign-in screen itself needs theme + language).
const OPEN_CHANNELS = new Set(['app:info', 'settings:get', 'app:open-external', 'update:check', 'update:install']);
function h(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      if (auth && !auth.isSignedIn() && !channel.startsWith('auth:') && !OPEN_CHANNELS.has(channel)) throw new Error('Sign in to Enide first');
      return { ok: true, data: await fn(...args) };
    }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err), code: err && err.code, field: err && err.field }; }
  });
}

const aiControllers = new Map();

function registerIpc() {
  // ---------- account ----------
  h('auth:status', async () => auth.status());
  h('auth:register', async (f) => auth.register(f || {}));
  h('auth:login', async (f) => auth.login(f || {}));
  h('auth:recover', async (f) => auth.recover(f || {}));
  h('auth:logout', async () => auth.logout());
  h('auth:update', async (f) => auth.updateProfile(f || {}));
  h('auth:change-password', async (f) => auth.changePassword(f || {}));
  h('auth:change-word', async (f) => auth.changeWord(f || {}));
  h('auth:delete', async (f) => auth.deleteAccount(f || {}));

  h('app:info', async () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch, home: os.homedir(),
    isPackaged: app.isPackaged, hasPty: hasPty(), encryption: secrets.encryptionAvailable(), presets: PRESETS, vendors: VENDORS, defaultPrompts: DEFAULT_PROMPTS,
    defaultPolicy: DEFAULT_POLICY, mcpCatalog: CATALOG, toolDefs: tools.definitions('agent'), locale: app.getLocale(),
    pendingOpen: pendingOpen.splice(0), userData: USER, autoPolicy: AUTO_POLICY,
  }));
  h('app:set-dirty', async (v) => { dirty = !!v; });
  h('app:open-external', async (url) => { if (/^https?:|^mailto:/.test(url)) await shell.openExternal(url); });
  h('app:reveal', async (p) => shell.showItemInFolder(p));
  h('app:open-path', async (p) => shell.openPath(p));
  h('app:pick-images', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(readImage));
  });
  h('app:read-image', readImage);
  h('app:pick-files', async ({ folders } = {}) => {
    const r = await dialog.showOpenDialog(win, { defaultPath: app.getPath('desktop'), properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'openDirectory', 'multiSelections', 'treatPackageAsDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });
  h('app:capture-screen', async ({ full } = {}) => {
    if (process.platform !== 'darwin') {
      // Windows/Linux: whole primary screen via desktopCapturer (no area selection there).
      const { desktopCapturer, screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      const scale = Math.min(1, 2000 / Math.max(d.size.width * d.scaleFactor, d.size.height * d.scaleFactor));
      const visible = win && win.isVisible();
      if (visible) win.hide();
      await new Promise((r) => setTimeout(r, 300));
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor * scale), height: Math.round(d.size.height * d.scaleFactor * scale) } });
        const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
        if (!src) return null;
        return { mediaType: 'image/png', data: src.thumbnail.toPNG().toString('base64') };
      } finally { if (visible && win) { win.show(); win.focus(); } }
    }
    const tmp = path.join(os.tmpdir(), `enide-cap-${Date.now()}.png`);
    const visible = win && win.isVisible();
    if (visible) win.hide();
    await new Promise((r) => setTimeout(r, 300));
    try { await execP('/usr/sbin/screencapture', full ? ['-x', tmp] : ['-i', '-x', tmp], 120000); }
    catch (e) { throw new Error(`${e.message}\nAllow Screen Recording for Enide: System Settings → Privacy & Security → Screen Recording.`); }
    finally { if (visible && win) { win.show(); win.focus(); } }
    if (!fs.existsSync(tmp)) return null;
    try { await execP('/usr/bin/sips', ['-Z', '2000', tmp]); } catch {}
    try { return await readImage(tmp); } finally { fsp.rm(tmp, { force: true }).catch(() => {}); }
  });

  h('settings:get', async () => publicSettings());
  h('settings:set', async (patch) => {
    const before = settings.get();
    const beforeMcp = JSON.stringify(before.mcpServers || []);
    const beforeProxy = JSON.stringify(before.network || {});
    const beforePlugins = JSON.stringify(before.plugins || {});
    if (patch && Array.isArray(patch.__replace)) { for (const k of patch.__replace) { settings.replace(k, patch[k]); delete patch[k]; } delete patch.__replace; }
    for (const key of ['providers', 'mcpServers', 'recent']) if (patch && Array.isArray(patch[key])) { settings.replace(key, patch[key]); delete patch[key]; }
    settings.set(patch || {});
    if (patch && patch.theme) nativeTheme.themeSource = patch.theme === 'light' ? 'light' : patch.theme === 'system' ? 'system' : 'dark';
    const after = settings.get();
    if (JSON.stringify(after.mcpServers || []) !== beforeMcp) configureMcp();
    if (JSON.stringify(after.network || {}) !== beforeProxy) applyProxy();
    if (JSON.stringify(after.plugins || {}) !== beforePlugins) plugins.load();
    buildMenu();
    return publicSettings();
  });
  h('secrets:set', async (id, value) => { await secrets.set(id, value); return secrets.hint(id); });
  h('providers:new', async (presetId) => providerFromPreset(presetId));
  h('providers:models', async (providerId, draft) => {
    const p = draft || (settings.get().providers || []).find((x) => x.id === providerId);
    if (!p) throw new Error('Unknown provider');
    return listModels({ provider: p, apiKey: keyFor(p.id), fetchImpl });
  });
  h('providers:custom', async (f) => customModel(f || {}));
  h('api:set', async (patch) => { saveApi(patch || {}); return publicSettings(); });
  h('api:add-model', async (id) => {
    const v = String(id || '').trim();
    if (!v) throw new Error('Model ID is empty');
    const cur = apiProvider() || {};
    saveApi({}, [...(cur.models || []).filter((m) => m.custom), { id: v }]);
    return publicSettings();
  });
  h('api:remove-model', async (id) => { const cur = apiProvider() || {}; saveApi({}, (cur.models || []).filter((m) => m.custom && m.id !== id)); return publicSettings(); });
  h('api:fetch-models', async () => {
    const cur = apiProvider();
    if (!cur || !cur.baseUrl) throw new Error('Enter the API endpoint first');
    const got = await listModels({ provider: cur, apiKey: keyFor('api'), fetchImpl });
    const extras = [...(cur.models || []).filter((m) => m.custom), ...got.map((m) => ({ id: m.id, contextWindow: m.contextWindow, fetched: true }))];
    saveApi({}, extras);
    return { added: got.length, settings: publicSettings() };
  });
  h('providers:normalize', async (m, p) => normalizeModel(m || {}, p || {}));
  h('icons:get', async (vendor) => vendorIcons.get(String(vendor || '')));
  h('icons:clear', async () => { vendorIcons.clear(); return true; });
  h('icons:refresh', async () => {
    vendorIcons.clear();
    const keys = Object.keys(VENDORS);
    const got = await Promise.all(keys.map((k) => vendorIcons.get(k)));
    return { ok: got.filter(Boolean).length, total: keys.length, missing: keys.filter((_, i) => !got[i]).map((k) => VENDORS[k].name) };
  });
  h('providers:test', async (providerId, modelId, reasoningEnabled, draft) => {
    const p = draft || (settings.get().providers || []).find((x) => x.id === providerId);
    if (!p) throw new Error('Unknown provider');
    const m = (p.models || []).find((x) => x.id === modelId) || { id: modelId };
    return testConnection({ provider: p, apiKey: keyFor(p.id), model: normalizeModel(m, p), fetchImpl, reasoning: { enabled: !!reasoningEnabled, effort: 'low' } });
  });

  // workspace
  h('ws:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('ws:open', openWorkspace);
  h('ws:close', async () => { root = null; watcher.close(); settings.set({ lastWorkspace: null }); configureMcp(); return null; });
  h('ws:root', async () => root);
  h('ws:readdir', ws.readDir);
  h('ws:read', ws.readFile);
  h('ws:write', ws.writeFile);
  h('ws:create-file', ws.createFile);
  h('ws:create-dir', ws.createDir);
  h('ws:rename', ws.rename);
  h('ws:delete', async (p) => { await trash(p); });
  h('ws:list-files', async (r) => {
    const main = await ws.listFiles(r || root);
    if (r) return main;
    for (const extra of extraRootsFor(root)) for (const f of await ws.listFiles(extra, 8000)) main.push(path.join(extra, f));
    return main;
  });
  h('ws:search', async (opts) => ws.search(root, opts));
  h('ws:replace', async (opts, replacement, files) => ws.replaceInFiles(root, opts, replacement, files));
  h('ws:folder-summary', async (dir) => {
    const r = await tools.EXEC.list_dir({ path: dir, depth: 3 }, { root: root || os.homedir() });
    return r.output.slice(0, 20000);
  });
  h('ws:exists', async (p) => fs.existsSync(p));
  h('ws:describe-file', describeFile);

  // terminal
  h('term:create', async (opts) => terminals.create({ ...opts, cwd: opts.cwd || root, shell: (settings.get().terminal || {}).shell }));
  ipcMain.on('term:write', (_e, id, data) => terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id, cols, rows) => terminals.resize(id, cols, rows));
  h('term:kill', async (id) => terminals.kill(id));

  // git
  h('git:status', async () => git.status(root));
  h('git:diff', async (file, staged) => git.diffContents(root, file, staged));
  h('git:stage', async (files) => git.stage(root, files));
  h('git:unstage', async (files) => git.unstage(root, files));
  h('git:discard', async (files) => git.discard(root, files, trash));
  h('git:commit', async (message, opts) => git.commit(root, message, opts));
  h('git:branches', async () => git.branches(root));
  h('git:checkout', async (name, create) => git.checkout(root, name, create));
  h('git:push', async () => git.push(root));
  h('git:pull', async () => git.pull(root));
  h('git:fetch', async () => git.fetchAll(root));
  h('git:init', async () => git.init(root));
  h('git:log', async (n) => git.log(root, n));

  // chats & agent
  h('chat:list', async (r) => chats.list(r === undefined ? undefined : (r || null)));
  h('chat:get', async (id) => chats.get(id));
  h('chat:new', async (r) => chats.create({ root: r || root }));
  h('chat:rename', async (id, title) => chats.rename(id, title));
  h('chat:delete', async (id) => { await chats.remove(id); await checkpoints.removeChat(id); });
  h('agent:send', async (params) => {
    const p = { ...params };
    let runRoot = p.root !== undefined ? p.root : root;
    // git worktree per chat: create on first send, reuse afterwards
    let chat = p.chatId ? await chats.get(p.chatId) : null;
    if (p.worktree && !(chat && chat.worktree) && root) {
      if (!chat) { chat = await chats.create({ root }); p.chatId = chat.id; }
      chat.worktree = await worktrees.create(root, path.join(USER, 'worktrees'), chat.id);
      await chats.save(chat);
    }
    if (chat && chat.worktree) runRoot = chat.worktree.workRoot || chat.worktree.path;
    // @Docs mentions → the most relevant passages for this message
    const atts = [];
    for (const a of p.attachments || []) {
      if (a.type === 'docs') {
        const found = await docs.search(p.text || a.name, a.name, 6).catch((e) => e.message);
        atts.push({ type: 'text', kind: 'docs', label: a.name, text: `<docs name="${a.name}">\n${found}\n</docs>` });
      } else atts.push(a);
    }
    p.attachments = atts;
    return agent.start({ ...p, root: runRoot, extraRoots: extraRootsFor(root) });
  });
  h('agent:active', async () => agent.active());
  h('agent:compact', async (chatId, opts) => agent.compact(chatId, opts || {}));
  h('agent:context', async (chatId, opts = {}) => {
    const chat = chatId ? await chats.get(chatId) : null;
    const r = chat && chat.worktree ? chat.worktree.workRoot : root;
    return agent.contextBreakdown(chatId, { ...opts, root: r, extraRoots: extraRootsFor(root) });
  });
  h('chat:pin', async (id, v) => chats.pin(id, v));
  h('chat:search', async (q, r) => chats.search(q, r === undefined ? undefined : (r || null)));
  h('chat:fork', async (id, messageId, opts) => chats.fork(id, messageId, opts || {}));

  // worktrees
  const wtOf = async (chatId) => { const c = await chats.get(chatId); if (!c || !c.worktree) throw new Error('This chat has no worktree'); return c; };
  h('wt:status', async (chatId) => { const c = await wtOf(chatId); return { ...(await worktrees.status(c.worktree)), branch: c.worktree.branch, path: c.worktree.path }; });
  h('wt:apply', async (chatId) => {
    const c = await wtOf(chatId);
    if (agent.isRunning(chatId)) throw new Error('Stop the agent first');
    const r = await worktrees.apply(c.worktree);
    if (r.base) { c.worktree.base = r.base; await chats.save(c); }
    send('ws:changed', [root]);
    return r;
  });
  h('wt:discard', async (chatId) => {
    const c = await wtOf(chatId);
    if (agent.isRunning(chatId)) throw new Error('Stop the agent first');
    await worktrees.remove(c.worktree);
    c.worktree = null; c.worktreeDiscarded = true;
    await chats.save(c);
    return true;
  });
  h('wt:diff', async (chatId, rel) => {
    const c = await wtOf(chatId);
    const orig = await new Promise((res) => execFile('git', ['show', `${c.worktree.base}:${rel}`], { cwd: c.worktree.path, maxBuffer: 64 * 1024 * 1024 }, (e, out) => res(e ? '' : out)));
    let mod = ''; try { mod = await fsp.readFile(path.join(c.worktree.path, rel), 'utf8'); } catch {}
    return { original: orig, modified: mod, path: path.join(c.worktree.path, rel) };
  });
  h('agent:stop', async (runId) => agent.stop(runId));
  h('agent:approve', async (runId, callId, decision) => agent.approve(runId, callId, decision));
  h('agent:checkpoints', async (chatId) => checkpoints.summary(chatId));
  h('agent:restore', async (chatId, messageId, { truncate = true, revertFiles = true } = {}) => {
    const chat = await chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (agent.isRunning(chatId)) throw new Error('Stop the agent first');
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new Error('Message not found');
    const turnIds = chat.messages.slice(idx).filter((m) => m.role === 'user').map((m) => m.id);
    const restored = revertFiles ? await checkpoints.restore(chatId, turnIds) : [];
    const msg = chat.messages[idx];
    const text = (msg.content || []).filter((b) => b.type === 'text' && !b.attachment).map((b) => b.text).join('\n');
    // give the attachments back too, so an edited / retried question keeps its files and images
    const attachments = (msg.content || []).filter((b) => b.type === 'image' || (b.type === 'text' && b.attachment)).map((b) => (b.type === 'image'
      ? { type: 'image', mediaType: b.mediaType, data: b.data, name: b.name || 'image' }
      : { type: 'text', kind: b.attachment.kind, label: b.attachment.label || b.attachment.path, path: b.attachment.path, startLine: b.attachment.startLine, endLine: b.attachment.endLine, text: b.text }));
    if (truncate) await chats.truncate(chatId, messageId);
    for (const f of restored) send('ws:file-changed', f);
    return { restored, text, attachments };
  });
  h('agent:turn-changes', async (chatId, turnId) => {
    const cp = await checkpoints.get(chatId, turnId);
    if (!cp) return [];
    const out = [];
    for (const [abs, e] of Object.entries(cp.files || {})) {
      if (e.dir || e.skipped) continue;
      const before = e.existed ? Buffer.from(e.data, 'base64').toString('utf8') : '';
      let after = '';
      try { after = await fsp.readFile(abs, 'utf8'); } catch {}
      out.push({ path: abs, before, after, created: !e.existed });
    }
    return out;
  });
  h('agent:preview', async ({ mode, modelRef } = {}) => {
    const s = settings.get();
    const sys = await buildSystemPrompt({ mode: mode || 'agent', settings: s, root });
    const builtin = tools.definitions(mode || 'agent', s.agent && s.agent.tools, { computerUse: !!(s.agent && s.agent.computerUse) });
    const external = await toolHost.list(mode || 'agent');
    let model = null;
    try { const r = resolveRef(modelRef); model = { provider: r.provider.name, protocol: r.provider.protocol, baseUrl: r.provider.baseUrl, model: r.model }; } catch {}
    return { system: sys.text, template: sys.template, rules: sys.rules, tools: [...builtin, ...external].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, source: t.source || 'builtin' })), model };
  });
  h('rules:list', async () => loadProjectRules(root, settings.get()));
  h('slash:list', async () => listSlashCommands({ root, userDir: path.join(USER, 'commands'), plugins: plugins.listSlash() }));

  // one-shot AI (inline edit, autocomplete, commit message)
  h('ai:inline', async (opts) => {
    const s = settings.get();
    const { provider, model } = resolveRef(opts.modelRef || (s.inlineEdit && s.inlineEdit.model));
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    const user = fill(prompts.inlineEditUser, { path: opts.path || 'untitled', language: opts.language || 'plaintext', prefix: opts.prefix || '', selection: opts.selection || '', suffix: opts.suffix || '', instruction: opts.instruction || '' });
    const ac = new AbortController();
    aiControllers.set(opts.id, ac);
    let text = '';
    try {
      for await (const ev of streamText({ provider, model, apiKey: keyFor(provider.id), system: prompts.inlineEditSystem, user, reasoning: opts.reasoning || { enabled: false }, signal: ac.signal, fetchImpl,
        onRequest: (r) => logRequest({ ...r, kind: 'inline-edit', provider: provider.name, model: model.id }) })) {
        if (ev.type === 'usage') recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind: 'inline-edit', usage: ev.usage });
        else if (ev.type === 'text') { text += ev.text; send('ai:event', opts.id, { type: 'text', text: ev.text }); }
        else if (ev.type === 'reasoning') send('ai:event', opts.id, { type: 'reasoning', text: ev.text });
      }
    } finally { aiControllers.delete(opts.id); }
    return stripFences(text);
  });
  h('ai:complete', async (opts) => {
    const s = settings.get();
    const ac = s.autocomplete || {};
    const { provider, model } = resolveRef(ac.model);
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    const user = fill(prompts.autocompleteUser, { path: opts.path || 'untitled', language: opts.language || 'plaintext', prefix: opts.prefix || '', suffix: opts.suffix || '' });
    const ctl = new AbortController();
    if (aiControllers.has('complete')) aiControllers.get('complete').abort();
    aiControllers.set('complete', ctl);
    try {
      const out = await completeText({ provider, model, apiKey: keyFor(provider.id), system: prompts.autocompleteSystem, user, maxTokens: ac.maxTokens || 256, signal: ctl.signal, fetchImpl,
        onUsage: (u) => recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind: 'autocomplete', usage: u }),
        onRequest: (r) => logRequest({ ...r, kind: 'autocomplete', provider: provider.name, model: model.id }) });
      return stripFences(out).replace(/<CURSOR>/g, '');
    } finally { if (aiControllers.get('complete') === ctl) aiControllers.delete('complete'); }
  });
  h('ai:terminal-command', async ({ instruction, cwd }) => {
    const s = settings.get();
    const { provider, model } = resolveRef(s.inlineEdit && s.inlineEdit.model);
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    const system = fill(prompts.terminalSystem, { shell: require('./lib/shell').shellName(), os: require('./agent/prompt').osLabel(), cwd: cwd || root || os.homedir() });
    const out = await completeText({ provider, model, apiKey: keyFor(provider.id), system, user: instruction, maxTokens: 400, fetchImpl,
      onRequest: (r) => logRequest({ ...r, kind: 'terminal-command', provider: provider.name, model: model.id }) });
    return stripFences(out).trim().replace(/^\$\s*/, '');
  });
  h('ai:transcribe', async ({ data, mimeType }) => transcribe(Buffer.from(data, 'base64'), mimeType || 'audio/wav'));
  h('ai:cancel', async (id) => { const c = aiControllers.get(id); if (c) c.abort(); });
  h('ai:commit-message', async () => {
    const s = settings.get();
    const diff = await git.stagedDiff(root);
    if (!diff.trim()) throw new Error('No changes to describe');
    const { provider, model } = resolveRef(s.commitModel);
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    const out = await completeText({ provider, model, apiKey: keyFor(provider.id), system: prompts.commitSystem, user: diff, maxTokens: 400, fetchImpl,
      onUsage: (u) => recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind: 'commit-message', usage: u }),
      onRequest: (r) => logRequest({ ...r, kind: 'commit-message', provider: provider.name, model: model.id }) });
    return stripFences(out).trim();
  });

  // plugins & MCP
  h('mcp:status', async () => mcp.status());
  h('mcp:restart', async (id) => { await mcp.restart(id); return mcp.status(); });
  h('mcp:import', async () => importMcpConfigs());
  h('plugins:status', async () => plugins.status());
  h('plugins:install', async (src) => { const p = await plugins.install(src); return { folder: p, status: plugins.status() }; });
  h('plugins:remove', async (id) => { await plugins.remove(id); return plugins.status(); });
  h('plugins:scaffold', async (name) => { const f = await plugins.scaffold(name); return { folder: f, status: plugins.status() }; });
  h('plugins:reload', async () => { await plugins.load(); return plugins.status(); });
  h('plugins:commands', async () => plugins.listCommands());
  h('plugins:run-command', async (id) => plugins.runCommand(id));
  h('plugins:dir', async () => plugins.dir);
  h('plugins:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // multi-root workspace
  h('ws:extra-roots', async () => extraRootsFor(root));
  h('ws:add-folder', async (p) => {
    let dir = p;
    if (!dir) { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (r.canceled) return extraRootsFor(root); dir = r.filePaths[0]; }
    if (!root) throw new Error('Open a main folder first');
    const all = { ...(settings.get().extraRoots || {}) };
    all[root] = [...new Set([...(all[root] || []), dir])].filter((x) => x !== root);
    settings.replace('extraRoots', all);
    return extraRootsFor(root);
  });
  h('ws:remove-folder', async (dir) => {
    const all = { ...(settings.get().extraRoots || {}) };
    all[root] = (all[root] || []).filter((x) => x !== dir);
    settings.replace('extraRoots', all);
    return extraRootsFor(root);
  });
  h('ws:read-many', async (files) => {
    const out = {};
    for (const f of (files || []).slice(0, 3000)) { try { const st = await fsp.stat(f); if (st.size < 400000) out[f] = await fsp.readFile(f, 'utf8'); } catch {} }
    return out;
  });

  // diagnostics & review
  h('lint:run', async (paths) => { if (!root) throw new Error('Open a folder first'); return runLints(root, { paths: paths || [] }); });
  h('review:run', async () => {
    if (!root) throw new Error('Open a folder first');
    const s = settings.get();
    let diff = await git.git(root, ['diff', 'HEAD', '--no-color', '-U5']).catch(() => '');
    const untracked = (await git.git(root, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean).slice(0, 30);
    for (const f of untracked) { try { const t = await fsp.readFile(path.join(root, f), 'utf8'); if (t.length < 60000) diff += `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n` + t.split('\n').map((l, i) => `+${l}`).join('\n'); } catch {} }
    if (!diff.trim()) throw new Error('No changes to review');
    if (diff.length > 200000) diff = diff.slice(0, 200000) + '\n… (diff truncated)';
    const { provider, model } = resolveRef(s.reviewModel);
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    let u = null;
    const out = await completeText({ provider, model, apiKey: keyFor(provider.id), system: prompts.reviewSystem, user: diff, maxTokens: 8000, fetchImpl, reasoning: s.reasoning,
      onUsage: (x) => { u = x; }, onRequest: (r) => logRequest({ ...r, kind: 'review', provider: provider.name, model: model.id }) });
    if (u) recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind: 'review', usage: u });
    const m = /\[[\s\S]*\]/.exec(stripFences(out));
    let items = [];
    try { items = JSON.parse(m ? m[0] : '[]'); } catch { throw new Error('The model did not return valid JSON:\n' + out.slice(0, 500)); }
    return items.filter((x) => x && x.file).map((x) => ({ ...x, file: path.resolve(root, String(x.file).replace(/^[ab]\//, '')), line: Math.max(1, parseInt(x.line, 10) || 1), severity: ['error', 'warning', 'info'].includes(x.severity) ? x.severity : 'warning', source: 'review' }));
  });

  // next-edit prediction (Tab)
  h('ai:next-edit', async (opts) => {
    const s = settings.get();
    const ac = s.autocomplete || {};
    const { provider, model } = resolveRef(ac.model);
    const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
    const user = fill(prompts.nextEditUser, { path: opts.path || 'untitled', language: opts.language || 'plaintext', cursorLine: opts.cursorLine || 1, recentEdits: opts.recentEdits || '(none)', code: opts.code || '' });
    const ctl = new AbortController();
    if (aiControllers.has('next-edit')) aiControllers.get('next-edit').abort();
    aiControllers.set('next-edit', ctl);
    try {
      let u = null;
      const out = await completeText({ provider, model, apiKey: keyFor(provider.id), system: prompts.nextEditSystem, user, maxTokens: 600, signal: ctl.signal, fetchImpl, onUsage: (x) => { u = x; },
        onRequest: (r) => logRequest({ ...r, kind: 'next-edit', provider: provider.name, model: model.id }) });
      if (u) recordUsage({ providerId: provider.id, provider: provider.name, model: model.id, kind: 'next-edit', usage: u });
      const m = /\{[\s\S]*\}/.exec(out);
      if (!m) return null;
      const j = JSON.parse(m[0]);
      if (j.none || !j.start_line) return null;
      return { startLine: +j.start_line, endLine: +(j.end_line || j.start_line), replacement: String(j.replacement == null ? '' : j.replacement) };
    } catch { return null; }
    finally { if (aiControllers.get('next-edit') === ctl) aiControllers.delete('next-edit'); }
  });

  // semantic index & docs
  h('index:status', async () => semantic.status(root));
  h('index:build', async (full) => { if (!root) throw new Error('Open a folder first'); semantic.build(root, { full: !!full }).catch((e) => send('index:progress', { state: 'error', error: e.message })); return semantic.status(root); });
  h('index:remove', async () => { if (root) await semantic.remove(root); return semantic.status(root); });
  h('index:search', async (q) => semantic.search(root, q, 8));
  h('docs:list', async () => docs.list());
  h('docs:add', async (e) => docs.add(e));
  h('docs:reindex', async (id) => docs.reindex(id));
  h('docs:remove', async (id) => { await docs.remove(id); return docs.list(); });

  // memory, hooks
  h('memory:get', async () => {
    const p = memoryPaths(root, USER);
    const read = async (f) => { if (!f) return null; try { return await fsp.readFile(f, 'utf8'); } catch { return ''; } };
    return { global: { path: p.global, text: await read(p.global) }, project: p.project ? { path: p.project, text: await read(p.project) } : null };
  });
  h('memory:save', async (scope, text) => {
    const p = memoryPaths(root, USER)[scope];
    if (!p) throw new Error('No folder open');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, text || '', 'utf8');
    return true;
  });
  h('hooks:list', async () => loadHooks(settings.get(), root));

  // usage
  h('usage:summary', async (days) => usage.summary(days || 30));
  h('usage:clear', async () => usage.clear());

  // themes & keybindings from VS Code / Cursor
  h('themes:list', async () => importers.listThemes());
  h('themes:load', async (file, uiTheme) => importers.convertTheme(file, uiTheme));
  h('themes:pick-file', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'VS Code theme', extensions: ['json'] }] });
    if (r.canceled) return null;
    return importers.convertTheme(r.filePaths[0]);
  });
  h('keys:import', async () => importers.importKeybindings());

  // automations
  h('automations:run-now', async (id) => { const a = (settings.get().automations || []).find((x) => x.id === id); if (!a) throw new Error('Unknown automation'); scheduler.fire(a); return true; });
  h('automations:pick-folder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });

  // browser
  h('browser:show', async () => { browser.show(); return true; });

  // updates
  h('update:check', async () => checkForUpdate());
  h('update:install', async (info) => installUpdate(info));

  h('requestlog:list', async () => requestLog.map(summaryOf));
  h('requestlog:get', async (id) => requestLog.find((x) => x.id === id) || null);
  h('requestlog:clear', async () => { requestLog.length = 0; });
}

// ---------- updates (GitHub releases of the repo set in Settings → About) ----------
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
// ---------- updates ----------
// Latest GitHub release → the right file for this OS/arch. Packaged apps must update
// (the renderer shows a blocking screen); dev runs only get a notice.
function pickUpdateAsset(assets) {
  const list = assets || [];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const find = (re) => list.find((a) => re.test(a.name));
  if (process.platform === 'darwin') return find(new RegExp(`mac-${arch}\\.zip$`, 'i')) || find(new RegExp(`mac-${arch}\\.dmg$`, 'i')) || find(/mac.*\.zip$/i);
  if (process.platform === 'win32') return find(/Setup.*win.*\.exe$/i) || find(/win.*\.zip$/i);
  return find(/linux.*\.(AppImage|zip)$/i);
}

async function checkForUpdate() {
  const repo = ((settings.get().updates || {}).repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { configured: false, current: app.getVersion() };
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Enide' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const j = await res.json();
  const asset = pickUpdateAsset(j.assets);
  return {
    configured: true, current: app.getVersion(), latest: j.tag_name, available: semverGt(j.tag_name, app.getVersion()),
    required: app.isPackaged, page: j.html_url, url: asset ? asset.browser_download_url : j.html_url,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null, notes: String(j.body || '').slice(0, 4000),
  };
}

// Download the new version and install it:
//  macOS — unpack Enide.app next to the running one, swap them, relaunch;
//  Windows — run the installer (it closes this app and reopens the new one).
async function installUpdate(info) {
  const asset = info && info.asset;
  if (!asset) throw new Error('No file for this system in the release');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enide-update-'));
  const file = path.join(dir, asset.name);
  const res = await fetchImpl(asset.url, { headers: { 'user-agent': 'Enide', accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = asset.size || +res.headers.get('content-length') || 0;
  const out = fs.createWriteStream(file);
  let got = 0, last = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > 150) { last = Date.now(); send('update:progress', { got, total }); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  send('update:progress', { got, total, done: true });
  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));
  if (process.platform === 'darwin') {
    const current = path.resolve(process.execPath, '../../..'); // …/Enide.app
    if (!app.isPackaged || !current.endsWith('.app') || /\.dmg$/i.test(file)) { await shell.openPath(file); return { opened: file }; }
    const unpack = path.join(dir, 'unpacked');
    await run('/usr/bin/ditto', ['-x', '-k', file, unpack]);
    const fresh = fs.readdirSync(unpack).map((n) => path.join(unpack, n)).find((p) => p.endsWith('.app'));
    if (!fresh) throw new Error('Enide.app not found in the update');
    const old = current + '.old';
    await run('/bin/rm', ['-rf', old]);
    await run('/bin/mv', [current, old]);
    try { await run('/usr/bin/ditto', [fresh, current]); }
    catch (e) { await run('/bin/mv', [old, current]).catch(() => {}); throw new Error(`Cannot write ${current}: ${e.message}`); }
    await run('/usr/bin/xattr', ['-cr', current]).catch(() => {});
    await run('/bin/rm', ['-rf', old]).catch(() => {});
    setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { relaunching: true };
  }
  if (process.platform === 'win32' && /\.exe$/i.test(file)) {
    require('child_process').spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 800);
    return { installer: true };
  }
  await shell.openPath(file);
  return { opened: file };
}

// ---------- automations ----------
const scheduler = new Scheduler({
  getSettings: () => settings.get(),
  saveAutomation: (id, patch) => {
    const list = (settings.get().automations || []).map((a) => (a.id === id ? { ...a, ...patch } : a));
    settings.replace('automations', list);
    send('settings:changed', publicSettings());
  },
  runAutomation: (a) => new Promise((resolve) => {
    const { Notification } = require('electron');
    const done = ({ chatId, error }) => {
      scheduler.saveAutomation(a.id, { lastStatus: error ? 'error' : 'ok', lastError: error || null, lastChatId: chatId });
      try {
        const n = new Notification({ title: `Enide · ${a.name}`, body: error ? `Ошибка: ${error}`.slice(0, 200) : 'Готово — открыть чат' });
        n.on('click', () => { if (win) { win.show(); send('menu', 'open-chat', chatId); } });
        n.show();
      } catch {}
      send('chat:updated', chatId);
      resolve();
    };
    chats.create({ root: a.folder, title: `⏱ ${a.name}` }).then((chat) => {
      chat.automation = a.id;
      return chats.save(chat).then(() => agent.start({
        chatId: chat.id, text: a.prompt, title: `⏱ ${a.name}`, mode: a.mode || 'agent', root: a.folder, extraRoots: [],
        modelRef: a.modelRef || settings.get().defaultModel, reasoning: settings.get().reasoning,
        unattended: a.approval !== 'auto', policy: a.approval === 'auto' ? AUTO_POLICY : undefined, onDone: done,
      }));
    }).catch((e) => done({ chatId: null, error: e.message }));
  }),
});

function execP(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout, env: process.env, maxBuffer: 20 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error((err || e.message).trim())) : resolve(out))));
}

// Speech-to-text through a provider you configured (OpenAI/Groq-style /audio/transcriptions, or Gemini).
async function transcribe(buf, mimeType) {
  const s = settings.get();
  const v = s.voice || {};
  const providers = (s.providers || []).filter((p) => p.enabled !== false);
  const p = providers.find((x) => x.id === v.providerId)
    || providers.find((x) => ['openai', 'groq'].includes(x.preset) && secrets.has(x.id))
    || providers.find((x) => x.protocol === 'gemini' && secrets.has(x.id));
  if (!p) throw new Error('Voice input needs a speech-to-text provider: add OpenAI, Groq or Gemini in Settings → Providers and choose it in Settings → Voice. Tip: macOS Dictation (press Fn twice) works in any text field without setup.');
  const key = keyFor(p.id);
  const prompts = { ...DEFAULT_PROMPTS, ...(s.prompts || {}) };
  if (p.protocol === 'gemini') {
    const model = v.model || 'gemini-2.5-flash';
    const url = withQuery(joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`), p.query);
    const body = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: buf.toString('base64') } }, { text: prompts.transcribe }] }] };
    const id = logRequest({ kind: 'transcribe', url, method: 'POST', headers: {}, body, provider: p.name, model });
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(p, key), ...(p.headers || {}) }, body: JSON.stringify(body) });
    logRequest({ id, status: res.status });
    if (!res.ok) throw await readErrorBody(res);
    const j = await res.json();
    return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((x) => x.text || '').join('').trim();
  }
  const model = v.model || (p.preset === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1');
  const boundary = '----enide' + Date.now().toString(16);
  const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${mimeType.includes('wav') ? 'wav' : 'webm'}"\r\nContent-Type: ${mimeType}\r\n\r\n`), buf, Buffer.from('\r\n'),
    field('model', model),
  ];
  if (v.language) parts.push(field('language', v.language));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const url = withQuery(joinUrl(p.baseUrl, '/audio/transcriptions'), p.query);
  const id = logRequest({ kind: 'transcribe', url, method: 'POST', headers: {}, body: { model, file: `<audio · ${buf.length} bytes>`, language: v.language || undefined }, provider: p.name, model });
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...authHeaders(p, key), ...(p.headers || {}) }, body: Buffer.concat(parts) });
  logRequest({ id, status: res.status });
  if (!res.ok) throw await readErrorBody(res);
  const j = await res.json();
  return String(j.text || '').trim();
}

async function readImage(p) {
  const ext = path.extname(p).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  if (!types[ext]) throw new Error('Unsupported image type');
  const buf = await fsp.readFile(p);
  if (buf.length > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB');
  return { type: 'image', name: path.basename(p), mediaType: types[ext], data: buf.toString('base64') };
}

// What the agent gets when a file is attached: text inline, images as images,
// archives as a listing, anything else as a path it can inspect with its tools.
async function describeFile(p) {
  const st = await fsp.stat(p);
  const name = path.basename(p);
  if (st.isDirectory()) {
    const r = await tools.EXEC.list_dir({ path: p, depth: 3 }, { root: root || os.homedir() });
    return { kind: 'folder', path: p, name, content: r.output.slice(0, 20000) };
  }
  const ext = path.extname(p).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) && st.size <= 8 * 1024 * 1024) return { kind: 'image', ...(await readImage(p)), path: p };
  const runOut = (cmd, args) => new Promise((res) => require('child_process').execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (e, out) => res(e ? '' : String(out))));
  if (/\.(zip|jar|apk|ipa|xpi|docx|xlsx|pptx)$/i.test(name)) {
    const listing = await runOut('unzip', ['-l', p]);
    return { kind: 'archive', path: p, name, size: st.size, content: listing.slice(0, 30000) || '(could not list archive)' };
  }
  if (/\.(tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i.test(name)) {
    const listing = await runOut('tar', ['-tvf', p]);
    return { kind: 'archive', path: p, name, size: st.size, content: listing.slice(0, 30000) || '(could not list archive)' };
  }
  if (st.size <= 400 * 1024) {
    const r = await ws.readFile(p).catch(() => null);
    if (r && r.content != null) return { kind: 'text', path: p, name, size: st.size, content: r.content };
  }
  const info = await runOut('file', ['-b', p]);
  return { kind: 'binary', path: p, name, size: st.size, content: (info || 'binary file').trim() };
}

async function importMcpConfigs() {
  const home = os.homedir();
  const candidates = [
    { from: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { from: 'Claude Desktop', file: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
    { from: 'Claude Code', file: path.join(home, '.claude.json') },
    { from: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  ];
  if (root) candidates.push({ from: 'Project .cursor', file: path.join(root, '.cursor', 'mcp.json') }, { from: 'Project .mcp.json', file: path.join(root, '.mcp.json') });
  const found = [];
  for (const c of candidates) {
    let j;
    try { j = JSON.parse(await fsp.readFile(c.file, 'utf8')); } catch { continue; }
    const servers = j.mcpServers || (j.mcp && j.mcp.servers) || {};
    for (const [name, s] of Object.entries(servers)) {
      found.push({
        id: `${name}-${Math.random().toString(36).slice(2, 6)}`, name, from: c.from,
        type: s.url ? 'http' : 'stdio', command: s.command, args: s.args || [], env: s.env || {}, url: s.url, headers: s.headers || {}, enabled: true,
      });
    }
  }
  return found;
}

// ---------- lifecycle ----------
app.on('open-file', (e, p) => { e.preventDefault(); if (win) send('menu', 'open-path', p); else pendingOpen.push(p); });
app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const p = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a));
  if (p) send('menu', 'open-path', path.resolve(p));
});

app.whenReady().then(async () => {
  secrets = new SecretStore(USER, safeStorage);
  auth = new AuthStore({ dir: USER, safeStorage });
  await migrateToCustomModels();
  await migrateToSingleApi();
  const devIcon = path.join(APP_ROOT, 'build', 'icon.png');
  if (process.platform === 'darwin' && app.dock && !app.isPackaged && fs.existsSync(devIcon)) { try { app.dock.setIcon(devIcon); } catch {} }
  nativeTheme.themeSource = settings.get().theme === 'light' ? 'light' : settings.get().theme === 'system' ? 'system' : 'dark';
  protocol.handle('enide', serveFile);
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    if (permission === 'media' && process.platform === 'darwin' && (!details || !details.mediaTypes || details.mediaTypes.includes('audio'))) {
      systemPreferences.askForMediaAccess('microphone').then((ok) => cb(ok)).catch(() => cb(false));
      return;
    }
    cb(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  await loadShellEnv().catch(() => {});
  applyProxy();
  registerIpc();
  buildMenu();
  const argPath = process.argv.slice(DEV ? 2 : 1).find((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a));
  if (argPath) pendingOpen.push(path.resolve(argPath));
  createWindow();
  // Warm the vendor icon cache in the background so the model picker shows real icons right away.
  setTimeout(() => { for (const k of Object.keys(VENDORS)) vendorIcons.get(k).catch(() => {}); }, 2500);
  plugins.load().catch(() => {});
  configureMcp();
  scheduler.start();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('before-quit', () => {
  scheduler.stop();
  browser.close();
  agent.stopAll();
  terminals.killAll();
  tools.killAll();
  mcp.shutdown();
  watcher.close();
  settings.flush();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
