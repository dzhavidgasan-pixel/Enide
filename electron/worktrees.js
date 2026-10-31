'use strict';
// Git worktrees for parallel agents: each chat can work in its own checkout on its own
// branch, so several agents can change the same project at once without collisions.
const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const c = execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 256 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error((err || e.message).trim())) : resolve(out)));
    if (input != null) c.stdin.end(input);
  });
}

async function topLevel(root) { return (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }

async function create(root, baseDir, chatId) {
  const top = await topLevel(root);
  const head = (await git(top, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (!head) throw new Error('The repository has no commits yet — make a first commit before using worktrees.');
  const short = String(chatId).slice(-8).replace(/[^a-zA-Z0-9]/g, '');
  const branch = `enide/${short}`;
  const dir = path.join(baseDir, `${path.basename(top)}-${short}`);
  await fsp.mkdir(baseDir, { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  // carry over uncommitted work so the agent starts from what you see
  const patch = await git(top, ['diff', 'HEAD', '--binary']).catch(() => '');
  if (patch.trim()) await git(dir, ['apply', '--whitespace=nowarn'], patch).catch(() => {});
  const untracked = (await git(top, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '')).split('\0').filter(Boolean);
  for (const f of untracked.slice(0, 2000)) {
    try { await fsp.mkdir(path.dirname(path.join(dir, f)), { recursive: true }); await fsp.copyFile(path.join(top, f), path.join(dir, f)); } catch {}
  }
  // Snapshot the starting point so "apply" only carries what the agent changed.
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Enide', '-c', 'user.email=enide@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'enide: worktree baseline']);
  const base = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  // the relative path of root inside the repo (root may be a subfolder)
  const sub = path.relative(top, root);
  return { path: dir, workRoot: sub ? path.join(dir, sub) : dir, branch, base, repo: top, created: Date.now() };
}

async function status(wt) {
  const stat = await git(wt.path, ['status', '--porcelain']).catch(() => '');
  const files = stat.split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim(), rel: l.slice(3) }));
  const diff = await git(wt.path, ['diff', wt.base, '--shortstat']).catch(() => '');
  return { files, shortstat: diff.trim() };
}

// Bring the worktree's changes (relative to where it started) into the main checkout.
async function apply(wt) {
  await git(wt.path, ['add', '-A']);
  const patch = await git(wt.path, ['diff', '--cached', '--binary', wt.base]);
  await git(wt.path, ['reset', '-q']).catch(() => {});
  if (!patch.trim()) return { applied: 0 };
  // the main checkout's working tree matches the baseline, so a plain apply fits;
  // if you changed the same lines meanwhile, fall back to a 3-way merge
  try {
    await git(wt.repo, ['apply', '--whitespace=nowarn'], patch);
  } catch (e) {
    try { await git(wt.repo, ['apply', '--3way', '--whitespace=nowarn'], patch); }
    catch (e2) { throw new Error(`Could not apply the worktree changes cleanly — your copy changed in the same places. Resolve by hand from branch ${wt.branch}.\n${e2.message}`); }
  }
  // move the baseline forward so a second "apply" only brings newer changes
  await git(wt.path, ['add', '-A']);
  await git(wt.path, ['-c', 'user.name=Enide', '-c', 'user.email=enide@localhost', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'enide: applied to project']);
  const base = (await git(wt.path, ['rev-parse', 'HEAD'])).trim();
  return { applied: (patch.match(/^diff --git/gm) || []).length, base };
}

async function remove(wt) {
  await git(wt.repo, ['worktree', 'remove', '--force', wt.path]).catch(async () => { await fsp.rm(wt.path, { recursive: true, force: true }); await git(wt.repo, ['worktree', 'prune']).catch(() => {}); });
  await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => {});
}

module.exports = { create, status, apply, remove };
