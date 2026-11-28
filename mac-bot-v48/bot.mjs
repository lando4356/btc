// Kalshi BTC 15-minute bot, v48 (Mac / any computer with Node 18+).
//   node bot.mjs                 start (PAPER mode unless config.json says otherwise, see README)
//   node bot.mjs check           connect to everything for ~15 s, print what it sees, place NO orders, exit
//   node bot.mjs --seconds 300   run for 5 minutes then exit with a latency summary (useful for testing)
// Options: --no-notify (no phone alerts), --logs <folder> (where JSONL logs go, default ./logs)
// The same engine also runs on Cloudflare: see cloudflare/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./src/logger.mjs";
import { createNotifier } from "./src/notify.mjs";
import { startServer } from "./src/server.mjs";
import { round } from "./src/util.mjs";
import { buildConfig } from "./src/config.mjs";
import { managedSocket } from "./src/ws.mjs";
import { nodeSigner, nodePlatform } from "./src/platform-node.mjs";
import { createBot } from "./src/app.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const flag = (k) => argv.includes(k);

// ---- config: created from the example on first run (paper mode) ----
const CFG_FILE = path.join(DIR, "config.json");
if (!fs.existsSync(CFG_FILE)) { fs.copyFileSync(path.join(DIR, "config.example.json"), CFG_FILE); console.log("Created config.json (PAPER mode). Edit it to add your key; see README."); }
const example = JSON.parse(fs.readFileSync(path.join(DIR, "config.example.json"), "utf8"));
const cfg = buildConfig(example, JSON.parse(fs.readFileSync(CFG_FILE, "utf8")));
if (flag("--no-notify")) cfg.notify = false;

const LOGS = opt("--logs") || path.join(DIR, "logs");
const logger = createLogger(LOGS);
const platform = nodePlatform(DIR, LOGS);
const notifier = createNotifier(DIR, cfg);
let bot;
try { bot = createBot({ cfg, platform, signer: nodeSigner(cfg, DIR, (o) => logger.write("events", o)), socket: managedSocket, logger, notifier }); }
catch (e) { console.error(e.message, "(keyId + privateKeyPath in config.json)"); process.exit(1); }
const { engine, broker, getState } = bot;

async function main() {
  console.log("");
  try { await bot.start(); } catch (e) { console.error(e.message); process.exit(1); }
  if (cmd === "check") {
    await new Promise((r) => setTimeout(r, 15000));
    const s = getState();
    console.log("\nBTC feeds:"); for (const [n, f] of Object.entries(s.feeds)) console.log(`  ${n.padEnd(10)} ${f.connected ? "connected" : "DOWN"}  mid ${f.mid ?? "-"}  age ${f.ageMs ?? "-"}ms  ${f.lastError ? "(" + f.lastError + ")" : ""}`);
    console.log(`BRTI approximation: ${round(s.price, 2)} · Kalshi book via ${s.kalshiFeed.source}: Up ${s.top?.yesBid}/${s.top?.yesAsk} Down ${s.top?.noBid}/${s.top?.noAsk}`);
    console.log(`Model ${round(s.p0, 3)} · Kalshi ${round(s.pK, 3)} · decision ${s.why || s.lastDecision?.why || "-"}`);
    console.log(`Latency: decide p50 ${s.latency.decideUsP50}µs · event→decision p50 ${s.latency.eventToDecisionMsP50}ms · REST GET p50 ${round(s.latency.getMedianMs, 1)}ms`);
    console.log("\nCheck done. No orders placed.");
    await logger.close(); process.exit(0);
  }
  startServer({ port: cfg.port, dir: DIR, getState, onStop: () => platform.setStop() });
  console.log(`Dashboard: http://localhost:${cfg.port}   ·   Kill switch: Ctrl+C, or create a file named STOP in ${DIR}`);
  console.log(`Phone alerts (ntfy app): subscribe to ${notifier.topic}`);
  notifier.notify("Bot started", `v48 ${cfg.mode} mode`, 3, "rocket");
  const secs = Number(opt("--seconds"));
  if (secs > 0) setTimeout(async () => { const s = getState(); console.log(JSON.stringify({ summary: { latency: s.latency, feeds: Object.fromEntries(Object.entries(s.feeds).map(([n, f]) => [n, { connected: f.connected, msgs: f.msgs, ageMs: f.ageMs }])), kalshiFeed: s.kalshiFeed, stats: s.stats, gap: s.gap, brain: { windows: s.brain.windows }, lastWhy: s.why || s.lastDecision?.why } }, null, 1)); engine.save(); await logger.close(); process.exit(0); }, secs * 1000);
}
process.on("SIGINT", async () => { console.log("\nStopping."); engine.save(); await logger.close(); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
