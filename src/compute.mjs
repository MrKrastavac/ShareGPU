import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config, STATE_DIR } from "./config.mjs";
import { broker } from "./broker.mjs";

export const JOBS_DIR = path.join(STATE_DIR, "jobs");
export const WORKSPACES_DIR = path.join(STATE_DIR, "workspaces");

/**
 * A lease gets one workspace directory and every job on that lease runs inside
 * it. That is what makes the remote card feel like a machine rather than a
 * series of unrelated invocations: upload a dataset once, run three scripts
 * against it, collect the checkpoints at the end. Job directories hold only the
 * script and its logs.
 */
export const workspaceDir = (leaseId) => path.join(WORKSPACES_DIR, leaseId);

/**
 * A job runs caller-supplied commands on this machine with the GPU attached.
 * That is the whole point -- a remote harness cannot call CUDA over a tunnel,
 * so instead it ships the work here -- but it also means the compute surface is
 * remote code execution by design. It stays disabled unless --allow-compute is
 * passed, and even then it demands a bearer token on top of the subnet gate.
 */

// Nothing from the server's own environment is inherited: the parent process
// holds the compute token, and a job has no business reading it.
function jobEnv(workDir, extra = {}) {
  const base = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin",
    HOME: workDir,
    TMPDIR: path.join(workDir, ".tmp"),
    PWD: workDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    // Every visible GPU by default; a lease can narrow this to specific
    // indices so one card is leased while the other keeps serving chat.
    CUDA_VISIBLE_DEVICES: extra.__devices ?? "all",
    NVIDIA_VISIBLE_DEVICES: extra.__devices ?? "all",
    SHAREGPU: "1",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (key === "__devices") continue;
    // Loader and preload variables are how a job would escape the intended
    // toolchain, so they are not caller-settable.
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (/^(LD_|DYLD_|BASH_ENV|ENV$)/i.test(key)) continue;
    if (typeof value !== "string") continue;
    base[key] = value;
  }
  return base;
}

class Job extends EventEmitter {
  constructor({ id, leaseId, clientId, spec, dir, workDir }) {
    super();
    this.id = id;
    this.leaseId = leaseId;
    this.clientId = clientId;
    this.spec = spec;
    this.dir = dir;
    this.workDir = workDir;
    this.status = "pending";
    this.exitCode = null;
    this.signal = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.child = null;
    this.lines = [];
    this.lineCount = 0;
    this.maxLines = 2000;
    this.logStream = null;
    this.setMaxListeners(0);
  }

  append(stream, text) {
    for (const raw of text.split("\n")) {
      if (raw === "") continue;
      const entry = { n: ++this.lineCount, stream, text: raw.slice(0, 8192), at: Date.now() };
      this.lines.push(entry);
      if (this.lines.length > this.maxLines) this.lines.shift();
      this.logStream?.write(`${stream === "stderr" ? "E" : "O"} ${raw}\n`);
      this.emit("line", entry);
    }
  }

  start() {
    fs.mkdirSync(path.join(this.workDir, ".tmp"), { recursive: true });
    this.logStream = fs.createWriteStream(path.join(this.dir, "output.log"), { flags: "a" });

    const { command, args, script, shell } = this.spec;
    let file;
    let argv;
    if (script) {
      const scriptPath = path.join(this.dir, "job.sh");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      file = shell || "/bin/bash";
      argv = [scriptPath];
    } else {
      file = command;
      argv = args ?? [];
    }

    this.status = "running";
    this.startedAt = Date.now();

    try {
      this.child = spawn(file, argv, {
        cwd: this.workDir,
        env: jobEnv(this.workDir, { ...(this.spec.env ?? {}), __devices: this.spec.devices ?? undefined }),
        // Its own process group, so a kill reaches the whole tree rather than
        // leaving orphaned python holding VRAM.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.status = "failed";
      this.error = err.message;
      this.finishedAt = Date.now();
      this.emit("done", this);
      return this;
    }

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this.append("stdout", d));
    this.child.stderr.on("data", (d) => this.append("stderr", d));

    const limit = Math.min(this.spec.timeoutMs ?? config.jobMaxMs, config.jobMaxMs);
    this.timer = setTimeout(() => {
      this.append("stderr", `[sharegpu] job exceeded ${Math.round(limit / 1000)}s, terminating`);
      this.kill("SIGKILL");
      this.status = "timeout";
    }, limit);
    this.timer.unref?.();

    this.child.on("error", (err) => {
      this.error = err.message;
      this.append("stderr", `[sharegpu] ${err.message}`);
    });

    this.child.on("close", (code, signal) => {
      clearTimeout(this.timer);
      this.exitCode = code;
      this.signal = signal;
      this.finishedAt = Date.now();
      if (this.status === "timeout") {
        /* keep it */
      } else if (this.status === "killed") {
        /* keep it */
      } else {
        this.status = code === 0 ? "succeeded" : "failed";
      }
      this.logStream?.end();
      this.emit("done", this);
    });

    this.emit("started", this);
    return this;
  }

  kill(signal = "SIGTERM") {
    if (!this.child || this.finishedAt) return false;
    if (this.status === "running") this.status = "killed";
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        return false;
      }
    }
    if (signal !== "SIGKILL") {
      const hard = setTimeout(() => {
        if (!this.finishedAt) {
          try {
            process.kill(-this.child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, 10_000);
      hard.unref?.();
    }
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      lease_id: this.leaseId,
      client: this.clientId,
      status: this.status,
      exit_code: this.exitCode,
      signal: this.signal,
      error: this.error,
      created_at: this.createdAt,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      duration_ms: this.finishedAt && this.startedAt ? this.finishedAt - this.startedAt : null,
      lines: this.lineCount,
      spec: {
        command: this.spec.command ?? null,
        args: this.spec.args ?? null,
        script: this.spec.script ? `${this.spec.script.slice(0, 200)}${this.spec.script.length > 200 ? "..." : ""}` : null,
      },
    };
  }
}

class JobStore {
  #jobs = new Map();

  create({ leaseId, clientId, spec }) {
    const id = randomUUID();
    const dir = path.join(JOBS_DIR, id);
    const workDir = workspaceDir(leaseId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const job = new Job({ id, leaseId, clientId, spec, dir, workDir });
    this.#jobs.set(id, job);
    const lease = broker.lease;
    if (lease && lease.id === leaseId) lease.jobs.push(id);
    return job;
  }

  get(id) {
    return this.#jobs.get(id) ?? null;
  }

  list({ leaseId } = {}) {
    return [...this.#jobs.values()]
      .filter((j) => (leaseId ? j.leaseId === leaseId : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  running() {
    return [...this.#jobs.values()].filter((j) => j.status === "running");
  }

  killForLease(leaseId, reason) {
    let killed = 0;
    for (const job of this.#jobs.values()) {
      if (job.leaseId === leaseId && job.status === "running") {
        job.append("stderr", `[sharegpu] lease ended (${reason}), terminating job`);
        job.kill("SIGTERM");
        killed += 1;
      }
    }
    return killed;
  }

  async sweep() {
    const cutoff = Date.now() - config.jobRetentionMs;
    const liveLeases = new Set();
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        this.#jobs.delete(id);
        await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      } else {
        liveLeases.add(job.leaseId);
      }
    }
    // Workspaces outlive their lease so artifacts stay collectable, but not
    // past the retention window.
    const entries = await fsp.readdir(WORKSPACES_DIR, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || liveLeases.has(entry.name)) continue;
      if (broker.lease?.id === entry.name) continue;
      const dir = path.join(WORKSPACES_DIR, entry.name);
      const stat = await fsp.stat(dir).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export const jobs = new JobStore();

// A lease ending must not leave a caller's process holding the card, or the
// LLM cannot be reloaded and the next lease starts against a dirty GPU.
broker.on("lease:released", (lease) => {
  jobs.killForLease(lease.id, lease.reason);
});

const sweeper = setInterval(() => jobs.sweep(), 10 * 60_000);
sweeper.unref?.();

/** Confine a caller-supplied relative path to a lease's workspace. */
export function safeWorkspacePath(leaseId, relative) {
  const cleaned = String(relative ?? "").replace(/^\/+/, "");
  const base = path.resolve(workspaceDir(leaseId));
  const resolved = path.resolve(base, cleaned);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export async function listWorkspaceFiles(leaseId) {
  const base = workspaceDir(leaseId);
  const out = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".tmp") continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) out.push({ path: rel, size: stat.size, modified: stat.mtimeMs });
      }
      if (out.length > 5000) return;
    }
  }
  await walk(base, "");
  return out;
}
