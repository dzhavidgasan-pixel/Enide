// Welcome screen — modelled on the lightapi.app hero: glowing orb wordmark, white pill,
// dark pill, a terminal-style card and feature cards on a quiet starfield.
import { h, icon, btn, basename } from './dom.js';
import { state, emit } from './state.js';
import { t, tr } from './i18n.js';
import { starfield } from './stars.js';

export function welcome({ onOpenFolder, onOpenPath, onAsk }) {
  const root = h('div', { class: 'welcome' });
  const recent = ((state.settings && state.settings.recent) || []).slice(0, 6);
  const home = state.info ? state.info.home : '';
  const list = h('div', { class: 'recent-list' });
  if (!recent.length) list.append(h('div', { class: 'prompt-line' }, tr('Last login: ', 'Последний вход: ') + new Date().toLocaleString(), h('br'), '~ ❯', h('span', { class: 'cur' })));
  for (const r of recent) {
    list.append(h('div', { class: 'recent-item', onclick: () => onOpenPath(r) }, icon('folder'), h('span', null, basename(r)), h('span', { class: 'p ellipsis' }, r.replace(home, '~'))));
  }
  root.append(
    h('div', { class: 'hero-logo', 'aria-label': 'Enide' }, 'en', h('span', { class: 'ig' }, 'ı', h('span', { class: 'orb' })), 'de'),
    h('div', { class: 'hero-tag' }, t('tagline')),
    h('div', { class: 'hero-actions' },
      btn(t('openFolder'), { cls: 'primary lg', onclick: onOpenFolder }),
      btn(t('askEnide'), { cls: 'lg', onclick: onAsk })),
    h('div', { class: 'card window-card' },
      h('div', { class: 'window-bar', style: { position: 'relative' } }, h('div', { class: 'lights' }, h('i'), h('i'), h('i')), h('span', { class: 't' }, `Enide · zsh · ${t('recent').toLowerCase()}`)),
      list),
    h('div', { class: 'badge', style: { marginTop: '70px' } }, t('whyEnide')),
    h('h2', { class: 'display section-title' }, t('heroTitle1'), h('br'), h('span', { class: 'l2' }, t('heroTitle2'))),
    h('p', { class: 'section-sub' }, t('heroSub')),
    h('div', { class: 'features' },
      feature('eye', t('f.noHidden.t'), t('f.noHidden.d')),
      feature('cpu', t('f.providers.t'), t('f.providers.d')),
      feature('terminal', t('f.agent.t'), t('f.agent.d')),
      feature('puzzle', t('f.plugins.t'), t('f.plugins.d'))),
    h('div', { style: { height: '40px' } }));
  let stars = null;
  requestAnimationFrame(() => {
    if (state.settings && state.settings.starfield !== false) stars = starfield(root, { light: document.documentElement.dataset.theme === 'light' });
  });
  root.destroy = () => { if (stars) stars.destroy(); };
  return root;
}

function feature(ic, title, desc) {
  return h('div', { class: 'card feature' }, h('div', { class: 'tile' }, icon(ic)), h('h3', null, title), h('p', null, desc));
}
