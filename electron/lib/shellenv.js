'use strict';
// Apps launched from Finder get a minimal PATH. Load the user's login-shell environment
// so terminals, agent commands and MCP servers (npx, uvx, brew tools…) work like in Terminal.app.
const { execFile } = require('child_process');

function loadShellEnv(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') return resolve(false);
    const shell = process.env.SHELL || '/bin/zsh';
    const mark = '__ENIDE_ENV__';
    const cmd = `printf '${mark}'; env; printf '${mark}'`;
    execFile(shell, ['-ilc', cmd], { timeout: timeoutMs, env: { ...process.env, ENIDE_RESOLVING_ENV: '1' }, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve(false);
      const parts = String(stdout).split(mark);
      if (parts.length < 3) return resolve(false);
      for (const line of parts[1].split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const k = line.slice(0, i);
        if (['_', 'SHLVL', 'PWD', 'OLDPWD', 'ENIDE_RESOLVING_ENV'].includes(k)) continue;
        process.env[k] = line.slice(i + 1);
      }
      resolve(true);
    });
  });
}

module.exports = { loadShellEnv };
