// Writes bot/RESULTS.md from the paper bot's saved state (used by the GitHub Action).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreboard } from './strategy.mjs';

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
const name = k => k === 'rocket' ? '🚀 Takeoffs' : k === 'dip' ? 'Dip buys' : k === 'bounce' ? 'Bounce rule' : `Learned: ${k.replace(/\|/g, '·')}`;
const md = `# 📄 Paper bot results (fake money)

_Updated ${new Date().toUTCString()}_

## ${sb.verdict}

**Paper balance:** $${sb.bankroll} (started $30) · **P&L:** $${sb.pnl} · **${sb.wins}/${sb.trades} won (${sb.winRate}%)** · break-even ${sb.breakEvenPct}%

| Rule | Trades | Won | P&L |
|---|---|---|---|
${Object.entries(byRule).map(([k, v]) => `| ${name(k)} | ${v.n} | ${v.w} | $${v.pnl.toFixed(2)} |`).join('\n') || '| (none yet) | 0 | 0 | $0 |'}

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
${s.trades.slice(-15).reverse().map(t => `| ${new Date(t.closedAt).toISOString().slice(5, 16).replace('T', ' ')} | ${name(t.rule || 'bounce')} | ${t.side} | ${t.entry}¢ → ${t.exit}¢ | ${t.reason} | $${t.pnl} |`).join('\n') || '| | | | | | |'}

**Patterns the finder has proven:** ${pats.length ? pats.map(p => p.key).join(' · ') : 'none yet'} · days of data recorded: ${ticks}
`;
fs.writeFileSync(path.join(DIR, 'RESULTS.md'), md);
console.log(md);
