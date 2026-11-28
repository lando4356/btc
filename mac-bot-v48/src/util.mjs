export function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? x : +x.toFixed(d));
