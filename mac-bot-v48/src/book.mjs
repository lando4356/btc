// Kalshi order book for one market. Kalshi lists bids only: YES bids and NO bids.
// Buying YES at x cents = matching a NO bid at (100 - x). Prices are kept in cents (can be fractional, e.g. 49.5).
const toCents = (d) => Math.round(Number(d) * 10000) / 100;

export class KBook {
  constructor(ticker) { this.ticker = ticker; this.yes = new Map(); this.no = new Map(); this.updated = 0; this.seq = null; this.exchTs = null; }
  _rows(msg, side) {
    const fp = msg[`${side}_dollars_fp`] || msg[`${side}_dollars`];
    if (Array.isArray(fp)) return fp.map(([p, q]) => [toCents(p), Number(q)]);
    const c = msg[side];
    if (Array.isArray(c)) return c.map(([p, q]) => [Number(p), Number(q)]);
    return [];
  }
  applySnapshot(msg, now = Date.now()) {
    this.yes.clear(); this.no.clear();
    for (const [p, q] of this._rows(msg, "yes")) if (q > 0) this.yes.set(p, q);
    for (const [p, q] of this._rows(msg, "no")) if (q > 0) this.no.set(p, q);
    this.updated = now;
  }
  applyDelta(msg, now = Date.now()) {
    const side = msg.side === "yes" ? this.yes : msg.side === "no" ? this.no : null;
    if (!side) return;
    const p = msg.price_dollars != null ? toCents(msg.price_dollars) : Number(msg.price);
    const d = Number(msg.delta_fp ?? msg.delta ?? 0);
    const q = (side.get(p) || 0) + d;
    if (q > 1e-9) side.set(p, q); else side.delete(p);
    this.updated = now;
  }
  bids(side, n = 50) { // best first
    return [...(side === "yes" ? this.yes : this.no).entries()].sort((a, b) => b[0] - a[0]).slice(0, n);
  }
  // Prices you can BUY `side` at, cheapest first: [[askCents, qty], ...]
  asks(side, n = 50) { return this.bids(side === "yes" ? "no" : "yes", n).map(([p, q]) => [+(100 - p).toFixed(2), q]); }
  top() {
    const yb = this.bids("yes", 1)[0], nb = this.bids("no", 1)[0];
    return {
      yesBid: yb ? yb[0] : null, yesBidQty: yb ? yb[1] : 0, noBid: nb ? nb[0] : null, noBidQty: nb ? nb[1] : 0,
      yesAsk: nb ? +(100 - nb[0]).toFixed(2) : null, yesAskQty: nb ? nb[1] : 0,
      noAsk: yb ? +(100 - yb[0]).toFixed(2) : null, noAskQty: yb ? yb[1] : 0,
    };
  }
  mid() { const t = this.top(); return t.yesBid != null && t.yesAsk != null ? (t.yesBid + t.yesAsk) / 200 : null; }
  imbalance(n = 3) {
    const y = this.bids("yes", n).reduce((s, x) => s + x[1], 0), no = this.bids("no", n).reduce((s, x) => s + x[1], 0);
    return y + no > 0 ? (y - no) / (y + no) : 0;
  }
  // Contracts available to buy `side` at or below limitCents, and the fill if we took `count` of them.
  fillBuy(side, count, limitCents) {
    let left = count, cost = 0; const fills = [];
    for (const [px, q] of this.asks(side)) { if (px > limitCents + 1e-9 || left <= 0) break; const take = Math.min(left, Math.floor(q)); if (take <= 0) continue; fills.push([px, take]); cost += px * take; left -= take; }
    const filled = count - left;
    return { filled, avg: filled ? cost / filled : null, fills };
  }
  fillSell(side, count, limitCents) {
    let left = count, got = 0; const fills = [];
    for (const [px, q] of this.bids(side)) { if (px < limitCents - 1e-9 || left <= 0) break; const take = Math.min(left, Math.floor(q)); if (take <= 0) continue; fills.push([px, take]); got += px * take; left -= take; }
    const filled = count - left;
    return { filled, avg: filled ? got / filled : null, fills };
  }
  depthAtOrBelow(side, limitCents) { return this.asks(side).filter(([p]) => p <= limitCents + 1e-9).reduce((s, x) => s + x[1], 0); }
  snapshotTop(n = 3) { return { yes: this.bids("yes", n), no: this.bids("no", n) }; }
}
