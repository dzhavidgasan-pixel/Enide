// Vendor icons for providers and models. The image is the vendor's own favicon, fetched
// by the main process from the vendor's site and cached; until it arrives (or offline)
// a neutral initials badge is shown.
import { api } from './api.js';
import { state } from './state.js';

const cache = new Map(); // vendor -> Promise<dataUrl|null>

const PRESET_VENDOR = {
  anthropic: 'anthropic', openai: 'openai', 'openai-responses': 'openai', 'azure-openai': 'azure', gemini: 'google',
  openrouter: 'openrouter', 'zai-anthropic': 'zai', 'zai-openai': 'zai', moonshot: 'moonshot', 'moonshot-anthropic': 'moonshot',
  deepseek: 'deepseek', qwen: 'qwen', xai: 'xai', mistral: 'mistral', minimax: 'minimax', groq: 'groq', together: 'together',
  fireworks: 'fireworks', ollama: 'ollama', lmstudio: 'lmstudio', litellm: 'litellm',
};

const RULES = [
  [/claude|anthropic/, 'anthropic'], [/kimi|moonshot/, 'moonshot'], [/glm|z-ai|zhipu/, 'zai'], [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'], [/grok|x-ai/, 'xai'], [/mistral|codestral|ministral|devstral|magistral|pixtral/, 'mistral'],
  [/minimax/, 'minimax'], [/mimo|xiaomi/, 'xiaomi'], [/llama|meta-/, 'meta'], [/hunyuan|tencent/, 'tencent'],
  [/gemini|gemma|google/, 'google'], [/gpt|^o\d|codex|openai/, 'openai'],
];

export function vendorOfModel(m) {
  if (m && m.vendor) return m.vendor;
  const s = String((m && m.id) || m || '').toLowerCase();
  const hit = RULES.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
}

export function vendorOfProvider(p) {
  if (!p) return null;
  if (PRESET_VENDOR[p.preset]) return PRESET_VENDOR[p.preset];
  const first = (p.models || [])[0];
  return first ? vendorOfModel(first) : null;
}

function vendorName(key) {
  const v = state.info && state.info.vendors && state.info.vendors[key];
  return v ? v.name : key || '';
}

// Fallback badge colors (plain tiles with letters, not logos) until the real icon loads.
const TINT = { anthropic: '#c96442', openai: '#10a37f', google: '#4285f4', moonshot: '#1f6bff', zai: '#3b5bfd', deepseek: '#4d6bfe', qwen: '#615ced',
  xai: '#e5e5e5', mistral: '#fa520f', minimax: '#e73562', xiaomi: '#ff6900', meta: '#0866ff', tencent: '#2a6cf6', openrouter: '#6566f1',
  groq: '#f55036', together: '#0f6fff', fireworks: '#6720ff', ollama: '#d0d0d0', lmstudio: '#7c5cff', azure: '#0078d4', litellm: '#18a058' };

function initials(label) {
  const s = String(label || '?').replace(/[^A-Za-zА-Яа-я0-9 ]/g, ' ').trim();
  const w = s.split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : s.slice(0, 2)).toUpperCase();
}

function load(key) {
  const own = state.settings && state.settings.iconOverrides && state.settings.iconOverrides[key];
  if (own) return Promise.resolve(own);
  if (!cache.has(key)) cache.set(key, api.invoke('icons:get', key).catch(() => null));
  return cache.get(key);
}

// <span class="vicon"> with initials, swapped for the real icon once loaded.
export function vendorIcon(key, { size = 16, label } = {}) {
  const el = document.createElement('span');
  el.className = 'vicon';
  el.style.width = el.style.height = size + 'px';
  el.style.fontSize = Math.max(7, Math.round(size * 0.42)) + 'px';
  el.title = vendorName(key) || label || '';
  el.textContent = initials(vendorName(key) || label);
  if (TINT[key]) { el.style.background = TINT[key]; el.style.color = /^#(e|d|f)/i.test(TINT[key]) ? '#111' : '#fff'; }
  if (key) {
    el.dataset.vendor = key;
    load(key).then((url) => {
      if (!url) return;
      const img = new Image();
      img.alt = '';
      img.onload = () => { el.textContent = ''; el.style.background = ''; el.classList.add('img'); el.append(img); };
      img.src = url;
    });
  }
  return el;
}

export const modelIcon = (m, size) => vendorIcon(vendorOfModel(m), { size, label: m && (m.name || m.id) });
export const providerIcon = (p, size) => vendorIcon(vendorOfProvider(p), { size, label: p && p.name });
export function resetVendorIcons() { cache.clear(); }
