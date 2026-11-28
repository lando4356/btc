// Our own fair value for "Up", from the BRTI approximation, volatility and the measured gap to the real BRTI.
// Kalshi settles on the AVERAGE of the last 60 one-second BRTI values vs the strike (also a 60s BRTI average).
import { tcdf4, Ewma, clamp } from "./stats.mjs";

export function fairUp({ price, knownAvg = null, knownSecs = 0, leftSec, strike, sigma, gapMean = 0, gapSd = 3 }) {
  if (!(price > 0 && strike > 0 && sigma > 0)) return null;
  const left = Math.max(0, leftSec), r = Math.min(left, 60);
  const knownPart = knownAvg != null && knownSecs > 0 ? knownAvg * knownSecs : price * (60 - r);
  const m = (knownPart + r * price) / 60 + gapMean;
  const s$ = sigma * price; // dollars per sqrt(second)
  const v = s$ * s$ * (Math.max(left - 60, 0) * (r / 60) ** 2 + (r * r * r) / 10800) + gapSd * gapSd;
  const sd = Math.sqrt(Math.max(v, 1e-6));
  return clamp(tcdf4((m - strike) / sd), 0.001, 0.999);
}

// Measured gap between the real BRTI (Kalshi's strike and settlement values) and our approximation.
export class GapTracker {
  constructor(saved = null, { alpha = 0.1, priorSd = 3 } = {}) {
    this.e = Ewma.from(saved?.e, alpha); this.priorSd = priorSd; this.samples = saved?.samples || [];
  }
  add(kind, official, ours, t = Date.now()) {
    if (!(official > 0 && ours > 0)) return null;
    const g = official - ours;
    if (Math.abs(g) > 200) return null; // ignore broken samples
    // a window's strike IS the previous window's settlement (same BRTI minute): count that minute once
    if (this.samples.slice(-3).some((s) => s.official === official && Math.abs(t - s.t) < 180000)) return g;
    this.e.push(g); this.samples.push({ t, kind, official, g: +g.toFixed(2) }); if (this.samples.length > 500) this.samples.shift();
    return g;
  }
  get mean() { return this.e.n >= 5 ? this.e.mean : 0; }
  get sd() { // until enough samples, use the prior; afterwards blend toward the measured spread (floor $0.5)
    const n = this.e.n; if (n < 5) return this.priorSd;
    const meas = Math.max(Math.sqrt(this.e.var + 0), 0.5), w = Math.min(1, n / 50);
    return w * meas + (1 - w) * this.priorSd;
  }
  toJSON() { return { e: this.e.toJSON(), samples: this.samples.slice(-200) }; }
}
