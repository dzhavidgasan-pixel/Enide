// Rebuilds node-pty against the installed Electron so the integrated terminal
// gets a real PTY. If anything fails, Enide falls back to a `script`-based
// terminal, so this step never breaks `npm install`.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const has = (m) => fs.existsSync(path.join(root, 'node_modules', m, 'package.json'));

// CI release builds use node-pty's prebuilt binaries for every OS/arch instead.
if (process.env.ENIDE_SKIP_PTY_REBUILD) { console.log('[enide] node-pty rebuild skipped (prebuilds).'); process.exit(0); }
if (!has('node-pty') || !has('electron') || !has('@electron/rebuild')) {
  console.log('[enide] node-pty rebuild skipped (optional).');
  process.exit(0);
}
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
const r = spawnSync(bin, ['-f', '-w', 'node-pty'], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) console.log('[enide] node-pty rebuild failed — terminal will use the fallback mode.');
process.exit(0);
