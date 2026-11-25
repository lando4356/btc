# BTC 15-minute paper bot

**Paper only.** It never logs in to Kalshi and cannot spend real money. Its job is to
find out whether one rule actually wins before any real money goes near it.

## The rule (from Landan's manual trades)

- **Down on a bounce:** BTC has fallen $80+ over the last 30 minutes, then bounces up
  $25+ off its 3-minute low. That bounce makes Down cheap. If Down is 30¢ or less, the bot
  rests a limit bid for Down just under the ask.
- **Up on a dip:** the mirror image, in a 30-minute climb.
- Only between 12 and 3 minutes left in the window, one trade per window.

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
