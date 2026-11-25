// The two rules that were winning on the radar page v32 (Nov 20-22 paper: takeoffs 9/9 +159c,
// dip buys 10/13 +111c), ported from radar-v32/index.html with the same numbers, and with the
// EARLY-SELL exits they used then (the "hold until 85c" switch OFF).
//
// Differences from the page, because the bot sees less:
//  - one BTC feed (Coinbase) instead of four, checked every second
//  - the page's model also used the settle average, futures lead and options flow; this uses
//    distance to strike, volatility and trade flow, blended with Kalshi's price like the page does
//  - the "scalp lab" that tuned the dip numbers isn't ported; the page's defaults are used (6/6/6)

const kfee = x => 0.07 * x * (1 - x) * 100;                 // cents per contract, x = price in dollars
const tcdf4 = z => { const t = z * Math.SQRT2, q = 1 + t * t / 4, x = t / Math.sqrt(q); return .5 + .375 * x * (1 - (t * t / q) / 12); };
const at = (hist, t) => hist.find(h => h.t >= t);           // first point at or after t

export const V32 = { enable: true, RD: 6, RT: 6, RS: 6, rocketRide: true, holdSecs: 2, cooldownSecs: 15 };

function vol(hist, now) {
  const b = {};
  for (const x of hist) if (x.t > now - 300_000) b[Math.floor(x.t / 1000)] = x.btc;
  const k = Object.keys(b).map(Number).sort((a, c) => a - c), rs = [];
  for (let i = 1; i < k.length; i++) rs.push(Math.log(b[k[i]] / b[k[i - 1]]) / Math.sqrt(k[i] - k[i - 1]));
  let own = 0;
  if (rs.length >= 10) { const mu = rs.reduce((a, c) => a + c, 0) / rs.length; own = Math.sqrt(rs.reduce((a, c) => a + (c - mu) ** 2, 0) / rs.length); }
  return Math.max(own, 0.00002);
}

// the page's "one call" probability that Up wins, steadied so it doesn't flicker
function oneP(s, tick, left) {
  const sig = vol(s.hist, tick.t) * tick.btc;
  const sd = Math.max(sig * Math.sqrt(Math.max(left, 1)), 1e-6);
  const imb = Math.max(-1, Math.min(1, tick.imb60 || 0));
  const d = (tick.btc - tick.strike) + imb * sd * 0.1;
  let q = left <= 0 ? (d >= 0 ? 1 : 0) : Math.min(0.97, Math.max(0.03, tcdf4(d / sd)));
  if (tick.yesAsk - tick.yesBid <= 15) q = 0.6 * q + 0.4 * (tick.yesAsk + tick.yesBid) / 200;
  q = Math.min(0.97, Math.max(0.03, q));
  if (s.v32.win !== tick.ticker) { s.v32.win = tick.ticker; s.v32.p = null; }
  s.v32.p = s.v32.p == null ? q : s.v32.p * 0.8 + q * 0.2;
  return s.v32.p;
}

// returns a setup { side, ask, edge, kind, why } or null
export function v32Setup(s, tick, cfg = V32) {
  s.v32 ??= { win: null, p: null, kh: [], goodSince: 0, lastClose: 0 };
  const now = tick.t, left = (tick.closeTs - now) / 1000;
  const v = s.v32;
  if (!v.kh.length || now - v.kh[v.kh.length - 1].t >= 900) v.kh.push({ t: now, y: tick.yesAsk, n: tick.noAsk, tk: tick.ticker });
  v.kh = v.kh.filter(x => x.t > now - 22_000 && x.tk === tick.ticker);
  const P = oneP(s, tick, left);
  if (!cfg.enable || s.pos || s.order || now - v.lastClose < cfg.cooldownSecs * 1000) return null;
  if (left < 3 || left > 840 || v.kh.length < 8) return null;

  let setup = null;
  const price = tick.btc, p5 = at(s.hist, now - 5000), mv = p5 ? price - p5.btc : 0, th = price * 0.00002;
  for (const side of ['yes', 'no']) {
    const a1 = side === 'yes' ? tick.yesAsk : tick.noAsk, b1 = side === 'yes' ? tick.yesBid : tick.noBid;
    if (!(a1 >= 15 && a1 <= 80) || a1 - b1 > 3) continue;
    const hi = Math.max(...v.kh.map(x => side === 'yes' ? x.y : x.n)), dip = hi - a1;
    const fair = (side === 'yes' ? P : 1 - P) * 100, edge = fair - a1 - kfee(a1 / 100);
    const turn = (side === 'yes' ? mv : -mv) >= th;
    if (dip >= cfg.RD && edge >= 5 && turn && (!setup || edge > setup.edge))
      setup = { side, ask: a1, edge, kind: 'dip', why: `dipped ${dip}¢, bouncing, ${edge.toFixed(0)}¢ edge` };
  }
  // takeoff: BTC ripping one way over 10s, still going over 3s, buyers/sellers piling in, Kalshi lagging
  const p10 = at(s.hist, now - 10_000), p3 = at(s.hist, now - 3000);
  if (p10 && p3 && now - p10.t <= 12_000) {
    const m10 = price - p10.btc, m3 = price - p3.btc, sd10 = vol(s.hist, now) * price * Math.sqrt(10), dir = Math.sign(m10);
    if (dir && Math.abs(m10) >= 2 * sd10 && m3 * dir >= 0 && (tick.imb5 || 0) * dir >= 0.2) {
      const side = dir > 0 ? 'yes' : 'no', a1 = side === 'yes' ? tick.yesAsk : tick.noAsk, b1 = side === 'yes' ? tick.yesBid : tick.noBid;
      if (a1 >= 15 && a1 <= 85 && a1 - b1 <= 3) {
        const fair = (side === 'yes' ? P : 1 - P) * 100, edge = fair - a1 - kfee(a1 / 100);
        if (edge >= 5 && (!setup || edge > setup.edge))
          setup = { side, ask: a1, edge, kind: 'rocket', move: Math.abs(m10), why: `BTC ${dir > 0 ? '+' : '-'}$${Math.abs(m10).toFixed(0)} in 10s, Kalshi lagging` };
      }
    }
  }
  // the setup has to hold for 2 seconds, like the page
  if (!setup) { v.goodSince = 0; return null; }
  if (!v.goodSince) v.goodSince = now;
  return now - v.goodSince >= cfg.holdSecs * 1000 ? setup : null;
}

// decide whether to sell an open rocket/dip position now. Returns a reason or null.
export function v32Exit(s, tick, cfg = V32) {
  const pos = s.pos, now = tick.t, left = (tick.closeTs - now) / 1000;
  const bid = pos.side === 'yes' ? tick.yesBid : tick.noBid;
  if (!Number.isFinite(bid) || left <= 1) return null;
  const age = (now - pos.t) / 1000, be = pos.entry + kfee(pos.entry / 100) * 2;
  const P = s.v32?.p, mine = P == null ? null : (pos.side === 'yes' ? P : 1 - P);
  const stop = pos.stop, hard = pos.entry - Math.max(8, (pos.entry - stop) * 2.5);
  const hold = bid <= stop && mine != null && mine >= 0.55 && left > 60 && bid > hard;   // trend-aware stop
  if ((pos.kind === 'rocket' || pos.kind === 'rocketBig') && cfg.rocketRide !== false) {
    // v47.5 "let it ride": no selling on tiny wins. Trail the top only after a real gain.
    if (bid > pos.peak) pos.peak = bid;
    if (bid >= 95) return 'profit (nothing left to squeeze)';
    if (pos.peak >= be + 8 && bid <= pos.peak - Math.max(6, Math.round((pos.peak - pos.entry) * 0.3)))
      return bid > be ? `profit (rode to ${pos.peak}c, came off the top)` : 'cut (came off the top)';
    // "it thinks the price will drop": BTC turned hard against us (a takeoff the other way), or the model now
    // values our side well under what Kalshi pays for it -> sell now while the bid is still good.
    const p10 = at(s.hist, now - 10000), m10 = p10 ? (tick.btc - p10.btc) * (pos.side === 'yes' ? 1 : -1) : 0;
    if (p10 && -m10 >= 2 * vol(s.hist, now) * tick.btc * Math.sqrt(10) && bid > be) return 'profit (BTC turned hard, sold before the drop)';
    if (mine != null && mine * 100 < bid - 8 && bid > be) return 'profit (model says it will drop back)';
    if (bid <= stop && !hold) return 'cut (stop)';
    if (left <= 45 && !(mine != null && mine >= 0.8)) return bid > be ? 'profit (last 45s)' : 'cut (last 45s)';
    if (age > 180 && bid <= be + 2) return 'stale (3 min, never took off)';
  } else if (pos.kind === 'rocket' || pos.kind === 'rocketBig') {
    if (bid > pos.peak) pos.peak = bid;
    const p4 = at(s.hist, now - 4000), d = pos.side === 'yes' ? 1 : -1, stall = p4 ? (tick.btc - p4.btc) * d < 0 : false;
    if (bid >= 95) return 'profit (nothing left to squeeze)';
    if (pos.peak >= be + 4 && bid <= pos.peak - 4) return bid > be ? 'profit (came off the top)' : 'cut (came off the top)';
    if (stall && bid >= be + 2) return 'profit (BTC stopped running)';
    if (bid <= stop && !hold) return 'cut (stop)';
    if (age > 90) return bid > pos.entry ? 'profit (90s)' : 'stale (90s)';
  } else {
    // dip buys ride too: hitting the target no longer sells. It starts following the top and sells when the
    // price gives back 30% of the gain (4c+), or right away if BTC turns hard / the model says it will drop.
    if (bid > (pos.peak || 0)) pos.peak = bid;
    if (bid >= 95) return 'profit (nothing left to squeeze)';
    if (pos.peak >= pos.tgt && bid <= pos.peak - Math.max(4, Math.round((pos.peak - pos.entry) * 0.3)))
      return bid > be ? `profit (rode to ${pos.peak}c, came off the top)` : 'cut (came off the top)';
    if (pos.peak >= pos.tgt && bid > be) {
      const p10 = at(s.hist, now - 10000), m10 = p10 ? (tick.btc - p10.btc) * (pos.side === 'yes' ? 1 : -1) : 0;
      if (p10 && -m10 >= 2 * vol(s.hist, now) * tick.btc * Math.sqrt(10)) return 'profit (BTC turned hard, sold before the drop)';
      if (mine != null && mine * 100 < bid - 8) return 'profit (model says it will drop back)';
    }
    if (bid <= stop && !hold) return 'cut (stop)';
    if (left <= 45 && pos.peak >= pos.tgt && !(mine != null && mine >= 0.8)) return bid > be ? 'profit (last 45s)' : 'cut (last 45s)';
    if (age > 120 && pos.peak < pos.tgt) return bid > pos.entry ? 'profit (2 min)' : 'stale (2 min)';
  }
  return null;
}

export function v32Targets(setup, cfg = V32) {
  return { tgt: Math.ceil(setup.ask + cfg.RT + kfee(setup.ask / 100) * 2), stop: Math.floor(setup.ask - cfg.RS) };
}
