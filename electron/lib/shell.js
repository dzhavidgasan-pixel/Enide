'use strict';
// One place that knows how to run a shell command on each OS.
// macOS/Linux: the user's login shell (zsh by default). Windows: Git Bash if installed, else PowerShell.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

function gitBash() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function unixShell() {
  return process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh');
}

// [file, args] that run `command` non-interactively.
function shellCommand(command) {
  if (!IS_WIN) return [unixShell(), ['-c', command]];
  const bash = gitBash();
  if (bash) return [bash, ['-lc', command]];
  return ['powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]];
}

// Interactive shell for the terminal panel.
function interactiveShell(pref) {
  if (pref && fs.existsSync(pref)) return [pref, IS_WIN ? [] : ['-l']];
  if (!IS_WIN) return [unixShell(), ['-l']];
  const bash = gitBash();
  if (bash) return [bash, ['--login', '-i']];
  return ['powershell.exe', ['-NoLogo']];
}

function shellName() {
  if (!IS_WIN) return path.basename(unixShell());
  return gitBash() ? 'Git Bash' : 'PowerShell';
}

function killTree(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {} return; }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

module.exports = { IS_WIN, shellCommand, interactiveShell, shellName, killTree, unixShell };
