// Replays recorded ticks through the same strategy the bot uses.
//
//   node bot/backtest.mjs              -> run on every bot/data/ticks-*.csv
//   node bot/backtest.mjs --sweep      -> also try a few settings, scored on the
//                                         SECOND half of the data only, so a setting
//                                         that just got lucky on the first half shows up.
//
// The bot records ticks while it runs, so the more hours it runs, the more there is to test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, newState, onTick, settle, scoreboard } from './strategy.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv.find(a => a.startsWith('--data='))?.slice(7) || path.join(DIR, 'data');

export function loadTicks(dir = dataDir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /^ticks-.*\.csv$/.test(f)).sort();
  const ticks = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').slice(1);
    for (const l of lines) {
      const [t, ticker, closeTs, strike, btc, yesBid, yesAsk, noBid, noAsk, imb5, imb60] = l.split(',');
      ticks.push({ t: +t, ticker, closeTs: +closeTs, strike: +strike, btc: +btc,
        yesBid: +yesBid, yesAsk: +yesAsk, noBid: +noBid, noAsk: +noAsk, imb5: +(imb5 || 0), imb60: +(imb60 || 0) });
    }
  }
  return ticks.sort((a, b) => a.t - b.t);
}

export function run(ticks, cfg = DEFAULTS) {
  const s = newState(cfg);
  let prev = null;
  for (const tick of ticks) {
    if (prev && prev.ticker !== tick.ticker && s.pos && s.pos.ticker === prev.ticker) {
      settle(s, prev, prev.btc >= prev.strike);   // settle from the last price we saw
    }
    onTick(s, tick, cfg);
    prev = tick;
  }
  if (s.pos && prev) settle(s, prev, prev.btc >= prev.strike);
  return s;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const ticks = loadTicks();
  const windows = new Set(ticks.map(t => t.ticker)).size;
  console.log(`${ticks.length} ticks, ${windows} windows (${(windows / 4).toFixed(1)} hours)\n`);
  if (!ticks.length) { console.log('No data yet. Run the bot for a while first: node bot/bot.mjs'); process.exit(0); }

  const s = run(ticks);
  const flat = scoreboard(run(ticks, { ...DEFAULTS, startBankroll: 1e9, maxStakePct: 1 }));
  console.log(`Flat $3 per trade: ${flat.trades} trades, ${flat.winRate}% won (break-even ${flat.breakEvenPct}%), P&L $${flat.pnl}`);
  const sb = scoreboard(s);
  console.log('Default settings:', sb);
  const byReason = {};
  for (const t of s.trades) { byReason[t.reason] ??= { n: 0, pnl: 0 }; byReason[t.reason].n++; byReason[t.reason].pnl += t.pnl; }
  for (const [r, v] of Object.entries(byReason)) console.log(`  ${r}: ${v.n} trades, $${v.pnl.toFixed(2)}`);

  if (process.argv.includes('--sweep')) {
    const half = ticks[Math.floor(ticks.length / 2)].t;
    const first = ticks.filter(t => t.t < half), second = ticks.filter(t => t.t >= half);
    console.log('\nSweep ($3 every trade): ranked by first half; the second half is the honest number');
    const results = [];
    for (const maxEntry of [20, 25, 30, 35])
      for (const bounceUsd of [15, 25, 40])
        for (const trendMoveUsd of [20, 40, 80]) {
          const c = { ...DEFAULTS, maxEntry, bounceUsd, trendMoveUsd, startBankroll: 1e9, maxStakePct: 1 }; // fixed $3 per trade
          const a = scoreboard(run(first, c)), b = scoreboard(run(second, c));
          results.push({ maxEntry, bounceUsd, trendMoveUsd, firstPnl: a.pnl, firstN: a.trades, secondPnl: b.pnl, secondN: b.trades });
        }
    results.sort((x, y) => y.firstPnl - x.firstPnl);
    console.table(results.slice(0, 8));
    console.log('If the best first-half settings do badly on the second half, they were luck, not edge.');
  }
}
