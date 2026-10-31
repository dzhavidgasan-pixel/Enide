// Thin wrapper over the preload bridge. In a plain browser (design preview / tests)
// a mock bridge from dev/mock-bridge.js is used instead.
let bridge = window.enide;
if (!bridge) {
  const mod = await import('../dev/mock-bridge.js');
  bridge = mod.createMockBridge();
  window.enide = bridge;
}

export const api = {
  invoke: (ch, ...a) => bridge.invoke(ch, ...a),
  send: (ch, ...a) => bridge.send(ch, ...a),
  on: (ch, cb) => bridge.on(ch, cb),
  pathForFile: (f) => (bridge.pathForFile ? bridge.pathForFile(f) : ''),
  platform: bridge.platform || 'darwin',
  isMock: !!bridge.isMock,
};
