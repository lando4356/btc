// Phone alerts through the free ntfy app (same as v47). The topic is a random private name saved in notify.txt.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function createNotifier(dir, cfg = {}) {
  const f = path.join(dir, "notify.txt");
  let topic = null; try { topic = fs.readFileSync(f, "utf8").trim(); } catch {}
  if (!topic) { topic = "kbot-" + crypto.randomBytes(9).toString("hex"); fs.writeFileSync(f, topic + "\n"); }
  const base = cfg.ntfyBase || "https://ntfy.sh/";
  const enabled = cfg.notify !== false;
  const last = {};
  async function notify(title, msg, prio = 3, tag = "", throttleKey = null, throttleMs = 0) {
    if (!enabled) return;
    if (throttleKey) { const n = Date.now(); if (n - (last[throttleKey] || 0) < throttleMs) return; last[throttleKey] = n; }
    try { await fetch(base + topic, { method: "POST", body: String(msg), headers: { Title: String(title).replace(/[^\x20-\x7E]/g, "").trim(), Priority: String(prio), Tags: tag } }); } catch {}
  }
  return { topic, notify };
}
