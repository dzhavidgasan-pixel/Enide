'use strict';
// @Docs: crawl a documentation site (same origin + path prefix), store text chunks
// locally and search them with BM25. Used by the docs_search tool and @Docs mentions.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { htmlToText, tokenize, STOP } = require('../agent/tools');

function newId() { return 'docs_' + crypto.randomBytes(5).toString('hex'); }

function extractLinks(html, base) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try { const u = new URL(m[1], base); u.hash = ''; out.add(u.toString()); } catch {}
  }
  return [...out];
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

function mainHtml(html) {
  const m = /<main[\s\S]*?<\/main>/i.exec(html) || /<article[\s\S]*?<\/article>/i.exec(html);
  return m ? m[0] : html.replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<header[\s\S]*?<\/header>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '');
}

class DocsStore {
  constructor({ dir, fetchImpl, onProgress }) {
    this.dir = dir;
    this.fetchImpl = fetchImpl || fetch;
    this.onProgress = onProgress || (() => {});
    this.cache = new Map();
    this.jobs = new Map();
  }

  metaFile() { return path.join(this.dir, 'index.json'); }
  async list() {
    try { return JSON.parse(await fsp.readFile(this.metaFile(), 'utf8')); } catch { return []; }
  }
  async saveList(list) { await fsp.mkdir(this.dir, { recursive: true }); await fsp.writeFile(this.metaFile(), JSON.stringify(list, null, 2)); }
  names() { return this._names || []; }
  async refreshNames() { this._names = (await this.list()).filter((d) => d.status === 'ready').map((d) => d.name); return this._names; }

  async add({ name, url, maxPages = 60 }) {
    const start = new URL(url);
    const list = await this.list();
    const entry = { id: newId(), name: name || start.hostname, url: start.toString(), maxPages, status: 'crawling', pages: 0, created: Date.now() };
    list.push(entry);
    await this.saveList(list);
    this.crawl(entry).catch(() => {});
    return entry;
  }

  async reindex(id) {
    const list = await this.list();
    const e = list.find((x) => x.id === id);
    if (!e) throw new Error('Unknown docs');
    e.status = 'crawling';
    await this.saveList(list);
    this.crawl(e).catch(() => {});
    return e;
  }

  async remove(id) {
    const list = (await this.list()).filter((x) => x.id !== id);
    await this.saveList(list);
    this.cache.delete(id);
    await fsp.rm(path.join(this.dir, id + '.json'), { force: true });
    await this.refreshNames();
  }

  async crawl(entry) {
    const start = new URL(entry.url);
    const prefix = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '');
    const queue = [start.toString()];
    const seen = new Set(queue);
    const pages = [];
    const update = async (patch) => {
      const list = await this.list();
      const e = list.find((x) => x.id === entry.id);
      if (e) { Object.assign(e, patch); await this.saveList(list); this.onProgress(e); }
    };
    try {
      while (queue.length && pages.length < entry.maxPages) {
        const batch = queue.splice(0, 4);
        await Promise.all(batch.map(async (u) => {
          let res;
          try { res = await this.fetchImpl(u, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Enide-Docs/0.1', accept: 'text/html,text/plain;q=0.9' } }); } catch { return; }
          if (!res.ok) return;
          const ctype = res.headers.get('content-type') || '';
          if (!/html|text\/plain|markdown/.test(ctype)) return;
          const html = await res.text();
          const text = /html/.test(ctype) ? htmlToText(mainHtml(html)) : html;
          if (text.trim().length > 80) pages.push({ url: u, title: titleOf(html) || u, text });
          if (/html/.test(ctype)) {
            for (const l of extractLinks(html, u)) {
              let lu; try { lu = new URL(l); } catch { continue; }
              if (lu.origin !== start.origin || !lu.pathname.startsWith(prefix) || /\.(png|jpe?g|gif|svg|css|js|zip|pdf|ico|woff2?)$/i.test(lu.pathname)) continue;
              lu.search = '';
              const s = lu.toString();
              if (!seen.has(s)) { seen.add(s); queue.push(s); }
            }
          }
        }));
        await update({ pages: pages.length, status: 'crawling' });
      }
      const chunks = [];
      for (const p of pages) {
        const paras = p.text.split(/\n{2,}/);
        let buf = '';
        for (const para of paras) {
          if ((buf + '\n\n' + para).length > 1500 && buf) { chunks.push({ url: p.url, title: p.title, text: buf.trim() }); buf = ''; }
          buf += (buf ? '\n\n' : '') + para;
        }
        if (buf.trim()) chunks.push({ url: p.url, title: p.title, text: buf.trim() });
      }
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(path.join(this.dir, entry.id + '.json'), JSON.stringify({ chunks }));
      this.cache.delete(entry.id);
      await update({ status: pages.length ? 'ready' : 'error', error: pages.length ? null : 'No pages could be read', pages: pages.length, chunks: chunks.length, updated: Date.now() });
    } catch (e) {
      await update({ status: 'error', error: e.message });
    }
    await this.refreshNames();
  }

  async chunks(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try { const j = JSON.parse(await fsp.readFile(path.join(this.dir, id + '.json'), 'utf8')); this.cache.set(id, j.chunks); return j.chunks; } catch { return []; }
  }

  async search(query, name, k = 6) {
    const list = (await this.list()).filter((d) => d.status === 'ready' && (!name || d.name.toLowerCase() === String(name).toLowerCase()));
    if (!list.length) return name ? `No docs set named "${name}".` : 'No documentation sets are indexed yet.';
    const terms = tokenize(query).filter((t) => !STOP.has(t));
    const all = [];
    for (const d of list) for (const c of await this.chunks(d.id)) all.push({ ...c, docs: d.name });
    const df = new Map();
    const tfs = all.map((c) => {
      const toks = tokenize(c.title + ' ' + c.text);
      const tf = new Map();
      for (const t of toks) if (terms.includes(t)) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      return { tf, len: toks.length };
    });
    const N = all.length || 1;
    const avg = tfs.reduce((a, x) => a + x.len, 0) / N || 1;
    const scored = all.map((c, i) => {
      let s = 0;
      for (const [t, f] of tfs[i].tf) { const n = df.get(t) || 0; s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * tfs[i].len / avg)); }
      return { c, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
    if (!scored.length) return 'No relevant passages found.';
    return scored.map(({ c }) => `── ${c.docs} · ${c.title}\n${c.url}\n${c.text}`).join('\n\n');
  }
}

module.exports = { DocsStore };
