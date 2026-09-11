import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// gpu.mjs imports nothing from here, so this is not a cycle.
import { gpu } from "./gpu.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = path.join(ROOT, ".sharegpu");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
};

// Loopback unless explicitly opened to the VPN, matching Local Media Gen.
const vpnMode = flag("vpn") || process.env.SHAREGPU_VPN === "1";

const fileConfig = (() => {
  const p = path.join(STATE_DIR, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
})();

const pick = (cliName, envName, fileKey, fallback) =>
  opt(cliName, undefined) ?? process.env[envName] ?? fileConfig[fileKey] ?? fallback;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v, fallback) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return fallback;
};

export const config = {
  host: vpnMode ? "0.0.0.0" : "127.0.0.1",
  vpnMode,
  port: num(pick("port", "SHAREGPU_PORT", "port"), 8770),

  ollamaUrl: pick("ollama", "OLLAMA_URL", "ollamaUrl", "http://127.0.0.1:11434"),

  // Networks allowed to reach the gateway when it is bound past loopback.
  // WireGuard on the router usually either NATs peers into the LAN or gives
  // them their own /24 -- both are covered by default, narrow this if you can.
  // Loopback is always allowed and is never removable by --allow: the host has
  // to be able to reach its own dashboard, and locking yourself out of the box
  // the server runs on is never the intent behind narrowing the list.
  allowedNetworks: [
    "127.0.0.0/8",
    "::1/128",
    ...list(pick("allow", "SHAREGPU_ALLOW", "allowedNetworks"), [
      // Tailscale's CGNAT range. This is how the other apps here are reached
      // from a phone, and a tailnet peer arrives as 100.x -- not as a LAN
      // address -- so leaving it out refuses every remote device.
      // Tailscale's CGNAT range: a tailnet peer arrives as 100.x, never as a
      // LAN address, so leaving this out refuses every remote device.
      "100.64.0.0/10",
      // Broad RFC1918 defaults. A router that terminates WireGuard often puts
      // its peers on a *different* subnet from the LAN, and allowing only the
      // LAN silently drops them -- so the default covers the whole block and
      // you narrow it with --allow once you know your own ranges.
      "192.168.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
    ]).filter(
      (net) => net !== "127.0.0.0/8" && net !== "::1/128",
    ),
  ],

  // GPU budget. The desktop session (KDE, browsers, ComfyUI) holds a slice of
  // the card permanently, so never plan against the full 24 GB.
  // 0 means "measure it": the pool is whatever the driver reports across every
  // visible card, so a second GPU is picked up without editing anything.
  totalVramMb: num(pick("vram", "SHAREGPU_VRAM", "totalVramMb"), 0),
  reservedVramMb: num(pick("reserve", "SHAREGPU_RESERVE", "reservedVramMb"), 1536),

  // LLM serving.
  pinnedModel: pick("model", "SHAREGPU_MODEL", "pinnedModel", null),
  // Thinking models otherwise return an empty message to any client that does
  // not know to ask for reasoning. Opt in with --think-by-default.
  thinkByDefault: flag("think-by-default") || process.env.SHAREGPU_THINK_DEFAULT === "1",
  keepAlive: pick("keep-alive", "SHAREGPU_KEEP_ALIVE", "keepAlive", "30m"),
  maxConcurrentLlm: num(pick("concurrency", "SHAREGPU_CONCURRENCY", "maxConcurrentLlm"), 4),
  // null means "whatever the runner decides". Raising this costs KV cache per
  // concurrent request, which is the one thing that scales with user count.
  contextTokens: num(pick("ctx", "SHAREGPU_CTX", "contextTokens"), 0) || null,
  maxQueueDepth: num(pick("queue", "SHAREGPU_QUEUE", "maxQueueDepth"), 64),
  // Inactivity, not total duration. A 128k-token prompt produces no bytes for
  // several minutes while it is processed, so this has to exceed the longest
  // plausible prompt-eval, not the longest plausible response.
  requestTimeoutMs: num(pick("timeout", "SHAREGPU_TIMEOUT", "requestTimeoutMs"), 30 * 60_000),

  // Per-client token bucket, refilled continuously. Deliberately generous: the
  // GPU queue is the real backpressure, and an agent loop fires many small
  // calls in bursts. This is here to catch a runaway loop, not to shape normal
  // traffic -- a 429 in the middle of a tool-calling loop is far more
  // destructive than a slightly longer queue.
  rateBurst: num(pick("rate-burst", "SHAREGPU_RATE_BURST", "rateBurst"), 120),
  ratePerMinute: num(pick("rate", "SHAREGPU_RATE", "ratePerMinute"), 600),

  // Model management from the dashboard.
  //
  // Loading is open to the VPN by default: it is disruptive but not dangerous,
  // and the whole point of the dashboard is that people can serve themselves.
  // --lock-models puts it back behind the host or a token.
  lockModels: flag("lock-models") || process.env.SHAREGPU_LOCK_MODELS === "1" || fileConfig.lockModels === true,
  // A swap evicts multi-GB weights for everyone, so two people racing the
  // dropdown would thrash the card. One swap per cooldown window.
  swapCooldownMs: num(pick("swap-cooldown", "SHAREGPU_SWAP_COOLDOWN", "swapCooldownMs"), 45_000),

  // Pulling is off unless asked for: it writes to the model library and can
  // fill the disk, which is a different class of risk from loading one.
  pullEnabled: flag("allow-pull") || process.env.SHAREGPU_PULL === "1" || fileConfig.pullEnabled === true,
  pullMaxGb: num(pick("pull-max-gb", "SHAREGPU_PULL_MAX_GB", "pullMaxGb"), 60),
  minFreeDiskGb: num(pick("min-free-gb", "SHAREGPU_MIN_FREE_GB", "minFreeDiskGb"), 25),

  // Raw compute. Off unless asked for: it runs caller-supplied commands.
  computeEnabled: flag("allow-compute") || process.env.SHAREGPU_COMPUTE === "1" || fileConfig.computeEnabled === true,
  computeToken: pick("compute-token", "SHAREGPU_COMPUTE_TOKEN", "computeToken", null),
  leaseDefaultMs: num(pick("lease", "SHAREGPU_LEASE", "leaseDefaultMs"), 15 * 60_000),
  leaseMaxMs: num(pick("lease-max", "SHAREGPU_LEASE_MAX", "leaseMaxMs"), 4 * 60 * 60_000),
  leaseHeartbeatMs: num(pick("heartbeat", "SHAREGPU_HEARTBEAT", "leaseHeartbeatMs"), 60_000),
  jobMaxMs: num(pick("job-max", "SHAREGPU_JOB_MAX", "jobMaxMs"), 60 * 60_000),
  jobRetentionMs: num(pick("job-retention", "SHAREGPU_JOB_RETENTION", "jobRetentionMs"), 24 * 60 * 60_000),
  maxUploadBytes: num(pick("max-upload", "SHAREGPU_MAX_UPLOAD", "maxUploadBytes"), 512 * 1024 * 1024),
};

export const usableVramMb = () => {
  const total = config.totalVramMb || gpu.totalMb();
  // Before the first nvidia-smi poll there is nothing to measure. Reporting a
  // budget of zero would read as "no VRAM at all" and refuse work that would
  // have fit; null says "not known yet", which callers can handle honestly.
  if (!total) return null;
  return Math.max(0, total - config.reservedVramMb);
};

// A compute token is mandatory once compute is on -- subnet trust alone should
// not be what stands between a stray host and arbitrary command execution.
export function ensureComputeToken() {
  if (!config.computeEnabled) return null;
  if (config.computeToken) return config.computeToken;
  config.computeToken = randomBytes(24).toString("base64url");
  return config.computeToken;
}

export function showHelp() {
  return `ShareGPU -- share one GPU across a VPN

  node server.mjs [options]

  --vpn                 bind 0.0.0.0 instead of loopback (needed for VPN peers)
  --port <n>            listen port (default 8770)
  --allow <cidr,...>    networks allowed through (default LAN + RFC1918 WG ranges)
  --model <name>        model to keep resident and warm
  --concurrency <n>     concurrent LLM requests sharing the resident model
  --ctx <n>             context window per request (default: the runner's own)
  --think-by-default    let thinking models think unless a caller opts out
  --reserve <mb>        VRAM left to the desktop session (default 1536)
  --lock-models         restrict model loading to the host or a token holder
  --allow-pull          let dashboard users download new models
  --pull-max-gb <n>     refuse pulls larger than this (default 60)
  --min-free-gb <n>     keep at least this much disk free (default 25)
  --allow-compute       enable the raw compute lease + job runner
  --compute-token <s>   token for compute callers (generated if omitted)
  --lease <ms>          default compute lease length
  --help                this text
`;
}

export const helpRequested = flag("help") || flag("h");
