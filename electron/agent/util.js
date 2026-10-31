'use strict';

function authHeaders(provider, apiKey) {
  const h = {};
  const key = apiKey || '';
  switch (provider.authStyle) {
    case 'x-api-key': if (key) h['x-api-key'] = key; break;
    case 'bearer': if (key) h['authorization'] = `Bearer ${key}`; break;
    case 'both': if (key) { h['x-api-key'] = key; h['authorization'] = `Bearer ${key}`; } break;
    case 'goog': if (key) h['x-goog-api-key'] = key; break;
    case 'api-key': if (key) h['api-key'] = key; break;
    case 'none': default: break;
  }
  return h;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/key|authorization|token|secret/i.test(k)) {
      const s = String(v);
      out[k] = s.length > 16 ? s.slice(0, 10) + '…' + s.slice(-4) : '•••';
    } else out[k] = v;
  }
  return out;
}

// Deep-merge plain objects (used for per-model "extra body" JSON).
function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else if (v === null) {
      delete target[k];
    } else {
      target[k] = v;
    }
  }
  return target;
}

function safeJsonParse(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Tolerant parse of streamed tool arguments (some providers emit trailing junk).
function parseToolArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch {}
  const s = String(raw).trim();
  const last = s.lastIndexOf('}');
  if (last > 0) { try { return JSON.parse(s.slice(0, last + 1)); } catch {} }
  return { __raw: s, __parseError: true };
}

function genId(prefix = 'call') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Gemini accepts an OpenAPI-ish subset of JSON Schema.
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['$schema', 'additionalProperties', 'default', 'examples', '$id', '$ref', 'definitions', '$defs', 'const', 'title', 'exclusiveMinimum', 'exclusiveMaximum', 'patternProperties', 'unevaluatedProperties'].includes(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== 'null');
      out.type = nonNull[0] || 'string';
      if (v.includes('null')) out.nullable = true;
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = sanitizeSchemaForGemini(pv);
      continue;
    }
    if (k === 'format' && typeof v === 'string' && !['enum', 'date-time'].includes(v)) continue;
    out[k] = typeof v === 'object' ? sanitizeSchemaForGemini(v) : v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// Splits "<think>…</think>" tags out of a streamed text channel (local models via Ollama/LM Studio).
class ThinkTagSplitter {
  constructor() { this.inThink = false; this.buf = ''; this.seenContent = false; }
  push(chunk) {
    const out = [];
    this.buf += chunk;
    while (this.buf.length) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end === -1) {
          const keep = partialSuffix(this.buf, '</think>');
          const emit = this.buf.slice(0, this.buf.length - keep);
          if (emit) out.push({ type: 'reasoning', text: emit });
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        if (end > 0) out.push({ type: 'reasoning', text: this.buf.slice(0, end) });
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = this.seenContent ? -1 : this.buf.indexOf('<think>');
      if (start === -1) {
        const keep = this.seenContent ? 0 : partialSuffix(this.buf, '<think>');
        const emit = this.buf.slice(0, this.buf.length - keep);
        if (emit) {
          if (emit.trim()) this.seenContent = true;
          out.push({ type: 'text', text: emit });
        }
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
      const before = this.buf.slice(0, start);
      if (before) {
        if (before.trim()) this.seenContent = true;
        out.push({ type: 'text', text: before });
      }
      this.buf = this.buf.slice(start + 7);
      this.inThink = true;
    }
    return out;
  }
  flush() {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return [];
    return [{ type: this.inThink ? 'reasoning' : 'text', text: rest }];
  }
}

function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

// Append provider-level query params (e.g. Azure "api-version=…").
function withQuery(url, query) {
  if (!query) return url;
  const q = String(query).replace(/^[?&]/, '');
  if (!q) return url;
  return url + (url.includes('?') ? '&' : '?') + q;
}

function truncate(s, max) {
  s = String(s == null ? '' : s);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return s.slice(0, head) + `\n\n… [${s.length - max} characters truncated] …\n\n` + s.slice(-tail);
}

module.exports = {
  authHeaders, redactHeaders, deepMerge, safeJsonParse, parseToolArgs, genId,
  sanitizeSchemaForGemini, ThinkTagSplitter, truncate, withQuery,
};
