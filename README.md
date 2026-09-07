# ShareGPU

Share one GPU with everyone on your WireGuard VPN — as an OpenAI-compatible LLM
endpoint, and as a leasable card for raw compute — without the two colliding.

![The ShareGPU dashboard](docs/dashboard.png)

*The dashboard: pooled VRAM across both cards with a per-card breakdown, live
queue depth, the model library with one-click loading, and a download in
progress. The Connect panel at the top hands any client its setup.*

<p align="center">
  <img src="docs/connect.png" width="49%" alt="Connect panel, agents tab">
  <img src="docs/mobile.png" width="24%" alt="Dashboard on a phone">
</p>

*Left: ready-to-paste setup for six kinds of client. Right: the same dashboard
on a phone -- single column, touch sized, and it works over the VPN.*

## Contents

| | |
| --- | --- |
| [Setup](#setup) | install and run it |
| [Serving the VPN](#serving-the-vpn) | firewall, allow-lists, reaching it from a phone |
| [Using it — chat](#using-it--chat) | the OpenAI-compatible endpoint |
| [Agentic work](#agentic-work) | tool calling, and what actually matters for agents |
| [Using it — raw compute](#using-it--raw-compute) | leasing the whole card for non-LLM work |
| [Adding other machines](#adding-other-machines-and-windows) | federating Windows/macOS/Linux GPUs |
| **[Pooling cards in one machine](#pooling-several-cards-in-one-machine)** | **multi-GPU Ollama — [Linux](docs/linux-multi-gpu.md) · [Windows](docs/windows-multi-gpu.md)** |
| [Running models bigger than one card](#running-models-bigger-than-one-card) | pooling, driver swaps, sizing |
| [Dashboard](#dashboard) | what the web UI does |
| [Options](#options) | every flag |

## The constraint this is built around

The machine has a single RTX 3090: 24 GB total, of which the desktop session
(KDE, browsers, ComfyUI) permanently holds 2–3 GB. That leaves roughly **21 GB
to share**, and the installed models are 9–19 GB each.

So only one large model fits at a time. "Let VPN users fully use the GPU" cannot
mean handing each peer a slice of the card — there is no room. What it means
here:

- **Chat is multiplexed, not duplicated.** One model stays resident and every
  concurrent request runs against those same weights. Each extra user costs KV
  cache — a few hundred MB — not another 19 GB copy. That is what makes many
  simultaneous users affordable.
- **Model switching is the enemy.** If one peer asks for `qwen3.5` while another
  is using `glm-4.7`, the runner evicts and reloads 19 GB from disk. Under
  alternating traffic the card spends its life loading rather than generating.
  ShareGPU serialises swaps deliberately: a request for a different model waits
  for the current one to drain instead of interleaving.
- **Raw compute takes the whole card.** A caller's PyTorch job and a resident
  19 GB LLM cannot coexist. Compute runs under an exclusive *lease*: the LLM is
  evicted, the lease holder gets the VRAM, and the model is reloaded on release.

The broker in [`src/broker.mjs`](src/broker.mjs) is what enforces all of this.

## What a remote GPU can and cannot be

There is no practical, safe way to make this GPU appear as `/dev/nvidia0` on a
peer's machine. CUDA-over-IP projects (rCUDA and its descendants) are
effectively abandoned and do not support a modern CUDA 13 stack. Anyone
promising a "remote local GPU" over a tunnel is describing something that does
not exist in usable form.

What works — and is how every cloud GPU is actually used — is that **the harness
ships the work, not the driver call**:

- For LLM work, the peer's tooling points at this box's OpenAI endpoint. Nothing
  else changes.
- For everything else, the peer leases the card, uploads what it needs, runs a
  command, and streams the output back. From the harness's point of view that is
  a remote GPU, and it is exactly the shape of a cloud GPU job.

## Setting up a remote client (Raspberry Pi, laptop, anything)

From the machine that will use the GPU:

```bash
curl -fsSL http://<server>:8770/client/setup-pi.sh | bash
```

It finds the server (tailnet address first, then LAN), lists what models are
installed, picks a default, writes config for whichever harnesses are present
(aider, Continue, plus `OPENAI_BASE_URL`/`OPENAI_API_KEY` in
`~/.config/sharegpu/env` sourced from `.bashrc`), downloads the Python client,
and then proves it works by sending a real prompt. Re-runnable.

The model it picks is deliberate: a **coding-specialised model that is already
resident** beats a bigger one that has to cold-load. A coding harness makes many
sequential tool calls, so per-call latency compounds every turn -- and a model
big enough to force `OLLAMA_NUM_PARALLEL=1` makes every other device on the VPN
queue behind it. Size is the wrong axis to optimise for agent work.

Only `setup-pi.sh` and `sharegpu.py` are served under `/client/`, by exact name.

## Adding other machines (and Windows)

Any machine running Ollama can join the pool. It does **not** run ShareGPU --
it just runs Ollama and lets the gateway reach it, which is why Windows and
macOS machines can contribute a GPU without any of this project's
Linux-specific parts being ported.

On the machine joining:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File clients/windows/join-pool.ps1 -Gateway http://gpu-box:8770
```

```bash
# Linux / macOS -- the same two steps by hand
OLLAMA_HOST=0.0.0.0:11434 ollama serve
curl -X POST http://gpu-box:8770/api/providers \
  -H 'content-type: application/json' \
  -d '{"url":"http://this-machine:11434","name":"studio-pc"}'
```

Or paste the URL into **Add a machine** on the dashboard.

### Why routing rather than pooling

llama.cpp can genuinely pool VRAM across hosts with its RPC backend, so a
model larger than any single machine becomes possible. The cost is that every
token's activations cross the network, and on Ethernet that dominates -- you
buy capacity and pay for it in latency on every request.

Federating instead keeps each model wholly on one host and routes whole
requests. A second machine then adds throughput and capacity without adding
per-token latency, and one slow machine cannot drag down requests that are not
using it.

The trade is explicit: **pooling raises the ceiling on model size, federation
raises throughput and availability.** Within one machine ShareGPU still pools
across cards, because there the interconnect is PCIe rather than Ethernet.

### How a request is placed

A backend that already holds the model wins outright -- a cold load is several
GB off disk, which dwarfs any queueing difference. Among equals it prefers the
local machine (no network hop), then the lowest measured round-trip.

Backends are health-checked every 15 seconds. One that goes away stops
receiving traffic and its models leave the catalogue; one that comes back
rejoins on its own. That is what makes a GPU effectively hot-pluggable: the
unit of hot-plugging is a machine, not a card.

Responses carry `sharegpu.provider` (and an `X-ShareGPU-Provider` header) so a
client can see which machine served it.

## Pooling several cards in one machine

Different job from federation, and it does not involve ShareGPU at all -- it is
Ollama and driver configuration. Full guides with sizing arithmetic, measured
throughput and troubleshooting:

- **[Linux](docs/linux-multi-gpu.md)** -- written from a verified two-GPU build,
  including the driver swap and the DKMS/`depmod` step that decides whether the
  machine comes back with a display
- **[Windows](docs/windows-multi-gpu.md)**

The short version:

1. **`nvidia-smi` must list every card.** If one is missing, stop -- no Ollama
   setting fixes a driver that has not bound to the card. Pascal (GTX 10xx) and
   older need the 580 driver branch; the open kernel module supports Turing and
   newer only.
2. **Set `OLLAMA_SCHED_SPREAD=1`.** Without it the scheduler fits a model onto
   one card and only spills over when forced. On Linux that is an
   `Environment=` line in the systemd unit; on Windows a *user* environment
   variable.
3. **Restart Ollama so it actually picks the change up.** On Linux that means
   `systemctl daemon-reload` *then* restart -- restarting alone keeps the old
   environment. On Windows, quit from the system tray; closing the window does
   not restart it.
4. **Verify** with `ollama ps` and `nvidia-smi` that memory is in use on *both*
   cards.

Two things worth knowing before you bother:

- **VRAM adds up, throughput does not.** Layers are split across cards, so the
  pool runs at roughly the weighted average of its members. Measured on a
  3090 + 1080 Ti: a 14B model ran **56.7 tok/s** on the 3090 alone and
  **45.5 tok/s** spread across both. Pool when a model does not fit on the
  biggest card; do not when it does.
- **`OLLAMA_CONTEXT_LENGTH` is allocated per slot**, so `NUM_PARALLEL=4`
  multiplies your KV cache by four. That is the usual reason a model that
  "should fit" refuses to load.

## Running models bigger than one card

llama.cpp, inside Ollama, splits a model's **layers** across GPUs -- a pipeline,
not tensor parallelism. Each layer lives wholly on one card and activations hop
over PCIe between them. That traffic is small, so no NVLink is needed and PCIe
width is not the bottleneck.

The consequence worth internalising: **VRAM adds up, throughput does not.**
Decode is memory-bandwidth bound, so a pool runs at roughly the weighted
average of its cards. Pooling wins when a model does not fit on the biggest
card alone, and loses when it does.

```bash
./scripts/enable-second-gpu.sh      # dry run: what is bound, what would change
./scripts/enable-second-gpu.sh --apply
# reboot, confirm nvidia-smi lists both, then:
./scripts/pool-gpus.sh --apply
```

`enable-second-gpu.sh` exists because a Pascal card (GTX 1080 Ti) cannot run on
the current driver for two independent reasons: the *open* kernel module needs
GSP firmware that only Turing and newer have, and driver branch 610 dropped
Pascal support entirely. Both cards can only coexist on the proprietary 580
branch, which still covers Ampere and CUDA 13. The script swaps the driver in a
single transaction, refuses to run without kernel headers, warns if sshd is not
running, and has a `--rollback`.

`pool-gpus.sh` sets `OLLAMA_SCHED_SPREAD=1`. Without it the scheduler prefers
to fit a model on one card and only spills over when forced; with it, models
are spread across every GPU, which is what you want when the goal is capacity.

ShareGPU reads the pool automatically -- `totalVramMb` defaults to whatever the
driver reports across all devices, the dashboard shows pooled VRAM with a
per-card breakdown underneath, and compute jobs see every GPU unless a lease
narrows `CUDA_VISIBLE_DEVICES` to specific indices.

### Pool or partition

Two mismatched cards can be used two ways, and the better choice depends on
what you are short of:

- **Pool** when you need a model that does not fit on the big card. A 24 GB +
  11 GB pool reaches ~32B at q6 or ~70B at q3; a 70B at q4_K_M is ~42 GB and
  still will not fit.
- **Partition** when you are short of *speed*, not capacity: put the displays
  and image generation on the small card and leave the big one headless for the
  LLM. That reclaims the VRAM the desktop session holds and removes the
  contention the broker otherwise has to work around.

## Desktop shortcuts

```bash
./scripts/install-desktop.sh
```

This puts **ShareGPU** and **Stop ShareGPU** on the desktop and in the
application menu. Re-run it after moving the project so the paths are rewritten.

The launcher starts the server detached, waits for it to answer, and opens the
dashboard; running it again when it is already up just reopens the tab rather
than restarting the server underneath someone's request. Right-click it for:

| Action | Does |
| --- | --- |
| *Start without compute or downloads* | serves the VPN, chat and model loading only |
| *Start on this machine only* | loopback, nothing exposed |
| *Stop ShareGPU* | releases any lease, kills its jobs, stops the gateway |
| *Stop and free the GPU* | the above, then unloads Ollama's weights |
| *Why can a device not connect?* | runs `diagnose.sh` in a terminal |
| *Open the firewall* | runs `allow_firewall.sh` |
| *Open the startup log* | `.sharegpu/app.log` |

The plain icon starts with compute and downloads enabled. Edit `Exec=` in
`desktop/sharegpu.desktop.in` and re-run the installer to change that.

Two things the stop script is careful about. It only signals a `node` process
whose argv actually resolves to *this checkout's* `server.mjs`, checked through
`/proc` -- matching the command line alone would also catch an editor or a grep
that merely mentions the filename. And it leaves Ollama running, because Local
Media Gen and MusicGen share that same runner; `--free-gpu` unloads the weights
but never stops the service.

## Setup

Requires Node 20+ (Node 26 here) and a running Ollama on loopback.

```bash
npm start                  # loopback only, chat endpoints, no compute
```

Open <http://127.0.0.1:8770> for the dashboard.

### Serving the VPN

Following the same rules as Local Media Gen: everything binds `127.0.0.1` by
default, and Ollama stays on loopback — peers reach it only through this
gateway's proxy, never directly.

```bash
./scripts/launch.sh --vpn --allow 192.168.0.0/24        # narrow this to your own range
```

Then open the firewall, the same way the other apps here do it:

```bash
./scripts/allow_firewall.sh          # --remove undoes it
```

That allows the port on the LAN and everything on `tailscale0`.

**Use the tailnet address from a phone.** The startup banner prints it. A
Tailscale peer arrives from `100.64.0.0/10`, never as a LAN address, so the
allow-list covers that range by default -- narrowing it to only the LAN subnet
is what refuses phones. Tailscale is the better path anyway: encrypted, limited
to your own devices, and it works away from home.

If a peer cannot reach it, run:

```bash
./scripts/diagnose.sh
```

It answers the only question that matters -- are the peer's packets arriving?
ShareGPU logs every refused source address, so if the peer appears under
"peers refused" the packets got here and the allow-list is the problem (the
script prints the exact `--allow` CIDR to use). If nothing appears, the block is
below ShareGPU: ufw, or a tunnel whose `AllowedIPs` does not route this LAN.

**Never bind this to a public interface.** The gateway has no user accounts;
reachability *is* the authorisation for chat, exactly as in Local Media Gen.

## Using it — chat

Any OpenAI-compatible client works. Point it at `http://<host>:8770/v1` with any
API key string.

```bash
curl -X POST http://gpu-box.local:8770/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:14b","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://gpu-box.local:8770/v1", api_key="unused")
client.chat.completions.create(model="qwen3:14b", messages=[...])
```

Works with Open WebUI, Continue, Cursor, LibreChat, Aider, and anything else
that speaks the OpenAI API.

Notes:

- `/v1/models` reports each model's size and whether it is pinned, so a client
  can see what a swap would cost before asking for one.
- Reasoning models (qwen3, glm) return their scratchpad in `reasoning_content`.
  Set `"reasoning_effort": "none"` to turn thinking off — without it a short
  `max_tokens` can be spent entirely on reasoning and return empty content.
- Responses carry `sharegpu.queued_ms` so a client can see contention.
- `429` means the per-client rate limit; `503` means the queue is full; both
  carry `Retry-After`.

### Agentic work

The endpoint is a real OpenAI tool-calling surface, verified end to end with the
official SDK: a multi-turn loop that calls two tools in sequence and produces a
final answer. Three translations are done explicitly because getting any of them
wrong breaks agent frameworks in ways that are hard to debug:

- `tool_calls[].function.arguments` is a **JSON-encoded string**, as the spec
  requires. Ollama returns an object; every SDK calls `JSON.parse` on it.
- Each call carries `type: "function"` and a top-level `index`.
- `finish_reason` is `tool_calls` when the model asks for a tool. A loop that
  branches on this would otherwise treat a tool request as a finished answer.

The inbound direction is normalised too, so replaying an assistant turn whose
arguments are a string works without the caller converting anything.

`response_format: {"type": "json_object"}` maps to the runner's JSON mode, and
`num_ctx` can be set per request (or `--ctx` server-wide) when long tool outputs
threaten the context window.

Rate limits default to 120 burst / 600 per minute per client. Agent loops fire
many small calls, and a `429` mid-loop is far more destructive than a slightly
longer queue -- the GPU queue is the real backpressure, so the limiter exists
only to catch a runaway.

#### The parallelism ceiling

`OLLAMA_NUM_PARALLEL` on the runner, not this gateway's `--concurrency`, decides
how many requests are actually served at once. With the default of `1`, Ollama
serialises everything: concurrent agents pass this gateway's gate and then queue
*inside the runner*, which looks like unexplained latency. ShareGPU detects the
mismatch and warns at startup.

To genuinely serve several agents at once, restart Ollama with
`OLLAMA_NUM_PARALLEL=4`. The cost is one KV cache per slot, which is the only
thing that scales with concurrent users:

Measured on this box with qwen3:14b and `OLLAMA_KV_CACHE_TYPE=q8_0`:

| slots x context | resident VRAM | free for everything else |
| --- | --- | --- |
| 1 x 32k | 11.5 GB | ~10 GB |
| 4 x 32k | 19.9 GB | **1.3 GB -- too tight** |
| 4 x 16k | 14.2 GB | ~7 GB |

`OLLAMA_CONTEXT_LENGTH` is allocated *per slot*, so raising parallelism
multiplies it. Four slots at the full 32k leaves so little headroom that
ComfyUI cannot generate an image while the model is warm -- which matters here,
because Local Media Gen shares this same runner. Four slots at 16k is the
balance this machine is set to.

A 27B model has no room for four slots at any useful context; pin the 14B for
agent work and keep the larger models for single-user chat.

Concurrency buys throughput, not linear scaling -- one GPU is compute-bound, so
batching four requests measured 1.5x the sequential rate rather than 4x. The
win over `NUM_PARALLEL=1` is real, though: that serialises, so concurrent and
sequential are identical by construction.

#### One model at a time still applies

Agents that each want a different model are the worst case for a single card --
every alternation reloads multi-GB weights. Point every agent at the pinned
model, or accept that the broker will serialise them.

### What is deliberately not exposed

The native Ollama API is proxied at `/ollama/*` but allow-listed to read and
inference paths only. `/api/delete`, `/api/pull`, `/api/create` and `/api/push`
are all blocked there. Raw Ollama on a tunnel would let any peer erase the local
model library or fill the disk.

Downloading is instead available through `/api/models/pull` when `--allow-pull`
is set, which is the same capability with the guards described above. **Deleting
is never exposed by any route** -- an 87 GB library is far easier to destroy than
to rebuild, and nothing about sharing a GPU requires remote deletion.

## Using it — raw compute

Off unless explicitly enabled, because it runs caller-supplied commands:

```bash
./scripts/launch.sh --vpn --allow 192.168.0.0/24 --allow-compute
```

The launcher generates a token in `.sharegpu/compute.token` and reuses it across
restarts. Every compute call needs it as a bearer token — the subnet gate alone
is not what should stand between a stray host and command execution.

From a peer, using [`clients/sharegpu.py`](clients/sharegpu.py):

```python
from sharegpu import ShareGPU

gpu = ShareGPU("http://gpu-box.local:8770", token="...")

with gpu.lease(vram_mb=16000, label="train run") as lease:
    lease.put_file("train.py")
    job = lease.run("python train.py --epochs 3")   # output streams live
    lease.get("checkpoint.pt", "./checkpoint.pt")
```

`lease()` blocks until in-flight chat traffic has drained and the requested VRAM
is genuinely free — measured on the card, not assumed from the unload call
returning. The context manager heartbeats in the background and releases on
exit, including on exception.

There is also a CLI:

```bash
python clients/sharegpu.py status
python clients/sharegpu.py ask "summarise this repo"
python clients/sharegpu.py run "nvidia-smi" --vram-mb 8000
```

### Lease semantics

- One lease at a time; further requests queue, and chat is frozen while a lease
  is pending so the card can actually drain.
- A lease dies on expiry (default 15 min, extendable) or after three missed
  heartbeats, so a peer that drops off the VPN cannot hold the GPU hostage.
- When a lease ends its jobs are killed as a process group — an orphaned python
  holding VRAM would block the model reload.
- The workspace belongs to the lease, so successive jobs share files. Artifacts
  remain downloadable after release until the retention sweep (24h).
- Jobs get a scrubbed environment: no inherited server variables (the compute
  token is not visible to jobs), and `LD_PRELOAD`-style overrides are stripped.

### The honest security position

With `--allow-compute`, anyone who has both VPN access and the token can run
arbitrary commands as your user on this desktop. Path traversal is blocked and
the environment is scrubbed, but this is **not a sandbox** — a job could read
your home directory. Treat the token as a shell credential. If you need to hand
compute to someone you would not give a shell to, run the server as a dedicated
unprivileged user with its own home, or put jobs in containers.

Chat endpoints carry no such risk and can be left open to the VPN freely.

## Dashboard

<http://127.0.0.1:8770> -- or the box's VPN address from any peer -- shows live
VRAM and utilisation, the current mode, which model is resident, in-flight and
queued requests with their wait times, lease state, per-client request counts,
job history, and a running activity log. Models can be pinned from here (host or
token holders only) to keep one resident and avoid cold loads.

Two panels make it self-serve for anyone you point at it:

**Connect** shows the API base, the key to use (any string), and the model to
ask for, each with a copy button, plus ready-to-paste setup for the Python SDK,
Open WebUI, Continue/Aider/Cursor, curl, agent loops, and raw GPU leases. The
snippets are filled in with this server's real address and pinned model, so
there is nothing to substitute by hand. The compute token appears there **only
when the dashboard is opened on the host itself** -- it is a shell credential,
and the dashboard is readable by everyone on the VPN.

**Models** lists what is installed with a `Load` button on each. Loading is open
to anyone on the VPN by default -- it is disruptive but recoverable, and the
point of the dashboard is that people can serve themselves. `--lock-models`
puts it back behind the host or a token. Three things stop it being abused:
a swap is refused while a compute lease holds the card, a cooldown
(`--swap-cooldown`, 45s) stops two people racing the buttons and thrashing
multi-GB reloads, and simultaneous loads join the in-flight one rather than
starting a second.

With `--allow-pull`, that panel also downloads new models by name (`qwen3:8b`,
`hf.co/user/repo:quant`) with a live progress bar attributed to whoever started
it. Pulling is off by default because it writes to the model library and can
fill the disk -- a different class of risk from loading something already
present. It is guarded by a name validator (registry references only), a size
cap (`--pull-max-gb`, 60), a free-space floor checked before starting
(`--min-free-gb`, 25), and a one-at-a-time lock. Deleting models is still not
exposed at all; that stays on the host.

**Try it from this device** sends a real prompt through
`/v1/chat/completions` and streams the reply back with first-token latency and
tokens per second -- the quickest way to confirm the endpoint works from the
device in someone's hand before they configure a real client.

The layout is single-column and touch-sized on a phone, so a peer can check
whether the GPU is busy before queueing work. Inputs use a 16px font because
anything smaller makes iOS Safari zoom the page on focus.

## Layout

| Path | Role |
| --- | --- |
| [`server.mjs`](server.mjs) | HTTP routing, access gate, static serving |
| [`src/broker.mjs`](src/broker.mjs) | GPU arbitration: modes, slots, queues, leases |
| [`src/openai.mjs`](src/openai.mjs) | OpenAI-compatible translation over Ollama |
| [`src/compute.mjs`](src/compute.mjs) | Lease workspaces and the job runner |
| [`src/access.mjs`](src/access.mjs) | CIDR allow-list, tokens, rate limiting |
| [`src/gpu.mjs`](src/gpu.mjs) | `nvidia-smi` polling |
| [`src/ollama.mjs`](src/ollama.mjs) | Runner client with the destructive paths walled off |
| [`clients/sharegpu.py`](clients/sharegpu.py) | Peer-side library and CLI |

## Options

```
--vpn                 bind 0.0.0.0 instead of loopback
--port <n>            listen port (default 8770)
--allow <cidr,...>    networks allowed through
--model <name>        model to keep resident and warm at startup
--concurrency <n>     concurrent requests sharing the resident model (default 4)
--reserve <mb>        VRAM left to the desktop session (default 1536)
--allow-compute       enable the lease and job runner
--compute-token <s>   token for compute callers
--lease <ms>          default lease length (default 15m)
```

Anything settable by flag is also settable by env var (`SHAREGPU_*`) or in
`.sharegpu/config.json`.

## Tests

```bash
npm test
```

Covers the parts where a bug is a security hole: CIDR matching (including the
IPv4-mapped-IPv6 bypass), token comparison, rate-limit isolation, workspace path
traversal, and NDJSON stream framing.
