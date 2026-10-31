'use strict';
// Computer use on macOS: screenshots (screencapture), mouse via CoreGraphics events
// (JXA/osascript), keyboard via System Events. No native modules required.
// Needs: System Settings → Privacy & Security → Accessibility and Screen Recording for Enide.
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const MAX_DIM = 1440;
let lastShot = null; // { imgW, imgH, ptW, ptH }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 50 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err) { const e = new Error((stderr || err.message || '').trim()); e.code = err.code; return reject(e); }
      resolve(String(stdout));
    });
  });
}

const jxa = (code) => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', code]);
const applescript = (code) => run('/usr/bin/osascript', ['-e', code]);

function permissionHint(e) {
  const m = String(e && e.message || e);
  if (/not allowed|1002|-1719|assistive|-25211|Accessibility/i.test(m)) {
    return `${m}\nEnide needs Accessibility permission: System Settings → Privacy & Security → Accessibility → enable Enide, then retry.`;
  }
  return m;
}

async function screenSizePoints() {
  const out = await jxa(`ObjC.import('AppKit'); var f = $.NSScreen.mainScreen.frame; JSON.stringify({w: f.size.width, h: f.size.height});`);
  return JSON.parse(out.trim());
}

async function screenshot() {
  if (process.platform !== 'darwin') throw new Error('Computer use is available on macOS only.');
  const tmp = path.join(os.tmpdir(), `enide-shot-${Date.now()}.png`);
  const small = tmp.replace('.png', '-s.png');
  try {
    await run('/usr/sbin/screencapture', ['-x', '-C', '-t', 'png', tmp]);
    await run('/usr/bin/sips', ['-Z', String(MAX_DIM), tmp, '--out', small]);
    const info = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', small]);
    const imgW = +(/pixelWidth:\s*(\d+)/.exec(info) || [])[1];
    const imgH = +(/pixelHeight:\s*(\d+)/.exec(info) || [])[1];
    const pts = await screenSizePoints();
    lastShot = { imgW, imgH, ptW: pts.w, ptH: pts.h };
    const data = (await fsp.readFile(small)).toString('base64');
    return { data, imgW, imgH };
  } catch (e) {
    throw new Error(`Screenshot failed: ${e.message}\nIf the image is empty or fails, allow Screen Recording for Enide: System Settings → Privacy & Security → Screen Recording.`);
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
    fsp.rm(small, { force: true }).catch(() => {});
  }
}

// Screenshot pixel coordinates → screen points.
function toPoints(x, y) {
  if (!lastShot || !lastShot.imgW) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round((x * lastShot.ptW) / lastShot.imgW), y: Math.round((y * lastShot.ptH) / lastShot.imgH) };
}

function mouseScript(kind, p, p2, clicks = 1) {
  // CGEvent types: 1 LDown 2 LUp 3 RDown 4 RUp 5 Moved 6 LDragged; buttons: 0 left 1 right; tap 0 = HID
  return `ObjC.import('CoreGraphics');
function ev(t, x, y, b, n) { var e = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(x, y), b); if (n) $.CGEventSetIntegerValueField(e, 1, n); $.CGEventPost(0, e); }
function sleep(ms) { var s = Date.now(); while (Date.now() - s < ms) {} }
var x=${p.x}, y=${p.y};
${kind === 'move' ? 'ev(5, x, y, 0);' : ''}
${kind === 'click' ? 'ev(5, x, y, 0); sleep(30); ev(1, x, y, 0, 1); sleep(30); ev(2, x, y, 0, 1);' : ''}
${kind === 'double_click' ? 'ev(5, x, y, 0); sleep(30); ev(1, x, y, 0, 1); ev(2, x, y, 0, 1); sleep(60); ev(1, x, y, 0, 2); ev(2, x, y, 0, 2);' : ''}
${kind === 'right_click' ? 'ev(5, x, y, 0); sleep(30); ev(3, x, y, 1, 1); sleep(30); ev(4, x, y, 1, 1);' : ''}
${kind === 'drag' && p2 ? `ev(5, x, y, 0); sleep(40); ev(1, x, y, 0, 1); var steps = 18; for (var i = 1; i <= steps; i++) { ev(6, x + (${p2.x} - x) * i / steps, y + (${p2.y} - y) * i / steps, 0); sleep(12); } ev(2, ${p2.x}, ${p2.y}, 0, 1);` : ''}
'ok';`;
}

function scrollScript(dx, dy) {
  return `ObjC.import('CoreGraphics');
var e = null;
try { e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, ${-dy}, ${-dx}, 0); } catch (err) {}
if (!e) { e = $.CGEventCreateScrollWheelEvent(null, 1, 2, ${-dy}, ${-dx}); }
$.CGEventPost(0, e); 'ok';`;
}

const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, forwarddelete: 117,
  left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MODS = { cmd: 'command down', command: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', opt: 'option down', shift: 'shift down', fn: 'function down' };

function asStr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

async function pressKeys(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods = parts.filter((p) => MODS[p]).map((p) => MODS[p]);
  const key = parts.filter((p) => !MODS[p]).pop();
  if (!key) throw new Error(`No key in "${combo}"`);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const action = KEYCODES[key] != null ? `key code ${KEYCODES[key]}${using}` : `keystroke ${asStr(key)}${using}`;
  await applescript(`tell application "System Events" to ${action}`);
}

async function typeText(text) {
  const s = String(text);
  if (/^[\x20-\x7e\n\t]*$/.test(s) && s.length <= 400) {
    const lines = s.split('\n');
    const steps = lines.map((l, i) => (l ? `keystroke ${asStr(l)}` : '') + (i < lines.length - 1 ? '\nkey code 36' : '')).filter(Boolean).join('\n');
    await applescript(`tell application "System Events"\n${steps}\nend tell`);
    return;
  }
  // Unicode or long text: paste through the clipboard, then restore it.
  const prev = await run('/usr/bin/pbpaste', []).catch(() => '');
  await new Promise((res, rej) => { const c = execFile('/usr/bin/pbcopy', [], (e) => (e ? rej(e) : res())); c.stdin.end(s); });
  await applescript('tell application "System Events" to keystroke "v" using {command down}');
  await new Promise((r) => setTimeout(r, 250));
  await new Promise((res) => { const c = execFile('/usr/bin/pbcopy', [], () => res()); c.stdin.end(prev); });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function act(a, { autoScreenshot = true } = {}) {
  if (process.platform !== 'darwin') throw new Error('Computer use is available on macOS only.');
  const action = a.action;
  const need = (k) => { if (a[k] == null) throw new Error(`"${k}" is required for ${action}`); };
  let note = '';
  try {
    switch (action) {
      case 'screenshot': break;
      case 'click': case 'double_click': case 'right_click': case 'move': {
        need('x'); need('y');
        const p = toPoints(a.x, a.y);
        await jxa(mouseScript(action, p));
        note = `${action} at (${a.x}, ${a.y})`;
        break;
      }
      case 'drag': {
        need('x'); need('y'); need('x2'); need('y2');
        await jxa(mouseScript('drag', toPoints(a.x, a.y), toPoints(a.x2, a.y2)));
        note = `dragged (${a.x}, ${a.y}) → (${a.x2}, ${a.y2})`;
        break;
      }
      case 'scroll': {
        if (a.x != null && a.y != null) await jxa(mouseScript('move', toPoints(a.x, a.y)));
        const amt = parseInt(a.amount || 5, 10);
        const dir = a.direction || 'down';
        const dy = dir === 'down' ? amt : dir === 'up' ? -amt : 0;
        const dx = dir === 'right' ? amt : dir === 'left' ? -amt : 0;
        await jxa(scrollScript(dx, dy));
        note = `scrolled ${dir} ${amt}`;
        break;
      }
      case 'type': need('text'); await typeText(a.text); note = `typed ${String(a.text).length} chars`; break;
      case 'key': need('keys'); await pressKeys(a.keys); note = `pressed ${a.keys}`; break;
      case 'open_app': need('app'); await run('/usr/bin/open', ['-a', String(a.app)]); note = `opened ${a.app}`; await wait(1200); break;
      case 'open_url': need('url'); await run('/usr/bin/open', [String(a.url)]); note = `opened ${a.url}`; await wait(1500); break;
      case 'wait': await wait(Math.min(parseInt(a.ms || 1000, 10), 30000)); note = 'waited'; break;
      case 'cursor_position': {
        const out = await jxa(`ObjC.import('AppKit'); var p = $.NSEvent.mouseLocation; var h = $.NSScreen.mainScreen.frame.size.height; JSON.stringify({x: p.x, y: h - p.y});`);
        const pt = JSON.parse(out);
        const sx = lastShot ? lastShot.imgW / lastShot.ptW : 1;
        return { output: `Cursor at (${Math.round(pt.x * sx)}, ${Math.round(pt.y * sx)}) in screenshot pixels.` };
      }
      default: throw new Error(`Unknown action: ${action}`);
    }
  } catch (e) {
    throw new Error(permissionHint(e));
  }
  if (action === 'screenshot' || autoScreenshot) {
    if (action !== 'screenshot') await wait(450);
    const s = await screenshot();
    return { output: `${note ? note + '. ' : ''}Screenshot ${s.imgW}×${s.imgH} px (coordinates for the next action use this image).`, images: [{ mediaType: 'image/png', data: s.data }], display: { kind: 'computer', action, note, w: s.imgW, h: s.imgH } };
  }
  return { output: note, display: { kind: 'computer', action, note } };
}

module.exports = { act, screenshot, toPoints };
