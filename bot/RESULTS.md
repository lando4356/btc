# 📄 Paper bot results (fake money)

_Updated Wed, 25 Nov 2026 22:21:21 GMT_

## 🔍 Evidence checks: DON'T TRUST these results

- ❌ **Live prices**
  - expected: prices change on 8%+ of seconds
  - saw: Kalshi prices changed on only 3.9% of seconds — they look stale, so trades can't be trusted
  - look at: bot/bot.mjs currentMarket(): is it reading /orderbook? (list prices refresh ~every 28s)
- ✅ **Data coverage**
  - expected: 80%+ of seconds recorded, 5 or fewer gaps
  - saw: 90% of seconds recorded, 0 gap(s) over 30s
- ✅ **Fills were real**
  - expected: the buy price still there 1-2s later on 85%+ of buys
  - saw: 25 of 26 buys: the price was still there 1-2s later (1 were gone)
- ✅ **Believable win rate**
  - expected: under 80% (real edges here are small)
  - saw: 62% won over 34 trades
- ✅ **Both halves profitable**
  - expected: profit in both the first and second half of trades
  - saw: first half $7.18, second half $4.16
- ⚠️ **Enough trades**
  - expected: 100+ trades
  - saw: 34 of 100


## NOT PROVEN — 34/100 paper trades

**Paper balance:** $41.34 (started $30) · **P&L:** $11.34 · **21/34 won (61.8%)** · break-even 48.8%

| Rule | Trades | Won | P&L |
|---|---|---|---|
| 🚀 Takeoffs | 10 | 10 | $10.84 |
| Dip buys | 16 | 11 | $16.03 |
| Bounce rule | 8 | 0 | $-15.53 |

**Last 15 trades**

| Closed (UTC) | Rule | Side | Buy → Sell | Why | P&L |
|---|---|---|---|---|---|
| 11-25 22:03 | Dip buys | Down | 69¢ → 69¢ | stale (2 min) | $-0.12 |
| 11-25 21:59 | Dip buys | Down | 66¢ → 99¢ | profit (target) | $1.24 |
| 11-25 21:51 | Dip buys | Down | 57¢ → 65¢ | profit (2 min) | $0.23 |
| 11-25 21:44 | 🚀 Takeoffs | Down | 61¢ → 100¢ | profit (nothing left to squeeze) | $1.49 |
| 11-25 21:43 | Bounce rule | Up | 28¢ → 6¢ | loser exit | $-2.24 |
| 11-25 21:39 | Dip buys | Down | 52¢ → 71¢ | profit (target) | $0.78 |
| 11-25 21:14 | Dip buys | Down | 64¢ → 93¢ | profit (target) | $1.07 |
| 11-25 21:13 | Bounce rule | Up | 30¢ → 11¢ | loser exit | $-1.97 |
| 11-25 21:08 | Dip buys | Up | 73¢ → 66¢ | stale (2 min) | $-0.41 |
| 11-25 20:47 | Dip buys | Up | 48¢ → 72¢ | profit (target) | $1.24 |
| 11-25 20:45 | Dip buys | Down | 35¢ → 100¢ | settled | $5.07 |
| 11-25 20:41 | 🚀 Takeoffs | Down | 74¢ → 90¢ | profit (BTC stopped running) | $0.55 |
| 11-25 20:38 | Dip buys | Up | 53¢ → 45¢ | cut (stop) | $-0.58 |
| 11-25 20:33 | Dip buys | Down | 67¢ → 49¢ | cut (stop) | $-0.86 |
| 11-25 20:25 | Dip buys | Up | 45¢ → 39¢ | cut (stop) | $-0.57 |

**Patterns the finder has proven:** none yet · days of data recorded: 1
