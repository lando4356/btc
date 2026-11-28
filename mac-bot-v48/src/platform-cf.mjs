// Cloudflare platform: Kalshi key from Worker secrets, bot state + logs in the Durable Object's own SQLite storage,
// per-second ticks batched to R2 (optional), phone alerts via ntfy over fetch. (Mac equivalent: src/platform-node.mjs)
// Secrets (set with `wrangler secret put`, never in the repo): KALSHI_KEY_ID, KALSHI_PRIVATE_KEY (the PEM text), NTFY_TOPIC.

const b64 = (buf) => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Kalshi signs "timestamp + METHOD + path" with RSA-PSS/SHA-256 (salt = digest length, 32 bytes). Kalshi hands out
// PKCS#1 ("BEGIN RSA PRIVATE KEY") files; WebCrypto needs PKCS#8 ("BEGIN PRIVATE KEY"). Convert once with:
//   openssl pkcs8 -topk8 -nocrypt -in kalshi-key.pem -out kalshi-key-pkcs8.pem
export async function cfSigner(env) {
  if (!env.KALSHI_KEY_ID || !env.KALSHI_PRIVATE_KEY) return null;
  const pem = env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) throw new Error("KALSHI_PRIVATE_KEY is PKCS#1; convert it to PKCS#8 (see src/platform-cf.mjs)");
  let key, algo;
  try { key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]); algo = { name: "RSA-PSS", saltLength: 32 }; }
  catch { key = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "Ed25519" }, false, ["sign"]); algo = { name: "Ed25519" }; }
  const enc = new TextEncoder();
  return { hasKey: true, keyId: env.KALSHI_KEY_ID, sign: async (text) => b64(await crypto.subtle.sign(algo, key, enc.encode(text))) };
}

// One SQLite table per log kind inside the Durable Object. Kept small to stay inside the free row-write allowance:
// samples are written as ONE row per settled window; ticks go to R2 in 10-minute files (or 1 row/minute if no R2).
export function cfPlatform(ctx, env) {
  const sql = ctx.storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, body TEXT)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS log_kind_ts ON log(kind, ts)`);
  const get = (k) => { const r = sql.exec(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0]; return r ? JSON.parse(r.v) : null; };
  const put = (k, v) => sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, JSON.stringify(v));
  let lastStateWrite = 0, pendingState = null, stateTimer = null;
  const platform = {
    loadState: () => get("state"),
    // state can change many times a second during a trade; write at most once per second (ctx storage is durable)
    saveState: (obj) => {
      pendingState = obj; const now = Date.now();
      if (now - lastStateWrite > 1000) { put("state", obj); lastStateWrite = now; pendingState = null; }
      else if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; if (pendingState) { put("state", pendingState); lastStateWrite = Date.now(); pendingState = null; } }, 1000);
    },
    stopActive: () => !!get("stop"),
    setStop: (on = true) => put("stop", on ? { at: Date.now() } : null),
    readSamples: () => sql.exec(`SELECT body FROM log WHERE kind = 'samples' ORDER BY id`).toArray().flatMap((r) => JSON.parse(r.body)),
    get, put,
  };
  return platform;
}

// Logger with the same write(kind, obj) interface as src/logger.mjs.
export function cfLogger(ctx, env) {
  const sql = ctx.storage.sql;
  const sampleBuf = new Map(); // win -> rows, flushed as one row when the window's samples are complete
  let ticks = [], tickChunkStart = 0;
  const flushTicks = async () => {
    if (!ticks.length) return;
    const lines = ticks.map((t) => JSON.stringify(t)).join("\n") + "\n", first = ticks[0].ts; ticks = [];
    if (env.LOGS) { const d = new Date(first).toISOString(); await env.LOGS.put(`ticks/${d.slice(0, 10)}/${d.slice(11, 19).replace(/:/g, "")}.jsonl`, lines); }
    else sql.exec(`INSERT INTO log (ts, kind, body) VALUES (?, 'ticks', ?)`, first, lines);
  };
  function write(kind, obj) {
    const row = { ts: Date.now(), ...obj };
    if (kind === "ticks") {
      if (!tickChunkStart) tickChunkStart = row.ts;
      ticks.push(row);
      const chunkMs = env.LOGS ? 600000 : 60000;
      if (row.ts - tickChunkStart >= chunkMs) { tickChunkStart = row.ts; flushTicks().catch(() => {}); }
      return;
    }
    if (kind === "samples") { const a = sampleBuf.get(row.win) || []; a.push(row); sampleBuf.set(row.win, a); return; }
    if (kind === "windows") { // a window settled: its samples are complete, write them as one row
      const a = sampleBuf.get(obj.ticker); if (a) { sql.exec(`INSERT INTO log (ts, kind, body) VALUES (?, 'samples', ?)`, row.ts, JSON.stringify(a)); sampleBuf.delete(obj.ticker); }
    }
    sql.exec(`INSERT INTO log (ts, kind, body) VALUES (?, ?, ?)`, row.ts, kind, JSON.stringify(row));
  }
  // keep ~30 days of events/windows in SQLite (the free plan has 5 GB of DO storage per account)
  const prune = () => sql.exec(`DELETE FROM log WHERE kind IN ('events','ticks') AND ts < ?`, Date.now() - 30 * 86400000);
  return { write, flush: flushTicks, close: flushTicks, prune, root: "durable-object" };
}

export function cfNotifier(env, cfg = {}) {
  const topic = env.NTFY_TOPIC || null, last = {};
  async function notify(title, msg, prio = 3, tag = "", throttleKey = null, throttleMs = 0) {
    if (!topic || cfg.notify === false) return;
    if (throttleKey) { const n = Date.now(); if (n - (last[throttleKey] || 0) < throttleMs) return; last[throttleKey] = n; }
    try { await fetch(`https://ntfy.sh/${topic}`, { method: "POST", body: String(msg), headers: { Title: String(title).replace(/[^\x20-\x7E]/g, "").trim(), Priority: String(prio), Tags: tag } }); } catch {}
  }
  return { topic, notify };
}
