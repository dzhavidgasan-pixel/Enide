import { h, clear, icon, iconBtn, btn, toast, confirmDialog, popMenu, promptDialog, basename, dirname } from './dom.js';
import { fileIcon } from './icons.js';
import { api } from './api.js';
import { state, emit, on } from './state.js';
import { t, tr } from './i18n.js';
import { langOf } from './editor.js';

export class ScmPane {
  constructor(host, { editor }) {
    this.host = host;
    this.editor = editor;
    this.busy = false;
    this.build();
    let timer;
    api.on('ws:changed', () => { clearTimeout(timer); timer = setTimeout(() => this.refresh(), 600); });
    on('saved', () => this.refresh());
  }

  build() {
    clear(this.host);
    this.title = h('div', { class: 'pane-title' }, '/', h('b', null, t('sourceControl')));
    this.head = h('div', { class: 'pane-head' }, this.title,
      iconBtn('refresh', t('refresh'), () => this.refresh(), 'sm'),
      iconBtn('more', 'More', (e) => this.more(e.currentTarget), 'sm'));
    this.msg = h('textarea', { class: 'textarea', placeholder: t('commitMessage') });
    this.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.commit(); } });
    this.commitBtn = btn(t('commit'), { cls: 'sm primary', icon: 'check', onclick: () => this.commit() });
    this.genBtn = btn(t('generate'), { cls: 'sm', icon: 'edit', onclick: () => this.generate() });
    this.reviewBtn = btn(tr('AI review', 'ИИ-ревью'), { cls: 'sm', icon: 'shield', title: tr('Find bugs in uncommitted changes (Bugbot)', 'Найти баги в незакоммиченных изменениях (Bugbot)'), onclick: () => emit('cmd', 'review') });
    this.box = h('div', { class: 'commit-box' }, this.msg, h('div', { class: 'row' }, this.genBtn, this.commitBtn), h('div', { class: 'row' }, this.reviewBtn));
    this.body = h('div', { class: 'pane-body' });
    this.host.append(this.head, this.box, this.body);
  }

  async refresh() {
    if (!state.root) { state.gitStatus = null; this.render(); return; }
    try { state.gitStatus = await api.invoke('git:status'); } catch { state.gitStatus = { repo: false }; }
    emit('git-status', state.gitStatus);
    this.render();
  }

  render() {
    clear(this.body);
    const g = state.gitStatus;
    this.box.style.display = g && g.repo ? '' : 'none';
    if (!state.root) { this.body.append(h('div', { class: 'empty-pane' }, t('noFolder'))); return; }
    if (!g || !g.repo) {
      this.body.append(h('div', { class: 'empty-pane' }, t('notRepo'), h('br'), btn(t('initRepo'), { cls: 'sm primary', onclick: async () => { try { await api.invoke('git:init'); this.refresh(); } catch (e) { toast(e.message, 'error'); } } })));
      return;
    }
    const branchRow = h('div', { class: 'scm-head', style: { textTransform: 'none', cursor: 'pointer' }, onclick: (e) => this.branches(e.currentTarget) },
      icon('git'), h('span', { style: { color: 'var(--fg-2)' } }, g.branch || 'HEAD'),
      g.ahead ? h('span', null, `↑${g.ahead}`) : null, g.behind ? h('span', null, `↓${g.behind}`) : null);
    branchRow.querySelector('svg').style.cssText = 'width:13px;height:13px';
    this.body.append(branchRow);
    if (g.conflicts.length) this.section(t('conflicts'), g.conflicts, 'conflict');
    if (g.staged.length) this.section(t('staged'), g.staged, 'staged');
    this.section(t('changes'), g.unstaged, 'unstaged');
  }

  section(label, list, kind) {
    const head = h('div', { class: 'scm-head' }, h('span', { class: 'grow' }, label), h('span', { class: 'n' }, list.length));
    if (kind === 'unstaged' && list.length) {
      head.append(iconBtn('plus', t('stageAll'), () => this.run('git:stage', list.map((x) => x.path)), 'sm'));
      head.append(iconBtn('undo', t('discard'), () => this.discard(list.map((x) => x.path)), 'sm'));
    }
    if (kind === 'staged') head.append(iconBtn('x', t('unstage'), () => this.run('git:unstage', list.map((x) => x.path)), 'sm'));
    const sec = h('div', { class: 'scm-section' }, head);
    for (const e of list) {
      const code = e.code === 'U?' ? 'U' : e.code;
      const acts = h('span', { class: 'acts' });
      if (kind === 'unstaged') {
        acts.append(iconBtn('undo', t('discard'), (ev) => { ev.stopPropagation(); this.discard([e.path]); }, 'sm'));
        acts.append(iconBtn('plus', t('stage'), (ev) => { ev.stopPropagation(); this.run('git:stage', [e.path]); }, 'sm'));
      } else if (kind === 'staged') {
        acts.append(iconBtn('x', t('unstage'), (ev) => { ev.stopPropagation(); this.run('git:unstage', [e.path]); }, 'sm'));
      } else {
        acts.append(iconBtn('plus', t('stage'), (ev) => { ev.stopPropagation(); this.run('git:stage', [e.path]); }, 'sm'));
      }
      const row = h('div', { class: 'scm-file', title: e.rel },
        h('span', { class: 'fi' }, fileIcon(e.rel, false)),
        h('span', { class: `ellipsis git-${e.code === 'U?' ? 'A' : code}` }, basename(e.rel)),
        h('span', { class: 'dirn' }, dirname(e.rel) === '/' ? '' : dirname(e.rel)),
        acts,
        h('span', { class: `code git-${e.code === 'U?' ? 'A' : code}` }, code));
      row.addEventListener('click', () => this.openDiff(e, kind === 'staged'));
      sec.append(row);
    }
    this.body.append(sec);
  }

  async openDiff(e, staged) {
    if (e.code === 'D' && !staged) { /* deleted in worktree: diff vs empty */ }
    try {
      const d = await api.invoke('git:diff', e.path, staged);
      this.editor.openDiff({ title: `${basename(e.rel)} (${staged ? 'staged' : 'working tree'})`, path: e.path, original: d.original, modified: d.modified, language: langOf(e.path), readOnly: true });
    } catch (err) { toast(err.message, 'error'); }
  }

  async run(ch, files) {
    try { await api.invoke(ch, files); } catch (e) { toast(e.message, 'error'); }
    this.refresh();
  }

  async discard(files) {
    if (!(await confirmDialog(t('discard'), t('discardConfirm', { n: files.length }), t('discard'), true))) return;
    this.run('git:discard', files);
  }

  async commit() {
    const m = this.msg.value.trim();
    if (!m) { this.msg.focus(); return; }
    const g = state.gitStatus;
    try {
      await api.invoke('git:commit', m, { all: g && !g.staged.length });
      this.msg.value = '';
      toast(`${t('commit')} ✓`, 'ok', 2000);
    } catch (e) { toast(e.message, 'error'); }
    this.refresh();
  }

  async generate() {
    this.genBtn.disabled = true;
    try { this.msg.value = await api.invoke('ai:commit-message'); }
    catch (e) { toast(e.message, 'error'); }
    this.genBtn.disabled = false;
  }

  more(anchor) {
    const act = (ch, label) => async () => { try { toast(`${label}…`, 'info', 1500); await api.invoke(ch); toast(`${label} ✓`, 'ok', 2000); } catch (e) { toast(e.message, 'error', 8000); } this.refresh(); };
    popMenu(anchor, [
      { label: t('pull'), icon: 'download', onclick: act('git:pull', t('pull')) },
      { label: t('push'), icon: 'upload', onclick: act('git:push', t('push')) },
      { label: t('fetch'), icon: 'refresh', onclick: act('git:fetch', t('fetch')) },
      { sep: true },
      { label: 'Log', icon: 'history', onclick: () => this.log(anchor) },
    ], { alignRight: true });
  }

  async branches(anchor) {
    let list = [];
    try { list = await api.invoke('git:branches'); } catch (e) { toast(e.message, 'error'); return; }
    popMenu(anchor, [
      { label: 'New branch…', icon: 'plus', onclick: async () => { const n = await promptDialog('New branch', 'feature/…'); if (n) { try { await api.invoke('git:checkout', n.trim(), true); } catch (e) { toast(e.message, 'error'); } this.refresh(); } } },
      { sep: true },
      ...list.filter((b) => !b.name.includes('HEAD')).map((b) => ({ label: b.name, sub: b.when, on: b.current, icon: 'git', onclick: async () => { try { await api.invoke('git:checkout', b.name.replace(/^origin\//, '')); } catch (e) { toast(e.message, 'error'); } this.refresh(); } })),
    ], { search: 'Branch…', minWidth: 280 });
  }

  async log(anchor) {
    let list = [];
    try { list = await api.invoke('git:log', 40); } catch (e) { toast(e.message, 'error'); return; }
    popMenu(anchor, list.map((c) => ({ label: c.subject, sub: `${c.hash} · ${c.when}`, onclick: () => navigator.clipboard.writeText(c.hash) })), { minWidth: 380, search: 'Filter…' });
  }
}
