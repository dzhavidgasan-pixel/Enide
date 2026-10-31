// Soft custom tooltips for anything with a `title`: quicker, readable, with the shortcut
// shown as a key chip ("New chat (⌘⇧L)" → "New chat  ⌘⇧L").
let tip = null, timer = null, current = null;

function split(text) {
  const m = /^(.*?)\s*\(([⌘⌥⇧⌃][^)]*|Ctrl[^)]*|Esc|Tab|F\d+)\)\s*$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

function place(el) {
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let top = r.bottom + 8, cls = 'below';
  if (top + th > window.innerHeight - 6) { top = r.top - th - 8; cls = 'above'; }
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  // vertical bars (activity bar) read better with the tip on the side
  if (r.left < 60 && r.width < 48) { left = r.right + 10; top = r.top + r.height / 2 - th / 2; cls = 'side'; }
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  tip.dataset.side = cls;
}

function hide() {
  clearTimeout(timer);
  if (current && current.dataset.tip && !current.title) current.title = current.dataset.tip;
  current = null;
  if (tip) tip.classList.remove('show');
}

export function initTooltips() {
  if (tip) return;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  document.body.append(tip);
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title]');
    if (!el || el === current) return;
    if (el.closest('.monaco-editor, .xterm, input, textarea, select, .tree-row, .scm-file')) return;
    const text = el.getAttribute('title');
    if (!text || text.length > 160) return;
    hide();
    current = el;
    el.dataset.tip = text;
    el.removeAttribute('title'); // no native tooltip on top of ours
    timer = setTimeout(() => {
      if (current !== el || !el.isConnected) return;
      const [label, keys] = split(text);
      tip.replaceChildren(document.createTextNode(label));
      if (keys) { const k = document.createElement('kbd'); k.textContent = keys; tip.append(k); }
      place(el);
      tip.classList.add('show');
    }, 380);
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (!current) return;
    const to = e.relatedTarget;
    if (to && current.contains(to)) return;
    hide();
  }, true);
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('scroll', hide, true);
}
