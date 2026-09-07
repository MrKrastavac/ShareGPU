const $ = (id) => document.getElementById(id);

const state = { server: null, gpu: null, broker: null, models: [], resident: [], clients: [], jobs: [] };

const fmtMb = (mb) => (mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const fmtMs = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
};
const ago = (ts) => (ts ? fmtMs(Date.now() - ts) + " ago" : "—");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function log(text, level = "info") {
  const box = $("log");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const row = document.createElement("div");
  row.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span><span class="${level}">${esc(text)}</span>`;
  box.appendChild(row);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderGpu() {
  const devices = state.gpu?.devices ?? [];
  if (devices.length === 0) {
    $("gpu-name").textContent = state.gpu?.error ?? "no GPU detected";
    return;
  }

  // With more than one card the pooled figure is what decides which models
  // fit, so that leads; the per-card breakdown sits underneath.
  const pooledTotal = devices.reduce((n, d) => n + (d.memoryTotalMb ?? 0), 0);
  const pooledUsed = devices.reduce((n, d) => n + (d.memoryUsedMb ?? 0), 0);
  const pooledFree = devices.reduce((n, d) => n + (d.memoryFreeMb ?? 0), 0);
  const hottest = devices.reduce((a, b) => ((a.temperatureC ?? 0) > (b.temperatureC ?? 0) ? a : b));
  const busiest = devices.reduce((a, b) => ((a.utilizationPct ?? 0) > (b.utilizationPct ?? 0) ? a : b));
  const power = devices.reduce((n, d) => n + (d.powerDrawW ?? 0), 0);
  const powerCap = devices.reduce((n, d) => n + (d.powerLimitW ?? 0), 0);

  $("gpu-name").textContent =
    devices.length === 1
      ? devices[0].name
      : `${devices.length} GPUs · ${fmtMb(pooledTotal)} pooled`;

  $("m-util").innerHTML = `${busiest.utilizationPct ?? "—"}<span class="unit">%</span>`;
  $("m-temp").innerHTML = `${hottest.temperatureC ?? "—"}<span class="unit">°C</span>`;
  $("m-power").innerHTML = `${Math.round(power)}<span class="unit">/${Math.round(powerCap)} W</span>`;

  const reserved = state.server?.reservedMb ?? 0;
  const usedPct = Math.min(100, (pooledUsed / (pooledTotal || 1)) * 100);
  const reservedPct = Math.min(100 - usedPct, (reserved / (pooledTotal || 1)) * 100);
  $("bar-used").style.width = `${usedPct}%`;
  $("bar-reserved").style.width = `${reservedPct}%`;
  $("lg-used").textContent = `${fmtMb(pooledUsed)} in use`;
  $("lg-reserved").textContent = `${fmtMb(reserved)} reserved for the desktop`;
  $("lg-free").textContent = `${fmtMb(pooledFree)} free`;

  const perCard = $("gpu-cards");
  if (devices.length > 1) {
    perCard.classList.add("on");
    perCard.innerHTML = devices
      .map((d) => {
        const pct = Math.round(((d.memoryUsedMb ?? 0) / (d.memoryTotalMb || 1)) * 100);
        return `<div class="gcard">
          <div class="gname">${esc(d.name)} <span class="gidx">#${d.index}</span></div>
          <div class="bar"><span class="used" style="width:${pct}%"></span></div>
          <div class="gmeta">${fmtMb(d.memoryUsedMb)} / ${fmtMb(d.memoryTotalMb)}
            · ${d.utilizationPct ?? 0}% · ${d.temperatureC ?? "—"}°C</div>
        </div>`;
      })
      .join("");
  } else {
    perCard.classList.remove("on");
    perCard.innerHTML = "";
  }

  const budget = state.broker?.budgetMb ?? 0;
  const largest = state.models.reduce((m, x) => Math.max(m, x.sizeMb ?? 0), 0);
  const spread = devices.length > 1
    ? " Models are split across cards layer by layer, so capacity adds up but speed does not."
    : "";
  $("budget-note").textContent = largest
    ? `${fmtMb(budget)} shareable. Largest installed model is ${fmtMb(largest)}.${spread}`
    : `${fmtMb(budget)} shareable.${spread}`;
}

function renderBroker() {
  const b = state.broker;
  if (!b) return;
  const el = $("mode");
  el.className = `mode ${b.mode}`;
  el.textContent = b.mode === "llm" ? "serving models" : b.mode === "compute" ? "compute lease" : "switching";

  $("m-active").textContent = `${b.llm.active.length}/${b.llm.capacity}`;
  $("m-queued").textContent = b.llm.queued.length;
  $("m-served").textContent = b.stats.served;
  $("m-swaps").textContent = b.stats.swaps;

  const rows = [
    ...b.llm.active.map(
      (s) => `<tr><td class="mono">${esc(s.clientId)}</td><td class="mono">${esc(s.model)}</td>
        <td class="num">${fmtMs(s.waitedMs)}</td><td class="num">${fmtMs(Date.now() - s.startedAt)}</td></tr>`,
    ),
    ...b.llm.queued.map(
      (q) => `<tr style="opacity:.6"><td class="mono">${esc(q.clientId)}</td><td class="mono">${esc(q.model)}</td>
        <td class="num">#${q.position} in queue</td><td class="num">${fmtMs(q.waitingMs)}</td></tr>`,
    ),
  ];
  $("active-rows").innerHTML = rows.join("") || `<tr><td colspan="4" class="empty">idle</td></tr>`;
  $("swap-note").textContent = b.stats.swaps > 0
    ? `${b.stats.swaps} model swap(s) so far. Each one reloads the weights from disk — pin a single model if this climbs.`
    : "";

  // lease
  const lease = b.lease;
  const queue = b.leaseQueue ?? [];
  if (lease) {
    $("lease-body").innerHTML = `
      <div class="metrics">
        <div class="metric"><div class="label">Holder</div><div class="value mono" style="font-size:14px">${esc(lease.clientId)}</div></div>
        <div class="metric"><div class="label">VRAM</div><div class="value">${fmtMb(lease.vramMb)}</div></div>
        <div class="metric"><div class="label">Remaining</div><div class="value">${fmtMs(lease.remainingMs)}</div></div>
        <div class="metric"><div class="label">Jobs</div><div class="value">${lease.jobs}</div></div>
      </div>
      ${lease.label ? `<div class="note">${esc(lease.label)}</div>` : ""}
      <div class="note">The LLM is evicted for the duration and reloaded on release.</div>`;
  } else if (queue.length) {
    $("lease-body").innerHTML =
      `<div class="note">Draining LLM traffic before granting:</div><table><tbody>` +
      queue.map((q) => `<tr><td class="mono">#${q.position} ${esc(q.clientId)}</td><td class="num">${fmtMb(q.vramMb)}</td><td class="num">${fmtMs(q.waitingMs)}</td></tr>`).join("") +
      `</tbody></table>`;
  } else {
    $("lease-body").innerHTML = state.server?.computeEnabled
      ? `<div class="empty">No lease held — the card is serving models.</div>`
      : `<div class="empty">Compute is disabled. Start with <code>--allow-compute</code> to enable leases.</div>`;
  }
}

/**
 * Populate the try-panel model list, defaulting to whatever is already
 * resident. Picking a different model here would force a multi-GB reload, so
 * the loaded one is offered first and the rest are marked with their cost.
 */
function renderTryModels() {
  const select = $("try-model");
  if (select.dataset.touched === "1" && select.value) return;
  const resident = new Set(state.resident.map((r) => r.name));
  const pinned = state.broker?.pinnedModel;
  const preferred = pinned ?? state.resident[0]?.name ?? null;
  select.innerHTML = state.models
    .map((m) => {
      const tag = resident.has(m.name) ? " — loaded" : m.name === pinned ? " — pinned" : ` — ${fmtMb(m.sizeMb)} load`;
      return `<option value="${esc(m.name)}"${m.name === preferred ? " selected" : ""}>${esc(m.name)}${tag}</option>`;
    })
    .join("");
}

function renderModels() {
  const residentNames = new Set(state.resident.map((r) => r.name));
  const pinned = state.broker?.pinnedModel;
  $("model-rows").innerHTML =
    state.models
      .map((m) => {
        const tags = [];
        if (residentNames.has(m.name)) tags.push(`<span class="pill resident">loaded</span>`);
        if (m.name === pinned) tags.push(`<span class="pill pinned">pinned</span>`);
        const isCurrent = m.name === pinned || residentNames.has(m.name);
        return `<tr>
          <td class="mono">${esc(m.name)}</td>
          <td class="num">${fmtMb(m.sizeMb)}</td>
          <td>${tags.join(" ") || "—"}</td>
          <td style="text-align:right"><button data-load="${esc(m.name)}"${isCurrent ? " disabled" : ""}>${
            isCurrent ? "Loaded" : "Load"
          }</button></td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="4" class="empty">no models found on the runner</td></tr>`;
}

function renderClients() {
  $("client-rows").innerHTML =
    state.clients
      .map(
        (c) => `<tr><td class="mono">${esc(c.id)}</td><td>${esc(c.name ?? "—")}</td>
          <td class="num">${c.requests}</td><td class="num">${ago(c.lastSeen)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4" class="empty">no clients yet</td></tr>`;

  // Refused peers are the single most useful thing to see when someone says
  // they cannot reach the gateway, so they get their own visible block rather
  // than being buried in the activity log.
  const rejected = state.rejected ?? [];
  const box = $("rejected");
  if (!rejected.length) {
    box.innerHTML = "";
    box.classList.remove("on");
    return;
  }
  box.classList.add("on");
  box.innerHTML =
    `<div class="warn-title">Refused ${rejected.length} address${rejected.length > 1 ? "es" : ""}</div>` +
    `<div class="tw"><table><thead><tr><th>Address</th><th class="num">Tries</th><th class="num">Last</th><th>Fix</th></tr></thead><tbody>` +
    rejected
      .map((r) => {
        const parts = String(r.id).split(".");
        const cidr = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
        return `<tr><td class="mono">${esc(r.id)}</td><td class="num">${r.count}</td>
          <td class="num">${ago(r.last)}</td>
          <td class="mono">${cidr ? `--allow ${esc(cidr)}` : "—"}</td></tr>`;
      })
      .join("") +
    `</tbody></table></div>` +
    `<div class="note">These reached the server but were not in the allow-list. Restart with the CIDR above (and open it in ufw) to admit them.</div>`;
}

function renderJobs() {
  $("job-rows").innerHTML =
    state.jobs
      .map((j) => {
        const dur = j.duration_ms ?? (j.started_at ? Date.now() - j.started_at : null);
        return `<tr><td class="mono">${esc(j.id.slice(0, 8))}</td><td class="mono">${esc(j.client)}</td>
          <td><span class="pill ${esc(j.status)}">${esc(j.status)}</span></td><td class="num">${fmtMs(dur)}</td></tr>`;
      })
      .join("") || `<tr><td colspan="4" class="empty">no jobs</td></tr>`;
  $("compute-note").textContent = state.server?.computeEnabled
    ? "Jobs run under a lease with the GPU attached. Output streams back over SSE."
    : "";
}

function renderAll() {
  renderGpu();
  renderConnect();
  renderTryModels();
  renderBroker();
  renderModels();
  renderClients();
  renderJobs();
  renderPull();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-load]");
  if (!button) return;
  const model = button.dataset.load;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Loading…";
  log(`loading ${model}…`);
  try {
    const res = await fetch("/api/models/load", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sharegpu-client": "dashboard" },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? res.statusText);
    log(`${data.pinned} is resident`);
    refresh();
  } catch (err) {
    log(`load failed: ${err.message}`, "stderr");
    button.disabled = false;
    button.textContent = previous;
  }
});

// ---------------------------------------------------------------- model pulls

function renderPull() {
  const box = $("pull-box");
  if (!state.server?.pullEnabled) {
    box.classList.remove("on");
    return;
  }
  box.classList.add("on");

  const pull = state.pull ?? {};
  const prog = $("pull-progress");
  if (!pull.active) {
    prog.classList.remove("on");
    $("pull-go").disabled = false;
    $("pull-note").textContent = pull.error
      ? `Last download: ${pull.error}`
      : "Downloads run in the background and do not touch the GPU. One at a time.";
    return;
  }

  prog.classList.add("on");
  $("pull-go").disabled = true;
  $("pull-bar").style.width = `${pull.percent ?? 0}%`;
  const done = pull.completed ? `${(pull.completed / 1e9).toFixed(1)} GB` : "";
  const total = pull.total ? ` / ${(pull.total / 1e9).toFixed(1)} GB` : "";
  $("pull-text").textContent = `${pull.model} — ${pull.status ?? ""} ${done}${total}`.trim();
  $("pull-note").textContent = pull.by ? `Started by ${pull.by}` : "";
}

$("pull-go")?.addEventListener("click", async () => {
  const model = $("pull-name").value.trim();
  if (!model) return;
  $("pull-go").disabled = true;
  try {
    const res = await fetch("/api/models/pull", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sharegpu-client": "dashboard" },
      body: JSON.stringify({ model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? res.statusText);
    $("pull-name").value = "";
  } catch (err) {
    log(`download failed: ${err.message}`, "stderr");
    $("pull-note").textContent = err.message;
    $("pull-go").disabled = false;
  }
});

$("pull-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("pull-go").click();
  }
});

$("pull-cancel")?.addEventListener("click", async () => {
  await fetch("/api/models/pull", { method: "DELETE" }).catch(() => {});
});

// -------------------------------------------------------------- connect card

const SNIPPETS = {
  sdk: (base, model) => `# pip install openai
from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="unused")

r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
    # Reasoning models think before answering. Turn it off for short replies,
    # or a small max_tokens gets spent entirely on the scratchpad.
    extra_body={"reasoning_effort": "none"},
)
print(r.choices[0].message.content)`,

  ui: (base, model) => `Open WebUI
  Settings -> Connections -> OpenAI API
    API Base URL : ${base}/v1
    API Key      : unused        (any non-empty string)

  Then pick "${model}" in the model list.

LibreChat / AnythingLLM / LM Studio clients
  Same two fields: base URL and any key.

Anything that speaks the OpenAI API works -- this is a
standard /v1 endpoint, not a lookalike.`,

  editor: (base, model) => `Continue  (.continue/config.json)
{
  "models": [{
    "title": "ShareGPU",
    "provider": "openai",
    "model": "${model}",
    "apiBase": "${base}/v1",
    "apiKey": "unused"
  }]
}

Aider
  aider --openai-api-base ${base}/v1 \\
        --openai-api-key unused \\
        --model ${model}

Cursor / any tool reading the environment
  export OPENAI_BASE_URL=${base}/v1
  export OPENAI_API_KEY=unused`,

  curl: (base, model) => `# Chat
curl ${base}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{
    "model": "${model}",
    "messages": [{"role":"user","content":"Hello"}],
    "reasoning_effort": "none"
  }'

# Stream it
curl -N ${base}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hi"}],"stream":true}'

# What is installed
curl ${base}/v1/models`,

  agents: (base, model) => `# Full OpenAI tool calling: arguments arrive as a JSON
# string and finish_reason is "tool_calls", so agent loops work unchanged.
import json
from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="unused")

tools = [{"type": "function", "function": {
    "name": "get_weather",
    "parameters": {"type": "object",
                   "properties": {"city": {"type": "string"}},
                   "required": ["city"]}}}]

messages = [{"role": "user", "content": "Weather in Perth?"}]

while True:
    r = client.chat.completions.create(
        model="${model}", messages=messages, tools=tools,
        extra_body={"reasoning_effort": "none"})
    msg = r.choices[0].message
    if not msg.tool_calls:
        print(msg.content)
        break
    messages.append(msg.model_dump(exclude_none=True))
    for call in msg.tool_calls:
        args = json.loads(call.function.arguments)
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": json.dumps(run_tool(call.function.name, args))})

# Also supported: response_format={"type":"json_object"},
# and extra_body={"num_ctx": 32768} for long tool outputs.`,

  compute: (base, model, token) => `# Take the whole GPU for work that is not an LLM.
# Needs the compute token -- ${token ? "yours is below" : "ask whoever runs this box for it"}.
${token ? `#   ${token}\n` : ""}# Copy clients/sharegpu.py from the server, then:

from sharegpu import ShareGPU

gpu = ShareGPU("${base}", token="...")

with gpu.lease(vram_mb=14000, label="training") as lease:
    lease.put_file("train.py")          # stage inputs
    job = lease.run("python train.py")  # output streams back live
    lease.get("checkpoint.pt", "./checkpoint.pt")

# The lease evicts the chat model, hands you the VRAM, and reloads it
# on release. Chat requests queue while you hold it, so let it go.

# Command line:
#   python sharegpu.py status
#   python sharegpu.py run "nvidia-smi" --vram-mb 8000`,
};

const TAB_NOTES = {
  sdk: "Any OpenAI client library works — this is a standard /v1 endpoint.",
  ui: "No account or key setup needed; reachability over the VPN is the authorisation.",
  editor: "Keep every editor pointed at the pinned model — a different one forces a multi-GB reload that everyone waits for.",
  curl: "Responses include sharegpu.queued_ms so you can see contention.",
  agents: "Verified end to end with the official SDK: chained tool calls, JSON mode, and multi-turn loops.",
  compute: "Arbitrary command execution on the host. Treat the token like an SSH key.",
};

let activeTab = "sdk";

function renderConnect() {
  const base = location.origin;
  const model = state.broker?.pinnedModel ?? state.resident[0]?.name ?? state.models[0]?.name ?? "qwen3:14b";
  $("c-base").textContent = `${base}/v1`;
  $("c-model").textContent = model;
  const token = state.server?.computeToken ?? null;
  $("c-snippet").querySelector("code").textContent = SNIPPETS[activeTab](base, model, token);
  $("c-note").textContent = TAB_NOTES[activeTab] ?? "";
  for (const button of document.querySelectorAll(".tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === activeTab));
  }
}

document.querySelector(".tabs")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  activeTab = button.dataset.tab;
  renderConnect();
});

/**
 * navigator.clipboard only exists in a secure context, and this page is served
 * over plain HTTP on a private address -- so the modern API is missing exactly
 * where the page is most used. Fall back to a hidden textarea.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  scratch.remove();
  return ok;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.querySelector(button.dataset.copy);
  if (!source) return;
  const ok = await copyText(source.textContent);
  const original = button.textContent;
  button.textContent = ok ? "Copied" : "Select it";
  button.classList.toggle("ok", ok);
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("ok");
  }, 1400);
});

// ------------------------------------------------------------------ try panel

const out = () => $("try-out");

async function sendTry() {
  const button = $("try-send");
  const model = $("try-model").value;
  const prompt = $("try-prompt").value.trim();
  if (!prompt || !model) return;

  button.disabled = true;
  $("try-stat").textContent = "waiting for a slot…";
  const box = out();
  box.classList.add("on");
  box.innerHTML = "";
  const think = document.createElement("span");
  think.className = "think";
  const body = document.createElement("span");
  box.append(think, body);

  const started = performance.now();
  let firstToken = null;
  let tokens = 0;

  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sharegpu-client": "dashboard" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        max_tokens: 512,
        reasoning_effort: $("try-think").checked ? "low" : "none",
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error?.message ?? `HTTP ${response.status}`);
    }
    $("try-stat").textContent = "streaming…";

    // Parse SSE by hand: EventSource cannot issue a POST.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        if (!frame.startsWith("data:")) continue;
        const payload = frame.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message);
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) think.textContent += delta.reasoning_content;
        if (delta.content) {
          if (firstToken === null) firstToken = performance.now() - started;
          tokens += 1;
          body.textContent += delta.content;
          box.scrollTop = box.scrollHeight;
        }
      }
    }

    const total = performance.now() - started;
    const rate = tokens > 1 && total > firstToken ? (tokens / ((total - firstToken) / 1000)).toFixed(1) : "—";
    $("try-stat").textContent = `first token ${fmtMs(firstToken ?? total)} · ${rate} tok/s`;
  } catch (err) {
    body.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    $("try-stat").textContent = "failed";
  } finally {
    button.disabled = false;
  }
}

$("try-send").addEventListener("click", sendTry);
$("try-model").addEventListener("change", (e) => { e.target.dataset.touched = "1"; });
$("try-prompt").addEventListener("keydown", (event) => {
  // Enter sends on a desktop keyboard; on a phone the on-screen Return should
  // insert a newline instead, so only fire when a modifier is held.
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    sendTry();
  }
});

function connect() {
  const source = new EventSource("/api/events");

  source.addEventListener("snapshot", (event) => {
    Object.assign(state, JSON.parse(event.data));
    $("api-base").textContent = `${location.origin}/v1`;
    renderAll();
    log("connected to ShareGPU");
  });
  source.addEventListener("gpu", (event) => {
    state.gpu = JSON.parse(event.data);
    renderGpu();
  });
  source.addEventListener("broker", (event) => {
    state.broker = JSON.parse(event.data);
    renderBroker();
  });
  source.addEventListener("job", (event) => {
    const line = JSON.parse(event.data);
    log(`[${line.job.slice(0, 8)}] ${line.text}`, line.stream === "stderr" ? "stderr" : "");
  });
  source.addEventListener("job:done", (event) => {
    const job = JSON.parse(event.data);
    log(`job ${job.id.slice(0, 8)} ${job.status}${job.exit_code != null ? ` (exit ${job.exit_code})` : ""}`);
    refresh();
  });
  source.addEventListener("pull", (event) => {
    state.pull = JSON.parse(event.data);
    renderPull();
    if (!state.pull.active && state.pull.status === "complete") refresh();
  });
  source.addEventListener("log", (event) => {
    const entry = JSON.parse(event.data);
    log(entry.text, entry.level);
    refresh();
  });
  source.onerror = () => {
    $("mode").className = "mode offline";
    $("mode").textContent = "reconnecting";
  };
}

async function refresh() {
  try {
    const res = await fetch("/api/status");
    Object.assign(state, await res.json());
    renderAll();
  } catch {
    /* the event stream will report the outage */
  }
}

connect();
setInterval(refresh, 10_000);
setInterval(renderBroker, 1000);
