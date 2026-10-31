'use strict';
// File-system operations for the explorer, editor, quick open and search panel.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { IGNORE_DIRS, walkFiles, isBinaryFile, toPosix, globToRegExp } = require('./lib/fsutil');

const MAX_EDITOR_FILE = 15 * 1024 * 1024;

async function readDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '.DS_Store') continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory(); } catch {} }
    out.push({ name: e.name, path: path.join(dir, e.name), dir: isDir, ignored: isDir && IGNORE_DIRS.has(e.name) });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

async function readFile(file) {
  const st = await fsp.stat(file);
  if (st.size > MAX_EDITOR_FILE) return { tooLarge: true, size: st.size };
  if (await isBinaryFile(file)) return { binary: true, size: st.size };
  const content = await fsp.readFile(file, 'utf8');
  return { content, mtime: st.mtimeMs, size: st.size };
}

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  const st = await fsp.stat(file);
  return { mtime: st.mtimeMs };
}

async function createFile(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const fh = await fsp.open(file, 'wx');
  await fh.close();
  return file;
}

async function createDir(dir) { await fsp.mkdir(dir, { recursive: true }); return dir; }

async function rename(from, to) {
  if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists`);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return to;
}

async function listFiles(root, limit = 30000) {
  const out = [];
  for await (const f of walkFiles(root, { maxFiles: limit })) out.push(toPosix(path.relative(root, f)));
  return out;
}

function rgAvailable() {
  return new Promise((res) => {
    const c = spawn('rg', ['--version']);
    c.on('error', () => res(false));
    c.on('close', (code) => res(code === 0));
  });
}

// Search: returns [{ file, rel, matches: [{ line, col, text, length }] }]
async function search(root, { query, regex, caseSensitive, wholeWord, include, exclude, maxResults = 5000 }) {
  if (!query) return { results: [], total: 0 };
  let pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) pattern = `\\b${pattern}\\b`;
  let re;
  try { re = new RegExp(pattern, caseSensitive ? 'g' : 'gi'); } catch (e) { throw new Error('Invalid regular expression: ' + e.message); }
  const inc = include ? include.split(',').map((s) => s.trim()).filter(Boolean).map(globToRegExp) : null;
  const exc = exclude ? exclude.split(',').map((s) => s.trim()).filter(Boolean).map(globToRegExp) : null;
  const byFile = new Map();
  let total = 0;
  const add = (abs, line, text) => {
    const rel = toPosix(path.relative(root, abs));
    if (inc && !inc.some((r) => r.test(rel))) return;
    if (exc && exc.some((r) => r.test(rel))) return;
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 50) {
      if (!byFile.has(abs)) byFile.set(abs, { file: abs, rel, matches: [] });
      byFile.get(abs).matches.push({ line, col: m.index + 1, length: m[0].length || 1, text: text.length > 400 ? text.slice(Math.max(0, m.index - 100), m.index + 300) : text, offset: text.length > 400 ? Math.max(0, m.index - 100) : 0 });
      total++;
      if (!m[0].length) re.lastIndex++;
    }
  };

  if (await rgAvailable()) {
    await new Promise((resolve, reject) => {
      const args = ['--json', '--max-columns', '1000'];
      if (!caseSensitive) args.push('-i');
      if (!regex) args.push('-F');
      if (wholeWord) args.push('-w');
      args.push('-e', query, root);
      const c = spawn('rg', args);
      let buf = '';
      c.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try {
            const j = JSON.parse(line);
            if (j.type === 'match') add(j.data.path.text, j.data.line_number, (j.data.lines.text || '').replace(/\n$/, ''));
          } catch {}
          if (total >= maxResults) { c.kill(); break; }
        }
      });
      c.on('error', reject);
      c.on('close', () => resolve());
    });
  } else {
    for await (const f of walkFiles(root)) {
      if (total >= maxResults) break;
      let st; try { st = await fsp.stat(f); } catch { continue; }
      if (st.size > 2_000_000 || await isBinaryFile(f)) continue;
      const rel = toPosix(path.relative(root, f));
      if (inc && !inc.some((r) => r.test(rel))) continue;
      if (exc && exc.some((r) => r.test(rel))) continue;
      const text = await fsp.readFile(f, 'utf8').catch(() => '');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && total < maxResults; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) add(f, i + 1, lines[i]);
      }
    }
  }
  return { results: [...byFile.values()].sort((a, b) => a.rel.localeCompare(b.rel)), total, capped: total >= maxResults };
}

async function replaceInFiles(root, opts, replacement, files) {
  let pattern = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
  const re = new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
  let count = 0;
  for (const f of files) {
    const text = await fsp.readFile(f, 'utf8');
    let n = 0;
    const next = text.replace(re, (...m) => { n++; return opts.regex ? m[0].replace(new RegExp(pattern, opts.caseSensitive ? '' : 'i'), replacement) : replacement; });
    if (n) { await fsp.writeFile(f, next, 'utf8'); count += n; }
  }
  return count;
}

// Recursive watcher (native on macOS). Emits debounced batches of changed paths.
class Watcher {
  constructor(onBatch) { this.onBatch = onBatch; this.w = null; this.pending = new Set(); this.timer = null; }
  watch(root) {
    this.close();
    if (!root) return;
    try {
      this.w = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const rel = String(file);
        if (/(^|\/)(\.git|node_modules)(\/|$)/.test(rel) && !/\.git\/(HEAD|index)$/.test(rel)) return;
        this.pending.add(path.join(root, rel));
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { const list = [...this.pending]; this.pending.clear(); this.onBatch(list); }, 150);
      });
      this.w.on('error', () => {});
    } catch { this.w = null; }
  }
  close() { if (this.w) { try { this.w.close(); } catch {} this.w = null; } }
}

module.exports = { readDir, readFile, writeFile, createFile, createDir, rename, listFiles, search, replaceInFiles, Watcher };
