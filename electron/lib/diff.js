'use strict';
// Small line diff (Myers O(ND)) producing hunks for chat edit cards.

function diffLines(aText, bText) {
  const a = aText === '' ? [] : String(aText).split('\n');
  const b = bText === '' ? [] : String(bText).split('\n');
  const N = a.length, M = b.length;
  if (N * M > 4e7 && Math.abs(N - M) > 5000) return null; // too big; caller shows summary
  const max = N + M;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  const off = max + 1;
  let found = false;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
    if (found) { trace.push(v.slice()); break; }
    if (d > 20000) return null;
  }
  // backtrack
  const ops = [];
  let x = N, y = M;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: ' ', s: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push({ t: '+', s: b[y - 1] }); y--; }
      else { ops.push({ t: '-', s: a[x - 1] }); x--; }
    }
  }
  while (x > 0 && y > 0) { ops.push({ t: ' ', s: a[x - 1] }); x--; y--; }
  while (x > 0) { ops.push({ t: '-', s: a[x - 1] }); x--; }
  while (y > 0) { ops.push({ t: '+', s: b[y - 1] }); y--; }
  ops.reverse();
  return ops;
}

function hunks(aText, bText, context = 3, maxLines = 400) {
  const ops = diffLines(aText, bText);
  if (!ops) return { added: null, removed: null, hunks: [], tooLarge: true };
  let added = 0, removed = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
  const out = [];
  let aLine = 1, bLine = 1;
  let cur = null;
  let lastChange = -1e9;
  const pending = [];
  let total = 0;
  ops.forEach((o, i) => {
    const isChange = o.t !== ' ';
    if (isChange) {
      if (!cur || i - lastChange > context * 2) {
        cur = { aStart: aLine - pending.length, bStart: bLine - pending.length, lines: pending.splice(0).map((p) => p) };
        out.push(cur);
      } else {
        cur.lines.push(...pending.splice(0));
      }
      if (total < maxLines) cur.lines.push({ t: o.t, s: o.s });
      total++;
      lastChange = i;
    } else {
      if (cur && i - lastChange <= context) { if (total < maxLines) cur.lines.push({ t: ' ', s: o.s }); total++; }
      else {
        pending.push({ t: ' ', s: o.s });
        if (pending.length > context) pending.shift();
      }
    }
    if (o.t !== '+') aLine++;
    if (o.t !== '-') bLine++;
  });
  return { added, removed, hunks: out, truncated: total > maxLines };
}

module.exports = { diffLines, hunks };
