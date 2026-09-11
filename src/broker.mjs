import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config, usableVramMb } from "./config.mjs";
import { gpu } from "./gpu.mjs";
import { ollama } from "./ollama.mjs";

/**
 * The broker owns the card.
 *
 * One 24 GB device cannot hold a 19 GB resident LLM and a caller's training job
 * at the same time, so the GPU is run as a mode machine rather than a free-for-
 * all. In `llm` mode the resident weights are shared by every concurrent chat
 * request, which is what makes many users cheap: they pay KV cache, not another
 * copy of the model. In `compute` mode a single lease holder gets the card and
 * the LLM is evicted first, then reloaded when the lease ends.
 *
 * Admission is strictly head-of-queue. Letting a later same-model request jump
 * a waiting different-model one would raise throughput slightly and starve the
 * odd model out indefinitely; worse, freely interleaving models on one card
 * turns into a 19 GB reload per alternation, which is disk-bound and collapses
 * throughput for everyone. Serialising swaps is the point, not a limitation.
 */
class Broker extends EventEmitter {
  #mode = "llm";
  #llmActive = new Map();
  #llmQueue = [];
  #activeModel = null;
  #residentPin = null;
  #loadedModel = null;
  #lease = null;
  #leaseQueue = [];
  #switching = null;
  #lastShareable = null;
  #lastSwapAt = 0;
  #swapInFlight = null;
  #stats = { served: 0, rejected: 0, queuedPeak: 0, leases: 0, swaps: 0 };

  get mode() {
    return this.#mode;
  }

  get lease() {
    return this.#lease;
  }

  // ---------------------------------------------------------------- LLM slots

  /**
   * Reserve one of the concurrent LLM slots. Resolves to a release handle; the
   * caller must release in a finally block or the slot leaks for the lifetime
   * of the process.
   */
  acquireLlm({ model, clientId, signal }) {
    return new Promise((resolve, reject) => {
      if (this.#llmQueue.length >= config.maxQueueDepth) {
        this.#stats.rejected += 1;
        const err = new Error("GPU queue is full, retry shortly");
        err.status = 503;
        err.retryAfter = 15;
        reject(err);
        return;
      }

      const waiter = {
        id: randomUUID(),
        model,
        clientId,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        signal,
        settled: false,
      };

      const timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.#removeWaiter(waiter);
        const err = new Error("timed out waiting for a GPU slot");
        err.status = 504;
        reject(err);
      }, config.requestTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;

      if (signal) {
        const onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearTimeout(timer);
          this.#removeWaiter(waiter);
          const err = new Error("client disconnected");
          err.status = 499;
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.#llmQueue.push(waiter);
      this.#stats.queuedPeak = Math.max(this.#stats.queuedPeak, this.#llmQueue.length);
      this.#emitState();
      this.#pump();
    });
  }

  #removeWaiter(waiter) {
    const i = this.#llmQueue.indexOf(waiter);
    if (i !== -1) this.#llmQueue.splice(i, 1);
    this.#emitState();
  }

  #grant(waiter) {
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.cleanupAbort?.();

    const slot = {
      id: waiter.id,
      model: waiter.model,
      clientId: waiter.clientId,
      startedAt: Date.now(),
      waitedMs: Date.now() - waiter.enqueuedAt,
    };
    this.#llmActive.set(slot.id, slot);
    if (this.#activeModel && this.#activeModel !== waiter.model) this.#stats.swaps += 1;
    this.#activeModel = waiter.model;
    this.#stats.served += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#llmActive.delete(slot.id);
      if (this.#llmActive.size === 0) this.#activeModel = null;
      this.#emitState();
      this.#pump();
    };

    this.#emitState();
    waiter.resolve({ ...slot, release });
  }

  /** Position in the visible queue, 1-based; 0 once running. */
  queuePositionOf(id) {
    const i = this.#llmQueue.findIndex((w) => w.id === id);
    return i === -1 ? 0 : i + 1;
  }

  // -------------------------------------------------------------- Compute lease

  /**
   * Ask for exclusive use of the card. Resolves once the LLM has drained and
   * the requested VRAM is genuinely free, not merely once the unload returned.
   */
  /**
   * What the card could actually hand over right now: the memory already free
   * plus whatever the LLM is holding, since that is evictable on demand. The
   * static total-minus-reserve figure is only a policy ceiling -- the desktop
   * session's real usage floats, so a lease validated against the static number
   * can be accepted and then fail to free, which is worse than refusing it.
   */
  async shareableMb() {
    await gpu.poll();
    const free = gpu.freeMb();
    const resident = await ollama.resident().catch(() => []);
    const evictable = resident.reduce((sum, m) => sum + (m.sizeVramMb || 0), 0);
    // null means the card has not been measured yet; fall back to what is
    // observably free rather than treating "unknown" as "none".
    const policyCap = usableVramMb();
    const achievable = policyCap === null ? free + evictable : Math.min(policyCap, free + evictable);
    const budget = { free, evictable, policyCap, achievable };
    this.#lastShareable = budget.achievable;
    return budget;
  }

  async requestLease({ clientId, label, vramMb, durationMs, signal }) {
    const budget = await this.shareableMb();
    const want = Number(vramMb) || budget.achievable;
    if (want > budget.achievable) {
      const err = new Error(
        `requested ${want} MB but at most ${budget.achievable} MB can be freed right now ` +
          `(${budget.free} MB free + ${budget.evictable} MB held by the LLM, ` +
          `capped at ${budget.policyCap} MB by the ${config.reservedVramMb} MB desktop reserve)`,
      );
      err.status = 400;
      throw err;
    }

    const ttl = Math.min(Number(durationMs) || config.leaseDefaultMs, config.leaseMaxMs);

    return new Promise((resolve, reject) => {
      const entry = {
        id: randomUUID(),
        clientId,
        label: label || null,
        vramMb: want,
        durationMs: ttl,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        settled: false,
      };

      if (signal) {
        const onAbort = () => {
          if (entry.settled) return;
          entry.settled = true;
          const i = this.#leaseQueue.indexOf(entry);
          if (i !== -1) this.#leaseQueue.splice(i, 1);
          const err = new Error("client disconnected");
          err.status = 499;
          reject(err);
          this.#pump();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.#leaseQueue.push(entry);
      this.#emitState();
      this.#pump();
    });
  }

  async #grantLease(entry) {
    entry.settled = true;
    entry.cleanupAbort?.();
    this.#mode = "switching";
    this.#emitState();

    let evicted = [];
    try {
      evicted = await ollama.unloadAll();
      this.#loadedModel = null;
      const ok = await gpu.waitForFree(entry.vramMb, { timeoutMs: 120_000 });
      if (!ok) {
        this.#mode = "llm";
        this.#emitState();
        const err = new Error(
          `could not free ${entry.vramMb} MB within 120s -- something outside ShareGPU is holding the card`,
        );
        err.status = 503;
        entry.reject(err);
        this.#pump();
        return;
      }
    } catch (err) {
      this.#mode = "llm";
      this.#emitState();
      entry.reject(err);
      this.#pump();
      return;
    }

    const now = Date.now();
    this.#lease = {
      id: entry.id,
      clientId: entry.clientId,
      label: entry.label,
      vramMb: entry.vramMb,
      grantedAt: now,
      expiresAt: now + entry.durationMs,
      lastHeartbeat: now,
      waitedMs: now - entry.enqueuedAt,
      evictedModels: evicted,
      jobs: [],
    };
    this.#mode = "compute";
    this.#stats.leases += 1;
    this.#emitState();
    this.emit("lease:granted", this.#lease);
    entry.resolve(this.#lease);
  }

  heartbeat(leaseId) {
    if (!this.#lease || this.#lease.id !== leaseId) return false;
    this.#lease.lastHeartbeat = Date.now();
    return true;
  }

  extendLease(leaseId, extraMs) {
    if (!this.#lease || this.#lease.id !== leaseId) return null;
    const capped = Math.min(this.#lease.expiresAt + extraMs, this.#lease.grantedAt + config.leaseMaxMs);
    this.#lease.expiresAt = capped;
    this.#lease.lastHeartbeat = Date.now();
    this.#emitState();
    return this.#lease;
  }

  async releaseLease(leaseId, reason = "released") {
    if (!this.#lease || this.#lease.id !== leaseId) return false;
    const lease = this.#lease;
    this.#lease = null;
    this.#mode = "llm";
    this.emit("lease:released", { ...lease, reason });
    this.#emitState();
    this.#pump();
    // Bring the pinned model back so the next chat request is not paying for a
    // cold 19 GB load.
    this.#restorePin(lease.evictedModels);
    return true;
  }

  async #restorePin(evicted) {
    const target = this.#residentPin ?? config.pinnedModel ?? evicted?.[0];
    if (!target) return;
    if (this.#mode !== "llm") return;
    try {
      await ollama.load(target, config.keepAlive);
      this.emit("model:warmed", target);
    } catch {
      /* the next request will load it anyway */
    }
  }

  resetSwapCooldown() {
    this.#lastSwapAt = 0;
  }

  /** Time left before another swap is allowed, in ms. */
  swapCooldownRemaining() {
    if (this.#lastSwapAt === 0) return 0;
    return Math.max(0, config.swapCooldownMs - (Date.now() - this.#lastSwapAt));
  }

  async pinModel(model) {
    this.#residentPin = model || null;
    if (!model) return null;
    if (this.#mode !== "llm") return model;

    // Two dashboards racing the same button would otherwise start two
    // multi-GB loads at once. Join the in-flight one instead.
    //
    // The comparison must be against what actually finished loading, not
    // against the requested pin -- #residentPin was just set to `model` above,
    // so comparing to it always matched and the load was skipped entirely.
    if (this.#swapInFlight) {
      await this.#swapInFlight.catch(() => {});
      if (this.#loadedModel === model) return model;
    }

    this.#mode = "switching";
    this.#emitState();
    this.#swapInFlight = ollama
      .load(model, config.keepAlive)
      .finally(() => {
        this.#swapInFlight = null;
        this.#mode = this.#lease ? "compute" : "llm";
        this.#lastSwapAt = Date.now();
        this.#emitState();
      });

    await this.#swapInFlight;
    this.#loadedModel = model;
    this.emit("model:warmed", model);
    return model;
  }

  get pinnedModel() {
    return this.#residentPin ?? config.pinnedModel ?? null;
  }

  // ------------------------------------------------------------------ scheduler

  #pump() {
    if (this.#switching) return;

    // A pending lease freezes LLM admission so the card can drain. Without this
    // a steady chat load would hold the GPU forever and no lease would land.
    if (this.#leaseQueue.length > 0 && !this.#lease) {
      if (this.#llmActive.size === 0) {
        const entry = this.#leaseQueue.shift();
        if (entry && !entry.settled) {
          this.#switching = this.#grantLease(entry).finally(() => {
            this.#switching = null;
          });
        }
      }
      return;
    }

    if (this.#lease) return;

    while (this.#llmQueue.length > 0) {
      const head = this.#llmQueue[0];
      if (head.settled) {
        this.#llmQueue.shift();
        continue;
      }
      if (this.#llmActive.size >= config.maxConcurrentLlm) break;
      // Different model than the one in flight: wait for a clean drain rather
      // than forcing a mid-flight swap.
      if (this.#activeModel !== null && this.#activeModel !== head.model) break;
      this.#llmQueue.shift();
      this.#grant(head);
    }
  }

  /** Reap leases whose holder stopped heartbeating or ran out of time. */
  sweep() {
    if (!this.#lease) return;
    const now = Date.now();
    const staleAfter = config.leaseHeartbeatMs * 3;
    if (now > this.#lease.expiresAt) {
      this.releaseLease(this.#lease.id, "expired");
    } else if (now - this.#lease.lastHeartbeat > staleAfter) {
      this.releaseLease(this.#lease.id, "heartbeat lost");
    }
  }

  #emitState() {
    this.emit("state", this.status());
  }

  status() {
    return {
      mode: this.#mode,
      activeModel: this.#activeModel,
      pinnedModel: this.pinnedModel,
      llm: {
        active: [...this.#llmActive.values()].map((s) => ({
          id: s.id,
          model: s.model,
          clientId: s.clientId,
          startedAt: s.startedAt,
          waitedMs: s.waitedMs,
        })),
        queued: this.#llmQueue.map((w, i) => ({
          id: w.id,
          position: i + 1,
          model: w.model,
          clientId: w.clientId,
          waitingMs: Date.now() - w.enqueuedAt,
        })),
        capacity: config.maxConcurrentLlm,
      },
      lease: this.#lease
        ? {
            id: this.#lease.id,
            clientId: this.#lease.clientId,
            label: this.#lease.label,
            vramMb: this.#lease.vramMb,
            grantedAt: this.#lease.grantedAt,
            expiresAt: this.#lease.expiresAt,
            remainingMs: Math.max(0, this.#lease.expiresAt - Date.now()),
            jobs: this.#lease.jobs.length,
          }
        : null,
      leaseQueue: this.#leaseQueue.map((e, i) => ({
        id: e.id,
        position: i + 1,
        clientId: e.clientId,
        label: e.label,
        vramMb: e.vramMb,
        waitingMs: Date.now() - e.enqueuedAt,
      })),
      stats: { ...this.#stats },
      budgetMb: usableVramMb(),
      measuredShareableMb: this.#lastShareable,
    };
  }
}

export const broker = new Broker();

const sweeper = setInterval(() => broker.sweep(), 5000);
sweeper.unref?.();

// Keep the reported shareable figure fresh for the dashboard, so an operator
// can see headroom shrink as the desktop session grows without asking for a
// lease to find out.
const budgetPoll = setInterval(() => {
  broker.shareableMb().catch(() => {});
}, 15_000);
budgetPoll.unref?.();
