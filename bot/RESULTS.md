# 📄 Paper bot results (fake money)

_Updated Sat, 28 Nov 2026 13:40:56 GMT_

## 🔍 Evidence checks: NOT PROVEN yet

- ✅ **Live prices**
  - expected: prices change on 8%+ of seconds
  - saw: Kalshi prices changed on 43% of seconds
- ✅ **Data coverage**
  - expected: 80%+ of seconds recorded, 5 or fewer gaps
  - saw: 92% of seconds recorded, 0 gap(s) over 30s
- ⚠️ **Fills were real**
  - expected: the buy price still there 1-2s later on 85%+ of buys
  - saw: 3 buys checked so far
  - look at: bot/v32.mjs entries: buying moves that are already gone; add a delay or a resting order
- ⚠️ **Believable win rate**
  - expected: under 80% (real edges here are small)
  - saw: 10 trades so far
- ⚠️ **Both halves profitable**
  - expected: profit in both the first and second half of trades
  - saw: needs 30+ trades (10 so far)
  - look at: trades by rule in RESULTS.md: which rule loses in which half
- ⚠️ **Enough trades**
  - expected: 100+ trades
  - saw: 10 of 100


## NOT PROVEN — 10/100 paper trades

**Paper balance:** $18.37 (started $30) · **P&L:** $-11.63 · **1/10 won (10%)** · break-even 38.1%

| Rule | Trades | Won | P&L |
|---|---|---|---|
| Dip buys | 3 | 1 | $-1.61 |
| Bounce rule | 7 | 0 | $-10.02 |

**Wins by hour (Chicago time)**: which hours the rules actually work in (needs lots of trades to mean anything)

| Hour | Trades | Won | P&L |
|---|---|---|---|
| 12 am | 2 | 0 | $-2.83 |
| 1 am | 2 | 0 | $-3.05 |
| 2 am | 1 | 0 | $-1.75 |
| 3 pm | 1 | 1 | $0.27 |
| 4 pm | 1 | 0 | $-1.78 |
| 5 pm | 1 | 0 | $-0.31 |
| 6 pm | 2 | 0 | $-2.18 |

**Brakes:** stop for the day after losing 10%; sit out 30 min after 3 losses in a row. **Now:** daily stop: down 10% today, done until tomorrow

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
| 11-28 08:13 | Bounce rule | Up | 30¢ → 1¢ | loser exit | $-1.75 |
| 11-28 07:28 | Bounce rule | Down | 30¢ → 17¢ | loser exit | $-0.84 |
| 11-28 06:11 | Dip buys | Down | 72¢ → 54¢ | cut (stop) | $-0.43 |
| 11-27 07:58 | Bounce rule | Down | 21¢ → 1¢ | loser exit | $-2.21 |
| 11-27 06:30 | Bounce rule | Up | 30¢ → 0¢ | settled | $-2.4 |
| 11-27 00:58 | Dip buys | Up | 47¢ → 21¢ | cut (stop) | $-1.45 |
| 11-27 00:13 | Bounce rule | Up | 28¢ → 22¢ | loser exit | $-0.73 |
| 11-26 23:28 | Bounce rule | Down | 30¢ → 28¢ | loser exit | $-0.31 |
| 11-26 22:28 | Bounce rule | Down | 30¢ → 13¢ | loser exit | $-1.78 |
| 11-26 21:50 | Dip buys | Up | 63¢ → 73¢ | profit (rode to 78c, came off the top) | $0.27 |

**Patterns the finder has proven:** none yet · days of data recorded: 3
