// Cloudflare Pages relay for the BTC radar page (v47.1).
// Upload ONLY this folder (index.html + _worker.js) to your Cloudflare Pages project.
// NEVER upload the Mac bot folder: it holds your Kalshi key.
//   /k          -> the current KXBTC15M market, with live order-book prices (same as the Mac bot's relay)
//   /kr?ticker= -> Kalshi's official result for a finished window (for the scorecard)
//   /pm         -> Polymarket's matching 15-minute BTC market
//   anything else -> the page itself
const API = "https://api.elections.kalshi.com/trade-api/v2";
const H = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "application/json" };
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: H });
async function get(u) {
  const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "btc-radar-relay" }, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`Kalshi answered ${r.status}`);
  return r.json();
}
function best(rows, dollars) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let m = null;
  for (const x of rows) { const c = dollars ? Math.round(Number(x[0]) * 100) : Number(x[0]); if (Number(x[1]) > 0 && (m == null || c > m)) m = c; }
  return m;
}
async function currentMarket() {
  const now = Date.now();
  const pick = (list) => (list || []).filter((m) => Date.parse(m.close_time) > now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0];
  let m = pick((await get(`${API}/markets?series_ticker=KXBTC15M&status=open&limit=10`)).markets);
  if (!m) { // right at a rollover the "open" list can be empty for a moment
    const t = Math.floor(now / 1000);
    m = pick((await get(`${API}/markets?series_ticker=KXBTC15M&min_close_ts=${t}&max_close_ts=${t + 1800}&limit=10`)).markets);
  }
  return m || null;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/k") {
        const m = await currentMarket();
        if (!m) return J({ error: "no open KXBTC15M market right now (between windows?)" });
        try { // the market summary lags; use the live order book like the Mac bot does
          const j = await get(`${API}/markets/${m.ticker}/orderbook?depth=5`), fp = j.orderbook_fp || j.orderbook || {};
          const yb = best(fp.yes_dollars || fp.yes, !!fp.yes_dollars), nb = best(fp.no_dollars || fp.no, !!fp.no_dollars);
          if (yb != null || nb != null) {
            const L = { yes_bid: yb, no_bid: nb, yes_ask: nb != null ? 100 - nb : null, no_ask: yb != null ? 100 - yb : null };
            for (const [k, v] of Object.entries(L)) { delete m[k]; m[k + "_dollars"] = v == null ? null : (v / 100).toFixed(4); }
            m.price_source = "order book";
          }
        } catch {}
        return J(m);
      }
      if (url.pathname === "/kr") {
        const t = url.searchParams.get("ticker") || "";
        if (!/^KXBTC15M-[A-Z0-9-]+$/.test(t)) return J({ error: "bad ticker" }, 400);
        const j = await get(`${API}/markets/${t}`);
        return J({ ticker: t, result: j.market?.result || null, status: j.market?.status || null });
      }
      if (url.pathname === "/pm") {
        const start = Math.floor(Date.now() / 1000 / 900) * 900, slug = "btc-updown-15m-" + start;
        const r = await fetch("https://gamma-api.polymarket.com/events?slug=" + slug, { headers: { Accept: "application/json" } });
        const j = await r.json(), ev = Array.isArray(j) ? j[0] : j, m = ev && ev.markets && ev.markets[0];
        if (!m) return J({ error: "no market for " + slug });
        const pj = (x) => (typeof x === "string" ? JSON.parse(x) : x), outs = pj(m.outcomes) || [], prs = pj(m.outcomePrices) || [];
        const iu = outs.findIndex((o) => String(o).toLowerCase() === "up");
        return J({ slug, up: iu >= 0 && prs[iu] != null ? Number(prs[iu]) : null, outcomes: outs, prices: prs, bestBid: m.bestBid, bestAsk: m.bestAsk });
      }
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 502);
    }
    return env.ASSETS.fetch(request);
  },
};
