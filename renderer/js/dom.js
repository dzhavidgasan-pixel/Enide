import { svg } from './icons.js';

// h('div', { class: 'x', onclick: fn }, child, 'text', [more])
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const icon = (name, cls) => svg(name, cls);

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, onclick }, icon(name));
}

export function btn(label, opts = {}) {
  const { icon: ic, cls = '', onclick, title, disabled } = opts;
  return h('button', { class: `btn ${cls}`, onclick, title, disabled }, ic ? icon(ic) : null, label);
}

export function toggle(on, onchange) {
  const el = h('div', { class: `switch ${on ? 'on' : ''}`, role: 'switch', tabindex: 0 });
  const set = (v) => { el.classList.toggle('on', v); };
  el.addEventListener('click', () => { const v = !el.classList.contains('on'); set(v); onchange(v); });
  el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); el.click(); } });
  return el;
}

export function seg(options, value, onchange) {
  const wrap = h('div', { class: 'seg' });
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(h('button', { class: o.value === v ? 'on' : '', title: o.title, onclick: () => { render(o.value); onchange(o.value); } }, o.icon ? icon(o.icon) : null, o.label));
    }
  };
  render(value);
  wrap.setValue = render;
  return wrap;
}

// Positioned popup menu. items: [{ label, icon, sub, on, onclick } | { sep: true } | { header }]
let openMenu = null;
export function popMenu(anchor, items, opts = {}) {
  closeMenu();
  const m = h('div', { class: 'menu' });
  let search;
  const list = h('div');
  const renderItems = (q = '') => {
    clear(list);
    const ql = q.toLowerCase();
    for (const it of items) {
      if (it.sep) { if (!q) list.append(h('div', { class: 'sep' })); continue; }
      if (it.header) { if (!q) list.append(h('div', { class: 'mh' }, it.lead ? it.lead() : null, it.header)); continue; }
      if (q && !(`${it.label} ${it.sub || ''} ${it.keywords || ''}`.toLowerCase().includes(ql))) continue;
      const row = h('div', { class: `mi ${it.on ? 'on' : ''}`, title: it.title || '' },
        opts.checks ? h('span', { class: 'check-ic' }, it.on ? icon('check') : null) : null,
        it.lead ? it.lead() : it.icon ? icon(it.icon) : null,
        h('span', { class: 'ellipsis grow' }, it.label),
        it.sub ? h('span', { class: 'sub' }, it.sub) : null);
      row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.onclick && it.onclick(); });
      list.append(row);
    }
  };
  if (opts.search) {
    search = h('input', { class: 'input menu-search', placeholder: opts.search, oninput: (e) => renderItems(e.target.value) });
    m.append(search);
  }
  m.append(list);
  renderItems();
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = Math.max(m.offsetWidth, opts.minWidth || 0);
  if (opts.minWidth) m.style.minWidth = opts.minWidth + 'px';
  let left = opts.alignRight ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  const mh = m.offsetHeight;
  let top = opts.above || r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6;
  top = Math.max(8, top);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  openMenu = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) closeMenu(); };
    const key = (e) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', key, true);
    m._off = () => { document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', key, true); };
  });
  if (search) search.focus();
  return m;
}
export function closeMenu() {
  if (openMenu) { if (openMenu._off) openMenu._off(); openMenu.remove(); openMenu = null; }
}

export function modal({ title, body, footer, size = 'sm', onclose }) {
  const host = document.getElementById('overlays');
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc, true); onclose && onclose(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const m = h('div', { class: `modal ${size}` },
    title != null ? h('div', { class: 'modal-head' }, h('h2', null, title), iconBtn('x', 'Close', () => close())) : null,
    h('div', { class: 'modal-body selectable' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } }, m);
  host.append(ov);
  document.addEventListener('keydown', esc, true);
  return { close, el: m };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title, body: h('p', { class: 'dim', style: { margin: '0 0 6px', lineHeight: 1.6 } }, text),
      footer: [btn('Cancel', { onclick: () => { finish(false); m.close(); } }), btn(okLabel, { cls: danger ? 'danger' : 'primary', onclick: () => { finish(true); m.close(); } })],
      onclose: () => finish(false),
    });
  });
}

export function promptDialog(title, placeholder = '', value = '') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = h('input', { class: 'input', placeholder, value });
    const m = modal({
      title, body: input,
      footer: [btn('Cancel', { onclick: () => { finish(null); m.close(); } }), btn('OK', { cls: 'primary', onclick: () => { finish(input.value); m.close(); } })],
      onclose: () => finish(null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { finish(input.value); m.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function toast(text, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'), h('div', null, text));
  host.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
  t.addEventListener('click', () => t.remove());
}

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  if (d < 86400 * 7) return Math.floor(d / 86400) + 'd';
  return new Date(ts).toLocaleDateString();
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

export function basename(p) { return String(p || '').split('/').filter(Boolean).pop() || p; }
export function dirname(p) { const s = String(p || '').split('/'); s.pop(); return s.join('/') || '/'; }
export function relPath(root, p) { if (root && p && p.startsWith(root + '/')) return p.slice(root.length + 1); return p; }

export function jsonHighlight(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  const pre = h('pre', { class: 'code-view json' });
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) pre.append(text.slice(last, m.index));
    if (m[1]) { pre.append(h('span', { class: m[2] ? 'k' : 's' }, m[1])); if (m[2]) pre.append(m[2]); }
    else if (m[3]) pre.append(h('span', { class: 'b' }, m[3]));
    else if (m[4]) pre.append(h('span', { class: 'n' }, m[4]));
    last = re.lastIndex;
  }
  pre.append(text.slice(last));
  return pre;
}
