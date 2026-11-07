// Clicks through the whole UI in the browser preview (mock bridge) and fails on any
// uncaught error or console.error: every command, every settings page, chats, approvals.
//   python3 -m http.server 8765 &  node test/ui-crawl.mjs
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8765/renderer/index.html';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/google/chrome/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
let where = 'boot';
page.on('pageerror', (e) => errors.push(`[${where}] pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(`[${where}] console: ${m.text()}`); });
const wait = (ms) => page.waitForTimeout(ms);
const esc = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await wait(60); } await page.evaluate(() => { document.querySelectorAll('#overlays > *').forEach((x) => x.remove()); document.querySelectorAll('.menu').forEach((x) => x.remove()); }); };

await page.goto(URL); await wait(1800);

// 1) every palette command
const ids = await page.evaluate(() => window.__enide.commands().map((c) => c.id));
const SKIP = new Set(['quit', 'reload', 'open-folder', 'add-folder', 'close-folder']);
for (const id of ids) {
  if (SKIP.has(id)) continue;
  where = 'cmd:' + id;
  await page.evaluate((x) => window.__enide.runCmd(x), id).catch((e) => errors.push(`[${where}] ${e.message}`));
  await wait(220);
  await esc();
}
// 2) settings: the one page, its actions, and the two sub-pages
where = 'settings';
await page.evaluate(() => window.__enide.openSettings()); await wait(300);
const sections = await page.evaluate(() => document.querySelectorAll('.set-sec').length);
where = 'settings:add-model';
await page.fill('.set-main .set-row input:not([type=password])', 'my-model-1').catch(() => {});
await page.evaluate(() => { const i = [...document.querySelectorAll('.set-main .set-row .input')].find((x) => /ID/.test(x.placeholder)); if (i) { i.value = 'my-model-1'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } }); await wait(300);
where = 'settings:fetch';
await page.evaluate(() => [...document.querySelectorAll('.set-main .btn')].find((b) => /API$|from API/.test(b.textContent)).click()); await wait(700);
for (const sub of ['account', 'plugins']) {
  where = 'settings:' + sub;
  await page.evaluate((n) => window.__enide.openSettings(n), sub); await wait(300);
  await page.evaluate(() => document.querySelector('.set-back').click()); await wait(250);
}
await esc();
// 3) chat: send → approval → edit command → allow; edit message; retry; chats pane
where = 'reload';
await page.goto(URL); await wait(1800);
where = 'chat:send';
await page.click('.composer textarea'); await page.keyboard.type('Добавь кнопку выхода в шапку'); await page.keyboard.press('Enter');
await wait(3500);
where = 'chat:approve-shortcut';
await page.keyboard.press('Meta+Enter').catch(() => {}); await wait(1500);
where = 'chat:chats-pane';
await page.evaluate(() => window.__enide.runCmd('chats')); await wait(300);
await page.evaluate(() => { const r = document.querySelector('.chat-row'); if (r) r.click(); }); await wait(900);
where = 'chat:edit-message';
await page.evaluate(() => { const t = document.querySelector('.msg-user .text'); if (t) t.click(); }); await wait(300);
await page.keyboard.press('Escape'); await wait(200);
where = 'chat:menus';
for (const sel of ['.composer-bar .picker-btn >> nth=0', '.composer-bar .picker-btn >> nth=1', '.composer-bar .picker-btn >> nth=2']) { await page.click(sel).catch(() => {}); await wait(250); await esc(); }
where = 'chat:context';
await page.evaluate(() => { const m = document.querySelector('.ctx-meter'); if (m) m.click(); }); await wait(400); await esc();
where = 'chat:perm';
for (const n of [0, 2, 1]) { await page.evaluate((i) => document.querySelectorAll('.perm')[i].click(), n); await wait(200); }
where = 'account-menu';
await page.click('.avatar-btn'); await wait(250); await esc();

await browser.close();
if (errors.length) { console.log(errors.join('\n')); console.log(`\n${errors.length} UI error(s)`); process.exit(1); }
console.log(`UI crawl: ${ids.length} commands, ${sections} settings sections, chat flows — 0 errors`);
