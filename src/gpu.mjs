import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

const QUERY = [
  "index",
  "name",
  "memory.total",
  "memory.used",
  "memory.free",
  "utilization.gpu",
  "utilization.memory",
  "temperature.gpu",
  "power.draw",
  "power.limit",
];

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile("nvidia-smi", args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const toNumber = (raw) => {
  const n = Number.parseFloat(String(raw).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function readDevices() {
  const out = await run([`--query-gpu=${QUERY.join(",")}`, "--format=csv,noheader,nounits"]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cells = line.split(",").map((c) => c.trim());
      const [index, name, total, used, free, util, memUtil, temp, power, powerCap] = cells;
      return {
        index: toNumber(index) ?? 0,
        name,
        memoryTotalMb: toNumber(total),
        memoryUsedMb: toNumber(used),
        memoryFreeMb: toNumber(free),
        utilizationPct: toNumber(util),
        memoryUtilizationPct: toNumber(memUtil),
        temperatureC: toNumber(temp),
        powerDrawW: toNumber(power),
        powerLimitW: toNumber(powerCap),
      };
    });
}

async function readProcesses() {
  try {
    const out = await run([
      "--query-compute-apps=pid,process_name,used_memory",
      "--format=csv,noheader,nounits",
    ]);
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, name, mem] = line.split(",").map((c) => c.trim());
        return { pid: toNumber(pid), name, memoryMb: toNumber(mem) };
      });
  } catch {
    return [];
  }
}

class GpuMonitor extends EventEmitter {
  constructor({ intervalMs = 2000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.snapshot = { available: false, devices: [], processes: [], error: null, at: 0 };
    this.timer = null;
  }

  async poll() {
    try {
      const [devices, processes] = await Promise.all([readDevices(), readProcesses()]);
      this.snapshot = { available: true, devices, processes, error: null, at: Date.now() };
    } catch (err) {
      this.snapshot = {
        available: false,
        devices: [],
        processes: [],
        error: err.code === "ENOENT" ? "nvidia-smi not found" : err.message,
        at: Date.now(),
      };
    }
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  start() {
    if (this.timer) return this;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get primary() {
    return this.snapshot.devices[0] ?? null;
  }

  /**
   * Pooled free memory across every visible device.
   *
   * llama.cpp splits a model's layers across GPUs, so capacity really is the
   * sum -- but only for something being newly loaded. A single allocation
   * still cannot straddle two cards, which is why largestFreeMb() exists for
   * anything that must land on one device.
   */
  freeMb() {
    return this.snapshot.devices.reduce((sum, d) => sum + (d.memoryFreeMb ?? 0), 0);
  }

  totalMb() {
    return this.snapshot.devices.reduce((sum, d) => sum + (d.memoryTotalMb ?? 0), 0);
  }

  /** The biggest single-device allocation the machine could satisfy. */
  largestFreeMb() {
    return this.snapshot.devices.reduce((max, d) => Math.max(max, d.memoryFreeMb ?? 0), 0);
  }

  get deviceCount() {
    return this.snapshot.devices.length;
  }

  /**
   * Poll until the card has released memory. Model unloads are asynchronous
   * inside the runner, so a lease grant has to observe the VRAM actually come
   * back rather than trust the unload call returning.
   */
  async waitForFree(targetMb, { timeoutMs = 120_000, singleDevice = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.poll();
      const available = singleDevice ? this.largestFreeMb() : this.freeMb();
      if (available >= targetMb) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export const gpu = new GpuMonitor();
