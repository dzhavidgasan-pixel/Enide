// Line icons (24px grid, 1.6 stroke).
const P = {
  files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6"/><path d="M18 10.2c0 4-6 3-11 6"/>',
  puzzle: '<path d="M10 4a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1h4z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 18h7"/>',
  sparkle: '<path d="M12 3c.5 4.2 2.6 8.3 9 9-6.4.7-8.5 4.8-9 9-.5-4.2-2.6-8.3-9-9 6.4-.7 8.5-4.8 9-9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 18 5.6 11a2 2 0 0 1 1.9-1.3H21l-2.7 7.3a2 2 0 0 1-1.9 1.3H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  undo: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  panelBottom: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 15h18"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
  upload: '<path d="M12 20V8M6 14l6-6 6 6M4 4h16"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M2 12h6.5M15.5 12H22"/>',
  arrowDown: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  wand: '<path d="m15 4 1.5 1.5M19 8l1.5 1.5M18 3v3M21 6h-3M4 20 15.5 8.5l-2-2L2 18z"/>',
  feather: '<path d="M20 4c-6 0-12 4-14 12l-2 4"/><path d="M8 14h7M16 8c-1 6-6 10-10 10"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  bars: '<path d="M4 7h16M4 12h10M4 17h6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  newChat: '<path d="M12 20H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v5"/><path d="M18 15v6M15 18h6"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  diff: '<path d="M12 4v8M8 8h8M8 18h8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  infinity: '<path d="M12 12c-2-2.7-3.6-4-5.2-4a4 4 0 0 0 0 8c1.6 0 3.2-1.3 5.2-4Zm0 0c2 2.7 3.6 4 5.2 4a4 4 0 0 0 0-8c-1.6 0-3.2 1.3-5.2 4Z"/>',
  message: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/>',
  bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8v12M9 8a3 3 0 0 1 6 0M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/>',
  gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.4"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  textCursor: '<path d="M9 4h6M9 20h6M12 4v16M8 12h8"/>',
  hook: '<path d="M7 4v6a5 5 0 0 0 10 0V8"/><path d="m14 11 3-3 3 3"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  collapseWin: '<path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};

export function svg(name, cls) {
  const inner = P[name] || P.file;
  const s = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${inner}</svg>`;
  const t = document.createElement('template');
  t.innerHTML = s;
  return t.content.firstChild;
}

// File-type badges (Seti/JetBrains-style): a tinted tile with a short glyph per language.
const BADGES = {
  ts: ['TS', '#3b82f6'], mts: ['TS', '#3b82f6'], cts: ['TS', '#3b82f6'], tsx: ['TSX', '#38bdf8'], js: ['JS', '#eab308'], mjs: ['JS', '#eab308'], cjs: ['JS', '#eab308'], jsx: ['JSX', '#38bdf8'],
  json: ['{ }', '#f59e0b'], jsonc: ['{ }', '#f59e0b'], md: ['M↓', '#94a3b8'], mdx: ['MDX', '#94a3b8'], css: ['#', '#a78bfa'], scss: ['S', '#ec4899'], sass: ['S', '#ec4899'], less: ['L', '#6366f1'],
  html: ['<>', '#f97316'], htm: ['<>', '#f97316'], vue: ['V', '#22c55e'], svelte: ['S', '#f97316'], astro: ['A', '#f97316'], py: ['PY', '#3b82f6'], ipynb: ['NB', '#f97316'], rb: ['RB', '#ef4444'], go: ['GO', '#06b6d4'],
  rs: ['RS', '#f97316'], swift: ['SW', '#f97316'], kt: ['KT', '#a855f7'], kts: ['KT', '#a855f7'], java: ['J', '#ef4444'], c: ['C', '#60a5fa'], h: ['H', '#a78bfa'], cpp: ['C++', '#60a5fa'], cc: ['C++', '#60a5fa'], hpp: ['H++', '#a78bfa'],
  cs: ['C#', '#a855f7'], php: ['PHP', '#818cf8'], sh: ['>_', '#22c55e'], zsh: ['>_', '#22c55e'], bash: ['>_', '#22c55e'], fish: ['>_', '#22c55e'], ps1: ['PS', '#3b82f6'],
  yml: ['YML', '#ef4444'], yaml: ['YML', '#ef4444'], toml: ['TML', '#a3a3a3'], ini: ['INI', '#a3a3a3'], xml: ['XML', '#f97316'], sql: ['SQL', '#eab308'], graphql: ['GQL', '#ec4899'], gql: ['GQL', '#ec4899'], prisma: ['PR', '#14b8a6'],
  lua: ['LUA', '#3b82f6'], dart: ['DT', '#06b6d4'], r: ['R', '#3b82f6'], scala: ['SC', '#ef4444'], ex: ['EX', '#a855f7'], exs: ['EX', '#a855f7'], erl: ['ER', '#ef4444'], hs: ['HS', '#a855f7'], zig: ['ZIG', '#f59e0b'], nim: ['NIM', '#eab308'],
  txt: ['TXT', '#8b8b94'], log: ['LOG', '#8b8b94'], csv: ['CSV', '#22c55e'], tsv: ['TSV', '#22c55e'], pdf: ['PDF', '#ef4444'], zip: ['ZIP', '#a3a3a3'], gz: ['GZ', '#a3a3a3'], tar: ['TAR', '#a3a3a3'], rar: ['RAR', '#a3a3a3'], '7z': ['7Z', '#a3a3a3'],
  png: ['IMG', '#c084fc'], jpg: ['IMG', '#c084fc'], jpeg: ['IMG', '#c084fc'], gif: ['GIF', '#c084fc'], webp: ['IMG', '#c084fc'], ico: ['ICO', '#c084fc'], svg: ['SVG', '#f59e0b'], mp4: ['MP4', '#f43f5e'], mov: ['MOV', '#f43f5e'], mp3: ['MP3', '#f43f5e'], wav: ['WAV', '#f43f5e'],
  lock: ['LCK', '#71717a'], env: ['ENV', '#eab308'], wasm: ['WA', '#6366f1'], dockerfile: ['DKR', '#3b82f6'], makefile: ['MK', '#f97316'], gradle: ['GR', '#22c55e'], plist: ['PL', '#a3a3a3'], xcconfig: ['XC', '#3b82f6'], pbxproj: ['XC', '#3b82f6'],
};
const NAMES = {
  'package.json': ['npm', '#ef4444'], 'package-lock.json': ['npm', '#71717a'], 'pnpm-lock.yaml': ['pn', '#f59e0b'], 'yarn.lock': ['yrn', '#38bdf8'], 'bun.lockb': ['bun', '#a3a3ab'],
  'tsconfig.json': ['TS', '#3b82f6'], 'dockerfile': ['DKR', '#3b82f6'], 'docker-compose.yml': ['DKR', '#3b82f6'], 'makefile': ['MK', '#f97316'], 'cargo.toml': ['RS', '#f97316'], 'go.mod': ['GO', '#06b6d4'],
  '.gitignore': ['GIT', '#f97316'], '.gitattributes': ['GIT', '#f97316'], '.env': ['ENV', '#eab308'], '.env.local': ['ENV', '#eab308'], 'license': ['LIC', '#eab308'], 'readme.md': ['i', '#38bdf8'],
  'agents.md': ['AI', '#a3a3ab'], 'claude.md': ['AI', '#a3a3ab'], '.cursorrules': ['AI', '#a3a3ab'], 'vite.config.ts': ['V', '#a855f7'], 'vite.config.js': ['V', '#a855f7'], 'next.config.js': ['N', '#a3a3ab'], 'next.config.mjs': ['N', '#a3a3ab'],
  '.prettierrc': ['P', '#ec4899'], '.eslintrc.json': ['ES', '#6366f1'], 'eslint.config.js': ['ES', '#6366f1'], 'requirements.txt': ['PY', '#3b82f6'], 'pyproject.toml': ['PY', '#3b82f6'], 'gemfile': ['RB', '#ef4444'], 'podfile': ['POD', '#ef4444'], 'package.swift': ['SW', '#f97316'],
};
const FOLDER_COLORS = { src: '#60a5fa', app: '#60a5fa', lib: '#a78bfa', components: '#38bdf8', test: '#22c55e', tests: '#22c55e', __tests__: '#22c55e', spec: '#22c55e', docs: '#94a3b8', public: '#f59e0b', assets: '#c084fc', images: '#c084fc', scripts: '#22c55e', config: '#a3a3a3', '.github': '#a3a3a3', '.git': '#f97316', node_modules: '#71717a', dist: '#71717a', build: '#71717a', electron: '#38bdf8', renderer: '#f472b6', api: '#14b8a6', server: '#14b8a6', styles: '#a78bfa', pages: '#f97316', hooks: '#38bdf8', utils: '#a3a3a3', types: '#3b82f6', '.vscode': '#3b82f6', '.cursor': '#a3a3ab', '.enide': '#a3a3ab' };

export function fileIcon(name, isDir, open) {
  const n = String(name || '').split('/').pop().toLowerCase();
  if (isDir) {
    const el = svg(open ? 'folderOpen' : 'folder');
    const c = FOLDER_COLORS[n];
    el.style.color = c || 'var(--fg-3)';
    if (c) el.style.fill = c + '22';
    return el;
  }
  const b = NAMES[n] || (n.startsWith('.env') ? BADGES.env : null) || (n.endsWith('.d.ts') ? ['DTS', '#3b82f6'] : null) || BADGES[n.split('.').pop()] || (n === 'dockerfile' ? BADGES.dockerfile : null);
  if (!b) {
    const el = svg('file');
    el.style.color = 'var(--fg-3)';
    return el;
  }
  const [label, color] = b;
  const fs = label.length >= 3 ? 5.6 : label.length === 2 ? 7 : 9;
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.5" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.55" stroke-width="1"/><text x="8" y="8.4" text-anchor="middle" dominant-baseline="middle" font-family="SF Mono, Menlo, ui-monospace, monospace" font-size="${fs}" font-weight="700" fill="${color}" letter-spacing="-0.2">${label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text></svg>`;
  return t.content.firstChild;
}
