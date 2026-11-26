// Paper-trading bot for Kalshi's BTC 15-minute markets (KXBTC15M).
// PAPER ONLY: it never logs in to Kalshi and cannot place real orders.
//
// Run:   node bot/bot.mjs
// Open:  http://localhost:8787
//
// Every 2 seconds it reads the live Kalshi market (public data, no key needed) and the
// BTC price from Coinbase, records the tick to bot/data/ticks-YYYY-MM-DD.csv for
// backtesting, and runs the strategy in strategy.mjs with fake money.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, newState, onTick, settle, scoreboard } from './strategy.mjs';
import { findPatterns } from './finder.mjs';
import { loadTicks } from './backtest.mjs';
import { parseBook } from './book.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
fs.mkdirSync(DATA, { recursive: true });
const STATE_FILE = path.join(DATA, 'state.json');
const TRADES_FILE = path.join(DATA, 'trades.csv');
const KALSHI = process.env.KALSHI_URL || 'https://api.elections.kalshi.com/trade-api/v2';
const PRICE_URL = process.env.PRICE_URL || 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const PORT = +(process.env.PORT || 8787);
const cfg = { ...DEFAULTS };

let s = newState(cfg);
try { s = { ...s, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; console.log(`Loaded saved paper state: ${s.trades.length} trades.`); } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, window: null }, null, 1));

const log = [];
function note(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  console.log(line); log.unshift(line); log.length = Math.min(log.length, 40);
}

const cents = (c, d) => Number.isFinite(+c) && c !== null ? +c
  : (d != null && Number.isFinite(parseFloat(d)) ? Math.round(parseFloat(d) * 100) : NaN);

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function currentMarket() {
  const now = Date.now();
  const pick = list => (list || [])
    .filter(m => Date.parse(m.close_time) > now && (!m.open_time || Date.parse(m.open_time) <= now + 5000))
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0];
  let m = null;
  try { m = pick((await getJSON(`${KALSHI}/markets?series_ticker=KXBTC15M&status=open&limit=20`)).markets); } catch {}
  // right as a window rolls over, the "open" list can be empty for a moment: look it up by close time instead
  if (!m) {
    const t = Math.floor(now / 1000);
    m = pick((await getJSON(`${KALSHI}/markets?series_ticker=KXBTC15M&min_close_ts=${t}&max_close_ts=${t + 1800}&limit=20`)).markets);
  }
  if (!m) throw new Error('no open KXBTC15M market (between windows?)');
  const strike = +(m.floor_strike ?? m.cap_strike);
  if (!Number.isFinite(strike) || !strike) throw new Error(`strike not posted yet for ${m.ticker}`);
  const out = {
    ticker: m.ticker,
    closeTs: Date.parse(m.close_time),
    strike,
    yesBid: cents(m.yes_bid, m.yes_bid_dollars), yesAsk: cents(m.yes_ask, m.yes_ask_dollars),
    noBid: cents(m.no_bid, m.no_bid_dollars), noAsk: cents(m.no_ask, m.no_ask_dollars),
    src: 'list',
  };
  // The market LIST only refreshes its prices about every 30 seconds. Trading off it makes Kalshi look
  // "slow" when it isn't, and paper trades fill at prices that are already gone. Use the live order book.
  // Kalshi's reply key is `orderbook_fp` now (it used to be `orderbook`); reading only the old key left
  // every tick on stale list prices (runs on Nov 25-26: "quotes list", Live prices ❌). parseBook reads both.
  try {
    const b = parseBook(await getJSON(`${KALSHI}/markets/${m.ticker}/orderbook`));
    if (b) Object.assign(out, b, { src: 'book' });
  } catch {}
  return out;
}

async function btcPrice() {
  const j = await getJSON(PRICE_URL);
  return +j.price;
}

// recent Coinbase trades -> buy/sell pressure (the page's trade-flow signal)
const TRADES_URL = process.env.TRADES_URL || 'https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=100';
let flow = [], seenTrade = new Set();
async function tradeFlow(now) {
  try {
    const list = await getJSON(TRADES_URL);
    for (const x of list) {
      if (seenTrade.has(x.trade_id)) continue;
      seenTrade.add(x.trade_id);
      // Coinbase's "side" is the resting order's side, so a taker BUY shows as side "sell"
      flow.push({ t: Date.parse(x.time), sz: +x.size, buy: x.side === 'sell' });
    }
  } catch {}
  flow = flow.filter(x => x.t > now - 60_000);
  if (seenTrade.size > 5000) seenTrade = new Set([...seenTrade].slice(-2000));
  const imb = ms => { let b = 0, sl = 0; for (const x of flow) if (x.t > now - ms) x.buy ? (b += x.sz) : (sl += x.sz); return b + sl ? (b - sl) / (b + sl) : 0; };
  return { imb5: +imb(5000).toFixed(3), imb60: +imb(60_000).toFixed(3) };
}

async function marketResult(ticker) {
  try {
    const j = await getJSON(`${KALSHI}/markets/${ticker}`);
    if (j.market?.result === 'yes') return true;
    if (j.market?.result === 'no') return false;
  } catch {}
  return null;
}

function recordTick(t) {
  const f = path.join(DATA, `ticks-${new Date(t.t).toISOString().slice(0, 10)}.csv`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, 't,ticker,closeTs,strike,btc,yesBid,yesAsk,noBid,noAsk,imb5,imb60\n');
  fs.appendFileSync(f, [t.t, t.ticker, t.closeTs, t.strike, t.btc, t.yesBid, t.yesAsk, t.noBid, t.noAsk, t.imb5, t.imb60].join(',') + '\n');
}
function recordTrade(tr) {
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, 'closedAt,ticker,side,contracts,entry,exit,reason,pnl\n');
  fs.appendFileSync(TRADES_FILE, [new Date(tr.closedAt).toISOString(), tr.ticker, tr.side, tr.contracts, tr.entry, tr.exit, tr.reason, tr.pnl].join(',') + '\n');
}

let lastStatus = 0, quoteChanges = 0, quoteTicks = 0, lastQuote = '', bookTicks = 0;
let last = null, lastErr = '', pendingSettle = null, finderNote = 'not run yet', windowsRecorded = 0;

// Every 6 hours, search the recorded data for new patterns (see finder.mjs).
function runFinder() {
  try {
    const r = findPatterns(loadTicks(DATA));
    cfg.patterns = r.promoted.map(p => p.key);
    windowsRecorded = r.windows;
    fs.writeFileSync(path.join(DATA, 'patterns.json'), JSON.stringify({ createdAt: new Date().toISOString(), windows: r.windows,
      patterns: r.promoted.map(p => ({ key: p.key, testTrades: p.test.n, testEdgeCents: +p.test.mean.toFixed(2) })) }, null, 1));
    finderNote = `${new Date().toLocaleTimeString()}: ${r.windows} windows searched, ${cfg.patterns.length} pattern(s) passed the held-back test`;
    note(`pattern finder: ${finderNote}`);
  } catch (e) { finderNote = `error: ${e.message}`; }
}

async function loop() {
  try {
    const now0 = Date.now();
    const [m, btc, fl] = await Promise.all([currentMarket(), btcPrice(), tradeFlow(now0)]);
    const tick = { t: now0, btc, ...m, ...fl };

    // a position from a window that has closed: settle it from Kalshi's result
    if (s.pos && s.pos.ticker !== tick.ticker) {
      pendingSettle ??= { ticker: s.pos.ticker, lastYes: last && last.ticker === s.pos.ticker ? last.btc >= last.strike : null, since: Date.now() };
      const res = await marketResult(pendingSettle.ticker);
      const waited = Date.now() - pendingSettle.since > 10 * 60_000;
      if (res !== null || waited) {
        const yesWon = res ?? pendingSettle.lastYes ?? false;
        const tr = settle(s, tick, yesWon);
        if (tr) { recordTrade(tr); note(`SETTLED ${tr.side} → ${tr.exit === 100 ? 'WON' : 'lost'}, pnl $${tr.pnl}${res === null ? ' (estimated)' : ''}`); }
        pendingSettle = null;
      }
    }

    const q = `${tick.ticker}${tick.yesBid}/${tick.yesAsk}`;
    quoteTicks++; if (q !== lastQuote) quoteChanges++; lastQuote = q; if (tick.src === 'book') bookTicks++;
    recordTick(tick);
    const before = s.trades.length;
    for (const e of onTick(s, tick, cfg)) note(e);
    for (const tr of s.trades.slice(before)) recordTrade(tr);
    if (lastErr) note(`data back (${lastErr.slice(0, 60)} cleared)`);
    last = tick; lastErr = '';
    if (Date.now() - lastStatus >= 60_000) {   // one status line a minute so the log shows it's alive
      lastStatus = Date.now();
      const sb = scoreboard(s), gap = tick.btc - tick.strike, secs = Math.round((tick.closeTs - tick.t) / 1000);
      note(`status · ${tick.ticker} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left · BTC ${gap >= 0 ? '+' : ''}${gap.toFixed(0)} vs strike · Up ${tick.yesAsk}¢ Down ${tick.noAsk}¢ · paper $${sb.bankroll} · ${sb.trades} trades · quotes ${tick.src} (changed on ${quoteTicks ? Math.round(quoteChanges / quoteTicks * 100) : 0}% of seconds)${s.pos ? ` · holding ${s.pos.side === 'no' ? 'Down' : 'Up'} @ ${s.pos.entry}¢` : ''}`);
    }
    save();
  } catch (e) {
    if (String(e.message) !== lastErr) note(`data error: ${e.message}`);
    lastErr = String(e.message);
  }
  setTimeout(loop, 1000);   // every second, like the page
}

function page() {
  const sb = scoreboard(s);
  const t = last;
  const secs = t ? Math.max(0, Math.round((t.closeTs - Date.now()) / 1000)) : 0;
  const gap = t ? t.btc - t.strike : 0;
  const pos = s.pos ? `${s.pos.side === 'no' ? 'Down' : 'Up'} ${s.pos.contracts} @ ${s.pos.entry}¢` : 'none';
  const ord = s.order ? `${s.order.side === 'no' ? 'Down' : 'Up'} ${s.order.contracts} @ ${s.order.price}¢ (waiting to fill)` : 'none';
  const color = sb.verdict.startsWith('EDGE') ? '#22c55e' : sb.verdict.startsWith('NO') ? '#ef4444' : '#eab308';
  const rows = s.trades.slice(-15).reverse().map(x =>
    `<tr><td>${new Date(x.closedAt).toLocaleTimeString()}</td><td>${x.side}</td><td>${x.entry}¢→${x.exit}¢</td><td>${x.reason}</td><td style="color:${x.pnl > 0 ? '#22c55e' : '#ef4444'}">$${x.pnl}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3"><title>BTC 15m paper bot</title>
<style>body{background:#0b0d10;color:#e9edf2;font:15px -apple-system,system-ui,sans-serif;margin:0;padding:16px;max-width:640px}
.box{background:#14171c;border:1px solid #252a31;border-radius:12px;padding:14px;margin-bottom:12px}
h1{font-size:17px;margin:0 0 4px}.dim{color:#7d8794;font-size:13px}.big{font-size:22px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:4px 2px;border-top:1px solid #252a31}</style></head><body>
<div class="box"><h1>📄 PAPER ONLY — fake money</h1><div class="dim">Your bounce rule, plus any patterns the finder proved on data it hadn't seen.</div></div>
<div class="box"><div class="big" style="color:${color}">${sb.verdict}</div>
<div>Paper $${sb.bankroll} · P&amp;L $${sb.pnl} · ${sb.wins}/${sb.trades} won (${sb.winRate}%) · break-even ${sb.breakEvenPct}%</div></div>
<div class="box"><div class="dim">${t ? t.ticker : 'waiting for data'} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left</div>
<div>BTC $${t ? t.btc.toFixed(0) : '-'} · strike $${t ? t.strike.toFixed(0) : '-'} · <b>${gap >= 0 ? '+' : ''}${gap.toFixed(0)}</b></div>
<div>Up ${t?.yesBid}/${t?.yesAsk}¢ · Down ${t?.noBid}/${t?.noAsk}¢</div>
<div style="margin-top:6px">Signal: ${s.lastSignal || '-'}</div><div>Order: ${ord}</div><div>Holding: ${pos}</div>
${lastErr ? `<div style="color:#ef4444">data error: ${lastErr}</div>` : ''}</div>
<div class="box"><b>🔎 Patterns it found</b><div class="dim">${finderNote}</div>
${cfg.patterns.map(k => { const st = s.patternStats?.[k]; const dropped = st && st.n >= cfg.dropAfterTrades && st.pnl < 0;
  return `<div style="font-size:13px;margin-top:4px">${dropped ? '🚫' : '•'} ${k}${st ? ` — paper ${st.n} trades, $${st.pnl}` : ''}</div>`; }).join('') || '<div class="dim">none yet: needs more recorded data</div>'}</div>
<div class="box"><b>Last trades</b><table>${rows || '<tr><td class="dim">none yet</td></tr>'}</table></div>
<div class="box"><b>Log</b><div class="dim" style="white-space:pre-wrap">${log.join('\n')}</div></div></body></html>`;
}

http.createServer((req, res) => {
  if (req.url === '/api') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ scoreboard: scoreboard(s), state: s, last, patterns: cfg.patterns, finderNote, log, windowsRecorded }));
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/simple') return res.end(page());
  res.end(fs.readFileSync(path.join(DIR, 'dashboard.html')));
}).listen(PORT, () => {
  note(`Paper bot running (no real money). Open http://localhost:${PORT}`);
  runFinder();
  setInterval(runFinder, 6 * 3600_000);
  loop();
});
