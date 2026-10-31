'use strict';
// Project diagnostics: runs the checkers the project already has (tsc, eslint, ruff,
// go vet, cargo check, node --check, py_compile) and normalizes their output.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, cwd, { timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } }); }
    catch (e) { return resolve({ code: -1, out: e.message, missing: true }); }
    child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const ab = () => { try { child.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', ab, { once: true });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(t); if (signal) signal.removeEventListener('abort', ab); resolve({ code, out }); });
  });
}

const exists = (root, ...p) => fs.existsSync(path.join(root, ...p));
const bin = (root, name) => { const p = path.join(root, 'node_modules', '.bin', name); return fs.existsSync(p) ? p : null; };
function which(name) {
  for (const dir of String(process.env.PATH || '').split(':')) { const p = path.join(dir, name); if (dir && fs.existsSync(p)) return p; }
  return null;
}

function parseLines(out, re, map) {
  const items = [];
  for (const line of String(out).split('\n')) { const m = re.exec(line); if (m) items.push(map(m)); }
  return items;
}

async function runLints(root, { paths = [], signal } = {}) {
  const abs = (paths || []).map((p) => path.resolve(root, p));
  const has = (re) => (abs.length ? abs.some((p) => re.test(p)) : true);
  const checkers = [];
  const items = [];
  const ran = [];

  if (exists(root, 'tsconfig.json') && bin(root, 'tsc') && has(/\.(ts|tsx|mts|cts|js|jsx)$/)) {
    checkers.push(async () => {
      const r = await run(bin(root, 'tsc'), ['--noEmit', '--pretty', 'false', '-p', '.'], root, { signal });
      ran.push('tsc');
      items.push(...parseLines(r.out, /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/, (m) => ({ file: path.resolve(root, m[1]), line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6], source: 'tsc' })));
    });
  }
  const eslintCfg = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'].some((f) => exists(root, f));
  if (eslintCfg && bin(root, 'eslint') && has(/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/)) {
    checkers.push(async () => {
      const targets = abs.filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(p));
      const r = await run(bin(root, 'eslint'), ['-f', 'unix', ...(targets.length ? targets : ['.'])], root, { signal });
      ran.push('eslint');
      items.push(...parseLines(r.out, /^(.+?):(\d+):(\d+):\s*(.*?)(?:\s*\[(Error|Warning)\/([^\]]+)\])?$/, (m) => ({ file: path.resolve(root, m[1]), line: +m[2], col: +m[3], severity: (m[5] || 'error').toLowerCase(), code: m[6] || '', message: m[4], source: 'eslint' })));
    });
  }
  const pyFiles = abs.filter((p) => p.endsWith('.py'));
  const isPy = exists(root, 'pyproject.toml') || exists(root, 'requirements.txt') || exists(root, 'setup.py') || pyFiles.length;
  if (isPy && has(/\.py$/)) {
    const ruff = bin(root, 'ruff') || which('ruff') || (exists(root, '.venv', 'bin', 'ruff') ? path.join(root, '.venv', 'bin', 'ruff') : null);
    if (ruff) {
      checkers.push(async () => {
        const r = await run(ruff, ['check', '--output-format', 'concise', ...(pyFiles.length ? pyFiles : ['.'])], root, { signal });
        ran.push('ruff');
        items.push(...parseLines(r.out, /^(.+?):(\d+):(\d+): (\S+) (.*)$/, (m) => ({ file: path.resolve(root, m[1]), line: +m[2], col: +m[3], severity: /^E9|^F8/.test(m[4]) ? 'error' : 'warning', code: m[4], message: m[5], source: 'ruff' })));
      });
    } else if (pyFiles.length) {
      checkers.push(async () => {
        ran.push('py_compile');
        for (const f of pyFiles) {
          const r = await run('python3', ['-m', 'py_compile', f], root, { signal });
          const m = /File "(.+?)", line (\d+)[\s\S]*?(\w*Error: .*)/.exec(r.out);
          if (r.code !== 0 && m) items.push({ file: m[1], line: +m[2], col: 1, severity: 'error', code: '', message: m[3], source: 'python' });
        }
      });
    }
  }
  if (exists(root, 'go.mod') && has(/\.go$/)) {
    checkers.push(async () => {
      const r = await run('go', ['vet', './...'], root, { signal });
      ran.push('go vet');
      items.push(...parseLines(r.out, /^(?:vet: )?(.+?\.go):(\d+):(\d+): (.*)$/, (m) => ({ file: path.resolve(root, m[1]), line: +m[2], col: +m[3], severity: 'error', code: '', message: m[4], source: 'go' })));
    });
  }
  if (exists(root, 'Cargo.toml') && has(/\.rs$/)) {
    checkers.push(async () => {
      const r = await run('cargo', ['check', '--message-format', 'short', '--quiet'], root, { signal, timeoutMs: 300000 });
      ran.push('cargo check');
      items.push(...parseLines(r.out, /^(.+?\.rs):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/, (m) => ({ file: path.resolve(root, m[1]), line: +m[2], col: +m[3], severity: m[4], code: m[5] || '', message: m[6], source: 'cargo' })));
    });
  }
  // Plain JS files without a TypeScript setup: at least catch syntax errors.
  const plainJs = abs.filter((p) => /\.(js|mjs|cjs)$/.test(p) && fs.existsSync(p));
  if (plainJs.length && !checkers.length) {
    checkers.push(async () => {
      ran.push('node --check');
      for (const f of plainJs) {
        const r = await run(process.execPath.includes('Electron') ? 'node' : process.execPath, ['--check', f], root, { signal });
        const m = new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(r.out);
        if (r.code !== 0) items.push({ file: f, line: m ? +m[1] : 1, col: 1, severity: 'error', code: '', message: (r.out.split('\n').find((l) => /Error/.test(l)) || r.out).trim().slice(0, 300), source: 'node' });
      }
    });
  }

  await Promise.all(checkers.map((c) => c().catch(() => {})));
  let filtered = items;
  if (abs.length) filtered = items.filter((i) => abs.some((p) => i.file === p || i.file.startsWith(p + path.sep)));
  filtered.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || a.file.localeCompare(b.file) || a.line - b.line);
  return { items: filtered.slice(0, 500), ran, total: filtered.length };
}

function formatLints(root, r) {
  if (!r.ran.length) return 'No checker found for these files (looked for tsc, eslint, ruff, go vet, cargo check). Run the project build or tests instead.';
  if (!r.items.length) return `No problems found (${r.ran.join(', ')}).`;
  const lines = r.items.map((i) => `${path.relative(root, i.file)}:${i.line}:${i.col} ${i.severity}${i.code ? ' ' + i.code : ''}: ${i.message} [${i.source}]`);
  return `${r.total} problem(s) (${r.ran.join(', ')}):\n${lines.join('\n')}`;
}

module.exports = { runLints, formatLints };
