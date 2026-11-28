// JSON-lines logging, one folder per day: logs/YYYY-MM-DD/{ticks,events,samples,windows}.jsonl
// ticks   = one line per second: prices, every exchange, Kalshi book, model numbers, signals, position
// events  = decisions, orders, fills, fees, latency, errors
// samples = training rows (features + Kalshi price + asks) with the official result, written when a window settles
// windows = one line per settled window: official result, strike, settlement value, gap samples, out-of-sample scores
import fs from "node:fs";
import path from "node:path";

export function createLogger(root, { echo = false } = {}) {
  const streams = new Map();
  let day = null;
  const dayStr = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  function stream(kind) {
    const d = dayStr();
    if (d !== day) { for (const s of streams.values()) s.end(); streams.clear(); day = d; }
    let s = streams.get(kind);
    if (!s) { const dir = path.join(root, d); fs.mkdirSync(dir, { recursive: true }); s = fs.createWriteStream(path.join(dir, `${kind}.jsonl`), { flags: "a" }); streams.set(kind, s); }
    return s;
  }
  function write(kind, obj) {
    const line = JSON.stringify({ ts: Date.now(), ...obj });
    stream(kind).write(line + "\n");
    if (echo && kind === "events") console.log(line);
    return line;
  }
  function flush() { return Promise.all([...streams.values()].map((s) => new Promise((r) => (s.writableLength ? s.once("drain", r) : r())))); }
  function close() { return Promise.all([...streams.values()].map((s) => new Promise((r) => s.end(r)))); }
  return { write, flush, close, root };
}

// Reads every <kind>.jsonl under root (oldest day first). Skips broken lines.
export function readLogs(root, kind) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort()) {
    const f = path.join(root, d, `${kind}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line) continue; try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}
