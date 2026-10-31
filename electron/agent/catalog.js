'use strict';
// Built-in model catalog (checked October 2026) so you pick models instead of typing IDs.
// Prices are USD per 1M tokens (input / output / cached input) where the vendor publishes them.
// "Fetch from API" in Settings always adds anything newer the provider offers.

const VENDORS = {
  anthropic: { name: 'Anthropic', domain: 'anthropic.com' },
  openai: { name: 'OpenAI', domain: 'openai.com' },
  google: { name: 'Google', domain: 'gemini.google.com' },
  moonshot: { name: 'Moonshot · Kimi', domain: 'kimi.com' },
  zai: { name: 'Z.ai · GLM', domain: 'z.ai' },
  deepseek: { name: 'DeepSeek', domain: 'deepseek.com' },
  qwen: { name: 'Qwen', domain: 'qwen.ai' },
  xai: { name: 'xAI · Grok', domain: 'x.ai' },
  mistral: { name: 'Mistral', domain: 'mistral.ai' },
  minimax: { name: 'MiniMax', domain: 'minimax.io' },
  xiaomi: { name: 'Xiaomi MiMo', domain: 'mi.com' },
  meta: { name: 'Meta', domain: 'meta.ai' },
  tencent: { name: 'Tencent Hunyuan', domain: 'hunyuan.tencent.com' },
  openrouter: { name: 'OpenRouter', domain: 'openrouter.ai' },
  groq: { name: 'Groq', domain: 'groq.com' },
  together: { name: 'Together AI', domain: 'together.ai' },
  fireworks: { name: 'Fireworks', domain: 'fireworks.ai' },
  ollama: { name: 'Ollama', domain: 'ollama.com' },
  lmstudio: { name: 'LM Studio', domain: 'lmstudio.ai' },
  azure: { name: 'Azure', domain: 'azure.microsoft.com' },
  litellm: { name: 'LiteLLM', domain: 'litellm.ai' },
};

const M = (vendor, id, name, o = {}) => ({ vendor, id, name, ...o });
const K = 1000;

// r = reasoning style hint per protocol family: a = anthropic, o = openai-compatible
const MODELS = [
  // ---------- Anthropic ----------
  M('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', { ctx: 1000 * K, out: 128 * K, vision: true, price: [10, 50, 1], r: { a: 'anthropic-adaptive', o: 'openrouter' }, or: 'anthropic/claude-fable-5.1' }),
  M('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', { ctx: 1000 * K, out: 128 * K, vision: true, price: [4, 20, 0.4], r: { a: 'anthropic-adaptive', o: 'openrouter' }, or: 'anthropic/claude-opus-5.5' }),
  M('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', { ctx: 1000 * K, out: 128 * K, vision: true, price: [2, 10, 0.2], r: { a: 'anthropic-adaptive', o: 'openrouter' }, or: 'anthropic/claude-sonnet-5.5' }),
  M('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', { ctx: 1000 * K, out: 128 * K, vision: true, price: [0.1, 0.5, 0.01], r: { a: 'anthropic-adaptive', o: 'openrouter' }, or: 'anthropic/claude-haiku-5.5' }),
  M('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', { ctx: 200 * K, out: 64 * K, vision: true, legacy: true, r: { a: 'anthropic-adaptive' } }),
  M('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', { ctx: 200 * K, out: 64 * K, vision: true, legacy: true, r: { a: 'anthropic-adaptive' } }),
  M('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', { ctx: 200 * K, out: 64 * K, vision: true, legacy: true, r: { a: 'anthropic-budget' } }),
  M('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', { ctx: 200 * K, out: 64 * K, vision: true, legacy: true, r: { a: 'anthropic-budget' } }),
  M('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', { ctx: 200 * K, out: 64 * K, vision: true, legacy: true, r: { a: 'anthropic-budget' } }),

  // ---------- OpenAI ----------
  M('openai', 'gpt-6-astra', 'GPT-6 Astra', { ctx: 1050 * K, out: 128 * K, vision: true, price: [10, 50], r: { o: 'openai-effort' }, or: 'openai/gpt-6-astra' }),
  M('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', { ctx: 1050 * K, out: 128 * K, vision: true, price: [2, 10], r: { o: 'openai-effort' }, or: 'openai/gpt-6.1-sol' }),
  M('openai', 'gpt-6-sol', 'GPT-6 Sol', { ctx: 1050 * K, out: 128 * K, vision: true, price: [2, 10], r: { o: 'openai-effort' } }),
  M('openai', 'gpt-6-luna', 'GPT-6 Luna', { ctx: 1050 * K, out: 128 * K, vision: true, price: [0.1, 0.5], r: { o: 'openai-effort' }, or: 'openai/gpt-6-luna' }),
  M('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', { ctx: 1000 * K, out: 128 * K, vision: true, price: [4, 20], r: { o: 'openai-effort' }, or: 'openai/gpt-5.6-sol' }),
  M('openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', { ctx: 400 * K, out: 128 * K, vision: true, price: [2, 12], r: { o: 'openai-effort' } }),
  M('openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', { ctx: 400 * K, out: 128 * K, vision: true, price: [0.2, 1.2], r: { o: 'openai-effort' } }),
  M('openai', 'gpt-5.5', 'GPT-5.5', { ctx: 1000 * K, out: 128 * K, vision: true, price: [5, 30], r: { o: 'openai-effort' } }),
  M('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', { ctx: 1000 * K, out: 128 * K, vision: true, price: [30, 180], r: { o: 'openai-effort' }, responsesOnly: true }),
  M('openai', 'gpt-5.4', 'GPT-5.4', { ctx: 1000 * K, out: 128 * K, vision: true, legacy: true, r: { o: 'openai-effort' } }),
  M('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', { ctx: 400 * K, out: 128 * K, vision: true, legacy: true, r: { o: 'openai-effort' }, responsesOnly: true }),
  M('openai', 'gpt-5.1', 'GPT-5.1', { ctx: 400 * K, out: 128 * K, vision: true, legacy: true, r: { o: 'openai-effort' } }),
  M('openai', 'gpt-4.1', 'GPT-4.1', { ctx: 1000 * K, out: 32 * K, vision: true, legacy: true }),
  M('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', { ctx: 1000 * K, out: 32 * K, vision: true, legacy: true }),
  M('openai', 'gpt-4o', 'GPT-4o', { ctx: 128 * K, out: 16 * K, vision: true, legacy: true }),
  M('openai', 'gpt-4o-mini', 'GPT-4o mini', { ctx: 128 * K, out: 16 * K, vision: true, legacy: true }),

  // ---------- Google ----------
  M('google', 'gemini-4-argon', 'Gemini 4 Argon', { ctx: 1000 * K, out: 64 * K, vision: true, price: [2, 10], r: { g: 'gemini', o: 'openrouter' }, or: 'google/gemini-4-argon' }),
  M('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.75, 3.75], r: { g: 'gemini', o: 'openrouter' }, or: 'google/gemini-3.8-flash' }),
  M('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.75, 3.75], r: { g: 'gemini' } }),
  M('google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.75, 3.75], r: { g: 'gemini' } }),
  M('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.3, 2.5], r: { g: 'gemini' } }),
  M('google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', { ctx: 1000 * K, out: 64 * K, vision: true, price: [2, 12], r: { g: 'gemini' } }),

  // ---------- Moonshot · Kimi ----------
  M('moonshot', 'kimi-k3.1-pro', 'Kimi K3.1 Pro', { ctx: 1000 * K, out: 64 * K, vision: true, r: { o: 'kimi-effort', a: 'none' }, or: 'moonshotai/kimi-k3.1-pro' }),
  M('moonshot', 'kimi-k3.1-pro-highspeed', 'Kimi K3.1 Pro · highspeed', { ctx: 1000 * K, out: 64 * K, vision: true, r: { o: 'kimi-effort', a: 'none' } }),
  M('moonshot', 'kimi-k3', 'Kimi K3', { ctx: 1048576, out: 64 * K, vision: true, price: [3, 15, 0.3], r: { o: 'kimi-effort', a: 'none' }, or: 'moonshotai/kimi-k3' }),
  M('moonshot', 'kimi-k2.7-code', 'Kimi K2.7 Code', { ctx: 262144, out: 32 * K, price: [0.95, 4, 0.19], r: { o: 'thinking-object', a: 'anthropic-budget' }, or: 'moonshotai/kimi-k2.7-code' }),
  M('moonshot', 'kimi-k2.7-code-highspeed', 'Kimi K2.7 Code · highspeed', { ctx: 262144, out: 32 * K, price: [1.9, 8, 0.38], r: { o: 'thinking-object', a: 'anthropic-budget' } }),
  M('moonshot', 'kimi-k2.6', 'Kimi K2.6', { ctx: 262144, out: 32 * K, vision: true, price: [0.95, 4, 0.16], r: { o: 'thinking-object', a: 'anthropic-budget' }, or: 'moonshotai/kimi-k2.6' }),

  // ---------- Z.ai · GLM ----------
  M('zai', 'glm-5.3', 'GLM-5.3', { ctx: 1000 * K, out: 128 * K, price: [1.4, 4.4], r: { a: 'anthropic-budget', o: 'thinking-object' }, or: 'z-ai/glm-5.3' }),
  M('zai', 'glm-5.3-flash', 'GLM-5.3 Flash', { ctx: 1000 * K, out: 128 * K, price: [0.15, 0.5], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-5.2', 'GLM-5.2', { ctx: 1000 * K, out: 128 * K, price: [1.4, 4.4], r: { a: 'anthropic-budget', o: 'thinking-object' }, or: 'z-ai/glm-5.2' }),
  M('zai', 'glm-5.1', 'GLM-5.1', { ctx: 200 * K, out: 128 * K, price: [1.4, 4.4], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-5-code', 'GLM-5 Code', { ctx: 200 * K, out: 128 * K, price: [1.2, 5], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-5', 'GLM-5', { ctx: 200 * K, out: 128 * K, price: [1, 3.2], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.7', 'GLM-4.7', { ctx: 200 * K, out: 128 * K, price: [0.6, 2.2], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.7-flash', 'GLM-4.7 Flash (free)', { ctx: 200 * K, out: 128 * K, price: [0, 0], r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.6', 'GLM-4.6', { ctx: 200 * K, out: 128 * K, price: [0.6, 2.2], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5v', 'GLM-4.5V (vision)', { ctx: 128 * K, out: 16 * K, vision: true, price: [0.6, 1.8], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5', 'GLM-4.5', { ctx: 128 * K, out: 96 * K, price: [0.6, 2.2], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5-air', 'GLM-4.5 Air', { ctx: 128 * K, out: 96 * K, price: [0.2, 1.1], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5-airx', 'GLM-4.5 AirX', { ctx: 128 * K, out: 96 * K, price: [1.1, 4.5], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5-x', 'GLM-4.5 X', { ctx: 128 * K, out: 96 * K, price: [2.2, 8.9], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),
  M('zai', 'glm-4.5-flash', 'GLM-4.5 Flash (free)', { ctx: 128 * K, out: 96 * K, price: [0, 0], legacy: true, r: { a: 'anthropic-budget', o: 'thinking-object' } }),

  // ---------- DeepSeek ----------
  M('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { ctx: 1000 * K, out: 64 * K, or: 'deepseek/deepseek-v4-pro' }),
  M('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', { ctx: 1000 * K, out: 64 * K, or: 'deepseek/deepseek-v4.1-flash' }),

  // ---------- Qwen ----------
  M('qwen', 'qwen3.8-max', 'Qwen3.8 Max', { ctx: 1000 * K, out: 64 * K, vision: true, price: [2, 6], r: { o: 'enable-thinking' }, or: 'qwen/qwen3.8-max' }),
  M('qwen', 'qwen3.8-flash', 'Qwen3.8 Flash', { ctx: 1000 * K, out: 64 * K, price: [0.15, 0.47], r: { o: 'enable-thinking' }, or: 'qwen/qwen3.8-flash' }),
  M('qwen', 'qwen3.7-max', 'Qwen3.7 Max', { ctx: 1000 * K, out: 64 * K, price: [2.5, 7.5], r: { o: 'enable-thinking' } }),
  M('qwen', 'qwen3.7-plus', 'Qwen3.7 Plus', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.4, 1.6], r: { o: 'enable-thinking' } }),
  M('qwen', 'qwen3.7-flash', 'Qwen3.7 Flash', { ctx: 1000 * K, out: 64 * K, price: [0.03, 0.13], r: { o: 'enable-thinking' } }),
  M('qwen', 'qwen3.6-plus', 'Qwen3.6 Plus', { ctx: 1000 * K, out: 64 * K, price: [0.5, 3], legacy: true, r: { o: 'enable-thinking' } }),
  M('qwen', 'qwen3-coder-plus', 'Qwen3 Coder Plus', { ctx: 1000 * K, out: 64 * K, price: [1, 5] }),
  M('qwen', 'qwen3-coder-flash', 'Qwen3 Coder Flash', { ctx: 1000 * K, out: 64 * K, price: [0.3, 1.5] }),
  M('qwen', 'qwen3-vl-plus', 'Qwen3 VL Plus', { ctx: 256 * K, out: 32 * K, vision: true }),
  M('qwen', 'qwen3-vl-flash', 'Qwen3 VL Flash', { ctx: 256 * K, out: 32 * K, vision: true }),

  // ---------- xAI ----------
  M('xai', 'grok-4.7', 'Grok 4.7', { ctx: 500 * K, out: 128 * K, vision: true, price: [2, 6, 0.5], r: { o: 'openai-effort' }, or: 'x-ai/grok-4.7' }),

  // ---------- Mistral ----------
  M('mistral', 'mistral-large-4', 'Mistral Large 4', { ctx: 1000 * K, out: 64 * K, vision: true, price: [0.7, 2], or: 'mistralai/mistral-large-4' }),
  M('mistral', 'mistral-large-latest', 'Mistral Large (latest)', { ctx: 262 * K, out: 64 * K, vision: true, price: [0.5, 2] }),
  M('mistral', 'mistral-medium-latest', 'Mistral Medium', { ctx: 262 * K, out: 64 * K, vision: true, price: [2, 8] }),
  M('mistral', 'mistral-small-latest', 'Mistral Small', { ctx: 262 * K, out: 64 * K, vision: true, price: [0.15, 0.6] }),
  M('mistral', 'codestral-latest', 'Codestral', { ctx: 256 * K, out: 64 * K, price: [0.3, 0.9] }),
  M('mistral', 'ministral-8b-latest', 'Ministral 8B', { ctx: 262 * K, out: 32 * K, price: [0.15, 0.15] }),
  M('mistral', 'ministral-3b-latest', 'Ministral 3B', { ctx: 131 * K, out: 32 * K, price: [0.1, 0.1] }),

  // ---------- MiniMax / Xiaomi (native IDs: use "Fetch from API" to confirm) ----------
  M('minimax', 'MiniMax-M3', 'MiniMax M3', { ctx: 1000 * K, out: 128 * K, or: 'minimax/minimax-m3' }),
  M('xiaomi', 'mimo-v2.6-pro', 'MiMo V2.6 Pro', { ctx: 256 * K, out: 64 * K, or: 'xiaomi/mimo-v2.6-pro', orOnly: true }),

  // ---------- local (Ollama tags) ----------
  M('qwen', 'qwen3-coder:30b', 'Qwen3 Coder 30B', { ctx: 256 * K, out: 32 * K, local: true }),
  M('qwen', 'qwen3:32b', 'Qwen3 32B', { ctx: 128 * K, out: 32 * K, local: true }),
  M('openai', 'gpt-oss:20b', 'gpt-oss 20B', { ctx: 128 * K, out: 32 * K, local: true }),
  M('openai', 'gpt-oss:120b', 'gpt-oss 120B', { ctx: 128 * K, out: 32 * K, local: true }),
  M('deepseek', 'deepseek-r1:32b', 'DeepSeek R1 32B', { ctx: 128 * K, out: 32 * K, local: true }),
  M('google', 'gemma3:27b', 'Gemma 3 27B', { ctx: 128 * K, out: 8 * K, vision: true, local: true }),
  M('meta', 'llama3.3:70b', 'Llama 3.3 70B', { ctx: 128 * K, out: 8 * K, local: true }),
];

// Which vendors' models a preset serves natively.
const PRESET_VENDORS = {
  anthropic: ['anthropic'], openai: ['openai'], 'openai-responses': ['openai'], 'azure-openai': ['openai'], gemini: ['google'],
  'zai-anthropic': ['zai'], 'zai-openai': ['zai'], deepseek: ['deepseek'], moonshot: ['moonshot'], 'moonshot-anthropic': ['moonshot'],
  qwen: ['qwen'], xai: ['xai'], mistral: ['mistral'], minimax: ['minimax'], openrouter: '*', ollama: 'local', lmstudio: 'local',
};

function styleFor(m, protocol, presetId) {
  const r = m.r || {};
  if (presetId === 'openrouter') return r.o === 'openrouter' || m.or ? 'openrouter' : 'none';
  if (protocol === 'anthropic') return r.a || 'none';
  if (protocol === 'gemini') return r.g || 'gemini';
  if (protocol === 'openai-responses') return r.o === 'openai-effort' ? 'openai-responses' : 'none';
  return r.o && r.o !== 'openrouter' ? r.o : 'none';
}

// Catalog entries for a provider preset, as model configs ready to save.
function catalogFor(presetId, protocol) {
  const v = PRESET_VENDORS[presetId];
  if (!v) return [];
  let list;
  if (v === '*') list = MODELS.filter((m) => m.or && !m.local);
  else if (v === 'local') list = MODELS.filter((m) => m.local);
  else list = MODELS.filter((m) => v.includes(m.vendor) && !m.local && !m.orOnly && !(m.responsesOnly && protocol !== 'openai-responses'));
  return list.map((m) => ({
    id: presetId === 'openrouter' ? m.or : m.id,
    name: m.name,
    vendor: m.vendor,
    contextWindow: m.ctx,
    maxOutput: m.out,
    vision: !!m.vision,
    reasoningStyle: styleFor(m, protocol, presetId),
    legacy: !!m.legacy,
    price: m.price ? { input: m.price[0], output: m.price[1], ...(m.price[2] != null ? { cacheRead: m.price[2] } : {}) } : undefined,
  }));
}

// Guess the vendor of any model id (for icons on fetched/custom models).
function vendorOf(id) {
  const s = String(id || '').toLowerCase();
  const rules = [
    [/claude|anthropic/, 'anthropic'], [/kimi|moonshot/, 'moonshot'], [/glm|z-ai|zhipu|chatglm/, 'zai'], [/deepseek/, 'deepseek'],
    [/qwen|qwq|dashscope/, 'qwen'], [/grok|x-ai/, 'xai'], [/mistral|codestral|ministral|devstral|magistral|pixtral|voxtral/, 'mistral'],
    [/minimax|abab/, 'minimax'], [/mimo|xiaomi/, 'xiaomi'], [/llama|meta-/, 'meta'], [/hunyuan|^hy\d|tencent/, 'tencent'],
    [/gemini|gemma|google/, 'google'], [/gpt|^o\d|codex|openai|davinci|chatgpt/, 'openai'],
  ];
  const hit = rules.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}

module.exports = { VENDORS, MODELS, PRESET_VENDORS, catalogFor, vendorOf };
