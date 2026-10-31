// Bottom panel: terminals (xterm.js) + request log.
import { h, clear, icon, iconBtn, modal, jsonHighlight, fmtTokens, basename, btn } from './dom.js';
import { api } from './api.js';
import { state, emit, on } from './state.js';
import { relPath, toast } from './dom.js';
import { t, tr } from './i18n.js';

export class BottomPanel {
  constructor(host) {
    this.host = host;
    this.terms = [];
    this.view = 'terminal';
    this.active = null;
    this.reqs = [];
    this.problems = [];
    this.problemSources = {};
    this.build();
    api.on('term:data', (id, data) => { const tm = this.terms.find((x) => x.id === id); if (tm) tm.write(data); });
    api.on('term:exit', (id) => { const tm = this.terms.find((x) => x.id === id); if (tm) { tm.write(`\r\n\x1b[2m[process exited]\x1b[0m\r\n`); tm.exited = true; } });
    api.on('requestlog:entry', (e) => this.onReq(e));
    api.invoke('requestlog:list').then((l) => { this.reqs = l || []; if (this.view === 'requests') this.renderBody(); }).catch(() => {});
    on('new-terminal', (cwd) => { emit('show-panel'); this.newTerminal(cwd); });
  }

  build() {
    clear(this.host);
    this.tabsEl = h('div', { class: 'panel-tabs' });
    this.body = h('div', { class: 'panel-body' });
    this.host.append(this.tabsEl, this.body);
    this.renderTabs();
  }

  renderTabs() {
    clear(this.tabsEl);
    this.terms.forEach((tm, i) => {
      const b = h('button', { class: `panel-tab ${this.view === 'terminal' && this.active === tm ? 'on' : ''}`, onclick: () => { this.view = 'terminal'; this.active = tm; this.renderTabs(); this.renderBody(); } },
        icon('terminal'), `${basename(tm.cwd || '') || 'zsh'}${this.terms.length > 1 ? ' ' + (i + 1) : ''}`,
        h('span', { class: 'x', onclick: (e) => { e.stopPropagation(); this.kill(tm); } }, icon('x')));
      b.querySelector('svg').style.cssText = 'width:12px;height:12px';
      this.tabsEl.append(b);
    });
    if (!this.terms.length) this.tabsEl.append(h('button', { class: `panel-tab ${this.view === 'terminal' ? 'on' : ''}`, onclick: () => { this.view = 'terminal'; this.newTerminal(); } }, t('terminal')));
    const pe = this.problems.filter((x) => x.severity === 'error').length;
    this.tabsEl.append(h('button', { class: `panel-tab ${this.view === 'problems' ? 'on' : ''}`, onclick: () => this.showProblems(false) }, tr('problems', 'проблемы'), this.problems.length ? h('span', { style: { color: pe ? 'var(--err)' : 'var(--warn)' } }, String(this.problems.length)) : null));
    this.tabsEl.append(h('button', { class: `panel-tab ${this.view === 'requests' ? 'on' : ''}`, onclick: () => { this.view = 'requests'; this.renderTabs(); this.renderBody(); } }, t('requests'), this.reqs.length ? h('span', { class: 'muted' }, String(this.reqs.length)) : null));
    this.tabsEl.append(h('span', { class: 'grow' }));
    this.tabsEl.append(iconBtn('plus', t('newTerminal'), () => this.newTerminal(), 'sm'));
    this.tabsEl.append(iconBtn('x', 'Close panel', () => emit('cmd', 'toggle-panel'), 'sm'));
  }

  renderBody() {
    for (const el of [...this.body.children]) el.style.display = 'none';
    if (this.view === 'terminal') {
      if (!this.active && this.terms.length) this.active = this.terms[0];
      if (this.active) { this.active.el.style.display = ''; requestAnimationFrame(() => this.active.fit()); this.active.focus(); }
      if (this.reqEl) this.reqEl.style.display = 'none';
    } else if (this.view === 'problems') {
      if (this.reqEl) this.reqEl.style.display = 'none';
      if (!this.probEl) { this.probEl = h('div', { class: 'reqlog' }); this.body.append(this.probEl); }
      this.probEl.style.display = '';
      this.renderProblems();
    } else {
      if (this.probEl) this.probEl.style.display = 'none';
      if (!this.reqEl) { this.reqEl = h('div', { class: 'reqlog' }); this.body.append(this.reqEl); }
      this.reqEl.style.display = '';
      this.renderReqs();
    }
  }

  // ---------- problems: linters + AI review ----------
  setProblems({ source, items }) {
    this.problemSources[source] = items || [];
    if (source === 'agent') this.problemSources.lint = items || [];
    this.problems = [...(this.problemSources.lint || []), ...(this.problemSources.review || [])];
    emit('markers', this.problems);
    this.renderTabs();
    if (this.view === 'problems') this.renderProblems();
  }

  async showProblems(run) {
    this.view = 'problems';
    this.renderTabs(); this.renderBody();
    if (run) await this.runLint();
  }

  async runLint() {
    this.busy = tr('Checking…', 'Проверяю…'); this.renderProblems();
    try { const r = await api.invoke('lint:run', []); this.ran = r.ran; emit('problems', { source: 'lint', items: r.items }); }
    catch (e) { toast(e.message, 'error'); }
    this.busy = null; this.renderProblems();
  }

  async runReview() {
    this.view = 'problems'; this.renderTabs(); this.renderBody();
    this.busy = tr('AI review of uncommitted changes…', 'ИИ-ревью незакоммиченных изменений…'); this.renderProblems();
    try { const items = await api.invoke('review:run'); emit('problems', { source: 'review', items }); toast(items.length ? tr(`Review: ${items.length} finding(s)`, `Ревью: замечаний — ${items.length}`) : tr('Review: no problems found', 'Ревью: проблем не найдено'), items.length ? 'info' : 'ok'); }
    catch (e) { toast(e.message, 'error', 8000); }
    this.busy = null; this.renderProblems();
  }

  renderProblems() {
    if (!this.probEl) return;
    clear(this.probEl);
    const bar = h('div', { class: 'row', style: { padding: '8px 12px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--bg)' } },
      btn(tr('Check project', 'Проверить проект'), { cls: 'sm', icon: 'alert', onclick: () => this.runLint() }),
      btn(tr('AI review changes', 'ИИ-ревью изменений'), { cls: 'sm', icon: 'shield', onclick: () => this.runReview() }),
      this.busy ? h('span', { class: 'muted' }, this.busy) : (this.ran && this.ran.length ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, this.ran.join(', ')) : null),
      h('span', { class: 'grow' }),
      this.problems.length ? btn(tr('Fix all with agent', 'Исправить всё агентом'), { cls: 'sm primary', icon: 'wrench', onclick: () => emit('fix-problems', this.problems) }) : null);
    this.probEl.append(bar);
    if (!this.problems.length) { this.probEl.append(h('div', { class: 'empty-pane' }, tr('No problems. Run a check or an AI review.', 'Проблем нет. Запусти проверку или ИИ-ревью.'))); return; }
    const list = h('div', { class: 'problems' });
    for (const it of this.problems) {
      const row = h('div', { class: `problem ${it.severity}` }, h('span', { class: 'sev' }, icon(it.severity === 'error' ? 'xCircle' : it.severity === 'warning' ? 'alert' : 'info')),
        h('span', { class: 'loc mono' }, `${relPath(state.root, it.file)}:${it.line}`),
        h('span', { class: 'msg' }, it.title ? h('b', null, it.title + ' — ') : null, it.body || it.message),
        h('span', { class: 'src' }, it.source === 'review' ? 'AI review' : (it.code || it.source)),
        iconBtn('wrench', tr('Fix with agent', 'Исправить агентом'), (e) => { e.stopPropagation(); emit('fix-problems', [it]); }, 'sm'));
      row.addEventListener('click', () => emit('open-file-at', it.file, it.line, it.col));
      list.append(row);
    }
    this.probEl.append(list);
  }

  onShow() { if (this.view === 'terminal' && !this.terms.length) this.newTerminal(); else this.renderBody(); }

  async newTerminal(cwd) {
    const id = 't' + Date.now().toString(36);
    const el = h('div', { class: 'term-host' });
    this.body.append(el);
    let tm;
    if (window.Terminal) {
      const light = document.documentElement.dataset.theme === 'light';
      const term = new window.Terminal({
        fontFamily: (state.settings.editor || {}).fontFamily || 'Menlo, monospace', fontSize: (state.settings.terminal || {}).fontSize || 12,
        cursorBlink: true, cursorStyle: 'block', allowProposedApi: true, scrollback: 10000, macOptionIsMeta: true,
        theme: light ? { background: '#ffffff', foreground: '#111', cursor: '#000', selectionBackground: '#0002' } : { background: '#00000000', foreground: '#e8e8ec', cursor: '#ffffff', cursorAccent: '#000', selectionBackground: '#ffffff33', black: '#1c1c1f', brightBlack: '#5c5c66' },
        allowTransparency: true,
      });
      const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
      if (fit) term.loadAddon(fit);
      term.open(el);
      term.onData((d) => api.send('term:write', id, d));
      tm = {
        id, el, term, cwd,
        write: (d) => term.write(d),
        fit: () => { try { if (fit && el.offsetWidth) { fit.fit(); api.send('term:resize', id, term.cols, term.rows); } } catch {} },
        focus: () => term.focus(),
        dispose: () => term.dispose(),
      };
      new ResizeObserver(() => tm.fit()).observe(el);
    } else {
      const out = h('pre', { class: 'selectable' });
      const input = h('input', { placeholder: '$ command' });
      const wrap = h('div', { class: 'term-fallback' }, out, input);
      el.append(wrap);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { api.send('term:write', id, input.value + '\n'); input.value = ''; } });
      tm = { id, el, cwd, write: (d) => { out.textContent += String(d).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''); out.scrollTop = out.scrollHeight; }, fit: () => {}, focus: () => input.focus(), dispose: () => {} };
    }
    this.terms.push(tm);
    this.active = tm;
    this.view = 'terminal';
    this.renderTabs();
    this.renderBody();
    try {
      const r = await api.invoke('term:create', { id, cwd: cwd || state.root, cols: tm.term ? tm.term.cols : 100, rows: tm.term ? tm.term.rows : 24 });
      tm.cwd = r.cwd;
      this.renderTabs();
      setTimeout(() => tm.fit(), 50);
    } catch (e) { tm.write(`\r\n[failed to start shell] ${e.message}\r\n`); }
    return tm;
  }

  runInTerminal(cmd) {
    const go = (tm) => api.send('term:write', tm.id, cmd.replace(/\n$/, '') + '\n');
    emit('show-panel');
    if (this.active && !this.active.exited) { this.view = 'terminal'; this.renderTabs(); this.renderBody(); go(this.active); }
    else this.newTerminal().then((tm) => setTimeout(() => go(tm), 600));
  }

  kill(tm) {
    api.invoke('term:kill', tm.id).catch(() => {});
    tm.dispose();
    tm.el.remove();
    this.terms = this.terms.filter((x) => x !== tm);
    if (this.active === tm) this.active = this.terms[this.terms.length - 1] || null;
    this.renderTabs();
    this.renderBody();
  }

  onReq(e) {
    const i = this.reqs.findIndex((x) => x.id === e.id);
    if (i >= 0) this.reqs[i] = e; else this.reqs.push(e);
    if (this.reqs.length > 150) this.reqs.shift();
    if (this.view === 'requests') this.renderReqs();
    clearTimeout(this.tabTimer);
    this.tabTimer = setTimeout(() => this.renderTabs(), 300);
  }

  renderReqs() {
    if (!this.reqEl) return;
    clear(this.reqEl);
    const table = h('table', null, h('thead', null, h('tr', null, ...['time', 'kind', 'model', 'status', 'ttfb', 'total', 'in', 'out'].map((c) => h('th', null, c)))));
    const tb = h('tbody');
    for (const r of [...this.reqs].reverse()) {
      const u = r.usage || {};
      const row = h('tr', { onclick: () => showRequest(r.id) },
        h('td', null, new Date(r.time).toLocaleTimeString()), h('td', null, r.kind || 'agent'), h('td', null, `${r.provider || ''} · ${r.model || ''}`),
        h('td', { style: { color: r.error ? 'var(--err)' : r.status && r.status >= 400 ? 'var(--err)' : 'var(--fg-2)' } }, r.error ? 'error' : r.status || '…'),
        h('td', null, r.ttfbMs ? r.ttfbMs + 'ms' : ''), h('td', null, r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''),
        h('td', null, fmtTokens(u.input)), h('td', null, fmtTokens(u.output)));
      tb.append(row);
    }
    table.append(tb);
    this.reqEl.append(this.reqs.length ? table : h('div', { class: 'empty-pane' }, tr('Every request Enide sends to a model appears here — with the exact body.', 'Здесь появляется каждый запрос к модели — с точным телом.')));
  }
}

export async function showRequest(id) {
  let r;
  try { r = await api.invoke('requestlog:get', id); } catch { return; }
  if (!r) return;
  const body = h('div', null,
    h('div', { class: 'row', style: { marginBottom: '10px', flexWrap: 'wrap' } },
      h('span', { class: 'chip' }, r.method || 'POST'), h('span', { class: 'mono dim', style: { fontSize: '12px', wordBreak: 'break-all' } }, r.url),
      r.status ? h('span', { class: 'chip' }, `HTTP ${r.status}`) : null, r.ms ? h('span', { class: 'chip' }, `${(r.ms / 1000).toFixed(2)}s`) : null),
    r.error ? h('div', { class: 'notice error' }, icon('alert'), h('div', { class: 'body' }, r.error)) : null,
    h('div', { class: 'group-title' }, 'headers (keys redacted)'), jsonHighlight(r.headers || {}),
    h('div', { class: 'group-title' }, tr('body — exactly what was sent', 'тело — ровно то, что отправлено')),
    h('div', { class: 'row', style: { marginBottom: '6px' } }, btn(t('copy'), { cls: 'sm', icon: 'copy', onclick: () => navigator.clipboard.writeText(JSON.stringify(r.body, null, 2)) })),
    jsonHighlight(r.body || {}),
    r.response ? h('div', null, h('div', { class: 'group-title' }, 'response (summary)'), jsonHighlight(r.response)) : null,
    r.usage ? h('div', null, h('div', { class: 'group-title' }, 'usage'), jsonHighlight(r.usage)) : null);
  modal({ title: `${t('requestLog')} · ${r.model || ''}`, body, size: 'md' });
}
