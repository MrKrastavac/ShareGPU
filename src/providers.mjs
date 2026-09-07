import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

const FILE = path.join(STATE_DIR, "providers.json");

/**
 * A registry of Ollama backends this gateway can route to.
 *
 * The alternative design -- pooling VRAM across machines with llama.cpp's RPC
 * backend -- makes every token's activations cross the network, which on
 * Ethernet costs more than the extra VRAM is worth. Federating instead keeps
 * each model wholly on one host and routes whole requests, so a second machine
 * adds throughput and capacity without adding per-token latency.
 *
 * It also sidesteps the platform problem: a provider is just an Ollama server,
 * and Ollama runs natively on Windows and macOS. A machine joins the pool
 * without running any of this project's Linux-specific parts.
 */
class Providers extends EventEmitter {
  #providers = new Map();
  #timer = null;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /** The always-present local backend, plus anything previously registered. */
  init(localUrl) {
    this.#providers.set("local", {
      id: "local",
      name: "this machine",
      url: localUrl,
      builtin: true,
      enabled: true,
      online: false,
      lastSeen: 0,
      lastError: null,
      models: [],
      resident: [],
      version: null,
      latencyMs: null,
    });

    try {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
      for (const p of saved.providers ?? []) {
        if (p.id === "local") continue;
        this.#providers.set(p.id, {
          id: p.id,
          name: p.name ?? p.id,
          url: p.url,
          builtin: false,
          enabled: p.enabled !== false,
          online: false,
          lastSeen: 0,
          lastError: null,
          models: [],
          resident: [],
          version: null,
          latencyMs: null,
        });
      }
    } catch {
      /* no registry yet */
    }
    return this;
  }

  #persist() {
    const payload = {
      providers: [...this.#providers.values()]
        .filter((p) => !p.builtin)
        .map((p) => ({ id: p.id, name: p.name, url: p.url, enabled: p.enabled })),
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(payload, null, 2) + "\n");
  }

  add({ id, name, url }) {
    const clean = String(url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/i.test(clean)) {
      const err = new Error("url must look like http://host:11434");
      err.status = 400;
      throw err;
    }
    const key = (id || new URL(clean).host).replace(/[^A-Za-z0-9._:-]/g, "-");
    if (key === "local") {
      const err = new Error("'local' is reserved for this machine");
      err.status = 400;
      throw err;
    }
    this.#providers.set(key, {
      id: key,
      name: name || key,
      url: clean,
      builtin: false,
      enabled: true,
      online: false,
      lastSeen: 0,
      lastError: null,
      models: [],
      resident: [],
      version: null,
      latencyMs: null,
    });
    this.#persist();
    this.refresh(key);
    return this.#providers.get(key);
  }

  remove(id) {
    const p = this.#providers.get(id);
    if (!p) return false;
    if (p.builtin) {
      const err = new Error("the local backend cannot be removed");
      err.status = 400;
      throw err;
    }
    this.#providers.delete(id);
    this.#persist();
    this.emit("change");
    return true;
  }

  setEnabled(id, enabled) {
    const p = this.#providers.get(id);
    if (!p) return null;
    p.enabled = Boolean(enabled);
    this.#persist();
    this.emit("change");
    return p;
  }

  get(id) {
    return this.#providers.get(id) ?? null;
  }

  list() {
    return [...this.#providers.values()];
  }

  online() {
    return this.list().filter((p) => p.enabled && p.online);
  }

  /** Poll one backend for liveness, its library, and what it currently holds. */
  async refresh(id) {
    const p = this.#providers.get(id);
    if (!p || !p.enabled) return;
    const started = Date.now();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const [version, tags, ps] = await Promise.all([
        fetch(`${p.url}/api/version`, { signal: ac.signal }).then((r) => r.json()),
        fetch(`${p.url}/api/tags`, { signal: ac.signal }).then((r) => r.json()),
        fetch(`${p.url}/api/ps`, { signal: ac.signal }).then((r) => r.json()).catch(() => ({})),
      ]);
      clearTimeout(timer);
      p.version = version?.version ?? null;
      p.models = (tags?.models ?? []).map((m) => ({
        name: m.name,
        sizeMb: Math.round((m.size ?? 0) / (1024 * 1024)),
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
      }));
      p.resident = (ps?.models ?? []).map((m) => m.name);
      p.online = true;
      p.lastSeen = Date.now();
      p.latencyMs = Date.now() - started;
      p.lastError = null;
    } catch (err) {
      const wasOnline = p.online;
      p.online = false;
      p.lastError = err.name === "AbortError" ? "timed out" : err.message;
      if (wasOnline) this.emit("offline", p);
    }
  }

  async refreshAll() {
    await Promise.all(this.list().map((p) => this.refresh(p.id)));
    this.emit("change");
  }

  start(intervalMs = 15_000) {
    if (this.#timer) return this;
    this.refreshAll();
    this.#timer = setInterval(() => this.refreshAll(), intervalMs);
    this.#timer.unref?.();
    return this;
  }

  /**
   * Choose where a request should run.
   *
   * A backend that already holds the model wins outright: a cold load is
   * multiple GB off disk, which dwarfs any difference in queueing. Among
   * equals, prefer the local machine (no network hop), then the lowest
   * measured latency.
   */
  pickFor(model) {
    const candidates = this.online().filter((p) => p.models.some((m) => m.name === model));
    if (candidates.length === 0) return null;
    const score = (p) =>
      (p.resident.includes(model) ? 0 : 1000) + (p.id === "local" ? 0 : 10) + (p.latencyMs ?? 0) / 1000;
    return candidates.sort((a, b) => score(a) - score(b))[0];
  }

  /** Every distinct model across every online backend, with who has it. */
  catalogue() {
    const byName = new Map();
    for (const p of this.online()) {
      for (const m of p.models) {
        const entry = byName.get(m.name) ?? { ...m, providers: [], resident: false };
        entry.providers.push(p.id);
        if (p.resident.includes(m.name)) entry.resident = true;
        byName.set(m.name, entry);
      }
    }
    return [...byName.values()].sort((a, b) => b.sizeMb - a.sizeMb);
  }
}

export const providers = new Providers();
