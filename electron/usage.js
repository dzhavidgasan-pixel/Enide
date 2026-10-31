'use strict';
// Token usage and cost. Every model request is appended to usage.jsonl in Enide's data
// folder; prices come from each model's settings (USD per 1M tokens).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class UsageStore {
  constructor(dir, getSettings) { this.file = path.join(dir, 'usage.jsonl'); this.getSettings = getSettings; }

  record({ providerId, provider, model, kind, usage, chatId }) {
    const u = usage || {};
    const row = { t: Date.now(), p: providerId, pn: provider, m: model, k: kind || 'agent', i: u.input || 0, o: u.output || 0, c: u.cacheRead || 0, w: u.cacheWrite || 0, r: u.reasoning || 0, chat: chatId || undefined };
    row.usd = this.cost(row);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFile(this.file, JSON.stringify(row) + '\n', () => {});
    return row;
  }

  price(providerId, modelId) {
    const p = (this.getSettings().providers || []).find((x) => x.id === providerId);
    const m = p && (p.models || []).find((x) => x.id === modelId);
    return m && m.price ? m.price : null;
  }

  cost(row) {
    const pr = this.price(row.p, row.m);
    if (!pr) return null;
    const input = (pr.input || 0) * row.i, cache = (pr.cacheRead != null ? pr.cacheRead : pr.input || 0) * row.c, out = (pr.output || 0) * row.o;
    const write = (pr.cacheWrite != null ? pr.cacheWrite : (pr.input || 0) * 1.25) * (row.w || 0); // Anthropic cache writes cost 1.25× input
    return (input + cache + write + out) / 1e6;
  }

  async rows(sinceMs) {
    let text = '';
    try { text = await fsp.readFile(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.t >= sinceMs) out.push(r); } catch {}
    }
    return out;
  }

  async summary(days = 30) {
    const since = Date.now() - days * 86400000;
    const rows = await this.rows(since);
    const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
    const byDay = new Map(), byModel = new Map(), byKind = new Map();
    const today = dayKey(Date.now());
    const totals = { today: z(), week: z(), month: z() };
    for (const r of rows) {
      const usd = r.usd != null ? r.usd : this.cost(r);
      const add = (o) => { o.input += r.i + (r.w || 0); o.output += r.o; o.cache += r.c; o.requests++; if (usd != null) { o.usd += usd; o.priced = true; } };
      const d = dayKey(r.t);
      if (!byDay.has(d)) byDay.set(d, z());
      add(byDay.get(d));
      const mk = `${r.pn || r.p} · ${r.m}`;
      if (!byModel.has(mk)) byModel.set(mk, { ...z(), providerId: r.p, model: r.m });
      add(byModel.get(mk));
      if (!byKind.has(r.k)) byKind.set(r.k, z());
      add(byKind.get(r.k));
      if (d === today) add(totals.today);
      if (r.t >= Date.now() - 7 * 86400000) add(totals.week);
      add(totals.month);
    }
    const daysList = [];
    for (let i = days - 1; i >= 0; i--) { const d = dayKey(Date.now() - i * 86400000); daysList.push({ day: d, ...(byDay.get(d) || z()) }); }
    return { totals, days: daysList, models: [...byModel.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.input + b.output - a.input - a.output), kinds: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })) };
  }

  async clear() { await fsp.rm(this.file, { force: true }); }
}

function z() { return { input: 0, output: 0, cache: 0, requests: 0, usd: 0, priced: false }; }

module.exports = { UsageStore };
