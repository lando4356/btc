import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takerFeeDollars, makerFeeDollars, feePerContractCents, holdEdgeCents } from "../src/fees.mjs";
import { kellyFraction, sizeOrder } from "../src/sizing.mjs";
import { fitModel, predict, Brain, simWindowTrade } from "../src/brain.mjs";
import { createLogger, readLogs } from "../src/logger.mjs";
import { KBook } from "../src/book.mjs";
import { encodeFrame, decodeFrames } from "../src/ws.mjs";
import { GapTracker, fairUp } from "../src/fair.mjs";

test("taker fee matches Kalshi formula with centicent round-up", () => {
  assert.equal(takerFeeDollars(50, 1), 0.0175);   // 0.07*0.5*0.5
  assert.equal(takerFeeDollars(20, 1), 0.0112);   // 0.07*0.2*0.8
  assert.equal(takerFeeDollars(85, 1), 0.0090);   // 0.008925 -> 0.0090
  assert.equal(takerFeeDollars(50, 100), 1.75);
  assert.equal(takerFeeDollars(50, 0), 0);
});
test("maker fee is zero on plain quadratic series, 0.0175 rate otherwise", () => {
  assert.equal(makerFeeDollars(50, 10), 0);
  assert.equal(makerFeeDollars(50, 100, { feeType: "quadratic_with_maker_fees" }), 0.4375);
});
test("hold edge subtracts price and fee", () => {
  assert.ok(Math.abs(feePerContractCents(50, 1) - 1.75) < 1e-9);
  assert.ok(Math.abs(holdEdgeCents(0.55, 50, 1) - 3.25) < 1e-9);
  assert.ok(holdEdgeCents(0.5, 50, 1) < 0); // a fair coin at 50c loses the fee
});
test("Kelly: zero when no edge, quarter Kelly capped at 3%", () => {
  assert.equal(kellyFraction(0.5, 0.5175), 0);
  assert.ok(Math.abs(kellyFraction(0.6, 0.5) - 0.2) < 1e-12);
  const big = sizeOrder({ prob: 0.9, priceCents: 50, feeCentsPerContract: 1.75, balanceDollars: 1000 });
  assert.ok(big.fraction <= 0.03 + 1e-12);
  assert.ok(big.stakeDollars <= 30 + 1e-9);
  const small = sizeOrder({ prob: 0.56, priceCents: 50, feeCentsPerContract: 1.75, balanceDollars: 1000 });
  assert.ok(small.fraction < 0.03 && small.fraction > 0); // quarter of (0.56-0.5175)/(1-0.5175)=0.088 -> 0.022
  assert.equal(sizeOrder({ prob: 0.9, priceCents: 50, feeCentsPerContract: 1.75, balanceDollars: 1000, maxDepth: 3 }).count, 3);
  assert.equal(sizeOrder({ prob: 0.5, priceCents: 50, feeCentsPerContract: 1.75, balanceDollars: 1000 }).count, 0);
});

// synthetic data: y depends on a feature beyond Kalshi's price
function synth(nWin, rowsPer, beta, seed = 1) {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const wins = [];
  for (let w = 0; w < nWin; w++) {
    const pK = 0.3 + 0.4 * rnd(), x = rnd() * 2 - 1;
    const pt = 1 / (1 + Math.exp(-(Math.log(pK / (1 - pK)) + beta * x)));
    const y = rnd() < pt ? 1 : 0;
    const rows = Array.from({ length: rowsPer }, (_, i) => ({ win: "W" + w, t: w * 1000 + i, left: 800 - i * 10, pK, askYes: Math.round(pK * 100) + 1, askNo: Math.round((1 - pK) * 100) + 1, f: { flow5: x, flow60: x, gap: 0 } }));
    wins.push({ rows, y });
  }
  return wins;
}
test("combiner learns a real signal and leaves Kalshi alone when there is none", () => {
  const real = synth(600, 1, 2.0).flatMap((w) => w.rows.map((r) => ({ ...r, y: w.y })));
  const m = fitModel(real, ["flow"], { lambda: 4 });
  assert.ok(predict(m, { ...real[0], f: { flow5: 1, flow60: 1 } }) > predict(m, { ...real[0], f: { flow5: -1, flow60: -1 } }) + 0.2);
  const none = synth(600, 1, 0, 7).flatMap((w) => w.rows.map((r) => ({ ...r, y: w.y })));
  const m0 = fitModel(none, ["flow"], { lambda: 50 });
  const r = none[0]; assert.ok(Math.abs(predict(m0, r) - r.pK) < 0.06);
});
test("brain scores out-of-sample before learning and does not accept noise", () => {
  const b = new Brain({ minFitWindows: 10, minAcceptWindows: 100 });
  for (const w of synth(250, 5, 0, 3)) { for (const r of w.rows) b.addSample({ ...r }); b.settle(w.rows[0].win, w.y); }
  assert.equal(b.windows(), 250);
  assert.ok(b.evals.length === 250 && b.evals[0].ll.cand_flow == null); // first windows had no model yet
  assert.equal(b.accepted.size, 0);
  assert.equal(b.trusted(), false);
});
test("brain accepts a strong real signal after enough windows", () => {
  const b = new Brain({ minFitWindows: 20, minAcceptWindows: 150 });
  for (const w of synth(500, 3, 3.0, 11)) { for (const r of w.rows) b.addSample({ ...r }); b.settle(w.rows[0].win, w.y); }
  assert.ok(b.accepted.has("flow"));
});
test("simWindowTrade charges fee and slippage", () => {
  const t = simWindowTrade([{ askYes: 50, askNo: 52, left: 600 }], [0.6], 1, { minEdgeCents: 3, slipCents: 1 });
  assert.equal(t.side, "up"); assert.ok(Math.abs(t.pnl - (100 - 50 - 1.75 - 1)) < 1e-9);
  assert.equal(simWindowTrade([{ askYes: 50, askNo: 52, left: 600 }], [0.53], 1), null);
});
test("JSONL logger writes and reads back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v48log-"));
  const lg = createLogger(dir); lg.write("ticks", { a: 1 }); lg.write("ticks", { a: 2 }); lg.write("events", { event: "X" }); await lg.close();
  const t = readLogs(dir, "ticks"); assert.deepEqual(t.map((x) => x.a), [1, 2]); assert.ok(t[0].ts > 0);
  assert.equal(readLogs(dir, "events")[0].event, "X");
});
test("Kalshi book: fp snapshot, deltas, asks and fills", () => {
  const b = new KBook("T");
  b.applySnapshot({ yes_dollars_fp: [["0.4500", "10"], ["0.4400", "5"]], no_dollars_fp: [["0.5300", "7"], ["0.5200", "20"]] });
  assert.deepEqual(b.top(), { yesBid: 45, yesBidQty: 10, noBid: 53, noBidQty: 7, yesAsk: 47, yesAskQty: 7, noAsk: 55, noAskQty: 10 });
  const f = b.fillBuy("yes", 10, 48); assert.equal(f.filled, 10); assert.ok(Math.abs(f.avg - (47 * 7 + 48 * 3) / 10) < 1e-9);
  b.applyDelta({ side: "no", price_dollars: "0.5300", delta_fp: "-7" }); assert.equal(b.top().yesAsk, 48);
});
test("WebSocket frames round-trip (masked, 16-bit length)", () => {
  const msg = "x".repeat(300), { frames, rest } = decodeFrames(Buffer.concat([encodeFrame(msg), encodeFrame("hi", 1, false)]));
  assert.equal(frames[0].payload.toString(), msg); assert.equal(frames[1].payload.toString(), "hi"); assert.equal(rest.length, 0);
});
test("gap tracker counts the shared strike/settlement minute once; fair value sane", () => {
  const g = new GapTracker(null, { priorSd: 3 });
  g.add("close", 100000, 99995, 1000); g.add("open", 100000, 99995, 2000); assert.equal(g.e.n, 1);
  assert.ok(Math.abs(fairUp({ price: 100000, leftSec: 600, strike: 100000, sigma: 0.00003 }) - 0.5) < 0.01);
  assert.ok(fairUp({ price: 100100, leftSec: 30, strike: 100000, sigma: 0.00003 }) > 0.9);
});

test("Cloudflare signer (WebCrypto RSA-PSS) produces signatures Node verifies like Kalshi does", async () => {
  const crypto = await import("node:crypto");
  const { cfSigner } = await import("../src/platform-cf.mjs");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const s = await cfSigner({ KALSHI_KEY_ID: "k", KALSHI_PRIVATE_KEY: pem });
  const msg = "1795884844973GET/trade-api/v2/portfolio/balance", sig = Buffer.from(await s.sign(msg), "base64");
  assert.ok(crypto.verify("sha256", Buffer.from(msg), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig));
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });
  await assert.rejects(cfSigner({ KALSHI_KEY_ID: "k", KALSHI_PRIVATE_KEY: pkcs1 }), /PKCS#1/);
  assert.equal(await cfSigner({}), null);
});
test("config: paper by default, real needs the exact phrase, caps cannot be loosened", async () => {
  const { buildConfig, REAL_PHRASE } = await import("../src/config.mjs");
  const ex = JSON.parse(fs.readFileSync(new URL("../config.example.json", import.meta.url)));
  const q = () => {};
  assert.equal(buildConfig(ex, {}, q).mode, "paper");
  assert.equal(buildConfig(ex, { mode: "real" }, q).mode, "paper");
  assert.equal(buildConfig(ex, { mode: "real", confirmRealMoney: REAL_PHRASE }, q).mode, "real");
  const c = buildConfig(ex, { limits: { maxBetFraction: 0.9, floorDollars: 0, maxSlipCents: 10, minSecondsLeft: 5 } }, q);
  assert.equal(c.limits.maxBetFraction, 0.25); assert.equal(c.limits.floorDollars, 15); assert.equal(c.limits.maxSlipCents, 3); assert.equal(c.limits.minSecondsLeft, 30);
  assert.equal(ex.limits.maxBetFraction, 0.03); assert.equal(ex.strategy.kellyMultiplier, 0.25); assert.equal(ex.mode, "paper");
});
