// Welcome screen: name, two actions, recent folders. Nothing else.
import { h, icon, btn, basename } from './dom.js';
import { state } from './state.js';
import { t, tr } from './i18n.js';

export function welcome({ onOpenFolder, onOpenPath, onAsk }) {
  const root = h('div', { class: 'welcome' });
  const recent = ((state.settings && state.settings.recent) || []).slice(0, 8);
  const home = state.info ? state.info.home : '';
  root.append(
    h('div', { class: 'hero-logo' }, 'enide'),
    h('div', { class: 'hero-tag' }, t('tagline')),
    h('div', { class: 'hero-actions' },
      btn(t('openFolder'), { cls: 'primary', icon: 'folderOpen', onclick: onOpenFolder }),
      btn(t('askEnide'), { icon: 'message', onclick: onAsk })));
  if (recent.length) {
    root.append(h('div', { class: 'recent' }, h('div', { class: 'recent-h' }, tr('Recent', 'Недавние')),
      ...recent.map((r) => h('button', { class: 'recent-item', onclick: () => onOpenPath(r) }, icon('folder'), h('span', { class: 'n' }, basename(r)), h('span', { class: 'p ellipsis' }, r.replace(home, '~'))))));
  }
  root.destroy = () => {};
  return root;
}
