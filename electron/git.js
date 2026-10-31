'use strict';
// Source control via the git CLI.
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

function git(root, args, { input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const c = execFile('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }, maxBuffer }, (err, stdout, stderr) => {
      if (err) { const e = new Error((stderr || err.message).trim()); e.code = err.code; e.stdout = stdout; return reject(e); }
      resolve(stdout);
    });
    if (input != null) { c.stdin.end(input); }
  });
}

async function isRepo(root) {
  try { return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

async function status(root) {
  if (!root || !(await isRepo(root))) return { repo: false };
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const out = await git(root, ['status', '--porcelain=v1', '-b', '-z', '-uall']);
  const parts = out.split('\0');
  let branch = '', ahead = 0, behind = 0, upstream = '';
  const staged = [], unstaged = [], conflicts = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(p);
      if (m) { branch = m[1]; upstream = m[2] || ''; ahead = +(m[3] || 0); behind = +(m[4] || 0); }
      continue;
    }
    const x = p[0], y = p[1];
    const file = p.slice(3);
    let orig = null;
    if (x === 'R' || x === 'C') { orig = parts[++i]; }
    const abs = path.join(top, file);
    const entry = { path: abs, rel: file, orig, x, y };
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { conflicts.push({ ...entry, code: 'U' }); continue; }
    if (x !== ' ' && x !== '?') staged.push({ ...entry, code: x });
    if (y !== ' ') unstaged.push({ ...entry, code: y === '?' ? 'U?' : y });
  }
  return { repo: true, top, branch, upstream, ahead, behind, staged, unstaged, conflicts };
}

async function showFile(root, ref, rel) {
  try { return await git(root, ['show', `${ref}:${rel}`]); } catch { return ''; }
}

// Contents for a side-by-side diff of one file.
async function diffContents(root, abs, staged) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const rel = path.relative(top, abs).split(path.sep).join('/');
  if (staged) return { original: await showFile(top, 'HEAD', rel), modified: await showFile(top, '', rel) };
  let original = await showFile(top, '', rel);
  if (!original) original = await showFile(top, 'HEAD', rel);
  let modified = '';
  try { modified = await fsp.readFile(abs, 'utf8'); } catch {}
  return { original, modified };
}

const stage = (root, files) => git(root, ['add', '--', ...files]);
async function unstage(root, files) {
  try { await git(root, ['restore', '--staged', '--', ...files]); }
  catch { await git(root, ['reset', '-q', 'HEAD', '--', ...files]); }
}
async function discard(root, files, trash) {
  const st = await status(root);
  const untracked = new Set(st.unstaged.filter((e) => e.code === 'U?').map((e) => e.path));
  const tracked = files.filter((f) => !untracked.has(f));
  for (const f of files.filter((f) => untracked.has(f))) await trash(f);
  if (tracked.length) await git(root, ['checkout', '--', ...tracked]);
}
const commit = (root, message, { all, amend } = {}) => git(root, ['commit', ...(all ? ['-a'] : []), ...(amend ? ['--amend'] : []), '-F', '-'], { input: message });
async function branches(root) {
  const out = await git(root, ['branch', '-a', '--format=%(refname:short)%09%(HEAD)%09%(committerdate:relative)']);
  return out.split('\n').filter(Boolean).map((l) => { const [name, head, when] = l.split('\t'); return { name, current: head === '*', when }; });
}
const checkout = (root, name, create) => git(root, create ? ['checkout', '-b', name] : ['checkout', name]);
const push = async (root) => { try { return await git(root, ['push']); } catch (e) { if (/no upstream/i.test(e.message)) { const b = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); return git(root, ['push', '-u', 'origin', b]); } throw e; } };
const pull = (root) => git(root, ['pull', '--ff-only']);
const fetchAll = (root) => git(root, ['fetch', '--all', '--prune']);
const init = (root) => git(root, ['init']);
async function log(root, n = 50) {
  const out = await git(root, ['log', `-n${n}`, '--pretty=format:%h%x09%an%x09%ar%x09%s']);
  return out.split('\n').filter(Boolean).map((l) => { const [hash, author, when, subject] = l.split('\t'); return { hash, author, when, subject }; });
}
async function stagedDiff(root, max = 60000) {
  let d = await git(root, ['diff', '--cached', '--stat', '--patch', '--no-color']);
  if (!d.trim()) d = await git(root, ['diff', '--stat', '--patch', '--no-color']);
  return d.length > max ? d.slice(0, max) + '\n… (diff truncated)' : d;
}

module.exports = { git, isRepo, status, diffContents, stage, unstage, discard, commit, branches, checkout, push, pull, fetchAll, init, log, stagedDiff };
