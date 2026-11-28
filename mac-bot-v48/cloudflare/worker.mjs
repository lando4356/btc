// Kalshi BTC bot v48 on Cloudflare: one Durable Object runs the SAME engine as the Mac bot (src/app.mjs).
//  - fetch:  GET /  dashboard (static asset)   GET /api/state   POST /api/stop   POST /api/resume   GET /api/explain (optional)
//  - cron:   every minute, pokes the Durable Object so it (re)starts its streams after a deploy/eviction/restart.
// Secrets (wrangler secret put ...): KALSHI_KEY_ID, KALSHI_PRIVATE_KEY, NTFY_TOPIC, DASHBOARD_TOKEN. Never in the repo.
// Vars (wrangler.jsonc): MODE ("paper" default), CONFIRM_REAL_MONEY.
import { DurableObject } from "cloudflare:workers";
import example from "../config.example.json";
import { buildConfig } from "../src/config.mjs";
import { managedSocketCF } from "../src/ws-cf.mjs";
import { cfSigner, cfPlatform, cfLogger, cfNotifier } from "../src/platform-cf.mjs";
import { createBot } from "../src/app.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export class KalshiBot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.platform = cfPlatform(ctx, env);
    this.logger = cfLogger(ctx, env);
    this.bot = null; this.starting = null; this.startedAt = 0; this.lastError = null;
  }
  async ensureStarted() {
    if (this.bot) return;
    if (!this.starting) this.starting = (async () => {
      const env = this.env;
      // Cloudflare only gets a few feeds by default: each outbound socket is a connection (6 at a time per invocation)
      // and CPU is metered. Coinbase + Bitstamp + Gemini (+ OKX perp for the lead signal) = 3-exchange BRTI approximation. Kraken is unreachable from Cloudflare (HTTP 526/400) and Crypto.com is left off to stay at 5 sockets (Kalshi + 4), so REST calls are never starved by the 6-connection limit.
      const user = { mode: env.MODE || "paper", confirmRealMoney: env.CONFIRM_REAL_MONEY || "", notify: !!env.NTFY_TOPIC,
        feeds: { coinbase: true, kraken: false, bitstamp: true, gemini: true, cryptocom: false, okxPerp: true }, ...(this.platform.get("configOverride") || {}) };
      const cfg = buildConfig(example, user, (m) => this.logger.write("events", { event: "CONFIG_WARNING", msg: m }));
      const signer = await cfSigner(env);
      const bot = createBot({ cfg, platform: this.platform, signer, socket: managedSocketCF, logger: this.logger, notifier: cfNotifier(env, cfg) });
      await bot.start({ log: (m) => this.logger.write("events", { event: "START", msg: m }) });
      this.bot = bot; this.startedAt = Date.now();
    })().catch((e) => { this.lastError = e.message; this.logger.write("events", { event: "START_FAILED", error: e.message }); }).finally(() => { this.starting = null; });
    await this.starting;
  }
  async fetch(req) {
    const u = new URL(req.url);
    await this.ensureStarted();
    if (u.pathname === "/wake") { this.logger.prune(); await this.logger.flush(); return json({ ok: !!this.bot, startedAt: this.startedAt, error: this.lastError }); }
    if (!this.bot) return json({ error: "not started", detail: this.lastError }, 503);
    if (u.pathname === "/api/state") return json(this.bot.getState());
    if (u.pathname === "/api/stop" && req.method === "POST") { this.platform.setStop(true); return json({ ok: true }); }
    if (u.pathname === "/api/resume" && req.method === "POST") { this.platform.setStop(false); return json({ ok: true }); }
    if (u.pathname === "/api/explain") return json(await explain(this.env, this.bot.getState()));
    return json({ error: "not found" }, 404);
  }
}

// Optional plain-English explanation of what the bot is doing, using the free Workers AI allowance.
// It is NEVER used for trading decisions: it only rewords numbers the engine already computed. About 15 neurons a call
// (10,000 free per day), and only when you press the button on the dashboard.
async function explain(env, s) {
  if (!env.AI) return { text: null, why: "Workers AI binding not configured" };
  const facts = { mode: s.mode, market: s.market?.ticker, secondsLeft: s.left, btc: s.price, strike: s.market?.strike, kalshiChanceUp: s.pK, ourFairValue: s.p0, used: s.p, usedFrom: s.pSource,
    afterFeeEdgeCents: s.edges, lastDecision: s.why || s.lastDecision?.why, position: s.position, balance: s.balance, results: { trades: s.stats?.trades, pnl: s.stats?.totalPnl, fees: s.stats?.fees, ci95: s.stats?.ci95 },
    brain: { windows: s.brain?.windows, accepted: s.brain?.accepted, trusted: s.brain?.trusted } };
  const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", { max_tokens: 220, messages: [
    { role: "system", content: "You explain a trading bot's current status to a non-technical owner in 3-5 short sentences. Use only the numbers given. Do not predict prices or give advice." },
    { role: "user", content: JSON.stringify(facts) } ] });
  return { text: r.response, model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast" };
}

const botStub = (env) => env.BOT.get(env.BOT.idFromName("main"), { locationHint: "enam" }); // Kalshi's API is in the eastern US

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) {
      // the dashboard is read-only for anyone with the link; the buttons that change things need the token
      if (req.method !== "GET" || u.pathname === "/api/explain") {
        const tok = req.headers.get("Authorization")?.replace(/^Bearer /, "") || u.searchParams.get("token");
        if (!env.DASHBOARD_TOKEN || tok !== env.DASHBOARD_TOKEN) return json({ error: "token required" }, 401);
      }
      return botStub(env).fetch(req);
    }
    return env.ASSETS.fetch(req); // public/index.html
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(botStub(env).fetch("https://bot/wake")); },
};
