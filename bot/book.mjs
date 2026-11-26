// Reads best bid/ask from Kalshi's /markets/{ticker}/orderbook reply.
// Kalshi now answers with { orderbook_fp: { yes_dollars: [["0.5600","11147.18"], ...], no_dollars: [...] } }.
// The old shape was { orderbook: { yes: [[56, 100], ...], no: [...] } }. Both are read here.
// Returns null when either side is empty (caller then keeps the market-list prices).

export function parseBook(reply) {
  const ob = (reply && (reply.orderbook_fp || reply.orderbook)) || {};
  const levels = (centsRows, dollarRows) => {
    const rows = Array.isArray(centsRows) && centsRows.length ? centsRows.map(([p, q]) => [+p, +q])
      : Array.isArray(dollarRows) ? dollarRows.map(([p, q]) => [Math.round(parseFloat(p) * 100), +q]) : [];
    return rows.filter(([p, q]) => q > 0 && p >= 1 && p <= 99).map(([p]) => p);
  };
  const yes = levels(ob.yes, ob.yes_dollars), no = levels(ob.no, ob.no_dollars);
  if (!yes.length || !no.length) return null;
  const yb = Math.max(...yes), nb = Math.max(...no);
  return { yesBid: yb, noBid: nb, yesAsk: 100 - nb, noAsk: 100 - yb };
}
