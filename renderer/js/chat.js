// Agent panel: chat history, streaming messages, reasoning, tool cards, approvals,
// review of changes, and the composer (mentions, slash commands, attachments, voice).
import { h, clear, icon, iconBtn, btn, toggle, popMenu, toast, confirmDialog, promptDialog, modal, fmtTokens, basename, dirname, relPath, seg, relTime, jsonHighlight } from './dom.js';
import { fileIcon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { api } from './api.js';
import { state, emit, on, allModels, currentModel } from './state.js';
import { t, tr } from './i18n.js';
import { starfield } from './stars.js';
import { modelIcon, providerIcon } from './vendors.js';

const TOOL_META = {
  read_file: { icon: 'file', verb: 'read' }, list_dir: { icon: 'folder', verb: 'listed' }, glob: { icon: 'search', verb: 'found' },
  grep: { icon: 'search', verb: 'searched' }, codebase_search: { icon: 'search', verb: 'searched' }, write_file: { icon: 'edit', verb: 'edited' }, edit_file: { icon: 'edit', verb: 'edited' },
  delete_file: { icon: 'trash', verb: 'deleted' }, run_command: { icon: 'terminal', verb: 'ran' }, check_process: { icon: 'activity', verb: 'checked' },
  web_fetch: { icon: 'globe', verb: 'fetched' }, web_search: { icon: 'globe', verb: 'webSearched' }, todo_write: { icon: 'list', verb: 'tasks' },
  computer: { icon: 'cpu', verb: 'computer' }, browser: { icon: 'globe', verb: 'browser' }, read_lints: { icon: 'alert', verb: 'lints' },
  semantic_search: { icon: 'search', verb: 'searched' }, docs_search: { icon: 'book', verb: 'docs' }, update_memory: { icon: 'book', verb: 'memory' },
  task: { icon: 'layers', verb: 'subagent' },
};
const EXTRA_VERBS = { browser: ['Browser', 'Браузер'], lints: ['Problems', 'Проблемы'], docs: ['Docs', 'Документация'], memory: ['Memory', 'Память'], subagent: ['Subagent', 'Субагент'] };
const verbText = (v) => (EXTRA_VERBS[v] ? tr(EXTRA_VERBS[v][0], EXTRA_VERBS[v][1]) : t(v));

// Three modes under the composer. Deny-list commands (rm -rf /, sudo, …) still ask in every mode.
const APPROVAL_MODES = {
  ask: { strict: true, command: 'ask', write: 'ask', writeOutside: 'ask', mcp: 'ask', plugins: 'ask', computer: 'ask-all', network: 'auto', allowChained: false },
  noAsk: { strict: false, command: 'auto', write: 'auto', writeOutside: 'ask', mcp: 'auto', plugins: 'auto', computer: 'ask', network: 'auto', allowChained: true },
  full: { strict: false, command: 'auto', write: 'auto', writeOutside: 'auto', readOutside: 'auto', mcp: 'auto', plugins: 'auto', computer: 'auto', network: 'auto', allowChained: true },
};
export function approvalMode() {
  const p = (state.settings && state.settings.agent && state.settings.agent.policy) || {};
  if (p.command === 'auto' && p.writeOutside === 'auto') return 'full';
  if (p.command === 'auto') return 'noAsk';
  return 'ask';
}

function shortArgs(name, a) {
  if (!a) return '';
  if (a.path) return a.path;
  if (name === 'run_command') return a.command || '';
  if (name === 'glob') return a.pattern || '';
  if (name === 'grep') return a.pattern || '';
  if (name === 'web_fetch') return a.url || '';
  if (name === 'web_search') return a.query || '';
  if (name === 'check_process') return a.id || '';
  if (name === 'browser') return [a.action, a.url || a.ref || a.selector || a.key || (a.text ? JSON.stringify(a.text).slice(0, 40) : '')].filter(Boolean).join(' ');
  if (name === 'task') return a.description || '';
  if (name === 'read_lints') return (a.paths || []).join(', ') || tr('whole project', 'весь проект');
  if (name === 'semantic_search' || name === 'docs_search') return a.query || '';
  if (name === 'update_memory') return `${a.action} · ${a.scope}: ${a.text || a.old_text || ''}`;
  if (name === 'computer') return [a.action, a.x != null ? `(${a.x}, ${a.y})` : '', a.text ? JSON.stringify(a.text).slice(0, 40) : '', a.keys || '', a.app || ''].filter(Boolean).join(' ');
  const s = JSON.stringify(a);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function partialPath(partial) {
  const m = /"(?:path|command|pattern|url|query)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(partial || '');
  return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
}

function fuzzy(q, s) {
  q = q.toLowerCase(); const l = s.toLowerCase();
  if (!q) return 1;
  const base = l.split('/').pop();
  if (base.startsWith(q)) return 1000 - base.length;
  if (base.includes(q)) return 800 - base.length;
  if (l.includes(q)) return 600 - l.length;
  let i = 0, score = 0, last = -1;
  for (let j = 0; j < l.length && i < q.length; j++) if (l[j] === q[i]) { score += j === last + 1 ? 5 : 1; last = j; i++; }
  return i === q.length ? score : -1;
}

function readBlobAsBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}

export class ChatPanel {
  constructor(host, deps) {
    this.host = host;
    this.d = deps; // { editor, panel, openSettings, showContextPreview, tabs }
    this.mode = state.mode || 'agent';
    this.useWorktree = false;
    this.pendingApprovals = 0;
    this.active = true;
    this.chatId = null;
    this.chat = null;
    this.runId = null;
    this.running = false;
    this.attachments = [];
    this.cards = new Map();
    this.queue = [];
    this.fileList = null;
    this.build();
    api.on('agent:event', (runId, ev) => this.onEvent(runId, ev));
    api.on('ws:changed', () => { this.fileList = null; });
    on('add-selection-to-chat', () => { if (this.active) this.addSelection(); });
    on('explain-selection', () => { if (!this.active) return; this.addSelection(); this.setMode('ask'); this.send(tr('Explain this code.', 'Объясни этот код.')); });
    on('settings', () => this.renderBar());
    api.on('docs:progress', () => { this.docsList = null; });
  }

  // ---------- layout ----------
  setWide(on) {
    if (!this.wideBtn) return;
    clear(this.wideBtn);
    this.wideBtn.append(icon(on ? 'collapseWin' : 'expand'));
    this.wideBtn.title = on ? `${tr('Back to editor', 'Вернуть редактор')} (⌘E)` : `${tr('Wide chat', 'Чат на весь экран')} (⌘E)`;
    this.wideBtn.classList.toggle('active', on);
  }

  build() {
    clear(this.host);
    this.titleEl = h('div', { class: 'chat-title', onclick: (e) => this.historyMenu(e.currentTarget) }, h('span', { class: 't' }, t('newChat')), icon('chevronDown'));
    this.head = h('div', { class: 'agent-head' }, this.titleEl,
      iconBtn('newChat', `${t('newChat')} (⌘⇧L)`, () => this.newChat()),
      iconBtn('plus', `${tr('New tab — run agents in parallel', 'Новая вкладка — агенты параллельно')} (⌘T)`, () => this.d.tabs && this.d.tabs.newTab()),
      iconBtn('history', t('history'), (e) => this.historyMenu(e.currentTarget)),
      this.wideBtn = iconBtn('expand', `${tr('Wide chat', 'Чат на весь экран')} (⌘E)`, () => emit('cmd', 'toggle-chat-full')),
      iconBtn('more', 'More', (e) => this.moreMenu(e.currentTarget)));
    this.setWide(!!((state.settings && state.settings.layout) || {}).chatFull);
    this.msgs = h('div', { class: 'messages selectable' });
    this.msgs.addEventListener('scroll', () => { this.stick = this.msgs.scrollHeight - this.msgs.scrollTop - this.msgs.clientHeight < 60; });
    this.stick = true;
    this.todoDock = h('div', { class: 'todo-dock hidden' });
    this.changesDock = h('div', { class: 'todo-dock hidden' });
    this.wtDock = h('div', { class: 'todo-dock hidden' });
    this.buildComposer();
    this.host.append(this.head, this.msgs, this.wtDock, this.changesDock, this.todoDock, this.composerWrap);
    this.renderEmpty();
  }

  buildComposer() {
    this.ta = h('textarea', { rows: 1, placeholder: t('composerPlaceholder'), spellcheck: 'true' });
    this.attachRow = h('div', { class: 'attach-row' });
    this.bar = h('div', { class: 'composer-bar' });
    this.composer = h('div', { class: 'composer' }, this.attachRow, this.ta, this.bar);
    this.hint = h('div', { class: 'composer-hint' });
    this.popHost = h('div', { class: 'mention-pop hidden' });
    this.composerWrap = h('div', { class: 'composer-wrap' }, this.popHost, this.composer, this.hint);
    this.ta.addEventListener('focus', () => this.composer.classList.add('focus'));
    this.ta.addEventListener('blur', () => { this.composer.classList.remove('focus'); setTimeout(() => this.closePop(), 150); });
    this.ta.addEventListener('input', () => { this.autosize(); this.updatePop(); this.updateSend(); });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('paste', (e) => this.onPaste(e));
    // Keyboard for approvals: ⌘/Ctrl+Enter allows the latest pending action, Esc (with an empty composer) rejects it.
    document.addEventListener('keydown', (e) => {
      if (!this.active || !(this.pendingSet && this.pendingSet.size) || document.querySelector('.overlay, .menu')) return;
      const ap = [...this.msgs.querySelectorAll('.tool.pending .approval')].pop();
      if (!ap) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !this.ta.value.trim()) { e.preventDefault(); ap.querySelector('.btn.primary').click(); }
      else if (e.key === 'Escape' && !this.ta.value.trim() && !document.querySelector('.msg-user.editing')) { e.preventDefault(); e.stopPropagation(); ap.querySelector('.ap-reject').click(); }
    }, true);
    for (const ev of ['dragover', 'dragenter']) this.composerWrap.addEventListener(ev, (e) => { e.preventDefault(); this.composer.classList.add('drag'); });
    this.composerWrap.addEventListener('dragleave', () => this.composer.classList.remove('drag'));
    this.composerWrap.addEventListener('drop', (e) => this.onDrop(e));
    this.host.addEventListener('dragover', (e) => e.preventDefault());
    this.host.addEventListener('drop', (e) => { if (!this.composerWrap.contains(e.target)) this.onDrop(e); });
    this.renderBar();
  }

  autosize() { this.ta.style.height = 'auto'; this.ta.style.height = Math.min(260, this.ta.scrollHeight) + 'px'; }

  renderBar() {
    if (!this.bar || !state.settings) return;
    clear(this.bar);
    const modeIcons = { agent: 'infinity', ask: 'message', plan: 'list', debug: 'bug' };
    const modeName = (m) => (m === 'debug' ? tr('Debug', 'Отладка') : t(m));
    const modeSeg = h('button', { class: 'picker-btn mode-btn', title: tr('Mode (⌘1-⌘4)', 'Режим (⌘1-⌘4)'), onclick: (e) => popMenu(e.currentTarget, [
      { label: t('agent'), icon: 'infinity', sub: '⌘1', on: this.mode === 'agent', onclick: () => this.setMode('agent') },
      { label: t('ask'), icon: 'message', sub: '⌘2', on: this.mode === 'ask', onclick: () => this.setMode('ask') },
      { label: t('plan'), icon: 'list', sub: '⌘3', on: this.mode === 'plan', onclick: () => this.setMode('plan') },
      { label: tr('Debug', 'Отладка'), icon: 'bug', sub: '⌘4', on: this.mode === 'debug', title: tr('Reproduce → hypotheses → logs → proven cause → fix → clean up', 'Воспроизвести → гипотезы → логи → доказанная причина → фикс → уборка'), onclick: () => this.setMode('debug') },
    ], { above: true, checks: true, minWidth: 200 }) }, icon(modeIcons[this.mode] || 'infinity'), h('span', null, modeName(this.mode)), icon('chevronDown'));
    this.modeSeg = modeSeg;
    const cm = currentModel();
    const isAuto = state.modelRef && state.modelRef.providerId === 'auto';
    this.modelBtn = h('button', { class: 'picker-btn', title: isAuto ? tr('Auto: picks a model per message (Settings → Providers → Router)', 'Auto: модель выбирается под сообщение (Настройки → Провайдеры → Роутер)') : cm ? `${cm.provider.name} · ${cm.model.id}` : t('noModel'), onclick: (e) => this.modelMenu(e.currentTarget) }, isAuto ? icon('route') : cm ? modelIcon(cm.model, 14) : icon('cpu'), h('span', { class: 'ellipsis' }, isAuto ? 'Auto' : cm ? (cm.model.name || cm.model.id) : t('noModel')), icon('chevronDown'));
    const r = state.reasoning || { enabled: false };
    const supports = cm && cm.model.reasoningStyle && cm.model.reasoningStyle !== 'none';
    this.thinkBtn = h('button', { class: `picker-btn ${r.enabled && supports ? 'on' : ''}`, title: t('reasoning'), onclick: (e) => this.reasoningMenu(e.currentTarget) }, icon('gauge'), h('span', null, r.enabled && supports ? cap(r.effort || 'medium') : t('thinkingOff')));
    if (!supports) this.thinkBtn.style.opacity = '.5';
    const attach = iconBtn('plus', t('attach'), (e) => this.attachMenu(e.currentTarget), 'sm');
    this.micBtn = iconBtn('mic', tr('Voice input', 'Голосовой ввод'), () => this.toggleVoice(), 'sm');
    this.micBtn.replaceChildren(micIcon());
    this.ctxMeter = h('span', { class: 'mono ctx-meter', onclick: (e) => this.contextPopover(e.currentTarget) });
    this.sendBtn = h('button', { class: 'send-btn', title: `${t('send')} (⏎)`, onclick: () => (this.running && !this.ta.value.trim() ? this.stop() : this.send()) }, icon('arrowUp'));
    this.wtBtn = null;
    if (state.gitStatus && state.gitStatus.repo && !(this.chat && this.chat.messages && this.chat.messages.length && !this.chat.worktree)) {
      const on = this.useWorktree || !!(this.chat && this.chat.worktree);
      this.wtBtn = h('button', { class: `picker-btn ${on ? 'on' : ''}`, title: tr('Run this chat in its own git worktree, so parallel agents never collide. Apply the result when done.', 'Запустить чат в отдельном git worktree — параллельные агенты не мешают друг другу. Потом «Применить».'), onclick: () => { if (this.chat && this.chat.worktree) return; this.useWorktree = !this.useWorktree; this.renderBar(); } }, icon('git'), on ? h('span', null, 'Worktree') : null);
    }
    this.bar.append(...[modeSeg, this.modelBtn, h('span', { class: 'grow' }), this.micBtn, attach, this.sendBtn].filter(Boolean));
    this.updateSend();
    this.updateCtx();
    this.renderHint();
    this.ta.placeholder = this.mode === 'ask' ? t('composerPlaceholderAsk') : this.mode === 'plan' ? t('composerPlaceholderPlan') : this.mode === 'debug' ? tr('Describe the bug — Enide will reproduce it and prove the cause', 'Опиши баг — Enide воспроизведёт его и докажет причину') : t('composerPlaceholder');
  }

  renderHint() {
    clear(this.hint);
    const mode = approvalMode();
    const MODES = [
      ['full', 'unlock', tr('Full access', 'Полный доступ'), tr('Everything without asking: commands, edits anywhere on the Mac, MCP, computer control. Only deny-list commands still ask.', 'Всё без вопросов: команды, правки в любом месте Mac, MCP, управление компьютером. Спросит только про команды из чёрного списка.')],
      ['ask', 'lock', tr('Ask every time', 'Спрашивать каждый раз'), tr('Asks before every edit, command, MCP call and click.', 'Спрашивает перед каждой правкой, командой, вызовом MCP и кликом.')],
      ['noAsk', 'play', tr("Don't ask", 'Не спрашивать'), tr('Edits and commands in the project run without asking; changes outside the project and computer control still ask.', 'Правки и команды в проекте — без вопросов; правки вне проекта и управление компьютером — спросит.')],
    ];
    const modeBtn = h('span', { class: 'perm-seg' }, ...MODES.map(([id, ic, label, tip]) => h('button', { class: `perm ${id} ${mode === id ? 'on' : ''}`, title: tip, onclick: () => this.setApproval(id) }, icon(ic), label)));
    const left = h('span', { class: 'row', style: { gap: '12px' } }, modeBtn);
    if (state.settings.agent && state.settings.agent.computerUse) left.append(h('span', { class: 'row', style: { gap: '5px' } }, icon('monitor'), t('computerUseOn')));
    this.hint.append(left, h('span', { class: 'row', style: { gap: '10px' } }, this.ctxMeter || '', h('a', { onclick: () => this.d.showContextPreview(state.mode) }, t('contextPreview'))));
  }

  setApproval(mode) {
    const pol = { ...(state.settings.agent.policy || {}), ...APPROVAL_MODES[mode] };
    emit('save-settings', { agent: { policy: pol } });
  }

  setMode(m) {
    this.mode = m;
    state.mode = m;
    this.renderBar();
    this.ta.placeholder = m === 'ask' ? t('composerPlaceholderAsk') : m === 'plan' ? t('composerPlaceholderPlan') : t('composerPlaceholder');
  }

  updateSend() {
    if (!this.sendBtn) return;
    const has = this.ta.value.trim() || this.attachments.length;
    if (this.running && !this.ta.value.trim()) { this.sendBtn.className = 'send-btn stop'; this.sendBtn.replaceChildren(icon('stop')); this.sendBtn.disabled = false; this.sendBtn.title = t('stop'); }
    else { this.sendBtn.className = 'send-btn'; this.sendBtn.replaceChildren(icon('arrowUp')); this.sendBtn.disabled = !has; this.sendBtn.title = this.running ? tr('Queue message', 'В очередь') : t('send'); }
  }

  // Context meter: real token count reported by the provider for the last request
  // (input + cache read + cache write + output); before the first request — a calibrated estimate.
  updateCtx(usage) {
    if (!this.ctxMeter) return;
    const cm = currentModel();
    if (!cm) { clear(this.ctxMeter); return; }
    if (usage) {
      const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      if (prompt) this.ctxState = { used: prompt + (usage.output || 0), real: true, model: cm.model.id };
    }
    const s = this.ctxState;
    if (!s || s.model !== cm.model.id) { this.estimateCtx(); if (!s) { clear(this.ctxMeter); return; } }
    this.renderCtx(s, cm.model.contextWindow || 128000);
  }

  setCtx(ctx) {
    const cm = currentModel();
    if (ctx && ctx.real && ctx.used && cm && ctx.model === cm.model.id) { this.ctxState = { used: ctx.used, real: true, model: ctx.model }; this.updateCtx(); }
    else { this.ctxState = null; this.estimateCtx(); }
  }

  estimateCtx() {
    clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(async () => {
      const cm = currentModel();
      if (!cm || !this.ctxMeter) return;
      try {
        const b = await api.invoke('agent:context', this.chatId, { mode: this.mode, modelRef: state.modelRef });
        if (b.real && b.real.used) this.ctxState = { used: b.real.used, real: true, model: b.model };
        else this.ctxState = { used: b.total, real: false, model: b.model };
        this.renderCtx(this.ctxState, b.window);
      } catch {}
    }, 250);
  }

  renderCtx(s, win) {
    const pct = Math.min(100, (s.used / win) * 100);
    const lvl = pct >= 85 ? 'err' : pct >= 60 ? 'warn' : 'ok';
    const C = 2 * Math.PI * 6;
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 16 16'); ring.setAttribute('class', 'ctx-ring');
    ring.innerHTML = `<circle cx="8" cy="8" r="6" class="bg"/><circle cx="8" cy="8" r="6" class="fg" stroke-dasharray="${(C * Math.max(pct, 1.5)) / 100} ${C}" transform="rotate(-90 8 8)"/>`;
    this.ctxMeter.className = `mono ctx-meter ${lvl} ${s.real ? 'real' : 'est'}`;
    this.ctxMeter.replaceChildren(ring, h('span', null, `${s.real ? '' : '~'}${fmtTokens(s.used)} / ${fmtTokens(win)}`), h('span', { class: 'pct' }, `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`));
    this.ctxMeter.title = s.real
      ? tr(`Context: ${s.used.toLocaleString()} of ${win.toLocaleString()} tokens — exact count from the provider for the last request. Click for a breakdown.`, `Контекст: ${s.used.toLocaleString()} из ${win.toLocaleString()} токенов — точное число от провайдера за последний запрос. Нажми — разбивка.`)
      : tr(`Context: about ${s.used.toLocaleString()} of ${win.toLocaleString()} tokens (estimate until the first reply). Click for a breakdown.`, `Контекст: около ${s.used.toLocaleString()} из ${win.toLocaleString()} токенов (оценка до первого ответа). Нажми — разбивка.`);
  }

  // ---------- menus ----------
  modelMenu(anchor) {
    const items = [];
    const cur = currentModel();
    const vendors = state.info.vendors || {};
    let last;
    for (const m of allModels()) {
      const v = m.model.custom ? 'custom' : m.model.vendor || '';
      if (v !== last) { items.push({ header: v === 'custom' ? tr('Your models', 'Свои модели') : (vendors[v] || {}).name || v }); last = v; }
      items.push({ lead: () => modelIcon(m.model, 18), label: m.model.name || m.model.id, sub: m.model.name && m.model.name !== m.model.id ? m.model.id : '', keywords: m.model.id + ' ' + v, on: cur && cur.ref.providerId === m.ref.providerId && cur.ref.modelId === m.ref.modelId, onclick: () => {
        state.modelRef = m.ref;
        emit('save-settings', { defaultModel: m.ref });
        this.renderBar();
        if (!this.chatId) this.renderEmpty();
      } });
    }
    items.push({ sep: true }, { label: tr('API & models…', 'API и модели…'), icon: 'settings', onclick: () => this.d.openSettings() });
    popMenu(anchor, items, { search: tr('Search models', 'Поиск моделей'), above: true, checks: true, minWidth: 320, maxHeight: 460 });
  }

  reasoningMenu(anchor) {
    const r = state.reasoning || {};
    const set = (enabled, effort) => { state.reasoning = { enabled, effort: effort || r.effort || 'medium' }; emit('save-settings', { reasoning: state.reasoning }); this.renderBar(); };
    const cm = currentModel();
    const style = cm ? cm.model.reasoningStyle : 'none';
    popMenu(anchor, [
      { header: t('reasoning') + (style && style !== 'none' ? ` · ${style}` : '') },
      { label: t('thinkingOff'), on: !r.enabled, onclick: () => set(false) },
      ...['low', 'medium', 'high', 'max'].map((e) => ({ label: cap(e), on: r.enabled && r.effort === e, onclick: () => set(true, e) })),
      ...(style === 'none' ? [{ sep: true }, { label: tr('This model has no reasoning style set — Settings → Models', 'У модели не задан стиль reasoning — Настройки → Модели'), icon: 'info', onclick: () => this.d.openSettings('providers') }] : []),
    ], { above: true, checks: true, minWidth: 220 });
  }

  attachMenu(anchor) {
    popMenu(anchor, [
      { label: tr('Files from Mac… (any type, zip)', 'Файлы с Mac… (любые, zip)'), icon: 'file', onclick: () => this.pickFiles(false) },
      { label: tr('Folder…', 'Папка…'), icon: 'folder', onclick: () => this.pickFiles(true) },
      { label: tr('Screenshot of an area', 'Скриншот области'), icon: 'image', onclick: () => this.captureScreen(false) },
      { label: tr('Screenshot of the whole screen', 'Скриншот всего экрана'), icon: 'image', onclick: () => this.captureScreen(true) },
      { sep: true },
      { label: tr('Current file', 'Текущий файл'), icon: 'file', onclick: () => this.addCurrentFile() },
      { label: tr('Selection (⌘L)', 'Выделение (⌘L)'), icon: 'edit', onclick: () => this.addSelection() },
      { label: tr('Git changes (diff)', 'Изменения git (diff)'), icon: 'git', onclick: () => this.addGitDiff() },
      { label: tr('Terminal output', 'Вывод терминала'), icon: 'terminal', onclick: () => this.addTerminal() },
    ], { above: true, minWidth: 260 });
  }

  async historyMenu(anchor) {
    let list = [];
    try { list = await api.invoke('chat:list', state.root || null); } catch {}
    const items = list.length ? list.map((c) => ({ icon: c.pinned ? 'pin' : c.worktree ? 'git' : 'message', label: c.title || t('newChat'), sub: relTime(c.updated), on: c.id === this.chatId, keywords: c.title, onclick: () => this.openChat(c.id) })) : [{ label: t('noChats'), onclick: () => {} }];
    popMenu(anchor, [
      { label: t('newChat'), icon: 'newChat', sub: '⌘⇧L', onclick: () => this.newChat() },
      { label: tr('New chat tab', 'Новая вкладка чата'), icon: 'plus', sub: '⌘T', onclick: () => this.d.tabs && this.d.tabs.newTab() },
      { label: tr('Search in all chats…', 'Поиск по всем чатам…'), icon: 'search', onclick: () => this.searchChats() },
      { sep: true }, ...items], { search: tr('Filter by title', 'Фильтр по названию'), minWidth: 360 });
  }

  moreMenu(anchor) {
    popMenu(anchor, [
      { label: this.chat && this.chat.pinned ? tr('Unpin', 'Открепить') : tr('Pin chat', 'Закрепить чат'), icon: 'check', onclick: async () => { if (!this.chatId) return; await api.invoke('chat:pin', this.chatId, !(this.chat && this.chat.pinned)); if (this.chat) this.chat.pinned = !this.chat.pinned; } },
      { label: tr('Side chat (fork here)', 'Боковой чат (ответвить)'), icon: 'git', onclick: () => this.fork(null, true) },
      { label: tr('Compact context now', 'Сжать контекст сейчас'), icon: 'layers', onclick: () => this.compactNow() },
      { label: tr('Rename chat', 'Переименовать чат'), icon: 'edit', onclick: async () => { if (!this.chatId) return; const n = await promptDialog(tr('Rename chat', 'Переименовать чат'), '', this.chat && this.chat.title); if (n) { await api.invoke('chat:rename', this.chatId, n); this.setTitle(n); } } },
      { label: tr('Export as Markdown', 'Экспорт в Markdown'), icon: 'download', onclick: () => this.exportChat() },
      { label: tr('Delete chat', 'Удалить чат'), icon: 'trash', onclick: async () => { if (!this.chatId) return; if (await confirmDialog(tr('Delete chat', 'Удалить чат'), this.chat ? this.chat.title : '', t('delete'), true)) { await api.invoke('chat:delete', this.chatId); this.newChat(); } } },
      { sep: true },
      { label: t('contextPreview'), icon: 'eye', onclick: () => this.d.showContextPreview(state.mode) },
      { label: t('requestLog'), icon: 'activity', onclick: () => emit('cmd', 'request-log') },
      { label: t('settings'), icon: 'settings', onclick: () => this.d.openSettings('agent') },
    ], { alignRight: true, minWidth: 220 });
  }

  // ---------- chat lifecycle ----------
  setTitle(title) { this.titleEl.querySelector('.t').textContent = title || t('newChat'); if (this.chat) this.chat.title = title; this.title = title; this.notify(); }

  notify() { if (this.d.tabs) this.d.tabs.update(this); }

  newChat() {
    if (this.running) this.detachRun();
    this.chatId = null; this.chat = null; this.cards.clear();
    this.lastUsage = null; this.ctxState = null; this.estimateCtx();
    this.useWorktree = false;
    this.setTitle('');
    this.todoDock.classList.add('hidden');
    this.changesDock.classList.add('hidden');
    this.wtDock.classList.add('hidden');
    this.renderEmpty();
    this.renderBar();
    this.ta.focus();
  }

  detachRun() { this.runId = null; this.running = false; this.pendingApprovals = 0; this.updateSend(); this.notify(); }

  // Open a chat — in the tab where it is already open, otherwise here.
  openChat(id) {
    if (this.d.tabs && this.d.tabs.focusChat(id)) return;
    if (this.running && this.d.tabs) { this.d.tabs.newTab().loadChat(id); return; }
    this.loadChat(id);
  }

  async loadChat(id) {
    if (this.running) this.detachRun();
    let chat;
    try { chat = await api.invoke('chat:get', id); } catch (e) { toast(e.message, 'error'); return; }
    if (!chat) return;
    this.chatId = chat.id;
    this.chat = chat;
    this.ctxState = null;
    this.setTitle(chat.title);
    if (chat.lastModel) { const ok = allModels().some((m) => m.ref.providerId === chat.lastModel.providerId && m.ref.modelId === chat.lastModel.modelId); if (ok && !(state.modelRef && state.modelRef.providerId === 'auto')) { state.modelRef = chat.lastModel; } }
    this.renderAll();
    this.renderBar();
    this.renderWorktree();
    // re-attach to a run that is still going (e.g. an automation or another window state)
    try {
      const act = (await api.invoke('agent:active')) || [];
      const r = act.find((x) => x.chatId === chat.id);
      if (r) {
        this.runId = r.runId; this.running = true; this.turnAsst = []; this.runChanges = new Map(); this.updateSend(); this.notify();
        // show approvals that were asked while this chat was not on screen
        for (const req of r.pending || []) {
          if (!this.cards.has(req.callId)) { const card = this.toolCard({ id: req.callId, name: req.name, args: req.args }, true); this.cards.set(req.callId, card); this.msgs.append(card.el); }
          this.handle(req);
        }
      }
    } catch {}
  }

  // ---------- worktree banner ----------
  async renderWorktree() {
    clear(this.wtDock);
    const wt = this.chat && this.chat.worktree;
    if (!wt) { this.wtDock.classList.add('hidden'); return; }
    this.wtDock.classList.remove('hidden');
    let st = null;
    try { st = await api.invoke('wt:status', this.chatId); } catch {}
    const files = (st && st.files) || [];
    const list = h('div', { class: 'tool-body', style: { display: 'block', maxHeight: '140px' } });
    for (const f of files) {
      const row = h('div', { class: 'scm-file' }, h('span', { class: 'fi' }, fileIcon(f.rel, false)), h('span', { class: 'ellipsis' }, f.rel), h('span', { class: 'code', style: { marginLeft: 'auto' } }, f.code === '??' ? 'A' : f.code));
      row.addEventListener('click', async () => { try { const d = await api.invoke('wt:diff', this.chatId, f.rel); this.d.editor.openDiff({ title: `${basename(f.rel)} · worktree`, path: d.path, original: d.original, modified: d.modified, readOnly: true }); } catch (e) { toast(e.message, 'error'); } });
      list.append(row);
    }
    const card = h('div', { class: 'tool open' },
      h('div', { class: 'tool-head' }, h('span', { class: 'ic' }, icon('git')), h('span', { class: 'verb' }, 'Worktree'), h('span', { class: 'target' }, wt.branch + (st && st.shortstat ? ` · ${st.shortstat}` : '')), h('span', { class: 'grow' }),
        btn(tr('Apply to project', 'Применить к проекту'), { cls: 'sm primary', icon: 'check', disabled: !files.length, onclick: async (e) => { e.stopPropagation(); try { const r = await api.invoke('wt:apply', this.chatId); toast(tr(`Applied ${r.applied} file(s)`, `Применено файлов: ${r.applied}`), 'ok'); this.renderWorktree(); emit('cmd', 'refresh-git'); } catch (err) { toast(err.message, 'error', 10000); } } }),
        btn('', { cls: 'sm ghost', icon: 'trash', title: tr('Discard worktree', 'Удалить worktree'), onclick: async (e) => { e.stopPropagation(); if (!(await confirmDialog(tr('Discard worktree', 'Удалить worktree'), tr('Delete the worktree and its branch? Changes not applied will be lost.', 'Удалить worktree и ветку? Неприменённые изменения пропадут.'), t('delete'), true))) return; try { await api.invoke('wt:discard', this.chatId); this.chat.worktree = null; this.renderWorktree(); this.renderBar(); } catch (err) { toast(err.message, 'error'); } } })),
      files.length ? list : null);
    card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
    this.wtDock.append(card);
  }

  // ---------- context ----------
  async contextPopover(anchor) {
    let b;
    try { b = await api.invoke('agent:context', this.chatId, { mode: this.mode, modelRef: state.modelRef }); } catch (e) { toast(e.message, 'error'); return; }
    const labels = { system: tr('System prompt', 'Системный промпт'), rules: tr('Rules', 'Правила'), memory: tr('Memory', 'Память'), tools: tr('Built-in tools', 'Встроенные инструменты'), mcpPlugins: 'MCP + ' + tr('plugins', 'плагины'), summary: tr('Summary (compacted)', 'Сводка (сжато)'), messages: tr('Messages', 'Сообщения'), attachments: tr('Attachments', 'Вложения'), toolResults: tr('Tool results', 'Результаты инструментов'), images: tr('Images', 'Изображения') };
    const colors = { system: '#8ab4ff', rules: '#a78bfa', memory: '#f472b6', tools: '#38bdf8', mcpPlugins: '#14b8a6', summary: '#facc15', messages: '#e5e7eb', attachments: '#fb923c', toolResults: '#5ee08f', images: '#c084fc' };
    const pct = (n) => Math.max(0, Math.min(100, (n / b.window) * 100));
    const bar = h('div', { class: 'ctx-bar' }, ...Object.entries(b.parts).filter(([, v]) => v > 0).map(([k, v]) => h('span', { style: { width: pct(v) + '%', background: colors[k] }, title: `${labels[k]}: ${fmtTokens(v)}` })));
    const rows = Object.entries(b.parts).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]).map(([k, v]) => h('div', { class: 'ctx-row' }, h('span', { class: 'sw', style: { background: colors[k] } }), h('span', { class: 'grow' }, labels[k]), h('span', { class: 'mono' }, fmtTokens(v)), h('span', { class: 'mono muted', style: { width: '44px', textAlign: 'right' } }, pct(v).toFixed(1) + '%')));
    const m = modal({
      title: tr('Context window', 'Контекстное окно'),
      body: h('div', null,
        h('div', { class: 'row', style: { marginBottom: '10px' } }, h('b', null, `${fmtTokens(b.real ? b.real.used : b.total)} / ${fmtTokens(b.window)}`), h('span', { class: 'muted' }, `· ${b.model} · ${b.real ? tr('exact, from the provider (last request)', 'точно, по данным провайдера (последний запрос)') : b.calibrated ? tr('estimate, calibrated', 'оценка, откалибрована') : tr('estimate', 'оценка')}`), b.compacted ? h('span', { class: 'chip' }, tr('compacted', 'сжато')) : null),
        bar, h('div', { style: { marginTop: '12px' } }, ...rows),
        h('p', { class: 'muted', style: { marginTop: '12px', fontSize: '12px' } }, tr('Enide compacts automatically at 80% (Settings → Agent). Compacting replaces older turns with a summary the model writes; the full history stays in the chat.', 'Enide сжимает автоматически при 80% (Настройки → Агент). Сжатие заменяет старые ходы сводкой от модели; полная история остаётся в чате.'))),
      footer: [btn(tr('Compact now', 'Сжать сейчас'), { icon: 'layers', disabled: !this.chatId || this.running, onclick: () => { m.close(); this.compactNow(); } }), btn(t('contextPreview'), { onclick: () => { m.close(); this.d.showContextPreview(this.mode); } })],
    });
  }

  async compactNow() {
    if (!this.chatId) return;
    if (this.running) { toast(tr('Stop the agent first', 'Сначала останови агента'), 'error'); return; }
    const note = h('div', { class: 'notice' }, h('span', { class: 'spin' }), h('div', { class: 'body' }, tr('Compacting…', 'Сжимаю контекст…')));
    this.msgs.append(note); this.scrollBottom(true);
    try {
      const c = await api.invoke('agent:compact', this.chatId, { modelRef: state.modelRef });
      note.remove();
      if (!c) { toast(tr('Nothing to compact', 'Нечего сжимать'), 'info'); return; }
      await this.loadChat(this.chatId);
      toast(tr('Context compacted', 'Контекст сжат'), 'ok');
    } catch (e) { note.remove(); toast(e.message, 'error'); }
  }

  compactionDivider(c) {
    const body = h('div', { class: 'thinking-body' }, c.summary);
    const el = h('div', { class: 'thinking compact-divider' }, h('div', { class: 'thinking-head' }, icon('layers'), h('span', { class: 'label' }, tr(`Earlier messages compacted · ${c.coveredMessages || ''} messages → summary`, `Ранние сообщения сжаты · ${c.coveredMessages || ''} сообщ. → сводка`)), icon('chevron', 'chev')), body);
    el.querySelector('.thinking-head').addEventListener('click', () => el.classList.toggle('open'));
    return el;
  }

  async fork(messageId, inclusive) {
    if (!this.chatId) return;
    try {
      const r = await api.invoke('chat:fork', this.chatId, messageId, { inclusive });
      const tab = this.d.tabs ? this.d.tabs.newTab() : this;
      await tab.loadChat(r.chat.id);
      if (r.prefill) { tab.ta.value = r.prefill; tab.autosize(); tab.updateSend(); }
      tab.focus();
    } catch (e) { toast(e.message, 'error'); }
  }

  searchChats() {
    const input = h('input', { class: 'input', placeholder: tr('Search all chats…', 'Поиск по всем чатам…') });
    const results = h('div', { style: { marginTop: '10px', maxHeight: '420px', overflow: 'auto' } });
    let timer;
    const run = async () => {
      clear(results);
      if (!input.value.trim()) return;
      const list = await api.invoke('chat:search', input.value, null).catch(() => []);
      const all = list.length ? list : await api.invoke('chat:search', input.value).catch(() => []);
      if (!all.length) { results.append(h('div', { class: 'muted' }, t('noResults'))); return; }
      for (const r of all) results.append(h('div', { class: 'recent-item', style: { display: 'block', fontFamily: 'var(--font)' }, onclick: () => { m.close(); this.openChat(r.id); } }, h('div', { style: { color: 'var(--fg)', fontWeight: 600 } }, r.title || t('newChat')), h('div', { class: 'muted', style: { fontSize: '12px' } }, r.snippet), h('div', { class: 'muted', style: { fontSize: '11px' } }, relTime(r.updated))));
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
    const m = modal({ title: tr('Search chats', 'Поиск по чатам'), body: h('div', null, input, results), size: 'md' });
    setTimeout(() => input.focus(), 30);
  }

  renderEmpty() {
    if (this.stars) { this.stars.destroy(); this.stars = null; }
    clear(this.msgs);
    const empty = h('div', { class: 'chat-empty' },
      h('h2', { class: 'display' }, t('chatEmptyTitle')),
      h('p', null, t('chatEmptySub')),
      this.connectionPill());
    this.msgs.append(empty);
  }

  // Which model answers, whether a key is set, and a one-click real connection test.
  connectionPill() {
    const cm = currentModel();
    const pill = h('div', { class: 'conn' });
    const render = (status, text, extra) => {
      clear(pill);
      pill.className = `conn ${status}`;
      const ic = status === 'ok' ? icon('check') : status === 'bad' ? icon('alert') : status === 'wait' ? h('span', { class: 'spinner' }) : icon('plug');
      pill.append(h('span', { class: 'conn-ic' }, ic), h('span', { class: 'conn-text' }, text), ...(extra || []));
    };
    if (!cm) { render('bad', tr('No model yet', 'Модели пока нет'), [btn(tr('Add model', 'Добавить модель'), { cls: 'sm', onclick: () => this.d.openSettings('providers') })]); return pill; }
    const keyless = cm.provider.authStyle === 'none';
    const hasKey = keyless || !!(state.keyHints || {})[cm.provider.id];
    const label = cm.model.name || cm.model.id;
    pill.title = `${cm.provider.name} · ${cm.model.id}`;
    if (!hasKey) { render('bad', `${label} — ${tr('no API key', 'нет API-ключа')}`, [btn(tr('Add key', 'Вставить ключ'), { cls: 'sm', onclick: () => this.d.openSettings('providers') })]); return pill; }
    const test = async () => {
      render('wait', tr('Checking the connection…', 'Проверяю подключение…'));
      try {
        const r = await api.invoke('providers:test', cm.provider.id, cm.model.id, false);
        if (r.ok) render('ok', `${label} — ${tr('connected', 'подключено')} · ${(r.firstTokenMs || r.ms) / 1000 < 10 ? ((r.firstTokenMs || r.ms) / 1000).toFixed(1) : Math.round((r.firstTokenMs || r.ms) / 1000)} ${tr('s', 'с')}`, [h('a', { class: 'conn-link', onclick: test }, tr('again', 'ещё раз'))]);
        else render('bad', `${label} — ${String(r.error || '').slice(0, 140)}`, [btn(tr('Settings', 'Настройки'), { cls: 'sm', onclick: () => this.d.openSettings('providers') })]);
      } catch (e) { render('bad', `${label} — ${e.message}`); }
    };
    render('idle', label, [h('a', { class: 'conn-link', onclick: test }, tr('Test connection', 'Проверить подключение'))]);
    return pill;
  }

  clearEmpty() {
    if (this.stars) { this.stars.destroy(); this.stars = null; }
    const e = this.msgs.querySelector('.chat-empty');
    if (e) e.remove();
  }

  renderAll() {
    this.clearEmpty();
    clear(this.msgs);
    this.cards.clear();
    const msgs = (this.chat && this.chat.messages) || [];
    if (!msgs.length) { this.renderEmpty(); return; }
    const results = new Map();
    for (const m of msgs) if (m.role === 'tool') for (const b of m.content) results.set(b.id, b);
    let turn = null;
    const finishTurn = () => { if (turn && turn.asst.length) this.msgs.append(this.turnMeta(turn.asst)); };
    let todos = null;
    const comp = this.chat && this.chat.compaction;
    for (const m of msgs) {
      if (comp && comp.untilId === m.id) this.msgs.append(this.compactionDivider(comp));
      if (m.role === 'user' && m.meta && m.meta.hook) {
        this.msgs.append(h('div', { class: 'notice' }, icon('hook'), h('div', { class: 'body' }, tr('Stop hook sent the agent back: ', 'Stop-хук вернул агента к работе: '), (m.content[0].text || '').replace(/<\/?stop-hook-feedback>/g, '').trim())));
      } else if (m.role === 'user') {
        finishTurn();
        turn = { asst: [] };
        this.msgs.append(this.userBubble(m));
      } else if (m.role === 'assistant') {
        if (!turn) turn = { asst: [] };
        turn.asst.push(m);
        const el = h('div', { class: 'msg msg-assistant' });
        for (const b of m.content || []) {
          if (b.type === 'reasoning') { if (b.text || b.redacted) el.append(this.thinking(b.text, b.ms, false, !!b.redacted).el); }
          else if (b.type === 'text') { if (b.text) el.append(this.markdown(b.text)); }
          else if (b.type === 'tool_call') {
            const card = this.toolCard(b);
            this.cards.set(b.id, card);
            const r = results.get(b.id);
            if (r) card.setResult(r);
            el.append(card.el);
            if (b.name === 'todo_write' && b.args && Array.isArray(b.args.todos)) todos = b.args.todos;
          }
        }
        this.msgs.append(el);
        if (m.meta && m.meta.usage) this.lastUsage = m.meta.usage;
      }
    }
    finishTurn();
    if (comp && !comp.untilId) this.msgs.append(this.compactionDivider(comp));
    this.renderTodos(todos);
    this.setCtx(this.chat && this.chat.ctx);
    this.scrollBottom(true);
  }

  turnMeta(asstMsgs) {
    const u = { input: 0, output: 0, cacheRead: 0 };
    let ms = 0;
    let model = '';
    for (const m of asstMsgs) {
      const x = (m.meta && m.meta.usage) || {};
      u.input += x.input || 0; u.output += x.output || 0; u.cacheRead += x.cacheRead || 0;
      ms += (m.meta && m.meta.ms) || 0;
      model = (m.meta && m.meta.modelId) || model;
    }
    const text = asstMsgs.flatMap((m) => (m.content || []).filter((b) => b.type === 'text').map((b) => b.text)).join('\n\n');
    const usd = costOf(asstMsgs);
    const lastId = asstMsgs[asstMsgs.length - 1] && asstMsgs[asstMsgs.length - 1].id;
    return h('div', { class: 'turn-meta' },
      h('span', null, model),
      usd != null ? h('span', { title: tr('cost at the prices set for this model', 'стоимость по ценам модели') }, '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3))) : null,
      h('span', { title: tr('input tokens (incl. cached)', 'входные токены') }, '↑', fmtTokens(u.input + u.cacheRead)),
      h('span', { title: tr('output tokens', 'выходные токены') }, '↓', fmtTokens(u.output)),
      ms ? h('span', null, (ms / 1000).toFixed(1) + 's') : null,
      h('span', { class: 'grow' }),
      iconBtn('refresh', tr('Retry this answer', 'Повторить ответ'), (e) => this.retryTurn(e.currentTarget.closest('.turn-meta'))),
      lastId && lastId !== 'live' ? iconBtn('git', tr('Fork chat from here', 'Ответвить чат отсюда'), () => this.fork(lastId, true)) : null,
      text ? iconBtn('copy', t('copy'), () => { navigator.clipboard.writeText(text); toast(t('copied'), 'ok', 1200); }) : null);
  }

  userBubble(m) {
    const chips = h('div', { class: 'chips' });
    const imgs = h('div', { class: 'imgs' });
    let text = '';
    for (const b of m.content || []) {
      if (b.type === 'image') imgs.append(h('img', { src: `data:${b.mediaType};base64,${b.data}`, alt: b.name || 'image' }));
      else if (b.type === 'text' && b.attachment) chips.append(this.chip(b.attachment));
      else if (b.type === 'text') text += (text ? '\n' : '') + b.text;
    }
    const el = h('div', { class: 'msg msg-user', 'data-id': m.id },
      chips.childNodes.length ? chips : null, imgs.childNodes.length ? imgs : null,
      h('div', { class: 'text', title: tr('Click to edit', 'Нажми, чтобы изменить') }, text),
      h('div', { class: 'actions' },
        btn(tr('Edit', 'Изменить'), { cls: 'sm', icon: 'edit', onclick: () => this.editMessage(el, m, text) }),
        btn(t('restoreCheckpoint'), { cls: 'sm', icon: 'undo', onclick: () => this.restore(m.id) }),
        btn('', { cls: 'sm', icon: 'git', title: tr('Edit in a new branch (fork)', 'Изменить в новой ветке (форк)'), onclick: () => this.fork(m.id, false) }),
        btn('', { cls: 'sm', icon: 'copy', title: t('copy'), onclick: () => navigator.clipboard.writeText(text) })));
    el.querySelector('.text').addEventListener('click', () => { if (!window.getSelection().toString()) this.editMessage(el, m, text); });
    return el;
  }

  // Re-run a turn: roll the chat (and the files it changed) back to its question and ask again.
  async retryTurn(metaEl) {
    if (this.running) { toast(tr('Stop the agent first', 'Сначала останови агента'), 'error'); return; }
    let el = metaEl && metaEl.previousElementSibling;
    while (el && !el.classList.contains('msg-user')) el = el.previousElementSibling;
    if (!el || !this.chatId) return;
    const text = (el.querySelector('.text') || {}).textContent || '';
    try {
      const r = await api.invoke('agent:restore', this.chatId, el.dataset.id, { truncate: true, revertFiles: true });
      await this.loadChat(this.chatId);
      this.attachments = (r && r.attachments) || [];
      this.send((r && r.text) || text);
    } catch (e) { toast(e.message, 'error'); }
  }

  // Cursor-style: edit a sent message in place, roll the chat (and optionally files) back to it, resend.
  editMessage(el, m, text) {
    if (el.classList.contains('editing')) return;
    if (this.running) { toast(tr('Stop the agent first', 'Сначала останови агента'), 'error'); return; }
    if (!this.chatId) return;
    el.classList.add('editing');
    const ta = h('textarea', { class: 'edit-ta', rows: 1 });
    ta.value = text;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(320, ta.scrollHeight) + 'px'; };
    let revert = true;
    const revertSw = h('label', { class: 'check edit-revert', title: tr('Undo file changes the agent made after this message', 'Откатить изменения файлов, которые агент сделал после этого сообщения') },
      toggle(true, (v) => { revert = v; }), tr('revert files', 'откатить файлы'));
    const cancel = () => { el.classList.remove('editing'); box.remove(); };
    const submit = async () => {
      const v = ta.value.trim();
      if (!v) return;
      sendBtn.disabled = true;
      try {
        const r = await api.invoke('agent:restore', this.chatId, m.id, { truncate: true, revertFiles: revert });
        await this.loadChat(this.chatId);
        this.attachments = (r && r.attachments) || [];
        this.send(v);
      } catch (e) { toast(e.message, 'error'); sendBtn.disabled = false; }
    };
    const sendBtn = btn(tr('Send', 'Отправить'), { cls: 'sm primary', icon: 'arrowUp', onclick: submit });
    const box = h('div', { class: 'edit-box' }, ta,
      h('div', { class: 'edit-bar' }, revertSw, h('span', { class: 'grow' }), h('span', { class: 'muted edit-hint' }, '⏎ / Esc'),
        btn(tr('Cancel', 'Отмена'), { cls: 'sm ghost', onclick: cancel }), sendBtn));
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    el.append(box);
    setTimeout(() => { fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }

  chip(a) {
    const label = a.kind === 'selection' ? `${basename(a.path)}:${a.startLine}-${a.endLine}` : a.kind === 'terminal' ? 'terminal' : a.label || basename(a.path || '') || a.kind;
    const ic = a.kind === 'docs' ? icon('book') : a.kind === 'folder' ? fileIcon('', true) : a.kind === 'terminal' ? icon('terminal') : a.kind === 'git' ? icon('git') : a.kind === 'archive' ? icon('layers') : fileIcon(a.path || label, false);
    const c = h('span', { class: 'chip', title: a.path || label }, ic, h('span', { class: 'ellipsis' }, label));
    if (a.path && a.kind !== 'folder') c.style.cursor = 'pointer', c.addEventListener('click', () => this.d.editor.openFile(a.path, { line: a.startLine, endLine: a.endLine }));
    return c;
  }

  async restore(messageId) {
    if (this.running) { toast(tr('Stop the agent first', 'Сначала останови агента'), 'error'); return; }
    if (!(await confirmDialog(t('restoreCheckpoint'), t('restoreConfirm'), t('restoreCheckpoint'), true))) return;
    try {
      const r = await api.invoke('agent:restore', this.chatId, messageId);
      toast(t('restored', { n: r.restored.length }), 'ok');
      await this.loadChat(this.chatId);
      this.ta.value = r.text || '';
      this.attachments = r.attachments || []; this.renderAttachments();
      this.autosize(); this.updateSend(); this.ta.focus();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- rendering pieces ----------
  mdOpts() {
    return {
      onLink: (href) => api.invoke('app:open-external', href),
      onPath: (p) => {
        const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(p);
        const abs = m[1].startsWith('/') ? m[1] : (state.root ? state.root + '/' + m[1] : m[1]);
        this.d.editor.openFile(abs, { line: m[2] ? +m[2] : undefined, endLine: m[3] ? +m[3] : undefined });
      },
      onApply: ({ code, path }) => {
        if (path) { const abs = path.startsWith('/') ? path : (state.root || '') + '/' + path; this.d.editor.proposeFileContent(abs, code); }
        else if (state.activeFile) this.d.editor.proposeFileContent(state.activeFile, code);
        else toast(tr('Open a file first, or ask for a code block with a file path.', 'Сначала открой файл.'), 'error');
      },
      onInsert: ({ code }) => { if (!this.d.editor.insertAtCursor(code)) toast(tr('Open a file to insert into.', 'Открой файл для вставки.')); },
      onRun: (code) => this.d.panel.runInTerminal(code),
      colorize: (el, code, lang) => this.d.editor.colorize(el, code, lang),
    };
  }

  markdown(text, live) {
    const el = renderMarkdown(text, this.mdOpts());
    if (live) el.classList.add('caret');
    return el;
  }

  thinking(text, ms, live, redacted) {
    const body = h('div', { class: 'thinking-body' }, redacted ? tr('(reasoning redacted by the provider)', '(размышления скрыты провайдером)') : text || '');
    const label = h('span', { class: 'label' }, live ? t('thinking') + '…' : ms ? t('thought', { s: Math.max(1, Math.round(ms / 1000)) }) : t('reasoning'));
    const el = h('div', { class: `thinking ${live ? 'live' : ''}` }, h('div', { class: 'thinking-head' }, label, icon('chevron', 'chev')), body);
    el.querySelector('.thinking-head').addEventListener('click', () => el.classList.toggle('open'));
    let buf = text || '';
    const started = Date.now();
    return {
      el,
      append: (s) => { buf += s; body.textContent = buf; if (el.classList.contains('open')) body.scrollTop = body.scrollHeight; },
      end: (msEnd) => { el.classList.remove('live'); label.textContent = t('thought', { s: Math.max(1, Math.round((msEnd || Date.now() - started) / 1000)) }); if (!buf.trim()) label.textContent = tr('Thought (hidden by provider)', 'Размышлял (скрыто провайдером)'); },
    };
  }

  toolCard(call, live) {
    const name = call.name;
    const isMcp = name.startsWith('mcp__');
    const isPlugin = name.startsWith('plugin__');
    const meta = TOOL_META[name] || { icon: isMcp ? 'plug' : isPlugin ? 'puzzle' : 'wrench', verb: null };
    const verbEl = h('span', { class: 'verb' }, meta.verb ? verbText(meta.verb) : name.split('__').pop());
    const target = h('span', { class: 'target' });
    const stat = h('span', { class: 'stat' });
    const body = h('div', { class: 'tool-body' });
    const head = h('div', { class: 'tool-head' }, h('span', { class: 'ic' }, icon(meta.icon)), verbEl, target, stat);
    const el = h('div', { class: `tool ${name === 'task' ? 'subagent' : ''}` }, head, body);
    let subWrap = null, subLine = null, subBuf = '', hooksEl = null;
    if (name === 'task') {
      subLine = h('div', { class: 'sub-line' });
      subWrap = h('div', { class: 'sub-steps' });
      body.append(subLine, subWrap);
      el.classList.add('open');
    }
    head.addEventListener('click', (e) => {
      if (e.target.closest('.target') && args && args.path && !['list_dir', 'glob', 'grep'].includes(name)) {
        const abs = args.path.startsWith('/') ? args.path : (state.root || '') + '/' + args.path;
        this.d.editor.openFile(abs, { line: args.offset });
        return;
      }
      el.classList.toggle('open');
    });
    let args = call.args;
    const setTarget = (a) => {
      args = a || args;
      let s = shortArgs(name, args);
      if (args && args.path && state.root) s = relPath(state.root, s.startsWith('/') ? s : s);
      if (isMcp) s = `${name.split('__')[1]} · ${s}`;
      target.textContent = name === 'run_command' ? `$ ${s}` : s;
      if (name === 'write_file' && !live) verbEl.textContent = t('edited');
    };
    if (args) setTarget(args);
    if (live) stat.replaceChildren(h('span', { class: 'spin' }));
    let outPre = null;
    const ctl = {
      el, call,
      addSub: (child) => { if (subWrap) { subWrap.append(child); this.scrollBottom(); } },
      subText: (tx) => { if (!subLine) return; subBuf = (subBuf + tx).slice(-400); const last = subBuf.split('\n').filter((l) => l.trim()).pop() || ''; subLine.textContent = last ? '› ' + last.slice(-160) : ''; },
      addHook: (line, ev) => { if (!hooksEl) { hooksEl = h('div', { class: 'hook-lines' }); el.insertBefore(hooksEl, body); } hooksEl.append(h('div', { title: (ev.stderr || ev.stdout || '').slice(0, 1000), class: ev.code === 2 ? 'blocked' : '' }, '⚡ ' + line)); },
      setPartial: (p) => { const s = partialPath(p); if (s) target.textContent = name === 'run_command' ? `$ ${s}` : relPath(state.root, s); },
      setArgs: (a) => { setTarget(a); if (isMcp || isPlugin) { clear(body); body.append(jsonHighlight(a || {})); } if (name === 'task' && a) { verbEl.textContent = `${verbText('subagent')} · ${a.type === 'general' ? 'general' : 'explore'}`; } },
      setRunning: () => { stat.replaceChildren(h('span', { class: 'spin' })); el.classList.remove('pending'); const ap = el.querySelector('.approval'); if (ap) ap.remove(); if (name === 'run_command') { el.classList.add('open'); this.renderCommand(body, args, ''); outPre = body.querySelector('pre'); } },
      setOutput: (text) => { if (outPre) { outPre.textContent = text; outPre.scrollTop = outPre.scrollHeight; } },
      setArgs: (a) => setTarget(a),
      setApproval: (req, decide) => {
        el.classList.add('pending', 'open');
        const reasonKey = { command: 'approvalCommand', write: 'approvalWrite', outside: 'approvalOutside', deny: 'approvalDeny', mcp: 'approvalMcp', plugin: 'approvalPlugin', computer: 'approvalComputer', network: 'approvalNetwork' }[req.reason] || 'approvalOther';
        clear(body);
        if (req.preview && req.preview.kind === 'diff') body.append(this.diffView(req.preview));
        else if (req.preview && req.preview.kind === 'command') this.renderCommand(body, { command: req.preview.command, cwd: req.preview.cwd }, null);
        else if (req.preview && req.preview.kind === 'delete') body.append(h('pre', null, req.preview.path));
        else body.append(jsonHighlight(req.args || {}));
        const prefix = (req.allowKey || '').replace(/^run_command:/, '');
        const ap = h('div', { class: 'approval' },
          h('div', { class: 'q' }, t(reasonKey), h('span', { class: 'ap-keys' }, (api.platform === 'win32' ? 'Ctrl+Enter' : '⌘⏎') + tr(' allow · Esc reject', ' разрешить · Esc отклонить'))),
          btn(name === 'run_command' ? t('allowRun') : t('allow'), { cls: 'primary', icon: name === 'run_command' ? 'play' : 'check', onclick: () => decide({ action: 'allow' }) }),
          req.reason !== 'deny' ? btn(name === 'run_command' && prefix ? `${t('allowAlways')}: ${prefix}` : t('allowTask'), { onclick: () => decide({ action: 'always' }) }) : null,
          name === 'run_command' ? btn(tr('Edit', 'Изменить'), { cls: 'ghost', icon: 'edit', title: tr('Edit the command, then run it', 'Изменить команду и запустить'), onclick: async () => {
            const cmd = await promptDialog(tr('Edit command', 'Изменить команду'), '', (req.args && req.args.command) || '');
            if (cmd != null && cmd.trim()) decide({ action: 'allow', args: { command: cmd.trim() } });
          } }) : null,
          btn(t('reject'), { cls: 'ghost ap-reject', onclick: () => decide({ action: 'reject' }) }),
          btn('', { cls: 'ghost', icon: 'message', title: t('rejectWithNote'), onclick: async () => { const note = await promptDialog(t('rejectWithNote'), tr('What should it do instead?', 'Что сделать вместо этого?')); if (note != null) decide({ action: 'reject', message: note }); } }));
        el.append(ap);
        stat.replaceChildren(h('span', { class: 'muted' }, '⏸'));
        this.scrollBottom();
      },
      setResult: (r) => {
        el.classList.remove('pending');
        const ap = el.querySelector('.approval'); if (ap) ap.remove();
        stat.replaceChildren();
        const d = r.display;
        if (r.isError) {
          el.classList.add('error');
          stat.append(h('span', { class: 'err' }, r.rejected ? tr('rejected', 'отклонено') : tr('error', 'ошибка')));
          if (subWrap) body.append(h('pre', null, r.output || '')); else { clear(body); body.append(h('pre', null, r.output || '')); }
          return;
        }
        el.classList.remove('error');
        const preview = r.preview || (r.images && r.images[0]);
        if (d && d.kind === 'subagent') {
          stat.append(`${d.toolCount || 0} ${tr('tools', 'инстр.')}`);
          if (subLine) subLine.textContent = '';
          const rep2 = h('div', { class: 'sub-report' }, this.markdown(r.output || ''));
          body.append(rep2);
          if (!live) el.classList.remove('open');
        } else if (d && d.kind === 'problems') {
          const errs = d.items.filter((x) => x.severity === 'error').length;
          stat.append(h('span', { class: errs ? 'err' : '' }, d.items.length ? `${errs} err · ${d.items.length - errs} warn` : '✓'));
          clear(body);
          const list = h('div', { class: 'problems' });
          for (const it of d.items.slice(0, 80)) list.append(this.problemRow(it));
          if (!d.items.length) list.append(h('div', { class: 'muted', style: { padding: '8px 12px' } }, (d.ran || []).length ? tr('No problems ', 'Проблем нет ') + `(${d.ran.join(', ')})` : r.output));
          body.append(list);
        } else if (d && d.kind === 'memory') {
          stat.append(d.scope);
          clear(body); body.append(h('pre', null, `${d.action}: ${d.text || ''}\n${d.path}`));
        } else if (d && d.kind === 'browser') {
          stat.append(d.title ? d.title.slice(0, 40) : '');
          clear(body);
          if (preview) body.append(h('img', { class: 'tool-shot', src: `data:${preview.mediaType};base64,${preview.data}` }));
          body.append(h('pre', null, (r.output || '').slice(0, 6000)));
        } else if (d && d.kind === 'diff') {
          verbEl.textContent = d.created ? t('created') : t('edited');
          stat.append(h('span', { class: 'add' }, `+${d.added ?? '?'}`), h('span', { class: 'del' }, `−${d.removed ?? '?'}`));
          clear(body); body.append(this.diffView(d));
          if (!live) el.classList.remove('open');
        } else if (d && d.kind === 'command') {
          if (d.background) stat.append(t('background'));
          else stat.append(h('span', { class: d.exitCode === 0 ? '' : 'err' }, d.timedOut ? 'timeout' : t('exit', { c: d.exitCode })));
          clear(body); this.renderCommand(body, { command: d.command, cwd: d.cwd }, d.output, d);
          if (!live || d.exitCode === 0) el.classList.remove('open');
        } else if (d && d.kind === 'todos') {
          clear(body); body.append(this.todoList(d.todos));
          stat.append(`${d.todos.filter((x) => x.status === 'completed').length}/${d.todos.length}`);
          el.classList.add('open');
        } else if (d && d.kind === 'computer') {
          stat.append(d.w ? `${d.w}×${d.h}` : '');
          clear(body);
          if (preview) body.append(h('img', { class: 'tool-shot', src: `data:${preview.mediaType};base64,${preview.data}` }));
          body.append(h('pre', null, r.output || ''));
        } else {
          const out = r.output || '';
          if (name === 'read_file' && d && d.lines) stat.append(t('lines', { n: d.lines }));
          else if (name === 'grep' || name === 'glob') { const n = out.startsWith('No ') ? 0 : out.split('\n').filter((l) => l && !l.startsWith('…')).length; stat.append(String(n)); }
          clear(body);
          if (isMcp || isPlugin) body.append(h('div', { class: 'group-title', style: { margin: '8px 12px 0' } }, 'input'), jsonHighlight(args || {}), h('div', { class: 'group-title', style: { margin: '8px 12px 0' } }, 'output'));
          if (preview) body.append(h('img', { class: 'tool-shot', src: `data:${preview.mediaType};base64,${preview.data}` }));
          body.append(h('pre', null, out.length > 20000 ? out.slice(0, 20000) + '\n…' : out));
        }
        if (r.ms > 1500) stat.append(h('span', null, (r.ms / 1000).toFixed(1) + 's'));
      },
    };
    return ctl;
  }

  problemRow(it) {
    const row = h('div', { class: `problem ${it.severity}` }, h('span', { class: 'sev' }, icon(it.severity === 'error' ? 'xCircle' : it.severity === 'warning' ? 'alert' : 'info')),
      h('span', { class: 'loc mono' }, `${relPath(state.root, it.file)}:${it.line}`), h('span', { class: 'msg' }, it.title ? `${it.title} — ${it.body || ''}` : it.message), it.source ? h('span', { class: 'src' }, it.code || it.source) : null);
    row.addEventListener('click', () => this.d.editor.openFile(it.file, { line: it.line, col: it.col }));
    return row;
  }

  renderCommand(body, a, output, d) {
    clear(body);
    const pre = h('pre', null, output == null ? '' : output);
    body.append(h('div', { class: 'term-card' },
      h('div', { class: 'window-bar' }, h('div', { class: 'lights' }, h('i'), h('i'), h('i')), h('span', { class: 't' }, `zsh · ${basename(a.cwd || state.root || '~')}`),
        h('span', { class: 'grow' }), iconBtn('play', tr('Run in terminal', 'Запустить в терминале'), (e) => { e.stopPropagation(); this.d.panel.runInTerminal(a.command); }, 'sm')),
      h('pre', { class: 'cmd' }, '$ ' + (a.command || '')),
      output == null ? null : pre,
      d && !d.background ? h('div', { class: 'exit' }, d.timedOut ? 'timed out' : `exit ${d.exitCode}`) : null));
  }

  diffView(d) {
    const wrap = h('div', { class: 'diff' });
    if (d.tooLarge || !d.hunks) { wrap.append(h('div', { class: 'hunk-h' }, tr('Diff too large to show — open the file to review.', 'Дифф слишком большой — открой файл.'))); return wrap; }
    for (const hk of d.hunks) {
      wrap.append(h('div', { class: 'hunk-h' }, `@@ ${hk.aStart} → ${hk.bStart}`));
      let a = hk.aStart, b = hk.bStart;
      for (const l of hk.lines) {
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
        const no = l.t === '-' ? a : b;
        wrap.append(h('div', { class: `ln ${cls}` }, h('span', { class: 'no' }, String(no)), h('span', { class: 'sg' }, l.t === ' ' ? '' : l.t), h('span', { class: 'tx' }, l.s)));
        if (l.t !== '+') a++;
        if (l.t !== '-') b++;
      }
    }
    if (d.truncated) wrap.append(h('div', { class: 'hunk-h' }, '…'));
    if (d.path) wrap.append(h('div', { class: 'diff-actions' }, btn(tr('Open file', 'Открыть файл'), { cls: 'sm', icon: 'file', onclick: () => this.d.editor.openFile(d.path) })));
    return wrap;
  }

  todoList(todos) {
    return h('div', { class: 'todos' }, ...(todos || []).map((x) => h('div', { class: `todo ${x.status}` }, h('span', { class: 'box' }), h('span', null, x.content))));
  }

  renderTodos(todos) {
    clear(this.todoDock);
    if (!todos || !todos.length || todos.every((x) => x.status === 'completed')) { this.todoDock.classList.add('hidden'); return; }
    this.todoDock.classList.remove('hidden');
    const done = todos.filter((x) => x.status === 'completed').length;
    const card = h('div', { class: 'tool open' }, h('div', { class: 'tool-head' }, h('span', { class: 'ic' }, icon('list')), h('span', { class: 'verb' }, t('tasks')), h('span', { class: 'stat' }, `${done}/${todos.length}`)), h('div', { class: 'tool-body', style: { display: 'block', maxHeight: '160px' } }, this.todoList(todos)));
    card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
    this.todoDock.append(card);
  }

  // Cursor-style "files changed" bar after a run: review each file or undo all.
  renderChanges(files, turnId) {
    clear(this.changesDock);
    if (!files.size) { this.changesDock.classList.add('hidden'); return; }
    this.changesDock.classList.remove('hidden');
    const list = h('div', { class: 'tool-body', style: { display: 'block', maxHeight: '170px' } });
    for (const [p, st] of files) {
      const row = h('div', { class: 'scm-file', title: p }, h('span', { class: 'fi' }, fileIcon(p, false)), h('span', { class: 'ellipsis' }, basename(p)), h('span', { class: 'dirn' }, relPath(state.root, dirname(p))),
        h('span', { class: 'stat mono', style: { marginLeft: 'auto', fontSize: '11px' } }, st.deleted ? h('span', { class: 'del' }, tr('deleted', 'удалён')) : [h('span', { style: { color: 'var(--add-fg)' } }, `+${st.added}`), ' ', h('span', { style: { color: 'var(--del-fg)' } }, `−${st.removed}`)]));
      row.addEventListener('click', () => this.reviewFile(turnId, p));
      list.append(row);
    }
    const card = h('div', { class: 'tool open' },
      h('div', { class: 'tool-head' }, h('span', { class: 'ic' }, icon('diff')), h('span', { class: 'verb' }, tr(`${files.size} file(s) changed`, `Изменено файлов: ${files.size}`)), h('span', { class: 'grow' }),
        btn(tr('Undo all', 'Откатить всё'), { cls: 'sm ghost', icon: 'undo', onclick: async (e) => { e.stopPropagation(); if (!(await confirmDialog(tr('Undo all', 'Откатить всё'), tr('Restore every file changed in this turn?', 'Вернуть все файлы, изменённые в этом ходе?'), tr('Undo', 'Откатить'), true))) return; try { const r = await api.invoke('agent:restore', this.chatId, turnId, { truncate: false }); toast(t('restored', { n: r.restored.length }), 'ok'); this.changesDock.classList.add('hidden'); } catch (err) { toast(err.message, 'error'); } } }),
        btn(tr('Keep', 'Оставить'), { cls: 'sm', icon: 'check', onclick: (e) => { e.stopPropagation(); this.changesDock.classList.add('hidden'); } })),
      list);
    card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
    this.changesDock.append(card);
  }

  async reviewFile(turnId, p) {
    try {
      const ch = await api.invoke('agent:turn-changes', this.chatId, turnId);
      const f = ch.find((x) => x.path === p);
      if (!f) return this.d.editor.openFile(p);
      this.d.editor.openDiff({ title: `${basename(p)} · ${tr('agent changes', 'правки агента')}`, path: p, original: f.before, modified: f.after, readOnly: true });
    } catch (e) { toast(e.message, 'error'); }
  }

  scrollBottom(force) {
    if (force || this.stick) requestAnimationFrame(() => { this.msgs.scrollTop = this.msgs.scrollHeight; });
  }

  // ---------- sending ----------
  onKey(e) {
    if (this.popOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.movePop(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.movePop(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.choosePop(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.closePop(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    else if (e.key === 'Escape' && this.running) { e.preventDefault(); this.stop(); }
    else if (e.key === 'Backspace' && !this.ta.value && this.attachments.length) { this.attachments.pop(); this.renderAttachments(); }
  }

  async expandSlash(text) {
    const m = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text);
    if (!m) return text;
    const name = m[1];
    if (name === 'clear' || name === 'new') { this.newChat(); return null; }
    if (name === 'model') { this.modelMenu(this.modelBtn); return null; }
    let cmds = [];
    try { cmds = await api.invoke('slash:list'); } catch {}
    const c = cmds.find((x) => x.name === name);
    if (!c) return text;
    return c.prompt.includes('$ARGUMENTS') ? c.prompt.replace(/\$ARGUMENTS/g, m[2]).trim() : `${c.prompt}\n\n${m[2]}`.trim();
  }

  async send(override) {
    let text = (override != null ? override : this.ta.value).trim();
    if (!text && !this.attachments.length) return;
    if (this.running) {
      this.queue.push({ text, attachments: this.attachments });
      this.ta.value = ''; this.attachments = []; this.renderAttachments(); this.autosize(); this.updateSend();
      toast(tr('Queued — will send when the agent finishes.', 'В очереди — отправлю, когда агент закончит.'), 'info', 2000);
      return;
    }
    text = await this.expandSlash(text);
    if (text == null) { this.ta.value = ''; this.autosize(); return; }
    if (!allModels().length) { toast(tr('Add a model first (Settings → Models).', 'Сначала добавь модель (Настройки → Модели).'), 'error'); this.d.openSettings('providers'); return; }
    const atts = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    this.ta.value = '';
    this.autosize();
    this.startRun({ text, attachments: atts });
  }

  async startRun({ text, attachments, resume }) {
    this.clearEmpty();
    this.changesDock.classList.add('hidden');
    if (!resume) {
      const temp = { id: 'temp', role: 'user', content: [...attachments.map((a) => (a.type === 'image' ? { type: 'image', mediaType: a.mediaType, data: a.data, name: a.name } : { type: 'text', text: '', attachment: { kind: a.kind || a.type, path: a.path, label: a.label, startLine: a.startLine, endLine: a.endLine } })), { type: 'text', text }] };
      this.pendingUserEl = this.userBubble(temp);
      this.msgs.append(this.pendingUserEl);
    }
    this.scrollBottom(true);
    this.running = true;
    this.runChanges = new Map();
    this.updateSend();
    this.awaitingRun = true;
    this.early = [];
    const cm = currentModel();
    try {
      const runId = await api.invoke('agent:send', {
        chatId: this.chatId, text, attachments: (attachments || []).map(stripForSend), mode: this.mode, resume: !!resume, worktree: this.useWorktree || !!(this.chat && this.chat.worktree),
        modelRef: cm ? cm.ref : null, reasoning: state.reasoning && state.reasoning.enabled ? state.reasoning : { enabled: false },
      });
      this.runId = runId;
      this.awaitingRun = false;
      for (const [rid, ev] of this.early.splice(0)) if (rid === runId) this.handle(ev);
    } catch (e) {
      this.awaitingRun = false;
      this.running = false;
      this.updateSend();
      this.msgs.append(this.errorCard(e.message));
    }
  }

  stop() { if (this.runId) api.invoke('agent:stop', this.runId).catch(() => {}); }

  onEvent(runId, ev) {
    if (this.awaitingRun) { this.early.push([runId, ev]); return; }
    if (runId !== this.runId) {
      if (ev.type === 'done' && ev.chatId) emit('chat-finished', ev.chatId);
      return;
    }
    this.handle(ev);
  }

  handleSub(ev) {
    const parent = this.cards.get(ev.parent);
    if (!parent) return true;
    switch (ev.type) {
      case 'tool_preparing': case 'tool_call': {
        const call = ev.call || { id: ev.callId, name: ev.name, args: null };
        let card = this.cards.get(call.id);
        if (!card) { card = this.toolCard(call, true); this.cards.set(call.id, card); parent.addSub(card.el); }
        if (ev.call) card.setArgs(ev.call.args);
        return true;
      }
      case 'text_delta': parent.subText(ev.text); return true;
      case 'reasoning_delta': parent.subText(''); return true;
      case 'assistant_start': case 'reasoning_start': case 'reasoning_end': case 'usage': case 'tool_args_delta': return true;
      default: return false; // approvals, running, output, results use the nested card by callId
    }
  }

  handle(ev) {
    if (ev.parent && this.handleSub(ev)) return;
    switch (ev.type) {
      case 'router': {
        const md = allModels().find((m) => m.ref.providerId === ev.modelRef.providerId && m.ref.modelId === ev.modelRef.modelId);
        this.msgs.append(h('div', { class: 'turn-meta', style: { margin: '0 0 8px' } }, icon('route'), `Auto → ${md ? md.model.name || md.model.id : ev.modelRef.modelId} · ${ev.why}`));
        break;
      }
      case 'compacting': this.compactNote = h('div', { class: 'notice' }, h('span', { class: 'spin' }), h('div', { class: 'body' }, tr('Context is almost full — compacting older messages…', 'Контекст почти заполнен — сжимаю старые сообщения…'))); this.msgs.append(this.compactNote); this.scrollBottom(); break;
      case 'compacted': {
        const div = this.compactionDivider({ summary: ev.summary, coveredMessages: ev.coveredMessages });
        if (this.compactNote) { this.compactNote.replaceWith(div); this.compactNote = null; } else this.msgs.append(div);
        if (this.chat) this.chat.compaction = { summary: ev.summary, untilId: ev.untilId, coveredMessages: ev.coveredMessages };
        break;
      }
      case 'hook': {
        const c = ev.callId ? this.cards.get(ev.callId) : null;
        const line = `${ev.event} · ${ev.source}: ${ev.command.slice(0, 80)} → ${ev.code}${ev.code === 2 ? ' (block/feedback)' : ''}`;
        if (c) c.addHook(line, ev); else this.msgs.append(h('div', { class: 'turn-meta', style: { margin: '2px 0 8px' }, title: (ev.stderr || ev.stdout || '').slice(0, 1000) }, icon('hook'), line));
        break;
      }
      case 'run_start': {
        this.chatId = ev.chatId;
        if (!this.chat || this.chat.id !== ev.chatId) this.chat = { id: ev.chatId, title: ev.title, messages: [] };
        this.setTitle(ev.title);
        this.turnId = ev.userMessage.id;
        if (this.pendingUserEl) { const real = this.userBubble(ev.userMessage); this.pendingUserEl.replaceWith(real); this.pendingUserEl = null; }
        this.turnAsst = [];
        if (this.useWorktree && !(this.chat && this.chat.worktree)) api.invoke('chat:get', ev.chatId).then((c) => { if (c && c.id === this.chatId) { this.chat = { ...this.chat, worktree: c.worktree }; this.useWorktree = false; this.renderWorktree(); this.renderBar(); } }).catch(() => {});
        this.notify();
        break;
      }
      case 'assistant_start': {
        this.cur = { el: h('div', { class: 'msg msg-assistant live' }), text: null, buf: '', think: null, msg: { id: ev.messageId, meta: {}, content: [] } };
        this.msgs.append(this.cur.el);
        break;
      }
      case 'reasoning_start': {
        if (!this.cur) break;
        this.flushText(true);
        this.cur.think = this.thinking('', 0, true);
        this.cur.el.append(this.cur.think.el);
        break;
      }
      case 'reasoning_delta': if (this.cur && this.cur.think) { this.cur.think.append(ev.text); } break;
      case 'reasoning_redacted': if (this.cur) this.cur.el.append(this.thinking('', 0, false, true).el); break;
      case 'reasoning_end': if (this.cur && this.cur.think) { this.cur.think.end(ev.ms); this.cur.think = null; } break;
      case 'text_delta': {
        if (!this.cur) break;
        if (this.cur.think) { this.cur.think.end(); this.cur.think = null; }
        if (!this.cur.text) { this.cur.text = h('div'); this.cur.el.append(this.cur.text); this.cur.buf = ''; }
        this.cur.buf += ev.text;
        this.scheduleText();
        break;
      }
      case 'tool_preparing': {
        if (!this.cur) break;
        this.flushText(true);
        if (this.cur.think) { this.cur.think.end(); this.cur.think = null; }
        const card = this.toolCard({ id: ev.callId, name: ev.name, args: null }, true);
        this.cards.set(ev.callId, card);
        this.cur.el.append(card.el);
        this.scrollBottom();
        break;
      }
      case 'tool_args_delta': { const c = this.cards.get(ev.callId); if (c) c.setPartial(ev.partial); break; }
      case 'tool_call': {
        if (!this.cur) break;
        this.flushText(true);
        let card = this.cards.get(ev.call.id);
        if (!card) { card = this.toolCard(ev.call, true); this.cards.set(ev.call.id, card); this.cur.el.append(card.el); }
        card.setArgs(ev.call.args);
        if (ev.call.name === 'todo_write' && ev.call.args) this.renderTodos(ev.call.args.todos);
        this.scrollBottom();
        break;
      }
      case 'approval_request': {
        const card = this.cards.get(ev.callId);
        const runId = this.runId;
        this.pendingSet = this.pendingSet || new Set();
        this.pendingSet.add(ev.callId);
        this.pendingApprovals = this.pendingSet.size; this.notify();
        const decide = (d) => { this.pendingSet.delete(ev.callId); this.pendingApprovals = this.pendingSet.size; this.notify(); return api.invoke('agent:approve', runId, ev.callId, d).catch(() => {}); };
        if (card) card.setApproval(ev, decide);
        if (document.hidden || !document.hasFocus()) notify(tr('Enide needs your approval', 'Enide ждёт подтверждения'), `${ev.name}: ${shortArgs(ev.name, ev.args)}`);
        break;
      }
      case 'tool_running': { const c = this.cards.get(ev.callId); if (c) c.setRunning(); break; }
      case 'tool_output': { const c = this.cards.get(ev.callId); if (c) { c.setOutput(ev.text); this.scrollBottom(); } break; }
      case 'tool_result': {
        const c = this.cards.get(ev.callId);
        if (c) c.setResult(ev);
        if (this.pendingSet && this.pendingSet.delete(ev.callId)) { this.pendingApprovals = this.pendingSet.size; this.notify(); }
        if (ev.display && ev.display.kind === 'problems') emit('problems', { source: 'agent', items: ev.display.items });
        const d = ev.display;
        if (d && d.path && (d.kind === 'diff' || d.kind === 'delete')) {
          const prev = this.runChanges.get(d.path) || { added: 0, removed: 0 };
          this.runChanges.set(d.path, d.kind === 'delete' ? { deleted: true } : { added: prev.added + (d.added || 0), removed: prev.removed + (d.removed || 0) });
          if (d.kind === 'diff' && state.settings.agent.autoOpenEdits !== false) this.d.editor.openFile(d.path, { activate: false });
        }
        this.scrollBottom();
        break;
      }
      case 'todos': this.renderTodos(ev.todos); break;
      case 'context': this.ctxState = { used: ev.used, real: true, model: ev.model }; if (this.chat) this.chat.ctx = ev; this.updateCtx(); break;
      case 'tool_args': { const c = this.cards.get(ev.callId); if (c && c.setArgs) c.setArgs(ev.args); break; }
      case 'usage': this.updateCtx(ev.usage); if (this.cur) this.cur.msg.meta.usage = ev.usage; break;
      case 'assistant_start_meta': break;
      case 'assistant_end': {
        this.flushText(true);
        if (this.cur) this.cur.el.classList.remove('live');
        if (this.cur) { if (this.cur.think) this.cur.think.end(); const cm = currentModel(); this.cur.msg.meta = { usage: ev.usage, ms: ev.ms, modelId: cm && cm.ref.modelId, providerId: cm && cm.ref.providerId }; this.cur.msg.content.push({ type: 'text', text: this.cur.allText || '' }); this.turnAsst.push(this.cur.msg); }
        this.cur = null;
        break;
      }
      case 'notice': {
        const map = { context_trimmed: t('contextTrimmed'), max_tokens: t('maxTokens'), max_steps: t('maxSteps', { n: ev.maxSteps }), stop_hook: tr('Stop hook sent the agent back: ', 'Stop-хук вернул агента к работе: ') + (ev.message || ''), compact_failed: tr('Could not compact the context: ', 'Не удалось сжать контекст: ') + (ev.message || '') };
        if (this.compactNote && ev.code === 'compact_failed') { this.compactNote.remove(); this.compactNote = null; }
        this.msgs.append(h('div', { class: 'notice' }, icon(ev.code === 'stop_hook' ? 'hook' : 'info'), h('div', { class: 'body' }, map[ev.code] || ev.code)));
        break;
      }
      case 'error': this.msgs.append(this.errorCard(ev.message)); this.scrollBottom(); break;
      case 'stopped': this.msgs.append(h('div', { class: 'notice' }, icon('stop'), h('div', { class: 'body' }, t('stopped')))); break;
      case 'run_totals': break;
      case 'done': {
        this.flushText(true);
        this.msgs.querySelectorAll('.msg-assistant.live').forEach((x) => x.classList.remove('live'));
        if (this.turnAsst && this.turnAsst.length) this.msgs.append(this.turnMeta(this.turnAsst));
        this.running = false;
        this.runId = null;
        this.cur = null;
        this.pendingSet = new Set(); this.pendingApprovals = 0;
        this.updateSend();
        this.notify();
        if (this.runChanges && this.runChanges.size) this.renderChanges(this.runChanges, this.turnId);
        api.invoke('chat:get', this.chatId).then((c) => { if (c && c.id === this.chatId) { this.chat = c; if (c.worktree) this.renderWorktree(); this.renderBar(); } }).catch(() => {});
        emit('chat-finished', this.chatId);
        if (document.hidden || !document.hasFocus() || !this.active) notify('Enide', `${tr('Agent finished', 'Агент закончил')}: ${this.title || ''}`);
        this.scrollBottom();
        const next = this.queue.shift();
        if (next) setTimeout(() => { this.attachments = next.attachments; this.send(next.text); }, 300);
        break;
      }
      default: break;
    }
  }

  scheduleText() {
    if (this.textRaf) return;
    this.textRaf = requestAnimationFrame(() => { this.textRaf = null; this.flushText(false); });
  }

  flushText(final) {
    if (!this.cur || !this.cur.text) return;
    const md = this.markdown(this.cur.buf, !final);
    this.cur.text.replaceChildren(md);
    if (final) {
      this.cur.allText = (this.cur.allText ? this.cur.allText + '\n\n' : '') + this.cur.buf;
      this.cur.text = null;
      this.cur.buf = '';
    }
    this.scrollBottom();
  }

  errorCard(message) {
    const hint = /401|403|invalid.*key|unauthorized|authentication/i.test(message) ? tr('Check the API key in Settings → Providers.', 'Проверь API-ключ в Настройки → Провайдеры.')
      : /404|not found|model/i.test(message) ? tr('Check the base URL and model ID in Settings → Providers.', 'Проверь base URL и ID модели в Настройки → Провайдеры.')
      : /fetch failed|ENOTFOUND|ECONN|network|ERR_/i.test(message) ? tr('Network error — check your connection or proxy (Settings → General).', 'Сетевая ошибка — проверь соединение или прокси (Настройки → Общие).') : '';
    return h('div', { class: 'notice error' }, icon('alert'), h('div', { class: 'body' },
      h('div', null, message), hint ? h('div', { class: 'muted', style: { marginTop: '4px' } }, hint) : null,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        btn(t('retry'), { cls: 'sm', icon: 'refresh', onclick: (e) => { e.currentTarget.closest('.notice').remove(); this.startRun({ resume: true, attachments: [] }); } }),
        btn(t('openSettings'), { cls: 'sm ghost', onclick: () => this.d.openSettings('providers') }))));
  }

  // ---------- attachments ----------
  renderAttachments() {
    clear(this.attachRow);
    this.attachments.forEach((a, i) => {
      const rm = () => { this.attachments.splice(i, 1); this.renderAttachments(); this.updateSend(); };
      if (a.type === 'image') {
        this.attachRow.append(h('span', { class: 'img-chip', title: a.name || 'image' }, h('img', { src: `data:${a.mediaType};base64,${a.data}` }), h('span', { class: 'x', onclick: rm }, icon('x'))));
      } else {
        const c = this.chip({ kind: a.kind || a.type, path: a.path, label: a.label, startLine: a.startLine, endLine: a.endLine });
        c.append(h('span', { class: 'x', onclick: (e) => { e.stopPropagation(); rm(); } }, '×'));
        this.attachRow.append(c);
      }
    });
    this.updateSend();
  }

  addAttachment(a) {
    const key = (x) => `${x.type}|${x.path}|${x.startLine}|${x.label}|${x.data ? x.data.length : ''}`;
    if (this.attachments.some((x) => key(x) === key(a))) return;
    this.attachments.push(a);
    this.renderAttachments();
    this.ta.focus();
  }

  async attachPath(p) {
    try {
      const d = await api.invoke('ws:describe-file', p);
      if (d.kind === 'image') this.addAttachment({ type: 'image', name: d.name, mediaType: d.mediaType, data: d.data, path: p });
      else if (d.kind === 'folder') this.addAttachment({ type: 'folder', kind: 'folder', path: p, content: d.content });
      else if (d.kind === 'text') this.addAttachment({ type: 'file', kind: 'file', path: p, content: d.content });
      else if (d.kind === 'archive') this.addAttachment({ type: 'text', kind: 'archive', label: d.name, path: p, text: `<attached-archive path="${p}" size="${d.size}">\nContents:\n${d.content}\n</attached-archive>\nThe archive is on disk at the path above — extract it with run_command (e.g. ditto -x -k, unzip or tar -xf) if you need the files.` });
      else this.addAttachment({ type: 'text', kind: 'file', label: d.name, path: p, text: `<attached-file path="${p}" size="${d.size}" type="${d.content}" />\nThis file is on disk at the path above; inspect or convert it with your tools if needed.` });
    } catch (e) { toast(`${basename(p)}: ${e.message}`, 'error'); }
  }

  async pickFiles(folders) {
    try {
      const paths = await api.invoke('app:pick-files', { folders });
      for (const p of paths || []) await this.attachPath(p);
    } catch (e) { toast(e.message, 'error'); }
  }

  async captureScreen(full) {
    try {
      const img = await api.invoke('app:capture-screen', { full });
      if (img) this.addAttachment({ type: 'image', name: 'screenshot.png', mediaType: img.mediaType, data: img.data });
    } catch (e) { toast(e.message, 'error', 8000); }
  }

  async addCurrentFile() {
    const p = state.activeFile;
    if (!p) { toast(tr('No file is open.', 'Нет открытого файла.')); return; }
    await this.attachPath(p);
  }

  addSelection() {
    this.d.showAgent && this.d.showAgent();
    const s = this.d.editor.getSelectionInfo();
    if (!s) { this.ta.focus(); return; }
    if (s.empty || !s.text) { this.attachPath(s.path); return; }
    this.addAttachment({ type: 'selection', kind: 'selection', path: s.path, startLine: s.startLine, endLine: s.endLine, text: s.text });
  }

  async addGitDiff() {
    try {
      const st = await api.invoke('git:status');
      if (!st || !st.repo) { toast(t('notRepo'), 'error'); return; }
      const parts = [];
      for (const e of [...st.staged, ...st.unstaged].slice(0, 40)) {
        const d = await api.invoke('git:diff', e.path, st.staged.includes(e));
        parts.push(`--- ${e.rel} (${e.code})\n${simpleDiff(d.original, d.modified)}`);
      }
      this.addAttachment({ type: 'text', kind: 'git', label: tr('git changes', 'изменения git'), text: `<git-changes branch="${st.branch}">\n${parts.join('\n\n').slice(0, 120000)}\n</git-changes>` });
    } catch (e) { toast(e.message, 'error'); }
  }

  addTerminal() {
    const tm = this.d.panel.active;
    if (!tm || !tm.term) { toast(tr('Open a terminal first.', 'Сначала открой терминал.')); return; }
    const buf = tm.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buf.length - 300); i < buf.length; i++) { const l = buf.getLine(i); if (l) lines.push(l.translateToString(true)); }
    this.addAttachment({ type: 'terminal', kind: 'terminal', text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() });
  }

  async onPaste(e) {
    const items = [...(e.clipboardData && e.clipboardData.items) || []];
    const files = items.filter((i) => i.kind === 'file');
    if (!files.length) return;
    e.preventDefault();
    for (const it of files) {
      const f = it.getAsFile();
      if (!f) continue;
      const p = api.pathForFile(f);
      if (p) { await this.attachPath(p); continue; }
      if (f.type.startsWith('image/')) this.addAttachment({ type: 'image', name: f.name || 'pasted.png', mediaType: f.type, data: await readBlobAsBase64(f) });
    }
  }

  async onDrop(e) {
    e.preventDefault();
    this.composer.classList.remove('drag');
    const dt = e.dataTransfer;
    const internal = dt.getData('text/enide-path');
    if (internal) { await this.attachPath(internal); return; }
    for (const f of [...dt.files]) {
      const p = api.pathForFile(f);
      if (p) await this.attachPath(p);
      else if (f.type.startsWith('image/')) this.addAttachment({ type: 'image', name: f.name, mediaType: f.type, data: await readBlobAsBase64(f) });
    }
  }

  // ---------- voice ----------
  async toggleVoice() {
    if (this.rec) { this.rec.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast(tr('Microphone access denied. Allow Enide in System Settings → Privacy & Security → Microphone. Tip: macOS Dictation (press Fn twice) also works here.', 'Нет доступа к микрофону. Разреши Enide в Системных настройках → Конфиденциальность → Микрофон. Также работает диктовка macOS (дважды Fn).'), 'error', 9000); return; }
    const chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    this.rec = rec;
    this.micBtn.classList.add('active');
    this.micBtn.style.color = 'var(--err)';
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((tr2) => tr2.stop());
      this.rec = null;
      this.micBtn.classList.remove('active');
      this.micBtn.style.color = '';
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000) return;
      const prev = this.ta.placeholder;
      this.ta.placeholder = tr('Transcribing…', 'Распознаю…');
      try {
        let payload = { data: await readBlobAsBase64(blob), mimeType: 'audio/webm' };
        try { const wav = await toWav(blob); payload = { data: await readBlobAsBase64(wav), mimeType: 'audio/wav' }; } catch {}
        const text = await api.invoke('ai:transcribe', payload);
        const cur = this.ta.value;
        this.ta.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + (text || '').trim();
        this.autosize(); this.updateSend(); this.ta.focus();
      } catch (e) { toast(e.message, 'error', 9000); }
      this.ta.placeholder = prev;
    };
    rec.start();
    toast(tr('Listening… click the mic again to stop.', 'Слушаю… нажми микрофон ещё раз, чтобы остановить.'), 'info', 2500);
  }

  // ---------- @ mentions & / commands ----------
  async updatePop() {
    const v = this.ta.value;
    const caret = this.ta.selectionStart;
    const before = v.slice(0, caret);
    const slash = /^\/([\w:.-]*)$/.exec(before);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (slash) return this.showSlash(slash[1]);
    if (at) return this.showMentions(at[2], caret - at[2].length - 1);
    this.closePop();
  }

  async showSlash(q) {
    let cmds = [];
    try { cmds = await api.invoke('slash:list'); } catch {}
    cmds = [{ name: 'clear', description: t('newChat') }, { name: 'model', description: tr('Switch model', 'Сменить модель') }, ...cmds];
    const items = cmds.filter((c) => c.name.startsWith(q) || c.name.includes(q)).slice(0, 30).map((c) => ({
      label: '/' + c.name, sub: c.source && c.source !== 'builtin' ? c.source : '', desc: c.description,
      pick: () => { this.ta.value = '/' + c.name + ' '; this.autosize(); this.closePop(); this.updateSend(); },
    }));
    this.openPop(items);
  }

  async showMentions(q, atIndex) {
    const replace = () => { const v = this.ta.value; const end = this.ta.selectionStart; this.ta.value = v.slice(0, atIndex) + v.slice(end); this.ta.selectionStart = this.ta.selectionEnd = atIndex; this.closePop(); };
    if (!this.docsList) { try { this.docsList = (await api.invoke('docs:list')).filter((d) => d.status === 'ready'); } catch { this.docsList = []; } }
    const docsItems = this.docsList.filter((d) => !q || ('docs ' + d.name).toLowerCase().includes(q.toLowerCase())).map((d) => ({ label: `Docs: ${d.name}`, icon: 'book', desc: `${d.pages} ${tr('pages', 'стр.')}`, pick: () => { replace(); this.addAttachment({ type: 'docs', kind: 'docs', name: d.name, label: d.name }); } }));
    const special = [
      ...docsItems,
      { label: tr('Current file', 'Текущий файл'), icon: 'file', kw: 'file current текущий', pick: () => { replace(); this.addCurrentFile(); } },
      { label: tr('Selection', 'Выделение'), icon: 'edit', kw: 'selection выделение', pick: () => { replace(); this.addSelection(); } },
      { label: tr('Git changes', 'Изменения git'), icon: 'git', kw: 'git diff changes изменения', pick: () => { replace(); this.addGitDiff(); } },
      { label: tr('Terminal', 'Терминал'), icon: 'terminal', kw: 'terminal терминал', pick: () => { replace(); this.addTerminal(); } },
      { label: tr('Files from Mac…', 'Файлы с Mac…'), icon: 'upload', kw: 'mac desktop finder рабочий стол zip', pick: () => { replace(); this.pickFiles(false); } },
      { label: tr('Add docs…', 'Добавить документацию…'), icon: 'book', kw: 'docs документация', pick: () => { replace(); this.d.openSettings('index'); } },
      { label: tr('Web search', 'Поиск в интернете'), icon: 'globe', kw: 'web интернет', pick: () => { replace(); this.ta.value = this.ta.value + tr(' (search the web for this)', ' (поищи это в интернете)'); } },
    ].filter((s) => !q || s.kw.includes(q.toLowerCase()) || s.label.toLowerCase().includes(q.toLowerCase()));
    let files = [];
    if (state.root) {
      if (!this.fileList) { try { this.fileList = await api.invoke('ws:list-files'); } catch { this.fileList = []; } }
      const dirs = new Set();
      for (const f of this.fileList) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/'); }
      const all = [...dirs, ...this.fileList];
      files = all.map((f) => ({ f, s: fuzzy(q, f) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40)
        .map(({ f }) => ({ label: basename(f.replace(/\/$/, '')) + (f.endsWith('/') ? '/' : ''), desc: dirname(f.replace(/\/$/, '')) === '/' ? '' : dirname(f.replace(/\/$/, '')), fileIcon: f, isDir: f.endsWith('/'),
          pick: () => { replace(); const rel = f.replace(/\/$/, ''); this.attachPath(rel.startsWith('/') ? rel : state.root + '/' + rel); } }));
    }
    this.openPop([...special, ...files]);
  }

  openPop(items) {
    this.popItems = items;
    this.popIndex = 0;
    if (!items.length) { this.closePop(); return; }
    this.popOpen = true;
    this.popHost.classList.remove('hidden');
    this.renderPop();
  }

  renderPop() {
    clear(this.popHost);
    const m = h('div', { class: 'menu', style: { maxHeight: '300px' } });
    this.popItems.forEach((it, i) => {
      const row = h('div', { class: `mi ${i === this.popIndex ? 'hl' : ''}` },
        it.fileIcon ? fileIcon(it.fileIcon, it.isDir) : it.icon ? icon(it.icon) : null,
        h('span', { class: 'ellipsis' }, it.label), it.desc ? h('span', { class: 'sub ellipsis', style: { maxWidth: '55%' } }, it.desc) : it.sub ? h('span', { class: 'sub' }, it.sub) : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); it.pick(); });
      m.append(row);
    });
    this.popHost.append(m);
    const hl = m.querySelector('.hl');
    if (hl) hl.scrollIntoView({ block: 'nearest' });
  }

  movePop(d) { this.popIndex = (this.popIndex + d + this.popItems.length) % this.popItems.length; this.renderPop(); }
  choosePop() { const it = this.popItems[this.popIndex]; if (it) it.pick(); }
  closePop() { this.popOpen = false; this.popHost.classList.add('hidden'); clear(this.popHost); }

  focus() { this.ta.focus(); }

  exportChat() {
    if (!this.chat) return;
    const out = [`# ${this.chat.title || 'Chat'}\n`];
    for (const m of this.chat.messages || []) {
      if (m.role === 'user') out.push(`## You\n\n${m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')}\n`);
      else if (m.role === 'assistant') {
        for (const b of m.content) {
          if (b.type === 'text' && b.text) out.push(b.text + '\n');
          else if (b.type === 'reasoning' && b.text) out.push(`<details><summary>Reasoning</summary>\n\n${b.text}\n\n</details>\n`);
          else if (b.type === 'tool_call') out.push(`> 🔧 \`${b.name}\` ${shortArgs(b.name, b.args)}\n`);
        }
      }
    }
    navigator.clipboard.writeText(out.join('\n'));
    toast(tr('Chat copied as Markdown', 'Чат скопирован в Markdown'), 'ok');
  }
}

function stripForSend(a) {
  if (a.type === 'docs') return { type: 'docs', name: a.name };
  if (a.type === 'image') return { type: 'image', mediaType: a.mediaType, data: a.data, name: a.name };
  if (a.type === 'file') return { type: 'file', path: a.path, content: a.content };
  if (a.type === 'folder') return { type: 'folder', path: a.path, content: a.content };
  if (a.type === 'selection') return { type: 'selection', path: a.path, startLine: a.startLine, endLine: a.endLine, text: a.text };
  if (a.type === 'terminal') return { type: 'terminal', text: a.text };
  return { type: 'text', kind: a.kind, label: a.label || basename(a.path || ''), text: a.text };
}

function simpleDiff(a, b) {
  const al = String(a || '').split('\n'), bl = String(b || '').split('\n');
  const out = [];
  let i = 0, j = 0;
  while (i < al.length || j < bl.length) {
    if (i < al.length && j < bl.length && al[i] === bl[j]) { i++; j++; continue; }
    const k = bl.indexOf(al[i], j);
    if (i < al.length && (k === -1 || k - j > 40)) { out.push('-' + al[i]); i++; }
    else if (j < bl.length) { out.push('+' + bl[j]); j++; }
    if (out.length > 1500) { out.push('…'); break; }
  }
  return out.join('\n');
}

// Re-encode recorded audio as 16 kHz mono WAV — accepted by Whisper-style APIs and Gemini alike.
async function toWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const x = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

function costOf(asstMsgs) {
  let total = 0, priced = false;
  for (const m of asstMsgs) {
    const meta = m.meta || {};
    const p = (state.settings.providers || []).find((x) => x.id === meta.providerId);
    const md = p && (p.models || []).find((x) => x.id === meta.modelId);
    if (!md || !md.price) continue;
    const u = meta.usage || {};
    total += ((md.price.input || 0) * (u.input || 0) + (md.price.cacheRead != null ? md.price.cacheRead : md.price.input || 0) * (u.cacheRead || 0) + (md.price.output || 0) * (u.output || 0)) / 1e6;
    priced = true;
  }
  return priced ? total : null;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function micIcon() {
  const t2 = document.createElement('template');
  t2.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  return t2.content.firstChild;
}

function notify(title, body) {
  try { new Notification(title, { body, silent: false }); } catch {}
}
