// Editor area: Monaco (with a plain fallback), tabs, diffs, inline edit (⌘K), Tab autocomplete.
import { h, clear, icon, iconBtn, btn, toast, basename, relPath, confirmDialog } from './dom.js';
import { fileIcon } from './icons.js';
import { api } from './api.js';
import { state, emit, on } from './state.js';
import { t, tr } from './i18n.js';

let monaco = null;
export const monacoReady = new Promise((resolve) => {
  const req = window.require;
  if (!req || !req.config) { resolve(null); return; }
  try {
    req.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    req(['vs/editor/editor.main'], () => { monaco = window.monaco; defineThemes(); resolve(monaco); }, () => resolve(null));
  } catch { resolve(null); }
});

function defineThemes() {
  monaco.editor.defineTheme('enide-dark', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment', foreground: '6c6c75', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c8b6ff' },
      { token: 'string', foreground: 'b9e6a5' },
      { token: 'number', foreground: 'ffb38a' },
      { token: 'type', foreground: '8fd3ff' },
      { token: 'delimiter', foreground: '9a9aa3' },
    ],
    colors: {
      'editor.background': '#000000', 'editor.foreground': '#ececf0', 'editorLineNumber.foreground': '#3a3a41', 'editorLineNumber.activeForeground': '#a3a3ab',
      'editor.lineHighlightBackground': '#0b0b0d', 'editor.lineHighlightBorder': '#00000000', 'editor.selectionBackground': '#ffffff26', 'editor.inactiveSelectionBackground': '#ffffff14',
      'editorCursor.foreground': '#ffffff', 'editorIndentGuide.background1': '#ffffff0d', 'editorIndentGuide.activeBackground1': '#ffffff26', 'editorWhitespace.foreground': '#ffffff1a',
      'editorWidget.background': '#0c0c0e', 'editorWidget.border': '#ffffff1f', 'editorSuggestWidget.background': '#0c0c0e', 'editorSuggestWidget.border': '#ffffff1f', 'editorSuggestWidget.selectedBackground': '#1c1c21',
      'editorHoverWidget.background': '#0c0c0e', 'editorHoverWidget.border': '#ffffff1f', 'scrollbarSlider.background': '#ffffff14', 'scrollbarSlider.hoverBackground': '#ffffff24',
      'editorGutter.background': '#000000', 'minimap.background': '#000000', 'editorStickyScroll.background': '#050506', 'editorStickyScrollHover.background': '#111114',
      'diffEditor.insertedTextBackground': '#5ee08f22', 'diffEditor.removedTextBackground': '#ff7a7a22', 'diffEditor.insertedLineBackground': '#5ee08f12', 'diffEditor.removedLineBackground': '#ff7a7a12',
      'editorGhostText.foreground': '#ffffff55', 'focusBorder': '#ffffff33', 'input.background': '#050506', 'input.border': '#ffffff1f',
    },
  });
  monaco.editor.defineTheme('enide-light', {
    base: 'vs', inherit: true, rules: [],
    colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f6f6f7', 'editorLineNumber.foreground': '#c4c4c9', 'editorGhostText.foreground': '#00000055' },
  });
}

const LANGS = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', swift: 'swift', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', zsh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', xml: 'xml', svg: 'xml', vue: 'html', dockerfile: 'dockerfile', lua: 'lua', r: 'r', dart: 'dart' };
export function langOf(path) {
  const n = basename(path).toLowerCase();
  if (n === 'dockerfile') return 'dockerfile';
  if (n === 'makefile') return 'makefile';
  return LANGS[n.split('.').pop()] || 'plaintext';
}
const IMG = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

export class EditorArea {
  constructor(host) {
    this.host = host;
    this.tabs = [];
    this.active = null;
    this.editor = null;
    this.diffEditor = null;
    this.fallback = null;
    this.saveTimers = new Map();
    this.preloaded = new Set();
    this.markers = [];
    this.recentEdits = [];
    this.build();
    on('settings', () => this.applySettings());
    on('markers', (items) => { this.markers = items || []; this.applyMarkers(); });
    api.on('ws:file-changed', (f) => this.onExternalChange([f]));
    api.on('ws:changed', (list) => this.onExternalChange(list));
  }

  build() {
    clear(this.host);
    this.tabsEl = h('div', { class: 'tabs' });
    this.crumbs = h('div', { class: 'crumbs hidden' });
    this.diffBar = h('div', { class: 'diff-bar hidden' });
    this.editorHost = h('div', { class: 'editor-host' });
    this.welcomeHost = h('div', { class: 'welcome-host', style: { position: 'absolute', inset: 0 } });
    this.mainCol = h('div', { class: 'editor-main' }, this.tabsEl, this.crumbs, this.diffBar, this.editorHost, this.welcomeHost);
    this.sideHead = h('div', { class: 'side-head' });
    this.sideHost = h('div', { class: 'side-host' });
    this.sideCol = h('div', { class: 'editor-side hidden' }, this.sideHead, this.sideHost);
    this.host.append(h('div', { class: 'editor-row' }, this.mainCol, this.sideCol));
    this.renderTabs();
  }

  async ensureEditor() {
    if (this.editor || this.fallback) return;
    await monacoReady;
    const s = state.settings.editor || {};
    if (monaco) {
      this.monacoEl = h('div', { style: { position: 'absolute', inset: 0 } });
      this.editorHost.append(this.monacoEl);
      this.editor = monaco.editor.create(this.monacoEl, {
        model: null, theme: this.themeName(), automaticLayout: true,
        fontSize: s.fontSize || 13, fontFamily: s.fontFamily, lineHeight: s.lineHeight || 20, tabSize: s.tabSize || 2,
        minimap: { enabled: !!s.minimap }, wordWrap: s.wordWrap || 'off', renderWhitespace: s.renderWhitespace || 'selection',
        stickyScroll: { enabled: s.stickyScroll !== false }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', cursorBlinking: 'smooth',
        scrollBeyondLastLine: false, padding: { top: 8 }, bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active' },
        inlineSuggest: { enabled: true, mode: 'subwordSmart' }, fixedOverflowWidgets: true, renderLineHighlight: 'all', roundedSelection: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      });
      this.editor.onDidChangeCursorPosition((e) => emit('cursor', { line: e.position.lineNumber, col: e.position.column }));
      this.editor.onDidChangeCursorSelection(() => emit('selection'));
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => this.inlineEdit());
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => emit('add-selection-to-chat'));
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save());
      this.editor.addAction({ id: 'enide.addToChat', label: 'Enide: Add Selection to Chat', contextMenuGroupId: '0_enide', contextMenuOrder: 1, run: () => emit('add-selection-to-chat') });
      this.editor.addAction({ id: 'enide.inlineEdit', label: 'Enide: Edit with AI (⌘K)', contextMenuGroupId: '0_enide', contextMenuOrder: 2, run: () => this.inlineEdit() });
      this.editor.addAction({ id: 'enide.explain', label: 'Enide: Explain Selection', contextMenuGroupId: '0_enide', contextMenuOrder: 3, run: () => emit('explain-selection') });
      this.registerAutocomplete();
      this.setupNextEdit(this.editor);
      try {
        monaco.editor.registerEditorOpener({ openCodeEditor: (_src, resource, sel) => { const line = sel && (sel.startLineNumber || sel.lineNumber); this.openFile(resource.path, { line, preview: true }); return true; } });
      } catch {}
    } else {
      this.fallback = makeFallbackEditor(this.editorHost, () => this.onFallbackChange());
    }
  }

  themeName() {
    const th = state.settings && state.settings.editor && state.settings.editor.theme;
    if (monaco && th && th.data) {
      const key = JSON.stringify(th.data).length + ':' + th.name;
      if (this._themeKey !== key) { try { monaco.editor.defineTheme('enide-custom', th.data); this._themeKey = key; } catch { return document.documentElement.dataset.theme === 'light' ? 'enide-light' : 'enide-dark'; } }
      return 'enide-custom';
    }
    return document.documentElement.dataset.theme === 'light' ? 'enide-light' : 'enide-dark';
  }

  applySettings() {
    const s = (state.settings && state.settings.editor) || {};
    if (monaco) monaco.editor.setTheme(this.themeName());
    if (monaco && this.tsConfigured) monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: !s.semanticDiagnostics, noSyntaxValidation: false });
    if (this.sideEditor) this.sideEditor.updateOptions({ fontSize: s.fontSize, fontFamily: s.fontFamily, lineHeight: s.lineHeight });
    const opts = { fontSize: s.fontSize, fontFamily: s.fontFamily, lineHeight: s.lineHeight, tabSize: s.tabSize, minimap: { enabled: !!s.minimap }, wordWrap: s.wordWrap, renderWhitespace: s.renderWhitespace, stickyScroll: { enabled: s.stickyScroll !== false } };
    if (this.editor) this.editor.updateOptions(opts);
    if (this.diffEditor) this.diffEditor.updateOptions({ fontSize: s.fontSize, fontFamily: s.fontFamily });
    for (const tab of this.tabs) if (tab.model) tab.model.updateOptions({ tabSize: s.tabSize || 2 });
  }

  setWelcome(el) { clear(this.welcomeHost); if (el) this.welcomeHost.append(el); this.updateVisibility(); }

  updateVisibility() {
    const has = !!this.active;
    this.welcomeHost.style.display = has ? 'none' : '';
    this.tabsEl.style.display = this.tabs.length ? '' : 'none';
    this.editorHost.style.display = has ? '' : 'none';
  }

  // ---------- tabs ----------
  renderTabs() {
    clear(this.tabsEl);
    for (const tab of this.tabs) {
      const el = h('div', { class: `tab ${tab === this.active ? 'active' : ''} ${tab.dirty ? 'dirty' : ''} ${tab.preview ? 'preview' : ''}`, title: tab.path || tab.title, draggable: 'true' },
        h('span', { class: 'fi' }, tab.kind === 'diff' ? icon('diff') : fileIcon(tab.title, false)),
        h('span', { class: 'tname' }, tab.title + (tab.kind === 'diff' ? ' ↔' : '')),
        h('span', { class: 'close', onclick: (e) => { e.stopPropagation(); this.close(tab); } }, icon('x')));
      el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); this.close(tab); } });
      el.addEventListener('click', () => this.activate(tab));
      el.addEventListener('dblclick', () => { tab.preview = false; this.renderTabs(); });
      this.tabsEl.append(el);
    }
    this.updateVisibility();
    const dirty = this.tabs.some((x) => x.dirty);
    api.invoke('app:set-dirty', dirty).catch(() => {});
  }

  async openFile(path, opts = {}) {
    let tab = this.tabs.find((x) => x.kind === 'file' && x.path === path);
    if (!tab) {
      if (IMG.test(path) && !/\.svg$/i.test(path)) {
        tab = { id: 'img:' + path, kind: 'image', path, title: basename(path) };
      } else {
        let r;
        try { r = await api.invoke('ws:read', path); } catch (e) { toast(e.message, 'error'); return null; }
        tab = { id: 'file:' + path, kind: 'file', path, title: basename(path), preview: !!opts.preview };
        if (r.binary || r.tooLarge) { tab.kind = 'note'; tab.note = r.binary ? t('binary') : t('tooLarge'); }
        else {
          await this.ensureEditor();
          tab.content = r.content;
          tab.mtime = r.mtime;
          if (monaco) {
            const uri = monaco.Uri.file(path);
            let model = monaco.editor.getModel(uri);
            if (model) model.setValue(r.content); else model = monaco.editor.createModel(r.content, undefined, uri);
            model.updateOptions({ tabSize: (state.settings.editor || {}).tabSize || 2 });
            tab.model = model;
            tab.savedVersion = model.getAlternativeVersionId();
            model.onDidChangeContent(() => this.onModelChange(tab));
          } else {
            tab.saved = r.content;
          }
        }
      }
      const replace = opts.preview && this.tabs.find((x) => x.preview && !x.dirty);
      if (replace) { const i = this.tabs.indexOf(replace); this.disposeTab(replace); this.tabs.splice(i, 1, tab); }
      else {
        const i = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
        this.tabs.splice(i, 0, tab);
      }
    } else if (!opts.preview) tab.preview = false;
    if (opts.activate !== false || !this.active) await this.activate(tab);
    else this.renderTabs();
    if (opts.line && this.editor && tab === this.active) {
      const ln = Math.max(1, opts.line);
      this.editor.revealLineInCenter(ln);
      this.editor.setPosition({ lineNumber: ln, column: opts.col || 1 });
      if (opts.endLine) this.editor.setSelection(new monaco.Selection(ln, 1, opts.endLine, tab.model.getLineMaxColumn(opts.endLine)));
      this.editor.focus();
    }
    return tab;
  }

  async activate(tab) {
    if (this.active && this.active.kind === 'file' && this.editor) this.active.viewState = this.editor.saveViewState();
    this.active = tab;
    state.activeFile = tab && tab.kind === 'file' ? tab.path : null;
    clear(this.diffBar); this.diffBar.classList.add('hidden');
    for (const el of [...this.editorHost.children]) if (el !== this.monacoEl && el !== (this.fallback && this.fallback.el)) el.remove();
    if (this.monacoEl) this.monacoEl.style.display = 'none';
    if (this.fallback) this.fallback.el.style.display = 'none';
    if (this.diffEl) this.diffEl.style.display = 'none';
    if (tab) {
      if (tab.kind === 'file') {
        await this.ensureEditor();
        if (this.editor) {
          this.monacoEl.style.display = '';
          this.editor.setModel(tab.model);
          if (tab.viewState) this.editor.restoreViewState(tab.viewState);
          this.editor.focus();
        } else if (this.fallback) {
          this.fallback.el.style.display = '';
          this.fallback.setValue(tab.dirtyContent != null ? tab.dirtyContent : tab.saved, tab);
        }
        this.renderCrumbs(tab.path);
        emit('cursor', this.editor ? { line: this.editor.getPosition()?.lineNumber || 1, col: this.editor.getPosition()?.column || 1 } : { line: 1, col: 1 });
      } else if (tab.kind === 'diff') {
        this.renderCrumbs(null);
        this.showDiff(tab);
      } else if (tab.kind === 'image') {
        this.renderCrumbs(tab.path);
        const img = h('img', { alt: tab.title });
        api.invoke('app:read-image', tab.path).then((r) => { img.src = `data:${r.mediaType};base64,${r.data}`; }).catch((e) => { img.replaceWith(h('div', { class: 'muted' }, e.message)); });
        this.editorHost.append(h('div', { class: 'image-view' }, img));
      } else if (tab.kind === 'note') {
        this.renderCrumbs(tab.path);
        this.editorHost.append(h('div', { class: 'binary-note' }, icon('file'), h('div', null, tab.note), btn(t('openExternally'), { cls: 'sm', onclick: () => api.invoke('app:open-path', tab.path) })));
      }
    } else this.renderCrumbs(null);
    this.renderTabs();
    emit('active-tab', tab);
  }

  renderCrumbs(path) {
    clear(this.crumbs);
    if (!path) { this.crumbs.classList.add('hidden'); return; }
    this.crumbs.classList.remove('hidden');
    const rel = relPath(state.root, path);
    const parts = rel.split('/');
    parts.forEach((p, i) => {
      if (i) this.crumbs.append(icon('chevron'));
      this.crumbs.append(h('span', { class: i === parts.length - 1 ? 'dim' : '' }, p));
    });
  }

  disposeTab(tab) {
    if (tab.model && this.sideTab === tab) this.closeSide();
    if (tab.model && !this.tabs.some((x) => x !== tab && x.model === tab.model) && !this.preloaded.has(tab.model.uri.toString())) { try { tab.model.dispose(); } catch {} }
    else if (tab.model && this.preloaded.has(tab.model.uri.toString()) && tab.dirty) {
      const m = tab.model;
      api.invoke('ws:read', tab.path).then((r) => { if (r.content != null && !m.isDisposed()) m.setValue(r.content); }).catch(() => {}); // drop unsaved edits
    }
    if (tab.diffModels) { try { tab.diffModels.original.dispose(); tab.diffModels.modified.dispose(); } catch {} }
  }

  async close(tab, force) {
    if (!tab) return;
    if (tab.dirty && !force) {
      const ok = await confirmDialog(t('unsaved'), `${tab.title}: ${t('unsaved').toLowerCase()} — close without saving?`, 'Close', true);
      if (!ok) return;
    }
    if (tab.kind === 'diff' && tab.onReject && !tab.resolved) tab.onReject();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    this.disposeTab(tab);
    if (this.active === tab) await this.activate(this.tabs[i] || this.tabs[i - 1] || null);
    else this.renderTabs();
  }

  closeActive() { if (this.active) this.close(this.active); }
  closeAll() { for (const tab of [...this.tabs]) { this.disposeTab(tab); } this.tabs = []; this.activate(null); }

  onModelChange(tab) {
    const dirty = tab.model.getAlternativeVersionId() !== tab.savedVersion;
    if (dirty && tab.preview) tab.preview = false;
    if (dirty !== tab.dirty) { tab.dirty = dirty; this.renderTabs(); }
    const s = state.settings.editor || {};
    if (dirty && s.autoSave === 'afterDelay') {
      clearTimeout(this.saveTimers.get(tab));
      this.saveTimers.set(tab, setTimeout(() => this.save(tab), 1000));
    }
  }

  onFallbackChange() {
    const tab = this.active;
    if (!tab || tab.kind !== 'file') return;
    tab.dirtyContent = this.fallback.getValue();
    const dirty = tab.dirtyContent !== tab.saved;
    if (dirty !== tab.dirty) { tab.dirty = dirty; this.renderTabs(); }
  }

  contentOf(tab) { return tab.model ? tab.model.getValue() : (tab.dirtyContent != null ? tab.dirtyContent : tab.saved); }

  async save(tab = this.active) {
    if (!tab || tab.kind !== 'file') return;
    try {
      const content = this.contentOf(tab);
      const r = await api.invoke('ws:write', tab.path, content);
      tab.mtime = r.mtime;
      if (tab.model) tab.savedVersion = tab.model.getAlternativeVersionId();
      else { tab.saved = content; tab.dirtyContent = null; }
      tab.ignoreUntil = Date.now() + 800;
      tab.dirty = false;
      tab.preview = false;
      this.renderTabs();
      emit('saved', tab.path);
    } catch (e) { toast(`Save failed: ${e.message}`, 'error'); }
  }

  async saveAll() { for (const tab of this.tabs) if (tab.dirty) await this.save(tab); }

  async onExternalChange(paths) {
    this.refreshPreloaded(paths);
    for (const p of paths || []) {
      const tab = this.tabs.find((x) => x.kind === 'file' && x.path === p);
      if (!tab || tab.dirty || (tab.ignoreUntil && Date.now() < tab.ignoreUntil)) continue;
      let r;
      try { r = await api.invoke('ws:read', p); } catch { continue; }
      if (r.content == null) continue;
      if (tab.model) {
        if (tab.model.getValue() === r.content) continue;
        // keep undo history: replace through an edit operation
        tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: r.content }], () => null);
        tab.savedVersion = tab.model.getAlternativeVersionId();
        tab.dirty = false;
      } else {
        tab.saved = r.content; tab.dirtyContent = null;
        if (tab === this.active && this.fallback) this.fallback.setValue(r.content, tab);
      }
    }
    this.renderTabs();
  }

  // ---------- diff tabs ----------
  // opts: { title, path, original, modified, language, onAccept(modifiedText), onReject, acceptLabel, readOnly }
  async openDiff(opts) {
    await this.ensureEditor();
    const tab = { id: 'diff:' + Math.random().toString(36).slice(2), kind: 'diff', title: opts.title || basename(opts.path || 'diff'), ...opts };
    if (monaco) {
      const lang = opts.language || langOf(opts.path || '');
      tab.diffModels = { original: monaco.editor.createModel(opts.original || '', lang), modified: monaco.editor.createModel(opts.modified || '', lang) };
    }
    const existing = this.tabs.findIndex((x) => x.kind === 'diff' && x.path === opts.path && x.readOnly && opts.readOnly);
    if (existing >= 0) { this.disposeTab(this.tabs[existing]); this.tabs.splice(existing, 1, tab); }
    else this.tabs.push(tab);
    await this.activate(tab);
    return tab;
  }

  showDiff(tab) {
    this.diffBar.classList.remove('hidden');
    clear(this.diffBar);
    this.diffBar.append(icon('diff'), h('span', { class: 'title' }, tab.title), tab.path ? h('span', { class: 'muted mono ellipsis', style: { fontSize: '11.5px' } }, relPath(state.root, tab.path)) : null, h('span', { class: 'grow' }));
    if (tab.onAccept) {
      this.diffBar.append(
        btn(t('rejectKey'), { cls: 'sm', onclick: () => this.resolveDiff(tab, false) }),
        btn(t('acceptKey'), { cls: 'sm primary', icon: 'check', onclick: () => this.resolveDiff(tab, true) }));
    }
    if (monaco) {
      if (!this.diffEl) {
        this.diffEl = h('div', { style: { position: 'absolute', inset: 0 } });
        this.editorHost.append(this.diffEl);
        const s = state.settings.editor || {};
        this.diffEditor = monaco.editor.createDiffEditor(this.diffEl, { automaticLayout: true, theme: this.themeName(), fontSize: s.fontSize || 13, fontFamily: s.fontFamily, renderSideBySide: true, readOnly: false, originalEditable: false, scrollBeyondLastLine: false, minimap: { enabled: false }, renderOverviewRuler: false, ignoreTrimWhitespace: false });
        this.diffEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { if (this.active && this.active.onAccept) this.resolveDiff(this.active, true); });
      } else if (!this.diffEl.isConnected) this.editorHost.append(this.diffEl);
      this.diffEl.style.display = '';
      this.diffEditor.setModel(tab.diffModels);
      this.diffEditor.getModifiedEditor().updateOptions({ readOnly: !!tab.readOnly });
    } else {
      const pre = h('pre', { class: 'code-view', style: { position: 'absolute', inset: '0', margin: 0, borderRadius: 0, border: 'none' } }, tab.modified || '');
      this.editorHost.append(pre);
    }
  }

  async resolveDiff(tab, accept) {
    tab.resolved = true;
    const text = tab.diffModels ? tab.diffModels.modified.getValue() : tab.modified;
    try {
      if (accept && tab.onAccept) await tab.onAccept(text);
      if (!accept && tab.onReject) tab.onReject();
    } catch (e) { toast(e.message, 'error'); }
    await this.close(tab, true);
  }

  // Apply new content to a file through a reviewable diff.
  async proposeFileContent(path, newContent, title) {
    let original = '';
    const openTab = this.tabs.find((x) => x.kind === 'file' && x.path === path);
    if (openTab) original = this.contentOf(openTab);
    else { try { const r = await api.invoke('ws:read', path); original = r.content || ''; } catch {} }
    return this.openDiff({
      title: title || `${basename(path)}`, path, original, modified: newContent, language: langOf(path),
      onAccept: async (text) => {
        const tab = this.tabs.find((x) => x.kind === 'file' && x.path === path);
        if (tab && tab.model) { tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null); await this.save(tab); }
        else { await api.invoke('ws:write', path, text); }
        toast(`${basename(path)} ✓`, 'ok', 2000);
      },
    });
  }

  // ---------- helpers used by chat ----------
  getSelectionInfo() {
    const tab = this.active;
    if (!tab || tab.kind !== 'file') return null;
    if (this.editor) {
      const sel = this.editor.getSelection();
      const text = tab.model.getValueInRange(sel);
      return { path: tab.path, text, startLine: sel.startLineNumber, endLine: sel.endLineNumber, empty: sel.isEmpty(), language: tab.model.getLanguageId() };
    }
    if (this.fallback) {
      const s = this.fallback.getSelection();
      return { path: tab.path, ...s, language: langOf(tab.path) };
    }
    return null;
  }

  insertAtCursor(text) {
    if (this.editor && this.active && this.active.kind === 'file') {
      this.editor.executeEdits('enide', [{ range: this.editor.getSelection(), text, forceMoveMarkers: true }]);
      this.editor.focus();
      return true;
    }
    if (this.fallback && this.active) { this.fallback.insert(text); return true; }
    return false;
  }

  focus() { if (this.editor) this.editor.focus(); }

  async colorize(el, code, language) {
    await monacoReady;
    if (!monaco) return;
    const lang = LANGS[language] || language;
    try {
      const html = await monaco.editor.colorize(code, lang, { tabSize: 2 });
      el.innerHTML = html; // generated by Monaco from escaped text
    } catch {}
  }

  // ---------- ⌘K inline edit ----------
  inlineEdit() {
    if (!this.editor || !this.active || this.active.kind !== 'file') { toast('Open a file to use inline edit (⌘K).'); return; }
    if (this.inlineWidget) { this.inlineWidget.remove(); this.inlineWidget = null; }
    const tab = this.active;
    const model = tab.model;
    const sel = this.editor.getSelection();
    const full = model.getFullModelRange();
    const range = sel.isEmpty() ? sel : new monaco.Range(sel.startLineNumber, 1, sel.endLineNumber, model.getLineMaxColumn(sel.endLineNumber));
    const pos = this.editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: 1 });
    const input = h('textarea', { rows: 1, placeholder: sel.isEmpty() ? t('inlineInsert') : t('inlinePlaceholder') });
    const stream = h('div', { class: 'stream hidden' });
    const status = h('span', { class: 'muted', style: { fontSize: '11.5px' } }, (state.settings && currentModelName()) || '');
    const go = btn(t('generate'), { cls: 'sm primary', icon: 'arrowUp' });
    const widget = h('div', { class: 'inline-edit', style: { top: Math.max(6, (pos ? pos.top : 20) - 64) + 'px' } }, input, stream, h('div', { class: 'row' }, status, h('span', { class: 'grow' }), btn('Esc', { cls: 'sm ghost', onclick: () => cancel() }), go));
    this.editorHost.append(widget);
    this.inlineWidget = widget;
    input.focus();
    const id = 'inl' + Date.now();
    let off = null;
    const cancel = () => { api.invoke('ai:cancel', id).catch(() => {}); if (off) off(); widget.remove(); this.inlineWidget = null; this.editor.focus(); };
    const run = async () => {
      const instruction = input.value.trim();
      if (!instruction) return;
      input.disabled = true; go.disabled = true;
      status.textContent = t('generating');
      stream.classList.remove('hidden');
      let acc = '';
      off = api.on('ai:event', (rid, ev) => { if (rid === id && ev.type === 'text') { acc += ev.text; stream.textContent = acc.slice(-600); } });
      const startOff = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      const endOff = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
      const text = model.getValue();
      try {
        const result = await api.invoke('ai:inline', {
          id, path: relPath(state.root, tab.path), language: model.getLanguageId(),
          prefix: text.slice(Math.max(0, startOff - 8000), startOff), selection: text.slice(startOff, endOff), suffix: text.slice(endOff, endOff + 4000),
          instruction, modelRef: state.settings.inlineEdit && state.settings.inlineEdit.model ? state.settings.inlineEdit.model : state.modelRef,
        });
        if (off) off();
        widget.remove(); this.inlineWidget = null;
        const before = text.slice(0, startOff);
        const after = text.slice(endOff);
        const modified = before + result + after;
        await this.openDiff({
          title: `⌘K · ${tab.title}`, path: tab.path, original: text, modified, language: model.getLanguageId(),
          onAccept: async (finalText) => {
            await this.activate(tab);
            tab.model.pushEditOperations([], [{ range: full.isEmpty ? tab.model.getFullModelRange() : tab.model.getFullModelRange(), text: finalText }], () => null);
          },
        });
      } catch (e) {
        if (off) off();
        status.textContent = e.message;
        input.disabled = false; go.disabled = false;
      }
    };
    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
    });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; });
  }

  // ---------- Tab autocomplete ----------
  registerAutocomplete() {
    let seq = 0;
    const cache = new Map();
    monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model, position, _ctx, token) => {
        const ac = (state.settings && state.settings.autocomplete) || {};
        if (!ac.enabled) return { items: [] };
        const tab = this.tabs.find((x) => x.model === model);
        if (!tab) return { items: [] };
        const off = model.getOffsetAt(position);
        const text = model.getValue();
        const prefix = text.slice(Math.max(0, off - (ac.maxPrefix || 4000)), off);
        const suffix = text.slice(off, off + (ac.maxSuffix || 1500));
        const lineSuffix = model.getLineContent(position.lineNumber).slice(position.column - 1);
        if (/\w/.test(lineSuffix.trim().slice(0, 1))) return { items: [] }; // mid-word: skip
        const key = prefix.slice(-400) + '¦' + suffix.slice(0, 80);
        let completion = cache.get(key);
        if (completion == null) {
          const my = ++seq;
          await new Promise((r) => setTimeout(r, ac.debounceMs || 350));
          if (token.isCancellationRequested || my !== seq) return { items: [] };
          try {
            completion = await api.invoke('ai:complete', { path: relPath(state.root, tab.path), language: model.getLanguageId(), prefix, suffix });
          } catch { return { items: [] }; }
          if (token.isCancellationRequested) return { items: [] };
          cache.set(key, completion);
          if (cache.size > 60) cache.delete(cache.keys().next().value);
        }
        if (!completion || !completion.trim()) return { items: [] };
        return { items: [{ insertText: completion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      },
      freeInlineCompletions() {},
      disposeInlineCompletions() {},
    });
  }

  layout() { if (this.editor) this.editor.layout(); if (this.diffEditor) this.diffEditor.layout(); if (this.sideEditor) this.sideEditor.layout(); }

  // ---------- split editor ----------
  async splitActive() {
    const tab = this.active;
    if (!tab || tab.kind !== 'file') { toast(tr('Open a file to split.', 'Открой файл, чтобы разделить.')); return; }
    this.openSide(tab);
  }

  async openToSide(path) {
    const tab = await this.openFile(path, { activate: false });
    if (tab && tab.kind === 'file') this.openSide(tab);
  }

  openSide(tab) {
    if (!monaco || !tab.model) { toast(tr('Split view needs the Monaco editor.', 'Разделение работает с редактором Monaco.')); return; }
    this.sideCol.classList.remove('hidden');
    if (!this.sideEditor) {
      const s = state.settings.editor || {};
      this.sideEditor = monaco.editor.create(this.sideHost, { model: null, theme: this.themeName(), automaticLayout: true, fontSize: s.fontSize || 13, fontFamily: s.fontFamily, lineHeight: s.lineHeight || 20, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 8 }, stickyScroll: { enabled: true }, fixedOverflowWidgets: true, scrollbar: { verticalScrollbarSize: 10, useShadows: false } });
      this.sideEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.sideTab && this.save(this.sideTab));
      this.sideEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => emit('add-selection-to-chat'));
      this.setupNextEdit(this.sideEditor);
    }
    this.sideTab = tab;
    this.sideEditor.setModel(tab.model);
    clear(this.sideHead);
    this.sideHead.append(h('span', { class: 'fi' }, fileIcon(tab.title, false)), h('span', { class: 'ellipsis grow' }, relPath(state.root, tab.path)),
      iconBtn('file', tr('Open in main editor', 'Открыть в основном редакторе'), () => this.activate(tab), 'sm'),
      iconBtn('x', tr('Close split', 'Закрыть разделение'), () => this.closeSide(), 'sm'));
    setTimeout(() => { this.layout(); this.sideEditor.focus(); }, 0);
  }

  closeSide() {
    this.sideCol.classList.add('hidden');
    if (this.sideEditor) this.sideEditor.setModel(null);
    this.sideTab = null;
    setTimeout(() => this.layout(), 0);
  }

  // ---------- diagnostics from linters / AI review ----------
  applyMarkers() {
    if (!monaco) return;
    const sev = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
    const byFile = new Map();
    for (const it of this.markers) { if (!byFile.has(it.file)) byFile.set(it.file, []); byFile.get(it.file).push(it); }
    for (const model of monaco.editor.getModels()) {
      const items = byFile.get(model.uri.path) || [];
      monaco.editor.setModelMarkers(model, 'enide', items.map((it) => ({
        startLineNumber: it.line, startColumn: it.col || 1, endLineNumber: it.line, endColumn: it.col ? it.col + 1 : model.getLineMaxColumn(Math.min(it.line, model.getLineCount())),
        message: (it.title ? it.title + ' — ' : '') + (it.body || it.message || ''), severity: sev[it.severity] || sev.warning, source: it.source === 'review' ? 'AI review' : it.source, code: it.code || undefined,
      })));
    }
  }

  // ---------- whole-project TypeScript/JavaScript intelligence ----------
  // Loads project sources as Monaco models so go-to-definition, find references,
  // hover types and cross-file completions work like in VS Code.
  async loadProject() {
    await monacoReady;
    if (!monaco || !state.root) return;
    const ts = monaco.languages.typescript;
    const s = state.settings.editor || {};
    ts.typescriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.ReactJSX, allowJs: true, checkJs: false, esModuleInterop: true, allowNonTsExtensions: true, allowSyntheticDefaultImports: true, resolveJsonModule: true, skipLibCheck: true, strict: false });
    ts.javascriptDefaults.setCompilerOptions({ target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs, jsx: ts.JsxEmit.ReactJSX, allowJs: true, allowNonTsExtensions: true, esModuleInterop: true });
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: !s.semanticDiagnostics, noSyntaxValidation: false });
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    ts.typescriptDefaults.setEagerModelSync(true);
    this.tsConfigured = true;
    const root = state.root;
    let files = [];
    try { files = await api.invoke('ws:list-files'); } catch { return; }
    const wanted = files.filter((f) => !f.startsWith('/') && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f) && !/(^|\/)(node_modules|dist|build|out|\.next)\//.test(f) && !/\.min\.js$/.test(f)).slice(0, 1500).map((f) => root + '/' + f);
    if (!wanted.length) return;
    for (let i = 0; i < wanted.length; i += 300) {
      if (state.root !== root) return;
      let contents = {};
      try { contents = await api.invoke('ws:read-many', wanted.slice(i, i + 300)); } catch { continue; }
      for (const [f, text] of Object.entries(contents)) {
        const uri = monaco.Uri.file(f);
        if (monaco.editor.getModel(uri)) continue;
        try { monaco.editor.createModel(text, undefined, uri); this.preloaded.add(uri.toString()); } catch {}
      }
    }
    this.applyMarkers();
  }

  async refreshPreloaded(paths) {
    if (!monaco) return;
    for (const p of paths || []) {
      const uri = monaco.Uri.file(p);
      if (!this.preloaded.has(uri.toString())) continue;
      if (this.tabs.some((t) => t.model && t.model.uri.toString() === uri.toString())) continue;
      const m = monaco.editor.getModel(uri);
      try { const r = await api.invoke('ws:read', p); if (m && r.content != null && m.getValue() !== r.content) m.setValue(r.content); } catch { if (m) { m.dispose(); this.preloaded.delete(uri.toString()); } }
    }
  }

  // ---------- next-edit prediction (Cursor-style Tab) ----------
  setupNextEdit(ed) {
    const ctxKey = ed.createContextKey('enideNextEdit', false);
    let deco = [], zoneId = null, sugg = null, timer = null, seq = 0;
    const clearSugg = () => {
      sugg = null; ctxKey.set(false);
      deco = ed.deltaDecorations(deco, []);
      if (zoneId != null) { ed.changeViewZones((a) => a.removeZone(zoneId)); zoneId = null; }
    };
    const show = (s, model) => {
      clearSugg();
      const max = model.getLineCount();
      if (s.startLine < 1 || s.startLine > max) return;
      s.endLine = Math.min(Math.max(s.endLine, s.startLine), max);
      const current = model.getValueInRange(new monaco.Range(s.startLine, 1, s.endLine, model.getLineMaxColumn(s.endLine)));
      if (current.trim() === s.replacement.trim()) return;
      sugg = { ...s, versionId: model.getAlternativeVersionId() };
      ctxKey.set(true);
      deco = ed.deltaDecorations([], [{ range: new monaco.Range(s.startLine, 1, s.endLine, 1), options: { isWholeLine: true, className: 'next-edit-line', glyphMarginClassName: 'next-edit-glyph', after: { content: '  ⇥ Tab', inlineClassName: 'next-edit-hint' } } }]);
      ed.changeViewZones((a) => {
        const dom = document.createElement('div');
        dom.className = 'next-edit-zone';
        dom.textContent = s.replacement;
        zoneId = a.addZone({ afterLineNumber: s.endLine, heightInLines: Math.min(12, s.replacement.split('\n').length), domNode: dom });
      });
    };
    ed.onDidChangeModelContent((e) => {
      const model = ed.getModel();
      if (!model) return;
      for (const c of e.changes) {
        this.recentEdits.push({ path: model.uri.path, line: c.range.startLineNumber, removed: c.rangeLength, text: c.text.slice(0, 300) });
        if (this.recentEdits.length > 8) this.recentEdits.shift();
      }
      if (sugg && !this._applyingNext) clearSugg();
      const ac = state.settings.autocomplete || {};
      if (!ac.enabled || ac.nextEdit === false || e.isFlush || this._applyingNext) return;
      clearTimeout(timer);
      const my = ++seq;
      timer = setTimeout(async () => {
        const m = ed.getModel(); const pos = ed.getPosition();
        if (!m || !pos || my !== seq) return;
        const from = Math.max(1, pos.lineNumber - 40), to = Math.min(m.getLineCount(), pos.lineNumber + 40);
        const code = [];
        for (let i = from; i <= to; i++) code.push(`${String(i).padStart(4)}| ${m.getLineContent(i)}`);
        const edits = this.recentEdits.filter((x) => x.path === m.uri.path).slice(-5).map((x) => `line ${x.line}: ${x.removed ? `replaced ${x.removed} chars with` : 'inserted'} ${JSON.stringify(x.text)}`).join('\n');
        const r = await api.invoke('ai:next-edit', { path: relPath(state.root, m.uri.path), language: m.getLanguageId(), cursorLine: pos.lineNumber, recentEdits: edits, code: code.join('\n') }).catch(() => null);
        if (!r || my !== seq || ed.getModel() !== m) return;
        if (r.startLine >= pos.lineNumber - 1 && r.startLine <= pos.lineNumber && /\S/.test(m.getLineContent(pos.lineNumber).slice(pos.column - 1))) return;
        show(r, m);
      }, Math.max(600, (state.settings.autocomplete || {}).debounceMs * 2 || 800));
    });
    ed.addCommand(monaco.KeyCode.Tab, () => {
      const m = ed.getModel();
      if (!sugg || !m || m.getAlternativeVersionId() !== sugg.versionId) { clearSugg(); ed.trigger('enide', 'tab', null); return; }
      const pos = ed.getPosition();
      if (pos.lineNumber < sugg.startLine || pos.lineNumber > sugg.endLine) {
        ed.setPosition({ lineNumber: sugg.startLine, column: m.getLineFirstNonWhitespaceColumn(sugg.startLine) || 1 });
        ed.revealLineInCenterIfOutsideViewport(sugg.startLine);
        return;
      }
      const s = sugg;
      this._applyingNext = true;
      ed.executeEdits('enide-next-edit', [{ range: new monaco.Range(s.startLine, 1, s.endLine, m.getLineMaxColumn(s.endLine)), text: s.replacement, forceMoveMarkers: true }]);
      this._applyingNext = false;
      clearSugg();
      ed.setPosition({ lineNumber: s.startLine + s.replacement.split('\n').length - 1, column: 1 + (s.replacement.split('\n').pop() || '').length });
    }, 'enideNextEdit && !inlineSuggestionVisible && !suggestWidgetVisible');
    ed.addCommand(monaco.KeyCode.Escape, () => clearSugg(), 'enideNextEdit && !suggestWidgetVisible');
  }
}

function currentModelName() {
  const ref = state.modelRef || (state.settings && state.settings.defaultModel);
  return ref ? ref.modelId : '';
}

function makeFallbackEditor(host, onChange) {
  const gutter = h('div', { class: 'gutter' });
  const ta = h('textarea', { spellcheck: 'false' });
  const el = h('div', { class: 'fallback-editor' }, gutter, ta);
  host.append(el);
  const renderGutter = () => { const n = ta.value.split('\n').length; gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); };
  ta.addEventListener('input', () => { renderGutter(); onChange(); });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  return {
    el,
    setValue(v) { ta.value = v || ''; renderGutter(); },
    getValue() { return ta.value; },
    getSelection() {
      const s = ta.selectionStart, e = ta.selectionEnd;
      const before = ta.value.slice(0, s);
      const startLine = before.split('\n').length;
      const endLine = ta.value.slice(0, e).split('\n').length;
      return { text: ta.value.slice(s, e), startLine, endLine, empty: s === e };
    },
    insert(text) { ta.focus(); document.execCommand('insertText', false, text); },
  };
}
