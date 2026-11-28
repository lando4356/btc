// The v48 brain: start from Kalshi's own price, then let signals EARN a say, judged walk-forward only.
//
//   logit(P_up) = logit(Kalshi mid) + b0 + sum_k [ w_k * z_k + v_k * z_k * T ]
//
//   z_k = feature k standardized with the mean/sd of the TRAINING rows only; T = share of the window elapsed (0..1),
//   so every signal can matter more or less as the clock runs. With all weights at 0 the brain IS Kalshi's price.
//
// Walk-forward: when a window settles, its rows are first scored with the models as they were BEFORE seeing it
// (those scores are the out-of-sample record), and only then added to training. Nothing ever trains on the future.
// A signal group is accepted only when, over enough windows, it lowers out-of-sample log loss vs Kalshi's price alone
// by a statistically clear margin (t >= tAccept, a strict bar because 7 groups are tested). The active model uses only
// accepted groups. "Trusted" (allowed to drive real money) additionally needs positive out-of-sample after-fee P&L.
import { logit, sigmoid, logLoss, meanSd, solve, clamp } from "./stats.mjs";
import { takerFeeDollars } from "./fees.mjs";

export const GROUPS = {
  model: ["gap"],          // our BRTI-based fair value vs Kalshi (logit difference)
  flow: ["flow5", "flow60"],// taker buy/sell imbalance across exchanges
  momentum: ["mom10", "mom60"],
  lead: ["lead"],          // perpetual futures move vs spot
  book: ["bookImb"],       // exchange top-of-book size imbalance
  kbook: ["kImb"],         // Kalshi order book imbalance
  vol: ["volRatio"],       // short vs long volatility
};
export const GROUP_NAMES = Object.keys(GROUPS);

export const DEFAULT_BRAIN = {
  lambda: 20,              // ridge strength, in units of WINDOWS (rows within a window are highly correlated, so it is scaled by rows/window)
  minFitWindows: 20,       // fit nothing before this many settled windows
  minAcceptWindows: 150,   // a group needs this many out-of-sample windows before it can be accepted
  tAccept: 2.6,            // t-stat needed to accept (≈ Bonferroni for 7 groups at 5%)
  tDrop: 1.0,              // an accepted group is dropped if its t falls below this
  minTrustTrades: 300,     // simulated out-of-sample trades needed before the brain is "trusted"
  tTrust: 2.0,
  minEdgeCents: 3,
  slipCents: 1,
  maxTrainWindows: 1500,
  explorePriorGap: 0.5,    // paper exploration prior: halfway (in log-odds) between Kalshi and our fair value
};

const featNames = (groups) => groups.flatMap((g) => GROUPS[g]);

export function fitModel(rows, groups, { lambda = 4, prior = {}, warm = null, iters = 12 } = {}) {
  const names = featNames(groups);
  const mu = {}, sd = {};
  for (const k of names) {
    const v = rows.map((r) => r.f?.[k] ?? 0);
    const m = meanSd(v); mu[k] = m.mean; sd[k] = m.sd > 1e-9 ? m.sd : 1;
  }
  const d = 1 + names.length * 2;
  const w0 = new Array(d).fill(0);
  names.forEach((k, i) => { if (prior[k] != null) w0[1 + 2 * i] = prior[k] * sd[k]; }); // prior given per raw unit
  const L = new Array(d).fill(lambda); // the intercept is shrunk too: Kalshi's price is already calibrated, a free bias term overfits
  let w = warm && warm.length === d ? [...warm] : [...w0];
  const X = rows.map((r) => rowVec(r, names, mu, sd)), off = rows.map((r) => logit(r.pK)), y = rows.map((r) => r.y);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0), H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i]; let z = off[i]; for (let j = 0; j < d; j++) z += w[j] * x[j];
      const q = sigmoid(z), e = q - y[i], v = Math.max(q * (1 - q), 1e-6);
      for (let j = 0; j < d; j++) { if (!x[j]) continue; g[j] += e * x[j]; const vx = v * x[j]; for (let k = j; k < d; k++) H[j][k] += vx * x[k]; }
    }
    for (let j = 0; j < d; j++) { for (let k = 0; k < j; k++) H[j][k] = H[k][j]; g[j] += L[j] * (w[j] - w0[j]); H[j][j] += L[j]; }
    const st = solve(H, g); if (!st) break;
    let mx = 0; for (let j = 0; j < d; j++) { w[j] -= st[j]; mx = Math.max(mx, Math.abs(st[j])); }
    if (mx < 1e-6) break;
  }
  return { groups: [...groups], names, mu, sd, w, n: rows.length };
}

function rowVec(r, names, mu, sd) {
  const T = clamp(1 - (r.left ?? 450) / 900, 0, 1), x = [1];
  for (const k of names) { const z = clamp(((r.f?.[k] ?? 0) - mu[k]) / sd[k], -6, 6); x.push(z, z * T); }
  return x;
}

export function predict(model, r) {
  if (!model) return r.pK;
  const x = rowVec(r, model.names, model.mu, model.sd);
  let z = logit(r.pK); for (let j = 0; j < x.length; j++) z += model.w[j] * x[j];
  return clamp(sigmoid(z), 0.001, 0.999);
}

// Simulated after-fee P&L (cents, 1 contract) for one window: first row where the model's edge clears the bar,
// buy at the logged ask and hold to settlement. Returns null if no trade.
export function simWindowTrade(rows, probs, y, { minEdgeCents = 3, slipCents = 1 } = {}) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = probs[i];
    for (const side of ["up", "down"]) {
      const ask = side === "up" ? r.askYes : r.askNo;
      if (!(ask >= 5 && ask <= 95)) continue;
      const ps = side === "up" ? p : 1 - p, fee = takerFeeDollars(ask, 1) * 100;
      if (ps * 100 - ask - fee - slipCents >= minEdgeCents) {
        const won = side === "up" ? y === 1 : y === 0;
        return { side, ask, pnl: (won ? 100 : 0) - ask - fee - slipCents, left: r.left };
      }
    }
  }
  return null;
}

export class Brain {
  constructor(opts = {}) {
    this.o = { ...DEFAULT_BRAIN, ...opts };
    this.train = [];          // [{ win, rows:[...] }] settled windows, oldest first
    this.pending = new Map(); // win -> rows waiting for a result
    this.models = { cand: {}, active: null, explore: null };
    this.accepted = new Set();
    this.evals = [];          // per settled window out-of-sample record
    this.lastFitMs = 0;
    this.sinceFit = 0;
  }
  addSample(row) { // row: { win, t, left, pK, p0, askYes, askNo, f:{...} }
    if (!(row.pK > 0 && row.pK < 1)) return;
    const a = this.pending.get(row.win) || []; a.push(row); this.pending.set(row.win, a);
  }
  dropPending(win) { this.pending.delete(win); }
  windows() { return this.train.length; }

  predictAll(r) {
    const out = { pK: r.pK, active: predict(this.models.active, r), explore: null };
    if (this.models.explore) out.explore = predict(this.models.explore, r);
    else { const g = r.f?.gap ?? 0; out.explore = clamp(sigmoid(logit(r.pK) + this.o.explorePriorGap * g), 0.001, 0.999); }
    for (const g of GROUP_NAMES) out["cand_" + g] = this.models.cand[g] ? predict(this.models.cand[g], r) : r.pK;
    return out;
  }

  // A window's official result arrived. refit=false lets a log replay refit less often (still walk-forward).
  settle(win, y, { refit = true } = {}) {
    const rows = (this.pending.get(win) || []).sort((a, b) => a.t - b.t);
    this.pending.delete(win);
    if (!rows.length) return null;
    for (const r of rows) r.y = y;
    // 1) out-of-sample scoring with models fit on earlier windows only
    const ev = { win, n: rows.length, y, ll: {}, trade: {} };
    const sim = this.o;
    const score = (name, probs) => {
      ev.ll[name] = rows.reduce((s, r, i) => s + logLoss(probs[i], y), 0) / rows.length;
      ev.trade[name] = simWindowTrade(rows, probs, y, sim);
    };
    score("kalshi", rows.map((r) => r.pK));
    for (const g of GROUP_NAMES) if (this.models.cand[g]) score("cand_" + g, rows.map((r) => predict(this.models.cand[g], r)));
    if (this.models.active) score("active", rows.map((r) => predict(this.models.active, r)));
    score("explore", rows.map((r) => this.predictAll(r).explore));
    this.evals.push(ev);
    if (this.evals.length > 5000) this.evals.shift();
    // 2) now (and only now) learn from it
    this.train.push({ win, rows });
    if (this.train.length > this.o.maxTrainWindows) this.train.shift();
    this.sinceFit++;
    if (refit) this.refit();
    return ev;
  }

  refit() {
    const t0 = performance.now();
    this.sinceFit = 0;
    if (this.train.length < this.o.minFitWindows) { this.lastFitMs = performance.now() - t0; return; }
    const rows = this.train.flatMap((w) => w.rows);
    const lam = this.o.lambda * rows.length / this.train.length; // prior worth `lambda` windows, not `lambda` seconds
    for (const g of GROUP_NAMES) this.models.cand[g] = fitModel(rows, [g], { lambda: lam, warm: this.models.cand[g]?.w });
    this.updateAccepted();
    const acc = GROUP_NAMES.filter((g) => this.accepted.has(g));
    this.models.active = acc.length ? fitModel(rows, acc, { lambda: lam, warm: this.models.active?.groups.join() === acc.join() ? this.models.active.w : null }) : null;
    this.models.explore = fitModel(rows, GROUP_NAMES, { lambda: lam, prior: { gap: this.o.explorePriorGap }, warm: this.models.explore?.w });
    this.lastFitMs = performance.now() - t0;
  }

  groupStats(g) {
    const name = "cand_" + g, d = this.evals.filter((e) => e.ll[name] != null).map((e) => e.ll.kalshi - e.ll[name]);
    const m = meanSd(d);
    return { windows: m.n, gain: m.mean, t: m.se > 0 ? m.mean / m.se : 0 };
  }
  updateAccepted() {
    for (const g of GROUP_NAMES) {
      const s = this.groupStats(g);
      if (!this.accepted.has(g) && s.windows >= this.o.minAcceptWindows && s.gain > 0 && s.t >= this.o.tAccept) this.accepted.add(g);
      else if (this.accepted.has(g) && s.t < this.o.tDrop) this.accepted.delete(g);
    }
  }
  tradeStats(name) {
    const tr = this.evals.map((e) => e.trade[name]).filter(Boolean), m = meanSd(tr.map((x) => x.pnl));
    return { trades: m.n, avgCents: m.mean, t: m.se > 0 ? m.mean / m.se : 0, totalCents: m.mean * m.n };
  }
  llStats(name) {
    const d = this.evals.filter((e) => e.ll[name] != null).map((e) => e.ll.kalshi - e.ll[name]), m = meanSd(d);
    return { windows: m.n, gainVsKalshi: m.mean, t: m.se > 0 ? m.mean / m.se : 0 };
  }
  trusted() {
    if (!this.models.active) return false;
    const tr = this.tradeStats("active"), ll = this.llStats("active");
    return tr.trades >= this.o.minTrustTrades && tr.avgCents > 0 && tr.t >= this.o.tTrust && ll.gainVsKalshi > 0 && ll.t >= this.o.tTrust;
  }
  summary() {
    return {
      windows: this.train.length, evaluated: this.evals.length, lastFitMs: +this.lastFitMs.toFixed(1),
      accepted: [...this.accepted], trusted: this.trusted(),
      groups: Object.fromEntries(GROUP_NAMES.map((g) => [g, { ...this.groupStats(g), accepted: this.accepted.has(g), trade: this.tradeStats("cand_" + g) }])),
      active: this.models.active ? { groups: this.models.active.groups, ll: this.llStats("active"), trade: this.tradeStats("active") } : null,
      explore: { ll: this.llStats("explore"), trade: this.tradeStats("explore") },
    };
  }
}
