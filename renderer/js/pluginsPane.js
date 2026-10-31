// Sidebar view: live status of MCP servers and Enide plugins, with shortcuts to settings.
import { h, clear, icon, iconBtn, btn } from './dom.js';
import { api } from './api.js';
import { state, emit } from './state.js';
import { t, tr } from './i18n.js';

export class PluginsPane {
  constructor(host, { openSettings }) {
    this.host = host;
    this.openSettings = openSettings;
    this.mcp = [];
    this.plugins = [];
    this.build();
    api.on('mcp:changed', (s) => { this.mcp = s; this.render(); });
    api.on('plugins:changed', (s) => { this.plugins = s; this.render(); });
    this.refresh();
  }
  build() {
    clear(this.host);
    this.body = h('div', { class: 'pane-body' });
    this.host.append(h('div', { class: 'pane-head' }, h('div', { class: 'pane-title' }, '/', h('b', null, t('plugins'))),
      iconBtn('refresh', t('refresh'), () => this.refresh(), 'sm'), iconBtn('settings', t('settings'), () => this.openSettings('plugins'), 'sm')), this.body);
  }
  async refresh() {
    try { this.mcp = await api.invoke('mcp:status'); } catch {}
    try { this.plugins = await api.invoke('plugins:status'); } catch {}
    this.render();
  }
  render() {
    clear(this.body);
    this.body.append(h('div', { class: 'scm-head' }, h('span', { class: 'grow' }, 'MCP'), h('span', { class: 'n' }, this.mcp.length)));
    if (!this.mcp.length) this.body.append(h('div', { class: 'empty-pane', style: { paddingTop: '6px' } }, tr('Add servers from the catalog: Playwright, Context7, GitHub, Memory…', 'Добавь серверы из каталога: Playwright, Context7, GitHub, Memory…'), h('br'), btn(tr('Browse catalog', 'Открыть каталог'), { cls: 'sm primary', onclick: () => this.openSettings('plugins') })));
    for (const s of this.mcp) {
      const dot = s.status === 'ready' ? 'ok' : s.status === 'error' ? 'err' : s.status === 'starting' ? 'busy' : '';
      this.body.append(h('div', { class: 'plug-item', onclick: () => this.openSettings('plugins'), style: { cursor: 'pointer' } },
        h('div', { class: 'tile' }, icon('plug')),
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'nm' }, h('span', { class: `dot ${dot}` }), s.name),
          h('div', { class: 'ds ellipsis' }, s.status === 'ready' ? s.tools.map((x) => x.name).join(', ') || tr('no tools', 'нет инструментов') : s.error || s.status))));
    }
    this.body.append(h('div', { class: 'scm-head', style: { marginTop: '10px' } }, h('span', { class: 'grow' }, tr('Plugins', 'Плагины')), h('span', { class: 'n' }, this.plugins.length)));
    if (!this.plugins.length) this.body.append(h('div', { class: 'empty-pane', style: { paddingTop: '6px' } }, tr('Write tools in JavaScript — "Create plugin" scaffolds one.', 'Пиши инструменты на JavaScript — «Создать плагин» сделает заготовку.')));
    for (const p of this.plugins) {
      this.body.append(h('div', { class: 'plug-item', onclick: () => this.openSettings('plugins'), style: { cursor: 'pointer' } },
        h('div', { class: 'tile' }, icon('puzzle')),
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'nm' }, h('span', { class: `dot ${p.error ? 'err' : p.enabled ? 'ok' : ''}` }), p.name),
          h('div', { class: 'ds ellipsis' }, p.error || `${p.tools.length} tools · ${p.commands.length} commands`))));
    }
  }
}
