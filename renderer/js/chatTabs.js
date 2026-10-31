// Several chats side by side as tabs — each can run its own agent at the same time
// (optionally in its own git worktree).
import { h, clear, icon, iconBtn, confirmDialog } from './dom.js';
import { api } from './api.js';
import { state, on, emit } from './state.js';
import { t, tr } from './i18n.js';
import { ChatPanel } from './chat.js';

export class ChatTabs {
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.panels = [];
    this.activePanel = null;
    clear(host);
    this.strip = h('div', { class: 'chat-tabs hidden' });
    this.body = h('div', { class: 'chat-panes' });
    host.append(this.strip, this.body);
    this.newTab();
    on('workspace', () => {
      for (const p of [...this.panels]) { if (!p.running) this.remove(p, true); }
      if (!this.panels.length) this.newTab();
      else { this.activate(this.panels[0]); this.activePanel.newChat(); }
      for (const p of this.panels) p.fileList = null;
    });
    api.on('chat:updated', () => {});
  }

  get active() { return this.activePanel; }

  newTab() {
    const pane = h('div', { class: 'chat-pane' });
    this.body.append(pane);
    const panel = new ChatPanel(pane, { ...this.deps, tabs: this });
    panel.pane = pane;
    this.panels.push(panel);
    this.activate(panel);
    return panel;
  }

  activate(p) {
    this.activePanel = p;
    for (const x of this.panels) { x.active = x === p; x.pane.style.display = x === p ? '' : 'none'; }
    state.mode = p.mode;
    p.renderBar();
    this.render();
    emit('chats-changed');
    setTimeout(() => p.scrollBottom && p.scrollBottom(), 0);
  }

  async close(p) {
    if (p.running && !(await confirmDialog(tr('Close tab', 'Закрыть вкладку'), tr('The agent in this tab is still running. Stop it and close?', 'Агент в этой вкладке ещё работает. Остановить и закрыть?'), tr('Stop & close', 'Остановить и закрыть'), true))) return;
    if (p.running) p.stop();
    this.remove(p);
  }

  remove(p, silent) {
    const i = this.panels.indexOf(p);
    if (i < 0) return;
    this.panels.splice(i, 1);
    if (p.stars) p.stars.destroy();
    p.pane.remove();
    if (silent) return;
    if (!this.panels.length) this.newTab();
    else if (this.activePanel === p) this.activate(this.panels[Math.max(0, i - 1)]);
    else this.render();
  }

  focusChat(id) {
    const p = this.panels.find((x) => x.chatId === id);
    if (!p) return false;
    this.activate(p);
    return true;
  }

  update() { this.render(); emit('chats-changed'); }

  next(dir = 1) {
    if (this.panels.length < 2) return;
    const i = this.panels.indexOf(this.activePanel);
    this.activate(this.panels[(i + dir + this.panels.length) % this.panels.length]);
  }

  render() {
    clear(this.strip);
    this.strip.classList.toggle('hidden', this.panels.length < 2);
    for (const p of this.panels) {
      const status = p.pendingApprovals ? h('span', { class: 'tab-wait', title: tr('Waiting for your approval', 'Ждёт подтверждения') }, icon('alert')) : p.running ? h('span', { class: 'spinner', title: tr('Running', 'Работает') }) : null;
      const tab = h('div', { class: `chat-tab ${p === this.activePanel ? 'on' : ''}`, title: p.title || t('newChat') },
        status, p.chat && p.chat.worktree ? icon('git') : null,
        h('span', { class: 'ellipsis' }, p.title || t('newChat')),
        h('span', { class: 'x', onclick: (e) => { e.stopPropagation(); this.close(p); } }, icon('x')));
      tab.addEventListener('click', () => this.activate(p));
      tab.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.close(p); } });
      this.strip.append(tab);
    }
    this.strip.append(iconBtn('plus', `${tr('New chat tab', 'Новая вкладка чата')} (⌘T)`, () => this.newTab(), 'sm'));
  }
}
