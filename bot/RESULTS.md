# 📄 Paper bot results (fake money)

_Updated Fri, 27 Nov 2026 03:09:15 GMT_

## 🔍 Evidence checks: NOT PROVEN yet

- ✅ **Live prices**
  - expected: prices change on 8%+ of seconds
  - saw: Kalshi prices changed on 45% of seconds
- ✅ **Data coverage**
  - expected: 80%+ of seconds recorded, 5 or fewer gaps
  - saw: 91% of seconds recorded, 0 gap(s) over 30s
- ⚠️ **Fills were real**
  - expected: the buy price still there 1-2s later on 85%+ of buys
  - saw: 2 buys checked so far
  - look at: bot/v32.mjs entries: buying moves that are already gone; add a delay or a resting order
- ⚠️ **Believable win rate**
  - expected: under 80% (real edges here are small)
  - saw: 5 trades so far
- ⚠️ **Both halves profitable**
  - expected: profit in both the first and second half of trades
  - saw: needs 30+ trades (5 so far)
  - look at: trades by rule in RESULTS.md: which rule loses in which half
- ⚠️ **Enough trades**
  - expected: 100+ trades
  - saw: 5 of 100


## NOT PROVEN — 5/100 paper trades

**Paper balance:** $26 (started $30) · **P&L:** $-4 · **1/5 won (20%)** · break-even 39.6%

| Rule | Trades | Won | P&L |
|---|---|---|---|
| Dip buys | 2 | 1 | $-1.18 |
| Bounce rule | 3 | 0 | $-2.82 |

**Wins by hour (Chicago time)**: which hours the rules actually work in (needs lots of trades to mean anything)

| Hour | Trades | Won | P&L |
|---|---|---|---|
| 3 pm | 1 | 1 | $0.27 |
| 4 pm | 1 | 0 | $-1.78 |
| 5 pm | 1 | 0 | $-0.31 |
| 6 pm | 2 | 0 | $-2.18 |

**Brakes:** stop for the day after losing 10%; sit out 30 min after 3 losses in a row. **Now:** daily stop: down 10% today, done until tomorrow

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
| 11-27 00:58 | Dip buys | Up | 47¢ → 21¢ | cut (stop) | $-1.45 |
| 11-27 00:13 | Bounce rule | Up | 28¢ → 22¢ | loser exit | $-0.73 |
| 11-26 23:28 | Bounce rule | Down | 30¢ → 28¢ | loser exit | $-0.31 |
| 11-26 22:28 | Bounce rule | Down | 30¢ → 13¢ | loser exit | $-1.78 |
| 11-26 21:50 | Dip buys | Up | 63¢ → 73¢ | profit (rode to 78c, came off the top) | $0.27 |

**Patterns the finder has proven:** none yet · days of data recorded: 2
