// Safe markdown → DOM. Raw HTML is never interpreted; everything is built with text nodes.
import { h, icon } from './dom.js';

const BLOCK_RE = {
  fence: /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/,
  heading: /^(#{1,6})\s+(.*)$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*>\s?(.*)$/,
  ul: /^(\s*)[-*+]\s+(.*)$/,
  ol: /^(\s*)(\d+)[.)]\s+(.*)$/,
  table: /^\s*\|.*\|\s*$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

export function renderMarkdown(src, opts = {}) {
  const root = h('div', { class: 'md' });
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = h('p');
    inline(para.join('\n'), p, opts);
    root.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = BLOCK_RE.fence.exec(line))) {
      flushPara();
      const fence = m[2];
      const lang = m[3] || '';
      const info = m[4] || '';
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { body.push(lines[i]); i++; }
      const closed = i < lines.length;
      i++;
      root.append(codeBlock(body.join('\n'), lang, info, opts, !closed));
      continue;
    }
    if (!line.trim()) { flushPara(); i++; continue; }
    if ((m = BLOCK_RE.heading.exec(line))) {
      flushPara();
      const el = h('h' + Math.min(m[1].length + 0, 4));
      inline(m[2], el, opts);
      root.append(el);
      i++; continue;
    }
    if (BLOCK_RE.hr.test(line)) { flushPara(); root.append(h('hr')); i++; continue; }
    if (BLOCK_RE.quote.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && (m = BLOCK_RE.quote.exec(lines[i]))) { body.push(m[1]); i++; }
      const bq = h('blockquote');
      bq.append(...renderMarkdown(body.join('\n'), opts).childNodes);
      root.append(bq);
      continue;
    }
    if (BLOCK_RE.table.test(line) && i + 1 < lines.length && BLOCK_RE.tableSep.test(lines[i + 1])) {
      flushPara();
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const table = h('table');
      const thr = h('tr');
      head.forEach((c) => { const th = h('th'); inline(c, th, opts); thr.append(th); });
      table.append(h('thead', null, thr));
      const tb = h('tbody');
      while (i < lines.length && BLOCK_RE.table.test(lines[i])) {
        const tr = h('tr');
        cells(lines[i]).forEach((c) => { const td = h('td'); inline(c, td, opts); tr.append(td); });
        tb.append(tr);
        i++;
      }
      table.append(tb);
      root.append(table);
      continue;
    }
    if (BLOCK_RE.ul.test(line) || BLOCK_RE.ol.test(line)) {
      flushPara();
      const res = parseList(lines, i, opts);
      root.append(res.el);
      i = res.next;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return root;
}

function parseList(lines, start, opts) {
  const first = lines[start];
  const ordered = BLOCK_RE.ol.test(first) && !BLOCK_RE.ul.test(first);
  const indent = (/^(\s*)/.exec(first)[1] || '').length;
  const list = h(ordered ? 'ol' : 'ul');
  if (ordered) { const n = +BLOCK_RE.ol.exec(first)[2]; if (n !== 1) list.setAttribute('start', n); }
  let i = start;
  let li = null;
  let buf = [];
  const flushLi = () => {
    if (!li) return;
    const text = buf.join('\n');
    const sub = renderMarkdown(text, opts);
    if (sub.childNodes.length === 1 && sub.firstChild.tagName === 'P') li.append(...sub.firstChild.childNodes);
    else li.append(...sub.childNodes);
    list.append(li);
    li = null; buf = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const mu = BLOCK_RE.ul.exec(line);
    const mo = BLOCK_RE.ol.exec(line);
    const m = mu || mo;
    const ind = (/^(\s*)/.exec(line)[1] || '').length;
    if (m && ind <= indent + 1) {
      flushLi();
      li = h('li');
      buf.push(mu ? mu[2] : mo[3]);
      i++;
      continue;
    }
    if (!line.trim()) {
      if (i + 1 < lines.length && ((/^(\s*)/.exec(lines[i + 1])[1] || '').length > indent || BLOCK_RE.ul.test(lines[i + 1]) || BLOCK_RE.ol.test(lines[i + 1]))) { buf.push(''); i++; continue; }
      break;
    }
    if (ind > indent) { buf.push(line.slice(Math.min(ind, indent + 2))); i++; continue; }
    if (li && !BLOCK_RE.heading.test(line) && !BLOCK_RE.fence.test(line)) { buf.push(line); i++; continue; }
    break;
  }
  flushLi();
  return { el: list, next: i };
}

function codeBlock(code, lang, info, opts, open) {
  const filePath = /^[\w./-]+\.\w+$/.test(info) ? info : (lang.includes(':') ? lang.split(':')[1] : '');
  const language = lang.includes(':') ? lang.split(':')[0] : lang;
  const lines = code.split('\n');
  const pre = h('pre', null, h('code', null, code));
  const gutter = lines.length > 3 ? h('div', { class: 'cb-gutter', 'aria-hidden': 'true' }, lines.map((_, i) => i + 1).join('\n')) : null;
  const act = (label, ic, title, fn) => h('button', { class: 'cb-btn', title, onclick: fn }, icon(ic), h('span', null, label));
  const actions = [];
  const ru = typeof document !== 'undefined' && document.documentElement.lang === 'ru';
  if (opts.onApply && !open) actions.push(act(ru ? 'Применить' : 'Apply', 'check', filePath ? `Apply to ${filePath}` : 'Apply to active file', () => opts.onApply({ code, language, path: filePath })));
  if (opts.onInsert && !open) actions.push(act(ru ? 'Вставить' : 'Insert', 'arrowDown', 'Insert at cursor', () => opts.onInsert({ code })));
  if (opts.onRun && !open && /^(sh|bash|zsh|shell|console)$/.test(language)) actions.push(act(ru ? 'Запустить' : 'Run', 'play', 'Run in terminal', () => opts.onRun(code)));
  const copyBtn = act(ru ? 'Копировать' : 'Copy', 'copy', 'Copy', () => {
    navigator.clipboard.writeText(code);
    copyBtn.classList.add('done'); copyBtn.lastChild.textContent = ru ? 'Скопировано' : 'Copied';
    setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.lastChild.textContent = ru ? 'Копировать' : 'Copy'; }, 1400);
  });
  const label = filePath || language || 'text';
  const el = h('div', { class: `codeblock ${open ? 'streaming' : ''}` },
    h('div', { class: 'cb-head' },
      h('span', { class: 'cb-dots' }, h('i'), h('i'), h('i')),
      h('span', { class: 'lang' }, label),
      h('span', { class: 'cb-lines' }, `${lines.length} ${ru ? 'стр.' : 'lines'}`),
      h('span', { class: 'cb-actions' }, ...actions, copyBtn)),
    h('div', { class: 'cb-body' }, gutter, pre));
  if (opts.colorize && language) opts.colorize(pre.firstChild, code, language);
  return el;
}

// Inline: `code`, **bold**, *em*, ~~del~~, [text](url), autolinks, path:line.
function inline(text, parent, opts) {
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0, m;
  const pushText = (s) => {
    const parts = s.split('\n');
    parts.forEach((p, i) => { if (i) parent.append(h('br')); if (p) parent.append(p); });
  };
  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index));
    if (m[1]) {
      const c = m[2].replace(/^ (.*) $/, '$1');
      const isPath = /^[\w@.~/-]+\.[a-zA-Z0-9]{1,8}(:\d+(-\d+)?)?$/.test(c) && c.includes('/') || /^[\w-]+\.[a-zA-Z]{1,6}:\d+/.test(c);
      const el = h('code', { class: isPath && opts.onPath ? 'path' : null }, c);
      if (isPath && opts.onPath) el.addEventListener('click', () => opts.onPath(c));
      parent.append(el);
    } else if (m[3] || m[4]) { const el = h('strong'); inline(m[3] || m[4], el, opts); parent.append(el); }
    else if (m[5] || m[6]) { const el = h('em'); inline(m[5] || m[6], el, opts); parent.append(el); }
    else if (m[7]) { const el = h('del'); inline(m[7], el, opts); parent.append(el); }
    else if (m[8]) parent.append(link(m[8], m[9], opts));
    else if (m[10]) parent.append(link(m[10], m[10], opts));
    last = re.lastIndex;
  }
  if (last < text.length) pushText(text.slice(last));
}

function link(label, href, opts) {
  const safe = /^(https?:|mailto:)/i.test(href);
  const a = h('a', { title: href }, label);
  if (safe) a.addEventListener('click', (e) => { e.preventDefault(); opts.onLink ? opts.onLink(href) : null; });
  return a;
}
