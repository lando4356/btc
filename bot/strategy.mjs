// Strategy + paper broker. Pure logic: the live bot and the backtester both feed it ticks.
//
// One entry rule, taken from Landan's manual trading:
//   "In a downtrend, when BTC bounces up for a moment, buy Down cheap (20-30c) and ride it."
// The bounce pushes BTC above the strike, so Down gets cheap even though the bigger
// trend (the last 30 minutes, across windows) is still falling.
// Mirrored for uptrends ("buy Up cheap on a dip in a steady climb").
//
// Orders are RESTING limit orders (maker). Kalshi charges no maker fee on KXBTC15M,
// so entries cost nothing in fees. A paper order only counts as filled when the
// market's ask trades THROUGH our price (ask < our bid), which is stricter than real
// life on purpose, so paper results are not flattered.

import { features, patternKeys } from './features.mjs';

export const DEFAULTS = {
  // when we are allowed to enter (seconds left in the 15-minute window)
  enterMaxSecsLeft: 12 * 60,   // not in the first 3 minutes
  enterMinSecsLeft: 3 * 60,    // not in the last 3 minutes
  // trend: BTC must have moved this much over the last 30 minutes (across windows)
  trendMoveUsd: 80,
  trendLookbackSecs: 1800,
  // bounce: BTC moves back toward the strike by this much off its recent extreme
  bounceUsd: 25,
  bounceLookbackSecs: 180,
  // entry price band for the side we buy (cents)
  minEntry: 15,
  maxEntry: 30,
  orderLifeSecs: 90,           // cancel a resting order that hasn't filled after this
  // exits
  trailFromCents: 85,          // once our side's bid reaches 85c, protect it...
  trailDropCents: 10,          // ...sell if it falls 10c from its high
  loserExitSecsLeft: 120,      // with 2 min left, sell a losing position instead of riding it to 0
  // sizing (paper)
  startBankroll: 30,
  stakeUsd: 3,                 // fixed small stake per trade
  maxStakePct: 0.10,           // never more than 10% of bankroll
  enableDownRule: true,
  enableUpRule: true,
  // patterns the finder promoted (finder.mjs). Bought at the ask, held to the end, same as tested.
  patterns: [],
  dropAfterTrades: 30,         // a learned pattern that is losing after 30 paper trades is dropped
};

// Kalshi taker fee: ceil(0.07 * C * P * (1-P)) dollars. Returns cents.
export function takerFeeCents(contracts, priceCents) {
  const p = priceCents / 100;
  return Math.ceil(7 * contracts * p * (1 - p) - 1e-9);
}

export function newState(cfg = DEFAULTS) {
  return {
    bankroll: cfg.startBankroll,
    hist: [],            // recent BTC prices [{t, btc}], kept across windows
    window: null,        // { ticker, closeTs, strike, traded }
    order: null,         // resting paper order
    pos: null,           // open paper position
    trades: [],          // closed trades
    patternStats: {},    // learned pattern -> { n, pnl } in live paper trading
    lastSignal: '',
  };
}

function extremeSince(hist, sinceT, fn) {
  let v = null;
  for (const h of hist) if (h.t >= sinceT) v = v === null ? h.btc : fn(v, h.btc);
  return v;
}
function valueAt(hist, t) {
  let v = null;
  for (const h of hist) { if (h.t <= t) v = h.btc; else break; }
  return v;
}

// side: 'no' = Down, 'yes' = Up
function sideQuotes(tick, side) {
  return side === 'no'
    ? { bid: tick.noBid, ask: tick.noAsk }
    : { bid: tick.yesBid, ask: tick.yesAsk };
}

function closePos(s, tick, exitCents, reason, fee) {
  const p = s.pos;
  const gross = (exitCents - p.entry) * p.contracts;      // cents
  const pnl = (gross - fee - (p.entryFee || 0)) / 100;    // dollars (bounce entries are maker: no fee)
  s.bankroll += p.contracts * exitCents / 100 - fee / 100;
  s.trades.push({
    ticker: p.ticker, side: p.side === 'no' ? 'Down' : 'Up', contracts: p.contracts,
    entry: p.entry, exit: exitCents, reason, pnl: +pnl.toFixed(2),
    win: pnl > 0, openedAt: p.t, closedAt: tick.t, rule: p.pattern || 'bounce',
  });
  if (p.pattern) {
    const st = (s.patternStats ??= {})[p.pattern] ??= { n: 0, pnl: 0 };
    st.n++; st.pnl = +(st.pnl + pnl).toFixed(2);
  }
  s.pos = null;
  return s.trades[s.trades.length - 1];
}

// Settle a position when its window has closed. yesWon: true/false.
export function settle(s, tick, yesWon) {
  if (!s.pos) return null;
  const won = (s.pos.side === 'yes') === yesWon;
  return closePos(s, tick, won ? 100 : 0, 'settled', 0);
}

// Feed one tick. tick = { t(ms), ticker, closeTs(ms), strike, btc, yesBid, yesAsk, noBid, noAsk } (cents)
// Returns a list of events (strings) for logging.
export function onTick(s, tick, cfg = DEFAULTS) {
  const ev = [];
  if (!tick || !tick.ticker || !Number.isFinite(tick.btc) || !Number.isFinite(tick.strike)) return ev;

  // new window
  if (!s.window || s.window.ticker !== tick.ticker) {
    if (s.order) { ev.push(`cancel order (window ended)`); s.order = null; }
    s.window = { ticker: tick.ticker, closeTs: tick.closeTs, strike: tick.strike, traded: false };
  }
  const w = s.window;
  s.hist ??= [];
  // a gap in data (bot was off) makes old history meaningless
  if (s.hist.length && tick.t - s.hist[s.hist.length - 1].t > 60_000) s.hist = [];
  s.hist.push({ t: tick.t, btc: tick.btc });
  while (s.hist.length && s.hist[0].t < tick.t - (cfg.trendLookbackSecs + 120) * 1000) s.hist.shift();
  const secsLeft = (tick.closeTs - tick.t) / 1000;

  // ---- manage open position ----
  if (s.pos && s.pos.ticker === tick.ticker && !s.pos.holdToEnd) {
    const q = sideQuotes(tick, s.pos.side);
    if (Number.isFinite(q.bid)) {
      s.pos.peak = Math.max(s.pos.peak, q.bid);
      if (s.pos.peak >= cfg.trailFromCents && q.bid <= s.pos.peak - cfg.trailDropCents && q.bid > s.pos.entry) {
        const t = closePos(s, tick, q.bid, 'trail stop', takerFeeCents(s.pos.contracts, q.bid));
        ev.push(`SELL ${t.side} ${t.contracts} @ ${t.exit}c (trail) pnl $${t.pnl}`);
      } else if (secsLeft <= cfg.loserExitSecsLeft && q.bid < s.pos.entry && q.bid >= 1) {
        const t = closePos(s, tick, q.bid, 'loser exit', takerFeeCents(s.pos.contracts, q.bid));
        ev.push(`SELL ${t.side} ${t.contracts} @ ${t.exit}c (cut loser) pnl $${t.pnl}`);
      }
    }
  }

  // ---- manage resting order ----
  if (s.order) {
    const o = s.order;
    const q = sideQuotes(tick, o.side);
    const past = valueAt(s.hist, tick.t - cfg.trendLookbackSecs * 1000);
    const move = past === null ? 0 : tick.btc - past;
    const trendGone = o.side === 'no' ? move >= 0 : move <= 0;
    if (Number.isFinite(q.ask) && q.ask < o.price) {
      s.pos = { ticker: o.ticker, side: o.side, contracts: o.contracts, entry: o.price, peak: o.price, t: tick.t };
      s.bankroll -= o.contracts * o.price / 100;
      w.traded = true;
      s.order = null;
      ev.push(`FILLED ${o.side === 'no' ? 'Down' : 'Up'} ${o.contracts} @ ${o.price}c`);
    } else if (trendGone || secsLeft < cfg.enterMinSecsLeft - 60 || tick.t - o.t > cfg.orderLifeSecs * 1000) {
      ev.push(`cancel order (${trendGone ? 'trend flipped' : 'timed out'})`);
      s.order = null;
    }
  }

  // ---- look for a new entry ----
  s.lastSignal = '';
  if (s.pos || s.order || w.traded) return ev;
  if (secsLeft > cfg.enterMaxSecsLeft) { s.lastSignal = 'too early in window'; return ev; }
  if (secsLeft < cfg.enterMinSecsLeft) { s.lastSignal = 'too late in window'; return ev; }

  // learned patterns first: they were tested as "buy at the ask, hold to the end"
  if (cfg.patterns?.length) {
    const f = features(s.hist, tick);
    if (f) for (const side of ['yes', 'no']) {
      const ask = side === 'yes' ? tick.yesAsk : tick.noAsk;
      if (!(ask >= 3 && ask <= 97)) continue;
      const live = cfg.patterns.filter(k => { const st = s.patternStats?.[k]; return !(st && st.n >= cfg.dropAfterTrades && st.pnl < 0); });
      const hit = patternKeys(f, side, ask).find(k => live.includes(k));
      if (!hit) continue;
      const stake = Math.min(cfg.stakeUsd, s.bankroll * cfg.maxStakePct);
      const contracts = Math.floor(stake * 100 / ask);
      if (contracts < 1) { s.lastSignal = 'bankroll too small'; return ev; }
      const entryFee = takerFeeCents(contracts, ask);
      s.pos = { ticker: tick.ticker, side, contracts, entry: ask, peak: ask, t: tick.t, holdToEnd: true, pattern: hit, entryFee };
      s.bankroll -= (contracts * ask + entryFee) / 100;
      w.traded = true;
      ev.push(`BUY ${side === 'no' ? 'Down' : 'Up'} ${contracts} @ ${ask}c (learned: ${hit})`);
      return ev;
    }
  }

  const gap = tick.btc - w.strike;
  const past = valueAt(s.hist, tick.t - cfg.trendLookbackSecs * 1000);
  if (past === null || s.hist[0].t > tick.t - cfg.trendLookbackSecs * 1000 + 5000) {
    s.lastSignal = `collecting price history (needs ${cfg.trendLookbackSecs / 60} min)`; return ev;
  }
  const move = tick.btc - past;
  const since = tick.t - cfg.bounceLookbackSecs * 1000;

  let side = null, why = '';
  if (cfg.enableDownRule && move <= -cfg.trendMoveUsd) {
    const low = extremeSince(s.hist, since, Math.min);
    const bounce = tick.btc - low;
    if (bounce >= cfg.bounceUsd) { side = 'no'; why = `downtrend, bounced +$${bounce.toFixed(0)} off low`; }
    else s.lastSignal = `downtrend, waiting for a bounce (+$${bounce.toFixed(0)} of $${cfg.bounceUsd})`;
  } else if (cfg.enableUpRule && move >= cfg.trendMoveUsd) {
    const high = extremeSince(s.hist, since, Math.max);
    const dip = high - tick.btc;
    if (dip >= cfg.bounceUsd) { side = 'yes'; why = `uptrend, dipped -$${dip.toFixed(0)} off high`; }
    else s.lastSignal = `uptrend, waiting for a dip (-$${dip.toFixed(0)} of $${cfg.bounceUsd})`;
  } else {
    s.lastSignal = `no trend (BTC ${move >= 0 ? '+' : ''}${move.toFixed(0)} in 30m, needs ±${cfg.trendMoveUsd}; ${gap >= 0 ? '+' : ''}${gap.toFixed(0)} vs strike)`;
  }
  if (!side) return ev;

  const q = sideQuotes(tick, side);
  if (!Number.isFinite(q.ask) || !Number.isFinite(q.bid)) { s.lastSignal = 'no quotes'; return ev; }
  // only when our side is actually cheap; rest a bid just under the ask so we are a maker
  if (q.ask > cfg.maxEntry + 5) { s.lastSignal = `${why}, but ${side === 'no' ? 'Down' : 'Up'} is ${q.ask}c (want ≤${cfg.maxEntry}c)`; return ev; }
  const price = Math.min(cfg.maxEntry, q.ask - 1);
  if (price < cfg.minEntry) { s.lastSignal = `${why}, but price too low (${q.ask}c ask)`; return ev; }
  const stake = Math.min(cfg.stakeUsd, s.bankroll * cfg.maxStakePct);
  const contracts = Math.floor(stake * 100 / price);
  if (contracts < 1) { s.lastSignal = 'bankroll too small'; return ev; }
  s.order = { ticker: tick.ticker, side, price, contracts, t: tick.t, why };
  ev.push(`BID ${side === 'no' ? 'Down' : 'Up'} ${contracts} @ ${price}c (resting) — ${why}`);
  return ev;
}

export function scoreboard(s) {
  const n = s.trades.length;
  const wins = s.trades.filter(t => t.win).length;
  const pnl = s.trades.reduce((a, t) => a + t.pnl, 0);
  const avgEntry = n ? s.trades.reduce((a, t) => a + t.entry, 0) / n : 0;
  const winRate = n ? wins / n : 0;
  // with hold-to-settle, you need to win about entry/100 of the time to break even
  const breakEven = avgEntry / 100;
  let verdict;
  if (n < 100) verdict = `NOT PROVEN — ${n}/100 paper trades`;
  else if (pnl > 0 && winRate > breakEven + 0.05) verdict = 'EDGE SHOWING — still paper, review before real money';
  else verdict = 'NO EDGE — do not use real money';
  return { trades: n, wins, winRate: +(winRate * 100).toFixed(1), breakEvenPct: +(breakEven * 100).toFixed(1),
    pnl: +pnl.toFixed(2), bankroll: +s.bankroll.toFixed(2), verdict };
}
