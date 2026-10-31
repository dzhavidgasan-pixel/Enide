'use strict';
// Slash commands are plain prompt templates. Typing "/name args" in chat inserts the
// template with $ARGUMENTS replaced — what you see in your message is what is sent.
const fsp = require('fs').promises;
const path = require('path');

const BUILTIN = [
  { name: 'init', description: 'Create or update AGENTS.md for this project', prompt: 'Explore this repository and create (or update) AGENTS.md at the workspace root with: a short project overview, how to install, build, run and test, code style and conventions, and the most important directories. Keep it concise and accurate. $ARGUMENTS' },
  { name: 'review', description: 'Review uncommitted changes', prompt: 'Review the current uncommitted changes (run git status and git diff). List bugs, risky changes and missing tests ordered by severity, citing path:line. Do not modify files. $ARGUMENTS' },
  { name: 'test', description: 'Run tests and fix failures', prompt: 'Find how this project runs its tests, run them, and fix any failures you caused or that are clearly bugs. Report what you changed. $ARGUMENTS' },
  { name: 'fix', description: 'Fix a bug or error', prompt: 'Find the root cause of this problem and fix it, then verify the fix: $ARGUMENTS' },
  { name: 'explain', description: 'Explain code or a concept', prompt: 'Explain clearly, with references to the code (path:line): $ARGUMENTS' },
  { name: 'commit', description: 'Commit current changes with a good message', prompt: 'Look at git status and git diff, then stage the relevant changes and create a git commit with a clear message. Do not push. $ARGUMENTS' },
  { name: 'plan', description: 'Plan before coding', prompt: 'Before writing any code, investigate the codebase and write a step-by-step plan for: $ARGUMENTS\nWait for my confirmation before making changes.' },
];

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

async function readDir(dir, source) {
  const out = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const n of names.sort()) {
    if (!n.endsWith('.md')) continue;
    try {
      const { meta, body } = parseFrontmatter(await fsp.readFile(path.join(dir, n), 'utf8'));
      out.push({ name: n.slice(0, -3), description: meta.description || body.trim().split('\n')[0].slice(0, 80), prompt: body.trim(), source, path: path.join(dir, n) });
    } catch {}
  }
  return out;
}

async function listSlashCommands({ root, userDir, plugins }) {
  const map = new Map();
  for (const c of BUILTIN) map.set(c.name, { ...c, source: 'builtin' });
  for (const c of plugins || []) map.set(c.name, c);
  for (const c of await readDir(userDir, 'user')) map.set(c.name, c);
  if (root) {
    for (const c of await readDir(path.join(root, '.claude', 'commands'), 'project')) map.set(c.name, c);
    for (const c of await readDir(path.join(root, '.enide', 'commands'), 'project')) map.set(c.name, c);
  }
  return [...map.values()];
}

module.exports = { BUILTIN, listSlashCommands, parseFrontmatter };
