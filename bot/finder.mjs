// Pattern finder: lets the bot look for its own patterns WITHOUT fooling itself.
//
//   node bot/finder.mjs            -> searches bot/data, writes bot/data/patterns.json
//
// 1. Splits the recorded windows by time: the older 70% to search, the newest 30% held back.
// 2. Searches every combination of 2-3 simple conditions (time left, BTC vs strike,
//    30-minute move, 3-minute move, contract price) for Up and for Down.
// 3. A "trade" = buy that side at the ask the first time the pattern shows up in a window,
//    pay Kalshi's taker fee, hold to the end. Counted per contract, in cents.
// 4. The best-looking patterns on the older data are then checked ONCE on the held-back data.
//    Only ones that still win there, after fees, get promoted to the paper bot.
// Searching thousands of combos always finds some that look great by luck; step 4 is what
// catches them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTicks } from './backtest.mjs';
import { features, patternKeys } from './features.mjs';
import { takerFeeCents } from './strategy.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dataDir = arg('data', path.join(DIR, 'data'));
const outFile = arg('out', path.join(dataDir, 'patterns.json'));

export const RULES = {
  trainShare: 0.7,
  minTrainTrades: 40,     // a pattern must show up in at least this many older windows
  shortlist: 25,          // how many of the best older-data patterns get tested
  minTestTrades: 30,      // ...and this many held-back windows
  minTestEdge: 1.0,       // average profit per contract on held-back data, cents, after fees
  minTestT: 1.5,          // and it must be steady, not one lucky streak (t-statistic)
};

const feePer = c => takerFeeCents(10, c) / 10;   // fee per contract on a 10-contract order
const stats = xs => {
  const n = xs.length, mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, win: n ? xs.filter(x => x > 0).length / n : 0 };
};

export function findPatterns(ticks, rules = RULES) {
  // outcome of each window from its last tick
  const last = new Map();
  for (const t of ticks) last.set(t.ticker, t);
  const order = [...new Set(ticks.map(t => t.ticker))];
  const cut = Math.floor(order.length * rules.trainShare);
  const isTrain = new Map(order.map((k, i) => [k, i < cut]));

  const results = new Map();   // key -> { train: [cents], test: [cents], seen: Set(ticker) }
  const hist = [];
  let lastSample = 0;
  for (const tick of ticks) {
    if (hist.length && tick.t - hist[hist.length - 1].t > 60_000) hist.length = 0;
    hist.push({ t: tick.t, btc: tick.btc });
    while (hist[0].t < tick.t - 1_900_000) hist.shift();
    if (tick.t - lastSample < 10_000) continue;       // look every 10 seconds
    lastSample = tick.t;
    const f = features(hist, tick);
    if (!f) continue;
    const end = last.get(tick.ticker);
    if (end.closeTs - end.t > 30_000) continue;        // window not fully recorded, outcome unknown
    const yesWon = end.btc >= end.strike;
    for (const side of ['yes', 'no']) {
      const ask = side === 'yes' ? tick.yesAsk : tick.noAsk;
      if (!(ask >= 3 && ask <= 97)) continue;
      const won = (side === 'yes') === yesWon;
      const profit = (won ? 100 : 0) - ask - feePer(ask);
      for (const key of patternKeys(f, side, ask)) {
        let r = results.get(key);
        if (!r) results.set(key, r = { train: [], test: [], seen: new Set() });
        if (r.seen.has(tick.ticker)) continue;          // first appearance per window only
        r.seen.add(tick.ticker);
        (isTrain.get(tick.ticker) ? r.train : r.test).push(profit);
      }
    }
  }

  const all = [...results].map(([key, r]) => ({ key, train: stats(r.train), test: stats(r.test) }));
  const shortlist = all
    .filter(p => p.train.n >= rules.minTrainTrades && p.train.mean > 0)
    .sort((a, b) => b.train.t - a.train.t)
    .slice(0, rules.shortlist);
  const promoted = shortlist.filter(p =>
    p.test.n >= rules.minTestTrades && p.test.mean >= rules.minTestEdge && p.test.t >= rules.minTestT);
  return { windows: order.length, trainWindows: cut, searched: all.length, shortlist, promoted };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const ticks = loadTicks(dataDir);
  const r = findPatterns(ticks);
  console.log(`${r.windows} windows (${(r.windows / 4).toFixed(0)} hours): searched ${r.searched} patterns on the older ${r.trainWindows}, tested the best ${r.shortlist.length} on the newest ${r.windows - r.trainWindows}.\n`);
  const fmt = s => `${s.n} trades, ${(s.win * 100).toFixed(0)}% won, ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)}¢/contract`;
  for (const p of r.shortlist) {
    const ok = r.promoted.includes(p);
    console.log(`${ok ? '✅ KEEP' : '❌ luck'}  ${p.key}\n         older: ${fmt(p.train)}   |   held back: ${fmt(p.test)}`);
  }
  if (r.windows < 400) console.log(`\nOnly ${r.windows} windows recorded. Results get trustworthy after ~1,000 (about 10 days of running).`);
  console.log(`\n${r.promoted.length} pattern(s) promoted to the paper bot.`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    createdAt: new Date().toISOString(), windows: r.windows,
    patterns: r.promoted.map(p => ({ key: p.key, testTrades: p.test.n, testEdgeCents: +p.test.mean.toFixed(2) })),
  }, null, 1));
  console.log(`Saved to ${outFile}`);
}
