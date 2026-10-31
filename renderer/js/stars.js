// Quiet starfield like the lightapi.app background: sparse points, slow twinkle and drift.
export function starfield(host, { density = 0.00009, light = false } = {}) {
  const c = document.createElement('canvas');
  c.className = 'stars';
  host.prepend(c);
  const ctx = c.getContext('2d');
  let stars = [];
  let w = 0, hgt = 0, dpr = 1, raf = 0, last = 0, running = true;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = host.clientWidth; hgt = host.clientHeight;
    c.width = Math.max(1, w * dpr); c.height = Math.max(1, hgt * dpr);
    c.style.width = w + 'px'; c.style.height = hgt + 'px';
    const n = Math.round(w * hgt * density);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * hgt,
      r: Math.random() < 0.12 ? 1.3 + Math.random() * 0.9 : 0.5 + Math.random() * 0.6,
      a: 0.15 + Math.random() * 0.6, p: Math.random() * Math.PI * 2, s: 0.4 + Math.random() * 1.2,
      vy: -(0.6 + Math.random() * 1.6),
    }));
  };
  const draw = (t) => {
    if (!running) return;
    raf = requestAnimationFrame(draw);
    if (t - last < 33) return; // ~30fps is plenty
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    for (const s of stars) {
      s.y += s.vy * dt;
      if (s.y < -4) { s.y = hgt + 4; s.x = Math.random() * w; }
      const tw = 0.55 + 0.45 * Math.sin(t / 1000 * s.s + s.p);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = light ? '#000' : '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 1.3 && !light) {
        ctx.globalAlpha = s.a * tw * 0.18;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  raf = requestAnimationFrame(draw);
  const vis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf); } else if (!running) { running = true; raf = requestAnimationFrame(draw); } };
  document.addEventListener('visibilitychange', vis);
  return {
    destroy() { running = false; cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', vis); c.remove(); },
  };
}
