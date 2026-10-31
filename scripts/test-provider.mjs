#!/usr/bin/env node
// Send one real request through Enide's provider code and print exactly what happened.
//
//   node scripts/test-provider.mjs --key YOUR_KEY
//   node scripts/test-provider.mjs --preset zai-anthropic --model glm-5.2 --think --key YOUR_KEY
//   node scripts/test-provider.mjs --preset openai --model gpt-5 --key sk-...
//   node scripts/test-provider.mjs --preset custom-openai --base https://host/v1 --model my-model --key ...
//   ENIDE_KEY=... node scripts/test-provider.mjs --agent      (also runs a tiny tool-calling round)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { providerFromPreset, testConnection, listModels, PRESETS } = require('../electron/agent/providers.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
if (opt('help')) {
  console.log('Presets:\n' + PRESETS.map((p) => `  ${p.preset.padEnd(18)} ${p.protocol.padEnd(17)} ${p.baseUrl}`).join('\n'));
  process.exit(0);
}
const preset = opt('preset', 'zai-anthropic');
const key = opt('key', process.env.ENIDE_KEY || '');
const provider = providerFromPreset(preset, 'cli');
if (opt('base')) provider.baseUrl = opt('base');
const model = opt('model', (provider.models[0] || {}).id || 'glm-5.2');
const think = !!opt('think');

console.log(`\n→ ${provider.name} · ${provider.protocol} · ${provider.baseUrl}\n→ model ${model}${think ? ' · reasoning on' : ''}\n`);
if (!key && provider.authStyle !== 'none') console.log('! no key: pass --key or set ENIDE_KEY\n');

if (opt('list')) {
  try { const ms = await listModels({ provider, apiKey: key }); console.log('models:', ms.map((m) => m.id).join(', ')); }
  catch (e) { console.log('list models failed:', e.message); }
}

const r = await testConnection({ provider, apiKey: key, model, reasoning: { enabled: think, effort: 'low' } });
console.log('request:', JSON.stringify(r.request, null, 2));
if (r.ok) {
  console.log(`\n✓ OK in ${r.ms} ms (first token ${r.firstTokenMs} ms)`);
  if (r.reasoning) console.log('✦ reasoning:', r.reasoning.slice(0, 600));
  console.log('→ text:', JSON.stringify(r.text));
  console.log('usage:', r.usage);
} else {
  console.log(`\n✗ FAILED after ${r.ms} ms\n${r.error}`);
  process.exitCode = 1;
}

if (opt('agent') && r.ok) {
  const { AgentRunner } = require('../electron/agent/agent.js');
  const { ChatStore } = require('../electron/agent/chats.js');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enide-cli-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'The secret word is: lighthouse\n');
  let done;
  const finished = new Promise((res) => { done = res; });
  const runner = new AgentRunner({
    getSettings: () => ({ providers: [provider], agent: { maxSteps: 6 } }), getApiKey: async () => key,
    chats: new ChatStore(path.join(dir, '.chats')), checkpoints: null, toolHost: null,
    emit: (_id, ev) => {
      if (ev.type === 'tool_call') console.log(`  🔧 ${ev.call.name} ${JSON.stringify(ev.call.args)}`);
      if (ev.type === 'text_delta') process.stdout.write(ev.text);
      if (ev.type === 'error') console.log('\n✗', ev.message);
      if (ev.type === 'done') done();
    },
  });
  console.log('\n— agent round (read_file tool) —');
  await runner.start({ text: 'Read note.txt and tell me the secret word.', mode: 'ask', root: dir, modelRef: { providerId: 'cli', modelId: model }, reasoning: { enabled: think, effort: 'low' } });
  await finished;
  console.log('\n');
}
