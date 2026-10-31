'use strict';
// Integrated terminal: real PTY via node-pty when available, otherwise a `script`-backed
// pseudo-terminal (works on macOS without native modules; resize is not propagated).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }

class Terminals {
  constructor(send) { this.send = send; this.list = new Map(); }

  shell(pref) { return require('./lib/shell').interactiveShell(pref); }

  create({ id, cwd, cols = 100, rows = 24, shell }) {
    const [sh, shArgs] = this.shell(shell);
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Enide', LANG: process.env.LANG || 'en_US.UTF-8' };
    if (pty) {
      try {
        const p = pty.spawn(sh, shArgs, { name: 'xterm-256color', cols, rows, cwd: dir, env });
        p.onData((d) => this.send('term:data', id, d));
        p.onExit(({ exitCode }) => { this.list.delete(id); this.send('term:exit', id, exitCode); });
        this.list.set(id, { kind: 'pty', p });
        return { id, kind: 'pty', shell: sh, cwd: dir };
      } catch (e) {
        // fall through to fallback
      }
    }
    if (process.platform === 'win32') {
      // No pty: plain pipes to the shell (input is echoed by the terminal panel).
      const child = spawn(sh, shArgs, { cwd: dir, env, windowsHide: true });
      child.stdout.on('data', (d) => this.send('term:data', id, d.toString('utf8').replace(/\r?\n/g, '\r\n')));
      child.stderr.on('data', (d) => this.send('term:data', id, d.toString('utf8').replace(/\r?\n/g, '\r\n')));
      child.on('exit', (code) => { this.list.delete(id); this.send('term:exit', id, code); });
      child.on('error', (e) => this.send('term:data', id, `\r\n[terminal error] ${e.message}\r\n`));
      this.list.set(id, { kind: 'pipe', p: child, echo: true });
      return { id, kind: 'pipe', shell: sh, cwd: dir };
    }
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', sh, '-il'] : ['-qfc', `${sh} -il`, '/dev/null'];
    const child = spawn('script', args, { cwd: dir, env: { ...env, COLUMNS: String(cols), LINES: String(rows) } });
    child.stdout.on('data', (d) => this.send('term:data', id, d.toString('utf8')));
    child.stderr.on('data', (d) => this.send('term:data', id, d.toString('utf8')));
    child.on('exit', (code) => { this.list.delete(id); this.send('term:exit', id, code); });
    child.on('error', (e) => this.send('term:data', id, `\r\n[terminal error] ${e.message}\r\n`));
    this.list.set(id, { kind: 'script', p: child });
    // set the initial size inside the session
    setTimeout(() => { try { child.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null; clear\n`); } catch {} }, 250);
    return { id, kind: 'script', shell: sh, cwd: dir };
  }

  write(id, data) {
    const t = this.list.get(id);
    if (!t) return;
    if (t.kind === 'pty') t.p.write(data);
    else if (t.kind === 'pipe') {
      // Line editing for shells without a pty (Windows fallback): echo, backspace, Enter.
      t.line = t.line || '';
      for (const ch of String(data)) {
        if (ch === '\r' || ch === '\n') { this.send('term:data', id, '\r\n'); try { t.p.stdin.write(t.line + '\r\n'); } catch {} t.line = ''; }
        else if (ch === '\x7f' || ch === '\b') { if (t.line) { t.line = t.line.slice(0, -1); this.send('term:data', id, '\b \b'); } }
        else if (ch === '\x03') { t.line = ''; this.send('term:data', id, '^C\r\n'); }
        else if (ch >= ' ' ) { t.line += ch; this.send('term:data', id, ch); }
      }
    }
    else try { t.p.stdin.write(data); } catch {}
  }

  resize(id, cols, rows) {
    const t = this.list.get(id);
    if (!t || !cols || !rows) return;
    if (t.kind === 'pty') { try { t.p.resize(cols, rows); } catch {} }
  }

  kill(id) {
    const t = this.list.get(id);
    if (!t) return;
    try { t.kind === 'pty' ? t.p.kill() : t.kind === 'pipe' ? require('./lib/shell').killTree(t.p) : t.p.kill('SIGHUP'); } catch {}
    this.list.delete(id);
  }

  killAll() { for (const id of [...this.list.keys()]) this.kill(id); }
}

module.exports = { Terminals, hasPty: () => !!pty };
