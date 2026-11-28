// Two brokers with the same interface. The engine never knows which one it is talking to.
//  PaperBroker: honest simulation. Waits the measured order delay, then fills against the REAL Kalshi book at that
//               moment (walking price levels, never better than the book), and charges Kalshi's fee formula.
//  RealBroker:  sends real orders to Kalshi (immediate-or-cancel by default; resting post-only orders if enabled).
import { takerFeeDollars, makerFeeDollars } from "./fees.mjs";
import { sleep } from "./util.mjs";

const levelFee = (fills, feeFn) => { // Kalshi computes the fee per fill; sum then round per order
  let raw = 0; for (const [px, q] of fills) raw += feeFn(px, q, { roundStep: 1e-9 });
  return Math.ceil(raw * 10000 - 1e-6) / 10000;
};

export class PaperBroker {
  constructor({ kalshi, startBalance = 100, delayMs = null, feeOpts = {}, saved = null }) {
    this.kind = "paper"; this.k = kalshi; this.cash = saved?.cash ?? startBalance; this.start = saved?.start ?? startBalance;
    this.fixedDelay = delayMs; this.feeOpts = feeOpts; this.open = saved?.open || {}; // ticker -> { yes: n, no: n }
  }
  delay() { if (this.fixedDelay != null) return this.fixedDelay; const l = this.k.latency(); return Math.round(l.postMedianMs ?? l.getMedianMs ?? 150); }
  balance() { return this.cash; }
  _pos(t, side, d) { const p = this.open[t] || (this.open[t] = { yes: 0, no: 0 }); p[side] += d; }
  async buy({ ticker, side, count, limitCents }) {
    const delayMs = this.delay(); await sleep(delayMs);
    const b = this.k.book(ticker), f = b.fillBuy(side, count, limitCents);
    if (!f.filled) return { filled: 0, avg: null, feeDollars: 0, delayMs, simulated: true };
    const fee = levelFee(f.fills, (p, q, o) => takerFeeDollars(p, q, { ...this.feeOpts, ...o }));
    const cost = (f.avg * f.filled) / 100 + fee;
    if (cost > this.cash) return { filled: 0, avg: null, feeDollars: 0, delayMs, simulated: true, why: "paper cash too low" };
    this.cash -= cost; this._pos(ticker, side, f.filled);
    return { filled: f.filled, avg: f.avg, feeDollars: fee, delayMs, simulated: true, fills: f.fills };
  }
  async sell({ ticker, side, count, limitCents }) {
    const delayMs = this.delay(); await sleep(delayMs);
    const have = this.open[ticker]?.[side] || 0; count = Math.min(count, have);
    const b = this.k.book(ticker), f = b.fillSell(side, count, limitCents);
    if (!f.filled) return { filled: 0, avg: null, feeDollars: 0, delayMs, simulated: true };
    const fee = levelFee(f.fills, (p, q, o) => takerFeeDollars(p, q, { ...this.feeOpts, ...o }));
    this.cash += (f.avg * f.filled) / 100 - fee; this._pos(ticker, side, -f.filled);
    return { filled: f.filled, avg: f.avg, feeDollars: fee, delayMs, simulated: true, fills: f.fills };
  }
  // Resting post-only buy. Simulated fill only if the book TRADES THROUGH our price (the best ask for our side
  // drops to our price or lower) before the timeout. Queue position is ignored, so this is optimistic; it is labeled.
  async buyMaker({ ticker, side, count, priceCents, timeoutMs, stillWanted }) {
    const t0 = Date.now(); const b = this.k.book(ticker);
    const ask0 = b.asks(side, 1)[0]?.[0];
    if (ask0 != null && ask0 <= priceCents) return { filled: 0, why: "would cross (post-only rejected)", simulated: true };
    while (Date.now() - t0 < timeoutMs) {
      await sleep(200);
      if (stillWanted && !stillWanted()) return { filled: 0, why: "edge gone, canceled", simulated: true };
      const ask = b.asks(side, 1)[0]?.[0];
      if (ask != null && ask < priceCents) { // traded through: assume we were filled at our price
        const fee = makerFeeDollars(priceCents, count, this.feeOpts), cost = (priceCents * count) / 100 + fee;
        if (cost > this.cash) return { filled: 0, why: "paper cash too low", simulated: true };
        this.cash -= cost; this._pos(ticker, side, count);
        return { filled: count, avg: priceCents, feeDollars: fee, delayMs: Date.now() - t0, simulated: true, maker: true, optimistic: true };
      }
    }
    return { filled: 0, why: "not filled before timeout, canceled", simulated: true };
  }
  settle(ticker, result) { // result "yes" | "no": pays $1 per winning contract
    const p = this.open[ticker]; if (!p) return 0;
    const pay = (result === "yes" ? p.yes : p.no) * 1; this.cash += pay; delete this.open[ticker]; return pay;
  }
  toJSON() { return { cash: this.cash, start: this.start, open: this.open }; }
}

export class RealBroker {
  constructor({ kalshi, feeOpts = {}, log = () => {} }) { this.kind = "real"; this.k = kalshi; this.feeOpts = feeOpts; this.log = log; }
  balance() { return this.k.acct.shardBalance ?? this.k.acct.balance ?? 0; }
  _fee(avg, n, maker = false) { if (!n || avg == null) return 0; return maker ? makerFeeDollars(avg, n, this.feeOpts) : takerFeeDollars(avg, n, this.feeOpts); }
  async buy({ ticker, side, count, limitCents }) {
    const t0 = Date.now();
    const o = await this.k.placeOrder({ ticker, side, action: "buy", count, cents: limitCents });
    return { filled: o.filled, avg: o.avg, feeDollars: this._fee(o.avg, o.filled), delayMs: Date.now() - t0, apiMs: o.ms, orderId: o.orderId, raw: o.raw };
  }
  async sell({ ticker, side, count, limitCents }) {
    const t0 = Date.now();
    const o = await this.k.placeOrder({ ticker, side, action: "sell", count, cents: limitCents, reduceOnly: true });
    return { filled: o.filled, avg: o.avg, feeDollars: this._fee(o.avg, o.filled), delayMs: Date.now() - t0, apiMs: o.ms, orderId: o.orderId, raw: o.raw };
  }
  // EXPERIMENTAL (not tested against the live API): resting post-only limit buy, canceled after timeoutMs or when the
  // edge is gone. Fills are read back from the order record.
  async buyMaker({ ticker, side, count, priceCents, timeoutMs, stillWanted }) {
    const t0 = Date.now();
    const o = await this.k.placeOrder({ ticker, side, action: "buy", count, cents: priceCents, tif: "good_till_canceled", postOnly: true });
    let filled = o.filled, avg = o.avg, done = filled >= count;
    while (!done && Date.now() - t0 < timeoutMs && (!stillWanted || stillWanted())) {
      await sleep(500);
      try { const x = await this.k.getOrder(o.orderId); filled = Math.round(Number(x.fill_count ?? x.fill_count_fp ?? filled)); done = filled >= count || x.status === "executed" || x.status === "canceled"; } catch {}
    }
    if (!done) { try { await this.k.cancelOrder(o.orderId, ticker); } catch (e) { this.log({ event: "CANCEL_FAILED", orderId: o.orderId, error: e.message }); }
      try { const x = await this.k.getOrder(o.orderId); filled = Math.round(Number(x.fill_count ?? x.fill_count_fp ?? filled)); } catch {} }
    return { filled, avg: filled ? priceCents : null, feeDollars: this._fee(priceCents, filled, true), delayMs: Date.now() - t0, orderId: o.orderId, maker: true };
  }
  settle() { return 0; } // Kalshi settles real positions itself
}
