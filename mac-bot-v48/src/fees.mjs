// Kalshi trading fees (fee schedule effective 7 Jul 2026, checked 28 Nov 2026):
//   taker fee = round up( M x 0.07   x C x P x (1-P) )
//   maker fee = round up( M x 0.0175 x C x P x (1-P) )   (only on series with maker fees)
// P = price in dollars, C = contracts. "round up" = up to the next centicent ($0.0001); accounts held through a
// broker are rounded to the cent. KXBTC15M is fee_type "quadratic", multiplier 1: takers pay, resting (maker) orders pay 0.
// All functions take prices in CENTS and return DOLLARS unless the name says Cents.

const ceilTo = (x, step) => Math.ceil(x / step - 1e-9) * step;

export function takerFeeDollars(priceCents, count, { multiplier = 1, roundStep = 0.0001 } = {}) {
  if (!(count > 0)) return 0;
  const p = priceCents / 100;
  return +ceilTo(multiplier * 0.07 * count * p * (1 - p), roundStep).toFixed(6);
}

export function makerFeeDollars(priceCents, count, { feeType = "quadratic", multiplier = 1, roundStep = 0.0001 } = {}) {
  if (!(count > 0)) return 0;
  if (feeType !== "quadratic_with_maker_fees") return 0;
  const p = priceCents / 100;
  return +ceilTo(multiplier * 0.0175 * count * p * (1 - p), roundStep).toFixed(6);
}

// Fee per contract in cents for an order of `count` contracts (includes the rounding share).
export function feePerContractCents(priceCents, count = 1, opts = {}) {
  const c = Math.max(1, count);
  return (opts.maker ? makerFeeDollars(priceCents, c, opts) : takerFeeDollars(priceCents, c, opts)) * 100 / c;
}

// Expected value in cents per contract of buying at `priceCents` when the true chance of winning is `prob`,
// holding to settlement (settlement itself is free).
export function holdEdgeCents(prob, priceCents, count = 1, opts = {}) {
  return prob * 100 - priceCents - feePerContractCents(priceCents, count, opts);
}
