import { h, clear, icon, iconBtn, btn, toast, confirmDialog, basename, dirname, relPath } from './dom.js';
import { fileIcon } from './icons.js';
import { api } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

export class SearchPane {
  constructor(host, { onOpen }) {
    this.host = host;
    this.onOpen = onOpen;
    this.opts = { regex: false, caseSensitive: false, wholeWord: false };
    this.collapsed = new Set();
    this.build();
  }

  build() {
    clear(this.host);
    const optBtn = (key, label, title) => {
      const b = h('button', { class: this.opts[key] ? 'on' : '', title, onclick: () => { this.opts[key] = !this.opts[key]; b.classList.toggle('on', this.opts[key]); this.run(); } }, label);
      return b;
    };
    this.q = h('input', { class: 'input', placeholder: t('searchPlaceholder') });
    this.rep = h('input', { class: 'input', placeholder: t('replacePlaceholder') });
    this.inc = h('input', { class: 'input', placeholder: t('include') + ' (*.ts, src/**)' });
    this.exc = h('input', { class: 'input', placeholder: t('exclude') });
    this.summary = h('div', { class: 'muted', style: { fontSize: '11.5px', padding: '0 12px 6px' } });
    this.results = h('div', { class: 'pane-body' });
    const form = h('div', { class: 'search-form' },
      h('div', { class: 'search-input' }, this.q, h('div', { class: 'opts' }, optBtn('caseSensitive', 'Aa', 'Match case'), optBtn('wholeWord', 'ab', 'Whole word'), optBtn('regex', '.*', 'Regular expression'))),
      h('div', { class: 'row' }, this.rep, btn('', { cls: 'sm', icon: 'check', title: t('replaceAll'), onclick: () => this.replaceAll() })),
      this.inc, this.exc);
    this.host.append(h('div', { class: 'pane-head' }, h('div', { class: 'pane-title' }, '/', h('b', null, t('search')))), form, this.summary, this.results);
    let timer;
    const deb = () => { clearTimeout(timer); timer = setTimeout(() => this.run(), 250); };
    this.q.addEventListener('input', deb);
    this.inc.addEventListener('input', deb);
    this.exc.addEventListener('input', deb);
    this.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.run(); });
  }

  focus(text) { if (text) this.q.value = text; this.q.focus(); this.q.select(); if (text) this.run(); }

  async run() {
    const query = this.q.value;
    clear(this.results);
    this.summary.textContent = '';
    if (!query || !state.root) return;
    const my = (this.seq = (this.seq || 0) + 1);
    let r;
    try { r = await api.invoke('ws:search', { query, ...this.opts, include: this.inc.value, exclude: this.exc.value }); }
    catch (e) { this.summary.textContent = e.message; return; }
    if (my !== this.seq) return;
    this.last = r;
    this.summary.textContent = r.total ? `${r.total}${r.capped ? '+' : ''} ${t('results')} · ${r.results.length} files` : t('noResults');
    for (const f of r.results) {
      const open = !this.collapsed.has(f.file);
      const head = h('div', { class: 'result-file', title: f.file },
        icon('chevron', `chev ${open ? 'open' : ''}`), h('span', { class: 'fi' }, fileIcon(f.rel, false)), h('span', { class: 'ellipsis' }, basename(f.rel)),
        h('span', { class: 'muted ellipsis', style: { fontSize: '11px' } }, dirname(f.rel) === '/' ? '' : dirname(f.rel)), h('span', { class: 'count' }, f.matches.length));
      head.querySelector('.chev').style.cssText = `width:12px;height:12px;flex:none;transition:transform .12s;${open ? 'transform:rotate(90deg)' : ''}`;
      head.addEventListener('click', () => { if (open) this.collapsed.add(f.file); else this.collapsed.delete(f.file); this.renderCached(); });
      this.results.append(head);
      if (!open) continue;
      for (const m of f.matches.slice(0, 200)) {
        const col = m.col - 1 - (m.offset || 0);
        const line = h('div', { class: 'result-line', title: `${f.rel}:${m.line}` },
          m.text.slice(Math.max(0, col - 40), col).replace(/^\s+/, ''), h('mark', null, m.text.slice(col, col + m.length)), m.text.slice(col + m.length, col + m.length + 120));
        line.addEventListener('click', () => this.onOpen(f.file, { line: m.line, col: m.col, preview: true }));
        this.results.append(line);
      }
    }
  }

  renderCached() { if (this.last) { const q = this.q.value; this.run(); } }

  async replaceAll() {
    if (!this.last || !this.last.results.length) return;
    const files = this.last.results.map((r) => r.file);
    if (!(await confirmDialog(t('replaceAll'), `"${this.q.value}" → "${this.rep.value}" · ${this.last.total} × ${files.length} files`, t('replaceAll'), true))) return;
    try {
      const n = await api.invoke('ws:replace', { query: this.q.value, ...this.opts }, this.rep.value, files);
      toast(`${n} ✓`, 'ok');
      this.run();
    } catch (e) { toast(e.message, 'error'); }
  }
}
