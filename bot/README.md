# BTC 15-minute paper bot

**Paper only.** It never logs in to Kalshi and cannot spend real money. Its job is to
find out whether one rule actually wins before any real money goes near it.

## Main rules: radar v32 takeoffs + dip buys (bot/v32.mjs)

The page that was winning (`radar-v32/`, Nov 20-22 paper: takeoffs 9/9 +159¢, dip buys 10/13 +111¢),
ported with the same numbers and the **early-sell exits** it used then:

- **🚀 Takeoff:** BTC moves 2+ "normal 10-second moves" one way, is still going over the last 3s,
  trade flow agrees (20%+ buy or sell pressure), and Kalshi's price is 5¢+ behind the model. Buys at the ask.
  Sells when the contract comes 4¢ off its top, when BTC stalls (if in profit), at 95¢+, at the stop, or after 90s.
- **Dip buy:** one side's price just dropped 6¢+ in ~20s, BTC is already turning back its way, and
  the model says it's worth 5¢+ more than the ask. Target +6¢ (plus fees), stop -6¢ (held if the model
  still gives it 55%+), sells after 2 minutes.
- Setups must hold for 2 seconds; several trades per window are allowed, like the page.
- Differences from the page: one BTC feed (Coinbase) instead of four, and a simpler model (no settle
  average, futures or options flow). The tuning "scalp lab" isn't ported; the page's 6/6/6 defaults are used.

**Tested on fake data:** on fairly priced data it made 3 trades in 200 hours (no edge to find, so it
mostly stays out). With a hidden mispricing it bought the dips and took profits early: 267 of 344 won.

## Also: the bounce rule (from Landan's manual trades)

- **Down on a bounce:** BTC has fallen $80+ over the last 30 minutes, then bounces up
  $25+ off its 3-minute low. That bounce makes Down cheap. If Down is 30¢ or less, the bot
  rests a limit bid for Down just under the ask.
- **Up on a dip:** the mirror image, in a 30-minute climb.
- Only between 12 and 3 minutes left in the window, one trade per window.

## It finds its own patterns too (finder.mjs)

Every 6 hours the bot searches everything it has recorded for patterns: about 2,000
combinations of time left, BTC vs strike, 30-minute move, 3-minute move and contract price,
for Up and Down. It can't fool itself, because:

1. It searches only the **older 70%** of the data.
2. The 25 best-looking patterns are tested **once** on the **newest 30%**, which it never searched.
3. Only patterns that still win there, **after Kalshi's fee**, over 30+ trades, get traded (on paper).
4. A learned pattern that is losing after 30 live paper trades is **dropped automatically** (🚫 on the page).

Run it by hand any time: `node bot/finder.mjs`. It prints each pattern as ✅ KEEP or ❌ luck.
It needs real data first: expect nothing useful until ~1,000 windows (about 10 days of running).

**Tested on fake data:** on fairly priced data it promoted 0 of 2,074 patterns. With a hidden
10¢ edge planted in, it found it (24 patterns, all variations of that edge). On brand-new fake
data the learned patterns made money where the edge still existed, and where it didn't,
they lost a little and 11 of them were dropped automatically.

## Why it's built this way

- **Resting limit orders:** Kalshi charges no fee on these (maker orders) for KXBTC15M.
  Studies of thousands of windows found the taker fee is bigger than the edge from
  buying at the ask, so the old bot's instant orders paid a fee on every trade.
- **Strict paper fills:** a paper bid only counts as filled once the ask trades *below* it,
  so paper results don't look better than real life.
- **Small fixed bets:** $3 or 10% of the bankroll, whichever is smaller. No all-in.
- **Exits:** once the contract hits 85¢ it sells if it drops 10¢ from its high. With 2
  minutes left, a losing position is sold instead of riding to $0. Otherwise it holds to the end.
- **Verdict:** says NOT PROVEN until 100 paper trades, then EDGE SHOWING or NO EDGE.

## Run it (on the Mac)

```
cd ~/Downloads && git clone https://github.com/lando4356/btc && cd btc
node bot/bot.mjs
```
Open **http://localhost:8787**. Leave it running. Needs Node 18+ (you already have it).

To update later: `cd ~/Downloads/btc && git pull`, then Ctrl+C and start it again.

## Test it

```
node bot/backtest.mjs            # replay everything the bot recorded
node bot/backtest.mjs --sweep    # try settings; judge them on the second half only
```
The bot records every tick to `bot/data/ticks-*.csv`, so each hour it runs gives the
backtester more real data. `bot/test/fake-data.mjs` makes fairly-priced fake data: on it the
rule should lose a little (no edge exists in fake data). It does, so the math isn't flattering itself.

Settings are at the top of `bot/strategy.mjs`.
