// Kalshi real-money bot for the BTC radar page.
// Runs on your Mac. Serves the radar page at http://localhost:8787, relays Kalshi
// market data, and places REAL orders when the page's hold model calls a bet.
//
//   node kalshi-bot.mjs check   -> logs in, shows your balance and the current market. Places NO orders.
//   node kalshi-bot.mjs         -> starts the bot (real money)
//
// Kill switch: press Ctrl+C, or create a file named STOP in this folder (bot refuses all new orders).
// No installs needed beyond Node 18+.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));

// ---- hard limits (the page cannot override these) ----
const LIMITS = {
  maxFrac: Math.min(CFG.maxBetFraction ?? 0.25, 0.25), // never more than 25% of the balance on one bet
  floorDollars: Math.max(CFG.stopBelowDollars ?? 15, 1), // stop trading if the balance falls below this
  minPrice: 20, maxPrice: 50,                            // only buys contracts priced 20-50 cents (same as the model)
  maxSlip: 1,                                            // pays at most 1 cent more than the price the page saw
  minSecondsLeft: 120,                                   // never buys in the last 2 minutes of a window
  maxContracts: CFG.maxContractsPerBet ?? 200,           // extra cap per bet
};
const API = CFG.apiBase || "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const PORT = CFG.port || 8787;
const ORIGIN = `http://localhost:${PORT}`;
const STATE_FILE = path.join(DIR, "bot-state.json");
const LOG_FILE = path.join(DIR, "trades.log");
const STOP_FILE = path.join(DIR, "STOP");

// ---- signing ----
const keyPath = path.isAbsolute(CFG.privateKeyPath) ? CFG.privateKeyPath : path.join(DIR, CFG.privateKeyPath);
const PRIV = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
function sign(ts, method, p) {
  const msg = Buffer.from(ts + method + p);
  const sig = PRIV.asymmetricKeyType === "ed25519"
    ? crypto.sign(null, msg, PRIV)
    : crypto.sign("sha256", msg, { key: PRIV, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  return sig.toString("base64");
}
async function kalshi(method, p, body, tries = 0) {
  try { return await kalshiOnce(method, p, body); }
  catch (e) { if (e.status === 429 && tries < 4) { await new Promise((r) => setTimeout(r, 700 * (tries + 1))); return kalshi(method, p, body, tries + 1); } throw e; } // Kalshi said "too many requests": wait and retry
}
async function kalshiOnce(method, p, body) {
  const url = new URL(API + p);
  const ts = String(Date.now());
  const headers = { Accept: "application/json", "KALSHI-ACCESS-KEY": CFG.keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sign(ts, method, url.pathname) };
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(`Kalshi ${method} ${url.pathname} -> ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; e.body = j; throw e; }
  return j;
}

// ---- Kalshi order format (V2, /portfolio/events/orders) ----
// Every order is placed on the YES side: "bid" = buy YES, "ask" = sell YES.
// Buying NO at q cents  = selling YES at (100 - q).   Selling NO at q cents = buying YES at (100 - q).
function yesOrder(side, action, cents) {
  const buyYes = (side === "yes") === (action === "buy");
  const yesCents = side === "yes" ? cents : 100 - cents;
  return { side: buyYes ? "bid" : "ask", price: (yesCents / 100).toFixed(2) };
}
async function placeOrder({ ticker, side, action, count, cents, reduceOnly }) {
  const o = yesOrder(side, action, cents);
  const body = { ticker, client_order_id: crypto.randomUUID(), side: o.side, count: String(count), price: o.price,
    time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross" };
  if (reduceOnly) body.reduce_only = true; // a sell can never open a new position by mistake
  const res = await kalshi("POST", "/portfolio/events/orders", body);
  const r = res.order || res;
  const out = { orderId: r.order_id, filled: Math.round(Number(r.fill_count ?? r.fill_count_fp ?? 0)), remaining: Math.round(Number(r.remaining_count ?? r.remaining_count_fp ?? 0)), avg: r.average_fill_price, body };
  if (!out.filled) await explainMiss(ticker, r, body); // record exactly why, so a miss can be diagnosed
  return out;
}

// When an order fills 0, write down Kalshi's full reply, the order's final status, and the top of the order book at that moment.
async function explainMiss(ticker, reply, body) {
  const info = { event: "MISS_DETAILS", ticker, sentSide: body.side, sentPrice: body.price, kalshiReply: reply };
  try { const o = await kalshi("GET", `/portfolio/orders/${reply.order_id}`); const x = o.order || o; info.orderStatus = { status: x.status, fill: x.fill_count ?? x.fill_count_fp, remaining: x.remaining_count ?? x.remaining_count_fp, yes_price: x.yes_price_dollars ?? x.yes_price, no_price: x.no_price_dollars ?? x.no_price, side: x.side, action: x.action }; }
  catch (e) { info.orderStatusErr = e.message.slice(0, 200); }
  try {
    const r = await fetch(`${API}/markets/${ticker}/orderbook?depth=3`, { headers: { Accept: "application/json" } });
    const ob = await r.json(); const b = ob.orderbook_fp || ob.orderbook || ob;
    info.book = JSON.stringify(b).slice(0, 600);
  } catch (e) { info.bookErr = String(e).slice(0, 200); }
  try { const m = await openMarket(); if (m && m.ticker === ticker) info.marketNow = { yes_bid: m.yes_bid_dollars ?? m.yes_bid, yes_ask: m.yes_ask_dollars ?? m.yes_ask, no_bid: m.no_bid_dollars ?? m.no_bid, no_ask: m.no_ask_dollars ?? m.no_ask }; } catch {}
  log(info);
}

// ---- helpers ----
const cents = (c, d) => (c != null && c !== "" ? Number(c) : d != null && d !== "" ? Math.round(Number(d) * 100) : null);
// ---- shards: Kalshi keeps a separate balance per "exchange shard". The app moves money automatically; bots must do it themselves. ----
async function shardBalances() {
  const b = await kalshi("GET", "/portfolio/balance");
  const out = {};
  for (const x of b.balance_breakdown || []) out[Number(x.exchange_index) || 0] = Math.round(Number(x.balance) * 100); // breakdown is in dollars -> cents
  return out;
}
// Move all cash on other shards to the shard this market trades on. Transfers are free and have no clearing delay.
async function fundShard(shard) {
  shard = Number(shard) || 0;
  let bal; try { bal = await shardBalances(); } catch (e) { log({ event: "SHARD_CHECK_FAILED", error: e.message }); return null; }
  let moved = 0;
  for (const [idx, cents] of Object.entries(bal)) {
    const from = Number(idx);
    if (from === shard || cents < 1) continue;
    try {
      await kalshi("POST", "/portfolio/intra_exchange_instance_transfer", { source: "event_contract", destination: "event_contract",
        amount: cents * 100, source_exchange_shard: from, destination_exchange_shard: shard, client_transfer_id: crypto.randomUUID() }); // amount is in centicents
      moved += cents; log({ event: "MOVED_FUNDS", fromShard: from, toShard: shard, dollars: cents / 100 });
    } catch (e) { log({ event: "MOVE_FUNDS_FAILED", fromShard: from, toShard: shard, error: e.message }); }
  }
  if (moved) await new Promise((r) => setTimeout(r, 1500)); // transfers process asynchronously
  try { const b2 = await shardBalances(); return b2[shard] ?? null; } catch { return null; }
}
async function balanceDollars() {
  const b = await kalshi("GET", "/portfolio/balance");
  const c = b.balance != null ? Number(b.balance) : b.balance_dollars != null ? Math.round(Number(b.balance_dollars) * 100) : null;
  if (c == null || Number.isNaN(c)) throw new Error("could not read balance: " + JSON.stringify(b).slice(0, 200));
  return c / 100;
}
async function openMarket() {
  const r = await fetch(`${API}/markets?series_ticker=${SERIES}&status=open&limit=10`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  const ms = (j.markets || []).sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  return ms[0] || null;
}
function quote(m) {
  return {
    ticker: m.ticker,
    close: new Date(m.close_time).getTime(),
    yesAsk: cents(m.yes_ask, m.yes_ask_dollars), noAsk: cents(m.no_ask, m.no_ask_dollars),
    yesBid: cents(m.yes_bid, m.yes_bid_dollars), noBid: cents(m.no_bid, m.no_bid_dollars),
  };
}
// Live prices straight from the order book (the market summary can lag a few seconds behind on fast moves).
// Kalshi's book lists bids only: YES bids and NO bids. Buying YES costs (100 - best NO bid); buying NO costs (100 - best YES bid).
async function liveQuote(ticker) {
  try {
    const r = await fetch(`${API}/markets/${ticker}/orderbook?depth=5`, { headers: { Accept: "application/json" } });
    const j = await r.json();
    const fp = j.orderbook_fp, ob = j.orderbook;
    const best = (rows, dollars) => { if (!Array.isArray(rows) || !rows.length) return null; let m = null; for (const x of rows) { const c = dollars ? Math.round(Number(x[0]) * 100) : Number(x[0]); if (Number(x[1]) > 0 && (m == null || c > m)) m = c; } return m; };
    let yb = null, nb = null;
    if (fp) { yb = best(fp.yes_dollars || fp.yes, !!fp.yes_dollars); nb = best(fp.no_dollars || fp.no, !!fp.no_dollars); }
    if (yb == null && nb == null && ob) { yb = best(ob.yes_dollars || ob.yes, !!ob.yes_dollars); nb = best(ob.no_dollars || ob.no, !!ob.no_dollars); }
    if (yb == null && nb == null) return null;
    return { yesBid: yb, noBid: nb, yesAsk: nb != null ? 100 - nb : null, noAsk: yb != null ? 100 - yb : null };
  } catch { return null; }
}
let state = { win: {}, open: null, stopped: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
state.win = state.win || {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
function log(obj) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
  try { notifyFor(obj); } catch {}
}
// ---- phone notifications (free ntfy app). Topic is a random private name saved in notify.txt ----
const NOTIFY_FILE = path.join(DIR, "notify.txt");
let TOPIC = null;
try { TOPIC = fs.readFileSync(NOTIFY_FILE, "utf8").trim(); } catch {}
if (!TOPIC) { TOPIC = "kbot-" + crypto.randomBytes(9).toString("hex"); fs.writeFileSync(NOTIFY_FILE, TOPIC + "\n"); }
let lastSkipNote = 0;
async function notify(title, msg, prio = 3, tag = "") {
  try { await fetch((CFG.ntfyBase || "https://ntfy.sh/") + TOPIC, { method: "POST", body: msg, headers: { Title: title.replace(/[^\x20-\x7E]/g, "").replace(/^\s+/, ""), Priority: String(prio), Tags: tag } }); } catch {} // headers must be plain text; the tag adds the emoji
}
const SIDE = (s) => (s === "yes" ? "Up" : s === "no" ? "Down" : s);
function notifyFor(o) {
  switch (o.event) {
    case "ORDER_DONE": if (o.filled > 0) notify(`💵 Bought ${SIDE(o.sent && o.sent.side === "bid" ? "yes" : "no")} x${o.filled}`, `${o.kind === "box" ? "Box trade" : "Hold bet"} on ${o.ticker}${o.avgPrice ? ` · avg $${o.avgPrice}` : ""}`, 4, "moneybag"); break;
    case "NO_FILL": notify("Order missed (nothing spent)", o.note || "", 2, "hourglass"); break;
    case "ORDER_REJECTED": notify("❌ Kalshi refused an order", String(o.error).slice(0, 300), 4, "warning"); break;
    case "SELL_DONE": notify(`✅ Sold x${o.sold} @ ${o.priceCents}c`, o.remaining ? `${o.remaining} left, retrying` : "Position closed", 4, "white_check_mark"); break;
    case "SELL_REJECTED": notify("❌ Sell refused — check Kalshi app", String(o.error).slice(0, 300), 5, "rotating_light"); break;
    case "WINDOW_ENDED_HOLDING": notify("Window ended while holding", `${o.count} contracts settle at the close (100¢ if right, 0¢ if wrong)`, 3, "clock3"); break;
    case "MOVE_FUNDS_FAILED": notify("❌ Couldn't move cash to the BTC shard", String(o.error).slice(0, 300), 4, "warning"); break;
    case "STOPPED": notify("🛑 Bot stopped", o.why || "", 5, "stop_sign"); break;
    case "TEST": notify("🧪 Test trade", o.msg || "", 4, "test_tube"); break;
  }
}
let calls = 0, skips = {};
function noteSkip(why) {
  calls++; const k = String(why).replace(/\d+/g, "#"); skips[k] = (skips[k] || 0) + 1;
  if (Date.now() - lastSkipNote > 10 * 60e3) { lastSkipNote = Date.now(); notify("Trade skipped", String(why).slice(0, 200), 2, "pause_button"); }
}
// hourly "still alive" note so silence never leaves you guessing
setInterval(async () => {
  let bal = status.balance; try { bal = await balanceDollars(); status.balance = bal; } catch {}
  const top = Object.entries(skips).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n}× ${k}`).join("; ");
  notify("Bot is running", `Balance $${bal != null ? bal.toFixed(2) : "?"} · box called ${calls} trade${calls === 1 ? "" : "s"} in the last hour${state.open ? ` · holding ${state.open.count} ${SIDE(state.open.side)}` : ""}${top ? ` · skipped: ${top}` : ""}`, 2, "robot");
  calls = 0; skips = {};
}, 60 * 60e3);
let status = { balance: null, last: null, lastErr: null, busy: false };

// ---- the one thing that spends money ----
// Two kinds of real bets:
//  hold   = the hold-to-the-end model: 8c+ edge, 20-50c, 2+ min left, once per window, never sold (settles at the close)
//  box    = any trade the box makes (dip buys, takeoffs, AI): the box already picked it, 10-85c, 1+ min left,
//           sold when the box says SELL (or held to the end, same as the paper account)
const RULES = {
  hold: { minEdge: 0.08, minPrice: 20, maxPrice: 50, minSecondsLeft: 120 },
  box:  { minEdge: -1,   minPrice: 10, maxPrice: 85, minSecondsLeft: 60, chase: 2 }, // fast moves: may pay up to 2c over the ask to actually get filled
};
const MAX_BUYS_PER_WINDOW = 2;
// v45: trade types that are NOT allowed with real money until they're proven.
//  flip, ai = lost or unproven on paper (flip 4/8 for -63c; the flip learner says 90%+ when it wins ~55%)
//  hold     = bets purely on "model edge". Off until the page's scorecard shows the model beats Kalshi's price
//             (100+ windows). To turn hold bets back on, add  "allowHoldBets": true  to config.json.
const BLOCKED_SETUPS = new Set(["flip", "ai"]);
const ALLOW_HOLD = CFG.allowHoldBets === true;
async function placeBet(req) {
  const side = req.side === "up" ? "yes" : req.side === "down" ? "no" : null;
  if (!side) return { ok: false, why: "bad side" };
  const kind = req.kind === "box" || req.kind === "rocket" ? "box" : "hold", R = RULES[kind];
  if (fs.existsSync(STOP_FILE)) return { ok: false, why: "STOP file present (kill switch on)" };
  if (kind === "box" && BLOCKED_SETUPS.has(req.setup)) return { ok: false, why: `${req.setup} trades are off for real money (v45)` };
  if (kind === "hold" && !ALLOW_HOLD) return { ok: false, why: "hold bets are off until the scorecard proves the model (v45)" };
  if (state.stopped) return { ok: false, why: "stopped: " + state.stopped };
  if (!(req.edge >= R.minEdge)) return { ok: false, why: `edge under ${R.minEdge * 100} cents` };
  if (state.open) {
    const m0 = await openMarket().catch(() => null);
    if (m0 && m0.ticker !== state.open.ticker) { log({ event: "WINDOW_ENDED_HOLDING", ticker: state.open.ticker, count: state.open.count }); state.open = null; saveState(); } // old window settled at the close
    else return { ok: false, why: "already holding a position, one at a time" };
  }
  if (status.busy) return { ok: false, why: "another order in progress" };
  status.busy = true;
  try {
    const m = await openMarket();
    if (!m) return { ok: false, why: "no open market" };
    const q = quote(m);
    const W = (state.win[q.ticker] = state.win[q.ticker] || { hold: false, buys: 0 });
    if (kind === "hold" && W.hold) return { ok: false, why: "already made the hold bet this window" };
    if (W.buys >= MAX_BUYS_PER_WINDOW) return { ok: false, why: `already ${W.buys} buys this window` };
    const secsLeft = (q.close - Date.now()) / 1000;
    if (secsLeft < R.minSecondsLeft) return { ok: false, why: `only ${Math.round(secsLeft)}s left` };
    const L = await liveQuote(q.ticker);
    const ask = L ? (side === "yes" ? L.yesAsk : L.noAsk) : (side === "yes" ? q.yesAsk : q.noAsk);
    if (ask == null) return { ok: false, why: "no sellers right now" };
    if (ask < R.minPrice || ask > R.maxPrice) return { ok: false, why: `price ${ask}c outside ${R.minPrice}-${R.maxPrice}c` };
    if (ask > Number(req.ask) + (R.chase || LIMITS.maxSlip)) return { ok: false, why: `price moved: page saw ${req.ask}c, live book now ${ask}c` };
    const total = await balanceDollars();
    status.balance = total;
    let bal = total;
    const shard = Number(m.exchange_index) || 0;
    const onShard = await fundShard(shard); // move the money to where BTC trades
    if (onShard != null) bal = Math.min(total, onShard / 100);
    if (bal < LIMITS.floorDollars) { state.stopped = `balance $${bal.toFixed(2)} under $${LIMITS.floorDollars}`; saveState(); log({ event: "STOPPED", why: state.stopped }); return { ok: false, why: state.stopped }; }
    const limitPx = Math.min(R.maxPrice, ask + 1); // live ask + 1c cushion; Kalshi fills at the best price available
    const count = Math.min(LIMITS.maxContracts, Math.floor((bal * LIMITS.maxFrac) / (limitPx / 100)));
    if (count < 1) return { ok: false, why: "bet would be under 1 contract" };
    W.buys++; if (kind === "hold") W.hold = true; saveState(); // claim it before sending, so a crash can't double-buy
    log({ event: "ORDER_SENT", kind, setup: req.setup, ticker: q.ticker, side, count, pageAskCents: Number(req.ask), liveAskCents: ask, priceSource: L ? "order book" : "market summary", maxPriceCents: limitPx, maxCostDollars: (count * limitPx) / 100, balanceBefore: bal, edge: req.edge });
    let o;
    // limit buy at the ask, fills right away or cancels (nothing left sitting on the book); never pays more than the ask
    try { o = await placeOrder({ ticker: q.ticker, side, action: "buy", count, cents: limitPx }); }
    catch (e) { W.buys--; if (kind === "hold") W.hold = false; saveState(); // nothing bought: give the slot back
      if (/insufficient_balance/.test(e.message)) log({ event: "NOTE", note: `Kalshi says the BTC shard (${shard}) is short on cash; bot tried moving funds there first` });
      log({ event: "ORDER_REJECTED", kind, ticker: q.ticker, error: e.message }); status.lastErr = e.message; return { ok: false, why: "Kalshi rejected: " + e.message.slice(0, 160) }; }
    const filled = o.filled;
    if (filled === 0) { W.buys--; if (kind === "hold") W.hold = false; } // a miss costs nothing and doesn't use up a buy
    const paid = o.avg != null ? Math.round(Number(o.avg) * 100) : ask; const entry = side === "yes" ? paid : (o.avg != null ? 100 - paid : ask);
    if (kind === "box" && filled > 0) state.open = { ticker: q.ticker, side, count: filled, entry, t: Date.now() };
    saveState();
    status.last = { kind, ticker: q.ticker, side: req.side, count, filled, ask, t: Date.now() };
    log({ event: "ORDER_DONE", kind, ticker: q.ticker, orderId: o.orderId, filled, remaining: o.remaining, avgPrice: o.avg, sent: o.body });
    if (filled === 0) log({ event: "NO_FILL", ticker: q.ticker, note: `nobody selling at ${limitPx}c or less in that instant; nothing spent` });
    return { ok: true, kind, filled, count, ask: filled ? entry : ask, ticker: q.ticker };
  } catch (e) {
    status.lastErr = e.message; log({ event: "ERROR", error: e.message });
    return { ok: false, why: e.message.slice(0, 200) };
  } finally { status.busy = false; }
}

// ---- selling the open takeoff position ----
async function sellOpen() {
  const P = state.open;
  if (!P) return { ok: false, why: "no open position" };
  if (status.busy) return { ok: false, why: "another order in progress" };
  status.busy = true;
  try {
    const m = await openMarket();
    if (!m || m.ticker !== P.ticker) { log({ event: "WINDOW_ENDED_HOLDING", ticker: P.ticker, count: P.count }); state.open = null; saveState(); return { ok: false, why: "window ended, Kalshi settles it", remaining: 0 }; }
    const q = quote(m), L = await liveQuote(P.ticker), bid = L ? (P.side === "yes" ? L.yesBid : L.noBid) : (P.side === "yes" ? q.yesBid : q.noBid);
    if (bid == null || bid < 1) return { ok: false, why: "no buyers right now", remaining: P.count };
    const price = Math.max(1, bid - 2); // up to 2c under the bid so it actually fills
    log({ event: "SELL_SENT", ticker: P.ticker, side: P.side, count: P.count, minPriceCents: price, entryCents: P.entry });
    let o;
    try { o = await placeOrder({ ticker: P.ticker, side: P.side, action: "sell", count: P.count, cents: price, reduceOnly: true }); }
    catch (e) { log({ event: "SELL_REJECTED", ticker: P.ticker, error: e.message }); status.lastErr = e.message; return { ok: false, why: "Kalshi rejected sell: " + e.message.slice(0, 160), remaining: P.count }; }
    const sold = o.filled;
    P.count -= sold; const remaining = P.count;
    if (remaining <= 0) state.open = null;
    saveState();
    status.lastSell = { ticker: P.ticker, sold, price, remaining, t: Date.now() };
    log({ event: "SELL_DONE", ticker: P.ticker, orderId: o.orderId, sold, remaining, priceCents: price, avgPrice: o.avg, sent: o.body });
    return { ok: true, sold, remaining, price };
  } catch (e) { status.lastErr = e.message; log({ event: "ERROR", error: e.message }); return { ok: false, why: e.message.slice(0, 200) }; }
  finally { status.busy = false; }
}

// ---- test trade: buys 1 contract of the cheaper side at the live price, then sells it right back ----
async function testTrade() {
  if (fs.existsSync(STOP_FILE)) return { ok: false, why: "kill switch on" };
  if (state.open) return { ok: false, why: "already holding a position" };
  if (status.busy) return { ok: false, why: "busy" };
  status.busy = true;
  try {
    const m = await openMarket(); if (!m) return { ok: false, why: "no open market" };
    if ((new Date(m.close_time) - Date.now()) / 1000 < 60) return { ok: false, why: "under 1 min left, try next window" };
    await fundShard(Number(m.exchange_index) || 0);
    const L = await liveQuote(m.ticker); if (!L || L.yesAsk == null || L.noAsk == null) return { ok: false, why: "couldn't read the order book" };
    const side = L.yesAsk <= L.noAsk ? "yes" : "no", ask = side === "yes" ? L.yesAsk : L.noAsk;
    const b = await placeOrder({ ticker: m.ticker, side, action: "buy", count: 1, cents: Math.min(95, ask + 1) });
    if (!b.filled) { log({ event: "TEST", msg: `Buy didn't fill at ${ask + 1}¢ (nothing spent). Order book moved; try again.` }); return { ok: false, why: "buy didn't fill, nothing spent" }; }
    await new Promise((r) => setTimeout(r, 2000));
    const L2 = await liveQuote(m.ticker), bid = L2 ? (side === "yes" ? L2.yesBid : L2.noBid) : null;
    const sold = bid ? await placeOrder({ ticker: m.ticker, side, action: "sell", count: 1, cents: Math.max(1, bid - 2), reduceOnly: true }) : { filled: 0 };
    const msg = `Bought 1 ${SIDE(side)} @ ~${ask}¢, ${sold.filled ? `sold @ ~${bid}¢` : "SELL DIDN'T FILL, it will settle at the close"}. Buying and selling both work.`;
    log({ event: "TEST", msg });
    return { ok: true, msg };
  } catch (e) { log({ event: "TEST", msg: "Test failed: " + e.message.slice(0, 200) }); return { ok: false, why: e.message.slice(0, 200) }; }
  finally { status.busy = false; }
}

// ---- web server (localhost only) ----
const PAGE = path.join(DIR, "index.html");
function send(res, code, obj, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
async function relayK(res) {
  try {
    const m = await openMarket();
    if (m) { const L = await liveQuote(m.ticker); // replace the lagging summary prices with the live order book
      if (L) { for (const [k, v] of [["yes_bid", L.yesBid], ["yes_ask", L.yesAsk], ["no_bid", L.noBid], ["no_ask", L.noAsk]]) { delete m[k]; m[k + "_dollars"] = v == null ? null : (v / 100).toFixed(4); } m.price_source = "order book"; } }
    send(res, 200, m || { error: "no open market" });
  }
  catch (e) { send(res, 502, { error: String(e) }); }
}
// v45: Kalshi's official result for a finished window, so the page's scorecard grades against the real outcome
async function relayResult(res, ticker) {
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker || "")) return send(res, 400, { error: "bad ticker" });
  try {
    const r = await fetch(`${API}/markets/${ticker}`, { headers: { Accept: "application/json" } });
    const j = await r.json();
    send(res, 200, { ticker, result: j.market?.result || null, status: j.market?.status || null });
  } catch (e) { send(res, 502, { error: String(e) }); }
}
async function relayPM(res) {
  try {
    const start = Math.floor(Date.now() / 1000 / 900) * 900, slug = "btc-updown-15m-" + start;
    const r = await fetch("https://gamma-api.polymarket.com/events?slug=" + slug, { headers: { Accept: "application/json" } });
    const j = await r.json(), ev = Array.isArray(j) ? j[0] : j, m = ev && ev.markets && ev.markets[0];
    if (!m) return send(res, 200, { error: "no market for " + slug });
    const pj = (x) => (typeof x === "string" ? JSON.parse(x) : x), outs = pj(m.outcomes) || [], prs = pj(m.outcomePrices) || [];
    const iu = outs.findIndex((o) => String(o).toLowerCase() === "up");
    send(res, 200, { slug, up: iu >= 0 && prs[iu] != null ? Number(prs[iu]) : null, outcomes: outs, prices: prs, bestBid: m.bestBid, bestAsk: m.bestAsk });
  } catch (e) { send(res, 502, { error: String(e) }); }
}
function startServer() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, ORIGIN);
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) return send(res, 200, fs.readFileSync(PAGE, "utf8"), "text/html;charset=utf-8");
    if (req.method === "GET" && u.pathname === "/k") return relayK(res);
    if (req.method === "GET" && u.pathname === "/pm") return relayPM(res);
    if (req.method === "GET" && u.pathname === "/kr") return relayResult(res, u.searchParams.get("ticker"));
    if (req.method === "GET" && u.pathname === "/bot/status")
      return send(res, 200, { on: true, kill: fs.existsSync(STOP_FILE), stopped: state.stopped, balance: status.balance, last: status.last, lastSell: status.lastSell, open: state.open, lastErr: status.lastErr, limits: LIMITS, rules: RULES });
    if (req.method === "POST" && u.pathname === "/bot/test") {
      if (req.headers.origin !== ORIGIN || !(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 403, { ok: false, why: "forbidden" });
      for await (const _ of req) {}
      return send(res, 200, await testTrade());
    }
    if (req.method === "POST" && u.pathname === "/bot/sell") {
      if (req.headers.origin !== ORIGIN || !(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 403, { ok: false, why: "forbidden" });
      for await (const _ of req) {}
      return send(res, 200, await sellOpen());
    }
    if (req.method === "POST" && u.pathname === "/bot/bet") {
      // only the radar page served by this bot may place bets (blocks other websites from triggering orders)
      if (req.headers.origin !== ORIGIN || !(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 403, { ok: false, why: "forbidden" });
      let raw = ""; for await (const c of req) { raw += c; if (raw.length > 5000) return send(res, 413, { ok: false }); }
      let b; try { b = JSON.parse(raw); } catch { return send(res, 400, { ok: false, why: "bad json" }); }
      const r = await placeBet(b); if (r.ok) calls++; else noteSkip(r.why); return send(res, 200, r);
    }
    send(res, 404, { error: "not found" });
  });
  srv.listen(PORT, "127.0.0.1", () => console.log(`\nBot running. Open ${ORIGIN} in Chrome on this Mac and keep it open.\nKill switch: Ctrl+C here, or create a file named STOP in ${DIR}\n`));
}

// ---- start ----
const cmd = process.argv[2];
try {
  const bal = await balanceDollars();
  status.balance = bal;
  const m = await openMarket();
  console.log(`Logged in to Kalshi. Balance: $${bal.toFixed(2)}`);
  if (m) { const q = quote(m); console.log(`Current market: ${q.ticker} · Up ${q.yesAsk}c / Down ${q.noAsk}c · closes ${new Date(q.close).toLocaleTimeString()}`); }
  console.log(`Limits: max ${LIMITS.maxFrac * 100}% of balance per bet, stops under $${LIMITS.floorDollars}, max ${MAX_BUYS_PER_WINDOW} buys per window, one position open at a time.`);
  console.log(`v45: real money only for dip buys and takeoffs. Flip and AI trades are blocked${ALLOW_HOLD ? "" : "; hold bets are off (set allowHoldBets in config.json to turn them on)"}.`);
  console.log(`Copies every box trade (dips, takeoffs, AI): 10-85c, 1+ min left, sold when the box says SELL. Hold bets: 20-50c, 8c+ edge, 2+ min left.`);
  if (state.open) console.log(`NOTE: holding ${state.open.count} ${state.open.side} on ${state.open.ticker} from before.`);
  if (state.stopped) console.log(`NOTE: bot is stopped (${state.stopped}). Delete bot-state.json to reset after you add funds.`);
} catch (e) {
  console.error("Could not log in to Kalshi:", e.message);
  console.error("Check keyId and privateKeyPath in config.json.");
  process.exit(1);
}
try { const m0 = await openMarket(); if (m0) { const sh = Number(m0.exchange_index) || 0; const c = await fundShard(sh); console.log(`BTC markets trade on shard ${sh}. Cash there: ${c == null ? "unknown" : "$" + (c / 100).toFixed(2)}`); } } catch (e) { console.log("Shard check skipped: " + e.message); }
console.log(`\n📱 Phone alerts: install the free "ntfy" app, tap +, subscribe to:  ${TOPIC}\n   (keep this name private; anyone with it can read your bot's alerts)`);
if (cmd !== "check") notify("Bot started", `Balance $${status.balance != null ? status.balance.toFixed(2) : "?"}. You'll get alerts for buys, sells, misses and errors, plus an hourly check-in.`, 3, "rocket");
if (cmd === "check") { console.log("\nCheck passed. No orders placed. Start the bot with: node kalshi-bot.mjs"); process.exit(0); }
startServer();
