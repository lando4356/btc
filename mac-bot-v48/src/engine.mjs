// The decision engine. Runs inside the Node bot: every Kalshi book change and every exchange price change can trigger
// a decision (throttled), with no browser in the loop. One position at a time; all hard limits enforced here.
import { fairUp, GapTracker } from "./fair.mjs";
import { Brain, GROUP_NAMES } from "./brain.mjs";
import { feePerContractCents } from "./fees.mjs";
import { sizeOrder } from "./sizing.mjs";
import { logit, clamp, meanSd, percentile } from "./stats.mjs";
import { round } from "./util.mjs";
import { computeFeatures } from "./features.mjs";
import { v32Setup, v32Exit, v32Targets, V32 } from "./v32.mjs";

// platform = { loadState(), saveState(obj), stopActive(), readSamples() }: files on the Mac (src/platform-node.mjs)
// or Durable Object storage on Cloudflare (src/platform-cf.mjs). Nothing else in here touches the outside world.
export function createEngine({ cfg, platform, kalshi, index, broker, logger, notifier }) {
  const L = cfg.limits, S = cfg.strategy;
  let saved = platform.loadState() || {};
  if (saved.mode && saved.mode !== cfg.mode) saved = { gap: saved.gap }; // never mix paper and real positions/records
  const st = {
    position: saved.position || null, win: saved.win || {}, stopped: saved.stopped || null, closed: saved.closed || [],
    dayStart: saved.dayStart || null, busy: false, stopFile: false, lastDecision: null, settling: {}, gapOpenDone: {},
  };
  const gap = new GapTracker(saved.gap, { priorSd: S.gapPriorSd ?? 3 });
  const brain = new Brain(cfg.brain || {});
  const samplesByWin = new Map();
  // radar v32/v47.5 takeoff + dip setups (repo bot/v32.mjs, copied unchanged). In v48 a setup is only a TRIGGER:
  // the buy still has to pass the after-fee edge check against the live ask.
  const v32s = { hist: [], pos: null, order: null };
  const v32Tick = (ctx) => ({ t: ctx.now, ticker: ctx.m.ticker, closeTs: ctx.m.closeMs, strike: ctx.m.strike, btc: ctx.price,
    yesBid: Math.round(ctx.top.yesBid), yesAsk: Math.round(ctx.top.yesAsk), noBid: Math.round(ctx.top.noBid), noAsk: Math.round(ctx.top.noAsk), imb5: ctx.f?.flow5 ?? 0, imb60: ctx.f?.flow60 ?? 0 });
  const lat = { decideUs: [], eventToDecisionMs: [], orderMs: [] };
  const pushLat = (k, v) => { lat[k].push(v); if (lat[k].length > 2000) lat[k].shift(); };
  const ev = (o) => logger.write("events", o);
  const save = () => { try { platform.saveState(JSON.parse(JSON.stringify({ mode: cfg.mode, position: st.position, win: st.win, stopped: st.stopped, closed: st.closed.slice(-500), dayStart: st.dayStart, gap, paper: broker.kind === "paper" ? broker : undefined }))); } catch (e) { ev({ event: "STATE_SAVE_FAILED", error: e.message }); } };

  // ---- replay logged training rows through the brain (walk-forward, so the record is honest after a restart) ----
  function replayBrain() {
    const t0 = Date.now(), rows = platform.readSamples();
    const byWin = new Map();
    for (const r of rows) { if (r.y !== 0 && r.y !== 1) continue; const a = byWin.get(r.win) || []; a.push(r); byWin.set(r.win, a); }
    const wins = [...byWin.entries()].sort((a, b) => (a[1][0].settledTs || 0) - (b[1][0].settledTs || 0));
    let i = 0;
    for (const [win, rs] of wins) { for (const r of rs) brain.addSample(r); brain.settle(win, rs[0].y, { refit: ++i % 10 === 0 }); }
    if (wins.length) brain.refit();
    ev({ event: "BRAIN_REPLAYED", windows: wins.length, rows: rows.length, ms: Date.now() - t0, accepted: [...brain.accepted] });
  }

  // ---- the numbers at this instant ----
  function compute(now = Date.now()) {
    const m = kalshi.state.market; if (!m) return { ok: false, why: "no market" };
    const b = kalshi.book(m.ticker), top = b.top(), left = (m.closeMs - now) / 1000;
    const price = index.value(now), v = index.vol(Math.floor(now / 1000));
    const spread = top.yesAsk != null && top.yesBid != null ? top.yesAsk - top.yesBid : null;
    const pK = spread != null && spread <= S.maxSpreadCents ? (top.yesAsk + top.yesBid) / 200 : null;
    const ctx = { ok: true, now, m, top, left, price, sigma: v.sigma, pK, spread, bookAgeMs: now - b.updated, nFeeds: index.fresh(now).length };
    if (price == null || !v.sigma || !m.strike) return { ...ctx, ok: false, why: price == null ? "BTC feeds not ready" : !v.sigma ? "volatility warming up" : "no strike yet" };
    const nowSec = Math.floor(now / 1000), closeSec = Math.floor(m.closeMs / 1000);
    let knownAvg = null, knownSecs = 0;
    if (left < 60) { knownSecs = clamp(nowSec - (closeSec - 60), 0, 60); if (knownSecs > 0) knownAvg = index.avg(closeSec - 60, nowSec); if (knownAvg == null) knownSecs = 0; }
    ctx.p0 = fairUp({ price, knownAvg, knownSecs, leftSec: left, strike: m.strike, sigma: v.sigma, gapMean: gap.mean, gapSd: gap.sd });
    if (pK == null) return { ...ctx, ok: false, why: "Kalshi spread too wide or empty book" };
    ctx.f = computeFeatures({ price, p0: ctx.p0, pK, sigma: v.sigma, short: v.short, long: v.long, at: index.at, nowSec,
      flow5: index.flow(5000, now), flow60: index.flow(60000, now), perpMove10: index.perpMove(10000, now), bookImb: index.bookImb(now), kImb: b.imbalance(3) });
    const row = { win: m.ticker, t: now, left, pK, p0: ctx.p0, askYes: top.yesAsk, askNo: top.noAsk, f: ctx.f };
    ctx.row = row;
    ctx.preds = brain.predictAll(row);
    ctx.trusted = brain.trusted();
    if (ctx.trusted) { ctx.p = ctx.preds.active; ctx.pSource = "trusted brain"; }
    else if ((cfg.mode === "paper" && S.paperTradeUntrusted !== false) || (cfg.mode === "real" && S.allowUntrustedReal === true)) { ctx.p = ctx.preds.explore; ctx.pSource = "exploring (not proven)"; }
    else { ctx.p = null; ctx.pSource = "brain not proven: no trading"; }
    if (S.entrySource !== "brain" && ctx.top.yesBid != null && ctx.top.noBid != null) {
      const last = v32s.hist[v32s.hist.length - 1];
      if (!last || now - last.t >= 1000) { v32s.hist.push({ t: now, btc: price }); while (v32s.hist.length && v32s.hist[0].t < now - 2100000) v32s.hist.shift(); }
      v32s.pos = st.position ? v32s.pos || { side: st.position.side, entry: st.position.entry, kind: st.position.kind, stop: st.position.entry - V32.RS, tgt: st.position.entry + V32.RT, peak: st.position.entry, t: st.position.t } : null;
      ctx.v32tick = v32Tick(ctx); ctx.setup = v32Setup(v32s, ctx.v32tick);
    }
    return ctx;
  }

  const edgeAt = (ps, priceCents, count = 10, maker = false) => ps * 100 - priceCents - feePerContractCents(priceCents, count, { maker, ...feeOpts() }) - (maker ? 0 : S.slipBufferCents);
  const feeOpts = () => ({ feeType: kalshi.state.seriesInfo?.feeType || "quadratic", multiplier: kalshi.state.seriesInfo?.feeMultiplier ?? 1 });

  // ---- entries ----
  function entryBlock(ctx) {
    if (st.stopFile) return "STOP file present";
    if (st.stopped) return "stopped: " + st.stopped;
    if (st.position) return "holding a position";
    if (!ctx.ok) return ctx.why;
    if (ctx.p == null) return ctx.pSource;
    const W = st.win[ctx.m.ticker] || { buys: 0 };
    if (W.buys >= L.maxBuysPerWindow) return `already ${W.buys} buys this window`;
    if (ctx.left < L.minSecondsLeft) return `only ${Math.round(ctx.left)}s left`;
    if (ctx.left > S.maxSecondsLeft) return "too early in the window";
    if (ctx.bookAgeMs > L.maxBookAgeMs) return `Kalshi book ${ctx.bookAgeMs}ms old`;
    if (ctx.nFeeds < S.minFeeds) return `only ${ctx.nFeeds} BTC feeds`;
    if (W.cooldownUntil && ctx.now < W.cooldownUntil) return "cooling down after a trade";
    return null;
  }
  function bestEntry(ctx) {
    let best = null;
    const src = S.entrySource || "brain";
    if (src === "v32" && !ctx.setup) return null;
    for (const side of ["yes", "no"]) {
      if (src === "v32" && ctx.setup.side !== side) continue; // a v32 setup picks the side; the brain checks the price
      const ps = side === "yes" ? ctx.p : 1 - ctx.p, ask = side === "yes" ? ctx.top.yesAsk : ctx.top.noAsk;
      if (ask == null || ask < L.minPriceCents || ask > L.maxPriceCents) continue;
      const e = edgeAt(ps, ask);
      if (!best || e > best.edge) best = { side, ps, ask, edge: e };
      if (S.makerEntries) {
        const bid = side === "yes" ? ctx.top.yesBid : ctx.top.noBid; if (bid == null) continue;
        const px = ask - bid >= 2 ? bid + 1 : bid, em = edgeAt(ps, px, 10, true);
        if (em >= S.minEdgeCents && (!best || em > best.edge)) best = { side, ps, ask, edge: em, maker: true, makerPx: px };
      }
    }
    return best;
  }
  async function tryEnter(ctx) {
    const why = entryBlock(ctx); if (why) return { act: "none", why };
    const c = bestEntry(ctx); if (!c) return { act: "none", why: S.entrySource === "v32" ? "no takeoff/dip setup" : "no side in price range" };
    c.kind = ctx.setup && ctx.setup.side === c.side ? ctx.setup.kind : "edge";
    if (c.edge < S.minEdgeCents) return { act: "none", why: `best edge ${c.edge.toFixed(1)}c < ${S.minEdgeCents}c`, side: c.side, edge: c.edge };
    if (cfg.mode === "real" && !kalshi.hasKey) return { act: "none", why: "real mode needs a key" };
    const bal = broker.balance();
    if (bal < L.floorDollars) { st.stopped = `balance $${bal.toFixed(2)} under $${L.floorDollars}`; save(); ev({ event: "STOPPED", why: st.stopped }); notifier.notify("Bot stopped", st.stopped, 5, "stop_sign"); return { act: "none", why: st.stopped }; }
    const daily = dailyLoss(bal); if (daily != null && daily > L.maxDailyLossFraction) return { act: "none", why: `daily loss ${(daily * 100).toFixed(1)}% over limit` };
    const px = c.maker ? c.makerPx : c.ask;
    const limit = c.maker ? px : (edgeAt(c.ps, c.ask + L.maxSlipCents) >= S.minEdgeCents ? c.ask + L.maxSlipCents : c.ask);
    const depth = c.maker ? Infinity : kalshi.book(ctx.m.ticker).depthAtOrBelow(c.side, limit);
    const sz = sizeOrder({ prob: c.ps, priceCents: limit, feeCentsPerContract: c.maker ? 0 : feePerContractCents(limit, 10, feeOpts()), balanceDollars: bal, kellyMultiplier: S.kellyMultiplier, maxFraction: L.maxBetFraction, maxContracts: L.maxContracts, maxDepth: depth });
    if (sz.count < 1) return { act: "none", why: `size under 1 contract (Kelly ${(sz.fullKelly * 100).toFixed(1)}%)`, side: c.side, edge: c.edge };
    // claim the slot BEFORE sending so a crash can't double-buy
    const W = (st.win[ctx.m.ticker] = st.win[ctx.m.ticker] || { buys: 0 }); W.buys++; save();
    const order = { event: "ORDER_SENT", kind: c.kind, mode: cfg.mode, ticker: ctx.m.ticker, side: c.side, action: "buy", count: sz.count, limitCents: limit, seenAsk: c.ask, maker: !!c.maker, prob: round(c.ps), edgeCents: round(c.edge, 2), kelly: round(sz.fullKelly), fraction: round(sz.fraction), balance: round(bal, 2), pSource: ctx.pSource, left: round(ctx.left, 1) };
    ev(order);
    st.busy = true;
    try {
      const r = c.maker
        ? await broker.buyMaker({ ticker: ctx.m.ticker, side: c.side, count: sz.count, priceCents: px, timeoutMs: S.makerTimeoutMs, stillWanted: () => { const x = compute(); return x.ok && x.p != null && edgeAt(c.side === "yes" ? x.p : 1 - x.p, px, 10, true) >= S.minEdgeCents * 0.5; } })
        : await broker.buy({ ticker: ctx.m.ticker, side: c.side, count: sz.count, limitCents: limit });
      pushLat("orderMs", r.delayMs);
      ev({ event: "ORDER_DONE", mode: cfg.mode, ticker: ctx.m.ticker, side: c.side, action: "buy", filled: r.filled, avgCents: round(r.avg, 2), feeDollars: r.feeDollars, delayMs: r.delayMs, apiMs: r.apiMs, orderId: r.orderId, maker: !!r.maker, optimistic: !!r.optimistic, why: r.why, raw: r.raw });
      if (!r.filled) { W.buys--; save(); notifier.notify("Order missed (nothing spent)", `${c.side} ${sz.count} @ ${limit}c: ${r.why || "no sellers at that price"}`, 2, "hourglass", "miss", 600000); return { act: "miss" }; }
      st.position = { kind: c.kind, ticker: ctx.m.ticker, side: c.side, count: r.filled, entry: r.avg, entryFee: r.feeDollars, t: Date.now(), closeMs: ctx.m.closeMs, proceeds: 0, exitFees: 0, sold: 0, maker: !!r.maker };
      W.cooldownUntil = Date.now() + (S.cooldownSec || 0) * 1000;
      if (c.kind !== "edge") { const tg = v32Targets({ ask: r.avg }); v32s.pos = { side: c.side, entry: r.avg, kind: c.kind, stop: tg.stop, tgt: tg.tgt, peak: r.avg, t: Date.now() }; }
      save();
      if (cfg.mode === "real") kalshi.refreshBalance().catch(() => {});
      notifier.notify(`${cfg.mode === "paper" ? "[paper] " : ""}Bought ${c.side === "yes" ? "Up" : "Down"} x${r.filled}`, `@ ${round(r.avg, 1)}c, edge ${c.edge.toFixed(1)}c, fee $${r.feeDollars.toFixed(2)}`, 4, "moneybag");
      return { act: "bought" };
    } catch (e) {
      W.buys--; save(); ev({ event: "ORDER_REJECTED", error: e.message }); notifier.notify("Kalshi refused an order", e.message.slice(0, 300), 4, "warning");
      return { act: "error", why: e.message };
    } finally { st.busy = false; }
  }

  // ---- exits: sell when the bid pays more than our fair value (after the sell fee), or on the stop ----
  function exitReason(ctx) {
    const P = st.position; if (!P || !ctx.m || P.ticker !== ctx.m.ticker) return null;
    if (ctx.left < S.exitMinSecondsLeft) return null; // too late to trade out; settles
    const bid = P.side === "yes" ? ctx.top.yesBid : ctx.top.noBid; if (bid == null) return null;
    const left = P.count - P.sold;
    if (S.stopLossCents != null && bid <= P.entry - S.stopLossCents) return { why: "stop", bid };
    if (S.takeProfitCents != null && bid >= P.entry + S.takeProfitCents) return { why: "take-profit", bid };
    if (S.exitMode === "v32" && ctx.v32tick && v32s.pos) { v32s.pos.entry = P.entry; const w = v32Exit({ ...v32s, v32: v32s.v32 }, ctx.v32tick); if (w) return { why: "v32: " + w, bid }; return null; }
    if (S.exitMode === "edge" && ctx.ok && ctx.p != null) {
      const ps = P.side === "yes" ? ctx.p : 1 - ctx.p;
      const net = bid - feePerContractCents(bid, left, feeOpts());
      if (net - S.exitBufferCents > ps * 100) return { why: bid > P.entry ? "edge: profit" : "edge: cut", bid, fair: ps * 100 };
    }
    return null;
  }
  async function tryExit(ctx) {
    const P = st.position; const r = exitReason(ctx); if (!r) return { act: "hold" };
    const count = P.count - P.sold, limit = Math.max(1, r.bid - L.maxSellSlipCents);
    ev({ event: "SELL_SENT", mode: cfg.mode, ticker: P.ticker, side: P.side, count, limitCents: limit, bid: r.bid, why: r.why, fair: round(r.fair, 2), entry: P.entry });
    st.busy = true;
    try {
      const o = await broker.sell({ ticker: P.ticker, side: P.side, count, limitCents: limit });
      pushLat("orderMs", o.delayMs);
      ev({ event: "SELL_DONE", mode: cfg.mode, ticker: P.ticker, sold: o.filled, avgCents: round(o.avg, 2), feeDollars: o.feeDollars, delayMs: o.delayMs, apiMs: o.apiMs, why: r.why, raw: o.raw });
      if (o.filled) { P.sold += o.filled; P.proceeds += (o.avg * o.filled) / 100; P.exitFees += o.feeDollars; }
      if (P.sold >= P.count) closePosition("sold: " + r.why);
      save();
      return { act: o.filled ? "sold" : "sell-miss" };
    } catch (e) { ev({ event: "SELL_REJECTED", error: e.message }); notifier.notify("Sell refused: check Kalshi", e.message.slice(0, 300), 5, "rotating_light"); return { act: "error" }; }
    finally { st.busy = false; }
  }
  function closePosition(how, settlePayout = 0) {
    const P = st.position; if (!P) return;
    const pnl = P.proceeds + settlePayout - (P.entry * P.count) / 100 - P.entryFee - P.exitFees;
    const rec = { ticker: P.ticker, side: P.side, count: P.count, entry: P.entry, how, pnl: round(pnl, 4), fees: round(P.entryFee + P.exitFees, 4), t: Date.now(), mode: cfg.mode };
    st.closed.push(rec); st.position = null; v32s.pos = null; v32s.lastClose = Date.now(); if (v32s.v32) v32s.v32.lastClose = Date.now(); save();
    ev({ event: "POSITION_CLOSED", ...rec });
    notifier.notify(`${cfg.mode === "paper" ? "[paper] " : ""}${pnl >= 0 ? "Won" : "Lost"} $${Math.abs(pnl).toFixed(2)}`, `${how} · ${P.side === "yes" ? "Up" : "Down"} x${P.count} @ ${round(P.entry, 1)}c`, 3, pnl >= 0 ? "white_check_mark" : "x");
  }
  function dailyLoss(bal) {
    const today = new Date().toDateString();
    if (!st.dayStart || st.dayStart.day !== today) { st.dayStart = { day: today, balance: bal }; save(); return 0; }
    return st.dayStart.balance > 0 ? (st.dayStart.balance - bal) / st.dayStart.balance : 0;
  }

  // ---- the decision trigger (event driven, throttled) ----
  let lastEval = 0, pending = null, evalCount = 0;
  function trigger(eventRecvMs = Date.now()) {
    const wait = S.minDecisionIntervalMs - (Date.now() - lastEval);
    if (wait > 0) { if (!pending) pending = setTimeout(() => { pending = null; trigger(eventRecvMs); }, wait); return; }
    lastEval = Date.now();
    if (st.busy) return;
    const t0 = performance.now(); const ctx = compute(); const decided = performance.now();
    pushLat("decideUs", (decided - t0) * 1000); pushLat("eventToDecisionMs", Date.now() - eventRecvMs);
    evalCount++;
    st.lastCtx = ctx;
    const run = st.position ? tryExit(ctx) : tryEnter(ctx);
    run.then((r) => { st.lastDecision = { t: Date.now(), ...r }; if (r.act !== "none" && r.act !== "hold") ev({ event: "DECISION", ...r }); }).catch((e) => ev({ event: "ENGINE_ERROR", error: e.message }));
  }

  // ---- once per second: logging, samples, gap measurement, settlement ----
  let lastSampleSec = 0, lastStopCheck = 0;
  function onSecond(sec) {
    const now = Date.now();
    if (now - lastStopCheck > 1000) { st.stopFile = !!platform.stopActive(); lastStopCheck = now; }
    const m = kalshi.state.market;
    const ctx = st.lastCtx && now - st.lastCtx.now < 1500 ? st.lastCtx : compute(now);
    // per-second tick log
    const top = m ? kalshi.book(m.ticker).snapshotTop(3) : null, v = index.vol(sec);
    logger.write("ticks", {
      sec, ticker: m?.ticker, left: ctx.left != null ? round(ctx.left, 1) : null, strike: m?.strike, idx: round(index.at(sec), 2),
      ex: Object.fromEntries(Object.entries(index.ex).map(([n, e]) => [n, { b: e.bid, a: e.ask, bq: round(e.bidQty, 4), aq: round(e.askQty, 4), age: now - e.t }])),
      perp: index.perpMove(10000, now), sigma: round(v.sigma, 8), sShort: round(v.short, 8), sLong: round(v.long, 8), gapMean: round(gap.mean, 3), gapSd: round(gap.sd, 3),
      book: top, top: ctx.top, bookAgeMs: ctx.bookAgeMs, pK: round(ctx.pK), p0: round(ctx.p0), p: round(ctx.p), pSource: ctx.pSource, preds: ctx.preds ? Object.fromEntries(Object.entries(ctx.preds).map(([k, x]) => [k, round(x)])) : null,
      f: ctx.f ? Object.fromEntries(Object.entries(ctx.f).map(([k, x]) => [k, round(x)])) : null, pos: st.position, why: ctx.why, last: st.lastDecision?.why,
    });
    // training sample every sampleEverySec
    if (ctx.ok && ctx.row && sec - lastSampleSec >= S.sampleEverySec && ctx.left > 20 && ctx.left < 890) {
      lastSampleSec = sec; brain.addSample(ctx.row);
      const a = samplesByWin.get(ctx.row.win) || []; a.push(ctx.row); samplesByWin.set(ctx.row.win, a);
    }
    // gap at the open: Kalshi's strike is the 60s BRTI average before the open; compare with our average then
    if (m && m.strike && !st.gapOpenDone[m.ticker]) {
      const openSec = Math.floor(m.closeMs / 1000) - 900, ours = index.avg(openSec - 60, openSec);
      if (ours != null) { const g = gap.add("open", m.strike, ours); st.gapOpenDone[m.ticker] = true; ev({ event: "GAP_SAMPLE", kind: "open", ticker: m.ticker, official: m.strike, ours: round(ours, 2), gap: round(g, 2) }); }
      else if (sec - openSec > 120) st.gapOpenDone[m.ticker] = true; // weren't running then
    }
    // position from a market that has closed: wait for the official result
    if (st.position && now > st.position.closeMs) startSettle(st.position.ticker, st.position.closeMs);
    for (const [win, rows] of samplesByWin) { const closeMs = kalshi.state.lastClose?.[win] ?? (rows[0].t + rows[0].left * 1000); if (now > closeMs + 3000) startSettle(win, closeMs); }
    if (sec % 60 === 0) { save(); }
  }

  async function startSettle(ticker, closeMs) {
    if (st.settling[ticker]) return; st.settling[ticker] = { since: Date.now() };
    const closeSec = Math.floor(closeMs / 1000), oursClose = index.avg(closeSec - 60, closeSec);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 3000 : 3000));
      let res; try { res = await kalshi.marketResult(ticker); } catch (e) { continue; }
      if (res.result !== "yes" && res.result !== "no") continue;
      const y = res.result === "yes" ? 1 : 0;
      let g = null; if (res.expirationValue && oursClose) g = gap.add("close", res.expirationValue, oursClose);
      const rows = samplesByWin.get(ticker) || []; samplesByWin.delete(ticker);
      const settledTs = Date.now();
      for (const r of rows) logger.write("samples", { ...r, y, settledTs });
      const evr = rows.length ? brain.settle(ticker, y) : (brain.dropPending(ticker), null);
      let pnl = null;
      if (st.position && st.position.ticker === ticker) {
        const P = st.position, left = P.count - P.sold, won = (P.side === "yes") === (y === 1);
        broker.settle(ticker, res.result);
        closePosition(won ? "settled: won" : "settled: lost", won ? left : 0); pnl = st.closed[st.closed.length - 1].pnl;
        if (cfg.mode === "real") kalshi.refreshBalance().catch(() => {});
      } else broker.settle(ticker, res.result);
      logger.write("windows", { ticker, result: res.result, strike: res.strike, expirationValue: res.expirationValue, oursClose: round(oursClose, 2), gapClose: round(g, 2), gapMean: round(gap.mean, 3), gapSd: round(gap.sd, 3), samples: rows.length, oos: evr ? { ll: evr.ll, trade: evr.trade } : null, positionPnl: pnl, brainFitMs: brain.lastFitMs, accepted: [...brain.accepted], trusted: brain.trusted() });
      delete st.win[ticker]; delete st.gapOpenDone[ticker];
      delete st.settling[ticker]; save();
      return;
    }
    ev({ event: "SETTLE_GAVE_UP", ticker }); delete st.settling[ticker];
  }

  function stats() {
    const c = st.closed.filter((x) => x.mode === cfg.mode), m = meanSd(c.map((x) => x.pnl));
    return { trades: m.n, wins: c.filter((x) => x.pnl > 0).length, totalPnl: round(m.mean * m.n, 2), avgPnl: round(m.mean, 3), ci95: m.n > 1 ? [round((m.mean - 1.96 * m.se) * m.n, 2), round((m.mean + 1.96 * m.se) * m.n, 2)] : null, fees: round(c.reduce((s, x) => s + (x.fees || 0), 0), 2), recent: c.slice(-15).reverse() };
  }
  function latency() {
    const q = (a, p) => (a.length ? round(percentile(a, p), 3) : null);
    return { decideUsP50: q(lat.decideUs, 0.5), decideUsP99: q(lat.decideUs, 0.99), eventToDecisionMsP50: q(lat.eventToDecisionMs, 0.5), eventToDecisionMsP99: q(lat.eventToDecisionMs, 0.99), orderMsP50: q(lat.orderMs, 0.5), decisions: evalCount, ...kalshi.latency() };
  }

  return { st, brain, gap, compute, trigger, onSecond, replayBrain, stats, latency, save, edgeAt, exitReason, entryBlock, bestEntry, closePosition, startSettle };
}
