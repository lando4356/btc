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

## Next
1. Run the paper bot on live order-book prices; let evidence checks grade it.
2. If takeoff/dip still win over 100+ trades: add settlement-price (CF Benchmarks) reconstruction.
3. Then the real-money bot (v47.2 on the Mac) with real money OFF for a week.

## Never
- Put keys or `config.json` in the repo.
- Go live because paper "looks great": run the checks first.
