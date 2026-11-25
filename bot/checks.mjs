// Evidence checks: the bot grades its own results before anyone trusts them.
//
// Every run ends with these checks. A result only counts if the data behind it was good,
// the paper fills could really have happened, and the numbers hold up on both halves.
// Run 1 (takeoffs 16/16) would have failed check 1 and check 3 automatically.
//
//   node bot/checks.mjs            -> prints the checks for bot/data (or DATA_DIR)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTicks } from './backtest.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// status: pass | warn | fail.  A "fail" means: don't trust these results at all.
export function runChecks(state, ticks) {
  const out = [];
  const EXPECT = {
    'Live prices': 'prices change on 8%+ of seconds',
    'Data coverage': '80%+ of seconds recorded, 5 or fewer gaps',
    'Fills were real': 'the buy price still there 1-2s later on 85%+ of buys',
    'Believable win rate': 'under 80% (real edges here are small)',
    'Both halves profitable': 'profit in both the first and second half of trades',
    'Enough trades': '100+ trades',
  };
  const LOOK = {
    'Live prices': 'bot/bot.mjs currentMarket(): is it reading /orderbook? (list prices refresh ~every 28s)',
    'Data coverage': 'the run log for data errors; Kalshi/Coinbase blocking or rate limits',
    'Fills were real': 'bot/v32.mjs entries: buying moves that are already gone; add a delay or a resting order',
    'Both halves profitable': 'trades by rule in RESULTS.md: which rule loses in which half',
  };
  const add = (name, status, detail) => out.push({ name, status, detail, expected: EXPECT[name], look: status !== 'pass' ? LOOK[name] : undefined });
  const trades = state.trades || [];

  // 1. Are Kalshi prices live? Real order-book prices change on a good share of seconds.
  let changes = 0, pairs = 0;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1], b = ticks[i];
    if (a.ticker !== b.ticker || b.t - a.t > 3000) continue;
    pairs++; if (a.yesBid !== b.yesBid || a.yesAsk !== b.yesAsk) changes++;
  }
  const rate = pairs ? changes / pairs : 0;
  if (pairs < 600) add('Live prices', 'warn', `only ${pairs} seconds recorded so far`);
  else if (rate < 0.08) add('Live prices', 'fail', `Kalshi prices changed on only ${(rate * 100).toFixed(1)}% of seconds — they look stale, so trades can't be trusted`);
  else add('Live prices', 'pass', `Kalshi prices changed on ${(rate * 100).toFixed(0)}% of seconds`);

  // 2. Did the bot see the market most of the time?
  if (ticks.length > 1) {
    const span = (ticks[ticks.length - 1].t - ticks[0].t) / 1000;
    const cover = ticks.length / Math.max(1, span);
    let gaps = 0;
    for (let i = 1; i < ticks.length; i++) if (ticks[i].t - ticks[i - 1].t > 30_000) gaps++;
    add('Data coverage', cover >= 0.8 && gaps <= 5 ? 'pass' : cover >= 0.5 ? 'warn' : 'fail',
      `${(cover * 100).toFixed(0)}% of seconds recorded, ${gaps} gap(s) over 30s`);
  } else add('Data coverage', 'warn', 'no price data yet');

  // 3. Could the paper fills really have happened? For each buy at the ask, the ask must
  //    still be at or below that price 1-2 seconds later (a real order takes time to land).
  const byT = ticks;
  let checked = 0, gone = 0;
  for (const tr of trades) {
    if (!tr.openedAt || tr.rule === 'bounce') continue;           // bounce entries are resting bids
    const later = byT.find(x => x.t >= tr.openedAt + 1000 && x.t <= tr.openedAt + 3000);
    if (!later) continue;
    checked++;
    const ask = tr.side === 'Down' ? later.noAsk : later.yesAsk;
    if (ask > tr.entry + 1) gone++;
  }
  if (checked < 5) add('Fills were real', 'warn', `${checked} buys checked so far`);
  else add('Fills were real', gone / checked > 0.3 ? 'fail' : gone / checked > 0.15 ? 'warn' : 'pass',
    `${checked - gone} of ${checked} buys: the price was still there 1-2s later${gone ? ` (${gone} were gone)` : ''}`);

  // 4. Too good to be true? Real edges in these markets are small.
  const n = trades.length, wins = trades.filter(t => t.win).length;
  if (n >= 20 && wins / n > 0.8) add('Believable win rate', 'warn', `${Math.round(wins / n * 100)}% won over ${n} trades — check it before trusting it`);
  else if (n >= 20) add('Believable win rate', 'pass', `${Math.round(wins / n * 100)}% won over ${n} trades`);
  else add('Believable win rate', 'warn', `${n} trades so far`);

  // 5. Does it hold up on both halves? Luck usually shows up in one half only.
  if (n >= 30) {
    const h = Math.floor(n / 2), sum = a => a.reduce((x, t) => x + t.pnl, 0);
    const a = sum(trades.slice(0, h)), b = sum(trades.slice(h));
    add('Both halves profitable', a > 0 && b > 0 ? 'pass' : a <= 0 && b <= 0 ? 'fail' : 'warn',
      `first half $${a.toFixed(2)}, second half $${b.toFixed(2)}`);
  } else add('Both halves profitable', 'warn', `needs 30+ trades (${n} so far)`);

  // 6. Enough trades to mean anything?
  add('Enough trades', n >= 100 ? 'pass' : 'warn', `${n} of 100`);

  const fails = out.filter(c => c.status === 'fail').length, warns = out.filter(c => c.status === 'warn').length;
  const verdict = fails ? 'DON\'T TRUST these results' : warns ? 'NOT PROVEN yet' : 'Evidence checks passed (still paper)';
  return { checks: out, fails, warns, verdict };
}

export function checksMarkdown(r) {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' };
  const lines = r.checks.map(c => `- ${icon[c.status]} **${c.name}**\n  - expected: ${c.expected}\n  - saw: ${c.detail}${c.look ? `\n  - look at: ${c.look}` : ''}`);
  return `## 🔍 Evidence checks: ${r.verdict}\n\n${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
  let s = { trades: [] };
  try { s = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch {}
  const r = runChecks(s, loadTicks(DATA));
  console.log(checksMarkdown(r));
  if (r.fails) process.exitCode = 2;
}
