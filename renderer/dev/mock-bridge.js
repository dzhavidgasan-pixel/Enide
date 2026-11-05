// Mock of the Electron bridge so the UI can be previewed and tested in a plain browser.
// Not used inside the app.
const VENDORS = { anthropic: { name: 'Anthropic', domain: 'anthropic.com' }, openai: { name: 'OpenAI', domain: 'openai.com' }, moonshot: { name: 'Moonshot · Kimi', domain: 'kimi.com' }, zai: { name: 'Z.ai · GLM', domain: 'z.ai' }, deepseek: { name: 'DeepSeek', domain: 'deepseek.com' } };
const custom = (id, modelId, name, baseUrl, protocol, extra = {}) => ({ id, preset: 'custom', name, protocol, baseUrl, authStyle: protocol === 'anthropic' ? 'both' : 'bearer', headers: {}, enabled: true, streamUsage: true, maxTokensField: 'max_tokens',
  models: [{ id: modelId, name, contextWindow: 200000, maxOutput: 32000, vision: false, tools: true, reasoningStyle: protocol === 'anthropic' ? 'anthropic-budget' : 'thinking-object', enabled: true, custom: true, extraBody: {}, ...extra }] });
const ROOT = '/Users/you/Projects/light-app';
const listeners = new Map();
let mockUser = null;
const fire = (ch, ...a) => (listeners.get(ch) || []).forEach((cb) => cb(...a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = {
  'package.json': '{\n  "name": "light-app",\n  "version": "1.0.0",\n  "scripts": { "dev": "vite", "test": "vitest" }\n}\n',
  'README.md': '# Light app\n\nDemo project.\n',
  'AGENTS.md': '- Use TypeScript strict mode\n- Prefer small pure functions\n',
  'src/main.ts': "import { greet } from './lib/greet';\n\nconst app = document.querySelector('#app');\napp!.textContent = greet('world');\n",
  'src/lib/greet.ts': "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n",
  'src/styles.css': 'body { background: #000; color: #fff; }\n',
  'tests/greet.test.ts': "import { greet } from '../src/lib/greet';\ntest('greets', () => expect(greet('x')).toBe('Hello, x!'));\n",
  'index.html': '<!doctype html>\n<div id="app"></div>\n<script type="module" src="/src/main.ts"></script>\n',
};

const providers = [
  custom('zai', 'glm-5.2', 'GLM-5.2', 'https://api.z.ai/api/anthropic', 'anthropic', { contextWindow: 1000000 }),
  custom('kimi', 'kimi-k3', 'Kimi K3', 'https://api.moonshot.ai/v1', 'openai', { contextWindow: 1048576, vision: true, reasoningStyle: 'kimi-effort' }),
  custom('ds', 'deepseek-v4-pro', '', 'https://api.deepseek.com', 'openai', { reasoningStyle: 'none' }),
];

let settings = {
  version: 1, language: (typeof location !== 'undefined' && /lang=en/.test(location.search)) ? 'en' : 'ru', theme: /theme=light/.test(location.search) ? 'light' : 'dark', starfield: true, providers,
  defaultModel: { providerId: 'zai', modelId: 'glm-5.2' }, reasoning: { enabled: true, effort: 'high' },
  autocomplete: { enabled: true, debounceMs: 350 }, inlineEdit: { model: null }, commitModel: null,
  agent: { maxSteps: 80, checkpoints: true, autoOpenEdits: true, computerUse: false, policy: { write: 'auto', writeOutside: 'ask', readOutside: 'auto', command: 'ask', allowList: ['ls', 'git status', 'npm test'], denyList: ['rm -rf /', 'sudo '], allowChained: false, network: 'auto', computer: 'ask', mcp: 'ask', plugins: 'ask' }, tools: {} },
  prompts: {}, rules: { global: '', useProjectFiles: true, disabledFiles: [] },
  editor: { fontSize: 13, fontFamily: 'Menlo, monospace', tabSize: 2, wordWrap: 'off', minimap: false, autoSave: 'off', lineHeight: 20 },
  router: {}, index: { enabled: true, providerId: 'kimi', model: 'text-embedding-3-small' }, automations: [{ id: 'a1', name: 'Ночные тесты', enabled: true, folder: ROOT, prompt: 'Прогони тесты и почини падения.', mode: 'agent', approval: 'safe', schedule: { type: 'daily', time: '09:00', days: [1,2,3,4,5] }, lastRun: Date.now() - 864e5, lastStatus: 'ok' }], hooks: { enabled: true }, keybindings: {}, updates: { repo: 'dzhavidgasan-pixel/Enide' },
  terminal: { fontSize: 12 }, mcpServers: [{ id: 'pw', name: 'Playwright', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: true }],
  plugins: { disabled: [] }, network: { proxy: '' }, voice: {}, recent: [ROOT, '/Users/you/Projects/enicloud', '/Users/you/Desktop/bot'],
  layout: { sidebar: true, panel: /panel=1/.test(location.search), agent: true, sidebarWidth: 250, agentWidth: 430, panelHeight: 220 },
  lastWorkspace: /welcome=1/.test(location.search) ? null : ROOT,
};

const DEFAULT_PROMPTS = {
  agent: "You are Enide, an AI coding agent working inside the user's IDE on macOS. You have tools to read and search the workspace, edit files, and run terminal commands on the user's machine.\n\nEnvironment\n- Workspace: {{workspace}}\n- OS: {{os}} · Shell: {{shell}}\n- Date: {{date}}\n\nHow to work\n- Explore before changing…{{rules}}",
  ask: 'You are Enide… (ask)', plan: 'You are Enide… (plan)', inlineEditSystem: 'You edit code…', inlineEditUser: 'File: {{path}}…', autocompleteSystem: 'You are a code completion engine…', autocompleteUser: '{{prefix}}<CURSOR>{{suffix}}', commitSystem: 'Write a git commit message…', terminalSystem: 'Turn the request into a shell command…', transcribe: 'Transcribe this audio…', titleSystem: '…',
};
const TOOL_DEFS = ['list_dir', 'read_file', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'run_command', 'check_process', 'web_fetch', 'web_search', 'todo_write'].map((n) => ({ name: n, description: `Built-in tool ${n}.`, parameters: { type: 'object', properties: { path: { type: 'string' } } } }));

const HISTORY = {
  id: 'chat_1', title: 'Добавь тест для greet и почини падение', created: Date.now() - 3600e3, updated: Date.now() - 600e3, root: ROOT,
  messages: [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '', attachment: { kind: 'file', path: ROOT + '/src/lib/greet.ts' } }, { type: 'text', text: 'Добавь проверку пустого имени и прогони тесты' }] },
    { id: 'a1', role: 'assistant', meta: { modelId: 'glm-5.2', usage: { input: 5210, output: 412, cacheRead: 0 }, ms: 6200 }, content: [
      { type: 'reasoning', text: 'Нужно посмотреть greet.ts, затем добавить ветку для пустой строки и обновить тест. После — запустить npm test.', ms: 3100 },
      { type: 'text', text: 'Сначала посмотрю функцию и тест.' },
      { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'src/lib/greet.ts' } },
      { type: 'tool_call', id: 't2', name: 'edit_file', args: { path: 'src/lib/greet.ts', old_string: '  return', new_string: '  if (!name.trim()) return "Hello!";\n  return' } },
    ] },
    { id: 'tr1', role: 'tool', content: [
      { type: 'tool_result', id: 't1', name: 'read_file', output: '1│export function greet(name: string) {\n2│  return `Hello, ${name}!`;\n3│}', display: { path: ROOT + '/src/lib/greet.ts', lines: 3 } },
      { type: 'tool_result', id: 't2', name: 'edit_file', output: 'Edited', display: { kind: 'diff', path: ROOT + '/src/lib/greet.ts', added: 1, removed: 0, hunks: [{ aStart: 1, bStart: 1, lines: [{ t: ' ', s: 'export function greet(name: string) {' }, { t: '+', s: "  if (!name.trim()) return 'Hello!';" }, { t: ' ', s: '  return `Hello, ${name}!`;' }, { t: ' ', s: '}' }] }] } },
    ] },
    { id: 'a2', role: 'assistant', meta: { modelId: 'glm-5.2', usage: { input: 6020, output: 180 }, ms: 2400 }, content: [
      { type: 'tool_call', id: 't3', name: 'run_command', args: { command: 'npm test' } },
    ] },
    { id: 'tr2', role: 'tool', content: [{ type: 'tool_result', id: 't3', name: 'run_command', output: 'Exit code: 0', display: { kind: 'command', command: 'npm test', cwd: ROOT, exitCode: 0, output: '> light-app@1.0.0 test\n> vitest run\n\n ✓ tests/greet.test.ts (2)\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n' } }] },
    { id: 'a3', role: 'assistant', meta: { modelId: 'glm-5.2', usage: { input: 6400, output: 120 }, ms: 1800 }, content: [
      { type: 'text', text: 'Готово:\n\n- `src/lib/greet.ts:2` — пустое имя теперь возвращает `Hello!`\n- тесты проходят (**2 passed**)\n\n```ts\ngreet(\'  \') // → "Hello!"\n```' },
    ] },
  ],
};

const reqlog = [];

async function simulateRun(params) {
  const runId = 'run_' + Date.now();
  const emit = (ev) => fire('agent:event', runId, ev);
  if (/исследуй|subagent/i.test(params.text || '')) {
    setTimeout(async () => {
      emit({ type: 'run_start', chatId: 'chat_sub', title: params.text.slice(0, 40), userMessage: { id: 'u_s', role: 'user', content: [{ type: 'text', text: params.text }] } });
      emit({ type: 'assistant_start', messageId: 'm1' });
      for (const w of 'Запущу двух субагентов параллельно.'.split(' ')) { emit({ type: 'text_delta', text: w + ' ' }); await sleep(20); }
      emit({ type: 'tool_call', call: { id: 'T1', name: 'task', args: { description: 'Как устроена авторизация', prompt: '…', type: 'explore' } } });
      emit({ type: 'tool_call', call: { id: 'T2', name: 'task', args: { description: 'Где хранятся сессии', prompt: '…', type: 'explore' } } });
      emit({ type: 'assistant_end', messageId: 'm1', usage: { input: 3000, output: 120 }, ms: 900 });
      for (const T of ['T1', 'T2']) emit({ type: 'tool_running', callId: T });
      await sleep(200);
      emit({ type: 'tool_call', parent: 'T1', call: { id: 'T1a', name: 'grep', args: { pattern: 'login|session' } } });
      emit({ type: 'tool_result', parent: 'T1', callId: 'T1a', output: 'src/auth.ts:12:export function login', display: null });
      emit({ type: 'tool_call', parent: 'T2', call: { id: 'T2a', name: 'semantic_search', args: { query: 'session storage' } } });
      emit({ type: 'tool_result', parent: 'T2', callId: 'T2a', output: '── src/session.ts:1-40', display: null });
      emit({ type: 'tool_call', parent: 'T1', call: { id: 'T1b', name: 'read_file', args: { path: 'src/auth.ts' } } });
      emit({ type: 'text_delta', parent: 'T1', text: 'Читаю src/auth.ts, проверяю login()…' });
      emit({ type: 'tool_result', parent: 'T1', callId: 'T1b', output: '1│export function login', display: { lines: 88 } });
      await sleep(200);
      emit({ type: 'tool_result', callId: 'T1', output: '**Авторизация**: `src/auth.ts:12` — login() проверяет пароль через bcrypt и выдаёт JWT.', display: { kind: 'subagent', type: 'explore', toolCount: 2 } });
      if (!/live/.test(location.search)) emit({ type: 'tool_result', callId: 'T2', output: 'Сессии в Redis: `src/session.ts:20`.', display: { kind: 'subagent', type: 'explore', toolCount: 1 } });
      emit({ type: 'tool_call', call: { id: 'L1', name: 'read_lints', args: { paths: ['src/auth.ts'] } } });
      emit({ type: 'tool_result', callId: 'L1', output: '1 problem', display: { kind: 'problems', ran: ['tsc'], items: [{ file: ROOT + '/src/main.ts', line: 4, col: 1, severity: 'error', code: 'TS2531', message: "Object is possibly 'null'.", source: 'tsc' }] } });
      emit({ type: 'compacting' });
      await sleep(100);
      emit({ type: 'compacted', summary: '- Пользователь просил разобрать авторизацию\n- Найдены src/auth.ts и src/session.ts', coveredMessages: 12 });
      emit({ type: 'assistant_start', messageId: 'm2' });
      for (const w of 'Итог: логин в `src/auth.ts:12`, сессии в Redis.'.split(' ')) { emit({ type: 'text_delta', text: w + ' ' }); await sleep(15); }
      emit({ type: 'assistant_end', messageId: 'm2', usage: { input: 4100, output: 90 }, ms: 700 });
      if (!/live/.test(location.search)) emit({ type: 'done', chatId: 'chat_sub' });
    }, 50);
    return runId;
  }
  setTimeout(async () => {
    const chatId = params.chatId || 'chat_new';
    emit({ type: 'run_start', chatId, title: (params.text || '').slice(0, 50), userMessage: { id: 'um' + Date.now(), role: 'user', content: [...(params.attachments || []).filter((a) => a.type === 'image').map((a) => ({ type: 'image', mediaType: a.mediaType, data: a.data })), { type: 'text', text: params.text }] } });
    emit({ type: 'assistant_start', messageId: 'm1' });
    if (params.reasoning && params.reasoning.enabled) {
      emit({ type: 'reasoning_start' });
      for (const w of 'Пользователь просит обновить стили. Посмотрю styles.css и добавлю переменные темы, затем проверю сборку.'.split(' ')) { emit({ type: 'reasoning_delta', text: w + ' ' }); await sleep(35); }
      emit({ type: 'reasoning_end', ms: 2100 });
    }
    for (const w of 'Обновлю стили и проверю сборку.'.split(' ')) { emit({ type: 'text_delta', text: w + ' ' }); await sleep(40); }
    emit({ type: 'tool_preparing', callId: 'c1', name: 'edit_file' });
    await sleep(200);
    emit({ type: 'tool_call', call: { id: 'c1', name: 'edit_file', args: { path: 'src/styles.css', old_string: 'body', new_string: ':root' } } });
    emit({ type: 'tool_running', callId: 'c1' });
    await sleep(200);
    emit({ type: 'tool_result', callId: 'c1', output: 'Edited', display: { kind: 'diff', path: ROOT + '/src/styles.css', added: 3, removed: 1, hunks: [{ aStart: 1, bStart: 1, lines: [{ t: '-', s: 'body { background: #000; color: #fff; }' }, { t: '+', s: ':root { --bg: #000; --fg: #fff; }' }, { t: '+', s: 'body { background: var(--bg);' }, { t: '+', s: '       color: var(--fg); }' }] }] } });
    emit({ type: 'usage', usage: { input: 8200, output: 300 } });
    emit({ type: 'assistant_end', messageId: 'm1', usage: { input: 8200, output: 300 }, ms: 3000 });
    emit({ type: 'assistant_start', messageId: 'm2' });
    emit({ type: 'tool_preparing', callId: 'c2', name: 'run_command' });
    emit({ type: 'tool_call', call: { id: 'c2', name: 'run_command', args: { command: 'npm run build' } } });
    emit({ type: 'approval_request', callId: 'c2', name: 'run_command', args: { command: 'npm run build' }, reason: 'command', allowKey: 'run_command:npm run', preview: { kind: 'command', command: 'npm run build', cwd: ROOT } });
    pendingApproval = async (d) => {
      if (d.action === 'reject') { emit({ type: 'tool_result', callId: 'c2', output: 'The user rejected this tool call.', isError: true, rejected: true }); }
      else {
        emit({ type: 'tool_running', callId: 'c2' });
        let out = '';
        for (const l of ['> light-app@1.0.0 build', '> vite build', '', 'vite v7.1.2 building for production...', '✓ 14 modules transformed.', 'dist/index.html   0.41 kB', 'dist/assets/index.js  4.12 kB │ gzip: 1.9 kB', '✓ built in 412ms']) { out += l + '\n'; emit({ type: 'tool_output', callId: 'c2', text: out }); await sleep(120); }
        emit({ type: 'tool_result', callId: 'c2', output: 'Exit code: 0\n' + out, display: { kind: 'command', command: 'npm run build', cwd: ROOT, exitCode: 0, output: out } });
      }
      emit({ type: 'assistant_end', messageId: 'm2', usage: { input: 9100, output: 80 }, ms: 1200 });
      emit({ type: 'assistant_start', messageId: 'm3' });
      for (const w of 'Готово. Стили переведены на **CSS-переменные**, сборка проходит: `dist/` обновлён.'.split(' ')) { emit({ type: 'text_delta', text: w + ' ' }); await sleep(30); }
      emit({ type: 'assistant_end', messageId: 'm3', usage: { input: 9500, output: 60 }, ms: 900 });
      emit({ type: 'done', chatId });
    };
    if (/autoapprove/.test(location.search)) setTimeout(() => pendingApproval({ action: 'allow' }), 300);
  }, 50);
  return runId;
}
let pendingApproval = null;

const HANDLERS = {
  'auth:status': () => ({ hasAccounts: !/auth=register/.test(location.search), user: /auth=/.test(location.search) ? mockUser : (mockUser = mockUser || { id: 'u1', nick: 'Max Berry', login: 'maxberry', created: Date.now() - 86400000 * 3 }) }),
  'auth:login': ({ login, password }) => { if (password !== 'secret1') { const e = new Error('Неверный логин или пароль'); e.code = 'credentials'; e.field = 'password'; throw e; } return (mockUser = { id: 'u1', nick: 'Max Berry', login: login.toLowerCase(), created: Date.now() }); },
  'auth:register': ({ nick, login }) => (mockUser = { id: 'u1', nick, login: String(login).toLowerCase(), created: Date.now() }),
  'auth:recover': ({ login }) => (mockUser = { id: 'u1', nick: 'Max Berry', login, created: Date.now() }),
  'auth:logout': () => { mockUser = null; return true; },
  'auth:update': ({ nick }) => (mockUser = { ...mockUser, nick }),
  'auth:change-password': () => true,
  'auth:change-word': () => true,
  'providers:custom': ({ baseUrl = '', protocol } = {}) => custom('m' + Date.now().toString(36), '', '', baseUrl, protocol || (/anthropic/.test(baseUrl) ? 'anthropic' : 'openai')),
  'providers:normalize': (m) => ({ contextWindow: 128000, maxOutput: 8192, vision: false, tools: true, reasoningStyle: 'none', enabled: true, extraBody: {}, ...m }),
  'update:check': () => (/update=1/.test(location.search) ? { configured: true, available: true, required: true, current: '1.0.0', latest: 'v1.1.0', page: '#', asset: { name: 'Enide-mac-arm64.zip', size: 125e6, url: '#' }, notes: '- Свои модели: ID, адрес и ключ\n- Проще интерфейс и крупнее кнопки\n- Обновление прямо из приложения' } : { configured: true, available: false, current: '1.1.0' }),
  'update:install': async () => { for (let i = 1; i <= 20; i++) { await sleep(60); fire('update:progress', { got: i * 6.25e6, total: 125e6, done: i === 20 }); } await sleep(300); return { relaunching: true }; },
  'icons:get': () => null,
  'icons:refresh': () => ({ ok: 0, total: Object.keys(VENDORS).length, missing: [] }),
  'app:info': () => ({ version: '0.1.0', platform: 'darwin', arch: 'arm64', home: '/Users/you', hasPty: true, encryption: true, locale: 'ru-RU', userData: '/Users/you/Library/Application Support/Enide',
    vendors: VENDORS, presets: [{ preset: 'moonshot', name: 'Moonshot · Kimi', protocol: 'openai' }, { preset: 'anthropic', name: 'Anthropic', protocol: 'anthropic' }, { preset: 'openai', name: 'OpenAI', protocol: 'openai' }, { preset: 'openai-responses', name: 'OpenAI · Responses API', protocol: 'openai-responses' }, { preset: 'gemini', name: 'Google Gemini', protocol: 'gemini' }, { preset: 'openrouter', name: 'OpenRouter', protocol: 'openai' }, { preset: 'zai-anthropic', name: 'Z.ai GLM (Anthropic API)', protocol: 'anthropic' }, { preset: 'deepseek', name: 'DeepSeek', protocol: 'openai' }, { preset: 'ollama', name: 'Ollama (local)', protocol: 'openai' }],
    defaultPrompts: DEFAULT_PROMPTS, defaultPolicy: settings.agent.policy, toolDefs: TOOL_DEFS, pendingOpen: [],
    mcpCatalog: [{ key: 'playwright', name: 'Playwright', description: 'Drive a real browser', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, { key: 'context7', name: 'Context7', description: 'Up-to-date library docs', type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, { key: 'github', name: 'GitHub', description: 'Issues, PRs, code search', type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: {} }] }),
  'settings:get': () => ({ settings, keyHints: { zai: 'sk-a…9f2c' } }),
  'settings:set': (patch) => {
    const merge = (a, b) => { if (!b || typeof b !== 'object' || Array.isArray(b)) return b; const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v; return o; };
    if (patch.__replace) { for (const k of patch.__replace) settings[k] = patch[k]; }
    const p = { ...patch }; delete p.__replace;
    settings = merge(settings, p);
    return { settings, keyHints: { zai: 'sk-a…9f2c' } };
  },
  'secrets:set': () => 'sk-a…9f2c',
  'ws:open': (r) => ({ root: r, name: r.split('/').pop() }),
  'ws:exists': () => true,
  'ws:readdir': (dir) => {
    if (!dir.startsWith(ROOT)) throw new Error('not a dir');
    const rel = dir === ROOT ? '' : dir.slice(ROOT.length + 1) + '/';
    if (rel && !Object.keys(FILES).some((f) => f.startsWith(rel))) throw new Error('not a dir');
    const names = new Map();
    for (const f of Object.keys(FILES)) if (f.startsWith(rel)) { const rest = f.slice(rel.length); const [first, ...more] = rest.split('/'); names.set(first, more.length > 0); }
    if (!rel) { names.set('node_modules', true); names.set('.git', true); }
    return [...names.entries()].map(([name, isDir]) => ({ name, path: ROOT + '/' + rel + name, dir: isDir, ignored: ['node_modules', '.git'].includes(name) })).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  },
  'ws:read': (p) => ({ content: FILES[p.slice(ROOT.length + 1)] || '', mtime: Date.now() }),
  'ws:write': (p, c) => { FILES[p.slice(ROOT.length + 1)] = c; return { mtime: Date.now() }; },
  'ws:list-files': () => Object.keys(FILES),
  'ws:describe-file': (p) => (/\.(zip|7z|rar)$/.test(p) ? { kind: 'archive', path: p, name: p.split('/').pop(), size: 12000, content: 'Archive: x.zip\n  Length  Name\n     120  a.txt' } : { kind: 'text', path: p, name: p.split('/').pop(), content: FILES[p.slice(ROOT.length + 1)] || '' }),
  'git:status-x': () => null,
  'ws:search': ({ query }) => ({ total: 2, results: [{ file: ROOT + '/src/lib/greet.ts', rel: 'src/lib/greet.ts', matches: [{ line: 1, col: 17, length: query.length, text: 'export function greet(name: string) {' }] }, { file: ROOT + '/src/main.ts', rel: 'src/main.ts', matches: [{ line: 1, col: 10, length: query.length, text: "import { greet } from './lib/greet';" }] }] }),
  'git:status': () => ({ repo: true, top: ROOT, branch: 'main', ahead: 1, behind: 0, staged: [], conflicts: [], unstaged: [{ path: ROOT + '/src/lib/greet.ts', rel: 'src/lib/greet.ts', code: 'M' }, { path: ROOT + '/src/styles.css', rel: 'src/styles.css', code: 'M' }, { path: ROOT + '/tests/new.test.ts', rel: 'tests/new.test.ts', code: 'U?' }] }),
  'git:diff': () => ({ original: 'a\nb\n', modified: 'a\nB\n' }),
  'chat:list': () => [{ id: 'chat_1', title: HISTORY.title, updated: HISTORY.updated }, { id: 'chat_2', title: 'Почему падает сборка на CI?', updated: Date.now() - 86400e3 }],
  'chat:get': (id) => (id === 'chat_1' ? HISTORY : { id, title: 'Почему падает сборка на CI?', messages: [] }),
  'agent:send': (p) => simulateRun(p),
  'agent:approve': (_r, _c, d) => { if (pendingApproval) { const f = pendingApproval; pendingApproval = null; f(d); } return true; },
  'agent:stop': () => true,
  'agent:preview': () => ({ system: DEFAULT_PROMPTS.agent.replace('{{rules}}', '\n\nRules\n<rules source="AGENTS.md">\n- Use TypeScript strict mode\n</rules>'), tools: TOOL_DEFS.map((x) => ({ ...x, source: 'builtin' })), model: { provider: 'Z.ai', protocol: 'anthropic', model: providers[0].models[0] } }),
  'slash:list': () => [{ name: 'init', description: 'Create or update AGENTS.md', prompt: 'Explore… $ARGUMENTS', source: 'builtin' }, { name: 'review', description: 'Review uncommitted changes', prompt: 'Review… $ARGUMENTS', source: 'builtin' }, { name: 'test', description: 'Run tests and fix failures', prompt: '…', source: 'builtin' }],
  'mcp:status': () => [{ id: 'pw', name: 'Playwright', status: 'ready', tools: [{ name: 'browser_navigate' }, { name: 'browser_click' }, { name: 'browser_snapshot' }], log: [] }],
  'plugins:status': () => [],
  'plugins:commands': () => [],
  'rules:list': () => [{ source: 'AGENTS.md', path: ROOT + '/AGENTS.md', text: FILES['AGENTS.md'], enabled: true }],
  'requestlog:list': () => reqlog,
  'agent:active': () => [],
  'providers:test': async () => { await sleep(700); return { ok: true, text: 'pong', ms: 840, firstTokenMs: 610 }; },
  'agent:context': () => ({ window: 200000, maxOutput: 32000, total: 41200, model: 'glm-5.2', compacted: false, parts: { system: 900, rules: 120, memory: 60, tools: 5200, mcpPlugins: 1800, summary: 0, messages: 9800, attachments: 4200, toolResults: 18900, images: 0 } }),
  'agent:compact': () => ({ summary: '- user asked…', untilId: null }),
  'chat:search': (q) => [{ id: 'chat_1', title: HISTORY.title, snippet: '…проверку пустого имени и прогони тесты', updated: Date.now() - 600e3 }],
  'chat:pin': () => true,
  'chat:fork': () => ({ chat: { id: 'chat_fork', title: '↳ ' + HISTORY.title, messages: HISTORY.messages.slice(0, 3) }, prefill: '' }),
  'ws:extra-roots': () => [],
  'ws:read-many': (files) => Object.fromEntries(files.map((f) => [f, FILES[f.slice(ROOT.length + 1)] || ''])),
  'index:status': () => ({ state: 'ready', files: 42, chunks: 311, model: 'text-embedding-3-small', updated: Date.now() - 3600e3 }),
  'docs:list': () => [{ id: 'd1', name: 'react', url: 'https://react.dev/reference/', status: 'ready', pages: 58, chunks: 640 }],
  'usage:summary': () => {
    const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10), input: Math.round(Math.random() * 400000), output: Math.round(Math.random() * 60000), cache: Math.round(Math.random() * 200000), requests: Math.round(Math.random() * 120), usd: Math.random() * 2, priced: true }));
    const sum = (arr) => arr.reduce((a, d) => ({ input: a.input + d.input, output: a.output + d.output, cache: a.cache + d.cache, requests: a.requests + d.requests, usd: a.usd + d.usd, priced: true }), { input: 0, output: 0, cache: 0, requests: 0, usd: 0 });
    return { totals: { today: sum(days.slice(-1)), week: sum(days.slice(-7)), month: sum(days) }, days, models: [{ name: 'Z.ai · glm-5.2', ...sum(days.slice(-20)) }, { name: 'OpenRouter · claude-sonnet-5.5', ...sum(days.slice(-5)) }], kinds: [{ kind: 'agent', ...sum(days.slice(-25)) }, { kind: 'autocomplete', ...sum(days.slice(-3)) }, { kind: 'subagent', ...sum(days.slice(-2)) }] };
  },
  'hooks:list': () => [{ source: '.claude/settings.json', event: 'PostToolUse', matcher: 'Edit', hooks: [{ command: 'npx prettier --write "$ENIDE_FILE"' }] }],
  'memory:get': () => ({ global: { path: '/Users/you/Library/Application Support/Enide/memory.md', text: '- Отвечать по-русски\n' }, project: { path: ROOT + '/.enide/memory.md', text: '- Uses pnpm, not npm\n- Tests: vitest\n' } }),
  'themes:list': () => [{ label: 'One Dark Pro', from: 'Cursor', path: '/x', uiTheme: 'vs-dark' }, { label: 'GitHub Light', from: 'VS Code', path: '/y', uiTheme: 'vs' }],
  'lint:run': () => ({ ran: ['tsc', 'eslint'], total: 3, items: [{ file: ROOT + '/src/main.ts', line: 4, col: 1, severity: 'error', code: 'TS2531', message: "Object is possibly 'null'.", source: 'tsc' }, { file: ROOT + '/src/lib/greet.ts', line: 2, col: 3, severity: 'warning', code: 'no-unused-vars', message: "'x' is defined but never used.", source: 'eslint' }] }),
  'review:run': () => [{ file: ROOT + '/src/lib/greet.ts', line: 2, severity: 'warning', title: 'Whitespace-only names', body: 'name.trim() is checked but greeting uses untrimmed name — "  Bob " → "Hello,   Bob !".', source: 'review' }],
  'term:create': (o) => { setTimeout(() => fire('term:data', o.id, 'Last login: Fri Oct 30 09:41:12 on ttys002\r\n~/Projects/light-app ❯ '), 100); return { id: o.id, kind: 'pty', cwd: ROOT }; },
};

export function createMockBridge() {
  return {
    isMock: true,
    platform: 'darwin',
    async invoke(ch, ...args) {
      const fn = HANDLERS[ch];
      await sleep(10);
      if (!fn) return null;
      return fn(...args);
    },
    send(ch, id, data) { if (ch === 'term:write') fire('term:data', id, data === '\r' ? '\r\n~/Projects/light-app ❯ ' : data); },
    on(ch, cb) { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(cb); return () => { listeners.set(ch, listeners.get(ch).filter((x) => x !== cb)); }; },
    pathForFile: () => '',
  };
}
