export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => { const q = clamp(p, 1e-4, 1 - 1e-4); return Math.log(q / (1 - q)); };
// Student-t with 4 degrees of freedom, rescaled to unit variance (fat tails), CDF.
export function tcdf4(z) { const t = z * Math.SQRT2, q = 1 + (t * t) / 4, x = t / Math.sqrt(q); return 0.5 + 0.375 * x * (1 - (t * t / q) / 12); }
export const logLoss = (p, y) => { const q = clamp(p, 1e-6, 1 - 1e-6); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };
export function meanSd(a) {
  const n = a.length; if (!n) return { mean: 0, sd: 0, n: 0, se: 0 };
  const m = a.reduce((s, x) => s + x, 0) / n;
  const v = n > 1 ? a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) : 0;
  return { mean: m, sd: Math.sqrt(v), n, se: n > 1 ? Math.sqrt(v / n) : 0 };
}
export function percentile(arr, q) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = clamp((a.length - 1) * q, 0, a.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }
// Exponentially weighted mean/variance.
export class Ewma {
  constructor(alpha, mean = 0, variance = 0, n = 0) { this.alpha = alpha; this.mean = mean; this.var = variance; this.n = n; }
  push(x) { if (!Number.isFinite(x)) return; if (this.n === 0) { this.mean = x; this.var = 0; } else { const d = x - this.mean; this.mean += this.alpha * d; this.var = (1 - this.alpha) * (this.var + this.alpha * d * d); } this.n++; }
  get sd() { return Math.sqrt(this.var); }
  toJSON() { return { alpha: this.alpha, mean: this.mean, var: this.var, n: this.n }; }
  static from(o, alpha) { return o ? new Ewma(o.alpha ?? alpha, o.mean, o.var, o.n) : new Ewma(alpha); }
}
// Small dense linear solver (Gaussian elimination with partial pivoting).
export function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let mx = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[mx][i])) mx = k;
    [M[i], M[mx]] = [M[mx], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; if (f) for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let t = M[i][n]; for (let j = i + 1; j < n; j++) t -= M[i][j] * x[j]; x[i] = t / M[i][i]; }
  return x;
}
