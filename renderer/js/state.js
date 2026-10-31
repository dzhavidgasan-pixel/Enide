// Global app state + a tiny event bus.
const listeners = new Map();
export function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
}
export function emit(ev, ...args) {
  const set = listeners.get(ev);
  if (set) for (const fn of [...set]) { try { fn(...args); } catch (e) { console.error(ev, e); } }
}

export const state = {
  info: null,          // app:info
  settings: null,      // full settings
  keyHints: {},
  root: null,          // workspace folder
  gitStatus: null,
  activeFile: null,
  mode: 'agent',
  modelRef: null,      // { providerId, modelId }
  reasoning: { enabled: true, effort: 'medium' },
};

export function allModels() {
  const out = [];
  for (const p of (state.settings && state.settings.providers) || []) {
    if (p.enabled === false) continue;
    for (const m of p.models || []) {
      if (m.enabled === false) continue;
      out.push({ provider: p, model: m, ref: { providerId: p.id, modelId: m.id } });
    }
  }
  return out;
}

export function currentModel() {
  const ref = state.modelRef || (state.settings && state.settings.defaultModel);
  const all = allModels();
  return all.find((x) => ref && x.ref.providerId === ref.providerId && x.ref.modelId === ref.modelId) || all[0] || null;
}
