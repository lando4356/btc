// Signal features, computed the SAME way live (engine.mjs) and in the backtester (tools/backtest-repo.mjs).
import { logit, clamp } from "./stats.mjs";

// at(sec) -> BTC price at that clock second (or null). sigma/short/long are per-sqrt(second) log vols.
export function computeFeatures({ price, p0, pK, sigma, short, long, at, nowSec, flow5 = 0, flow60 = 0, perpMove10 = null, bookImb = 0, kImb = 0 }) {
  const sig10 = sigma * Math.sqrt(10), p10 = at(nowSec - 10), p60 = at(nowSec - 60);
  const r10 = p10 ? Math.log(price / p10) : 0;
  return {
    gap: clamp(logit(p0) - logit(pK), -4, 4),
    flow5: clamp(flow5, -1, 1), flow60: clamp(flow60, -1, 1),
    mom10: clamp(r10 / sig10, -6, 6),
    mom60: p60 ? clamp(Math.log(price / p60) / (sigma * Math.sqrt(60)), -6, 6) : 0,
    lead: perpMove10 == null ? 0 : clamp((perpMove10 - r10) / sig10, -6, 6),
    bookImb: clamp(bookImb, -1, 1), kImb: clamp(kImb, -1, 1),
    volRatio: short && long ? clamp(Math.log(short / long), -3, 3) : 0,
  };
}

// Volatility from a per-second price lookup (same recipe live and in backtests):
// 70% weight on 1-minute moves over the last hour, 30% on 10-second moves over the last 10 minutes.
export function volFrom(at, nowSec, seedLong = null) {
  const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : 0);
  const r10 = [], r60 = [];
  for (let k = nowSec - 600; k + 10 <= nowSec; k += 10) { const a = at(k), b = at(k + 10); if (a && b) r10.push(Math.log(b / a) / Math.sqrt(10)); }
  for (let k = nowSec - 3600; k + 60 <= nowSec; k += 60) { const a = at(k), b = at(k + 60); if (a && b) r60.push(Math.log(b / a) / Math.sqrt(60)); }
  const short = r10.length >= 20 ? rms(r10) : null;
  let long = r60.length >= 30 ? rms(r60) : seedLong;
  if (long == null) long = short;
  if (long == null) return { sigma: null, short, long };
  return { sigma: Math.max(Math.sqrt(0.7 * long * long + 0.3 * (short ?? long) ** 2), 2e-6), short: short ?? long, long };
}
