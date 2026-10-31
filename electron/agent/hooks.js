'use strict';
// Hooks: your own shell commands that run around agent actions. Same format as Claude
// Code hooks, so existing .claude/settings.json hooks work unchanged:
//
// { "hooks": { "PostToolUse": [ { "matcher": "edit_file|write_file", "hooks": [ { "type": "command", "command": "npx prettier --write \"$ENIDE_FILE\"" } ] } ] } }
//
// Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
// The hook gets a JSON payload on stdin. Exit code 2 = block / send stderr back to the agent.
// Stdout JSON {"decision":"block","reason":"…"} or {"hookSpecificOutput":{"permissionDecision":"allow"|"deny"|"ask"}} is also understood.
const { spawn } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

// Claude Code tool names → Enide tool names, so matchers written for Claude Code match here too.
const ALIASES = {
  run_command: ['Bash'], edit_file: ['Edit', 'MultiEdit'], write_file: ['Write'], read_file: ['Read'],
  glob: ['Glob'], grep: ['Grep'], list_dir: ['LS'], web_fetch: ['WebFetch'], web_search: ['WebSearch'],
  todo_write: ['TodoWrite'], task: ['Task'], delete_file: [],
};

function stripJsonc(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}

async function readHooksFile(file) {
  try {
    const j = JSON.parse(stripJsonc(await fsp.readFile(file, 'utf8')));
    return j && j.hooks ? j.hooks : null;
  } catch { return null; }
}

// Collect hook groups from settings + project files. Returns [{ source, event, matcher, hooks: [{command, timeout}] }].
async function loadHooks(settings, root) {
  const sources = [];
  const h = settings && settings.hooks;
  if (h && h.enabled !== false && h.config && h.config.hooks) sources.push({ source: 'settings', hooks: h.config.hooks });
  if (root && !(h && h.enabled === false)) {
    const p1 = await readHooksFile(path.join(root, '.enide', 'hooks.json'));
    if (p1) sources.push({ source: '.enide/hooks.json', hooks: p1 });
    if (!(h && h.importClaude === false)) {
      for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
        const p2 = await readHooksFile(path.join(root, f));
        if (p2) sources.push({ source: f, hooks: p2 });
      }
    }
  }
  const out = [];
  for (const s of sources) {
    for (const ev of EVENTS) {
      for (const group of s.hooks[ev] || []) {
        const hooks = (group.hooks || []).filter((x) => x && (x.type === 'command' || !x.type) && x.command);
        if (hooks.length) out.push({ source: s.source, event: ev, matcher: group.matcher || '', hooks });
      }
    }
  }
  return out;
}

function matches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  const names = [toolName, ...(ALIASES[toolName] || [])];
  if (toolName.startsWith('mcp__')) names.push(toolName);
  let re;
  try { re = new RegExp(`^(?:${matcher})$`); } catch { return names.includes(matcher); }
  return names.some((n) => re.test(n));
}

function runOne(command, payload, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const [file, args] = require('../lib/shell').shellCommand(command);
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); resolve({ code: code == null ? -1 : code, stdout, stderr }); });
    try { child.stdin.end(JSON.stringify(payload)); } catch {}
  });
}

// Run every hook matching (event, toolName). Returns an aggregate decision:
// { block: bool, reason, permission: 'allow'|'deny'|'ask'|null, feedback: [text], context: [text], ran: [...] }
async function runHooks(groups, event, { toolName, payload, root, chatId, signal, onRun }) {
  const res = { block: false, reason: '', permission: null, feedback: [], context: [], ran: [] };
  const relevant = groups.filter((g) => g.event === event && (event === 'UserPromptSubmit' || event === 'Stop' || matches(g.matcher, toolName || '')));
  for (const g of relevant) {
    for (const hk of g.hooks) {
      const input = { hook_event_name: event, session_id: chatId || '', cwd: root || process.cwd(), ...(payload || {}) };
      const env = {
        ENIDE_PROJECT_DIR: root || '', CLAUDE_PROJECT_DIR: root || '', ENIDE_HOOK_EVENT: event, ENIDE_TOOL: toolName || '',
        ENIDE_FILE: (payload && payload.tool_input && (payload.tool_input.path || payload.tool_input.file_path)) ? path.resolve(root || process.cwd(), payload.tool_input.path || payload.tool_input.file_path) : '',
        ENIDE_COMMAND: (payload && payload.tool_input && payload.tool_input.command) || '',
      };
      const t0 = Date.now();
      const r = await runOne(hk.command, input, { cwd: root || process.cwd(), env, timeoutMs: Math.max(1, hk.timeout || 60) * 1000, signal });
      const entry = { source: g.source, event, command: hk.command, code: r.code, ms: Date.now() - t0, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 4000) };
      res.ran.push(entry);
      if (onRun) onRun(entry);
      let json = null;
      const so = r.stdout.trim();
      if (so.startsWith('{')) { try { json = JSON.parse(so); } catch {} }
      if (json) {
        const hso = json.hookSpecificOutput || {};
        if (hso.permissionDecision) res.permission = hso.permissionDecision;
        if (json.decision === 'block' || json.decision === 'deny') { res.block = true; res.reason = json.reason || hso.permissionDecisionReason || 'Blocked by hook'; }
        if (json.decision === 'approve' || json.decision === 'allow') res.permission = 'allow';
        if (hso.permissionDecision === 'deny') { res.block = true; res.reason = hso.permissionDecisionReason || json.reason || 'Denied by hook'; }
        if (hso.additionalContext) res.context.push(String(hso.additionalContext));
        if (json.reason && !res.block) res.feedback.push(String(json.reason));
      } else if (r.code === 0 && so && event === 'UserPromptSubmit') {
        res.context.push(so);
      }
      if (r.code === 2) {
        const msg = r.stderr.trim() || r.stdout.trim() || 'Blocked by hook';
        if (event === 'PostToolUse') res.feedback.push(msg);
        else { res.block = true; res.reason = msg; }
      }
    }
  }
  return res;
}

module.exports = { loadHooks, runHooks, matches, EVENTS, stripJsonc };
