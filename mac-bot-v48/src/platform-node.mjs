// Mac / Node platform: key file, state file, STOP file, JSONL logs. (Cloudflare equivalent: src/platform-cf.mjs)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readLogs } from "./logger.mjs";

// Signs Kalshi requests with the key file next to the bot (RSA-PSS or Ed25519). Returns null without a key.
export function nodeSigner(cfg, dir, log = () => {}) {
  if (!cfg.keyId || !cfg.privateKeyPath || /PASTE/.test(cfg.keyId)) return null;
  const p = path.isAbsolute(cfg.privateKeyPath) ? cfg.privateKeyPath : path.join(dir, cfg.privateKeyPath);
  let key; try { key = crypto.createPrivateKey(fs.readFileSync(p, "utf8")); } catch (e) { log({ event: "KEY_NOT_LOADED", error: e.message }); return null; }
  return {
    hasKey: true, keyId: cfg.keyId,
    sign: async (text) => {
      const msg = Buffer.from(text);
      const sig = key.asymmetricKeyType === "ed25519" ? crypto.sign(null, msg, key)
        : crypto.sign("sha256", msg, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
      return sig.toString("base64");
    },
  };
}

export function nodePlatform(dir, logsDir) {
  const STATE = path.join(dir, "bot-state.json"), STOP = path.join(dir, "STOP");
  return {
    loadState: () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } },
    saveState: (obj) => fs.writeFileSync(STATE, JSON.stringify(obj, null, 1)),
    stopActive: () => fs.existsSync(STOP),
    setStop: () => fs.writeFileSync(STOP, "stop\n"),
    readSamples: () => readLogs(logsDir, "samples"),
  };
}
