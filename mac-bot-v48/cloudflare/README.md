# Running v48 on Cloudflare

The same engine (`src/app.mjs`) runs inside one **Durable Object**. Only the platform parts differ:
key from Cloudflare secrets (WebCrypto signing), sockets via `fetch()` upgrade, state + logs in the Durable Object's
SQLite storage, a Cron Trigger as watchdog. This folder has its **own** `wrangler.jsonc`; the repo-root one (radar page,
auto-deployed on merge) is untouched.

## Deploy (deployed 28 Nov 2026 in paper mode: https://kalshi-bot-v48.landomando-2020.workers.dev)

```
cd mac-bot-v48/cloudflare
npx wrangler secret put KALSHI_KEY_ID
openssl pkcs8 -topk8 -nocrypt -in ~/path/kalshi-key.pem -out /tmp/k8.pem   # Kalshi gives PKCS#1; Workers need PKCS#8
npx wrangler secret put KALSHI_PRIVATE_KEY < /tmp/k8.pem && rm /tmp/k8.pem
npx wrangler secret put DASHBOARD_TOKEN      # any long random text; needed for STOP/Resume/Explain
npx wrangler secret put NTFY_TOPIC           # optional
npx wrangler deploy
```
Paper mode unless you set `MODE` = `real` **and** `CONFIRM_REAL_MONEY` = `I understand this uses real money`.
STOP: dashboard button (token) — blocks new buys, kept in Durable Object storage.

## What it uses from Cloudflare, and the free-tier limits that matter (checked 28 Nov 2026)

| Used | Why | Free-tier limit | Bot's use |
|---|---|---|---|
| Durable Object (SQLite) | holds the live streams + the engine in memory; storage for state, samples, windows, events | 100,000 requests/day; 13,000 GB-s/day duration; 5M rows read & 100,000 rows written/day; 5 GB | always-on = 86,400 s × 128 MB = 10,800 GB-s/day (83 % of free); ~3,000-5,000 rows/day |
| Cron Trigger (every minute) | restarts streams after deploys/evictions; replaces the GitHub Actions schedule | 5 cron triggers per account | 1,440 wake-ups/day |
| Static assets | dashboard page | free, unlimited | — |
| R2 (optional) | per-second ticks in 10-minute files | 10 GB, 1M writes/month | ~4,300 writes/month, ~250 MB/month |
| Workers AI (optional) | **Explain** button: rewords the dashboard numbers in plain English | 10,000 neurons/day | ~15 neurons per press. Never used to decide trades |

Skipped: **D1** (the Durable Object's built-in SQLite does the same job, next to the code), **KV** (1,000 writes/day,
eventually consistent: wrong for state), **Queues** (nothing to hand off), **Vectorize** (paid plan only, no use),
**Analytics Engine** (nice charts, but a second store for the same data), **Workers AI in decisions** (an LLM has no
tested edge on 15-minute BTC direction; it would only add latency and noise).

## Things to know

- **Outbound WebSockets keep the Durable Object awake** (hibernation only works for sockets it *accepts*), so it is
  billed for duration the whole time. Each open connection keeps it alive up to 15 minutes; the bot's own timers and
  the 1-minute cron keep it going. One bot fits inside the free duration allowance, with little room for a second.
- **CPU**: the Workers Free plan allows 10 ms of CPU per invocation. A brain refit measured 48-56 ms at 162 windows and
  grows with history (up to ~1,500 windows). Expect to need **Workers Paid ($5/month)** for the brain to keep learning;
  there you can also raise `limits.cpu_ms`.
- Placement: the object is created with `locationHint: "enam"` (eastern North America, near Kalshi's API).
- Kalshi 403s: you've confirmed authenticated calls from your Cloudflare account work. Public, unauthenticated calls
  from Cloudflare have been refused before; with a key the bot uses the Kalshi WebSocket for the book.
- Timing inside Workers is coarse (clocks only move on I/O), so the dashboard's microsecond decision timings read 0 there.
- Tested locally with `wrangler dev` (Cloudflare's runtime on this computer, not deployed): 4 exchange streams + Kalshi
  connected, decisions running, cron wake-up OK, STOP refused without the token.

## Findings from the first real deploy (28 Nov 2026)

- **Kraken cannot be reached from Cloudflare** (HTTP 526/400: both sit behind Cloudflare), so it is off here. Feeds on Cloudflare:
  Coinbase + Bitstamp + Gemini for the price index, OKX perp for the lead signal, plus Kalshi = 5 sockets. A 6th socket would
  leave no free connection for REST calls (Workers allow 6 open outbound connections at once).
- **Coinbase refuses the real-time `ticker` channel on shared cloud IPs** ("subscription limit reached"). The bot now falls back to
  `ticker_batch` (same fields, one update per second) automatically.
- Workers AI (`env.AI`) is bound for the dashboard's Explain button only. Verified working on the free allowance; it never feeds a trade decision.
- The Durable Object restarts onto new code about a minute after `wrangler deploy`.
