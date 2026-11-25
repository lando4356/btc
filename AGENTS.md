# AGENTS.md: start here (for any Claude chat or AI working on this repo)

Owner: lando4356. Project: BTC vs Kalshi 15-minute markets (KXBTC15M). Owner works mostly from an iPhone.
Read `PROGRESS.md` before changing anything: it lists what was tried and must not be repeated.

## Map

| What | Where |
|---|---|
| Paper bot (runs on GitHub every 6h) | `bot/bot.mjs` |
| Trading rules: v32 takeoff + dip | `bot/v32.mjs` |
| Other rules, paper broker, scoreboard | `bot/strategy.mjs` |
| Evidence checks (the loop) | `bot/checks.mjs` |
| Pattern finder (older data in, held-back test) | `bot/finder.mjs`, `bot/features.mjs` |
| Backtester | `bot/backtest.mjs` |
| Results page (written every run) | `bot/RESULTS.md` |
| Live run data | `bot/live/` |
| Old/invalid runs and why | `bot/archive/` |
| The radar page that "was winning" | `radar-v32/` |
| Brain backup from Nov 22 + analysis | `backups/` |
| GitHub Action | `.github/workflows/paper-bot.yml` |

## Done when (what "green" means)

A strategy is only considered working when ALL of these hold on the paper bot:
1. `bot/checks.mjs` shows no ❌ (live prices, fills real, data coverage).
2. 100+ paper trades.
3. Profitable after Kalshi fees in BOTH halves of the trades.
4. Then: a week of the real-money bot with real money OFF, matching the paper results.
Anything less is "not proven", however good it looks.

## Walls (not wishes)

- **No real money from GitHub.** The paper bot has no Kalshi login code; keep it that way.
- **No secrets in the repo, ever:** `config.json`, `*.pem`, `.env`, private keys, API keys (`.gitignore` blocks them).
- **Never trust Kalshi's market-list prices** for trading decisions. Use `/markets/{ticker}/orderbook` (or WebSocket).
- Changes go through a pull request; the owner merges from his phone.
- Real-money changes are the owner's call, after the "done when" list is met.
