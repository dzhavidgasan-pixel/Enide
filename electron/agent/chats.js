'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function newId(prefix) { return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

class ChatStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.writeQueue = new Map();
  }
  file(id) { return path.join(this.dir, String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'); }

  async list(root) {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const id = n.slice(0, -5);
        const c = this.cache.get(id) || JSON.parse(await fsp.readFile(path.join(this.dir, n), 'utf8'));
        if (root !== undefined && (c.root || null) !== (root || null)) continue;
        out.push({ id: c.id, title: c.title, created: c.created, updated: c.updated, root: c.root, count: (c.messages || []).length, pinned: !!c.pinned, worktree: c.worktree ? c.worktree.branch : null, automation: c.automation || null, forkOf: c.forkOf || null });
      } catch {}
    }
    return out.sort((a, b) => (b.pinned - a.pinned) || b.updated - a.updated);
  }

  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const c = JSON.parse(await fsp.readFile(this.file(id), 'utf8'));
      this.cache.set(id, c);
      return c;
    } catch { return null; }
  }

  async create({ title, root } = {}) {
    const c = { id: newId('chat'), title: title || '', created: Date.now(), updated: Date.now(), root: root || null, messages: [] };
    this.cache.set(c.id, c);
    await this.save(c);
    return c;
  }

  async save(chat) {
    chat.updated = Date.now();
    this.cache.set(chat.id, chat);
    await fsp.mkdir(this.dir, { recursive: true });
    // serialize writes per chat
    const prev = this.writeQueue.get(chat.id) || Promise.resolve();
    const next = prev.then(() => fsp.writeFile(this.file(chat.id) + '.tmp', JSON.stringify(chat)))
      .then(() => fsp.rename(this.file(chat.id) + '.tmp', this.file(chat.id)))
      .catch(() => {});
    this.writeQueue.set(chat.id, next);
    return next;
  }

  async rename(id, title) {
    const c = await this.get(id);
    if (!c) return null;
    c.title = title;
    await this.save(c);
    return c;
  }

  async remove(id) {
    this.cache.delete(id);
    await fsp.rm(this.file(id), { force: true }).catch(() => {});
  }

  async pin(id, pinned) {
    const c = await this.get(id);
    if (!c) return null;
    c.pinned = !!pinned;
    const prev = c.updated;
    await this.save(c);
    c.updated = prev;
    return c;
  }

  // Full-text search across every chat (titles, your messages and the agent's answers).
  async search(query, root) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const list = await this.list(root);
    const out = [];
    for (const meta of list) {
      const c = await this.get(meta.id);
      if (!c) continue;
      let hit = null;
      if ((c.title || '').toLowerCase().includes(q)) hit = { snippet: c.title, messageId: null };
      for (const m of c.messages || []) {
        if (hit) break;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        for (const b of m.content || []) {
          if (b.type !== 'text' || !b.text || b.attachment) continue;
          const i = b.text.toLowerCase().indexOf(q);
          if (i >= 0) { hit = { snippet: (i > 40 ? '…' : '') + b.text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' '), messageId: m.id, role: m.role }; break; }
        }
      }
      if (hit) out.push({ id: c.id, title: c.title, updated: c.updated, ...hit });
      if (out.length >= 50) break;
    }
    return out;
  }

  // New chat with the history up to a message. inclusive=false: stop before it (edit & branch).
  async fork(id, messageId, { inclusive = true } = {}) {
    const c = await this.get(id);
    if (!c) throw new Error('Chat not found');
    let idx = messageId ? c.messages.findIndex((m) => m.id === messageId) : c.messages.length - 1;
    if (idx < 0) idx = c.messages.length - 1;
    let end = inclusive ? idx + 1 : idx;
    if (inclusive) { while (end < c.messages.length && c.messages[end].role !== 'user') end++; }
    const copy = JSON.parse(JSON.stringify(c.messages.slice(0, end)));
    const f = await this.create({ title: `↳ ${c.title || 'Chat'}`, root: c.root });
    f.messages = copy;
    f.forkOf = { chatId: c.id, messageId };
    f.lastModel = c.lastModel;
    if (c.compaction && copy.some((m) => m.id === c.compaction.untilId)) f.compaction = { ...c.compaction };
    await this.save(f);
    const prefill = !inclusive && c.messages[idx] ? (c.messages[idx].content || []).filter((b) => b.type === 'text' && !b.attachment).map((b) => b.text).join('\n') : '';
    return { chat: f, prefill };
  }

  // Remove the message `messageId` and everything after it. Returns removed messages.
  async truncate(id, messageId) {
    const c = await this.get(id);
    if (!c) return [];
    const idx = c.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return [];
    const removed = c.messages.splice(idx);
    await this.save(c);
    return removed;
  }
}

module.exports = { ChatStore, newId };
