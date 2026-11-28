// Walk-forward backtest of the v48 brain, entries, exits and sizing on the REAL ticks the repo's paper bot recorded
// (bot/live/ticks-*.csv: Kalshi order-book top + Coinbase BTC, ~1 tick per second).
//
//   node mac-bot-v48/tools/backtest-repo.mjs [ticksDir ...]      (default: ../bot/live)
//
// Honest by construction:
//  - official results come from Kalshi's public API (cached in mac-bot-v48/data/results-cache.json)
//  - the brain only ever predicts a window with models fit on EARLIER windows (walk-forward)
//  - an order decided on tick i fills on the NEXT tick (about 1 s later) at that tick's price, only if the price is
//    still within the slippage limit; taker fees by Kalshi's formula on every buy and every early sell
//  - limitation: the CSV has no order-book sizes, so it assumes our (small) size was available at the top
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Brain, GROUP_NAMES } from "../src/brain.mjs";
import { computeFeatures, volFrom } from "../src/features.mjs";
import { fairUp, GapTracker } from "../src/fair.mjs";
import { takerFeeDollars, feePerContractCents } from "../src/fees.mjs";
import { sizeOrder } from "../src/sizing.mjs";
import { meanSd } from "../src/stats.mjs";
import { v32Setup, v32Exit, v32Targets } from "../src/v32.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dirs.length) dirs.push(path.join(HERE, "../../bot/live"));
const CACHE = path.join(HERE, "../data/results-cache.json");
const API = "https://api.elections.kalshi.com/trade-api/v2";

// ---------- load ticks ----------
const ticks = [];
for (const d of dirs) for (const f of fs.readdirSync(d).filter((x) => /^ticks-.*\.csv$/.test(x)).sort()) {
  const lines = fs.readFileSync(path.join(d, f), "utf8").trim().split("\n"); const head = lines.shift().split(",");
  for (const ln of lines) { const v = ln.split(","), o = {}; head.forEach((h, i) => (o[h] = h === "ticker" ? v[i] : +v[i])); if (o.ticker && Number.isFinite(o.yesBid) && Number.isFinite(o.noBid) && o.btc > 0) ticks.push(o); }
}
ticks.sort((a, b) => a.t - b.t);
const byWin = new Map(); for (const t of ticks) { const a = byWin.get(t.ticker) || []; a.push(t); byWin.set(t.ticker, a); }
const sec = new Map(); for (const t of ticks) sec.set(Math.floor(t.t / 1000), t.btc);
const at = (s) => { for (let k = s; k > s - 10; k--) if (sec.has(k)) return sec.get(k); return null; };
const avgSecs = (a, b) => { let s = 0, n = 0, have = 0, c = at(a - 1); for (let k = a; k < b; k++) { const v = sec.get(k); if (v != null) { c = v; have++; } if (c != null) { s += c; n++; } } return n && have >= 0.6 * (b - a) ? s / n : null; };

// ---------- official results ----------
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch {}
for (const tk of byWin.keys()) {
  if (cache[tk]?.result === "yes" || cache[tk]?.result === "no") continue;
  try { const j = await (await fetch(`${API}/markets/${tk}`, { headers: { Accept: "application/json" } })).json(); const m = j.market || {};
    cache[tk] = { result: m.result || null, expirationValue: m.expiration_value != null ? Number(m.expiration_value) : null, strike: Number(m.floor_strike) || null, closeMs: Date.parse(m.close_time) };
  } catch (e) { console.error("result fetch failed", tk, e.message); }
  await new Promise((r) => setTimeout(r, 60));
}
fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));

const windows = [...byWin.entries()].map(([tk, ts]) => ({ tk, ts, r: cache[tk] })).filter((w) => (w.r?.result === "yes" || w.r?.result === "no") && w.ts.length >= 300).sort((a, b) => a.ts[0].closeTs - b.ts[0].closeTs);

// ---------- measured gap: Kalshi's official BRTI numbers vs our (Coinbase-only) averages ----------
const gapOpen = [], gapClose = []; // NOTE: a window's strike is the same BRTI minute as the previous window's settlement
for (const w of windows) {
  const closeSec = Math.floor(w.ts[0].closeTs / 1000), openSec = closeSec - 900;
  const o = avgSecs(openSec - 60, openSec); if (o && w.r.strike) gapOpen.push(w.r.strike - o);
  const c = avgSecs(closeSec - 60, closeSec); if (c && w.r.expirationValue) gapClose.push(w.r.expirationValue - c);
}

// ---------- strategies ----------
const C = { minEdgeCents: 3, slipBufferCents: 1, maxSlipCents: 1, maxSellSlipCents: 2, kelly: 0.25, maxFrac: 0.03, maxContracts: 200, maxBuys: 2, minLeft: 60, maxLeft: 870, minPx: 10, maxPx: 90, maxSpread: 6, stopLoss: 15, exitBuffer: 1, start: 100 };
function mkAcct(name, entry, exit, sizing = "kelly") { return { name, entry, exit, sizing, bal: C.start, trades: [], pos: null, pend: null, buys: {}, v32: { hist: [], pos: null, order: null } }; }
const accts = [
  mkAcct("brain: hold to settlement", "brain", "hold"),
  mkAcct("brain: edge exit (v48 default)", "brain", "edge"),
  mkAcct("brain: edge exit + 15c stop", "brain", "edge+stop"),
  mkAcct("brain: 15c stop only", "brain", "stop"),
  mkAcct("v32 setups, NO edge check, v32 exits, fixed 3% (repo rule)", "v32", "v32", "fixed"),
  mkAcct("v32 setups + after-fee edge check, v32 exits", "v32gated", "v32"),
  mkAcct("v32 setups + after-fee edge check, edge exit + stop", "v32gated", "edge+stop"),
];

const brain = new Brain({ minFitWindows: 20, minAcceptWindows: 60 });
const gap = new GapTracker(null);
let wi = 0;
for (const w of windows) {
  wi++;
  const ts = w.ts, closeMs = ts[0].closeTs, strike = w.r.strike || ts[0].strike, closeSec = Math.floor(closeMs / 1000);
  let lastSample = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], left = (closeMs - t.t) / 1000, nowSec = Math.floor(t.t / 1000), price = t.btc;
    const spread = t.yesAsk - t.yesBid, pK = spread >= 0 && spread <= C.maxSpread ? (t.yesAsk + t.yesBid) / 200 : null;
    const v = volFrom(at, nowSec); if (!v.sigma || pK == null || !(pK > 0 && pK < 1)) continue;
    let knownAvg = null, knownSecs = 0; if (left < 60) { knownSecs = Math.min(60, Math.max(0, nowSec - (closeSec - 60))); knownAvg = knownSecs ? avgSecs(closeSec - 60, nowSec) : null; if (knownAvg == null) knownSecs = 0; }
    const p0 = fairUp({ price, knownAvg, knownSecs, leftSec: left, strike, sigma: v.sigma, gapMean: gap.mean, gapSd: gap.sd });
    const f = computeFeatures({ price, p0, pK, sigma: v.sigma, short: v.short, long: v.long, at, nowSec, flow5: t.imb5, flow60: t.imb60 });
    const row = { win: w.tk, t: t.t, left, pK, p0, askYes: t.yesAsk, askNo: t.noAsk, f };
    const preds = brain.predictAll(row), p = preds.explore;
    if (t.t - lastSample >= 10000 && left > 20 && left < 890) { lastSample = t.t; brain.addSample(row); }
    const nxt = ts[i + 1];
    for (const A of accts) step(A, t, nxt, left, p, row);
  }
  // window over: settle open positions at the official result, then the brain learns (walk-forward)
  const y = w.r.result === "yes" ? 1 : 0;
  for (const A of accts) { if (A.pos) { const P = A.pos, won = (P.side === "yes") === (y === 1); close(A, won ? 100 : 0, false, won ? "settled won" : "settled lost", closeMs); } A.pend = null; }
  const cA = avgSecs(closeSec - 60, closeSec); if (cA && w.r.expirationValue) gap.add("close", w.r.expirationValue, cA);
  brain.settle(w.tk, y);
}

function step(A, t, nxt, left, p, row) {
  // pending order from the previous tick fills now (about 1 s later) at this tick's price
  if (A.pend) {
    const o = A.pend; A.pend = null;
    if (o.type === "buy") { const ask = o.side === "yes" ? t.yesAsk : t.noAsk; if (ask <= o.limit && ask >= 1 && ask <= 99) open(A, o, ask, t); }
    else if (A.pos) { const bid = o.side === "yes" ? t.yesBid : t.noBid; if (bid >= o.limit && bid >= 1) close(A, bid, true, o.why, t.t); }
  }
  if (!nxt || A.pend) return;
  const ps = (s) => (s === "yes" ? p : 1 - p);
  let setup = null;
  if (A.entry !== "brain") { const h = A.v32.hist, last = h[h.length - 1]; if (!last || t.t - last.t >= 1000) { h.push({ t: t.t, btc: t.btc }); while (h[0].t < t.t - 2100000) h.shift(); }
    A.v32.pos = A.pos ? A.v32.pos : null; setup = v32Setup(A.v32, t); }
  if (A.pos) { // exits
    const P = A.pos, bid = P.side === "yes" ? t.yesBid : t.noBid; if (!(bid >= 1) || left < 5) return;
    let why = null;
    if ((A.exit === "stop" || A.exit === "edge+stop") && bid <= P.entry - C.stopLoss) why = "stop";
    if (!why && (A.exit === "edge" || A.exit === "edge+stop") && bid - feePerContractCents(bid, P.n) - C.exitBuffer > ps(P.side) * 100) why = bid > P.entry ? "edge: profit" : "edge: cut";
    if (!why && A.exit === "v32") { const w = v32Exit(A.v32, t); if (w) why = w; }
    if (why) A.pend = { type: "sell", side: P.side, limit: bid - C.maxSellSlipCents, why };
    return;
  }
  if (left < C.minLeft || left > C.maxLeft || (A.buys[t.ticker] || 0) >= C.maxBuys) return;
  let best = null;
  for (const side of ["yes", "no"]) {
    if ((A.entry === "v32" || A.entry === "v32gated") && (!setup || setup.side !== side)) continue;
    const ask = side === "yes" ? t.yesAsk : t.noAsk; if (ask < C.minPx || ask > C.maxPx) continue;
    const e = ps(side) * 100 - ask - feePerContractCents(ask, 10) - C.slipBufferCents;
    if (A.entry === "v32") { best = { side, ask, e, kind: setup.kind }; break; }
    if (e >= C.minEdgeCents && (!best || e > best.e)) best = { side, ask, e, kind: setup ? setup.kind : "edge" };
  }
  if (!best) return;
  const limit = best.ask + C.maxSlipCents;
  let n;
  if (A.sizing === "fixed") n = Math.floor((A.bal * C.maxFrac) / ((limit + feePerContractCents(limit, 10)) / 100));
  else n = sizeOrder({ prob: ps(best.side), priceCents: limit, feeCentsPerContract: feePerContractCents(limit, 10), balanceDollars: A.bal, kellyMultiplier: C.kelly, maxFraction: C.maxFrac, maxContracts: C.maxContracts }).count;
  if (n >= 1) A.pend = { type: "buy", side: best.side, limit, n, kind: best.kind, e: best.e };
}
function open(A, o, ask, t) {
  const fee = takerFeeDollars(ask, o.n), cost = (ask * o.n) / 100 + fee; if (cost > A.bal) return;
  A.bal -= cost; A.buys[t.ticker] = (A.buys[t.ticker] || 0) + 1;
  A.pos = { side: o.side, n: o.n, entry: ask, fee, t: t.t, kind: o.kind, e: o.e };
  if (A.entry !== "brain") { const tg = v32Targets({ ask }); A.v32.pos = { side: o.side, entry: ask, kind: o.kind === "edge" ? "dip" : o.kind, stop: tg.stop, tgt: tg.tgt, peak: ask, t: t.t }; }
}
function close(A, px, isSell, why, tt) {
  const P = A.pos, fee = isSell ? takerFeeDollars(px, P.n) : 0, got = (px * P.n) / 100 - fee;
  A.bal += got; const pnl = got - (P.entry * P.n) / 100 - P.fee;
  A.trades.push({ pnl, n: P.n, entry: P.entry, exit: px, why, fees: P.fee + fee, kind: P.kind, t: P.t });
  A.pos = null; A.v32.pos = null; if (A.v32.v32) A.v32.v32.lastClose = tt;
}

// ---------- report ----------
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(d));
const gs = (a) => { const m = meanSd(a); return `mean ${fmt(m.mean)} $, sd ${fmt(m.sd)} $, n ${m.n}`; };
console.log(`\nData: ${ticks.length} ticks, ${windows.length} windows with official results (${new Date(windows[0].ts[0].t).toISOString()} → ${new Date(windows[windows.length - 1].ts.at(-1).t).toISOString()})`);
console.log(`Measured gap, official BRTI 60-s average minus our Coinbase-only average (one sample per window; a strike is the previous settlement): ${gs(gapClose)}`);
const S = brain.summary();
console.log(`\nBrain, out-of-sample (walk-forward) log loss vs Kalshi's price (positive gain = better than Kalshi):`);
const ll = brain.llStats("explore"); console.log(`  explore model (all signals, used for paper): windows ${ll.windows}, gain ${fmt(ll.gainVsKalshi, 4)}, t ${fmt(ll.t)}`);
for (const g of GROUP_NAMES) { const x = S.groups[g]; if (x.windows) console.log(`  ${g.padEnd(9)} windows ${x.windows}, gain ${fmt(x.gain, 4)}, t ${fmt(x.t)}${x.accepted ? "  ACCEPTED" : ""}`); }
console.log(`  accepted groups: ${S.accepted.join(", ") || "none"} · trusted for real money: ${S.trusted}`);
const half = (tr) => { const h = Math.floor(tr.length / 2); return [tr.slice(0, h), tr.slice(h)].map((x) => x.reduce((s, y) => s + y.pnl, 0)); };
console.log(`\nStrategies ($${C.start} start each, after fees, fills 1 tick later):`);
for (const A of accts) {
  const tr = A.trades, m = meanSd(tr.map((x) => x.pnl)), cpc = tr.map((x) => (x.pnl / x.n) * 100), mc = meanSd(cpc), [h1, h2] = half(tr);
  console.log(`  ${A.name}\n    trades ${tr.length}, won ${tr.filter((x) => x.pnl > 0).length}, P&L $${fmt(m.mean * m.n)}, per trade ${fmt(mc.mean, 1)}c/contract (t ${fmt(mc.se ? mc.mean / mc.se : 0)}), fees $${fmt(tr.reduce((s, x) => s + x.fees, 0))}, halves $${fmt(h1)} / $${fmt(h2)}, end balance $${fmt(A.bal)}`);
}
const out = { generated: new Date().toISOString(), ticks: ticks.length, windows: windows.length, gapOpen: meanSd(gapOpen), gapClose: meanSd(gapClose), brain: S, strategies: accts.map((A) => ({ name: A.name, trades: A.trades.length, wins: A.trades.filter((x) => x.pnl > 0).length, pnl: A.trades.reduce((s, x) => s + x.pnl, 0), fees: A.trades.reduce((s, x) => s + x.fees, 0), endBalance: A.bal, halves: half(A.trades), byExit: Object.entries(A.trades.reduce((o, x) => { const k = x.why.split(" (")[0]; o[k] = o[k] || { n: 0, pnl: 0 }; o[k].n++; o[k].pnl += x.pnl; return o; }, {})) })) };
fs.writeFileSync(path.join(HERE, "../data/backtest-results.json"), JSON.stringify(out, null, 1));
console.log("\nSaved mac-bot-v48/data/backtest-results.json");
