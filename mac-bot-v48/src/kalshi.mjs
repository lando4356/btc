// Kalshi access: request signing (RSA-PSS or Ed25519, same as v47), market discovery, a live order book stream
// (WebSocket with your API key; public REST polling when there is no key), official results, orders, cached balance.
// Runs in Node AND in a Cloudflare Worker: the key handling (signer) and the socket type are passed in.
//   Node:       signer = nodeSigner(cfg, dir)  (src/platform-node.mjs, key file on your Mac)
//   Cloudflare: signer = await cfSigner(env)   (src/platform-cf.mjs, key from Cloudflare secrets)
import { KBook } from "./book.mjs";
import { percentile } from "./stats.mjs";

const uuid = () => globalThis.crypto.randomUUID();

export function createKalshi({ cfg, signer = null, socket, log = () => {} }) {
  const API = cfg.apiBase || "https://api.elections.kalshi.com/trade-api/v2";
  const WS_URL = cfg.wsUrl || "wss://api.elections.kalshi.com/trade-api/ws/v2";
  const SERIES = cfg.series || "KXBTC15M";
  const hasKey = !!signer?.hasKey;
  const authHeaders = async (method, path) => { const ts = String(Date.now()); return { "KALSHI-ACCESS-KEY": signer.keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": await signer.sign(ts + method + path) }; };
  const lat = { get: [], post: [] };
  const pushLat = (k, ms) => { lat[k].push(ms); if (lat[k].length > 200) lat[k].shift(); };

  async function req(method, p, body, { auth = false, tries = 0 } = {}) {
    const url = new URL(API + p);
    const headers = { Accept: "application/json", "User-Agent": "kalshi-bot-v48", ...(auth ? await authHeaders(method, url.pathname) : {}) };
    if (body) headers["Content-Type"] = "application/json";
    const t0 = performance.now();
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    pushLat(method === "GET" ? "get" : "post", performance.now() - t0);
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (r.status === 429 && tries < 4) { await new Promise((res) => setTimeout(res, 500 * (tries + 1))); return req(method, p, body, { auth, tries: tries + 1 }); }
    if (!r.ok) { const e = new Error(`Kalshi ${method} ${url.pathname} -> ${r.status}: ${text.slice(0, 300)}`); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // ---- markets ----
  const books = new Map(); // ticker -> KBook
  const state = { market: null, next: null, seriesInfo: null, wsStatus: null, bookSource: hasKey && cfg.useKalshiWebSocket !== false ? "websocket" : "rest-poll", lastBookMsg: 0, exchLagMs: [] };
  async function seriesInfo() { try { const j = await req("GET", `/series/${SERIES}`); state.seriesInfo = { feeType: j.series?.fee_type, feeMultiplier: Number(j.series?.fee_multiplier ?? 1) }; } catch (e) { log({ event: "SERIES_INFO_FAILED", error: e.message }); } return state.seriesInfo; }
  async function openMarkets() {
    const j = await req("GET", `/markets?series_ticker=${SERIES}&status=open&limit=10`);
    return (j.markets || []).sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  }
  const norm = (m) => ({ ticker: m.ticker, closeMs: Date.parse(m.close_time), openMs: Date.parse(m.open_time), strike: Number(m.floor_strike) || null, exchangeIndex: Number(m.exchange_index) || 0, status: m.status });
  async function refreshMarket() {
    const ms = await openMarkets();
    const now = Date.now();
    const cur = ms.find((m) => Date.parse(m.close_time) > now);
    if (!cur) return state.market;
    const n = norm(cur);
    if (!state.market || state.market.ticker !== n.ticker) { state.market = n; onNewMarket(n); }
    else if (!state.market.strike && n.strike) state.market.strike = n.strike;
    return state.market;
  }
  async function marketResult(ticker) {
    const j = await req("GET", `/markets/${ticker}`); const m = j.market || {};
    return { result: m.result || null, status: m.status, expirationValue: m.expiration_value != null ? Number(m.expiration_value) : null, strike: Number(m.floor_strike) || null };
  }
  const book = (t) => { let b = books.get(t); if (!b) { b = new KBook(t); books.set(t, b); } return b; };

  // ---- book stream ----
  let ws = null, subId = 1, pollTimer = null;
  function onNewMarket(m) {
    book(m.ticker);
    for (const t of books.keys()) if (t !== m.ticker && books.size > 3) books.delete(t);
    if (ws && ws.connected) ws.send({ id: ++subId, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: [m.ticker] } });
    api.onMarket && api.onMarket(m);
  }
  function startBookStream() {
    if (state.bookSource === "websocket") {
      ws = socket({
        name: "kalshi", url: WS_URL, staleMs: 30000, headers: () => authHeaders("GET", new URL(WS_URL).pathname),
        onOpen: (s) => { if (state.market) s.send({ id: ++subId, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: [state.market.ticker] } }); },
        onMessage: (text) => {
          const d = JSON.parse(text), recv = Date.now(), m = d.msg || {};
          if (d.type === "orderbook_snapshot") { book(m.market_ticker).applySnapshot(m, recv); }
          else if (d.type === "orderbook_delta") { book(m.market_ticker).applyDelta(m, recv); }
          else if (d.type === "error") { log({ event: "KALSHI_WS_ERROR", msg: m }); return; }
          else return;
          state.lastBookMsg = recv;
          const ts = m.ts_ms || d.sending_ts_ms; if (ts) { state.exchLagMs.push(recv - ts); if (state.exchLagMs.length > 500) state.exchLagMs.shift(); }
          api.onBook && api.onBook(m.market_ticker, recv);
        },
      });
      state.wsStatus = ws;
    }
    // REST polling: the only source without a key, and a safety net if the socket goes quiet.
    const pollMs = Math.max(150, cfg.restPollMs || 300);
    const poll = async () => {
      try {
        const m = state.market;
        const wsHealthy = ws && ws.connected && Date.now() - state.lastBookMsg < 5000;
        if (m && !wsHealthy) {
          const t0 = Date.now();
          const j = await req("GET", `/markets/${m.ticker}/orderbook?depth=10`);
          const ob = j.orderbook_fp || j.orderbook || {};
          book(m.ticker).applySnapshot(ob, Date.now());
          state.lastBookMsg = Date.now(); state.restRtt = Date.now() - t0;
          api.onBook && api.onBook(m.ticker, Date.now());
        }
      } catch (e) { state.lastError = e.message; }
      pollTimer = setTimeout(poll, pollMs);
    };
    poll();
  }

  // ---- account (only with a key) ----
  const acct = { balance: null, balanceAt: 0, shardBalance: null };
  async function refreshBalance() {
    if (!hasKey) return null;
    const b = await req("GET", "/portfolio/balance", null, { auth: true });
    const c = b.balance != null ? Number(b.balance) : b.balance_dollars != null ? Math.round(Number(b.balance_dollars) * 100) : null;
    if (c == null || Number.isNaN(c)) throw new Error("could not read balance");
    acct.balance = c / 100; acct.balanceAt = Date.now();
    acct.breakdown = {}; for (const x of b.balance_breakdown || []) acct.breakdown[Number(x.exchange_index) || 0] = Math.round(Number(x.balance) * 100);
    return acct.balance;
  }
  // Kalshi keeps a separate balance per exchange shard; move cash to the shard the BTC market trades on (free).
  async function fundShard(shard) {
    if (!hasKey) return;
    await refreshBalance();
    let moved = 0;
    for (const [idx, cents] of Object.entries(acct.breakdown || {})) {
      const from = Number(idx); if (from === shard || cents < 1) continue;
      try {
        await req("POST", "/portfolio/intra_exchange_instance_transfer", { source: "event_contract", destination: "event_contract", amount: cents * 100, source_exchange_shard: from, destination_exchange_shard: shard, client_transfer_id: uuid() }, { auth: true });
        moved += cents; log({ event: "MOVED_FUNDS", fromShard: from, toShard: shard, dollars: cents / 100 });
      } catch (e) { log({ event: "MOVE_FUNDS_FAILED", fromShard: from, toShard: shard, error: e.message }); }
    }
    if (moved) { await new Promise((r) => setTimeout(r, 1500)); await refreshBalance(); }
    acct.shardBalance = acct.breakdown?.[shard] != null ? acct.breakdown[shard] / 100 : acct.balance;
  }
  // V2 order: every order is on the YES book. "bid" = buy YES, "ask" = sell YES. Buying NO at q = selling YES at 100-q.
  function yesOrder(side, action, cents) {
    const buyYes = (side === "yes") === (action === "buy");
    const yesCents = side === "yes" ? cents : 100 - cents;
    return { side: buyYes ? "bid" : "ask", price: (Math.round(yesCents) / 100).toFixed(2) };
  }
  async function placeOrder({ ticker, side, action, count, cents, tif = "immediate_or_cancel", postOnly = false, reduceOnly = false }) {
    const o = yesOrder(side, action, cents);
    const body = { ticker, client_order_id: uuid(), side: o.side, count: String(count), price: o.price, time_in_force: tif, self_trade_prevention_type: "taker_at_cross" };
    if (reduceOnly) body.reduce_only = true;
    if (postOnly) body.post_only = true;
    const t0 = performance.now();
    const res = await req("POST", "/portfolio/events/orders", body, { auth: true });
    const ms = performance.now() - t0;
    const r = res.order || res;
    const filled = Math.round(Number(r.fill_count ?? r.fill_count_fp ?? 0));
    let avgYes = r.average_fill_price != null ? Number(r.average_fill_price) * (Number(r.average_fill_price) <= 1 ? 100 : 1) : null;
    const avg = avgYes == null ? null : side === "yes" ? avgYes : 100 - avgYes; // price of OUR side
    return { orderId: r.order_id, filled, remaining: Math.round(Number(r.remaining_count ?? r.remaining_count_fp ?? 0)), avg, status: r.status, ms, body, raw: r };
  }
  async function cancelOrder(orderId, ticker) { return req("DELETE", `/portfolio/events/orders/${orderId}?market_ticker=${encodeURIComponent(ticker)}`, null, { auth: true }); }
  async function getOrder(orderId) { const o = await req("GET", `/portfolio/orders/${orderId}`, null, { auth: true }); return o.order || o; }

  const api = {
    hasKey, state, acct, books, book, req, refreshMarket, marketResult, seriesInfo, startBookStream, refreshBalance, fundShard, placeOrder, cancelOrder, getOrder,
    onBook: null, onMarket: null,
    latency: () => ({ getMedianMs: percentile(lat.get, 0.5), postMedianMs: percentile(lat.post, 0.5), postP90Ms: percentile(lat.post, 0.9), exchToUsMedianMs: percentile(state.exchLagMs, 0.5) }),
    wsInfo: () => (ws ? { connected: ws.connected, msgs: ws.msgs, reconnects: ws.reconnects, lastError: ws.lastError } : null),
    stop: () => { clearTimeout(pollTimer); ws && ws.stop(); },
  };
  return api;
}
