'use strict';
// Vendor names + domains (for the real site icons) and a guess of the vendor from a model ID.
// No built-in models: every model is one the user adds.

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

module.exports = { VENDORS, vendorOf };
