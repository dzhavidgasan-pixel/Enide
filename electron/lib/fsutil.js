'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  'target', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', 'DerivedData',
  'Pods', '.parcel-cache', 'coverage', '.DS_Store', 'release',
]);

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolvePath(root, p) {
  const e = expandHome(String(p || '.'));
  return path.resolve(root || os.homedir(), e);
}

function isInside(root, abs) {
  if (!root) return false;
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(p) { return p.split(path.sep).join('/'); }

function globToRegExp(glob) {
  let g = String(glob).trim();
  if (!g.includes('/')) g = '**/' + g;
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') { re += '(?:'; inBrace++; i++; continue; }
    if (c === '}' && inBrace) { re += ')'; inBrace--; i++; continue; }
    if (c === ',' && inBrace) { re += '|'; i++; continue; }
    if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > i) { re += g.slice(i, end + 1); i = end + 1; continue; }
    }
    re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}

async function* walkFiles(root, opts = {}) {
  const { maxFiles = 50000, signal, includeIgnored = false, ignore = IGNORE_DIRS } = opts;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    if (signal && signal.aborted) return;
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeIgnored && ignore.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (e.name === '.DS_Store') continue;
        yield full;
        if (++count >= maxFiles) return;
      }
    }
  }
}

async function isBinaryFile(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, 8000, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return true; } finally { if (fh) await fh.close().catch(() => {}); }
}

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

module.exports = { IGNORE_DIRS, expandHome, resolvePath, isInside, toPosix, globToRegExp, walkFiles, isBinaryFile, IMAGE_EXT };
