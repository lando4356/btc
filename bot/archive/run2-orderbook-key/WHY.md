# Why run 2 is archived (Nov 25-26, 2026)

The bot asked Kalshi for the live order book but read the reply's old key (`orderbook`).
Kalshi now answers with `orderbook_fp`, so every tick fell back to the market LIST prices,
which refresh only about every 28 seconds. Run log: "quotes list (changed on 4% of seconds)".

Result on those stale prices: 55 trades, $30 → $51.35 (takeoffs 17/17, dips 19/28, bounce 0/10).
Evidence checks: Live prices ❌ twice in a row (ESCALATE), Data coverage ❌ (39%: GitHub's cron
ran the bot only about twice a day). Same trap as run 1, so these numbers don't count.

Fix: `bot/book.mjs` reads both keys (test: `node bot/test/book.test.mjs`), and each Actions run
now starts the next one when it finishes.
