// Sidebar "Chats": every chat of this project — open, running, pinned, earlier — one click away.
import { h, clear, icon, iconBtn, btn, toast, confirmDialog, promptDialog, relTime } from './dom.js';
import { api } from './api.js';
import { state, on, emit } from './state.js';
import { t, tr } from './i18n.js';

const DAY = 24 * 3600 * 1000;

export class ChatsPane {
  constructor(host, { tabs }) {
    this.host = host;
    this.tabs = tabs;
    this.list = [];
    this.q = '';
    this.build();
    let timer;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => this.refresh(), 250); };
    api.on('chat:updated', later);
    on('chats-changed', later);
    on('workspace', later);
    on('chat-finished', later);
  }

  build() {
    clear(this.host);
    this.head = h('div', { class: 'pane-head' }, h('div', { class: 'pane-title' }, h('b', null, tr('Chats', 'Чаты'))),
      iconBtn('search', tr('Search in all chats', 'Поиск по всем чатам'), () => this.tabs.active.searchChats(), 'sm'),
      iconBtn('plus', `${tr('New chat tab', 'Новая вкладка')} (⌘T)`, () => { this.tabs.newTab(); emit('chats-changed'); }, 'sm'));
    this.newBtn = btn(tr('New chat', 'Новый чат'), { cls: 'primary new-chat-btn', icon: 'newChat', onclick: () => { this.tabs.active.newChat(); emit('chats-changed'); } });
    this.filter = h('input', { class: 'input chats-filter', placeholder: tr('Filter chats', 'Фильтр чатов'), oninput: (e) => { this.q = e.target.value.toLowerCase(); this.render(); } });
    this.body = h('div', { class: 'pane-body chats-body' });
    this.host.append(this.head, h('div', { class: 'chats-top' }, this.newBtn, this.filter), this.body);
    this.refresh();
  }

  async refresh() {
    try { this.list = await api.invoke('chat:list', state.root || null) || []; } catch { this.list = []; }
    this.render();
  }

  render() {
    clear(this.body);
    const panels = this.tabs.panels || [];
    const activeId = this.tabs.active && this.tabs.active.chatId;
    const openIds = new Map(panels.filter((p) => p.chatId).map((p) => [p.chatId, p]));
    let items = this.list;
    if (this.q) items = items.filter((c) => (c.title || '').toLowerCase().includes(this.q));
    // Unsaved new tabs (no chat yet) show on top so they can be switched to / closed.
    const drafts = panels.filter((p) => !p.chatId);
    if (!this.q && drafts.length > 1) {
      this.body.append(h('div', { class: 'chats-group' }, tr('Open tabs', 'Открытые вкладки')));
      drafts.forEach((p) => this.body.append(this.row({ id: null, title: tr('New chat', 'Новый чат'), updated: Date.now() }, p, p === this.tabs.active)));
    }
    if (!items.length) {
      this.body.append(h('div', { class: 'empty-pane chats-empty' }, icon('newChat'), h('div', null, this.q ? tr('Nothing found', 'Ничего не найдено') : tr('No chats yet — ask anything.', 'Чатов пока нет — спроси что-нибудь.'))));
      return;
    }
    const now = Date.now();
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const groups = [
      [tr('Pinned', 'Закреплённые'), (c) => c.pinned],
      [tr('Today', 'Сегодня'), (c) => c.updated >= startToday.getTime()],
      [tr('Yesterday', 'Вчера'), (c) => c.updated >= startToday.getTime() - DAY],
      [tr('This week', 'На этой неделе'), (c) => c.updated >= now - 7 * DAY],
      [tr('Earlier', 'Ранее'), () => true],
    ];
    const used = new Set();
    for (const [label, test] of groups) {
      const g = items.filter((c) => !used.has(c.id) && test(c));
      if (!g.length) continue;
      g.forEach((c) => used.add(c.id));
      this.body.append(h('div', { class: 'chats-group' }, label));
      for (const c of g) this.body.append(this.row(c, openIds.get(c.id), c.id === activeId));
    }
  }

  row(c, panel, active) {
    const running = panel && panel.running;
    const el = h('div', { class: `chat-row ${active ? 'active' : ''} ${panel ? 'open' : ''}`, title: c.title || '' },
      h('span', { class: 'chat-ic' }, running ? h('span', { class: 'spinner' }) : icon(c.pinned ? 'pin' : c.worktree ? 'git' : 'message')),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'chat-row-title ellipsis' }, c.title || tr('New chat', 'Новый чат')),
        h('div', { class: 'chat-row-sub' }, running ? tr('working…', 'работает…') : relTime(c.updated))),
      h('span', { class: 'chat-row-acts' },
        c.id ? iconBtn('pin', c.pinned ? tr('Unpin', 'Открепить') : tr('Pin', 'Закрепить'), async (e) => { e.stopPropagation(); await api.invoke('chat:pin', c.id, !c.pinned); this.refresh(); }, 'sm') : null,
        c.id ? iconBtn('edit', tr('Rename', 'Переименовать'), async (e) => {
          e.stopPropagation();
          const n = await promptDialog(tr('Rename chat', 'Переименовать чат'), '', c.title);
          if (!n) return;
          await api.invoke('chat:rename', c.id, n);
          if (panel) panel.setTitle(n);
          this.refresh();
        }, 'sm') : null,
        panel && this.tabs.panels.length > 1 ? iconBtn('x', tr('Close tab', 'Закрыть вкладку'), (e) => { e.stopPropagation(); this.tabs.close(panel).then(() => this.render()); }, 'sm') : null,
        c.id ? iconBtn('trash', t('delete'), async (e) => {
          e.stopPropagation();
          if (!(await confirmDialog(tr('Delete chat', 'Удалить чат'), c.title || '', t('delete'), true))) return;
          if (panel && panel.running) panel.stop();
          await api.invoke('chat:delete', c.id);
          if (panel) panel.newChat();
          toast(tr('Chat deleted', 'Чат удалён'), 'ok', 1500);
          this.refresh();
        }, 'sm') : null));
    el.addEventListener('click', () => {
      if (panel) this.tabs.activate(panel);
      else if (c.id) this.tabs.active.openChat(c.id);
      emit('chats-changed');
    });
    return el;
  }
}
