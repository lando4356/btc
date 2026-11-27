# 📄 Paper bot results (fake money)

_Updated Fri, 27 Nov 2026 14:39:51 GMT_

## 🔍 Evidence checks: NOT PROVEN yet

- ✅ **Live prices**
  - expected: prices change on 8%+ of seconds
  - saw: Kalshi prices changed on 46% of seconds
- ✅ **Data coverage**
  - expected: 80%+ of seconds recorded, 5 or fewer gaps
  - saw: 94% of seconds recorded, 0 gap(s) over 30s
- ⚠️ **Fills were real**
  - expected: the buy price still there 1-2s later on 85%+ of buys
  - saw: 2 buys checked so far
  - look at: bot/v32.mjs entries: buying moves that are already gone; add a delay or a resting order
- ⚠️ **Believable win rate**
  - expected: under 80% (real edges here are small)
  - saw: 7 trades so far
- ⚠️ **Both halves profitable**
  - expected: profit in both the first and second half of trades
  - saw: needs 30+ trades (7 so far)
  - look at: trades by rule in RESULTS.md: which rule loses in which half
- ⚠️ **Enough trades**
  - expected: 100+ trades
  - saw: 7 of 100


## NOT PROVEN — 7/100 paper trades

**Paper balance:** $21.39 (started $30) · **P&L:** $-8.61 · **1/7 won (14.3%)** · break-even 35.6%

| Rule | Trades | Won | P&L |
|---|---|---|---|
| Dip buys | 2 | 1 | $-1.18 |
| Bounce rule | 5 | 0 | $-7.43 |

**Wins by hour (Chicago time)**: which hours the rules actually work in (needs lots of trades to mean anything)

| Hour | Trades | Won | P&L |
|---|---|---|---|
| 12 am | 1 | 0 | $-2.40 |
| 1 am | 1 | 0 | $-2.21 |
| 3 pm | 1 | 1 | $0.27 |
| 4 pm | 1 | 0 | $-1.78 |
| 5 pm | 1 | 0 | $-0.31 |
| 6 pm | 2 | 0 | $-2.18 |

**Brakes:** stop for the day after losing 10%; sit out 30 min after 3 losses in a row. **Now:** daily stop: down 10% today, done until tomorrow

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
| 11-27 07:58 | Bounce rule | Down | 21¢ → 1¢ | loser exit | $-2.21 |
| 11-27 06:30 | Bounce rule | Up | 30¢ → 0¢ | settled | $-2.4 |
| 11-27 00:58 | Dip buys | Up | 47¢ → 21¢ | cut (stop) | $-1.45 |
| 11-27 00:13 | Bounce rule | Up | 28¢ → 22¢ | loser exit | $-0.73 |
| 11-26 23:28 | Bounce rule | Down | 30¢ → 28¢ | loser exit | $-0.31 |
| 11-26 22:28 | Bounce rule | Down | 30¢ → 13¢ | loser exit | $-1.78 |
| 11-26 21:50 | Dip buys | Up | 63¢ → 73¢ | profit (rode to 78c, came off the top) | $0.27 |

**Patterns the finder has proven:** none yet · days of data recorded: 2
