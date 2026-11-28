# Kalshi BTC 15-minute bot, v48

**Paper mode by default.** It places no real orders until you change two settings yourself (see "Real money").

## What changed from v47

| | v47.1 (browser page + Mac bot) | v48 |
|---|---|---|
| Where decisions happen | in a browser tab, sent to the Mac bot | inside the bot (Node). The dashboard only displays |
| Kalshi prices | polled through a relay about once a second | Kalshi WebSocket with your key (REST poll every 0.3 s without a key) |
| BTC price | mostly one exchange, fixed $2.50 correction | 5 exchanges streamed live, outliers dropped, and the gap to the real settlement index (BRTI) **measured** from Kalshi's own strike and settlement values |
| Balance | fetched before each order | cached, refreshed every 30 s, never on the order path |
| Combining signals | hand-set nudges, learner that re-tests on data it learned from | starts from Kalshi's price; a signal is added only after it beats Kalshi on windows it has **not** seen (walk-forward), with a strict bar (t ≥ 2.6, 150+ windows) |
| Fees | rough estimate, box trades had no check | Kalshi's exact formula on **every** buy, box trades too: buys only when chance − price − fee − 1¢ ≥ 3¢ |
| Bet size | up to 25 % of balance | quarter Kelly, never more than 3 % |
| Exits | fixed stops/targets | sell when the bid (after fee) is worth more than holding; optional stop-loss (off: it lost money in testing) |
| Logs | scorecard in the page | one line per second + every decision/order/fill/fee in `logs/YYYY-MM-DD/*.jsonl` |
| Paper results | optimistic | waits the real measured order delay, fills against the real Kalshi book, charges real fees |

Kept from v47: STOP file, $15 floor, no buys in the last minute, max 2 buys per window, max 1¢ slippage, ntfy phone alerts,
daily loss limit (10 %). The v32/v47.5 takeoff and dip setups are still available (`"entrySource": "v32"`), but each buy
still has to pass the after-fee check.

## Start (Mac)

1. Install Node 18 or newer (nodejs.org).
2. In Terminal: `cd mac-bot-v48` then `node bot.mjs check` (connects for 15 s, prints what it sees, places nothing).
3. `node bot.mjs` then open http://localhost:8787 .
4. Phone alerts: install the ntfy app and subscribe to the topic printed at start.

Your key: put `kalshi-key.pem` in this folder and your key ID in `config.json` (`keyId`). Both are ignored by git:
never commit them. Without a key the bot still runs in paper mode on public data.

## Real money

Only when the dashboard says the brain is **trusted** (it shows how far it is). Then in `config.json`:
`"mode": "real"` and `"confirmRealMoney": "I understand this uses real money"`. Anything else stays in paper mode.
In real mode the bot does not trade at all until the brain is trusted (unless you set `allowUntrustedReal`, which you shouldn't).

## What the tests on your own data showed (honest)

`node tools/backtest-repo.mjs` replays the 133,963 ticks in `bot/live` (162 windows with official results, 26-28 Nov 2026),
fills one tick late, charges Kalshi's fees, $100 start:

- No signal beat Kalshi's own price on unseen windows. None got accepted, so real money would not trade.
- Every brain strategy lost money after fees (best: edge exit, −$15.35 on 133 trades; the 15¢ stop made things worse).
- The repo's v32 rules: 30 trades, −$5.05. With the after-fee check only 4 trades passed.
- Our Coinbase-only price ran **$4.70 below** the real settlement index on average (sd $4.01): v48 now measures and corrects this live.

162 windows (about 1.7 days) is a small sample. These numbers say "no edge shown yet", not "never". Let it run in paper mode;
it re-scores itself every window and only unlocks real money if a signal clears the bar.

## Files

`bot.mjs` start · `src/app.mjs` wiring · `src/engine.mjs` decisions + limits · `src/brain.mjs` walk-forward combiner ·
`src/fair.mjs` BRTI fair value + measured gap · `src/index.mjs` exchange streams · `src/kalshi.mjs` Kalshi API/WebSocket ·
`src/broker.mjs` paper + real orders · `src/fees.mjs` · `src/sizing.mjs` · `src/logger.mjs` · `public/index.html` dashboard ·
`cloudflare/` run the same bot on Cloudflare (see `cloudflare/README.md`) · `test/` unit tests (`npm test`) ·
`tools/backtest-repo.mjs` backtest on the repo's logged ticks.
