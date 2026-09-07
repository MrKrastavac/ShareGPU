# Pooling multiple GPUs in Ollama on Windows

For running one Ollama across two or more cards **in the same machine**, so a
model larger than any single card can load. This is local pooling, not the
multi-machine federation described in the main README.

Ollama does most of this for you — the work is in the parts that are silent
when they go wrong.

---

## The short version

1. Confirm the driver sees every card: `nvidia-smi`
2. Set `OLLAMA_SCHED_SPREAD=1` in your **user** environment variables
3. **Fully quit Ollama from the system tray** and reopen it
4. Check with `ollama ps` that a large model's size exceeds one card

If `nvidia-smi` lists both cards, Ollama will already split layers across them
without any configuration. `OLLAMA_SCHED_SPREAD` only changes *when* it does:
by default the scheduler prefers to fit a model on one card and spills over
only when forced; with it set, models spread across everything available.

---

## Step 1 — check the driver sees both cards

```powershell
nvidia-smi
```

Every GPU you intend to use must be listed. If one is missing, **stop here** —
no amount of Ollama configuration will help.

The usual cause is a driver that does not support one of the cards. NVIDIA
splits support by architecture and by module type:

| Card generation | Notes |
| --- | --- |
| Turing (RTX 20xx) and newer | works on current drivers |
| Pascal (GTX 10xx), Maxwell, Volta | needs the **580** branch or older |

Mixing a Pascal card with an Ampere card means both must be on a branch that
still supports Pascal. On a machine where this was tested, a GTX 1080 Ti was
completely invisible until the driver was moved back to the 580 branch — the
card was seated and enumerated by the OS, but no driver had bound to it.

Check `lspci`-equivalent on Windows via Device Manager: a card present in
Device Manager but absent from `nvidia-smi` is a driver problem, not a
hardware one.

Ollama also skips any GPU below CUDA compute capability 5.0.

---

## Step 2 — set the environment variables

On Windows, Ollama reads these at startup from the **user** environment.

Settings → *Edit environment variables for your account*, or:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_SCHED_SPREAD", "1", "User")
```

| Variable | Value | What it does |
| --- | --- | --- |
| `OLLAMA_SCHED_SPREAD` | `1` | spread models across every GPU rather than fitting on one |
| `OLLAMA_KEEP_ALIVE` | `30m` | keep the model resident so callers do not pay a cold load |
| `OLLAMA_FLASH_ATTENTION` | `1` | lower memory use for attention |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | quantise the KV cache — roughly halves it |
| `OLLAMA_NUM_PARALLEL` | `1`–`4` | concurrent requests; **each one costs its own KV cache** |
| `OLLAMA_CONTEXT_LENGTH` | `16384` | context per slot |
| `OLLAMA_GPU_OVERHEAD` | bytes | reserve VRAM per GPU, e.g. for the desktop |

`CUDA_VISIBLE_DEVICES` restricts which cards Ollama may use — set it to
`0,1` to be explicit, or to a single index to keep a card free for something
else.

---

## Step 3 — restart Ollama properly

This is the step that silently defeats people.

**Closing the Ollama window does not restart it.** It keeps running in the
system tray, still holding the old environment. Right-click the tray icon →
**Quit Ollama**, then start it again. Confirm with:

```powershell
Get-Process ollama -ErrorAction SilentlyContinue
```

Nothing should be listed before you relaunch.

---

## Step 4 — verify it actually pooled

```powershell
ollama run <a-model-larger-than-one-card>
ollama ps
nvidia-smi
```

`ollama ps` reports the resident size. `nvidia-smi` shows the per-card split —
you should see memory in use on **both** cards. If everything landed on one,
either the model fits on that card alone (expected without
`OLLAMA_SCHED_SPREAD`), or the second card is not visible to Ollama.

---

## What pooling does and does not buy you

**VRAM adds up. Speed does not.**

llama.cpp splits a model's *layers* across cards — a pipeline, not tensor
parallelism. Each layer lives wholly on one GPU and activations hop over PCIe.
That traffic is small, so no NVLink is needed and PCIe width is not the
bottleneck. But token generation is memory-bandwidth bound, so a pool runs at
roughly the weighted average of its cards.

Measured on a 3090 (936 GB/s) + 1080 Ti (484 GB/s) pool:

| Model | Alone on the 3090 | Spread across both |
| --- | --- | --- |
| 14B dense | 56.7 tok/s | 45.5 tok/s |

**Pooling is a win when a model does not fit on the biggest card, and a loss
when it does.** Turn `OLLAMA_SCHED_SPREAD` off when you are back on a model
that fits.

A mismatched pair is gated by the slower card for the layers it holds. Two
identical cards pool much more gracefully than a fast one plus an old one.

---

## Sizing: the arithmetic that decides what loads

Budget is not simply the sum of the cards.

```
usable = (sum of VRAM) - (desktop/compositor) - (compute buffers) - (KV cache)
```

- **Desktop** — measured at ~2 GB on a Windows/KDE-class desktop with a browser
  and a few apps. It grows as you open things. On Windows, WDDM also reserves
  a slice of the display GPU.
- **Compute buffers** — roughly 1 GB.
- **KV cache** — `OLLAMA_CONTEXT_LENGTH` is allocated **per slot**, so
  `NUM_PARALLEL=4` multiplies it by four. This is the one people miss.

Measured for a 14B at 32k context with `q8_0` KV:

| Slots × context | Resident | Free (of 35 GB) |
| --- | --- | --- |
| 1 × 32k | 11.5 GB | ~10 GB |
| 4 × 32k | 19.9 GB | 1.3 GB — too tight |
| 4 × 16k | 14.2 GB | ~7 GB |

Leave at least 1.5–2 GB spare. A model that loads with 0.5 GB free will run
until you open a few browser tabs, then fail mid-request.

---

## Troubleshooting

**A card is in Device Manager but not `nvidia-smi`** — driver does not support
it. Check the architecture table above.

**Both cards visible, but models only use one** — `OLLAMA_SCHED_SPREAD` is not
set, or Ollama was not fully quit from the tray after setting it.

**A model that should fit will not load** — you are almost certainly paying
`NUM_PARALLEL ×` the KV cache. Drop to 1 slot, or lower the context length.

**It loads but is slower than one card** — expected if the model fits on the
faster card alone. That is the pooling trade, not a fault.

**Out of memory partway through a session** — the margin was too thin for
desktop growth. Reduce context, slots, or use `OLLAMA_GPU_OVERHEAD`.

---

## A note on what was verified where

The environment variables, layer-splitting behaviour, sizing arithmetic and
measured throughput figures come from a working two-GPU Ollama install on
Linux, where the same llama.cpp scheduler and the same variables apply.

The Windows-specific parts — user-scope environment variables, the tray-quit
restart, WDDM's display reservation — are documented from Ollama's Windows
behaviour and have **not** been re-tested on a Windows box here. If something
in that column does not match what you see, trust your machine over this page.
