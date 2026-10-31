'use strict';
// Built-in browser the agent can drive: open your localhost app, read the page, click,
// type, read console errors and take screenshots. It is a normal visible window, so
// you can watch (and use) it too. Separate cookie jar from your own browser.
const { BrowserWindow } = require('electron');

const DEF = {
  name: 'browser',
  description: 'Control Enide\'s built-in browser window to check web pages and local apps (e.g. http://localhost:3000). Actions: navigate {url}; snapshot (page title, URL, visible text and a numbered list of interactive elements like [e12] button "Save"); screenshot; click {ref | selector | x,y}; type {ref | selector, text, submit?}; press {key, e.g. "Enter", "Tab", "Escape"}; scroll {dy}; evaluate {script} (JavaScript expression, result returned); console (recent console messages and errors); back; reload; wait {ms | selector}. Use snapshot after navigating to get element refs.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['navigate', 'snapshot', 'screenshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'console', 'back', 'reload', 'wait', 'close'] },
      url: { type: 'string' }, ref: { type: 'string', description: 'Element ref from snapshot, e.g. "e12"' }, selector: { type: 'string', description: 'CSS selector' },
      x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' }, key: { type: 'string' },
      dy: { type: 'number' }, script: { type: 'string' }, ms: { type: 'number' },
    },
    required: ['action'],
  },
};

const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],summary,[onclick]';
  let n = 0; const items = [];
  document.querySelectorAll('[data-enide-ref]').forEach((e) => e.removeAttribute('data-enide-ref'));
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 250) continue;
    const ref = 'e' + (++n); el.setAttribute('data-enide-ref', ref);
    const tag = el.tagName.toLowerCase(); const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'input') : tag);
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    items.push('[' + ref + '] ' + role + (name ? ' "' + name + '"' : '') + (tag === 'a' && el.getAttribute('href') ? ' -> ' + el.getAttribute('href').slice(0, 80) : '') + (el.disabled ? ' (disabled)' : ''));
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 9000);
  return { title: document.title, url: location.href, items, text };
})()`;

class AgentBrowser {
  constructor({ getSettings }) {
    this.getSettings = getSettings;
    this.win = null;
    this.logs = [];
  }

  enabled() { const a = (this.getSettings().agent || {}); return a.browser !== false; }

  list(mode) { return this.enabled() ? [{ ...DEF, source: 'browser', readOnly: true }] : []; }
  find(name) { return name === 'browser' && this.enabled() ? { source: 'browser', autoApprove: false } : null; }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const show = (this.getSettings().agent || {}).browserVisible !== false;
    this.win = new BrowserWindow({
      width: 1280, height: 860, show, title: 'Enide Browser', backgroundColor: '#ffffff',
      webPreferences: { partition: 'persist:enide-agent-browser', sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.logs = [];
    this.win.webContents.on('console-message', (...args) => {
      // Electron ≥ 35 passes an event object; older versions pass (event, level, message, line, sourceId)
      const e = args[0];
      const level = e && e.level != null ? e.level : args[1];
      const message = e && e.message != null ? e.message : args[2];
      const src = e && e.sourceId != null ? `${e.sourceId}:${e.lineNumber}` : `${args[4]}:${args[3]}`;
      this.logs.push({ level: typeof level === 'number' ? ['debug', 'info', 'warning', 'error'][level] || level : level, message: String(message).slice(0, 2000), src, time: Date.now() });
      if (this.logs.length > 300) this.logs.shift();
    });
    this.win.webContents.on('did-fail-load', (_e, code, desc, url) => this.logs.push({ level: 'error', message: `Failed to load ${url}: ${desc} (${code})`, time: Date.now() }));
    this.win.webContents.setWindowOpenHandler(({ url }) => { this.win.loadURL(url); return { action: 'deny' }; });
    this.win.on('closed', () => { this.win = null; });
    return this.win;
  }

  show() { const w = this.ensure(); w.show(); w.focus(); }

  async waitIdle(ms = 8000) {
    const wc = this.win.webContents;
    if (!wc.isLoading()) return;
    await new Promise((res) => { const t = setTimeout(res, ms); wc.once('did-stop-loading', () => { clearTimeout(t); res(); }); });
  }

  async shot() {
    const img = await this.win.webContents.capturePage();
    const size = img.getSize();
    const scaled = size.width > 1280 ? img.resize({ width: 1280 }) : img;
    return { mediaType: 'image/png', data: scaled.toPNG().toString('base64'), w: scaled.getSize().width, h: scaled.getSize().height };
  }

  async center(a) {
    const js = a.ref ? `document.querySelector('[data-enide-ref="${String(a.ref).replace(/[^\w-]/g, '')}"]')` : `document.querySelector(${JSON.stringify(a.selector)})`;
    const r = await this.win.webContents.executeJavaScript(`(() => { const el = ${js}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!r) throw new Error(`Element not found: ${a.ref || a.selector}. Take a new snapshot.`);
    return r;
  }

  async call(_name, a, ctx) {
    const act = a.action;
    if (act === 'close') { if (this.win) this.win.close(); return { output: 'Browser closed.' }; }
    const w = this.ensure();
    const wc = w.webContents;
    const vision = ctx && ctx.vision;
    switch (act) {
      case 'navigate': {
        let url = String(a.url || '').trim();
        if (!/^[a-z]+:/i.test(url)) url = (/^(localhost|127\.|0\.0\.0\.0)/.test(url) ? 'http://' : 'https://') + url;
        this.logs = [];
        try { await wc.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(e.message)) return { output: `Navigation failed: ${e.message}`, isError: true }; }
        await this.waitIdle();
        const snap = await wc.executeJavaScript(SNAPSHOT_JS);
        const errors = this.logs.filter((l) => l.level === 'error').length;
        return { output: `Loaded ${snap.url} — "${snap.title}"${errors ? ` · ${errors} console error(s), see action=console` : ''}\n\nInteractive elements:\n${snap.items.slice(0, 120).join('\n')}\n\nText:\n${snap.text.slice(0, 4000)}`, display: { kind: 'browser', url: snap.url, title: snap.title } };
      }
      case 'snapshot': {
        const snap = await wc.executeJavaScript(SNAPSHOT_JS);
        return { output: `${snap.title}\n${snap.url}\n\nInteractive elements:\n${snap.items.join('\n')}\n\nText:\n${snap.text}`, display: { kind: 'browser', url: snap.url, title: snap.title } };
      }
      case 'screenshot': {
        const s = await this.shot();
        return { output: `Screenshot of ${wc.getURL()} (${s.w}×${s.h}).`, images: vision !== false ? [s] : [], display: { kind: 'browser', url: wc.getURL() } };
      }
      case 'click': {
        const p = a.x != null && a.y != null ? { x: a.x, y: a.y } : await this.center(a);
        const x = Math.round(p.x), y = Math.round(p.y);
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 400));
        await this.waitIdle(5000);
        return { output: `Clicked ${a.ref || a.selector || `(${x}, ${y})`}. Now at ${wc.getURL()}. Take a snapshot to see the result.` };
      }
      case 'type': {
        if (a.ref || a.selector) {
          const p = await this.center(a);
          wc.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
          await wc.executeJavaScript(`(() => { const el = document.activeElement; if (el && 'value' in el) { el.select && el.select(); } })()`);
        }
        await wc.insertText(String(a.text || ''));
        if (a.submit) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await new Promise((r) => setTimeout(r, 500)); await this.waitIdle(5000); }
        return { output: `Typed ${String(a.text || '').length} chars${a.submit ? ' and pressed Enter' : ''}.` };
      }
      case 'press': {
        const map = { enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', arrowdown: 'Down', arrowup: 'Up', arrowleft: 'Left', arrowright: 'Right', space: 'Space', pagedown: 'PageDown', pageup: 'PageUp' };
        const k = map[String(a.key || '').toLowerCase()] || a.key;
        wc.sendInputEvent({ type: 'keyDown', keyCode: k });
        if (k === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: k });
        await new Promise((r) => setTimeout(r, 300));
        return { output: `Pressed ${k}.` };
      }
      case 'scroll': {
        await wc.executeJavaScript(`window.scrollBy(0, ${Number(a.dy) || 600})`);
        return { output: `Scrolled by ${Number(a.dy) || 600}px.` };
      }
      case 'evaluate': {
        const v = await wc.executeJavaScript(String(a.script || 'undefined'), true);
        let s; try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
        return { output: String(s).slice(0, 30000) };
      }
      case 'console': {
        const list = this.logs.slice(-100).map((l) => `[${l.level}] ${l.message}${l.src ? ` (${l.src})` : ''}`);
        return { output: list.length ? list.join('\n') : 'No console messages.' };
      }
      case 'back': wc.goBack(); await this.waitIdle(); return { output: `Back to ${wc.getURL()}` };
      case 'reload': this.logs = []; wc.reload(); await this.waitIdle(); return { output: `Reloaded ${wc.getURL()}` };
      case 'wait': {
        if (a.selector) {
          const ok = await wc.executeJavaScript(`new Promise((res) => { const t0 = Date.now(); const f = () => { if (document.querySelector(${JSON.stringify(a.selector)})) res(true); else if (Date.now() - t0 > ${Math.min(Number(a.ms) || 10000, 30000)}) res(false); else setTimeout(f, 150); }; f(); })`);
          return { output: ok ? `Found ${a.selector}.` : `Timed out waiting for ${a.selector}.`, isError: !ok };
        }
        await new Promise((r) => setTimeout(r, Math.min(Number(a.ms) || 1000, 30000)));
        return { output: 'Waited.' };
      }
      default: throw new Error(`Unknown browser action: ${act}`);
    }
  }

  close() { if (this.win && !this.win.isDestroyed()) this.win.close(); }
}

module.exports = { AgentBrowser, BROWSER_TOOL: DEF };
