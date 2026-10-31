'use strict';
// Import color themes and keybindings from VS Code, Cursor and Windsurf installs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { stripJsonc } = require('./agent/hooks');

const HOME = os.homedir();
const EXT_DIRS = [
  ['VS Code', path.join(HOME, '.vscode', 'extensions')],
  ['Cursor', path.join(HOME, '.cursor', 'extensions')],
  ['Windsurf', path.join(HOME, '.windsurf', 'extensions')],
  ['VS Code (built-in)', '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions'],
  ['Cursor (built-in)', '/Applications/Cursor.app/Contents/Resources/app/extensions'],
];

async function listThemes() {
  const out = [];
  const seen = new Set();
  for (const [from, dir] of EXT_DIRS) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      let pkg;
      try { pkg = JSON.parse(await fsp.readFile(path.join(dir, n, 'package.json'), 'utf8')); } catch { continue; }
      for (const t of (pkg.contributes && pkg.contributes.themes) || []) {
        const label = typeof t.label === 'string' && !t.label.startsWith('%') ? t.label : (t.id || path.basename(t.path, '.json'));
        const key = `${label}|${from.replace(/ \(built-in\)/, '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label, from, uiTheme: t.uiTheme, path: path.join(dir, n, t.path) });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

async function readThemeFile(file, depth = 0) {
  const j = JSON.parse(stripJsonc(await fsp.readFile(file, 'utf8')));
  let colors = {}, tokenColors = [];
  if (j.include && depth < 5) {
    const inc = await readThemeFile(path.resolve(path.dirname(file), j.include), depth + 1).catch(() => null);
    if (inc) { colors = { ...inc.colors }; tokenColors = [...inc.tokenColors]; }
  }
  Object.assign(colors, j.colors || {});
  if (Array.isArray(j.tokenColors)) tokenColors.push(...j.tokenColors);
  return { name: j.name, type: j.type, colors, tokenColors };
}

// TextMate scope → Monaco (monarch) token. Monaco matches rules by prefix.
const SCOPE_MAP = [
  [/^comment/, 'comment'], [/^string\.regexp/, 'regexp'], [/^constant\.character\.escape/, 'string.escape'], [/^string/, 'string'],
  [/^constant\.numeric/, 'number'], [/^constant\.language/, 'keyword'], [/^constant/, 'constant'],
  [/^keyword\.operator/, 'operator'], [/^keyword/, 'keyword'], [/^storage/, 'keyword'],
  [/^entity\.name\.type|^support\.type|^support\.class|^entity\.name\.class|^entity\.other\.inherited-class/, 'type'],
  [/^entity\.name\.tag/, 'tag'], [/^entity\.other\.attribute-name/, 'attribute.name'],
  [/^entity\.name\.function|^support\.function|^meta\.function-call/, 'function'],
  [/^variable\.language|^variable\.parameter/, 'variable.predefined'], [/^variable/, 'variable'],
  [/^punctuation\.definition\.tag/, 'delimiter.html'], [/^punctuation/, 'delimiter'], [/^meta\.annotation|^storage\.type\.annotation/, 'annotation'],
  [/^markup\.heading/, 'keyword.md'], [/^markup\.bold/, 'strong'], [/^markup\.italic/, 'emphasis'], [/^invalid/, 'invalid'],
];

const hex = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);
const strip = (c) => { const h = hex(c); if (!h) return null; let x = h.slice(1); if (x.length === 3 || x.length === 4) x = x.split('').map((ch) => ch + ch).join(''); return x.slice(0, 6); };

async function convertTheme(file, uiTheme) {
  const t = await readThemeFile(file);
  const isLight = uiTheme === 'vs' || t.type === 'light';
  const base = uiTheme === 'hc-black' ? 'hc-black' : isLight ? 'vs' : 'vs-dark';
  const rules = [];
  const taken = new Set();
  for (const tc of t.tokenColors) {
    const set = tc.settings || {};
    const fg = strip(set.foreground);
    if (!fg && !set.fontStyle) continue;
    const scopes = Array.isArray(tc.scope) ? tc.scope : String(tc.scope || '').split(',');
    for (const raw of scopes) {
      const sc = raw.trim().split(/\s+/).pop();
      if (!sc) continue;
      const m = SCOPE_MAP.find(([re]) => re.test(sc));
      if (!m || taken.has(m[1])) continue;
      taken.add(m[1]);
      rules.push({ token: m[1], ...(fg ? { foreground: fg } : {}), ...(set.fontStyle ? { fontStyle: set.fontStyle } : {}) });
    }
  }
  const defaultFg = t.colors['editor.foreground'];
  if (hex(defaultFg)) rules.unshift({ token: '', foreground: strip(defaultFg) });
  const colors = {};
  for (const [k, v] of Object.entries(t.colors)) if (hex(v)) colors[k] = v;
  const terminal = {};
  for (const n of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    const a = colors[`terminal.ansi${n[0].toUpperCase() + n.slice(1)}`];
    const b = colors[`terminal.ansiBright${n[0].toUpperCase() + n.slice(1)}`];
    if (a) terminal[n] = a;
    if (b) terminal['bright' + n[0].toUpperCase() + n.slice(1)] = b;
  }
  if (colors['terminal.foreground']) terminal.foreground = colors['terminal.foreground'];
  return { name: t.name || path.basename(file, '.json'), base, light: isLight, data: { base, inherit: true, rules, colors }, terminal };
}

// VS Code / Cursor command ids → Enide command ids.
const COMMAND_MAP = {
  'workbench.action.quickOpen': 'quick-open', 'workbench.action.showCommands': 'palette', 'workbench.action.toggleSidebarVisibility': 'toggle-sidebar',
  'workbench.action.togglePanel': 'toggle-panel', 'workbench.action.terminal.toggleTerminal': 'toggle-panel', 'workbench.action.terminal.new': 'new-terminal',
  'workbench.action.files.save': 'save', 'workbench.action.files.saveAll': 'save-all', 'workbench.action.findInFiles': 'search', 'workbench.view.search': 'search',
  'workbench.view.explorer': 'explorer', 'workbench.view.scm': 'git', 'workbench.view.extensions': 'plugins', 'workbench.action.splitEditor': 'split-editor',
  'workbench.action.closeActiveEditor': 'close-tab', 'workbench.action.files.newUntitledFile': 'new-file', 'workbench.action.files.openFolder': 'open-folder',
  'workbench.action.openSettings': 'settings', 'workbench.action.toggleAuxiliaryBar': 'toggle-agent', 'aichat.newchataction': 'new-chat',
  'composer.newAgentChat': 'new-chat', 'aipopup.action.modal.generate': 'inline-edit', 'composer.startComposerPrompt': 'focus-chat', 'aichat.insertselectionintochat': 'focus-chat',
  'workbench.action.problems.focus': 'problems', 'workbench.actions.view.problems': 'problems',
};

function toAccelerator(key) {
  if (!key || /\s/.test(key.trim())) return null; // chords are not supported
  const map = { cmd: 'Cmd', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Cmd', win: 'Super', enter: 'Enter', escape: 'Esc', backspace: 'Backspace', delete: 'Delete', tab: 'Tab', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', '`': '`', ',': ',', '.': '.', '/': '/', '\\': '\\', '[': '[', ']': ']', ';': ';', "'": "'", '=': '=', '-': '-' };
  return key.split('+').map((p) => { const x = p.trim().toLowerCase(); return map[x] || (x.length === 1 ? x.toUpperCase() : x.replace(/^f(\d+)$/, 'F$1')); }).join('+');
}

async function importKeybindings() {
  const files = [
    ['Cursor', path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'keybindings.json')],
    ['VS Code', path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json')],
  ];
  const out = {};
  const found = [];
  for (const [from, f] of files) {
    let arr;
    try { arr = JSON.parse(stripJsonc(await fsp.readFile(f, 'utf8'))); } catch { continue; }
    found.push(from);
    for (const kb of Array.isArray(arr) ? arr : []) {
      if (!kb || kb.command == null || String(kb.command).startsWith('-')) continue;
      const id = COMMAND_MAP[kb.command];
      const acc = toAccelerator(kb.key);
      if (id && acc && !out[id]) out[id] = acc;
    }
  }
  return { keybindings: out, from: found };
}

module.exports = { listThemes, convertTheme, importKeybindings, toAccelerator };
