// Wires the bot together. Shared by the Mac bot (bot.mjs) and the Cloudflare Durable Object (cloudflare/worker.mjs);
// only the platform pieces differ (key/signing, sockets, storage, logger, notifier).
import { createIndex } from "./index.mjs";
import { createKalshi } from "./kalshi.mjs";
import { PaperBroker, RealBroker } from "./broker.mjs";
import { createEngine } from "./engine.mjs";
import { round } from "./util.mjs";

export function createBot({ cfg, platform, signer, socket, logger, notifier }) {
  const evlog = (o) => logger.write("events", o);
  const index = createIndex({ enabled: cfg.feeds, log: evlog, minFeeds: 2, socket });
  const kalshi = createKalshi({ cfg, signer, socket, log: evlog });
  if (cfg.mode === "real" && !kalshi.hasKey) throw new Error("Real mode needs your Kalshi key.");
  const saved = platform.loadState();
  const savedPaper = saved?.mode === "paper" ? saved.paper : null;
  const broker = cfg.mode === "real" ? new RealBroker({ kalshi, log: evlog, feeOpts: {} }) : new PaperBroker({ kalshi, startBalance: cfg.paperStartBalance, delayMs: cfg.paperDelayMs, saved: savedPaper });
  const engine = createEngine({ cfg, platform, kalshi, index, broker, logger, notifier });
  kalshi.onBook = (ticker, recv) => { if (ticker === kalshi.state.market?.ticker) engine.trigger(recv); };
  index.onUpdate = () => engine.trigger(Date.now());
  index.onSecond = (sec) => { try { engine.onSecond(sec); } catch (e) { evlog({ event: "SECOND_ERROR", error: e.message, stack: e.stack?.split("\n").slice(0, 3).join(" | ") }); } };

  function getState() {
    const ctx = engine.st.lastCtx || {}, m = kalshi.state.market;
    return {
      version: 48, mode: cfg.mode, now: Date.now(), market: m, left: ctx.left, price: ctx.price, sigma: ctx.sigma, top: ctx.top, spread: ctx.spread, bookAgeMs: ctx.bookAgeMs,
      pK: ctx.pK, p0: ctx.p0, p: ctx.p, pSource: ctx.pSource, preds: ctx.preds, f: ctx.f, why: ctx.why,
      edges: ctx.ok && ctx.p != null ? { up: ctx.top.yesAsk != null ? round(engine.edgeAt(ctx.p, ctx.top.yesAsk), 2) : null, down: ctx.top.noAsk != null ? round(engine.edgeAt(1 - ctx.p, ctx.top.noAsk), 2) : null } : null,
      feeds: index.status(), kalshiFeed: { source: kalshi.state.bookSource, ws: kalshi.wsInfo(), lastBookMsgAgo: Date.now() - kalshi.state.lastBookMsg, restRtt: kalshi.state.restRtt, error: kalshi.state.lastError },
      gap: { mean: round(engine.gap.mean, 3), sd: round(engine.gap.sd, 3), n: engine.gap.e.n, recent: engine.gap.samples.slice(-8) },
      position: engine.st.position, stopped: engine.st.stopped, stopFile: engine.st.stopFile, lastDecision: engine.st.lastDecision,
      balance: round(broker.balance(), 2), paperStart: broker.kind === "paper" ? broker.start : null, stats: engine.stats(), latency: engine.latency(), brain: engine.brain.summary(),
      limits: cfg.limits, strategy: cfg.strategy, notifyTopic: notifier.topic, hasKey: kalshi.hasKey,
    };
  }

  const timers = [];
  async function start({ log = console.log } = {}) {
    log(`Kalshi BTC bot v48 · mode: ${cfg.mode === "real" ? "REAL MONEY" : "PAPER (no real orders)"} · Kalshi key: ${kalshi.hasKey ? "loaded" : "none (public data only)"}`);
    await kalshi.seriesInfo();
    log(`Series fee type: ${kalshi.state.seriesInfo?.feeType ?? "unknown"} (multiplier ${kalshi.state.seriesInfo?.feeMultiplier ?? "?"})`);
    await index.backfill();
    try { await kalshi.refreshMarket(); } catch (e) { log("Could not read Kalshi markets: " + e.message); }
    const m = kalshi.state.market; if (m) log(`Current market: ${m.ticker} · strike ${m.strike ?? "?"} · closes ${new Date(m.closeMs).toISOString()}`);
    if (kalshi.hasKey) {
      try { await kalshi.refreshBalance(); log(`Kalshi balance: $${kalshi.acct.balance.toFixed(2)}`); if (cfg.mode === "real" && m) await kalshi.fundShard(m.exchangeIndex); }
      catch (e) { log("Kalshi login failed: " + e.message); if (cfg.mode === "real") throw e; }
    }
    kalshi.startBookStream();
    engine.replayBrain();
    log(`Brain: ${engine.brain.windows()} settled windows in memory, accepted signals: ${[...engine.brain.accepted].join(", ") || "none yet"}, trusted: ${engine.brain.trusted()}`);
    timers.push(setInterval(() => kalshi.refreshMarket().catch((e) => { kalshi.state.lastError = e.message; }), 2000));
    if (cfg.mode === "real") {
      timers.push(setInterval(() => kalshi.refreshBalance().catch(() => {}), 30000)); // cached balance: never fetched on the order path
      timers.push(setInterval(() => { const mm = kalshi.state.market; if (mm) kalshi.fundShard(mm.exchangeIndex).catch(() => {}); }, 5 * 60000));
    }
    timers.push(setInterval(() => { const s = engine.stats(); notifier.notify("Bot is running", `${cfg.mode} · balance $${broker.balance().toFixed(2)} · ${s.trades} trades, ${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl} · brain ${engine.brain.trusted() ? "trusted" : "not proven"}`, 2, "robot"); }, 3600000));
  }
  function stop() { timers.forEach(clearInterval); index.stop(); kalshi.stop(); engine.save(); }
  return { index, kalshi, broker, engine, getState, start, stop, evlog };
}
