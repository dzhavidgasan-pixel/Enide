'use strict';
// Semantic code index: chunks of the workspace embedded with YOUR provider
// (OpenAI-compatible /embeddings — OpenAI, OpenRouter, Ollama, LM Studio… — or Gemini).
// Stored locally in Enide's data folder; nothing is uploaded anywhere else.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { walkFiles, isBinaryFile, toPosix } = require('../lib/fsutil');
const { joinUrl, readErrorBody, netErr } = require('../agent/sse');
const { authHeaders, withQuery } = require('../agent/util');

const CHUNK = 60;
const OVERLAP = 12;
const SKIP = /\.(lock|min\.js|map|svg|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|mp[34]|mov|wasm|bin|exe|dylib|so|class|jar)$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i;

function hashRoot(root) { return crypto.createHash('sha1').update(root).digest('hex').slice(0, 16); }
function f32ToB64(arr) { return Buffer.from(new Float32Array(arr).buffer).toString('base64'); }
function b64ToF32(s) { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); }
function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }

class SemanticIndex {
  constructor({ dir, getSettings, getApiKey, fetchImpl, onProgress, logRequest, recordUsage }) {
    Object.assign(this, { dir, getSettings, getApiKey, fetchImpl: fetchImpl || fetch, onProgress: onProgress || (() => {}), logRequest, recordUsage });
    this.cache = new Map();
    this.building = new Map();
  }

  file(root) { return path.join(this.dir, hashRoot(root) + '.json'); }

  config() {
    const s = this.getSettings();
    const ix = s.index || {};
    const p = (s.providers || []).find((x) => x.id === ix.providerId);
    return { ix, provider: p, model: ix.model || (p && p.protocol === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small') };
  }

  async load(root) {
    if (this.cache.has(root)) return this.cache.get(root);
    try {
      const j = JSON.parse(await fsp.readFile(this.file(root), 'utf8'));
      this.cache.set(root, j);
      return j;
    } catch { return null; }
  }

  async status(root) {
    if (!root) return { state: 'none' };
    if (this.building.has(root)) return { state: 'building', ...this.building.get(root).progress };
    const j = await this.load(root);
    if (!j) return { state: 'none' };
    const files = Object.keys(j.files).length;
    const chunks = Object.values(j.files).reduce((a, f) => a + f.chunks.length, 0);
    return { state: 'ready', files, chunks, model: j.model, updated: j.updated };
  }

  async embed(texts, signal) {
    const { provider: p, model } = this.config();
    if (!p) throw new Error('Choose an embeddings provider in Settings → Index (OpenAI-compatible or Gemini).');
    if (p.protocol === 'anthropic') throw new Error('Anthropic APIs have no embeddings endpoint. Pick an OpenAI-compatible (OpenAI, OpenRouter, Ollama…) or Gemini provider for the index.');
    const key = await this.getApiKey(p.id);
    const headers = { 'content-type': 'application/json', ...authHeaders(p, key), ...(p.headers || {}) };
    let url, body;
    if (p.protocol === 'gemini') {
      url = withQuery(joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`), p.query);
      body = { requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] } })) };
    } else {
      url = withQuery(joinUrl(p.baseUrl, '/embeddings'), p.query);
      body = { model, input: texts };
    }
    const id = this.logRequest ? this.logRequest({ kind: 'embeddings', url, method: 'POST', headers: {}, body: { ...body, input: `<${texts.length} chunks>`, requests: undefined }, provider: p.name, model }) : null;
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(netErr(url));
    if (this.logRequest && id) this.logRequest({ id, status: res.status });
    if (!res.ok) throw await readErrorBody(res);
    const j = await res.json();
    const vecs = p.protocol === 'gemini' ? (j.embeddings || []).map((e) => e.values) : (j.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding);
    if (vecs.length !== texts.length) throw new Error(`Embeddings API returned ${vecs.length} vectors for ${texts.length} inputs`);
    if (this.recordUsage && j.usage) this.recordUsage({ providerId: p.id, provider: p.name, model, kind: 'embeddings', usage: { input: j.usage.prompt_tokens || j.usage.total_tokens || 0, output: 0 } });
    return vecs.map(normalize);
  }

  // Incremental: only changed files are re-embedded.
  async build(root, { signal, full } = {}) {
    if (this.building.has(root)) return this.building.get(root).promise;
    const state = { progress: { done: 0, total: 0, phase: 'scan' } };
    const run = async () => {
      const { model } = this.config();
      const prev = full ? null : await this.load(root);
      const idx = { root, model, updated: Date.now(), files: {} };
      const pending = [];
      const maxFiles = (this.config().ix.maxFiles) || 6000;
      for await (const f of walkFiles(root, { maxFiles, signal })) {
        if (SKIP.test(f)) continue;
        let st; try { st = await fsp.stat(f); } catch { continue; }
        if (st.size > 300000 || st.size === 0) continue;
        const rel = toPosix(path.relative(root, f));
        const old = prev && prev.model === model && prev.files[rel];
        if (old && old.mtime === st.mtimeMs && old.size === st.size) { idx.files[rel] = old; continue; }
        if (await isBinaryFile(f)) continue;
        let text; try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        const chunks = [];
        for (let i = 0; i < lines.length; i += CHUNK - OVERLAP) {
          const body = lines.slice(i, i + CHUNK).join('\n');
          if (body.trim().length < 20) continue;
          chunks.push({ start: i + 1, end: Math.min(lines.length, i + CHUNK), text: `${rel}\n${body}`.slice(0, 6000) });
          if (i + CHUNK >= lines.length) break;
        }
        idx.files[rel] = { mtime: st.mtimeMs, size: st.size, chunks: [] };
        for (const c of chunks) pending.push({ rel, c });
      }
      state.progress = { done: 0, total: pending.length, phase: 'embed' };
      this.onProgress(root, { state: 'building', ...state.progress });
      const B = 64;
      for (let i = 0; i < pending.length; i += B) {
        if (signal && signal.aborted) throw new Error('Indexing cancelled');
        const batch = pending.slice(i, i + B);
        const vecs = await this.embed(batch.map((x) => x.c.text), signal);
        batch.forEach((x, k) => idx.files[x.rel].chunks.push({ start: x.c.start, end: x.c.end, v: f32ToB64(vecs[k]) }));
        state.progress.done = Math.min(pending.length, i + B);
        this.onProgress(root, { state: 'building', ...state.progress });
      }
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(this.file(root), JSON.stringify(idx));
      this.cache.set(root, idx);
      return idx;
    };
    state.promise = run().finally(() => { this.building.delete(root); this.status(root).then((s) => this.onProgress(root, s)); });
    this.building.set(root, state);
    return state.promise;
  }

  async search(root, query, k = 8) {
    const idx = await this.load(root);
    if (!idx) return null;
    const [q] = await this.embed([query]);
    const scored = [];
    for (const [rel, f] of Object.entries(idx.files)) {
      for (const c of f.chunks) {
        const v = b64ToF32(c.v);
        let dot = 0;
        for (let i = 0; i < v.length && i < q.length; i++) dot += v[i] * q[i];
        scored.push({ rel, start: c.start, end: c.end, score: dot });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    for (const s of scored.slice(0, k)) {
      let body = '';
      try { body = (await fsp.readFile(path.join(root, s.rel), 'utf8')).split('\n').slice(s.start - 1, s.end).join('\n'); } catch { continue; }
      const numbered = body.split('\n').slice(0, 45).map((l, i) => `${String(s.start + i).padStart(5)}│${l}`).join('\n');
      out.push(`── ${s.rel}:${s.start}-${s.end} (score ${s.score.toFixed(3)})\n${numbered}`);
    }
    return out.length ? out.join('\n\n') : 'No results.';
  }

  async remove(root) { this.cache.delete(root); await fsp.rm(this.file(root), { force: true }); }
}

module.exports = { SemanticIndex };
