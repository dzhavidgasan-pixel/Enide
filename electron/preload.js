'use strict';
// The only bridge between the UI and the system. Channels are whitelisted.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:info', 'app:set-dirty', 'app:open-external', 'app:reveal', 'app:open-path', 'app:pick-images', 'app:read-image', 'app:pick-files', 'app:capture-screen',
  'auth:status', 'auth:register', 'auth:login', 'auth:recover', 'auth:logout', 'auth:update', 'auth:change-password', 'auth:change-word', 'auth:delete',
  'settings:get', 'settings:set', 'secrets:set', 'providers:new', 'providers:models', 'providers:test', 'providers:catalog', 'icons:get', 'icons:clear', 'icons:refresh',
  'ws:pick-folder', 'ws:open', 'ws:close', 'ws:root', 'ws:readdir', 'ws:read', 'ws:write', 'ws:create-file', 'ws:create-dir',
  'ws:rename', 'ws:delete', 'ws:list-files', 'ws:search', 'ws:replace', 'ws:folder-summary', 'ws:exists', 'ws:describe-file',
  'term:create', 'term:kill',
  'git:status', 'git:diff', 'git:stage', 'git:unstage', 'git:discard', 'git:commit', 'git:branches', 'git:checkout', 'git:push', 'git:pull', 'git:fetch', 'git:init', 'git:log',
  'chat:list', 'chat:get', 'chat:new', 'chat:rename', 'chat:delete',
  'agent:send', 'agent:stop', 'agent:approve', 'agent:checkpoints', 'agent:restore', 'agent:preview', 'agent:turn-changes',
  'rules:list', 'slash:list',
  'ai:inline', 'ai:complete', 'ai:cancel', 'ai:commit-message', 'ai:terminal-command', 'ai:transcribe',
  'mcp:status', 'mcp:restart', 'mcp:import',
  'plugins:status', 'plugins:install', 'plugins:remove', 'plugins:scaffold', 'plugins:reload', 'plugins:commands', 'plugins:run-command', 'plugins:dir', 'plugins:pick-folder',
  'requestlog:list', 'requestlog:get', 'requestlog:clear',
  'agent:active', 'agent:compact', 'agent:context', 'chat:pin', 'chat:search', 'chat:fork',
  'wt:status', 'wt:apply', 'wt:discard', 'wt:diff', 'ws:extra-roots', 'ws:add-folder', 'ws:remove-folder', 'ws:read-many',
  'lint:run', 'review:run', 'ai:next-edit', 'index:status', 'index:build', 'index:remove', 'index:search',
  'docs:list', 'docs:add', 'docs:reindex', 'docs:remove', 'memory:get', 'memory:save', 'hooks:list',
  'usage:summary', 'usage:clear', 'themes:list', 'themes:load', 'themes:pick-file', 'keys:import',
  'automations:run-now', 'automations:pick-folder', 'browser:show', 'update:check',
]);
const SEND = new Set(['term:write', 'term:resize']);
const EVENTS = new Set(['agent:event', 'ai:event', 'term:data', 'term:exit', 'ws:changed', 'ws:file-changed', 'mcp:changed', 'plugins:changed', 'requestlog:entry', 'menu', 'settings:changed', 'index:progress', 'docs:progress', 'usage:entry', 'chat:updated']);

// On Windows the renderer works with forward-slash paths (C:/Users/…); Node accepts both.
const WIN = process.platform === 'win32';
const WIN_PATH = /^[A-Za-z]:\\[^\n\r]*$/;
function norm(v, depth = 0) {
  if (!WIN || depth > 8 || v == null) return v;
  if (typeof v === 'string') return v.length < 2048 && WIN_PATH.test(v) ? v.replace(/\\/g, '/') : v;
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { const o = {}; for (const k of Object.keys(v)) o[k] = norm(v[k], depth + 1); return o; }
  return v;
}

contextBridge.exposeInMainWorld('enide', {
  platform: process.platform,
  async invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Blocked channel ${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (r && r.ok === false) { const e = new Error(r.error); e.code = r.code; e.field = r.field; throw e; }
    return r ? norm(r.data) : undefined;
  },
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`Blocked event ${channel}`);
    const fn = (_e, ...args) => cb(...args.map((a) => norm(a)));
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  pathForFile(file) { try { return norm(webUtils.getPathForFile(file)); } catch { return ''; } },
});
