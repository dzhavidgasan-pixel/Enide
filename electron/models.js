'use strict';
// The model list every Enide user sees — the same families Cursor offers (Anthropic, OpenAI,
// Google, xAI, Moonshot, Z.ai, DeepSeek), with the vendors' own API IDs. Requests go to the
// one API the user pasted; whether a model works depends on that API. Cursor-only models
// (Composer, Auto) are not here: no other API serves them.

const K = 1000;
const M = (vendor, id, name, ctx, out, vision = false) => ({ vendor, id, name, contextWindow: ctx, maxOutput: out, vision });

const MODELS = [
  M('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 1000 * K, 128 * K, true),
  M('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000 * K, 128 * K, true),
  M('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', 1000 * K, 128 * K, true),
  M('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 1000 * K, 128 * K, true),
  M('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', 1050 * K, 128 * K, true),
  M('openai', 'gpt-6-luna', 'GPT-6 Luna', 1050 * K, 128 * K, true),
  M('openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', 1000 * K, 128 * K, true),
  M('openai', 'gpt-5.5', 'GPT-5.5', 1000 * K, 128 * K, true),
  M('openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', 400 * K, 128 * K, true),
  M('google', 'gemini-4-argon', 'Gemini 4 Argon', 1000 * K, 64 * K, true),
  M('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 1000 * K, 64 * K, true),
  M('google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 1000 * K, 64 * K, true),
  M('xai', 'grok-4.7', 'Grok 4.7', 500 * K, 128 * K, true),
  M('moonshot', 'kimi-k3.1-pro', 'Kimi K3.1 Pro', 1000 * K, 64 * K, true),
  M('moonshot', 'kimi-k3', 'Kimi K3', 1048576, 64 * K, true),
  M('moonshot', 'kimi-k2.6', 'Kimi K2.6', 262144, 32 * K, true),
  M('zai', 'glm-5.3', 'GLM-5.3', 1000 * K, 128 * K),
  M('zai', 'glm-5.2', 'GLM-5.2', 1000 * K, 128 * K),
  M('zai', 'glm-5.3-flash', 'GLM-5.3 Flash', 1000 * K, 128 * K),
  M('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 1000 * K, 64 * K),
  M('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', 1000 * K, 64 * K),
];

module.exports = { MODELS };
