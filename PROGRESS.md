# PROGRESS.md: the project's memory (update it whenever something is learned)

## Goal
Find out honestly whether any strategy beats Kalshi's BTC 15-minute markets after fees, on paper first.

## Known (verified)
- Kalshi's market LIST endpoint only refreshes prices about every 28 s. Trading off it creates fake
  edges ("Kalshi is lagging"). The radar page v32 and paper run 1 both used it. (Nov 25)
- On those stale prices: takeoffs 16/16, dip buys 14/15 (run 1, archived). Not trustworthy.
- Nov 20-22 page backup: early sells beat holding (+88c vs +18c on 8 trades). Small sample, stale prices.
- Real money: $30 bankroll went to $0.12 (Nov 24): all-in sizing + losing holds.
- Outside evidence: real edges in these markets are tiny and get competed away
  (npcnpc09 real-money bot; Astanwa pair tape; mlysophia 23,462-market study).

## Dead ends (don't retry without new evidence)
- All-in / 50% bet sizes: one loss wipes the account.
- Hold every bet to 85c / to settlement: lost to early selling in the page's own data.
- Flip watch / flip gate: 74 of 186 alerts hit (40%); flips 4/8, -63c; gate blocked all trading.
- Resting bids at fixed prices: fill on reversals (pair tape: one-side fills won 8 of 421).
- The bounce rule: 1 of 7 on run 1.
- Most extra indicators (MACD, VWAP, etc.): no better than chance on the page's own scoreboard.
- Lottery tickets: no edge, pure long shots.
- "Bots that made $X" posts on X: none had verifiable results (ads, referral links, own-token promos).

## Failures → where the lesson was filed (fix the class, not the output)

| Failure | Layer | Lesson became |
|---|---|---|
| Fake 16-for-16 wins from stale list prices | Loop | "Live prices" check in `bot/checks.mjs` (run 1 must stay ❌) |
| Bot crashed at every 15-min window switch | Harness | rollover fallback in `bot/bot.mjs` + "Data coverage" check |
| Paper fills at prices that weren't really there | Loop | "Fills were real" check |
| All-in bets wiped the real account | Harness | stake cap (`stakeUsd`, `maxStakePct`) + dead-end line above |
| Retried hold-to-85 / flip gate after they lost | Harness | Dead ends list (this file) |
| Same failure run after run | Loop | 🛑 ESCALATE when one check fails two runs in a row |
| Radar paper account stopped trading for good (v47.1) | Harness | a losing rule was "benched" and a benched rule never traded again, so it could never recover. v47.3: benched only blocks real money; the card says why paper isn't trading |
| Run 2 still on stale list prices: Kalshi renamed the order-book reply key to `orderbook_fp`, the bot only read `orderbook` (Nov 26) | Harness | `bot/book.mjs` reads both + `bot/test/book.test.mjs` runs before every Actions run; run 2 archived |
| Only ~2 paper runs a day: GitHub cron late/skipped, 39% coverage (Nov 26) | Harness | each run starts the next one (`gh workflow run`), cron kept as backup |
| Keys could leak into the repo | Harness | `.gitignore` wall + no login code in the paper bot |

## Next
1. Run the paper bot on live order-book prices; let evidence checks grade it.
2. If takeoff/dip still win over 100+ trades: add settlement-price (CF Benchmarks) reconstruction.
3. Then the real-money bot (v47.2 on the Mac) with real money OFF for a week.

## Never
- Put keys or `config.json` in the repo.
- Go live because paper "looks great": run the checks first.

## Nov 27: practice bot on the Cloudflare site
- radar-v47/index.html is now the Mac radar page (fast quote chart, 11-exchange flow, overlay, chart-vs-Kalshi, big-move with 2.5s hold check, fast cash-out, last-minute penny bets).
- On the hosted site every /bot/* call is answered in the page by a fake-money copy of the Mac bot's rules ($20 start, $3 bets, 10-40c, sell 90c, +30% take profit, double-up exit, 60s wait, $1 penny bets, stop after 5 losses). Trades are saved in the phone's browser (localStorage). It only trades while the page is open.
- Not proven: it is for studying the Mac bot's choices, not evidence on its own (see "Done when").
