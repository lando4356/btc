// Describes the market at one moment as a few simple buckets. The pattern finder
// searches combinations of these; the bot uses the same function to spot them live.

export function valueAt(hist, t) {
  let v = null;
  for (const h of hist) { if (h.t <= t) v = h.btc; else break; }
  return v;
}

const bucket = (x, edges, labels) => { for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i]; return labels[edges.length]; };

// hist: recent [{t, btc}] including this tick. Returns null if not enough history.
export function features(hist, tick) {
  const secsLeft = (tick.closeTs - tick.t) / 1000;
  if (secsLeft > 780 || secsLeft < 180) return null;            // 13 to 3 minutes left
  const p30 = valueAt(hist, tick.t - 1_800_000), p3 = valueAt(hist, tick.t - 180_000);
  if (p30 === null || p3 === null || hist[0].t > tick.t - 1_795_000) return null;
  const gap = tick.btc - tick.strike, m30 = tick.btc - p30, m3 = tick.btc - p3;
  const f = {
    time: bucket(secsLeft, [360, 540], ['3-6m left', '6-9m left', '9-13m left']),
    gap: bucket(gap, [-60, -20, 20, 60], ['BTC 60+ under strike', 'BTC 20-60 under', 'BTC near strike', 'BTC 20-60 over', 'BTC 60+ over']),
    m30: bucket(m30, [-80, -20, 20, 80], ['30m: down 80+', '30m: down 20-80', '30m: flat', '30m: up 20-80', '30m: up 80+']),
    m3: bucket(m3, [-30, -10, 10, 30], ['3m: down 30+', '3m: down 10-30', '3m: flat', '3m: up 10-30', '3m: up 30+']),
  };
  return f;
}

export const priceBucket = c => bucket(c, [21, 36, 51, 66, 81], ['price ≤20¢', 'price 21-35¢', 'price 36-50¢', 'price 51-65¢', 'price 66-80¢', 'price 81¢+']);

// Every pattern key that this moment matches for one side: all pairs and triples of features.
const KEYS = ['time', 'gap', 'm30', 'm3', 'px'];
const COMBOS = [];
for (let a = 0; a < KEYS.length; a++) for (let b = a + 1; b < KEYS.length; b++) {
  COMBOS.push([KEYS[a], KEYS[b]]);
  for (let c = b + 1; c < KEYS.length; c++) COMBOS.push([KEYS[a], KEYS[b], KEYS[c]]);
}
export function patternKeys(f, side, askCents) {
  const all = { ...f, px: priceBucket(askCents) };
  return COMBOS.map(ks => `${side === 'yes' ? 'Up' : 'Down'} | ${ks.map(k => all[k]).join(' + ')}`);
}
