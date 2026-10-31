'use strict';
// File checkpoints: before the agent first touches a file during a user turn, the
// original bytes are saved. Restoring a turn rolls every touched file back.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_BYTES = 20 * 1024 * 1024;

class Checkpoint {
  constructor(store, chatId, turnId) {
    this.store = store;
    this.chatId = chatId;
    this.turnId = turnId;
    this.files = new Map();
    this.created = Date.now();
  }
  // Continue an existing checkpoint for the same turn (e.g. resume after an error).
  async init() {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(this.store.dir, safe(this.chatId), safe(this.turnId) + '.json'), 'utf8'));
      for (const [k, v] of Object.entries(j.files || {})) this.files.set(k, v);
      this.created = j.created || this.created;
    } catch {}
    return this;
  }
  async record(abs) {
    if (this.files.has(abs)) return;
    let entry;
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) { entry = { existed: true, dir: true }; }
      else if (st.size > MAX_BYTES) entry = { existed: true, skipped: true };
      else entry = { existed: true, data: (await fsp.readFile(abs)).toString('base64') };
    } catch {
      entry = { existed: false };
    }
    this.files.set(abs, entry);
    await this.save();
  }
  toJSON() {
    return { chatId: this.chatId, turnId: this.turnId, created: this.created, files: Object.fromEntries(this.files) };
  }
  async save() {
    const dir = path.join(this.store.dir, safe(this.chatId));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, safe(this.turnId) + '.json'), JSON.stringify(this.toJSON()));
  }
}

function safe(s) { return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_'); }

class CheckpointStore {
  constructor(dir) { this.dir = dir; }
  begin(chatId, turnId) { return new Checkpoint(this, chatId, turnId); }

  async list(chatId) {
    const dir = path.join(this.dir, safe(chatId));
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))); } catch {}
    }
    return out.sort((a, b) => a.created - b.created);
  }

  // Undo every change made in `turnIds` (newest first). Returns the restored paths.
  async restore(chatId, turnIds) {
    const all = await this.list(chatId);
    const wanted = all.filter((c) => turnIds.includes(c.turnId)).sort((a, b) => b.created - a.created);
    const restored = [];
    for (const cp of wanted) {
      for (const [abs, e] of Object.entries(cp.files)) {
        try {
          if (e.dir || e.skipped) continue;
          if (e.existed) {
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, Buffer.from(e.data, 'base64'));
          } else {
            await fsp.rm(abs, { force: true });
          }
          restored.push(abs);
        } catch {}
      }
      try { await fsp.rm(path.join(this.dir, safe(chatId), safe(cp.turnId) + '.json'), { force: true }); } catch {}
    }
    return [...new Set(restored)];
  }

  async get(chatId, turnId) {
    try { return JSON.parse(await fsp.readFile(path.join(this.dir, safe(chatId), safe(turnId) + '.json'), 'utf8')); } catch { return null; }
  }

  async summary(chatId) {
    const all = await this.list(chatId);
    return all.map((c) => ({ turnId: c.turnId, files: Object.keys(c.files) }));
  }

  async removeChat(chatId) {
    await fsp.rm(path.join(this.dir, safe(chatId)), { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { CheckpointStore };
