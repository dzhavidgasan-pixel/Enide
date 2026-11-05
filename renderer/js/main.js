// App shell: layout, title bar, activity bar, status bar, commands and keybindings.
import { api } from './api.js';
import { h, clear, icon, iconBtn, btn, toast, modal, jsonHighlight, basename, popMenu, promptDialog, fmtTokens, relPath } from './dom.js';
import { state, emit, on, currentModel, allModels } from './state.js';
import { setLang, t, tr } from './i18n.js';
import { EditorArea } from './editor.js';
import { Explorer } from './explorer.js';
import { SearchPane } from './search.js';
import { ScmPane } from './scm.js';
import { PluginsPane } from './pluginsPane.js';
import { BottomPanel, showRequest } from './panel.js';
import { ChatTabs } from './chatTabs.js';
import { ChatsPane } from './chatsPane.js';
import { authGate, avatar } from './auth.js';
import { initTooltips } from './tooltips.js';
import { checkRequiredUpdate, showUpdateScreen } from './update.js';
import { openSettings } from './settings.js';
import { quickOpen, commandPalette } from './palette.js';
import { welcome } from './welcome.js';
import { starfield } from './stars.js';

const ui = {};
Object.defineProperty(ui, 'chat', { get: () => ui.chatTabs && ui.chatTabs.active });
const recentFiles = [];

function applySettings(r) {
  state.settings = r.settings;
  state.keyHints = r.keyHints || {};
  const s = r.settings;
  const lang = s.language === 'auto' || !s.language ? ((state.info && state.info.locale) || navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en' : s.language;
  setLang(lang);
  const dark = s.theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : s.theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (s.reasoning) state.reasoning = s.reasoning;
  if (!state.modelRef || !allModels().some((m) => m.ref.providerId === state.modelRef.providerId && m.ref.modelId === state.modelRef.modelId)) state.modelRef = s.defaultModel || null;
}

on('save-settings', async (patch, cb) => {
  try {
    const r = await api.invoke('settings:set', patch);
    const langBefore = state.settings.language;
    applySettings(r);
    emit('settings');
    if (patch.language && patch.language !== langBefore) rebuild();
    if (patch.theme || patch.starfield !== undefined) refreshEmpty();
  } catch (e) { toast(e.message, 'error'); }
  if (cb) cb();
});
on('save-settings-replace', async (key, value, cb) => {
  const r = await api.invoke('settings:set', { __replace: [key], [key]: value });
  applySettings(r); emit('settings'); if (cb) cb();
});
api.on('settings:changed', (r) => { applySettings(r); emit('settings'); });

// ---------- layout ----------
function L() { return state.settings.layout || {}; }
let layoutTimer;
function saveLayout(patch) {
  Object.assign(state.settings.layout, patch);
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => api.invoke('settings:set', { layout: state.settings.layout }).catch(() => {}), 400);
}

function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  // title bar
  ui.cc = h('div', { class: 'command-center', onclick: () => runCmd('quick-open') }, icon('search'), h('span', { class: 'name' }, 'Enide'), h('kbd', null, '⌘P'));
  ui.btnSidebar = iconBtn('sidebar', `${tr('Toggle sidebar', 'Боковая панель')} (⌘B)`, () => runCmd('toggle-sidebar'));
  ui.btnPanel = iconBtn('panelBottom', `${tr('Toggle terminal', 'Терминал')} (⌘J)`, () => runCmd('toggle-panel'));
  ui.btnAgent = iconBtn('panelRight', `${tr('Toggle agent', 'Панель агента')} (⌘I)`, () => runCmd('toggle-agent'));
  ui.agentPill = btn(t('agent'), { cls: 'primary agent-pill', icon: 'terminal', onclick: () => { if (!L().agent) runCmd('toggle-agent'); ui.chat.focus(); } });
  document.body.classList.add('plat-' + (api.isMock ? 'mock' : api.platform));
  const title = h('div', { class: `titlebar ${api.platform !== 'darwin' || api.isMock ? 'no-traffic' : ''}` },
    h('div', { class: 'wordmark' }, 'En', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'),
    h('div', { class: 'spacer' }), ui.cc,
    ui.btnSidebar, ui.btnPanel, ui.avatarBtn = accountButton());

  // activity bar
  ui.views = {};
  ui.activity = h('div', { class: 'activitybar' });
  const act = (id, ic, label, key, hidden) => {
    const b = iconBtn(ic, `${label} (${key})`, () => showView(id, true));
    ui.views[id] = { btn: b };
    if (!hidden) ui.activity.append(b);
  };
  act('chats', 'newChat', tr('Chats', 'Чаты'), '⌘⇧H');
  act('explorer', 'files', tr('Explorer', 'Проводник'), '⌘⇧E');
  act('search', 'search', tr('Search', 'Поиск'), '⌘⇧F');
  act('scm', 'git', 'Source Control', '⌃⇧G');
  act('plugins', 'puzzle', tr('Plugins & MCP', 'Плагины и MCP'), '⌘⇧X', true);
  ui.scmCount = h('span', { class: 'count hidden' });
  ui.views.scm.btn.append(ui.scmCount);
  ui.activity.append(h('div', { class: 'fill' }), iconBtn('settings', `${t('settings')} (⌘,)`, () => openSettings()));

  ui.sidebar = h('div', { class: 'sidebar', style: { width: (L().sidebarWidth || 260) + 'px' } });
  for (const id of Object.keys(ui.views)) { ui.views[id].el = h('div', { class: 'col', style: { flex: 1, minHeight: 0, display: 'none' } }); ui.sidebar.append(ui.views[id].el); }
  const rs1 = resizer('x', (dx) => { const w = Math.max(170, Math.min(600, ui.sidebar.offsetWidth + dx)); ui.sidebar.style.width = w + 'px'; saveLayout({ sidebarWidth: w }); });
  ui.editorArea = h('div', { class: 'editor-area' });
  ui.panel = h('div', { class: 'bottom-panel', style: { height: (L().panelHeight || 260) + 'px' } });
  const rsH = resizer('y', (dy) => { const v = Math.max(100, Math.min(window.innerHeight - 200, ui.panel.offsetHeight - dy)); ui.panel.style.height = v + 'px'; saveLayout({ panelHeight: v }); });
  ui.center = h('div', { class: 'center' }, ui.editorArea, rsH, ui.panel);
  ui.rsH = rsH;
  ui.agent = h('div', { class: 'agent', style: { width: (L().agentWidth || 440) + 'px' } });
  const rs2 = resizer('x', (dx) => { const w = Math.max(320, Math.min(900, ui.agent.offsetWidth - dx)); ui.agent.style.width = w + 'px'; saveLayout({ agentWidth: w }); });
  ui.rs1 = rs1; ui.rs2 = rs2;
  ui.main = h('div', { class: 'main' });
  const main = ui.main;
  main.append(ui.activity, ui.sidebar, rs1, ui.center, rs2, ui.agent);

  // status bar
  ui.status = {
    branch: h('span', { class: 'item click', onclick: () => showView('scm', true) }),
    agent: h('span', { class: 'item' }),
    pos: h('span', { class: 'item' }),
    lang: h('span', { class: 'item' }),
    tab: h('span', { class: 'item click', onclick: () => runCmd('toggle-autocomplete') }),
    model: h('span', { class: 'item click', onclick: (e) => ui.chat.modelMenu(e.currentTarget) }),
    eye: h('span', { class: 'item click', title: t('contextPreview'), onclick: () => runCmd('context-preview') }, icon('eye'), tr('no hidden prompts', 'без скрытых промптов')),
    index: h('span', { class: 'item click hidden', title: tr('Semantic index', 'Семантический индекс'), onclick: () => openSettings('index') }),
    problems: h('span', { class: 'item click', title: tr('Problems (⌘⇧M)', 'Проблемы (⌘⇧M)'), onclick: () => runCmd('problems') }),
    today: h('span', { class: 'item click hidden', title: tr('Spent today', 'Потрачено сегодня'), onclick: () => openSettings('usage') }),
  };
  const sb = h('div', { class: 'statusbar' }, ui.status.branch, ui.status.problems, ui.status.agent, h('span', { class: 'fill' }), ui.status.pos, ui.status.model);
  app.append(title, main, sb);

  // components
  ui.editor = new EditorArea(ui.editorArea);
  ui.bottom = new BottomPanel(ui.panel);
  ui.explorer = new Explorer(ui.views.explorer.el, { onOpen: (p, o) => openFile(p, o), onAddToChat: (p) => { showAgent(); ui.chat.attachPath(p); } });
  ui.search = new SearchPane(ui.views.search.el, { onOpen: (p, o) => openFile(p, o) });
  ui.scm = new ScmPane(ui.views.scm.el, { editor: ui.editor });
  ui.plugins = new PluginsPane(ui.views.plugins.el, { openSettings });
  ui.chatTabs = new ChatTabs(ui.agent, { editor: ui.editor, panel: ui.bottom, openSettings, showContextPreview, showAgent });
  ui.chats = new ChatsPane(ui.views.chats.el, { tabs: ui.chatTabs });

  showView(state.view || 'explorer', false);
  applyLayout();
  refreshEmpty();
  updateStatus();
}

function rebuild() {
  const tabs = ui.editor ? ui.editor.tabs.filter((x) => x.kind === 'file' && !x.dirty).map((x) => x.path) : [];
  buildShell();
  if (state.root) { ui.explorer.setRoot(state.root); ui.scm.refresh(); updateTitle(); }
  for (const p of tabs) openFile(p, { activate: false });
}

function resizer(axis, onDelta) {
  const el = h('div', { class: `resizer ${axis === 'y' ? 'h' : ''}` });
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    let last = axis === 'y' ? e.clientY : e.clientX;
    el.classList.add('drag');
    document.body.style.cursor = axis === 'y' ? 'row-resize' : 'col-resize';
    const move = (ev) => { const cur = axis === 'y' ? ev.clientY : ev.clientX; onDelta(cur - last); last = cur; };
    const up = () => { el.classList.remove('drag'); document.body.style.cursor = ''; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return el;
}

function applyLayout() {
  const l = L();
  ui.sidebar.style.display = l.sidebar === false ? 'none' : '';
  ui.rs1.style.display = l.sidebar === false ? 'none' : '';
  ui.panel.style.display = l.panel ? '' : 'none';
  ui.rsH.style.display = l.panel ? '' : 'none';
  // Wide chat: the agent takes the whole editor area, sidebar stays (⌘E).
  const wide = !!l.chatFull && l.agent !== false;
  ui.main.classList.toggle('chat-full', wide);
  ui.center.style.display = wide ? 'none' : '';
  ui.agent.style.display = l.agent === false ? 'none' : '';
  ui.rs2.style.display = l.agent === false || wide ? 'none' : '';
  for (const pnl of (ui.chatTabs && ui.chatTabs.panels) || []) pnl.setWide(wide);
  ui.btnSidebar.classList.toggle('active', l.sidebar !== false);
  ui.btnPanel.classList.toggle('active', !!l.panel);
  ui.btnAgent.classList.toggle('active', l.agent !== false);
  if (l.panel) ui.bottom.onShow();
  setTimeout(() => ui.editor.layout(), 0);
}

// ---------- account ----------
function accountButton() {
  const b = h('button', { class: 'avatar-btn', title: state.user ? `${state.user.nick} · @${state.user.login}` : '', onclick: (e) => accountMenu(e.currentTarget) }, avatar(state.user, 28));
  return b;
}
function accountMenu(anchor) {
  const u = state.user || {};
  popMenu(anchor, [
    { header: `${u.nick || ''} · @${u.login || ''}` },
    { label: tr('Account & security', 'Аккаунт и безопасность'), icon: 'user', onclick: () => openSettings('account') },
    { label: t('settings'), icon: 'settings', sub: '⌘,', onclick: () => openSettings() },
    { sep: true },
    { label: tr('Sign out', 'Выйти'), icon: 'logout', onclick: () => signOut() },
  ], { alignRight: true, minWidth: 240 });
}
export async function signOut() {
  try { await api.invoke('auth:logout'); } catch {}
  location.reload();
}
on('user', (u) => { state.user = u; if (ui.avatarBtn) { ui.avatarBtn.replaceChildren(avatar(u, 28)); ui.avatarBtn.title = `${u.nick} · @${u.login}`; } });

function showView(id, toggleIfActive) {
  if (toggleIfActive && state.view === id && L().sidebar !== false) { saveLayout({ sidebar: false }); applyLayout(); return; }
  state.view = id;
  for (const [vid, v] of Object.entries(ui.views)) { v.el.style.display = vid === id ? 'flex' : 'none'; v.btn.classList.toggle('active', vid === id); }
  if (L().sidebar === false) { saveLayout({ sidebar: true }); applyLayout(); }
  if (id === 'scm') ui.scm.refresh();
  if (id === 'plugins') ui.plugins.refresh();
}

function showAgent() { if (L().agent === false) { saveLayout({ agent: true }); applyLayout(); } }

function refreshEmpty() {
  if (!ui.editor) return;
  if (ui.emptyEl && ui.emptyEl.destroy) ui.emptyEl.destroy();
  ui.emptyEl = state.root ? emptyEditor() : welcome({ onOpenFolder: () => runCmd('open-folder'), onOpenPath: (p) => openWorkspace(p), onAsk: () => { showAgent(); ui.chat.focus(); } });
  ui.editor.setWelcome(ui.emptyEl);
}

function emptyEditor() {
  const rows = [[tr('Go to file', 'Перейти к файлу'), '⌘P'], [tr('Command palette', 'Палитра команд'), '⌘⇧P'], [tr('Ask the agent', 'Спросить агента'), '⌘L'], [tr('Inline edit', 'Правка в коде'), '⌘K'], [tr('Terminal', 'Терминал'), '⌘J'], [tr('Find in files', 'Поиск по файлам'), '⌘⇧F']];
  const el = h('div', { class: 'welcome', style: { justifyContent: 'center', paddingTop: 0 } },
    h('div', { class: 'hero-logo', style: { fontSize: '120px', opacity: .9 } }, 'en', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'),
    h('div', { class: 'hero-tag', style: { marginBottom: '28px' } }, basename(state.root)),
    h('table', { class: 'kbd-table', style: { width: '320px' } }, ...rows.map(([a, k]) => h('tr', null, h('td', null, a), h('td', null, h('kbd', null, k))))));
  let stars = null;
  requestAnimationFrame(() => { if (state.settings.starfield !== false) stars = starfield(el, { density: 0.00006, light: document.documentElement.dataset.theme === 'light' }); });
  el.destroy = () => stars && stars.destroy();
  return el;
}

function updateTitle() {
  const name = state.root ? basename(state.root) : 'Enide';
  document.title = state.root ? `${name} — Enide` : 'Enide';
  if (ui.cc) ui.cc.querySelector('.name').textContent = name;
}

function updateStatus() {
  if (!ui.status) return;
  const g = state.gitStatus;
  clear(ui.status.branch);
  if (g && g.repo) {
    ui.status.branch.append(icon('git'), g.branch || 'HEAD', g.ahead ? ` ↑${g.ahead}` : '', g.behind ? ` ↓${g.behind}` : '');
    const n = g.staged.length + g.unstaged.length;
    ui.scmCount.textContent = n > 99 ? '99+' : String(n);
    ui.scmCount.classList.toggle('hidden', !n);
  } else ui.scmCount.classList.add('hidden');
  const cm = currentModel();
  clear(ui.status.model);
  ui.status.model.append(icon('cpu'), cm ? (cm.model.name || cm.model.id) : t('noModel'));
  ui.status.model.title = tr('Chat model — click to change', 'Модель чата — нажми, чтобы сменить');
  const ac = state.settings.autocomplete || {};
  clear(ui.status.tab);
  ui.status.tab.append(icon('textCursor'), tr('Tab hints', 'Подсказки Tab') + ': ' + (ac.enabled ? tr('on', 'вкл') : tr('off', 'выкл')));
  ui.status.tab.title = ac.enabled ? tr('Autocomplete on', 'Автодополнение вкл.') : tr('Autocomplete off', 'Автодополнение выкл.');
}

on('settings', updateStatus);
on('problems', (p) => { if (ui.bottom) ui.bottom.setProblems(p); const items = (ui.bottom && ui.bottom.problems) || []; const e = items.filter((x) => x.severity === 'error').length; if (ui.status) { clear(ui.status.problems); ui.status.problems.append(h('span', { class: `sb-count ${e ? 'err' : ''}` }, icon('xCircle'), String(e)), h('span', { class: `sb-count ${items.length - e ? 'warn' : ''}` }, icon('alert'), String(items.length - e))); } });
api.on('index:progress', (st) => renderIndexStatus(st));
api.on('usage:entry', () => refreshToday());
function renderIndexStatus(st) {
  if (!ui.status) return;
  const el = ui.status.index;
  clear(el);
  if (!st || st.state === 'none') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (st.state === 'building') el.append(icon('layers'), `${tr('Indexing', 'Индексация')} ${st.total ? Math.round((st.done / st.total) * 100) : 0}%`);
  else if (st.state === 'error') el.append(icon('alert'), tr('Index error', 'Ошибка индекса'));
  else el.append(icon('layers'), `${tr('Indexed', 'Индекс')} · ${st.files}`);
  if (st.error) el.title = st.error;
}
let todayTimer;
function refreshToday() {
  clearTimeout(todayTimer);
  todayTimer = setTimeout(async () => {
    try {
      const u = await api.invoke('usage:summary', 1);
      const tt = u.totals.today;
      if (!ui.status) return;
      ui.status.today.classList.toggle('hidden', !tt.requests);
      ui.status.today.textContent = tr('Today ', 'Сегодня ') + (tt.priced ? `$${tt.usd.toFixed(2)}` : `${fmtTokens(tt.input + tt.output + tt.cache)} tok`);
    } catch {}
  }, 500);
}
on('git-status', updateStatus);
on('cursor', (c) => { if (ui.status) ui.status.pos.textContent = `Ln ${c.line}, Col ${c.col}`; });
on('active-tab', (tab) => {
  if (!ui.status) return;
  ui.status.lang.textContent = tab && tab.model ? tab.model.getLanguageId() : '';
  if (!tab) ui.status.pos.textContent = '';
});
on('open-file', (p) => openFile(p, { preview: false }));
on('open-to-side', (p) => ui.editor.openToSide(p));
on('open-file-at', (p, line, col) => openFile(p, { line, col, preview: true }));
on('fix-problems', (items) => {
  showAgent();
  const lines = items.slice(0, 60).map((it) => `- ${relPath(state.root, it.file)}:${it.line} ${it.severity}: ${it.title ? it.title + ' — ' : ''}${it.body || it.message}`);
  const p = ui.chat.running ? ui.chatTabs.newTab() : ui.chat;
  p.setMode('agent');
  p.send(tr('Fix these problems, then run read_lints to confirm:\n', 'Исправь эти проблемы, потом проверь через read_lints:\n') + lines.join('\n'));
});
on('show-panel', () => { if (!L().panel) { saveLayout({ panel: true }); applyLayout(); } });
on('context-preview', (mode) => showContextPreview(mode));
on('cmd', (id, ...a) => runCmd(id, ...a));

async function openFile(p, opts = {}) {
  if (L().chatFull) { saveLayout({ chatFull: false }); applyLayout(); } // opening a file brings the editor back
  const tab = await ui.editor.openFile(p, opts);
  if (tab) { const i = recentFiles.indexOf(p); if (i >= 0) recentFiles.splice(i, 1); recentFiles.unshift(p); if (recentFiles.length > 30) recentFiles.pop(); }
  return tab;
}

async function openWorkspace(dir) {
  try {
    const r = await api.invoke('ws:open', dir);
    state.root = r.root;
    ui.editor.closeAll();
    ui.explorer.setRoot(state.root);
    showView('explorer', false);
    updateTitle();
    refreshEmpty();
    emit('workspace', state.root);
    ui.scm.refresh();
    ui.explorer.loadExtraRoots();
    api.invoke('index:status').then(renderIndexStatus).catch(() => {});
    ui.editor.loadProject && ui.editor.loadProject();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- context preview (exact prompt) ----------
async function showContextPreview(mode = state.mode) {
  let p;
  try { p = await api.invoke('agent:preview', { mode, modelRef: state.modelRef }); } catch (e) { toast(e.message, 'error'); return; }
  const toolsList = h('div');
  for (const tl of p.tools) {
    const det = h('details', { style: { margin: '6px 0' } }, h('summary', { style: { cursor: 'pointer' } }, h('b', { class: 'mono' }, tl.name), h('span', { class: 'muted' }, ` · ${tl.source}`)), h('p', { class: 'dim', style: { margin: '6px 0' } }, tl.description), jsonHighlight(tl.parameters));
    toolsList.append(det);
  }
  modal({
    title: `${t('contextPreview')} · ${{ agent: t('agent'), ask: t('ask'), plan: t('plan') }[mode] || mode}`,
    size: 'md',
    body: h('div', null,
      h('div', { class: 'card transparency' }, h('div', { class: 'tile' }, icon('eye')), h('div', null, h('b', null, tr('This is everything Enide adds.', 'Это всё, что добавляет Enide.')),
        h('span', null, tr('System prompt + tool definitions below, then your messages and attachments as shown in chat. Nothing else. Edit in Settings → Prompts & rules.', 'Системный промпт и описания инструментов ниже, затем твои сообщения и вложения — как в чате. Больше ничего. Редактируется в Настройки → Промпты и правила.')))),
      p.model ? h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '12px' } }, h('span', { class: 'chip' }, p.model.provider), h('span', { class: 'chip' }, p.model.protocol), h('span', { class: 'chip' }, p.model.model.id), h('span', { class: 'chip' }, `reasoning: ${p.model.model.reasoningStyle}`)) : null,
      h('div', { class: 'group-title' }, tr(`System prompt · ${p.system.length} chars`, `Системный промпт · ${p.system.length} символов`)),
      h('pre', { class: 'code-view' }, p.system || tr('(empty — no system prompt is sent)', '(пусто — системный промпт не отправляется)')),
      h('div', { class: 'group-title' }, tr(`Tools · ${p.tools.length}`, `Инструменты · ${p.tools.length}`)),
      toolsList,
      h('div', { class: 'row', style: { marginTop: '14px' } }, btn(tr('Edit prompts', 'Изменить промпты'), { cls: 'sm', icon: 'edit', onclick: () => { document.querySelector('.overlay').remove(); openSettings('prompts'); } }), btn(t('requestLog'), { cls: 'sm', icon: 'activity', onclick: () => { document.querySelector('.overlay').remove(); runCmd('request-log'); } }))),
  });
}

// ---------- terminal ⌘K ----------
async function terminalCmdK() {
  const instruction = await promptDialog(tr('Generate a terminal command', 'Сгенерировать команду терминала'), tr('e.g. find the 10 largest files here', 'напр. найди 10 самых больших файлов здесь'));
  if (!instruction) return;
  try {
    toast(t('generating'), 'info', 1500);
    const cmd = await api.invoke('ai:terminal-command', { instruction, cwd: ui.bottom.active && ui.bottom.active.cwd });
    const tm = ui.bottom.active || (await ui.bottom.newTerminal());
    api.send('term:write', tm.id, cmd.replace(/\n+$/, ''));
    tm.focus();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- commands ----------
function commands() {
  const c = (id, label, key, icon2, keywords) => ({ id, label, key, icon: icon2, keywords, run: () => runCmd(id) });
  const list = [
    c('open-folder', t('openFolder'), '⌘O', 'folder'), c('new-file', t('newFile'), '⌘N', 'plus'), c('save', t('save'), '⌘S', 'check'), c('save-all', tr('Save all', 'Сохранить всё'), '⌥⌘S', 'check'),
    c('quick-open', t('quickOpen'), '⌘P', 'search'), c('search', tr('Find in files', 'Поиск по файлам'), '⌘⇧F', 'search'),
    c('new-chat', t('newChat'), '⌘⇧L', 'newChat'), c('focus-chat', tr('Add selection to chat', 'Выделение в чат'), '⌘L', 'at'), c('inline-edit', tr('Inline edit', 'Правка в коде'), '⌘K', 'wand'),
    c('mode-agent', `${tr('Mode', 'Режим')}: ${t('agent')}`, '⌘1', 'infinity'), c('mode-ask', `${tr('Mode', 'Режим')}: ${t('ask')}`, '⌘2', 'message'), c('mode-plan', `${tr('Mode', 'Режим')}: ${t('plan')}`, '⌘3', 'list'), c('mode-debug', `${tr('Mode', 'Режим')}: ${tr('Debug', 'Отладка')}`, '⌘4', 'bug'),
    c('new-chat-tab', tr('New chat tab (parallel agent)', 'Новая вкладка чата (параллельный агент)'), '⌘T', 'plus'), c('compact', tr('Compact chat context', 'Сжать контекст чата'), '', 'layers'),
    c('review', tr('Review changes with AI (Bugbot)', 'Ревью изменений ИИ (Bugbot)'), '', 'shield'), c('problems', tr('Problems: check project', 'Проблемы: проверить проект'), '⌘⇧M', 'alert'),
    c('split-editor', tr('Split editor', 'Разделить редактор'), '⌘\\', 'panelRight'), c('add-folder', tr('Add folder to workspace', 'Добавить папку в проект'), '', 'folder'),
    c('show-browser', tr('Show agent browser', 'Показать браузер агента'), '', 'globe'), c('index-build', tr('Rebuild semantic index', 'Пересобрать семантический индекс'), '', 'layers'),
    c('search-chats', tr('Search all chats', 'Поиск по всем чатам'), '', 'search'), c('settings-usage', tr('Usage & cost', 'Расход и стоимость'), '', 'activity'), c('check-update', tr('Check for updates', 'Проверить обновления'), '', 'download'),
    c('toggle-autocomplete', tr('Toggle Tab autocomplete', 'Вкл/выкл автодополнение'), '', 'textCursor'), c('context-preview', t('contextPreview'), '', 'eye', 'system prompt hidden'),
    c('request-log', t('requestLog'), '', 'activity', 'requests http'), c('toggle-sidebar', tr('Toggle sidebar', 'Боковая панель'), '⌘B', 'sidebar'), c('toggle-panel', tr('Toggle terminal', 'Терминал'), '⌘J', 'terminal'),
    c('new-terminal', t('newTerminal'), '', 'terminal'), c('toggle-agent', tr('Toggle agent panel', 'Панель агента'), '⌘I', 'panelRight'), c('toggle-chat-full', tr('Wide chat (agent layout)', 'Чат на весь экран'), '⌘E', 'expand'), c('git', 'Source control', '⌃⇧G', 'git'), c('plugins', tr('Plugins & MCP', 'Плагины и MCP'), '⌘⇧X', 'puzzle'),
    c('settings', t('settings'), '⌘,', 'settings'), c('settings-providers', tr('Settings: providers & models', 'Настройки: провайдеры и модели'), '', 'cpu', 'api key'), c('settings-prompts', tr('Settings: prompts & rules', 'Настройки: промпты и правила'), '', 'eye'),
    c('theme-toggle', tr('Toggle light/dark theme', 'Светлая/тёмная тема'), '', 'eye', 'theme'), c('close-folder', tr('Close folder', 'Закрыть папку'), '', 'x'), c('reload', tr('Reload window', 'Перезагрузить окно'), '', 'refresh'),
  ];
  return list;
}

let pluginCommands = [];
async function allCommands() {
  try { pluginCommands = await api.invoke('plugins:commands'); } catch { pluginCommands = []; }
  return [...commands(), ...pluginCommands.map((pc) => ({ label: `${pc.pluginId}: ${pc.title}`, icon: 'puzzle', run: async () => { try { const r = await api.invoke('plugins:run-command', pc.id); if (r && r.message) toast(r.message, 'ok', 6000); if (r && r.openFile) openFile(r.openFile); } catch (e) { toast(e.message, 'error'); } } }))];
}

async function runCmd(id, arg) {
  const inTerminal = document.activeElement && document.activeElement.closest && document.activeElement.closest('.bottom-panel');
  switch (id) {
    case 'open-folder': { const p = await api.invoke('ws:pick-folder'); if (p) openWorkspace(p); break; }
    case 'open-path': {
      const isDir = await api.invoke('ws:readdir', arg).then(() => true).catch(() => false);
      if (isDir) openWorkspace(arg); else openFile(arg, { preview: false });
      break;
    }
    case 'close-folder': await api.invoke('ws:close'); state.root = null; ui.editor.closeAll(); ui.explorer.setRoot(null); updateTitle(); refreshEmpty(); emit('workspace', null); ui.scm.refresh(); break;
    case 'new-file': {
      if (!state.root) { const p = await api.invoke('ws:pick-folder'); if (p) await openWorkspace(p); else break; }
      showView('explorer', false); ui.explorer.startCreate(false); break;
    }
    case 'save': ui.editor.save(); break;
    case 'save-all': ui.editor.saveAll(); break;
    case 'close-tab': ui.editor.closeActive(); break;
    case 'quick-open': quickOpen({ onOpen: (p, o) => openFile(p, o), recent: recentFiles, commands: await allCommands() }); break;
    case 'palette': commandPalette(await allCommands()); break;
    case 'search': {
      showView('search', false);
      const sel = ui.editor.getSelectionInfo();
      ui.search.focus(sel && !sel.empty && sel.text.length < 200 && !sel.text.includes('\n') ? sel.text : '');
      break;
    }
    case 'explorer': showView('explorer', false); break;
    case 'git': showView('scm', false); break;
    case 'plugins': showView('plugins', false); break;
    case 'toggle-sidebar': saveLayout({ sidebar: L().sidebar === false }); applyLayout(); break;
    case 'toggle-panel': saveLayout({ panel: !L().panel }); applyLayout(); break;
    case 'toggle-chat-full': saveLayout({ chatFull: !L().chatFull, agent: true }); applyLayout(); if (L().chatFull) showView('chats', false); ui.chat.focus(); break;
    case 'chats': showView('chats', false); break;
    case 'toggle-agent': saveLayout({ agent: L().agent === false }); applyLayout(); if (L().agent !== false) ui.chat.focus(); break;
    case 'new-terminal': saveLayout({ panel: true }); applyLayout(); ui.bottom.newTerminal(); break;
    case 'request-log': saveLayout({ panel: true }); applyLayout(); ui.bottom.view = 'requests'; ui.bottom.renderTabs(); ui.bottom.renderBody(); break;
    case 'new-chat': showAgent(); ui.chat.newChat(); break;
    case 'focus-chat': showAgent(); { const s = ui.editor.getSelectionInfo(); if (s && !s.empty && document.activeElement && document.activeElement.closest('.editor-area')) ui.chat.addSelection(); else ui.chat.focus(); } break;
    case 'inline-edit': if (inTerminal) terminalCmdK(); else ui.editor.inlineEdit(); break;
    case 'mode-agent': case 'mode-ask': case 'mode-plan': case 'mode-debug': showAgent(); ui.chat.setMode(id.slice(5)); ui.chat.focus(); break;
    case 'new-chat-tab': showAgent(); ui.chatTabs.newTab().focus(); break;
    case 'compact': showAgent(); ui.chat.compactNow(); break;
    case 'search-chats': showAgent(); ui.chat.searchChats(); break;
    case 'open-chat': if (arg) { showAgent(); ui.chat.openChat(arg); } break;
    case 'review': saveLayout({ panel: true }); applyLayout(); ui.bottom.runReview(); break;
    case 'problems': saveLayout({ panel: true }); applyLayout(); ui.bottom.showProblems(true); break;
    case 'split-editor': ui.editor.splitActive(); break;
    case 'add-folder': try { await api.invoke('ws:add-folder'); ui.explorer.loadExtraRoots(); } catch (e) { toast(e.message, 'error'); } break;
    case 'show-browser': api.invoke('browser:show').catch((e) => toast(e.message, 'error')); break;
    case 'index-build': api.invoke('index:build', false).then(renderIndexStatus).catch((e) => toast(e.message, 'error')); break;
    case 'settings-usage': openSettings('usage'); break;
    case 'refresh-git': ui.scm && ui.scm.refresh(); break;
    case 'check-update': checkUpdate(true); break;
    case 'toggle-autocomplete': { const v = !(state.settings.autocomplete || {}).enabled; emit('save-settings', { autocomplete: { enabled: v } }); toast(v ? tr('Tab autocomplete on', 'Автодополнение включено') : tr('Tab autocomplete off', 'Автодополнение выключено'), 'info', 1500); break; }
    case 'context-preview': showContextPreview(state.mode); break;
    case 'settings': openSettings(); break;
    case 'settings-providers': openSettings('providers'); break;
    case 'settings-prompts': openSettings('prompts'); break;
    case 'theme-toggle': emit('save-settings', { theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' }); break;
    case 'reload': location.reload(); break;
    case 'undo': case 'redo': case 'select-all': {
      const ed = ui.editor.editor;
      if (ed && ed.hasTextFocus()) ed.trigger('menu', id === 'select-all' ? 'editor.action.selectAll' : id, null);
      else if (ui.editor.diffEditor && ui.editor.diffEditor.getModifiedEditor().hasTextFocus()) ui.editor.diffEditor.getModifiedEditor().trigger('menu', id === 'select-all' ? 'editor.action.selectAll' : id, null);
      else document.execCommand(id === 'select-all' ? 'selectAll' : id);
      break;
    }
    default: break;
  }
}

api.on('menu', (id, arg) => runCmd(id, arg));
api.on('ws:changed', () => { clearTimeout(ui.gitTimer); ui.gitTimer = setTimeout(() => ui.scm && ui.scm.refresh(), 800); });
on('chat-finished', () => ui.scm && ui.scm.refresh());
on('renamed', (from, to) => { const tab = ui.editor.tabs.find((x) => x.path === from); if (tab) { ui.editor.close(tab, true).then(() => openFile(to)); } });

// Keyboard fallbacks for the browser preview (in the app, the native menu owns these).
window.addEventListener('keydown', (e) => {
  if (!api.isMock || !e.metaKey) return;
  const k = e.key.toLowerCase();
  const map = { t: 'new-chat-tab', '4': 'mode-debug', '\\': 'split-editor', m: e.shiftKey ? 'problems' : null, p: e.shiftKey ? 'palette' : 'quick-open', b: 'toggle-sidebar', e: e.shiftKey ? null : 'toggle-chat-full', h: e.shiftKey ? 'chats' : null, j: 'toggle-panel', i: 'toggle-agent', k: 'inline-edit', l: e.shiftKey ? 'new-chat' : 'focus-chat', ',': 'settings', s: 'save', '1': 'mode-agent', '2': 'mode-ask', '3': 'mode-plan', f: e.shiftKey ? 'search' : null };
  if (map[k]) { e.preventDefault(); runCmd(map[k]); }
});

// Drop a folder anywhere to open it; drop files on the editor to open them.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  if (e.target.closest && e.target.closest('.agent')) return;
  e.preventDefault();
  for (const f of [...(e.dataTransfer.files || [])]) {
    const p = api.pathForFile(f);
    if (!p) continue;
    const isDir = await api.invoke('ws:readdir', p).then(() => true).catch(() => false);
    if (isDir) { openWorkspace(p); return; }
    openFile(p, { preview: false });
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.settings.theme === 'system') { applySettings({ settings: state.settings, keyHints: state.keyHints }); emit('settings'); refreshEmpty(); } });

// ---------- boot ----------
async function checkUpdate(manual) {
  try {
    const r = await api.invoke('update:check');
    if (!r || !r.configured) { if (manual) toast(tr('Set the GitHub repo for updates in Settings → About.', 'Укажи GitHub-репозиторий для обновлений в Настройки → О программе.'), 'info', 6000); return; }
    if (r.available) showUpdateScreen(r, { blocking: !!r.required });
    else if (manual) toast(tr(`You have the latest version (${r.current}).`, `Установлена последняя версия (${r.current}).`), 'ok');
  } catch (e) { if (manual) toast(e.message, 'error'); }
}

async function boot() {
  state.info = await api.invoke('app:info');
  applySettings(await api.invoke('settings:get'));
  initTooltips();
  const upd = await checkRequiredUpdate(); // a newer release blocks here until it is installed
  state.user = await authGate();
  applySettings(await api.invoke('settings:get')); // key hints and the rest are readable after sign-in
  buildShell();
  toast(tr(`Hi, ${state.user.nick}!`, `Привет, ${state.user.nick}!`), 'ok', 2200);
  const pending = (state.info.pendingOpen || [])[0];
  const last = pending || state.settings.lastWorkspace;
  if (last) {
    const ok = await api.invoke('ws:exists', last).catch(() => false);
    if (ok) await runCmd('open-path', last);
  }
  updateTitle();
  api.invoke('index:status').then(renderIndexStatus).catch(() => {});
  refreshToday();
  if (upd && upd.available && !upd.required) toast(tr(`Enide ${upd.latest} is available (dev build — not forced).`, `Доступна Enide ${upd.latest} (dev-сборка — без принуждения).`), 'info', 6000);
  if (!allModels().length) setTimeout(() => toast(tr('Add a provider and API key to start — Settings → Providers.', 'Добавь провайдера и API-ключ — Настройки → Провайдеры.'), 'info', 7000), 800);
  else if (!Object.values(state.keyHints).some(Boolean) && !(state.settings.providers || []).some((p) => p.authStyle === 'none')) setTimeout(() => { toast(tr('Paste your API key in Settings → Providers.', 'Вставь API-ключ в Настройки → Провайдеры.'), 'info', 7000); }, 800);
}

// Browser preview only: hooks for the UI crawler in test/ui-crawl.mjs.
if (api.isMock) window.__enide = { runCmd, commands, openSettings, ui, state };

boot().catch((e) => { console.error(e); document.getElementById('app').append(h('pre', { class: 'code-view', style: { margin: '60px' } }, String(e && e.stack || e))); });
