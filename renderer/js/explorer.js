import { h, clear, icon, iconBtn, btn, popMenu, toast, confirmDialog, basename, dirname, relPath } from './dom.js';
import { fileIcon } from './icons.js';
import { api } from './api.js';
import { state, emit, on } from './state.js';
import { t, tr } from './i18n.js';

export class Explorer {
  constructor(host, { onOpen, onAddToChat }) {
    this.host = host;
    this.onOpen = onOpen;
    this.onAddToChat = onAddToChat;
    this.expanded = new Set();
    this.cache = new Map();
    this.selected = null;
    this.editing = null;
    this.build();
    api.on('ws:changed', (paths) => this.onFsChange(paths));
    on('git-status', () => this.render());
    on('active-tab', (tab) => { if (tab && tab.path) { this.selected = tab.path; this.reveal(tab.path, false); } });
  }

  build() {
    clear(this.host);
    this.title = h('div', { class: 'pane-title' });
    this.head = h('div', { class: 'pane-head' }, this.title,
      iconBtn('plus', t('newFile'), () => this.startCreate(false), 'sm'),
      iconBtn('folder', t('newFolder'), () => this.startCreate(true), 'sm'),
      iconBtn('refresh', t('refresh'), () => this.refresh(), 'sm'),
      iconBtn('folderOpen', tr('Add folder to workspace', 'Добавить папку в проект'), () => emit('cmd', 'add-folder'), 'sm'),
      iconBtn('layers', t('collapse'), () => { this.expanded.clear(); this.render(); }, 'sm'));
    this.body = h('div', { class: 'pane-body' });
    this.host.append(this.head, this.body);
    this.body.addEventListener('contextmenu', (e) => { if (e.target === this.body || e.target.classList.contains('tree')) { e.preventDefault(); this.menu(e, state.root, true); } });
    this.setRoot(state.root);
  }

  async loadExtraRoots() {
    try { this.extraRoots = state.root ? await api.invoke('ws:extra-roots') : []; } catch { this.extraRoots = []; }
    for (const r of this.extraRoots) this.expanded.add(r);
    this.render();
  }

  setRoot(root) {
    this.extraRoots = [];
    this.cache.clear();
    this.expanded = new Set(root ? [root] : []);
    clear(this.title);
    this.title.append(h('b', null, root ? basename(root) : t('explorer')));
    this.render();
  }

  async load(dir) {
    if (this.cache.has(dir)) return this.cache.get(dir);
    let list = [];
    try { list = await api.invoke('ws:readdir', dir); } catch {}
    this.cache.set(dir, list);
    return list;
  }

  async refresh() { this.cache.clear(); await this.render(); }

  async onFsChange(paths) {
    const dirs = new Set(paths.map((p) => dirname(p)));
    let touched = false;
    for (const d of dirs) if (this.cache.has(d)) { this.cache.delete(d); touched = true; }
    for (const p of paths) if (this.cache.has(p)) { this.cache.delete(p); touched = true; }
    if (touched) this.render();
  }

  gitCode(path) {
    const g = state.gitStatus;
    if (!g || !g.repo) return null;
    const e = g.unstaged.find((x) => x.path === path) || g.staged.find((x) => x.path === path);
    if (e) return e.code === 'U?' ? 'U' : e.code;
    if ([...g.unstaged, ...g.staged].some((x) => x.path.startsWith(path + '/'))) return '•';
    return null;
  }

  async render() {
    const root = state.root;
    clear(this.body);
    if (!root) {
      this.body.append(h('div', { class: 'empty-pane' }, t('noFolder'), h('br'), btn(t('openFolder'), { cls: 'primary sm', onclick: () => emit('cmd', 'open-folder') })));
      return;
    }
    const tree = h('div', { class: 'tree' });
    const scroll = this.body.scrollTop;
    if ((this.extraRoots || []).length) tree.append(h('div', { class: 'root-head', onclick: () => { if (this.expanded.has(root)) this.expanded.delete(root); else this.expanded.add(root); this.render(); } }, basename(root)));
    if (this.expanded.has(root) || !(this.extraRoots || []).length) await this.renderDir(root, tree, 0);
    for (const extra of this.extraRoots || []) {
      tree.append(h('div', { class: 'root-head', title: extra, onclick: () => { if (this.expanded.has(extra)) this.expanded.delete(extra); else this.expanded.add(extra); this.render(); } }, basename(extra),
        iconBtn('x', tr('Remove from workspace', 'Убрать из проекта'), async (e) => { e.stopPropagation(); this.extraRoots = await api.invoke('ws:remove-folder', extra); this.render(); }, 'sm')));
      if (this.expanded.has(extra)) await this.renderDir(extra, tree, 0);
    }
    clear(this.body);
    this.body.append(tree);
    this.body.scrollTop = scroll;
  }

  async renderDir(dir, parent, depth) {
    const items = await this.load(dir);
    if (this.editing && this.editing.parent === dir && this.editing.create) parent.append(this.editRow(depth));
    for (const it of items) {
      const open = this.expanded.has(it.path);
      if (this.editing && !this.editing.create && this.editing.path === it.path) { parent.append(this.editRow(depth, it)); continue; }
      const code = it.dir ? (this.gitCode(it.path) === '•' ? '•' : null) : this.gitCode(it.path);
      const row = h('div', {
        class: `tree-row ${this.selected === it.path ? 'active' : ''} ${it.ignored ? 'ignored' : ''}`,
        style: { paddingLeft: 6 + depth * 12 + 'px' }, title: it.path, draggable: 'true',
      },
        it.dir ? icon('chevron', `chev ${open ? 'open' : ''}`) : h('span', { style: { width: '14px', flex: 'none' } }),
        h('span', { class: 'fi' }, fileIcon(it.name, it.dir, open)),
        h('span', { class: `name ${code && code !== '•' ? 'git-' + code : ''}` }, it.name),
        code ? h('span', { class: `git git-${code}` }, code) : null);
      row.addEventListener('click', (e) => {
        this.selected = it.path;
        if (it.dir) { if (open) this.expanded.delete(it.path); else this.expanded.add(it.path); this.render(); }
        else { this.onOpen(it.path, { preview: !(e.metaKey || e.ctrlKey) }); this.render(); }
      });
      row.addEventListener('dblclick', () => { if (!it.dir) this.onOpen(it.path, { preview: false }); });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.selected = it.path; this.menu(e, it.path, it.dir); });
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/enide-path', it.path); e.dataTransfer.setData('text/plain', it.path); });
      parent.append(row);
      if (it.dir && open) await this.renderDir(it.path, parent, depth + 1);
    }
  }

  editRow(depth, item) {
    const input = h('input', { value: item ? item.name : '' });
    const row = h('div', { class: 'tree-row focused', style: { paddingLeft: 6 + depth * 12 + 14 + 'px' } },
      h('span', { class: 'fi' }, fileIcon(item ? item.name : '', this.editing.isDir)), input);
    const done = async (commit) => {
      const ed = this.editing;
      this.editing = null;
      const name = input.value.trim();
      if (commit && name) {
        try {
          if (ed.create) {
            const p = ed.parent + '/' + name;
            if (ed.isDir) await api.invoke('ws:create-dir', p);
            else { await api.invoke('ws:create-file', p); this.onOpen(p, { preview: false }); }
            this.cache.delete(ed.parent);
            this.selected = p;
          } else if (name !== basename(ed.path)) {
            const to = dirname(ed.path) + '/' + name;
            await api.invoke('ws:rename', ed.path, to);
            this.cache.delete(dirname(ed.path));
            emit('renamed', ed.path, to);
          }
        } catch (e) { toast(e.message, 'error'); }
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => { if (this.editing) done(true); });
    setTimeout(() => { input.focus(); if (item) { const dot = item.name.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : item.name.length); } }, 0);
    return row;
  }

  startCreate(isDir, parentDir) {
    if (!state.root) return;
    let parent = parentDir;
    if (!parent) {
      const sel = this.selected;
      const items = sel ? this.cache.get(dirname(sel)) : null;
      const it = items && items.find((x) => x.path === sel);
      parent = it ? (it.dir ? it.path : dirname(it.path)) : state.root;
    }
    this.expanded.add(parent);
    this.editing = { create: true, isDir, parent };
    this.render();
  }

  menu(e, path, isDir) {
    const root = state.root;
    const items = [];
    if (isDir) {
      items.push({ label: t('newFile'), icon: 'plus', onclick: () => this.startCreate(false, path) });
      items.push({ label: t('newFolder'), icon: 'folder', onclick: () => this.startCreate(true, path) });
      items.push({ sep: true });
    }
    items.push({ label: t('addToChat'), icon: 'at', onclick: () => this.onAddToChat(path, isDir) });
    if (!isDir) items.push({ label: tr('Open to the side', 'Открыть сбоку'), icon: 'panelRight', onclick: () => emit('open-to-side', path) });
    if (path === root) items.push({ label: tr('Add folder to workspace…', 'Добавить папку в проект…'), icon: 'folderOpen', onclick: () => emit('cmd', 'add-folder') });
    if (path !== root) {
      items.push({ label: t('rename'), icon: 'edit', onclick: () => { this.editing = { create: false, path, isDir }; this.render(); } });
      items.push({ label: t('delete'), icon: 'trash', onclick: async () => {
        if (await confirmDialog(t('delete'), `${basename(path)} → Trash?`, t('delete'), true)) {
          try { await api.invoke('ws:delete', path); this.cache.delete(dirname(path)); this.render(); emit('deleted', path); } catch (err) { toast(err.message, 'error'); }
        }
      } });
    }
    items.push({ sep: true });
    items.push({ label: t('copyPath'), icon: 'copy', onclick: () => navigator.clipboard.writeText(path) });
    items.push({ label: t('copyRelPath'), icon: 'copy', onclick: () => navigator.clipboard.writeText(relPath(root, path)) });
    items.push({ label: t('reveal'), icon: 'external', onclick: () => api.invoke('app:reveal', path) });
    if (isDir) items.push({ label: t('newTerminal'), icon: 'terminal', onclick: () => emit('new-terminal', path) });
    popMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, items);
  }

  async reveal(path, doRender = true) {
    if (!state.root || !path.startsWith(state.root)) return;
    let d = dirname(path);
    let changed = false;
    while (d.length >= state.root.length) { if (!this.expanded.has(d)) { this.expanded.add(d); changed = true; } if (d === state.root) break; d = dirname(d); }
    if (changed || doRender) await this.render();
    else this.body.querySelectorAll('.tree-row').forEach((r) => r.classList.toggle('active', r.title === path));
    const row = [...this.body.querySelectorAll('.tree-row')].find((r) => r.title === path);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}
