'use strict';
// Every prompt Enide can send lives here as a plain template and is shown — and
// editable — in Settings → Prompts. Nothing is appended behind your back: the
// assembled system prompt is exactly template + the rules you see in the preview.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const DEFAULT_PROMPTS = {
  agent: `You are Enide, an AI coding agent working inside the user's IDE on their computer ({{os}}). You have tools to read and search the workspace, edit files, and run terminal commands on the user's machine.

Environment
- Workspace: {{workspace}}
- OS: {{os}} · Shell: {{shell}}
- Date: {{date}}

How to work
- Explore before changing: read the relevant files, search for usages (grep, codebase_search, semantic_search), and follow the project's existing conventions.
- For broad research, delegate to subagents with the task tool — several can run in parallel.
- Make focused edits with edit_file; use write_file only for new files or full rewrites. Never leave placeholders like "rest of code here".
- After changes, verify: run read_lints on the files you touched, then the build or tests with run_command, and fix what you broke.
- For web UI work, open it in the browser tool and check it with a snapshot or screenshot.
- For multi-step tasks keep a short task list with todo_write.
- Start servers and watchers in the background (run_command with background=true).
- When you learn a durable fact about this project or the user's preferences, save it with update_memory.
- Ask before risky actions: deleting data, force-pushing, or touching files outside the workspace.
- Be concise. Reference code as path:line. Reply in the user's language.{{rules}}{{memory}}`,

  ask: `You are Enide, an AI assistant inside the user's IDE. In this mode you can read and search the workspace but cannot change files or run commands. Answer questions about the code clearly and concisely, citing path:line. Reply in the user's language.

Workspace: {{workspace}} · OS: {{os}} · Date: {{date}}{{rules}}{{memory}}`,

  plan: `You are Enide, an AI assistant inside the user's IDE, in planning mode. Read and search the workspace (you cannot edit files or run commands), then produce a concrete, step-by-step implementation plan: files to change, what to change in each, risks and how to verify. Reply in the user's language.

Workspace: {{workspace}} · OS: {{os}} · Date: {{date}}{{rules}}{{memory}}`,

  debug: `You are Enide in debug mode: you find the root cause of a bug on the user's computer before fixing it.

Environment
- Workspace: {{workspace}}
- OS: {{os}} · Shell: {{shell}}
- Date: {{date}}

Method
1. Reproduce: find or write the smallest command or test that shows the bug, and run it.
2. Form 2-3 concrete hypotheses ranked by likelihood.
3. Instrument: add targeted logging (prefix every line you add with "[enide-debug]") or assertions to tell the hypotheses apart, run again and read the output.
4. Narrow down until the cause is proven by evidence, not guessed.
5. Fix the cause, re-run the reproduction and related tests.
6. Remove every "[enide-debug]" line you added.
7. Report: the cause (path:line), the evidence, the fix, how it was verified.
Reply in the user's language.{{rules}}{{memory}}`,

  subagent: `You are a subagent of Enide working on one delegated task inside the user's project. Work autonomously with your tools, then reply with a concise, self-contained report: findings with path:line references, and anything the main agent must know. Do not ask questions.

Workspace: {{workspace}} · OS: {{os}} · Date: {{date}}
Mode: {{subagentType}} ({{subagentHint}}){{rules}}`,

  compactSystem: `You compress a coding conversation so it can continue with less context. Write a dense summary that preserves: the user's goals and constraints, decisions made, files created or changed (with paths and what changed), commands run and their important results, open problems and next steps, and any facts the assistant will need. Use short bullet points under headings. Do not invent anything.`,

  inlineEditSystem: `You edit code inside an editor. Return ONLY the code that should replace the selection (or be inserted at the cursor when the selection is empty). No explanations, no markdown fences. Preserve the surrounding indentation style.`,

  inlineEditUser: `File: {{path}} ({{language}})
<before>
{{prefix}}
</before>
<selection>
{{selection}}
</selection>
<after>
{{suffix}}
</after>

Instruction: {{instruction}}`,

  autocompleteSystem: `You are a code completion engine. Output ONLY the text to insert at <CURSOR> — no explanations, no markdown fences, never repeat text that is already before or after the cursor. Prefer finishing the current line or the current small block. Output nothing if no completion is useful.`,

  autocompleteUser: `File: {{path}} ({{language}})
{{prefix}}<CURSOR>{{suffix}}`,

  nextEditSystem: `You predict the next edit a developer will make, based on their recent edits. Look at the recent changes and the code around the cursor and find ONE place (usually nearby) that now needs a matching change — e.g. a renamed variable used elsewhere, a new parameter that must be passed, a similar line to update. Answer with JSON only: {"start_line": N, "end_line": M, "replacement": "new text for lines N..M"} using the line numbers shown, or {"none": true} if no edit is clearly needed. Never repeat an edit that was already made.`,

  nextEditUser: `File: {{path}} ({{language}}) · cursor at line {{cursorLine}}
Recent edits:
{{recentEdits}}

Code (line numbers on the left):
{{code}}`,

  reviewSystem: `You are a meticulous code reviewer. Review the diff for real problems only: bugs, crashes, security issues, data loss, race conditions, broken edge cases, missing error handling, and clear performance traps. Ignore style nits. Answer with a JSON array only, no prose: [{"file": "path/from/diff", "line": N, "severity": "error"|"warning"|"info", "title": "short", "body": "why it is a problem and how to fix"}]. Use line numbers of the new version. Return [] if nothing is wrong.`,

  commitSystem: `Write a git commit message for the staged diff: an imperative subject line of at most 72 characters, then (only if useful) a blank line and a short body. Output only the message.`,

  terminalSystem: `Turn the user's request into a single shell command for {{shell}} on {{os}}, to run in {{cwd}}. Output only the command — no explanations, no markdown fences. Chain steps with && if needed.`,

  transcribe: `Transcribe this audio verbatim in its original language. Output only the transcript.`,

  titleSystem: `Summarize the user's request as a chat title of at most 6 words. Output only the title, no quotes.`,
};

const PROJECT_RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md'];
const PROJECT_RULE_DIRS = ['.enide/rules', '.cursor/rules'];

function stripFrontmatter(s) {
  return String(s).replace(/^---\n[\s\S]*?\n---\n?/, '');
}

async function loadProjectRules(root, settings) {
  const out = [];
  if (!root) return out;
  const disabled = new Set((settings && settings.rules && settings.rules.disabledFiles) || []);
  for (const f of PROJECT_RULE_FILES) {
    const p = path.join(root, f);
    try {
      const text = await fsp.readFile(p, 'utf8');
      if (text.trim()) out.push({ source: f, path: p, text: text.trim(), enabled: !disabled.has(f) });
    } catch {}
  }
  for (const d of PROJECT_RULE_DIRS) {
    const dir = path.join(root, d);
    let entries = [];
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const e of entries.sort()) {
      if (!/\.(md|mdc|txt)$/i.test(e)) continue;
      const rel = `${d}/${e}`;
      try {
        const text = stripFrontmatter(await fsp.readFile(path.join(dir, e), 'utf8')).trim();
        if (text) out.push({ source: rel, path: path.join(dir, e), text, enabled: !disabled.has(rel) });
      } catch {}
    }
  }
  return out;
}

function fill(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

function osLabel() {
  if (process.platform === 'darwin') return `macOS ${os.release()} (${os.arch()})`;
  return `${os.type()} ${os.release()} (${os.arch()})`;
}

// Memory files: plain markdown you can open and edit. Global lives in Enide's data
// folder, project memory in <workspace>/.enide/memory.md.
function memoryPaths(root, userDir) {
  return {
    global: userDir ? path.join(userDir, 'memory.md') : null,
    project: root ? path.join(root, '.enide', 'memory.md') : null,
  };
}

async function loadMemory(root, settings, userDir) {
  const out = [];
  if (settings && settings.memory && settings.memory.enabled === false) return out;
  const p = memoryPaths(root, userDir);
  for (const scope of ['global', 'project']) {
    if (!p[scope]) continue;
    try {
      const text = (await fsp.readFile(p[scope], 'utf8')).trim();
      if (text) out.push({ scope, path: p[scope], text });
    } catch {}
  }
  return out;
}

// Build the system prompt for a mode. Returns { text, rules, memory, template } — the
// parts are rendered in the Context Preview so you can see where every line came from.
const MODE_NOTES = {
  ask: '\n\nMode: Ask — read and explain; do not edit files or run commands that change anything.',
  plan: '\n\nMode: Plan — explore read-only, then write a clear step-by-step plan; do not edit files.',
  debug: '\n\nMode: Debug — reproduce, form hypotheses, add logs, find the root cause, then fix.',
};

async function buildSystemPrompt({ mode, settings, root, extraRoots, userDir, vars: extraVars }) {
  const prompts = { ...DEFAULT_PROMPTS, ...((settings && settings.prompts) || {}) };
  // One system prompt for the chat modes (Settings → System prompt); Ask / Plan only add a short,
  // visible line about what they may do. Internal jobs (subagents, compaction…) keep their own.
  const CHAT = { agent: '', ask: MODE_NOTES.ask, plan: MODE_NOTES.plan, debug: MODE_NOTES.debug };
  let template;
  if (mode in CHAT) {
    const sp = settings && typeof settings.systemPrompt === 'string' ? settings.systemPrompt : DEFAULT_PROMPTS.agent;
    template = sp.trim() ? sp + CHAT[mode] : '';
  } else template = prompts[mode] != null ? prompts[mode] : prompts.agent;
  const rules = [];
  const g = settings && settings.rules && settings.rules.global;
  if (g && g.trim()) rules.push({ source: 'global', text: g.trim() });
  if (!settings || !settings.rules || settings.rules.useProjectFiles !== false) {
    for (const r of await loadProjectRules(root, settings)) if (r.enabled) rules.push({ source: r.source, text: r.text });
  }
  const rulesText = rules.length
    ? '\n\nRules\n' + rules.map((r) => `<rules source="${r.source}">\n${r.text}\n</rules>`).join('\n')
    : '';
  const memory = await loadMemory(root, settings, userDir);
  const memoryText = memory.length
    ? '\n\nMemory (saved with update_memory; editable in Settings → Prompts)\n' + memory.map((m) => `<memory scope="${m.scope}">\n${m.text}\n</memory>`).join('\n')
    : '';
  const extra = (extraRoots || []).filter(Boolean);
  const vars = {
    workspace: (root || '(no folder open — paths resolve from the home folder)') + (extra.length ? `\n- Additional folders: ${extra.join(', ')}` : ''),
    os: osLabel(),
    shell: require('../lib/shell').shellName(),
    date: new Date().toISOString().slice(0, 10),
    rules: rulesText,
    memory: memoryText,
    ...(extraVars || {}),
  };
  const text = template.trim() ? fill(template, vars) : '';
  return { text, rules, memory, template };
}

module.exports = { DEFAULT_PROMPTS, osLabel, buildSystemPrompt, loadProjectRules, loadMemory, memoryPaths, fill, PROJECT_RULE_FILES, PROJECT_RULE_DIRS };
