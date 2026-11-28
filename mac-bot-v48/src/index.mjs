// Streams BTC from exchange WebSockets directly in Node and builds a BRTI approximation.
// CF Benchmarks' BRTI is computed from the ORDER BOOKS of its constituent exchanges (Coinbase, Kraken, Bitstamp,
// Gemini, Crypto.com, LMAX Digital, Bullish as of Aug 2026). We stream top-of-book from the 5 we can reach without
// accounts, take each one's mid-price, drop outliers and average them. The remaining difference to the real BRTI is
// MEASURED (see gap.mjs) instead of guessed.
import { managedSocket } from "./ws.mjs";
import { median } from "./util.mjs";
import { volFrom } from "./features.mjs";

export function createIndex({ enabled = {}, staleMs = 3000, outlierPct = 0.15, minFeeds = 2, log = () => {}, socket = managedSocket } = {}) {
  // `socket` = managedSocket (Node, src/ws.mjs) or managedSocketCF (Cloudflare, src/ws-cf.mjs): same interface
  const ex = {};            // name -> { bid, ask, bidQty, askQty, t, msgs, exchTs }
  const trades = [];        // { t, qty, buy } (taker side), all exchanges
  const perp = [];          // { t, p } OKX BTC-USDT perpetual
  const series = new Map(); // second -> index value
  const sockets = {};
  const on = (n) => enabled[n] !== false;
  const setTop = (name, bid, ask, bidQty, askQty, exchTs) => {
    if (!(bid > 0 && ask > 0 && ask >= bid)) return;
    const e = ex[name] || (ex[name] = { msgs: 0 });
    e.bid = bid; e.ask = ask; e.bidQty = bidQty || 0; e.askQty = askQty || 0; e.t = Date.now(); e.msgs++;
    if (exchTs) e.lagMs = e.t - exchTs;
    api.onUpdate && api.onUpdate(name);
  };
  const addTrade = (qty, buy) => { if (qty > 0) { trades.push({ t: Date.now(), qty, buy }); if (trades.length > 20000) trades.splice(0, 5000); } };

  if (on("coinbase")) sockets.coinbase = socket({
    name: "coinbase", url: "wss://ws-feed.exchange.coinbase.com", staleMs: 20000,
    onOpen: (ws) => ws.send({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "matches", "heartbeat"] }),
    onMessage: (m) => { const d = JSON.parse(m);
      if (d.type === "ticker") setTop("coinbase", +d.best_bid, +d.best_ask, +d.best_bid_size, +d.best_ask_size, Date.parse(d.time));
      else if (d.type === "match") addTrade(+d.size, d.side === "sell"); }, // match side = maker side; maker sold => taker bought
  });
  if (on("kraken")) sockets.kraken = socket({
    name: "kraken", url: "wss://ws.kraken.com/v2", staleMs: 20000,
    onOpen: (ws) => { ws.send({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" } }); ws.send({ method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"] } }); },
    onMessage: (m) => { const d = JSON.parse(m);
      if (d.channel === "ticker" && Array.isArray(d.data)) for (const x of d.data) setTop("kraken", +x.bid, +x.ask, +x.bid_qty, +x.ask_qty);
      else if (d.channel === "trade" && Array.isArray(d.data) && d.type === "update") for (const x of d.data) addTrade(+x.qty, x.side === "buy"); },
  });
  if (on("bitstamp")) sockets.bitstamp = socket({
    name: "bitstamp", url: "wss://ws.bitstamp.net", staleMs: 30000,
    onOpen: (ws) => { ws.send({ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }); ws.send({ event: "bts:subscribe", data: { channel: "live_trades_btcusd" } }); },
    onMessage: (m) => { const d = JSON.parse(m);
      if (d.event === "data" && d.channel === "order_book_btcusd" && d.data?.bids?.[0] && d.data?.asks?.[0]) setTop("bitstamp", +d.data.bids[0][0], +d.data.asks[0][0], +d.data.bids[0][1], +d.data.asks[0][1], Number(d.data.microtimestamp) / 1000);
      else if (d.event === "trade") addTrade(+d.data.amount, +d.data.type === 0); },
  });
  if (on("gemini")) { const gem = { bid: null, ask: null, bq: 0, aq: 0 }; sockets.gemini = socket({
    name: "gemini", url: "wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=true&heartbeat=true", staleMs: 30000,
    onMessage: (m) => { const d = JSON.parse(m); if (d.type !== "update" || !d.events) return;
      for (const e of d.events) {
        if (e.type === "change" && +e.remaining > 0) { if (e.side === "bid") { gem.bid = +e.price; gem.bq = +e.remaining; } else { gem.ask = +e.price; gem.aq = +e.remaining; } }
        else if (e.type === "trade") addTrade(+e.amount, e.makerSide === "ask");
      }
      if (gem.bid && gem.ask) setTop("gemini", gem.bid, gem.ask, gem.bq, gem.aq, d.timestampms); },
  }); }
  if (on("cryptocom")) sockets.cryptocom = socket({
    name: "cryptocom", url: "wss://stream.crypto.com/exchange/v1/market", staleMs: 40000,
    onOpen: (ws) => setTimeout(() => ws.send({ id: 1, method: "subscribe", params: { channels: ["ticker.BTC_USD"] }, nonce: Date.now() }), 1000),
    onMessage: (m, ws) => { const d = JSON.parse(m);
      if (d.method === "public/heartbeat") return ws.send({ id: d.id, method: "public/respond-heartbeat" });
      const x = d.result?.data?.[0]; if (d.result?.channel === "ticker" && x) setTop("cryptocom", +x.b, +x.k, +x.bs, +x.ks, x.t); },
  });
  if (on("okxPerp")) sockets.okxPerp = socket({
    name: "okxPerp", url: "wss://ws.okx.com/ws/v5/public", staleMs: 30000, pingMs: true,
    onOpen: (ws) => ws.send({ op: "subscribe", args: [{ channel: "tickers", instId: "BTC-USDT-SWAP" }] }),
    onMessage: (m) => { if (m === "pong") return; const d = JSON.parse(m); const x = d.data?.[0]; if (x?.last) { perp.push({ t: Date.now(), p: +x.last }); if (perp.length > 20000) perp.splice(0, 5000); } },
  });

  function fresh(now = Date.now()) { return Object.entries(ex).filter(([n, e]) => n !== "okxPerp" && now - e.t < staleMs); }
  function value(now = Date.now()) {
    const f = fresh(now); if (f.length < minFeeds) return null;
    const mids = f.map(([, e]) => (e.bid + e.ask) / 2), med = median(mids);
    const keep = mids.filter((m) => Math.abs(m / med - 1) * 100 <= outlierPct);
    return keep.length ? keep.reduce((s, x) => s + x, 0) / keep.length : null;
  }
  // per-second sampler (aligned to the clock second)
  let samplerTimer = null;
  function tick() {
    const now = Date.now(), sec = Math.floor(now / 1000), v = value(now);
    if (v != null) series.set(sec, v);
    if (series.size > 8000) { const cut = sec - 7200; for (const k of series.keys()) { if (k < cut) series.delete(k); else break; } }
    api.onSecond && api.onSecond(sec, v);
    samplerTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 2);
  }
  samplerTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 2);

  function at(sec) { // value at a second, carrying the last known value forward up to 10s
    for (let s = sec; s > sec - 10; s--) if (series.has(s)) return series.get(s);
    return null;
  }
  function avg(fromSec, toSec) { // average of seconds [fromSec, toSec), needs >= 80% coverage
    let s = 0, n = 0, have = 0; let carry = at(fromSec - 1);
    for (let k = fromSec; k < toSec; k++) { const v = series.get(k); if (v != null) { carry = v; have++; } if (carry != null) { s += carry; n++; } }
    return n && have >= 0.8 * (toSec - fromSec) ? s / n : null;
  }
  let longVolSeed = null; // per-sqrt(second) log vol from candles at startup
  function vol(nowSec = Math.floor(Date.now() / 1000)) { return volFrom(at, nowSec, longVolSeed); }
  const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : 0);
  async function backfill() {
    try {
      const r = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60", { headers: { "User-Agent": "kalshi-bot-v48" } });
      const k = (await r.json()).slice(1, 61).reverse(); const rs = [];
      for (let i = 1; i < k.length; i++) rs.push(Math.log(k[i][4] / k[i - 1][4]) / Math.sqrt(60));
      if (rs.length > 20) longVolSeed = rms(rs);
    } catch (e) { log({ event: "BACKFILL_FAILED", error: String(e.message || e) }); }
  }
  function flow(ms, now = Date.now()) {
    let b = 0, s = 0; for (let i = trades.length - 1; i >= 0 && trades[i].t > now - ms; i--) { if (trades[i].buy) b += trades[i].qty; else s += trades[i].qty; }
    return b + s > 0 ? (b - s) / (b + s) : 0;
  }
  function bookImb(now = Date.now()) {
    let b = 0, a = 0; for (const [, e] of fresh(now)) { const px = (e.bid + e.ask) / 2; b += e.bidQty * px; a += e.askQty * px; }
    return b + a > 0 ? (b - a) / (b + a) : 0;
  }
  function perpMove(ms, now = Date.now()) {
    if (!perp.length || now - perp[perp.length - 1].t > 10000) return null;
    const a = perp.find((x) => x.t >= now - ms); return a ? Math.log(perp[perp.length - 1].p / a.p) : null;
  }
  function status(now = Date.now()) {
    const out = {};
    for (const [n, s] of Object.entries(sockets)) { const e = ex[n]; out[n] = { connected: s.connected, ageMs: n === "okxPerp" ? (perp.length ? now - perp[perp.length - 1].t : null) : e ? now - e.t : null, mid: e ? +((e.bid + e.ask) / 2).toFixed(2) : null, msgs: s.msgs, reconnects: s.reconnects, lastError: s.lastError, lagMs: e?.lagMs ?? null }; }
    return out;
  }
  const api = { ex, series, value, at, avg, vol, flow, bookImb, perpMove, status, backfill, fresh, onUpdate: null, onSecond: null,
    stop: () => { clearTimeout(samplerTimer); Object.values(sockets).forEach((s) => s.stop()); } };
  return api;
}
