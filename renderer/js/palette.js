// ⌘P quick open and ⌘⇧P command palette.
import { h, clear, icon } from './dom.js';
import { fileIcon } from './icons.js';
import { api } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

let current = null;

function score(q, s) {
  q = q.toLowerCase(); const l = s.toLowerCase();
  if (!q) return 1;
  const base = l.split('/').pop();
  if (base === q) return 2000;
  if (base.startsWith(q)) return 1500 - base.length;
  if (base.includes(q)) return 1000 - base.length;
  if (l.includes(q)) return 700 - l.length;
  let i = 0, sc = 0, last = -2;
  for (let j = 0; j < l.length && i < q.length; j++) if (l[j] === q[i]) { sc += j === last + 1 ? 6 : 1; last = j; i++; }
  return i === q.length ? sc : -1;
}

function highlight(text, q) {
  if (!q) return [text];
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [text];
  return [text.slice(0, i), h('b', null, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

export function closePalette() { if (current) { current.remove(); current = null; } }

function openList({ placeholder, initial = '', getItems }) {
  closePalette();
  const input = h('input', { placeholder, value: initial });
  const list = h('div', { class: 'list' });
  const box = h('div', { class: 'palette' }, input, list);
  const back = h('div', { class: 'palette-backdrop', onmousedown: () => closePalette() });
  const wrap = h('div', null, back, box);
  document.body.append(wrap);
  current = wrap;
  let items = [];
  let idx = 0;
  const render = async () => {
    const q = input.value;
    items = await getItems(q);
    idx = 0;
    draw(q);
  };
  const draw = (q) => {
    clear(list);
    items.slice(0, 80).forEach((it, i) => {
      const row = h('div', { class: `pi ${i === idx ? 'hl' : ''}` }, it.fileIcon ? fileIcon(it.fileIcon, false) : icon(it.icon || 'command'), h('span', { class: 'ellipsis' }, ...highlight(it.label, it.hlQuery != null ? it.hlQuery : q)), it.desc ? h('span', { class: 'desc' }, it.desc) : null, it.sub ? h('span', { class: 'sub' }, it.sub) : null);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); closePalette(); it.run(); });
      row.addEventListener('mousemove', () => { if (idx !== i) { idx = i; draw(q); } });
      list.append(row);
    });
    const hl = list.querySelector('.hl');
    if (hl) hl.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[idx]; if (it) { closePalette(); it.run(); } }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  render();
  setTimeout(() => input.focus(), 0);
}

let fileCache = null;
let fileCacheRoot = null;
api.on('ws:changed', () => { fileCache = null; });

export function quickOpen({ onOpen, recent = [], commands }) {
  openList({
    placeholder: t('quickOpen') + '   (> for commands)',
    getItems: async (q) => {
      if (q.startsWith('>')) return commandItems(commands, q.slice(1).trim());
      if (!state.root) return commandItems(commands, q);
      if (!fileCache || fileCacheRoot !== state.root) { try { fileCache = await api.invoke('ws:list-files'); fileCacheRoot = state.root; } catch { fileCache = []; } }
      let line = null;
      const m = /^(.*?):(\d+)$/.exec(q);
      if (m) { q = m[1]; line = +m[2]; }
      let list;
      if (!q) list = [...recent.filter((r) => r.startsWith(state.root)).map((r) => r.slice(state.root.length + 1)), ...fileCache.filter((f) => !recent.includes(state.root + '/' + f))];
      else list = fileCache.map((f) => ({ f, s: score(q, f) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.f);
      return list.slice(0, 80).map((f) => {
        const parts = f.split('/');
        const base = parts.pop();
        return { label: base, desc: f.startsWith('/') ? parts.join('/').replace(state.info.home, '~') : parts.join('/'), fileIcon: base, hlQuery: q, run: () => onOpen(f.startsWith('/') ? f : state.root + '/' + f, { line, preview: false }) };
      });
    },
  });
}

function commandItems(commands, q) {
  return commands
    .map((c) => ({ c, s: score(q, c.label + ' ' + (c.keywords || '')) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => (q ? b.s - a.s : 0))
    .map(({ c }) => ({ label: c.label, sub: c.key, icon: c.icon || 'command', run: c.run }));
}

export function commandPalette(commands) {
  openList({ placeholder: t('commandPalette'), getItems: async (q) => commandItems(commands, q.replace(/^>\s*/, '')) });
}
