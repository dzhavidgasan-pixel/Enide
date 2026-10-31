// Loads electron/main.js against a stubbed "electron" module and exercises the IPC surface
// end-to-end (settings, workspace, agent run with streaming, protocol handler) — no Electron needed.
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startMockServer, anthropicStream } from './mock-llm-server.mjs';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enide-smoke-'));
const userData = path.join(tmp, 'userData');
const ws = path.join(tmp, 'project');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'export const x = 1;\n');
fs.writeFileSync(path.join(ws, 'AGENTS.md'), '- be nice\n');
execFileSync('git', ['init', '-q'], { cwd: ws });
const zip = path.join(tmp, 'bundle.zip');
try { execFileSync('zip', ['-q', '-j', zip, path.join(ws, 'AGENTS.md')]); } catch {}

const handlers = new Map();
const sent = [];
let readyResolve;
const whenReady = new Promise((r) => { readyResolve = r; });
let protocolHandler = null;
class BrowserWindow {
  constructor() { this.webContents = { send: (...a) => sent.push(a), setWindowOpenHandler() {}, on() {}, openDevTools() {}, toggleDevTools() {} }; BrowserWindow.last = this; }
  static getAllWindows() { return [BrowserWindow.last]; }
  loadURL() {} once() {} on() {} isDestroyed() { return false; } isMinimized() { return false; } isFullScreen() { return false; } getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; } isVisible() { return true; } show() {} hide() {} focus() {}
}
const electronStub = {
  app: { name: 'Enide', getPath: (k) => (k === 'userData' ? userData : k === 'desktop' ? tmp : tmp), whenReady: () => whenReady, on() {}, setName() {}, requestSingleInstanceLock: () => true, getLocale: () => 'ru-RU', getVersion: () => '0.1.0', addRecentDocument() {}, quit() {} },
  BrowserWindow,
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set('on:' + ch, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBoxSync: () => 1 },
  shell: { openExternal: async () => {}, showItemInFolder() {}, openPath: async () => '', trashItem: async (p) => fs.rmSync(p, { recursive: true, force: true }) },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
  protocol: { registerSchemesAsPrivileged() {}, handle: (s, fn) => { protocolHandler = fn; } },
  net: { fetch: (...a) => fetch(...a) },
  session: { defaultSession: { setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().replace(/^enc:/, '') },
  nativeTheme: { themeSource: 'dark' },
  systemPreferences: { askForMediaAccess: async () => true },
  Notification: class { on() {} show() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { if (req === 'electron') return 'electron-stub'; return origResolve.call(this, req, ...rest); };
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n    ', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e); }
}
const call = async (ch, ...args) => { const fn = handlers.get(ch); if (!fn) throw new Error('no handler ' + ch); const r = await fn({}, ...args); if (!r.ok) throw new Error(r.error); return r.data; };

console.log('\nelectron main (stubbed)');
const mock = await startMockServer();
require('../electron/main.js');
readyResolve();
await new Promise((r) => setTimeout(r, 300));

await test('account: gate, register, wrong password, recover with code word, session', async () => {
  await assert.rejects(call('ws:open', tmp), /Sign in/);
  let st = await call('auth:status');
  assert.equal(st.hasAccounts, false);
  await assert.rejects(call('auth:register', { nick: 'M', login: 'max', password: 'secret1', word: 'apple' }), /Ник/);
  await assert.rejects(call('auth:register', { nick: 'Max', login: 'Мax!', password: 'secret1', word: 'apple' }), /Логин/);
  const u = await call('auth:register', { nick: 'Max', login: 'MaxBerry', password: 'secret1', word: 'Green Apple' });
  assert.equal(u.login, 'maxberry');
  await call('auth:logout');
  await assert.rejects(call('auth:login', { login: 'maxberry', password: 'nope' }), /Неверный/);
  await assert.rejects(call('auth:recover', { login: 'maxberry', word: 'red', newPassword: 'secret2' }), /кодовое/);
  await call('auth:recover', { login: 'MAXBERRY', word: '  green   apple ', newPassword: 'secret2' });
  await call('auth:logout');
  await call('auth:login', { login: 'maxberry', password: 'secret2' });
  st = await call('auth:status');
  assert.equal(st.user.nick, 'Max');
  const raw = fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8');
  assert.ok(!raw.includes('secret2') && !raw.includes('green apple'), 'only hashes on disk');
});

await test('IPC handlers registered', () => {
  for (const ch of ['app:info', 'settings:get', 'settings:set', 'ws:open', 'agent:send', 'agent:preview', 'ai:inline', 'mcp:status', 'plugins:scaffold', 'requestlog:get', 'app:capture-screen', 'ai:transcribe', 'agent:turn-changes']) assert.ok(handlers.has(ch), ch);
});
await test('app:info + settings defaults (Z.ai preset)', async () => {
  const info = await call('app:info');
  assert.ok(info.presets.length > 15);
  assert.ok(info.defaultPrompts.agent.includes('You are Enide'));
  const s = await call('settings:get');
  assert.equal(s.settings.providers[0].id, 'zai');
  assert.equal(s.settings.providers[0].baseUrl, 'https://api.z.ai/api/anthropic');
});
await test('protocol serves renderer, blocks other paths', async () => {
  const ok = await protocolHandler({ url: 'enide://app/renderer/index.html' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  const bad = await protocolHandler({ url: 'enide://app/electron/main.js' });
  assert.equal(bad.status, 404);
  const trav = await protocolHandler({ url: 'enide://app/renderer/../package.json' });
  assert.equal(trav.status, 404);
});
await test('workspace: open, readdir, read, describe zip, rules, slash', async () => {
  const r = await call('ws:open', ws);
  assert.equal(r.root, ws);
  const list = await call('ws:readdir', ws);
  assert.ok(list.some((x) => x.name === 'src' && x.dir));
  const f = await call('ws:read', path.join(ws, 'src', 'a.js'));
  assert.match(f.content, /export const x/);
  if (fs.existsSync(zip)) {
    const d = await call('ws:describe-file', zip);
    assert.equal(d.kind, 'archive');
    assert.match(d.content, /AGENTS\.md/);
  }
  const rules = await call('rules:list');
  assert.equal(rules[0].source, 'AGENTS.md');
  const slash = await call('slash:list');
  assert.ok(slash.some((x) => x.name === 'init'));
  const files = await call('ws:list-files');
  assert.ok(files.includes('src/a.js'));
});
await test('settings:set saves providers + secret, preview shows rules', async () => {
  const s = (await call('settings:get')).settings;
  const p = { ...s.providers[0], baseUrl: mock.url + '/anthropic' };
  await call('settings:set', { providers: [p], agent: { policy: { ...s.agent.policy, write: 'auto' } } });
  const hint = await call('secrets:set', 'zai', 'sk-zai-0123456789abcdef');
  assert.ok(hint.includes('…'));
  const prev = await call('agent:preview', { mode: 'agent' });
  assert.match(prev.system, /<rules source="AGENTS.md">/);
  assert.ok(prev.tools.some((t) => t.name === 'run_command'));
});
await test('agent:send streams events to the window and edits a file', async () => {
  mock.scripts.anthropic.push(
    () => anthropicStream({ thinking: 'plan', signature: 'S', toolUse: [{ id: 'toolu_x', name: 'edit_file', input: { path: 'src/a.js', old_string: 'x = 1', new_string: 'x = 2' } }] }),
    () => anthropicStream({ text: 'done' }),
  );
  sent.length = 0;
  const runId = await call('agent:send', { text: 'bump x', mode: 'agent', modelRef: { providerId: 'zai', modelId: 'glm-5.2' }, reasoning: { enabled: true, effort: 'low' }, attachments: [{ type: 'file', path: path.join(ws, 'src/a.js'), content: 'export const x = 1;' }] });
  for (let i = 0; i < 100 && !sent.some((s) => s[0] === 'agent:event' && s[2].type === 'done'); i++) await new Promise((r) => setTimeout(r, 30));
  const evs = sent.filter((s) => s[0] === 'agent:event' && s[1] === runId).map((s) => s[2]);
  assert.equal(evs.find((e) => e.type === 'error'), undefined, (evs.find((e) => e.type === 'error') || {}).message);
  assert.ok(evs.some((e) => e.type === 'reasoning_delta'));
  assert.equal(fs.readFileSync(path.join(ws, 'src/a.js'), 'utf8'), 'export const x = 2;\n');
  assert.ok(sent.some((s) => s[0] === 'ws:file-changed'));
  const req = mock.requests.filter((r) => r.proto === 'anthropic').at(-2);
  assert.equal(req.headers['x-api-key'], 'sk-zai-0123456789abcdef');
  assert.match(req.body.messages[0].content[0].text, /<file path=/);
  const log = await call('requestlog:list');
  assert.ok(log.length >= 2 && log[0].status === 200);
  const full = await call('requestlog:get', log[0].id);
  assert.ok(full.body.messages);
  assert.ok(!JSON.stringify(full.headers).includes('0123456789abcdef'), 'key must be redacted');
  // review + undo the turn
  const startEv = evs.find((e) => e.type === 'run_start');
  const changes = await call('agent:turn-changes', startEv.chatId, startEv.userMessage.id);
  assert.equal(changes[0].before, 'export const x = 1;\n');
  assert.equal(changes[0].after, 'export const x = 2;\n');
  const r = await call('agent:restore', startEv.chatId, startEv.userMessage.id, { truncate: false });
  assert.equal(r.restored.length, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'src/a.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(r.text, 'bump x');
  assert.equal(r.attachments.length, 1, 'attachment comes back with the restored question');
  assert.match(r.attachments[0].text, /<file path=.*a\.js">\nexport const x = 1;/);
  const chats = await call('chat:list', ws);
  assert.equal(chats.length, 1);
});
await test('inline edit + autocomplete use visible prompts', async () => {
  mock.scripts.anthropic.push(() => anthropicStream({ text: '```js\nconst y = 3;\n```' }), () => anthropicStream({ text: '42;' }));
  const out = await call('ai:inline', { id: 'i1', path: 'a.js', language: 'javascript', prefix: '', selection: 'const y = 1;', suffix: '', instruction: 'set to 3' });
  assert.equal(out, 'const y = 3;');
  const c = await call('ai:complete', { path: 'a.js', language: 'javascript', prefix: 'const z = ', suffix: '' });
  assert.equal(c, '42;');
  const last = mock.requests.filter((r) => r.proto === 'anthropic').at(-1);
  assert.match(last.body.system[0].text, /code completion engine/);
});
await test('plugins: scaffold → tool listed → callable from agent tool host', async () => {
  const r = await call('plugins:scaffold', 'Demo Plugin');
  assert.ok(fs.existsSync(path.join(r.folder, 'index.js')));
  const st = await call('plugins:status');
  assert.equal(st[0].tools.length, 1);
  const cmds = await call('plugins:commands');
  const res = await call('plugins:run-command', cmds[0].id);
  assert.match(res.message, /Hello/);
  const prev = await call('agent:preview', { mode: 'agent' });
  assert.ok(prev.tools.some((t) => t.name.startsWith('plugin__demo_plugin__word_count')));
  const sl = await call('slash:list');
  assert.ok(sl.some((x) => x.name === 'explain-simply'));
});
await test('git status on fresh repo', async () => {
  const g = await call('git:status');
  assert.equal(g.repo, true);
  assert.ok(g.unstaged.some((e) => e.rel === 'src/a.js'));
});

await test('terminal: create, write, receive output', async () => {
  sent.length = 0;
  const t = await call('term:create', { id: 'T1', cols: 80, rows: 24 });
  assert.ok(t.kind === 'pty' || t.kind === 'script');
  await new Promise((r) => setTimeout(r, 600));
  handlers.get('on:term:write')({}, 'T1', 'echo enide-$((40+2))\n');
  let out = '';
  for (let i = 0; i < 60 && !/enide-42/.test(out); i++) { await new Promise((r) => setTimeout(r, 50)); out = sent.filter((x) => x[0] === 'term:data' && x[1] === 'T1').map((x) => x[2]).join(''); }
  assert.match(out, /enide-42/);
  await call('term:kill', 'T1');
});

await test('worktree chat: agent edits in its own checkout, apply brings changes back', async () => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: ws });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: ws });
  mock.scripts.anthropic.push(
    () => anthropicStream({ toolUse: [{ id: 'toolu_w', name: 'write_file', input: { path: 'wt.txt', content: 'from worktree\n' } }] }),
    () => anthropicStream({ text: 'done in worktree' }),
  );
  sent.length = 0;
  const runId = await call('agent:send', { text: 'make wt.txt', mode: 'agent', worktree: true, modelRef: { providerId: 'zai', modelId: 'glm-5.2' } });
  for (let i = 0; i < 100 && !sent.some((x) => x[0] === 'agent:event' && x[1] === runId && x[2].type === 'done'); i++) await new Promise((r) => setTimeout(r, 30));
  const start = sent.find((x) => x[0] === 'agent:event' && x[1] === runId && x[2].type === 'run_start')[2];
  assert.equal(fs.existsSync(path.join(ws, 'wt.txt')), false, 'main checkout untouched');
  const st = await call('wt:status', start.chatId);
  assert.ok(st.files.some((f) => f.rel === 'wt.txt'));
  const r = await call('wt:apply', start.chatId);
  assert.equal(r.applied, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'wt.txt'), 'utf8'), 'from worktree\n');
  await call('wt:discard', start.chatId);
  assert.equal(fs.existsSync(st.path), false);
});
await test('semantic index: build with embeddings and search', async () => {
  const s = (await call('settings:get')).settings;
  const emb = { id: 'emb', preset: 'custom-openai', name: 'Emb', protocol: 'openai', baseUrl: mock.url + '/openai/v1', authStyle: 'bearer', headers: {}, enabled: true, models: [] };
  await call('settings:set', { providers: [...s.providers, emb], index: { enabled: true, providerId: 'emb', model: 'test-embed' } });
  fs.writeFileSync(path.join(ws, 'src', 'payments.js'), 'export function refundPayment(order) {\n  // refund the customer payment through stripe\n  return stripe.refunds.create({ charge: order.charge });\n}\n');
  await call('index:build', true);
  let st;
  for (let i = 0; i < 100; i++) { st = await call('index:status'); if (st.state === 'ready') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.state, 'ready');
  assert.ok(st.chunks >= 1 && st.files >= 1);
  const hits = await call('index:search', 'refund customer payment stripe');
  assert.match(hits.split('\n')[0], /payments\.js/);
});
await test('docs: crawl site, search, @Docs attachment resolves passages', async () => {
  const e = await call('docs:add', { name: 'widgets', url: mock.url + '/site/docs/', maxPages: 10 });
  let list;
  for (let i = 0; i < 100; i++) { list = await call('docs:list'); if (list.find((x) => x.id === e.id).status !== 'crawling') break; await new Promise((r) => setTimeout(r, 50)); }
  const d = list.find((x) => x.id === e.id);
  assert.equal(d.status, 'ready', d.error);
  assert.equal(d.pages, 2);
  mock.scripts.anthropic.push((body) => { assert.match(JSON.stringify(body.messages), /widget\.paint/); assert.ok(body.tools.some((t) => t.name === 'docs_search')); return anthropicStream({ text: 'use paint' }); });
  sent.length = 0;
  const runId = await call('agent:send', { text: 'how to change widget color', mode: 'ask', attachments: [{ type: 'docs', name: 'widgets' }], modelRef: { providerId: 'zai', modelId: 'glm-5.2' } });
  for (let i = 0; i < 100 && !sent.some((x) => x[0] === 'agent:event' && x[1] === runId && x[2].type === 'done'); i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(!sent.some((x) => x[0] === 'agent:event' && x[2].type === 'error'), JSON.stringify(sent.filter((x) => x[2] && x[2].type === 'error')));
});
await test('review bot returns findings with absolute paths', async () => {
  fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'export const x = 1;\nexport const y = JSON.parse(input);\n');
  mock.scripts.anthropic.push((b) => { assert.match(b.system[0].text, /code reviewer/); assert.match(b.messages[0].content[0].text, /JSON\.parse\(input\)/); return anthropicStream({ text: '```json\n[{"file":"src/a.js","line":2,"severity":"error","title":"input undefined","body":"input is not defined"}]\n```' }); });
  const items = await call('review:run');
  assert.equal(items[0].file, path.join(ws, 'src', 'a.js'));
  assert.equal(items[0].severity, 'error');
});
await test('usage, chat fork/search/pin, context breakdown, memory, themes', async () => {
  const u = await call('usage:summary', 7);
  assert.ok(u.totals.today.requests >= 3);
  const list = await call('chat:list', ws);
  const c = await call('chat:get', list.find((x) => x.count > 2).id);
  const f = await call('chat:fork', c.id, c.messages[0].id, { inclusive: false });
  assert.equal(f.chat.messages.length, 0);
  assert.ok(f.prefill.length > 0);
  const found = await call('chat:search', 'bump');
  assert.ok(found.length >= 1);
  await call('chat:pin', found[0].id, true);
  assert.equal((await call('chat:list', ws))[0].id, found[0].id);
  const br = await call('agent:context', c.id, { mode: 'agent' });
  assert.ok(br.parts.tools > 0 && br.window > 0);
  await call('memory:save', 'project', '- uses tabs\n');
  const mem = await call('memory:get');
  assert.equal(mem.project.text, '- uses tabs\n');
  const themeFile = path.join(tmp, 'theme.json');
  fs.writeFileSync(themeFile, '{ // comment\n "name": "Test", "type": "dark", "colors": { "editor.background": "#101010", "terminal.ansiRed": "#ff0000" }, "tokenColors": [ { "scope": ["comment"], "settings": { "foreground": "#888888", "fontStyle": "italic" } }, { "scope": "keyword.control", "settings": { "foreground": "#ff00ff" } }, ], }');
  const th = await call('themes:load', themeFile, 'vs-dark');
  assert.equal(th.data.colors['editor.background'], '#101010');
  assert.ok(th.data.rules.some((r) => r.token === 'comment' && r.foreground === '888888'));
  assert.equal(th.terminal.red, '#ff0000');
});
await test('lint:run and hooks:list', async () => {
  fs.writeFileSync(path.join(ws, 'bad.js'), 'let = ;\n');
  const r = await call('lint:run', ['bad.js']);
  assert.ok(r.items.length >= 1);
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'true' }] }] } }));
  const hk = await call('hooks:list');
  assert.equal(hk[0].source, '.claude/settings.json');
});

await mock.close();
for (const fn of handlers.values()) void fn;
console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
