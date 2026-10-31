'use strict';
// Built-in agent tools. Descriptions below are sent to the model verbatim and are
// visible in Settings → Prompts → Tools and in every Request Log entry.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { resolvePath, isInside, toPosix, globToRegExp, walkFiles, isBinaryFile, IMAGE_EXT } = require('../lib/fsutil');
const { hunks } = require('../lib/diff');
const { truncate } = require('./util');

const MAX_TOOL_OUTPUT = 30000;

const DEFS = {
  list_dir: {
    kind: 'read',
    description: 'List files and folders in a directory (relative to the workspace root unless absolute). Folders end with "/". Use depth 2-3 to see nested structure.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' },
      depth: { type: 'integer', description: 'How many levels to list (1-4). Default 1.' },
    } },
  },
  read_file: {
    kind: 'read',
    description: 'Read a text file with line numbers (format: "  LINE│content"). Use offset/limit for large files. Images (png/jpg/gif/webp) are returned as images when the model supports vision.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root or absolute.' },
      offset: { type: 'integer', description: '1-based line to start from.' },
      limit: { type: 'integer', description: 'Max lines to return (default 2000).' },
    }, required: ['path'] },
  },
  glob: {
    kind: 'read',
    description: 'Find files by glob pattern, e.g. "**/*.tsx" or "src/**/test_*.py". Returns paths relative to the workspace, newest first.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the workspace root.' },
    }, required: ['pattern'] },
  },
  grep: {
    kind: 'read',
    description: 'Search file contents with a regular expression (ripgrep syntax). Returns matching lines as path:line:text.',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignore_case: { type: 'boolean' },
      files_only: { type: 'boolean', description: 'Return only file paths that match.' },
      max_results: { type: 'integer', description: 'Default 200.' },
    }, required: ['pattern'] },
  },
  codebase_search: {
    kind: 'read',
    description: 'Find code relevant to a natural-language question (e.g. "where are auth tokens refreshed?"). Ranks code chunks across the workspace by keyword relevance (BM25 over identifiers, split camelCase/snake_case) and returns the best snippets with line numbers. Use grep for exact patterns.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'What you are looking for, in words.' },
      path: { type: 'string', description: 'Limit to this folder. Defaults to the workspace root.' },
      max_results: { type: 'integer', description: 'Number of snippets (default 8).' },
    }, required: ['query'] },
  },
  write_file: {
    kind: 'write',
    description: 'Create a new file or completely overwrite an existing one with the given content. Parent folders are created. Prefer edit_file for changes to existing files.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      content: { type: 'string', description: 'Full file content.' },
    }, required: ['path', 'content'] },
  },
  edit_file: {
    kind: 'write',
    description: 'Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Include enough surrounding lines to make it unique. Use an empty old_string only to create a new file.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    }, required: ['path', 'old_string', 'new_string'] },
  },
  delete_file: {
    kind: 'write',
    description: 'Delete a file or folder (moved to the macOS Trash, so it can be recovered).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  run_command: {
    kind: 'command',
    description: (process.platform === 'win32' ? 'Run a shell command (Git Bash if installed, otherwise PowerShell) on the user\'s Windows PC' : 'Run a shell command (zsh) on the user\'s Mac') + ' in the workspace folder and return stdout/stderr and the exit code. Use background=true for servers or watchers, then check_process to read their output.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root.' },
      timeout_seconds: { type: 'integer', description: 'Kill after this many seconds (default 120, max 1800). Ignored for background.' },
      background: { type: 'boolean', description: 'Start and return immediately with a process id.' },
    }, required: ['command'] },
  },
  check_process: {
    kind: 'read',
    description: 'Read new output from a background process started with run_command, or stop it.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' },
      kill: { type: 'boolean', description: 'Stop the process.' },
    }, required: ['id'] },
  },
  web_fetch: {
    kind: 'network',
    description: 'Fetch a URL over HTTP(S) and return its readable text (HTML is converted to text).',
    parameters: { type: 'object', properties: {
      url: { type: 'string' },
      max_chars: { type: 'integer', description: 'Default 40000.' },
    }, required: ['url'] },
  },
  web_search: {
    kind: 'network',
    description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets. Follow up with web_fetch to read a result.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  computer: {
    kind: 'computer',
    description: 'Control the user\'s Mac like a person: take a screenshot, move/click the mouse, drag, scroll, type text, press key combos (e.g. "cmd+t", "enter"), open apps or URLs. x/y are pixel coordinates in the most recent screenshot. Start with action=screenshot; every other action returns a fresh screenshot so you can check the result. Prefer run_command / file tools when they can do the job.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'open_app', 'open_url', 'wait', 'cursor_position'] },
      x: { type: 'integer' }, y: { type: 'integer' },
      x2: { type: 'integer', description: 'Drag end x' }, y2: { type: 'integer', description: 'Drag end y' },
      text: { type: 'string', description: 'Text to type' },
      keys: { type: 'string', description: 'Key combo, e.g. "cmd+shift+t", "enter", "esc"' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', description: 'Scroll amount (lines), default 5' },
      app: { type: 'string', description: 'Application name for open_app, e.g. "Safari"' },
      url: { type: 'string' },
      ms: { type: 'integer', description: 'Milliseconds for wait' },
    }, required: ['action'] },
  },
  read_lints: {
    kind: 'read',
    description: 'Get compiler and linter diagnostics (errors/warnings) for files you changed, using the checkers the project already has (tsc, eslint, ruff, go vet, cargo check). Run it after editing.',
    parameters: { type: 'object', properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders to check. Empty = whole project.' },
    } },
  },
  semantic_search: {
    kind: 'read',
    description: 'Search the codebase by meaning using the embedding index (Settings → Index). Best for "where is X handled" questions when you do not know exact names. Falls back to keyword ranking if no index is built.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      max_results: { type: 'integer', description: 'Default 8.' },
    }, required: ['query'] },
  },
  docs_search: {
    kind: 'read',
    description: 'Search documentation sets the user added in Settings → Docs (crawled websites). Returns the most relevant passages with their URLs.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      docs: { type: 'string', description: 'Name of a docs set to limit the search to (optional).' },
    }, required: ['query'] },
  },
  update_memory: {
    kind: 'meta',
    description: 'Save, change or remove a durable fact in memory so future chats know it. scope "project" = this workspace (.enide/memory.md), "global" = all projects. Keep each fact to one short line. Memory is shown to the user and included in your system prompt.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'remove', 'replace'] },
      scope: { type: 'string', enum: ['project', 'global'] },
      text: { type: 'string', description: 'The fact to add, or the new text for replace.' },
      old_text: { type: 'string', description: 'Existing line to remove or replace.' },
    }, required: ['action', 'scope'] },
  },
  task: {
    kind: 'meta',
    description: 'Delegate a self-contained task to a subagent with a fresh context. type "explore" = read-only research (fast, safe); type "general" = may also edit files and run commands. Call several in the same turn to run them in parallel. The subagent returns a written report — give it all context it needs in the prompt.',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: 'Short label (3-6 words) shown to the user.' },
      prompt: { type: 'string', description: 'Full instructions for the subagent.' },
      type: { type: 'string', enum: ['explore', 'general'] },
    }, required: ['description', 'prompt'] },
  },
  todo_write: {
    kind: 'meta',
    description: 'Create or update the task list shown to the user for multi-step work. Send the full list every time. Keep exactly one item in_progress while working.',
    parameters: { type: 'object', properties: {
      todos: { type: 'array', items: { type: 'object', properties: {
        content: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'] } },
    }, required: ['todos'] },
  },
};

const READ_ONLY = new Set(['list_dir', 'read_file', 'glob', 'grep', 'codebase_search', 'semantic_search', 'docs_search', 'read_lints', 'check_process', 'web_fetch', 'web_search', 'todo_write', 'task', 'update_memory']);

function definitions(mode, enabledMap, opts = {}) {
  return Object.entries(DEFS)
    .filter(([name]) => (mode === 'ask' || mode === 'plan' ? READ_ONLY.has(name) && name !== 'check_process' : true))
    .filter(([name]) => name !== 'computer' || opts.computerUse)
    .filter(([name]) => name !== 'task' || opts.subagents !== false)
    .filter(([name]) => name !== 'docs_search' || (opts.docs && opts.docs.length))
    .filter(([name]) => name !== 'update_memory' || opts.memory !== false)
    .filter(([name]) => !enabledMap || enabledMap[name] !== false)
    .map(([name, d]) => {
      let description = d.description;
      if (name === 'docs_search' && opts.docs && opts.docs.length) description += ` Available: ${opts.docs.join(', ')}.`;
      return { name, description, parameters: d.parameters, kind: d.kind, source: 'builtin' };
    });
}

// ---------- background processes ----------
const procs = new Map();

const SH = require('../lib/shell');
function shellPath() { return SH.shellCommand('')[0]; }

function startProcess(command, cwd, env) {
  const [file, args] = SH.shellCommand(command);
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env, TERM: 'dumb', NO_COLOR: '1', CI: process.env.CI || '' }, detached: !SH.IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { id: 'p' + (child.pid || Math.random().toString(36).slice(2, 7)), child, out: '', read: 0, exit: null, command, started: Date.now() };
  const onData = (d) => { rec.out += d.toString(); if (rec.out.length > 2_000_000) { rec.read = Math.max(0, rec.read - (rec.out.length - 1_000_000)); rec.out = rec.out.slice(-1_000_000); } };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, sig) => { rec.exit = code == null ? `signal ${sig}` : code; });
  child.on('error', (e) => { rec.out += `\n[spawn error] ${e.message}`; rec.exit = -1; });
  return rec;
}

function killTree(rec) {
  SH.killTree(rec.child, 'SIGTERM');
  setTimeout(() => { if (rec.exit == null) SH.killTree(rec.child, 'SIGKILL'); }, 2000);
}

function killAll() { for (const r of procs.values()) if (r.exit == null) killTree(r); }

// ---------- helpers ----------
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function which(bin) {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [bin], { env: process.env }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

let rgPathCache;
async function rgPath() {
  if (rgPathCache !== undefined) return rgPathCache;
  rgPathCache = await which('rg');
  return rgPathCache;
}

async function grepJs({ root, target, regex, globRe, filesOnly, max, signal }) {
  const results = [];
  const files = new Set();
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new Error(`Path not found: ${target}`);
  const iter = st.isFile() ? (async function* () { yield target; })() : walkFiles(target, { signal });
  for await (const file of iter) {
    const rel = toPosix(path.relative(root, file));
    if (globRe && !globRe.test(rel) && !globRe.test(path.basename(file))) continue;
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    if (stat.size > 2_000_000) continue;
    if (await isBinaryFile(file)) continue;
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        files.add(rel);
        if (filesOnly) break;
        results.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`);
        if (results.length >= max) return { results, files: [...files], capped: true };
      }
    }
    if (filesOnly && files.size >= max) break;
  }
  return { results, files: [...files], capped: false };
}

function grepRg({ rg, root, target, pattern, glob, ignoreCase, filesOnly, max, signal }) {
  return new Promise((resolve, reject) => {
    const args = ['--no-heading', '--line-number', '--color', 'never', '--max-columns', '300', '--max-columns-preview'];
    if (ignoreCase) args.push('-i');
    if (filesOnly) args.push('-l');
    if (glob) args.push('-g', glob);
    args.push('-e', pattern, target);
    const child = spawn(rg, args, { cwd: root });
    let out = '';
    let lines = 0;
    let capped = false;
    child.stdout.on('data', (d) => {
      out += d.toString();
      lines = out.split('\n').length;
      if (lines > max + 1) { capped = true; child.kill(); }
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
    child.on('close', (code) => {
      if (code === 2 && !out && !capped) return reject(new Error(err.trim() || 'ripgrep failed'));
      const rows = out.split('\n').filter(Boolean).slice(0, max).map((l) => {
        return l.replace(/^[^:]+/, (p) => toPosix(path.relative(root, path.isAbsolute(p) ? p : path.join(root, p))));
      });
      resolve(filesOnly ? { results: [], files: rows, capped } : { results: rows, files: [], capped });
    });
    child.on('error', reject);
  });
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'where', 'what', 'how', 'does', 'do', 'which', 'with', 'this', 'that', 'it', 'be', 'by', 'from', 'code', 'file', 'files', 'function', 'functions', 'где', 'как', 'что', 'это', 'в', 'и', 'на', 'с', 'по']);
function tokenize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/i)
    .filter((t) => t.length > 1);
}

function numberLines(text, start) {
  const lines = text.split('\n');
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width + 1)}│${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
}

// ---------- executors ----------
// ctx: { root, signal, fetchImpl, checkpoint, emitOutput(text), trash(abs), vision, todos(list) }
const EXEC = {
  async list_dir(a, ctx) {
    const dir = resolvePath(ctx.root, a.path || '.');
    const depth = Math.min(Math.max(parseInt(a.depth || 1, 10) || 1, 1), 4);
    const lines = [];
    let count = 0;
    const walk = async (d, level, prefix) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { if (level === 0) throw e; return; }
      entries.sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (e.name === '.DS_Store') continue;
        if (count++ > 1500) { lines.push(prefix + '… (truncated)'); return; }
        const isDir = e.isDirectory();
        lines.push(prefix + e.name + (isDir ? '/' : ''));
        if (isDir && level + 1 < depth && !['node_modules', '.git'].includes(e.name)) await walk(path.join(d, e.name), level + 1, prefix + '  ');
      }
    };
    await walk(dir, 0, '');
    return { output: `${dir}\n${lines.join('\n') || '(empty)'}` };
  },

  async read_file(a, ctx) {
    const file = resolvePath(ctx.root, a.path);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error(`${a.path} is a directory — use list_dir.`);
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_EXT[ext]) {
      if (st.size > 5_000_000) return { output: `Image ${a.path} is too large (${st.size} bytes).` };
      const data = (await fsp.readFile(file)).toString('base64');
      return { output: `Image file ${a.path} (${st.size} bytes).`, images: ctx.vision ? [{ mediaType: IMAGE_EXT[ext], data }] : [] };
    }
    if (st.size > 20_000_000) throw new Error(`File is too large (${st.size} bytes). Use grep to find the relevant part.`);
    if (await isBinaryFile(file)) return { output: `${a.path} is a binary file (${st.size} bytes).` };
    const text = await fsp.readFile(file, 'utf8');
    const all = text.split('\n');
    const offset = Math.max(1, parseInt(a.offset || 1, 10) || 1);
    const limit = Math.max(1, parseInt(a.limit || 2000, 10) || 2000);
    const slice = all.slice(offset - 1, offset - 1 + limit).join('\n');
    let out = numberLines(slice, offset);
    if (offset - 1 + limit < all.length) out += `\n… (${all.length - (offset - 1 + limit)} more lines; total ${all.length})`;
    if (!text.length) out = '(empty file)';
    return { output: truncate(out, 120000), display: { path: file, lines: all.length } };
  },

  async glob(a, ctx) {
    const base = resolvePath(ctx.root, a.path || '.');
    const re = globToRegExp(a.pattern);
    const hits = [];
    for await (const f of walkFiles(base, { signal: ctx.signal })) {
      const rel = toPosix(path.relative(base, f));
      if (re.test(rel)) {
        let m = 0;
        try { m = (await fsp.stat(f)).mtimeMs; } catch {}
        hits.push({ p: toPosix(path.relative(ctx.root, f)) || rel, m });
        if (hits.length >= 2000) break;
      }
    }
    hits.sort((x, y) => y.m - x.m);
    const list = hits.slice(0, 500).map((h) => h.p);
    return { output: list.length ? list.join('\n') + (hits.length > 500 ? `\n… ${hits.length - 500} more` : '') : 'No files matched.' };
  },

  async grep(a, ctx) {
    const target = resolvePath(ctx.root, a.path || '.');
    const max = Math.min(parseInt(a.max_results || 200, 10) || 200, 2000);
    const rg = await rgPath();
    let r;
    if (rg) {
      r = await grepRg({ rg, root: ctx.root, target, pattern: a.pattern, glob: a.glob, ignoreCase: a.ignore_case, filesOnly: a.files_only, max, signal: ctx.signal });
    } else {
      let regex;
      try { regex = new RegExp(a.pattern, a.ignore_case ? 'i' : ''); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
      r = await grepJs({ root: ctx.root, target, regex, globRe: a.glob ? globToRegExp(a.glob) : null, filesOnly: a.files_only, max, signal: ctx.signal });
    }
    const rows = a.files_only ? r.files : r.results;
    return { output: rows.length ? rows.join('\n') + (r.capped ? `\n… (capped at ${max})` : '') : 'No matches.' };
  },

  async codebase_search(a, ctx) {
    const base = resolvePath(ctx.root, a.path || '.');
    const max = Math.min(parseInt(a.max_results || 8, 10) || 8, 30);
    const terms = tokenize(a.query).filter((t) => !STOP.has(t));
    if (!terms.length) throw new Error('Query has no searchable words.');
    const chunks = [];
    const df = new Map();
    let files = 0;
    for await (const f of walkFiles(base, { signal: ctx.signal, maxFiles: 8000 })) {
      let st; try { st = await fsp.stat(f); } catch { continue; }
      if (st.size > 400_000 || /\.(lock|min\.js|map|svg|png|jpe?g|gif|ico|pdf|zip|woff2?|ttf)$/i.test(f)) continue;
      if (await isBinaryFile(f)) continue;
      let text; try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      files++;
      const rel = toPosix(path.relative(ctx.root, f));
      const pathTokens = tokenize(rel);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 40) {
        const body = lines.slice(i, i + 60).join('\n');
        const toks = tokenize(body).concat(pathTokens, pathTokens);
        const tf = new Map();
        for (const t of toks) if (terms.includes(t)) tf.set(t, (tf.get(t) || 0) + 1);
        if (!tf.size) continue;
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
        chunks.push({ rel, start: i + 1, body, tf, len: toks.length });
      }
    }
    if (!chunks.length) return { output: `No relevant code found in ${files} files.` };
    const N = chunks.length;
    const avg = chunks.reduce((x, c) => x + c.len, 0) / N;
    for (const c of chunks) {
      let sc = 0;
      for (const [t, f] of c.tf) {
        const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        sc += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.len / avg)));
      }
      c.score = sc * (1 + 0.15 * c.tf.size);
    }
    chunks.sort((x, y) => y.score - x.score);
    const seen = new Set();
    const out = [];
    for (const c of chunks) {
      const key = c.rel + ':' + Math.floor(c.start / 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`── ${c.rel}:${c.start}\n${numberLines(c.body.split('\n').slice(0, 40).join('\n'), c.start)}`);
      if (out.length >= max) break;
    }
    return { output: truncate(out.join('\n\n'), 60000) };
  },

  async write_file(a, ctx) {
    const file = resolvePath(ctx.root, a.path);
    let before = null;
    try { before = await fsp.readFile(file, 'utf8'); } catch {}
    if (ctx.checkpoint) await ctx.checkpoint.record(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const content = String(a.content == null ? '' : a.content);
    await fsp.writeFile(file, content, 'utf8');
    const d = hunks(before || '', content);
    return {
      output: `${before == null ? 'Created' : 'Overwrote'} ${a.path} (${content.split('\n').length} lines).`,
      display: { kind: 'diff', path: file, created: before == null, added: d.added, removed: d.removed, hunks: d.hunks, truncated: d.truncated },
      changedFile: file,
    };
  },

  async edit_file(a, ctx) {
    const file = resolvePath(ctx.root, a.path);
    let before = null;
    try { before = await fsp.readFile(file, 'utf8'); } catch {}
    const oldS = String(a.old_string == null ? '' : a.old_string);
    const newS = String(a.new_string == null ? '' : a.new_string);
    let after;
    if (before == null) {
      if (oldS !== '') throw new Error(`File not found: ${a.path}. To create it, use write_file or edit_file with an empty old_string.`);
      after = newS;
    } else if (oldS === '') {
      if (before.length) throw new Error('old_string is empty but the file already exists. Provide the exact text to replace.');
      after = newS;
    } else {
      let count = before.split(oldS).length - 1;
      let src = before;
      let o = oldS, n = newS;
      if (count === 0 && before.includes('\r\n') && !oldS.includes('\r\n')) {
        // tolerate LF-vs-CRLF mismatch
        o = oldS.replace(/\n/g, '\r\n'); n = newS.replace(/\n/g, '\r\n');
        count = src.split(o).length - 1;
      }
      if (count === 0) {
        const trimmed = oldS.trim();
        const hint = trimmed && before.includes(trimmed) ? ' (it matches after trimming whitespace — check indentation and surrounding newlines)' : '';
        throw new Error(`old_string not found in ${a.path}${hint}. Read the file again and copy the exact text.`);
      }
      if (count > 1 && !a.replace_all) throw new Error(`old_string matches ${count} places in ${a.path}. Add more surrounding context to make it unique, or set replace_all.`);
      after = a.replace_all ? src.split(o).join(n) : src.replace(o, () => n);
    }
    if (ctx.checkpoint) await ctx.checkpoint.record(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, after, 'utf8');
    const d = hunks(before || '', after);
    return {
      output: `Edited ${a.path}: +${d.added == null ? '?' : d.added} −${d.removed == null ? '?' : d.removed} lines.`,
      display: { kind: 'diff', path: file, created: before == null, added: d.added, removed: d.removed, hunks: d.hunks, truncated: d.truncated },
      changedFile: file,
    };
  },

  async delete_file(a, ctx) {
    const file = resolvePath(ctx.root, a.path);
    const st = await fsp.stat(file);
    if (ctx.checkpoint && st.isFile()) await ctx.checkpoint.record(file);
    if (ctx.trash) await ctx.trash(file);
    else await fsp.rm(file, { recursive: true, force: true });
    return { output: `Deleted ${a.path}${ctx.trash ? ' (moved to Trash)' : ''}.`, changedFile: file, display: { kind: 'delete', path: file } };
  },

  async run_command(a, ctx) {
    const cwd = resolvePath(ctx.root, a.cwd || '.');
    const rec = startProcess(String(a.command), cwd, ctx.env || {});
    procs.set(rec.id, rec);
    if (a.background) {
      await new Promise((r) => setTimeout(r, 2500));
      rec.read = rec.out.length;
      return { output: `Started in background as ${rec.id}${rec.exit != null ? ` (already exited: ${rec.exit})` : ''}.\nInitial output:\n${truncate(rec.out, 8000) || '(none yet)'}`, display: { kind: 'command', command: a.command, cwd, background: true, pid: rec.id, output: rec.out.slice(0, 20000) } };
    }
    const timeout = Math.min(Math.max(parseInt(a.timeout_seconds || 120, 10) || 120, 1), 1800) * 1000;
    let lastEmit = 0;
    const tick = setInterval(() => {
      if (ctx.emitOutput && rec.out.length !== lastEmit) { ctx.emitOutput(rec.out.slice(-20000)); lastEmit = rec.out.length; }
    }, 250);
    let timedOut = false;
    await new Promise((resolve) => {
      const t = setTimeout(() => { timedOut = true; killTree(rec); }, timeout);
      const onAbort = () => { killTree(rec); };
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      const done = () => { clearTimeout(t); if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort); resolve(); };
      if (rec.exit != null) return done();
      rec.child.on('close', done);
      rec.child.on('error', done);
    });
    clearInterval(tick);
    procs.delete(rec.id);
    const out = rec.out;
    const code = rec.exit;
    const header = timedOut ? `Timed out after ${timeout / 1000}s and was stopped.` : ctx.signal && ctx.signal.aborted ? 'Stopped by user.' : `Exit code: ${code}`;
    return {
      output: `${header}\n${truncate(out, MAX_TOOL_OUTPUT) || '(no output)'}`,
      display: { kind: 'command', command: a.command, cwd, exitCode: code, timedOut, output: out.length > 60000 ? out.slice(0, 20000) + '\n…\n' + out.slice(-38000) : out },
    };
  },

  async check_process(a) {
    const rec = procs.get(a.id);
    if (!rec) throw new Error(`No background process with id ${a.id}.`);
    if (a.kill) { killTree(rec); await new Promise((r) => setTimeout(r, 300)); }
    const fresh = rec.out.slice(rec.read);
    rec.read = rec.out.length;
    const status = rec.exit != null ? `exited (${rec.exit})` : a.kill ? 'stopping' : 'running';
    if (rec.exit != null && a.kill) procs.delete(a.id);
    return { output: `Process ${a.id} [${status}] ${rec.command}\nNew output:\n${truncate(fresh, MAX_TOOL_OUTPUT) || '(none)'}` };
  },

  async web_fetch(a, ctx) {
    let url = String(a.url || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const f = ctx.fetchImpl || fetch;
    const res = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Enide/0.1', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' }, signal: ctx.signal });
    const ctype = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = /html/i.test(ctype) || /^\s*<!doctype html|^\s*<html/i.test(raw) ? htmlToText(raw) : raw;
    const max = Math.min(parseInt(a.max_chars || 40000, 10) || 40000, 200000);
    return { output: `HTTP ${res.status} ${url}\n\n${truncate(text, max)}` };
  },

  async web_search(a, ctx) {
    const f = ctx.fetchImpl || fetch;
    const res = await f('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(a.query), { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }, signal: ctx.signal });
    const html = await res.text();
    const items = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/g;
    let m;
    while ((m = re.exec(html)) && items.length < 10) {
      let href = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      items.push(`${items.length + 1}. ${htmlToText(m[2])}\n   ${href}\n   ${htmlToText(m[3] || m[4] || '')}`);
    }
    return { output: items.length ? items.join('\n') : `No results parsed (HTTP ${res.status}). Try web_fetch on a specific site.` };
  },

  async computer(a, ctx) {
    return require('./computer').act(a, { autoScreenshot: true });
  },

  async read_lints(a, ctx) {
    const { runLints, formatLints } = require('./lints');
    const r = await runLints(ctx.root, { paths: a.paths || [], signal: ctx.signal });
    return { output: formatLints(ctx.root, r), display: { kind: 'problems', items: r.items.slice(0, 200), ran: r.ran } };
  },

  async semantic_search(a, ctx) {
    if (ctx.services && ctx.services.semanticSearch) {
      const r = await ctx.services.semanticSearch(ctx.root, a.query, Math.min(parseInt(a.max_results || 8, 10) || 8, 30));
      if (r) return { output: r };
    }
    const r = await EXEC.codebase_search({ query: a.query, max_results: a.max_results }, ctx);
    return { output: '(no embedding index for this workspace — keyword ranking used)\n\n' + r.output };
  },

  async docs_search(a, ctx) {
    if (!ctx.services || !ctx.services.docsSearch) throw new Error('No documentation sets are configured (Settings → Docs).');
    return { output: await ctx.services.docsSearch(a.query, a.docs) };
  },

  async update_memory(a, ctx) {
    const file = a.scope === 'global' ? ctx.memoryFiles && ctx.memoryFiles.global : ctx.memoryFiles && ctx.memoryFiles.project;
    if (!file) throw new Error(a.scope === 'global' ? 'Global memory is not available.' : 'Project memory needs an open folder.');
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch {}
    const lines = text.split('\n').filter((l) => l.trim());
    const norm = (l) => l.replace(/^[-*]\s*/, '').trim();
    const fact = String(a.text || '').replace(/\n+/g, ' ').trim();
    if (a.action === 'add') {
      if (!fact) throw new Error('text is required');
      if (!lines.some((l) => norm(l) === fact)) lines.push(`- ${fact}`);
    } else {
      const old = String(a.old_text || '').trim();
      const i = lines.findIndex((l) => norm(l) === norm(old) || (old && norm(l).includes(norm(old))));
      if (i < 0) throw new Error(`Not found in ${a.scope} memory: ${old}`);
      if (a.action === 'remove') lines.splice(i, 1);
      else { if (!fact) throw new Error('text is required'); lines[i] = `- ${fact}`; }
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return { output: `${a.scope} memory updated (${lines.length} facts).`, display: { kind: 'memory', scope: a.scope, path: file, action: a.action, text: fact || a.old_text } };
  },

  async todo_write(a, ctx) {
    const todos = Array.isArray(a.todos) ? a.todos.map((t) => ({ content: String(t.content || ''), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' })) : [];
    if (ctx.todos) ctx.todos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return { output: `Task list updated (${done}/${todos.length} done).`, display: { kind: 'todos', todos } };
  },
};

// Decide whether a call needs the user's approval. Returns { needs, reason }.
function approvalFor(name, args, ctx, policy) {
  const def = DEFS[name];
  if (!def) return { needs: true, reason: 'external' };
  const p = policy || {};
  const pathArg = args && (args.path || args.cwd);
  const abs = pathArg ? resolvePath(ctx.root, pathArg) : ctx.root;
  const outside = ctx.hasWorkspace ? ![ctx.root, ...(ctx.extraRoots || [])].some((r) => isInside(r, abs)) : true;
  if (def.kind === 'read' || def.kind === 'meta') {
    if (outside && p.readOutside === 'ask' && name !== 'check_process') return { needs: true, reason: 'outside' };
    return { needs: false };
  }
  if (def.kind === 'network') return { needs: p.network === 'ask', reason: 'network' };
  if (def.kind === 'computer') return { needs: p.computer !== 'auto' && args.action !== 'screenshot' && args.action !== 'cursor_position' && args.action !== 'wait' ? true : p.computer === 'ask-all', reason: 'computer' };
  if (def.kind === 'write') {
    if (outside) return { needs: p.writeOutside !== 'auto', reason: 'outside' };
    return { needs: p.write === 'ask', reason: 'write' };
  }
  if (def.kind === 'command') {
    const cmd = String(args.command || '').trim();
    if ((p.denyList || []).some((d) => d && cmd.includes(d))) return { needs: true, reason: 'deny' };
    if (p.command === 'auto') return { needs: false };
    if (p.strict) {
      const ok = (p.userAllow || []).some((pre) => pre && (cmd === pre || cmd.startsWith(pre + ' '))) && !/[;&|`$<>]/.test(cmd);
      return ok ? { needs: false } : { needs: true, reason: 'command' };
    }
    if ((p.allowList || []).some((pre) => pre && (cmd === pre || cmd.startsWith(pre + ' ')))) {
      if (!/[;&|`$<>]/.test(cmd) || p.allowChained) return { needs: false };
    }
    return { needs: true, reason: 'command' };
  }
  return { needs: true, reason: 'other' };
}

module.exports = { DEFS, READ_ONLY, definitions, EXEC, approvalFor, killAll, procs, htmlToText, startProcess, tokenize, STOP, numberLines };
