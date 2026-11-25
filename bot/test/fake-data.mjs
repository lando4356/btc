// Makes fake tick files for testing the bot's plumbing. The fake market is priced
// FAIRLY, so a correct backtest should show NO edge here: it should lose a little to the
// spread, exit fees and fill timing. If it shows big profits on fake data, something is broken.
//
//   node bot/test/fake-data.mjs [hours] [outDir]

import fs from 'node:fs';
import path from 'node:path';

const hours = +(process.argv[2] || 48);
const out = process.argv[3] || path.join(process.cwd(), 'bot/test/fake');
fs.mkdirSync(out, { recursive: true });

let seed = 7;   // mulberry32: small seeded random generator
const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const ncdf = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };

const volPerSec = 2.2;            // ~$85 typical move over 15 minutes
let btc = 95000, t0 = Date.UTC(2026, 10, 1);
const rows = ['t,ticker,closeTs,strike,btc,yesBid,yesAsk,noBid,noAsk'];
for (let w = 0; w < hours * 4; w++) {
  const open = t0 + w * 900_000, close = open + 900_000, strike = btc;
  const ticker = `KXBTC15M-FAKE${String(w).padStart(5, '0')}`;
  for (let t = open; t < close; t += 2000) {
    btc += gauss() * volPerSec * Math.sqrt(2);
    const left = (close - t) / 1000;
    const pUp = ncdf((btc - strike) / (volPerSec * Math.sqrt(Math.max(left, 1))));
    const mid = Math.min(99, Math.max(1, Math.round(pUp * 100)));
    const yesBid = Math.max(1, mid - 1), yesAsk = Math.min(99, mid + 1);
    rows.push([t, ticker, close, strike.toFixed(2), btc.toFixed(2), yesBid, yesAsk, 100 - yesAsk, 100 - yesBid].join(','));
  }
}
fs.writeFileSync(path.join(out, 'ticks-fake.csv'), rows.join('\n') + '\n');
console.log(`wrote ${rows.length - 1} fake ticks (${hours}h) to ${out}`);
