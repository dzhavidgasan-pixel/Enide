'use strict';
// Scheduled agent runs ("every weekday at 9:00, run the tests and fix failures").
// They run while Enide is open; results land in chat history with a notification.

function due(a, now = new Date()) {
  if (!a.enabled || !a.prompt || !a.folder) return false;
  const last = a.lastRun || 0;
  const s = a.schedule || {};
  if (s.type === 'interval') {
    const ms = Math.max(5, Number(s.minutes) || 60) * 60000;
    return now.getTime() - last >= ms;
  }
  // daily at HH:MM on chosen weekdays (0 = Sunday)
  const [hh, mm] = String(s.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(now.getDay())) return false;
  const slot = new Date(now); slot.setHours(hh, mm, 0, 0);
  return now >= slot && last < slot.getTime() && now.getTime() - slot.getTime() < 6 * 3600000;
}

class Scheduler {
  constructor({ getSettings, saveAutomation, runAutomation }) {
    Object.assign(this, { getSettings, saveAutomation, runAutomation });
    this.timer = null;
    this.running = new Set();
  }
  start() { this.stop(); this.timer = setInterval(() => this.tick(), 30000); setTimeout(() => this.tick(), 5000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick() {
    for (const a of this.getSettings().automations || []) {
      if (this.running.has(a.id) || !due(a)) continue;
      this.fire(a);
    }
  }
  async fire(a) {
    this.running.add(a.id);
    this.saveAutomation(a.id, { lastRun: Date.now(), lastStatus: 'running' });
    try { await this.runAutomation(a); }
    finally { this.running.delete(a.id); }
  }
}

module.exports = { Scheduler, due };
