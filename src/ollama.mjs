import { config } from "./config.mjs";

// Everything the gateway is willing to reach on the runner. Anything that
// mutates the model library -- delete, pull, push, create, copy -- is absent on
// purpose: a peer on the VPN must not be able to erase or refill ~160 GB of
// local models.
const SAFE_PATHS = new Set([
  "/api/tags",
  "/api/ps",
  "/api/show",
  "/api/chat",
  "/api/generate",
  "/api/embed",
  "/api/embeddings",
  "/api/version",
]);

export const isSafeOllamaPath = (p) => SAFE_PATHS.has(p);

export class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status ?? 502;
  }
}

async function call(pathname, { method = "GET", body, signal, timeoutMs = 30_000, baseUrl } = {}) {
  const base = baseUrl ?? config.ollamaUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === "AbortError") throw new OllamaError("upstream request aborted", 504);
    throw new OllamaError(`cannot reach Ollama at ${base}: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function json(pathname, options) {
  const res = await call(pathname, options);
  const text = await res.text();
  if (!res.ok) throw new OllamaError(text || `upstream ${res.status}`, res.status);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new OllamaError("upstream returned malformed JSON", 502);
  }
}

/**
 * Best-effort read of the runner's own parallelism. OLLAMA_NUM_PARALLEL=1 means
 * the runner serialises every request, so any concurrency this gateway allows
 * is imaginary -- requests pass the gate and then queue inside the runner. That
 * is invisible from the API, and it is the first thing to check when several
 * agents feel slower than one.
 */
export async function detectRunnerParallelism() {
  const { readdir, readFile } = await import("node:fs/promises");
  try {
    const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (!cmd.includes("ollama")) continue;
      const env = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
      const match = env.split("\0").find((line) => line.startsWith("OLLAMA_NUM_PARALLEL="));
      if (match) return Number(match.split("=")[1]) || null;
      // Present but unset means the runner picks its own value.
      if (env) return null;
    }
  } catch {
    /* not Linux, or the process is not ours to inspect */
  }
  return null;
}

/**
 * Model names reach the runner as a registry reference, so they are validated
 * rather than trusted: a name is a registry path with optional tag or digest,
 * and nothing else. This keeps shell-ish and path-ish input out of the puller.
 */
export function isValidModelName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (trimmed.includes("..") || trimmed.startsWith("/") || /\s/.test(trimmed)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$/.test(trimmed);
}

export const ollama = {
  /** Streaming-capable raw call, used by the chat proxy. */
  raw: (pathname, options) => call(pathname, options),

  async version() {
    return json("/api/version", { timeoutMs: 5000 });
  },

  async models() {
    const data = await json("/api/tags", { timeoutMs: 15_000 });
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      sizeMb: Math.round((m.size ?? 0) / (1024 * 1024)),
      family: m.details?.family ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      modifiedAt: m.modified_at ?? null,
    }));
  },

  /** Models currently holding VRAM, with their expiry. */
  async resident() {
    const data = await json("/api/ps", { timeoutMs: 10_000 });
    return (data.models ?? []).map((m) => ({
      name: m.name,
      sizeMb: Math.round((m.size ?? 0) / (1024 * 1024)),
      sizeVramMb: Math.round((m.size_vram ?? 0) / (1024 * 1024)),
      expiresAt: m.expires_at ?? null,
    }));
  },

  /**
   * Load a model and hold it. keepAlive of -1 pins it until told otherwise.
   * An empty prompt makes this a pure load with no generation.
   */
  async load(model, keepAlive = config.keepAlive) {
    return json("/api/generate", {
      method: "POST",
      body: { model, prompt: "", stream: false, keep_alive: keepAlive },
      timeoutMs: 10 * 60_000,
    });
  },

  /** keep_alive 0 tells the runner to drop the weights immediately. */
  async unload(model) {
    return json("/api/generate", {
      method: "POST",
      body: { model, prompt: "", stream: false, keep_alive: 0 },
      timeoutMs: 120_000,
    }).catch(() => ({}));
  },

  /**
   * Start a pull and yield progress objects. The runner streams NDJSON with
   * total/completed byte counts per layer, which is enough to show a real bar
   * rather than a spinner.
   */
  async pull(model, { signal } = {}) {
    return call("/api/pull", {
      method: "POST",
      body: { model, stream: true },
      signal,
      timeoutMs: 6 * 60 * 60_000,
    });
  },

  async unloadAll() {
    const loaded = await this.resident().catch(() => []);
    await Promise.all(loaded.map((m) => this.unload(m.name)));
    return loaded.map((m) => m.name);
  },
};
