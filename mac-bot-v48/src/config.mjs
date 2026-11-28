// Settings merge + hard caps, shared by the Mac bot (bot.mjs) and the Cloudflare Worker (cloudflare/worker.mjs).
export const REAL_PHRASE = "I understand this uses real money";

export function buildConfig(example, user = {}, warn = console.error) {
  const cfg = { ...example, ...user, limits: { ...example.limits, ...(user.limits || {}) }, strategy: { ...example.strategy, ...(user.strategy || {}) }, brain: { ...example.brain, ...(user.brain || {}) }, feeds: { ...example.feeds, ...(user.feeds || {}) } };
  if (cfg.mode === "real" && cfg.confirmRealMoney !== REAL_PHRASE) { warn(`"mode" is "real" but "confirmRealMoney" is not exactly "${REAL_PHRASE}". Staying in PAPER mode.`); cfg.mode = "paper"; }
  if (cfg.mode !== "real") cfg.mode = "paper";
  // hard caps the config cannot loosen
  cfg.limits.maxBetFraction = Math.min(Number(cfg.limits.maxBetFraction) || 0.03, 0.25);
  cfg.limits.floorDollars = Math.max(Number(cfg.limits.floorDollars) || 15, 1);
  cfg.limits.maxBuysPerWindow = Math.min(Number(cfg.limits.maxBuysPerWindow) || 2, 4);
  cfg.limits.minSecondsLeft = Math.max(Number(cfg.limits.minSecondsLeft) || 60, 30);
  cfg.limits.maxSlipCents = Math.min(Math.max(Number(cfg.limits.maxSlipCents) || 0, 0), 3);
  return cfg;
}
