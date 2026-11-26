# 📄 Paper bot results (fake money)

_Updated Thu, 26 Nov 2026 13:47:19 GMT_

## 🛑 ESCALATE: same failure two runs in a row

Failed again: **Live prices**. Don't keep tweaking strategy settings, fix the layer that owns it (data, fills or code) and log the lesson in PROGRESS.md. The owner decides what happens next.

## 🔍 Evidence checks: DON'T TRUST these results

- ❌ **Live prices**
  - expected: prices change on 8%+ of seconds
  - saw: Kalshi prices changed on only 3.8% of seconds — they look stale, so trades can't be trusted
  - look at: bot/bot.mjs currentMarket(): is it reading /orderbook? (list prices refresh ~every 28s)
- ❌ **Data coverage**
  - expected: 80%+ of seconds recorded, 5 or fewer gaps
  - saw: 39% of seconds recorded, 1 gap(s) over 30s
  - look at: the run log for data errors; Kalshi/Coinbase blocking or rate limits
- ✅ **Fills were real**
  - expected: the buy price still there 1-2s later on 85%+ of buys
  - saw: 43 of 45 buys: the price was still there 1-2s later (2 were gone)
- ✅ **Believable win rate**
  - expected: under 80% (real edges here are small)
  - saw: 65% won over 55 trades
- ✅ **Both halves profitable**
  - expected: profit in both the first and second half of trades
  - saw: first half $8.89, second half $12.46
- ⚠️ **Enough trades**
  - expected: 100+ trades
  - saw: 55 of 100


## NOT PROVEN — 55/100 paper trades

**Paper balance:** $51.35 (started $30) · **P&L:** $21.35 · **36/55 won (65.5%)** · break-even 49%

| Rule | Trades | Won | P&L |
|---|---|---|---|
| 🚀 Takeoffs | 17 | 17 | $16.92 |
| Dip buys | 28 | 19 | $24.74 |
| Bounce rule | 10 | 0 | $-20.31 |

**Wins by hour (Chicago time)**: which hours the rules actually work in (needs lots of trades to mean anything)

| Hour | Trades | Won | P&L |
|---|---|---|---|
| 4 am | 6 | 4 | $1.05 |
| 5 am | 5 | 4 | $2.26 |
| 6 am | 9 | 7 | $7.08 |
| 7 am | 1 | 0 | $-0.38 |
| 11 am | 5 | 3 | $-1.80 |
| 12 pm | 5 | 4 | $2.08 |
| 1 pm | 7 | 5 | $6.90 |
| 2 pm | 8 | 4 | $4.09 |
| 3 pm | 8 | 5 | $0.19 |
| 4 pm | 1 | 0 | $-0.12 |

**Brakes:** stop for the day after losing 10%; sit out 30 min after 3 losses in a row.

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
| 11-26 13:03 | Dip buys | Down | 60¢ → 56¢ | stale (2 min) | $-0.38 |
| 11-26 12:58 | Bounce rule | Up | 30¢ → 13¢ | loser exit | $-1.78 |
| 11-26 12:45 | Bounce rule | Down | 30¢ → 0¢ | settled | $-3 |
| 11-26 12:35 | 🚀 Takeoffs | Up | 46¢ → 66¢ | profit (BTC turned hard, sold before the drop) | $0.99 |
| 11-26 12:28 | Dip buys | Down | 57¢ → 96¢ | profit (nothing left to squeeze) | $1.84 |
| 11-26 12:27 | Dip buys | Down | 49¢ → 70¢ | profit (model says it will drop back) | $1.06 |
| 11-26 12:23 | Dip buys | Down | 25¢ → 63¢ | profit (BTC turned hard, sold before the drop) | $4.2 |
| 11-26 12:20 | 🚀 Takeoffs | Up | 58¢ → 75¢ | profit (BTC turned hard, sold before the drop) | $0.69 |
| 11-26 12:13 | 🚀 Takeoffs | Down | 70¢ → 95¢ | profit (nothing left to squeeze) | $0.92 |
| 11-26 12:01 | 🚀 Takeoffs | Up | 38¢ → 72¢ | profit (BTC turned hard, sold before the drop) | $2.16 |
| 11-26 11:55 | Dip buys | Down | 65¢ → 74¢ | profit (rode to 79c, came off the top) | $0.23 |
| 11-26 11:54 | Dip buys | Up | 20¢ → 35¢ | profit (model says it will drop back) | $1.84 |
| 11-26 11:38 | 🚀 Takeoffs | Up | 55¢ → 72¢ | profit (BTC turned hard, sold before the drop) | $0.68 |
| 11-26 11:18 | Dip buys | Down | 37¢ → 47¢ | profit (BTC turned hard, sold before the drop) | $0.52 |
| 11-26 11:12 | Dip buys | Down | 24¢ → 18¢ | cut (came off the top) | $-1.01 |

**Patterns the finder has proven:** none yet · days of data recorded: 2
