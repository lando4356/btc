// Position sizing: fractional Kelly for a binary contract, with hard caps.
// Buying one contract costs c dollars (price + fee) and pays $1 if it wins with probability p.
// Full Kelly stake as a share of bankroll: f* = (p - c) / (1 - c). We use a fraction of it (default 1/4) and
// never more than maxFraction of the balance (default 3%).
export function kellyFraction(prob, costDollars) {
  if (!(costDollars > 0 && costDollars < 1)) return 0;
  const f = (prob - costDollars) / (1 - costDollars);
  return f > 0 ? f : 0;
}

export function sizeOrder({ prob, priceCents, feeCentsPerContract, balanceDollars, kellyMultiplier = 0.25, maxFraction = 0.03, maxContracts = 200, maxDepth = Infinity }) {
  const cost = (priceCents + feeCentsPerContract) / 100;
  const fFull = kellyFraction(prob, cost);
  const frac = Math.min(fFull * kellyMultiplier, maxFraction);
  const stake = Math.max(0, balanceDollars) * frac;
  let count = Math.floor(stake / cost + 1e-9);
  count = Math.max(0, Math.min(count, maxContracts, Math.floor(maxDepth)));
  return { count, fullKelly: fFull, fraction: frac, stakeDollars: +(count * cost).toFixed(4), costPerContract: cost };
}
