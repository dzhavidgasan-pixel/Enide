'use strict';
// Minimal, spec-tolerant Server-Sent Events parser over a WHATWG ReadableStream.
// Yields { event, data } objects. Works with Electron net.fetch and Node fetch.

async function* readSSE(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event = '';
  let data = [];
  const flush = function* () {
    if (data.length) {
      yield { event: event || 'message', data: data.join('\n') };
    }
    event = '';
    data = [];
  };
  try {
    while (true) {
      if (signal && signal.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r\n|\n|\r/)) !== -1) {
        const line = buf.slice(0, idx);
        const sepLen = buf[idx] === '\r' && buf[idx + 1] === '\n' ? 2 : 1;
        buf = buf.slice(idx + sepLen);
        if (line === '') {
          yield* flush();
          continue;
        }
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c === -1 ? line : line.slice(0, c);
        let val = c === -1 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
    }
    yield* flush();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function abortError() {
  const e = new Error('Request aborted');
  e.name = 'AbortError';
  return e;
}

// Join a user-provided base URL with an API path, avoiding duplicated segments.
// joinUrl('https://api.z.ai/api/anthropic', '/v1/messages') -> .../api/anthropic/v1/messages
// joinUrl('https://api.openai.com/v1', '/v1/chat/completions') -> .../v1/chat/completions
function joinUrl(base, path) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  let p = path.startsWith('/') ? path : '/' + path;
  const firstSeg = p.split('/')[1];
  if (firstSeg && /^v\d+(beta|alpha)?\d*$/.test(firstSeg) && new RegExp('/' + firstSeg + '$').test(b)) {
    p = p.slice(firstSeg.length + 1);
  } else if (firstSeg && /^v\d+/.test(firstSeg) && /\/v\d+(beta|alpha)?\d*$/.test(b)) {
    // base already pins a version (e.g. /v4 or /api/paas/v4) — keep base's version
    p = p.slice(firstSeg.length + 1);
  }
  return b + p;
}

async function readErrorBody(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = (j.error && (j.error.message || j.error.msg || (typeof j.error === 'string' ? j.error : ''))) || j.message || j.msg || text;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {}
  const e = new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}: ${String(msg).slice(0, 2000)}`);
  e.status = res.status;
  e.body = text.slice(0, 8000);
  return e;
}

// Turn low-level fetch failures ("fetch failed") into something actionable.
function netErr(url) {
  return (e) => {
    if (e && e.name === 'AbortError') throw e;
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
    let host = url;
    try { host = new URL(url).host; } catch {}
    const err = new Error(`Network error reaching ${host}: ${e && e.message ? e.message : e}${cause ? ` (${cause})` : ''}`);
    err.cause = e;
    throw err;
  };
}

module.exports = { readSSE, joinUrl, readErrorBody, abortError, netErr };
