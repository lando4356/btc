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
  const j = await getJSON(`${KALSHI}/markets?series_ticker=KXBTC15M&status=open&limit=10`);
  const now = Date.now();
  const m = (j.markets || [])
    .filter(m => Date.parse(m.close_time) > now)
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0];
  if (!m) throw new Error('no open KXBTC15M market');
  return {
    ticker: m.ticker,
    closeTs: Date.parse(m.close_time),
    strike: +(m.floor_strike ?? m.cap_strike),
    yesBid: cents(m.yes_bid, m.yes_bid_dollars), yesAsk: cents(m.yes_ask, m.yes_ask_dollars),
    noBid: cents(m.no_bid, m.no_bid_dollars), noAsk: cents(m.no_ask, m.no_ask_dollars),
  };
}

async function btcPrice() {
  const j = await getJSON(PRICE_URL);
  return +j.price;
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
  if (!fs.existsSync(f)) fs.writeFileSync(f, 't,ticker,closeTs,strike,btc,yesBid,yesAsk,noBid,noAsk\n');
  fs.appendFileSync(f, [t.t, t.ticker, t.closeTs, t.strike, t.btc, t.yesBid, t.yesAsk, t.noBid, t.noAsk].join(',') + '\n');
}
function recordTrade(tr) {
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, 'closedAt,ticker,side,contracts,entry,exit,reason,pnl\n');
  fs.appendFileSync(TRADES_FILE, [new Date(tr.closedAt).toISOString(), tr.ticker, tr.side, tr.contracts, tr.entry, tr.exit, tr.reason, tr.pnl].join(',') + '\n');
}

let last = null, lastErr = '', pendingSettle = null;

async function loop() {
  try {
    const [m, btc] = await Promise.all([currentMarket(), btcPrice()]);
    const tick = { t: Date.now(), btc, ...m };

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

    recordTick(tick);
    const before = s.trades.length;
    for (const e of onTick(s, tick, cfg)) note(e);
    for (const tr of s.trades.slice(before)) recordTrade(tr);
    last = tick; lastErr = '';
    save();
  } catch (e) {
    if (String(e.message) !== lastErr) note(`data error: ${e.message}`);
    lastErr = String(e.message);
  }
  setTimeout(loop, 2000);
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
<div class="box"><h1>📄 PAPER ONLY — fake money</h1><div class="dim">Rule: in a trend, wait for a bounce against it, rest a cheap limit bid (no fee), hold.</div></div>
<div class="box"><div class="big" style="color:${color}">${sb.verdict}</div>
<div>Paper $${sb.bankroll} · P&amp;L $${sb.pnl} · ${sb.wins}/${sb.trades} won (${sb.winRate}%) · break-even ${sb.breakEvenPct}%</div></div>
<div class="box"><div class="dim">${t ? t.ticker : 'waiting for data'} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left</div>
<div>BTC $${t ? t.btc.toFixed(0) : '-'} · strike $${t ? t.strike.toFixed(0) : '-'} · <b>${gap >= 0 ? '+' : ''}${gap.toFixed(0)}</b></div>
<div>Up ${t?.yesBid}/${t?.yesAsk}¢ · Down ${t?.noBid}/${t?.noAsk}¢</div>
<div style="margin-top:6px">Signal: ${s.lastSignal || '-'}</div><div>Order: ${ord}</div><div>Holding: ${pos}</div>
${lastErr ? `<div style="color:#ef4444">data error: ${lastErr}</div>` : ''}</div>
<div class="box"><b>Last trades</b><table>${rows || '<tr><td class="dim">none yet</td></tr>'}</table></div>
<div class="box"><b>Log</b><div class="dim" style="white-space:pre-wrap">${log.join('\n')}</div></div></body></html>`;
}

http.createServer((req, res) => {
  if (req.url === '/api') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ scoreboard: scoreboard(s), state: s, last })); }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page());
}).listen(PORT, () => {
  note(`Paper bot running (no real money). Open http://localhost:${PORT}`);
  loop();
});
