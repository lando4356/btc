// Writes bot/RESULTS.md from the paper bot's saved state (used by the GitHub Action).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreboard, DEFAULTS } from './strategy.mjs';
import { runChecks, checksMarkdown, recordAndEscalate, escalateMarkdown } from './checks.mjs';
import { loadTicks } from './backtest.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
let s;
try { s = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { s = { trades: [], bankroll: 30, patternStats: {} }; }
const sb = scoreboard(s);
const byRule = {};
for (const t of s.trades) { const k = t.rule || 'bounce'; byRule[k] ??= { n: 0, w: 0, pnl: 0 }; byRule[k].n++; byRule[k].w += t.win ? 1 : 0; byRule[k].pnl += t.pnl; }
let pats = [];
try { pats = JSON.parse(fs.readFileSync(path.join(DATA, 'patterns.json'), 'utf8')).patterns || []; } catch {}
const ticks = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => f.startsWith('ticks-')).length : 0;
const evidence = runChecks(s, loadTicks(DATA));
const repeat = fs.existsSync(DATA) ? recordAndEscalate(path.join(DATA, 'check-history.json'), evidence) : [];
const byHour = {};
for (const t of s.trades) { const h = +new Date(t.openedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }) % 24; byHour[h] ??= { n: 0, w: 0, pnl: 0 }; byHour[h].n++; byHour[h].w += t.win ? 1 : 0; byHour[h].pnl += t.pnl; }
const hourName = h => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const name = k => k === 'rocket' ? '🚀 Takeoffs' : k === 'dip' ? 'Dip buys' : k === 'bounce' ? 'Bounce rule' : `Learned: ${k.replace(/\|/g, '·')}`;
const md = `# 📄 Paper bot results (fake money)

_Updated ${new Date().toUTCString()}_

${escalateMarkdown(repeat)}${checksMarkdown(evidence)}

## ${sb.verdict}

**Paper balance:** $${sb.bankroll} (started $30) · **P&L:** $${sb.pnl} · **${sb.wins}/${sb.trades} won (${sb.winRate}%)** · break-even ${sb.breakEvenPct}%

| Rule | Trades | Won | P&L |
|---|---|---|---|
${Object.entries(byRule).map(([k, v]) => `| ${name(k)} | ${v.n} | ${v.w} | $${v.pnl.toFixed(2)} |`).join('\n') || '| (none yet) | 0 | 0 | $0 |'}

**Wins by hour (Chicago time)**: which hours the rules actually work in (needs lots of trades to mean anything)

| Hour | Trades | Won | P&L |
|---|---|---|---|
${Object.keys(byHour).sort((a, b) => a - b).map(h => `| ${hourName(+h)} | ${byHour[h].n} | ${byHour[h].w} | $${byHour[h].pnl.toFixed(2)} |`).join('\n') || '| (none yet) | 0 | 0 | $0 |'}

**Brakes:** stop for the day after losing ${Math.round((DEFAULTS.dailyLossPct || 0) * 100)}%; sit out ${Math.round(DEFAULTS.streakPauseSecs / 60)} min after ${DEFAULTS.lossStreak} losses in a row.${s.lastSignal && /stop|pausing/.test(s.lastSignal) ? ` **Now:** ${s.lastSignal}` : ''}

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
${s.trades.slice(-15).reverse().map(t => `| ${new Date(t.closedAt).toISOString().slice(5, 16).replace('T', ' ')} | ${name(t.rule || 'bounce')} | ${t.side} | ${t.entry}¢ → ${t.exit}¢ | ${t.reason} | $${t.pnl} |`).join('\n') || '| | | | | | |'}

**Patterns the finder has proven:** ${pats.length ? pats.map(p => p.key).join(' · ') : 'none yet'} · days of data recorded: ${ticks}
`;
fs.writeFileSync(path.join(DIR, 'RESULTS.md'), md);
console.log(md);
