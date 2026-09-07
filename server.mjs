import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config, ROOT, STATE_DIR, ensureComputeToken, showHelp, helpRequested, usableVramMb } from "./src/config.mjs";
import { gpu } from "./src/gpu.mjs";
import { broker } from "./src/broker.mjs";
import { ollama, isSafeOllamaPath, detectRunnerParallelism, isValidModelName } from "./src/ollama.mjs";
import { jobs, safeWorkspacePath, listWorkspaceFiles } from "./src/compute.mjs";
import { providers } from "./src/providers.mjs";
import {
  isAllowedAddress,
  identify,
  consumeRate,
  bearerFrom,
  tokensMatch,
  knownClients,
  describeAllowList,
  recordRejection,
  recentRejections,
  suggestNetworkFor,
} from "./src/access.mjs";
import { sendJson, sendError, sendText, readJson, openSse, ndjson } from "./src/http.mjs";
import * as oai from "./src/openai.mjs";

if (helpRequested) {
  process.stdout.write(showHelp());
  process.exit(0);
}

fs.mkdirSync(STATE_DIR, { recursive: true });

const PUBLIC_DIR = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendError(res, 403, "forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(resolved);
    res.writeHead(200, {
      "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    sendError(res, 404, "not found");
  }
}

// --------------------------------------------------------------------- status

const isLoopback = (id) => id === "127.0.0.1" || id === "::1";

async function fullStatus(client) {
  const [models, resident] = await Promise.all([
    ollama.models().catch(() => []),
    ollama.resident().catch(() => []),
  ]);
  const snapshot = gpu.snapshot;
  return {
    server: {
      host: config.host,
      port: config.port,
      vpnMode: config.vpnMode,
      computeEnabled: config.computeEnabled,
      pullEnabled: config.pullEnabled,
      lockModels: config.lockModels,
      // The compute token is a shell credential on this desktop. The dashboard
      // is readable by anyone on the VPN, so it is only ever handed to the host
      // itself -- everyone else is told to ask for it.
      computeToken: config.computeEnabled && client && isLoopback(client.id) ? config.computeToken : null,
      allowedNetworks: describeAllowList(),
      uptimeMs: Math.round(process.uptime() * 1000),
      budgetMb: usableVramMb(),
      reservedMb: config.reservedVramMb,
    },
    gpu: snapshot,
    broker: broker.status(),
    models,
    resident,
    clients: knownClients().slice(0, 50),
    providers: providers.list().map((p) => ({
      id: p.id, name: p.name, url: p.url, builtin: p.builtin, enabled: p.enabled,
      online: p.online, latencyMs: p.latencyMs, lastError: p.lastError,
      modelCount: p.models.length, residentCount: p.resident.length,
    })),
    pull: pullSnapshot(),
    rejected: recentRejections(),
    jobs: config.computeEnabled ? jobs.list().slice(0, 50).map((j) => j.toJSON()) : [],
  };
}

// ------------------------------------------------------------------ SSE fanout

const listeners = new Set();

function broadcast(event, payload) {
  for (const send of listeners) {
    try {
      send(payload, event);
    } catch {
      /* dropped below on its own close */
    }
  }
}

gpu.on("snapshot", (snap) => broadcast("gpu", snap));
broker.on("state", (state) => broadcast("broker", state));
broker.on("lease:granted", (lease) => broadcast("log", { level: "info", text: `lease granted to ${lease.clientId} (${lease.vramMb} MB)` }));
broker.on("lease:released", (lease) => broadcast("log", { level: "info", text: `lease ${lease.id.slice(0, 8)} ${lease.reason}` }));
broker.on("model:warmed", (model) => broadcast("log", { level: "info", text: `model warmed: ${model}` }));

// --------------------------------------------------------------- model pulls

// Ollama reports progress per layer, restarting the byte counts for each one.
// Reporting that verbatim makes the bar jump backwards from 100% to whatever
// the next layer is at, so layers are tracked individually and summed.
const pullState = {
  active: false, model: null, by: null, status: null,
  total: 0, completed: 0, startedAt: 0, error: null, controller: null,
  layers: new Map(), done: false,
};

function pullSnapshot() {
  let total = 0;
  let completed = 0;
  for (const layer of pullState.layers.values()) {
    total += layer.total ?? 0;
    completed += Math.min(layer.completed ?? 0, layer.total ?? 0);
  }
  const percent = pullState.done ? 100 : total > 0 ? Math.round((completed / total) * 100) : null;
  return {
    active: pullState.active,
    model: pullState.model,
    by: pullState.by,
    status: pullState.status,
    total,
    completed,
    percent,
    error: pullState.error,
    startedAt: pullState.startedAt,
  };
}

async function freeDiskGb() {
  try {
    const dir = process.env.OLLAMA_MODELS || process.env.HOME || "/";
    const stat = await statfs(dir);
    return (stat.bavail * stat.bsize) / 1e9;
  } catch {
    return null;
  }
}

async function startPull(model, by) {
  const controller = new AbortController();
  Object.assign(pullState, {
    active: true, model, by, status: "starting", total: 0, completed: 0,
    startedAt: Date.now(), error: null, controller, layers: new Map(), done: false,
  });
  broadcast("pull", pullSnapshot());
  broadcast("log", { level: "info", text: `${by} started downloading ${model}` });

  try {
    const upstream = await ollama.pull(model, { signal: controller.signal });
    if (!upstream.ok) throw new Error((await upstream.text()) || `upstream ${upstream.status}`);

    let lastEmit = 0;
    for await (const chunk of ndjson(Readable.fromWeb(upstream.body))) {
      if (chunk.error) throw new Error(chunk.error);
      pullState.status = chunk.status ?? pullState.status;
      if (chunk.digest) {
        const layer = pullState.layers.get(chunk.digest) ?? { total: 0, completed: 0 };
        if (typeof chunk.total === "number") layer.total = chunk.total;
        if (typeof chunk.completed === "number") layer.completed = chunk.completed;
        pullState.layers.set(chunk.digest, layer);
      }

      // A pull emits progress far faster than any UI needs it.
      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        broadcast("pull", pullSnapshot());
      }

      const bytes = [...pullState.layers.values()].reduce((sum, l) => sum + (l.total ?? 0), 0);
      if (bytes / 1e9 > config.pullMaxGb) {
        throw new Error(`${model} is larger than the ${config.pullMaxGb} GB limit`);
      }
    }
    pullState.done = true;
    pullState.status = "complete";
    broadcast("log", { level: "info", text: `${model} downloaded` });
  } catch (err) {
    pullState.error = err.name === "AbortError" ? "cancelled" : err.message;
    pullState.status = pullState.error;
    broadcast("log", { level: "stderr", text: `download of ${model} ${pullState.error}` });
  } finally {
    pullState.active = false;
    pullState.controller = null;
    broadcast("pull", pullSnapshot());
  }
}

// ------------------------------------------------------------------- compute

function requireCompute(req, res) {
  if (!config.computeEnabled) {
    sendError(res, 404, "compute is disabled; start the server with --allow-compute");
    return false;
  }
  if (!tokensMatch(bearerFrom(req), config.computeToken)) {
    sendError(res, 401, "a valid compute token is required", { type: "unauthorized" });
    return false;
  }
  return true;
}

function activeLeaseFor(req, res) {
  const token = req.headers["x-sharegpu-lease"];
  const lease = broker.lease;
  if (!lease || !token || lease.id !== token) {
    sendError(res, 409, "an active GPU lease is required; POST /compute/leases first", { type: "no_lease" });
    return null;
  }
  broker.heartbeat(lease.id);
  return lease;
}

async function handleCompute(req, res, url, client) {
  if (!requireCompute(req, res)) return;
  const segments = url.pathname.split("/").filter(Boolean); // ["compute", ...]
  const [, section, id, action, ...rest] = segments;

  // ---- leases
  if (section === "leases") {
    if (req.method === "POST" && !id) {
      const body = await readJson(req);
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      try {
        const lease = await broker.requestLease({
          clientId: client.label,
          label: typeof body.label === "string" ? body.label.slice(0, 120) : null,
          vramMb: body.vram_mb,
          durationMs: body.duration_ms,
          signal: controller.signal,
        });
        sendJson(res, 201, {
          lease_id: lease.id,
          vram_mb: lease.vramMb,
          granted_at: lease.grantedAt,
          expires_at: lease.expiresAt,
          waited_ms: lease.waitedMs,
          heartbeat_every_ms: config.leaseHeartbeatMs,
          evicted_models: lease.evictedModels,
          note: "send X-ShareGPU-Lease with this id on every job call, and heartbeat to keep it",
        });
      } catch (err) {
        if (err.status === 499) return;
        sendError(res, err.status ?? 503, err.message);
      }
      return;
    }
    if (req.method === "POST" && id && action === "heartbeat") {
      const ok = broker.heartbeat(id);
      if (!ok) return sendError(res, 404, "no such active lease");
      return sendJson(res, 200, { ok: true, expires_at: broker.lease.expiresAt });
    }
    if (req.method === "POST" && id && action === "extend") {
      const body = await readJson(req);
      const lease = broker.extendLease(id, Number(body.extra_ms) || config.leaseDefaultMs);
      if (!lease) return sendError(res, 404, "no such active lease");
      return sendJson(res, 200, { ok: true, expires_at: lease.expiresAt });
    }
    // Workspace files live on the lease, so a caller can stage inputs before
    // the first job and collect outputs after the last one.
    if (action === "files") {
      const relative = rest.join("/");
      if (req.method === "GET" && !relative) {
        return sendJson(res, 200, { files: await listWorkspaceFiles(id) });
      }
      const target = safeWorkspacePath(id, relative);
      if (!target) return sendError(res, 400, "path escapes the workspace");

      if (req.method === "PUT" || req.method === "POST") {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        let written = 0;
        const out = fs.createWriteStream(target);
        req.on("data", (c) => {
          written += c.length;
          if (written > config.maxUploadBytes) req.destroy(new Error("upload exceeds the size limit"));
        });
        try {
          await pipeline(req, out);
        } catch (err) {
          await fsp.rm(target, { force: true }).catch(() => {});
          return sendError(res, 413, err.message);
        }
        return sendJson(res, 201, { path: relative, size: written });
      }

      if (req.method === "GET") {
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat?.isFile()) return sendError(res, 404, "no such file");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "content-disposition": `attachment; filename="${path.basename(target)}"`,
        });
        return pipeline(fs.createReadStream(target), res).catch(() => {});
      }

      if (req.method === "DELETE") {
        await fsp.rm(target, { force: true, recursive: true }).catch(() => {});
        return sendJson(res, 200, { ok: true });
      }
      return sendError(res, 405, "method not allowed");
    }

    if (req.method === "DELETE" && id) {
      const ok = await broker.releaseLease(id, "released");
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (req.method === "GET") {
      return sendJson(res, 200, { lease: broker.status().lease, queue: broker.status().leaseQueue });
    }
    return sendError(res, 405, "method not allowed");
  }

  // ---- jobs
  if (section === "jobs") {
    if (req.method === "POST" && !id) {
      const lease = activeLeaseFor(req, res);
      if (!lease) return;
      const body = await readJson(req);
      const hasScript = typeof body.script === "string" && body.script.trim();
      const hasCommand = typeof body.command === "string" && body.command.trim();
      if (!hasScript && !hasCommand) {
        return sendError(res, 400, "provide either script (shell text) or command (+ args array)");
      }
      if (body.args != null && !Array.isArray(body.args)) {
        return sendError(res, 400, "args must be an array of strings");
      }
      const job = jobs.create({
        leaseId: lease.id,
        clientId: client.label,
        spec: {
          script: hasScript ? body.script : null,
          command: hasCommand ? body.command : null,
          args: (body.args ?? []).map(String),
          env: body.env && typeof body.env === "object" ? body.env : {},
          timeoutMs: Number(body.timeout_ms) || config.jobMaxMs,
        },
      });
      job.on("line", (line) => broadcast("job", { job: job.id, ...line }));
      job.on("done", (j) => broadcast("job:done", j.toJSON()));
      job.start();
      broadcast("log", { level: "info", text: `job ${job.id.slice(0, 8)} started for ${client.label}` });
      return sendJson(res, 201, {
        ...job.toJSON(),
        logs_url: `/compute/jobs/${job.id}/logs`,
        // Files belong to the lease workspace, shared by every job on it.
        files_url: `/compute/leases/${lease.id}/files`,
      });
    }

    if (!id) {
      if (req.method !== "GET") return sendError(res, 405, "method not allowed");
      return sendJson(res, 200, { jobs: jobs.list().map((j) => j.toJSON()) });
    }

    const job = jobs.get(id);
    if (!job) return sendError(res, 404, "no such job");

    if (req.method === "GET" && !action) return sendJson(res, 200, job.toJSON());

    if (req.method === "DELETE" && !action) {
      const killed = job.kill("SIGTERM");
      return sendJson(res, 200, { ok: killed, status: job.status });
    }

    if (req.method === "GET" && action === "logs") {
      // Live tail: replay the retained buffer, then follow.
      const since = Number(url.searchParams.get("since")) || 0;
      const sse = openSse(res);
      for (const line of job.lines) if (line.n > since) sse.send(line, "line");
      if (job.finishedAt) {
        sse.send(job.toJSON(), "done");
        sse.close();
        return;
      }
      const onLine = (line) => sse.send(line, "line");
      const onDone = (j) => {
        sse.send(j.toJSON(), "done");
        sse.close();
      };
      job.on("line", onLine);
      job.once("done", onDone);
      const keepAlive = setInterval(() => sse.comment("keepalive"), 15_000);
      keepAlive.unref?.();
      req.on("close", () => {
        clearInterval(keepAlive);
        job.off("line", onLine);
        job.off("done", onDone);
      });
      return;
    }

    return sendError(res, 405, "method not allowed");
  }

  return sendError(res, 404, "unknown compute endpoint");
}

// -------------------------------------------------------------------- routing

async function route(req, res, url, client) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/healthz") return sendJson(res, 200, { ok: true, mode: broker.mode });

  if (pathname === "/api/status") return sendJson(res, 200, await fullStatus(client));

  if (pathname === "/api/events") {
    const sse = openSse(res);
    sse.send(await fullStatus(client), "snapshot");
    const send = (payload, event) => sse.send(payload, event);
    listeners.add(send);
    const keepAlive = setInterval(() => sse.comment("keepalive"), 15_000);
    keepAlive.unref?.();
    req.on("close", () => {
      clearInterval(keepAlive);
      listeners.delete(send);
    });
    return;
  }

  if (pathname === "/api/models" && method === "GET") {
    return sendJson(res, 200, { models: await ollama.models(), pinned: broker.pinnedModel });
  }

  // ---- federation: other machines contributing their GPUs
  if (pathname === "/api/providers") {
    if (method === "GET") {
      return sendJson(res, 200, {
        providers: providers.list().map((p) => ({
          id: p.id, name: p.name, url: p.url, builtin: p.builtin, enabled: p.enabled,
          online: p.online, lastSeen: p.lastSeen, lastError: p.lastError,
          version: p.version, latencyMs: p.latencyMs,
          modelCount: p.models.length, resident: p.resident,
        })),
      });
    }
    // Adding a backend means this gateway will send prompts to it, so it is an
    // admin action rather than something any VPN client can do.
    if (method === "POST") {
      if (config.lockModels && !isLoopback(client.id) && !tokensMatch(bearerFrom(req), config.computeToken)) {
        return sendError(res, 403, "adding a machine is restricted to the host or a token holder");
      }
      const body = await readJson(req);
      try {
        const added = providers.add({ id: body.id, name: body.name, url: body.url });
        broadcast("log", { level: "info", text: `${client.label} added backend ${added.id} (${added.url})` });
        return sendJson(res, 201, { id: added.id, url: added.url });
      } catch (err) {
        return sendError(res, err.status ?? 400, err.message);
      }
    }
    return sendError(res, 405, "method not allowed");
  }

  if (pathname.startsWith("/api/providers/")) {
    const id = decodeURIComponent(pathname.slice("/api/providers/".length));
    if (config.lockModels && !isLoopback(client.id) && !tokensMatch(bearerFrom(req), config.computeToken)) {
      return sendError(res, 403, "managing machines is restricted to the host or a token holder");
    }
    if (method === "DELETE") {
      try {
        const ok = providers.remove(id);
        if (ok) broadcast("log", { level: "info", text: `${client.label} removed backend ${id}` });
        return sendJson(res, ok ? 200 : 404, { ok });
      } catch (err) {
        return sendError(res, err.status ?? 400, err.message);
      }
    }
    if (method === "POST") {
      const body = await readJson(req);
      const p = providers.setEnabled(id, body.enabled);
      return sendJson(res, p ? 200 : 404, { ok: Boolean(p) });
    }
    return sendError(res, 405, "method not allowed");
  }

  // ---- model management
  //
  // Loading is disruptive but recoverable; pulling writes to the library and
  // can fill the disk. They are gated differently for that reason.
  if (pathname === "/api/models/load" && method === "POST") {
    if (config.lockModels && !isLoopback(client.id) && !tokensMatch(bearerFrom(req), config.computeToken)) {
      return sendError(res, 403, "model loading is restricted to the host or a token holder");
    }
    const body = await readJson(req);
    const model = String(body.model ?? "").trim();
    if (!isValidModelName(model)) return sendError(res, 400, "that is not a valid model name");

    // Validate the request before rate-limiting it, so a typo reports the typo
    // rather than a cooldown the caller then waits out for nothing.
    const installed = await ollama.models().catch(() => []);
    if (!installed.some((m) => m.name === model)) {
      return sendError(res, 404, `${model} is not installed on this machine`);
    }
    if (broker.pinnedModel === model) {
      return sendJson(res, 200, { pinned: model, note: "already resident" });
    }
    if (broker.mode === "compute") {
      return sendError(res, 409, "a compute lease holds the GPU; the model cannot be swapped until it ends");
    }
    const wait = broker.swapCooldownRemaining();
    if (wait > 0) {
      return sendError(res, 429, `a model was just loaded; wait ${Math.ceil(wait / 1000)}s before swapping again`, {
        retryAfter: Math.ceil(wait / 1000),
      });
    }

    broadcast("log", { level: "info", text: `${client.label} is loading ${model}...` });
    try {
      await broker.pinModel(model);
      broadcast("log", { level: "info", text: `${model} is now resident` });
      return sendJson(res, 200, { pinned: model });
    } catch (err) {
      broadcast("log", { level: "stderr", text: `load failed: ${err.message}` });
      return sendError(res, err.status ?? 502, err.message);
    }
  }

  if (pathname === "/api/models/pull" && method === "POST") {
    if (!config.pullEnabled) {
      return sendError(res, 403, "downloading models is disabled; start the server with --allow-pull");
    }
    if (config.lockModels && !isLoopback(client.id) && !tokensMatch(bearerFrom(req), config.computeToken)) {
      return sendError(res, 403, "downloading models is restricted to the host or a token holder");
    }
    const body = await readJson(req);
    const model = String(body.model ?? "").trim();
    if (!isValidModelName(model)) return sendError(res, 400, "that is not a valid model name");
    if (pullState.active) {
      return sendError(res, 409, `already downloading ${pullState.model}; one at a time`);
    }

    // Refuse before starting rather than filling the disk and failing midway.
    const free = await freeDiskGb();
    if (free !== null && free < config.minFreeDiskGb) {
      return sendError(res, 507, `only ${free.toFixed(1)} GB free; ShareGPU keeps ${config.minFreeDiskGb} GB in reserve`);
    }

    startPull(model, client.label);
    return sendJson(res, 202, { model, status: "started", note: "progress streams on /api/events as pull events" });
  }

  if (pathname === "/api/models/pull" && method === "DELETE") {
    if (!pullState.active) return sendJson(res, 200, { ok: false, note: "no download in progress" });
    pullState.controller?.abort();
    broadcast("log", { level: "stderr", text: `${client.label} cancelled the download of ${pullState.model}` });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/models/pull" && method === "GET") {
    return sendJson(res, 200, pullSnapshot());
  }

  // Bootstrap files for remote clients: a Pi can set itself up with one curl
  // rather than needing the repo. Only these two files are exposed, by name.
  if (pathname.startsWith("/client/") && method === "GET") {
    const CLIENT_FILES = {
      "/client/setup-pi.sh": path.join(ROOT, "clients", "pi", "setup-pi.sh"),
      "/client/sharegpu.py": path.join(ROOT, "clients", "sharegpu.py"),
    };
    const file = CLIENT_FILES[pathname];
    if (!file) return sendError(res, 404, "no such client file");
    try {
      const body = await fsp.readFile(file, "utf8");
      return sendText(res, 200, body, "text/plain; charset=utf-8");
    } catch {
      return sendError(res, 404, "client file is missing from the install");
    }
  }

  // ---- OpenAI-compatible surface
  if (pathname.startsWith("/v1/")) {
    const rate = consumeRate(client.id);
    if (!rate.ok) return sendError(res, 429, "rate limit exceeded", { retryAfter: rate.retryAfter });

    if (pathname === "/v1/models" && method === "GET") return oai.listModels(req, res);
    if (pathname === "/v1/chat/completions" && method === "POST") return oai.chatCompletions(req, res, client);
    if (pathname === "/v1/completions" && method === "POST") return oai.completions(req, res, client);
    if (pathname === "/v1/embeddings" && method === "POST") return oai.embeddings(req, res, client);
    return sendError(res, 404, `unsupported endpoint ${pathname}`);
  }

  // ---- native Ollama passthrough, allowlisted
  if (pathname.startsWith("/ollama/")) {
    const upstreamPath = pathname.replace(/^\/ollama/, "");
    if (!isSafeOllamaPath(upstreamPath)) {
      return sendError(res, 403, `${upstreamPath} is not exposed; model management stays on the host`);
    }
    const rate = consumeRate(client.id);
    if (!rate.ok) return sendError(res, 429, "rate limit exceeded", { retryAfter: rate.retryAfter });

    const body = method === "POST" ? await readJson(req) : undefined;
    const model = body?.model ?? broker.pinnedModel ?? "unknown";
    const heavy = upstreamPath === "/api/chat" || upstreamPath === "/api/generate" || upstreamPath.startsWith("/api/embed");

    const forward = async () => {
      const upstream = await ollama.raw(upstreamPath, { method, body, timeoutMs: config.requestTimeoutMs });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
      else res.end();
    };

    if (!heavy) return forward();

    const controller = new AbortController();
    req.on("close", () => controller.abort());
    let slot;
    try {
      slot = await broker.acquireLlm({ model, clientId: client.label, signal: controller.signal });
    } catch (err) {
      if (err.status === 499) return;
      return sendError(res, err.status ?? 503, err.message, { retryAfter: err.retryAfter });
    }
    try {
      await forward();
    } finally {
      slot.release();
    }
    return;
  }

  // ---- compute
  if (pathname.startsWith("/compute/")) return handleCompute(req, res, url, client);

  if (method === "GET") return serveStatic(res, pathname);
  return sendError(res, 404, "not found");
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress;

  if (!isAllowedAddress(remote)) {
    const entry = recordRejection(remote, req.url);
    const suggestion = suggestNetworkFor(remote);
    if (entry.count === 1) {
      // First refusal from an address is the one worth shouting about -- it is
      // almost always a VPN peer on a subnet nobody thought to allow.
      process.stdout.write(
        `refused ${entry.id} (not in ${describeAllowList().join(", ")})` +
          (suggestion ? ` -- allow it with: --allow ${suggestion}\n` : "\n"),
      );
      broadcast("log", {
        level: "stderr",
        text: `refused ${entry.id} -- not in the allow-list${suggestion ? `; add ${suggestion}` : ""}`,
      });
    }
    sendError(res, 403, `your address ${entry.id} is not in an allowed network`, {
      allowed: describeAllowList(),
      hint: suggestion ? `restart with --allow ${suggestion} to admit this address` : undefined,
    });
    return;
  }

  const client = identify(req);
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  // Same-origin dashboard plus arbitrary local tooling on the tunnel.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-sharegpu-lease, x-sharegpu-client, x-sharegpu-token");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await route(req, res, url, client);
  } catch (err) {
    if (res.writableEnded) return;
    sendError(res, err.status ?? 500, err.message ?? "internal error");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `port ${config.port} is already in use -- another ShareGPU is probably running.\n` +
        `  check with: ss -tlnp | grep ${config.port}\n` +
        `  or pick another port: node server.mjs --port ${config.port + 1}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`server error: ${err.message}\n`);
  process.exit(1);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

function ufwActive() {
  try {
    return execFileSync("systemctl", ["is-active", "ufw"], { timeout: 3000 }).toString().trim() === "active";
  } catch {
    return false;
  }
}

gpu.start();
providers.init(config.ollamaUrl).start();
providers.on("offline", (p) =>
  broadcast("log", { level: "stderr", text: `backend ${p.id} went offline: ${p.lastError}` }),
);
providers.on("change", () => broadcast("providers", providers.list().map((p) => ({
  id: p.id, name: p.name, online: p.online, enabled: p.enabled,
  modelCount: p.models.length, latencyMs: p.latencyMs, builtin: p.builtin, lastError: p.lastError,
}))));

server.listen(config.port, config.host, async () => {
  const token = ensureComputeToken();
  const lines = [
    `ShareGPU listening on http://${config.host}:${config.port}`,
    config.vpnMode
      ? `  allow-list: ${describeAllowList().join(", ")}`
      : "  loopback only -- pass --vpn to serve other devices",
    `  ollama:  ${config.ollamaUrl}`,
    `  budget:  ${usableVramMb()} MB shareable (${config.reservedVramMb} MB reserved for the desktop)`,
    `  compute: ${config.computeEnabled ? "ENABLED" : "disabled"}`,
  ];
  if (token) lines.push(`  compute token: ${token}`);

  // Printing the address other devices should actually type saves the usual
  // round of guessing, and the tailnet one is the answer more often than the
  // LAN one -- it works away from home.
  if (config.vpnMode) {
    lines.push("", "  Addresses other devices can use:");
    let tailnet = null;
    try {
      tailnet = execFileSync("tailscale", ["ip", "-4"], { timeout: 3000 })
        .toString()
        .trim()
        .split("\n")[0];
    } catch {
      /* tailscale is optional */
    }
    if (tailnet) lines.push(`    tailnet : http://${tailnet}:${config.port}`);
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family !== "IPv4" || addr.internal) continue;
        if (addr.address.startsWith("100.")) continue;
        lines.push(`    LAN     : http://${addr.address}:${config.port}  (${name})`);
      }
    }
    if (ufwActive()) {
      lines.push(
        "",
        "  ufw is active and drops incoming by default, so other devices",
        "  cannot reach this yet. Open it with:",
        "    ./scripts/allow_firewall.sh",
      );
    }
  }
  process.stdout.write(lines.join("\n") + "\n");

  const runnerParallel = await detectRunnerParallelism();
  if (runnerParallel !== null && runnerParallel < config.maxConcurrentLlm) {
    process.stdout.write(
      `\n  WARNING: the runner has OLLAMA_NUM_PARALLEL=${runnerParallel}, so it serves\n` +
        `  ${runnerParallel} request(s) at a time no matter what this gateway allows.\n` +
        `  Concurrent callers will queue inside Ollama instead of sharing the\n` +
        `  resident model. To actually serve ${config.maxConcurrentLlm} at once, restart Ollama with\n` +
        `    OLLAMA_NUM_PARALLEL=${config.maxConcurrentLlm}\n` +
        `  (costs one KV cache per slot -- see the README's sizing note).\n`,
    );
  }

  if (config.pinnedModel) {
    process.stdout.write(`  warming ${config.pinnedModel}...\n`);
    await broker.pinModel(config.pinnedModel).catch((err) => {
      process.stdout.write(`  warm failed: ${err.message}\n`);
    });
    // Warming at boot should not make the first user wait out a cooldown.
    broker.resetSwapCooldown();
  }
});

const shutdown = async () => {
  process.stdout.write("\nShareGPU shutting down\n");
  for (const job of jobs.running()) job.kill("SIGTERM");
  if (broker.lease) await broker.releaseLease(broker.lease.id, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
