'use strict';
// Vendor icons: the real favicon / touch icon each vendor publishes on its own site.
// Fetched once from the vendor's domain, cached on disk as a data URL, never redrawn.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const TTL = 30 * 24 * 3600 * 1000;

class VendorIcons {
  constructor({ dir, fetchImpl, vendors }) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.vendors = vendors;
    this.pending = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(key) { return path.join(this.dir, key.replace(/[^a-z0-9_-]/gi, '_') + '.json'); }

  async get(key) {
    const v = this.vendors[key];
    if (!v) return null;
    const f = this.file(key);
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c.dataUrl && Date.now() - c.at < TTL) return c.dataUrl;
      if (!c.dataUrl && Date.now() - c.at < 6 * 3600 * 1000) return null; // recent miss: don't hammer
    } catch {}
    if (!this.pending.has(key)) {
      this.pending.set(key, this.load(v.domain).then((dataUrl) => {
        try { fs.writeFileSync(f, JSON.stringify({ at: Date.now(), dataUrl })); } catch {}
        return dataUrl;
      }).catch(() => null).finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }

  async load(domain) {
    const origin = `https://${domain}`;
    const candidates = [];
    try {
      const res = await this.timed(origin + '/', { headers: { accept: 'text/html' } });
      if (res.ok) {
        const html = (await res.text()).slice(0, 400000);
        for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
          const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
          const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
          if (!href || !/icon/i.test(rel)) continue;
          const sizes = +((tag.match(/\bsizes\s*=\s*["'](\d+)/i) || [])[1] || 0);
          const score = (/apple-touch/i.test(rel) ? 180 : sizes || 32) + (/\.svg(\?|$)/i.test(href) ? 120 : 0) - (sizes > 512 ? 400 : 0);
          try { candidates.push({ url: new URL(href.replace(/&amp;/g, '&'), res.url || origin).href, score }); } catch {}
        }
      }
    } catch {}
    candidates.sort((a, b) => b.score - a.score);
    candidates.push({ url: origin + '/apple-touch-icon.png' }, { url: origin + '/favicon.ico' },
      // Public favicon mirrors of the same site icon, for sites that block plain fetches.
      { url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` },
      { url: `https://icons.duckduckgo.com/ip3/${domain}.ico` });
    for (const c of candidates) {
      const d = await this.image(c.url).catch(() => null);
      if (d) return d;
    }
    return null;
  }

  async image(url) {
    if (url.startsWith('data:image/')) return url.length < MAX_BYTES * 1.4 ? url : null;
    const res = await this.timed(url, {});
    if (!res.ok) return null;
    let type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    if (!/^image\//.test(type)) type = sniff(buf);
    if (!type) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  }

  async timed(url, opts) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try { return await this.fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
  }

  clear() { for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true }); }
}

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1) return 'image/x-icon';
  if (b.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (/<svg/i.test(b.slice(0, 500).toString())) return 'image/svg+xml';
  return null;
}

module.exports = { VendorIcons };
