'use strict';
// Provider registry: presets, model defaults, model listing and connection tests.
// Nothing here injects text into prompts — adapters send exactly the system prompt
// and messages they are given.

const { joinUrl, readErrorBody, netErr } = require('./sse');
const { authHeaders, redactHeaders, withQuery } = require('./util');
const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const responses = require('./responses');
const { vendorOf, VENDORS } = require('../vendors');

const ADAPTERS = { anthropic, openai, gemini, 'openai-responses': responses };

// Presets are only starting points: every field is editable in Settings → Providers.
const PRESETS = [
  { preset: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', authStyle: 'x-api-key', promptCaching: true,
    keyUrl: 'https://console.anthropic.com/settings/keys' },
  { preset: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer', maxTokensField: 'max_completion_tokens',
    defaultReasoning: 'openai-effort', keyUrl: 'https://platform.openai.com/api-keys' },
  { preset: 'openai-responses', name: 'OpenAI · Responses API', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer',
    defaultReasoning: 'openai-responses', keyUrl: 'https://platform.openai.com/api-keys' },
  { preset: 'gemini', name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'goog',
    defaultReasoning: 'gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  { preset: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer',
    defaultReasoning: 'openrouter', headers: { 'HTTP-Referer': 'https://enide.app', 'X-Title': 'Enide' }, keyUrl: 'https://openrouter.ai/keys' },
  { preset: 'zai-anthropic', name: 'Z.ai GLM (Anthropic API)', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', authStyle: 'both',
    defaultReasoning: 'anthropic-budget', promptCaching: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { preset: 'zai-openai', name: 'Z.ai GLM (OpenAI API)', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', authStyle: 'bearer',
    defaultReasoning: 'thinking-object', echoReasoning: true, keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    note: 'GLM Coding Plan: https://api.z.ai/api/coding/paas/v4' },
  { preset: 'moonshot', name: 'Moonshot · Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', authStyle: 'bearer', echoReasoning: true,
    defaultReasoning: 'thinking-object', keyUrl: 'https://platform.kimi.ai/console/api-keys', note: 'China: https://api.moonshot.cn/v1' },
  { preset: 'moonshot-anthropic', name: 'Moonshot · Kimi (Anthropic API)', protocol: 'anthropic', baseUrl: 'https://api.moonshot.ai/anthropic', authStyle: 'both',
    defaultReasoning: 'anthropic-budget', promptCaching: false, keyUrl: 'https://platform.kimi.ai/console/api-keys' },
  { preset: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', authStyle: 'bearer', echoReasoning: true,
    keyUrl: 'https://platform.deepseek.com/api_keys' },
  { preset: 'qwen', name: 'Qwen · Model Studio', protocol: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authStyle: 'bearer',
    defaultReasoning: 'enable-thinking', echoReasoning: false, keyUrl: 'https://modelstudio.console.alibabacloud.com',
    note: 'US: https://dashscope-us.aliyuncs.com/compatible-mode/v1 · China: https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { preset: 'minimax', name: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1', authStyle: 'bearer', echoReasoning: true,
    keyUrl: 'https://platform.minimax.io' },
  { preset: 'xai', name: 'xAI · Grok', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', authStyle: 'bearer', keyUrl: 'https://console.x.ai' },
  { preset: 'mistral', name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', authStyle: 'bearer', streamUsage: false },
  { preset: 'groq', name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', authStyle: 'bearer' },
  { preset: 'together', name: 'Together AI', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1', authStyle: 'bearer' },
  { preset: 'fireworks', name: 'Fireworks', protocol: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', authStyle: 'bearer' },
  { preset: 'ollama', name: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', authStyle: 'none', streamUsage: true },
  { preset: 'lmstudio', name: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', authStyle: 'none' },
  { preset: 'custom-openai', name: 'Custom · OpenAI-compatible', protocol: 'openai', baseUrl: '', authStyle: 'bearer' },
  { preset: 'custom-anthropic', name: 'Custom · Anthropic-compatible', protocol: 'anthropic', baseUrl: '', authStyle: 'x-api-key' },
  { preset: 'azure-openai', name: 'Azure OpenAI', protocol: 'openai', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT', authStyle: 'api-key', query: 'api-version=2025-04-01-preview', maxTokensField: 'max_completion_tokens' },
  { preset: 'litellm', name: 'LiteLLM / any gateway', protocol: 'openai', baseUrl: 'http://localhost:4000/v1', authStyle: 'bearer' },
];

function presetById(p) { return PRESETS.find((x) => x.preset === p); }

// Make a full provider config from a preset (used when user adds a provider).
function providerFromPreset(presetId, id) {
  const p = presetById(presetId) || presetById('custom-openai');
  return {
    id: id || `${p.preset}-${Math.random().toString(36).slice(2, 7)}`,
    preset: p.preset,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    authStyle: p.authStyle,
    headers: { ...(p.headers || {}) },
    query: p.query || '',
    echoReasoning: !!p.echoReasoning,
    streamUsage: p.streamUsage !== false,
    promptCaching: p.promptCaching !== false && p.protocol === 'anthropic',
    maxTokensField: p.maxTokensField || 'max_tokens',
    defaultReasoning: p.defaultReasoning || null,
    enabled: true,
    models: [],
  };
}

// A model the user adds: just an ID, an endpoint and a protocol. Everything else is guessed
// from those and can be changed under "More".
function customModel({ id, modelId = '', name = '', baseUrl = '', protocol }) {
  const proto = protocol || detectProtocol(baseUrl);
  const p = {
    id: id || `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    preset: 'custom', name: name || modelId || '', protocol: proto, baseUrl,
    authStyle: authFor(proto, baseUrl), headers: {}, query: '', echoReasoning: true, streamUsage: true,
    promptCaching: false, maxTokensField: 'max_tokens', defaultReasoning: null, enabled: true, models: [],
  };
  p.models = [normalizeModel({ id: modelId, name, custom: true }, p)];
  return p;
}

// Endpoint → protocol: …/anthropic or anthropic.com → Anthropic Messages, Google → Gemini, else OpenAI-compatible.
function detectProtocol(url) {
  const u = String(url || '').toLowerCase();
  if (/anthropic/.test(u)) return 'anthropic';
  if (/generativelanguage\.googleapis\.com/.test(u)) return 'gemini';
  return 'openai';
}
function authFor(protocol, url) {
  if (protocol === 'anthropic') return /api\.anthropic\.com/.test(String(url)) ? 'x-api-key' : 'both';
  if (protocol === 'gemini') return 'goog';
  return 'bearer';
}

// Sensible per-model defaults. Everything is visible and editable in Settings → Models.
function guessReasoningStyle(provider, id) {
  const m = String(id).toLowerCase();
  if (provider.protocol === 'anthropic') {
    if (/^claude-/.test(m)) {
      if (/claude-3|claude-(opus|sonnet|haiku)-4-5|claude-(opus|sonnet)-4-1|claude-(opus|sonnet)-4-\d{8}|claude-(opus|sonnet)-4$/.test(m)) return 'anthropic-budget';
      return 'anthropic-adaptive';
    }
    return provider.defaultReasoning || 'anthropic-budget';
  }
  if (provider.protocol === 'gemini') return 'gemini';
  if (provider.protocol === 'openai-responses') return /^(o\d|gpt-5|gpt-6|codex|gpt-oss|computer-use)/.test(m) ? 'openai-responses' : 'none';
  if (provider.defaultReasoning) {
    if (provider.defaultReasoning === 'openai-effort' && !/^(o\d|gpt-5|gpt-6|gpt-oss)/.test(m)) return 'none';
    return provider.defaultReasoning;
  }
  // custom OpenAI-compatible endpoints: guess from the model ID
  const bare = m.replace(/^[\w.-]+\//, '');
  if (/^(o\d|gpt-5|gpt-6|gpt-oss)/.test(bare)) return 'openai-effort';
  if (/^kimi-k3/.test(bare)) return 'kimi-effort';
  if (/^(glm-[45]|kimi-k2|deepseek-v3\.[1-9]|deepseek-v4)/.test(bare)) return 'thinking-object';
  if (/^qwen3/.test(bare)) return 'enable-thinking';
  if (/^grok-[34]/.test(bare)) return 'openai-effort';
  if (/\//.test(m) && /openrouter/.test(String(provider.baseUrl))) return 'openrouter';
  return 'none';
}

function guessVision(id) {
  const m = String(id).toLowerCase();
  return /claude|gpt-4o|gpt-4\.1|gpt-5|gpt-6|gemini|vision|-vl|vl-|llava|pixtral|grok-4|kimi-k2\.5|kimi-k3|glm-4\.\dv|glm-5v|qwen.*vl/.test(m);
}

function normalizeModel(m, provider) {
  const id = m.id;
  return {
    id,
    name: m.name || id,
    contextWindow: m.contextWindow || 128000,
    maxOutput: m.maxOutput || 8192,
    vision: m.vision != null ? m.vision : guessVision(id),
    tools: m.tools != null ? m.tools : true,
    reasoningStyle: m.reasoningStyle || guessReasoningStyle(provider, id),
    reasoningBudget: m.reasoningBudget || 8000,
    temperature: m.temperature != null ? m.temperature : null,
    extraBody: m.extraBody || {},
    enabled: m.enabled !== false,
    custom: !!m.custom,
    vendor: m.vendor || vendorOf(id) || undefined,
    ...(m.price ? { price: m.price } : {}),
  };
}

function adapterFor(provider) {
  const a = ADAPTERS[provider.protocol];
  if (!a) throw new Error(`Unknown protocol: ${provider.protocol}`);
  return a;
}

// List models straight from the provider API.
async function listModels({ provider, apiKey, fetchImpl }) {
  const f = fetchImpl || fetch;
  const headers = { ...authHeaders(provider, apiKey), ...(provider.headers || {}) };
  let url;
  if (provider.protocol === 'anthropic') {
    url = joinUrl(provider.baseUrl, '/v1/models?limit=1000');
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.protocol === 'gemini') {
    url = joinUrl(provider.baseUrl, '/v1beta/models?pageSize=1000');
  } else {
    url = joinUrl(provider.baseUrl, '/models');
  }
  url = withQuery(url, provider.query);
  const res = await f(url, { headers }).catch(netErr(url));
  if (!res.ok) throw await readErrorBody(res);
  const j = await res.json();
  let ids = [];
  if (provider.protocol === 'gemini') {
    ids = (j.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName, contextWindow: m.inputTokenLimit, maxOutput: m.outputTokenLimit }));
  } else {
    const arr = Array.isArray(j) ? j : j.data || j.models || [];
    ids = arr.map((m) => (typeof m === 'string' ? { id: m } : {
      id: m.id || m.name || m.model,
      name: m.display_name || m.name || undefined,
      contextWindow: m.context_length || m.context_window || m.max_context_length || (m.top_provider && m.top_provider.context_length) || undefined,
      maxOutput: m.max_output_tokens || (m.top_provider && m.top_provider.max_completion_tokens) || undefined,
    })).filter((m) => m.id);
  }
  return ids.map((m) => normalizeModel(m, provider));
}

// Fire one tiny real request and report what came back (used by "Test connection").
async function testConnection({ provider, apiKey, model, fetchImpl, reasoning }) {
  const adapter = adapterFor(provider);
  const started = Date.now();
  const out = { ok: false, text: '', reasoning: '', usage: null, ms: 0, request: null, error: null, firstTokenMs: null };
  try {
    const stream = adapter.stream({
      provider, apiKey, fetchImpl,
      model: normalizeModel(typeof model === 'string' ? { id: model } : model, provider),
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
      tools: [],
      reasoning: reasoning || { enabled: false },
      maxTokens: 512,
      onRequest: (r) => { out.request = r; },
    });
    for await (const ev of stream) {
      if ((ev.type === 'text' || ev.type === 'reasoning') && out.firstTokenMs == null) out.firstTokenMs = Date.now() - started;
      if (ev.type === 'text') out.text += ev.text;
      else if (ev.type === 'reasoning') out.reasoning += ev.text;
      else if (ev.type === 'usage') out.usage = { ...(out.usage || {}), ...ev.usage };
    }
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  out.ms = Date.now() - started;
  return out;
}

module.exports = {
  PRESETS, presetById, providerFromPreset, customModel, detectProtocol, authFor, normalizeModel, guessReasoningStyle, VENDORS, vendorOf,
  authHeaders, redactHeaders, adapterFor, listModels, testConnection,
};
