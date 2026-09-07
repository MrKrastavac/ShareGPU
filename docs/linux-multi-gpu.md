# Pooling multiple GPUs in Ollama on Linux

Running one Ollama across two or more cards in the same machine, so a model
larger than any single card can load. **No ShareGPU involved** — this is Ollama
and driver configuration only.

Most of the work is in step 1. Once the driver has bound to every card, Ollama
splits layers across them with almost no configuration.

Everything below was verified on a working two-GPU box (RTX 3090 24 GB +
GTX 1080 Ti 11 GB, CachyOS, kernel 7.1, Ollama 0.32).

---

## 1. Make the driver see every card

```bash
nvidia-smi                      # what the driver has bound
lspci | grep -i vga             # what is physically present
```

**If a card appears in `lspci` but not `nvidia-smi`, stop here.** No Ollama
setting will help — no driver is attached to it. Check which:

```bash
lspci -k -s 17:00.0 | grep "Kernel driver in use"
```

A card with no `Kernel driver in use` line is unbound. Two independent causes,
both of which bit this machine:

### The open kernel module only supports Turing and newer

NVIDIA's open modules (`nvidia-open`, `linux-*-nvidia-open`) need GSP firmware,
which exists on Turing (RTX 20xx) and later. Pascal, Maxwell and Volta cannot
bind to them at all. Check what you are running:

```bash
cat /proc/driver/nvidia/version
```

`NVIDIA UNIX Open Kernel Module` means open; you need the proprietary module
for an older card.

### Driver branches drop old architectures

The 580 branch is the last one supporting Maxwell, Pascal and Volta. Anything
newer will not drive a GTX 10xx card, open module or not. Distributions package
these as legacy — on Arch/CachyOS, `nvidia-580xx-dkms`.

So mixing a 1080 Ti with a 3090 means **both** on the proprietary 580 branch.
It still supports Ampere and CUDA 13.

### Swapping the driver, safely

```bash
sudo pacman -Rdd linux-cachyos-nvidia-open nvidia-utils      # remove open
sudo pacman -S nvidia-580xx-dkms nvidia-580xx-utils          # install legacy
```

Then — and this is the part that turns a driver swap into a black screen —
**verify before rebooting**:

```bash
# DKMS builds only for the RUNNING kernel by default. Every installed kernel
# needs a module, or your fallback kernel is not a fallback.
for k in $(ls /usr/lib/modules | grep -v extramodules); do
  [ -d "/usr/lib/modules/$k/build" ] || continue
  sudo dkms install nvidia/580.178.04 -k "$k" --force
  sudo depmod -a "$k"
done

# depmod is what makes them findable. Without it the modules exist on disk and
# modinfo still cannot see them, and the initramfs is built without them.
for k in $(ls /usr/lib/modules | grep -v extramodules); do
  for m in nvidia nvidia_modeset nvidia_uvm nvidia_drm; do
    modinfo -k "$k" "$m" >/dev/null 2>&1 || echo "MISSING: $k $m"
  done
done

sudo mkinitcpio -P        # or: sudo limine-mkinitcpio  (Limine bootloaders)
```

If that loop prints nothing, it is safe to reboot. If it prints anything,
rebooting gives you a machine with no display driver.

Other things to confirm first:

- `grep -r "blacklist nouveau" /usr/lib/modprobe.d/ /etc/modprobe.d/` — the
  proprietary driver needs nouveau out of the way; the packages normally do it.
- `modinfo nvidia_drm | grep modeset` — Wayland needs kernel modesetting.
  Drivers since 545 default it on; older ones need
  `nvidia_drm.modeset=1` on the kernel command line.
- **Have SSH working from another device before you reboot.** If the display
  fails, that is how you get back in to roll back.
- Secure Boot, if enabled, requires the DKMS modules to be signed with an
  enrolled key or they will not load.

---

## 2. Set the environment

Where depends on how Ollama runs.

**systemd system service** (the usual install):

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment=OLLAMA_SCHED_SPREAD=1
Environment=OLLAMA_KEEP_ALIVE=30m
Environment=OLLAMA_FLASH_ATTENTION=1
Environment=OLLAMA_KV_CACHE_TYPE=q8_0
Environment=OLLAMA_NUM_PARALLEL=2
Environment=OLLAMA_CONTEXT_LENGTH=16384
```

**systemd user service** — same `Environment=` lines in
`~/.config/systemd/user/<name>.service`, then
`systemctl --user daemon-reload && systemctl --user restart <name>`.

**Run by hand** — just export them before `ollama serve`.

| Variable | What it does |
| --- | --- |
| `OLLAMA_SCHED_SPREAD=1` | spread a model across every GPU instead of fitting it on one |
| `OLLAMA_KV_CACHE_TYPE=q8_0` | quantise the KV cache, roughly halving it |
| `OLLAMA_FLASH_ATTENTION=1` | lower attention memory |
| `OLLAMA_NUM_PARALLEL=n` | concurrent requests — **each costs its own KV cache** |
| `OLLAMA_CONTEXT_LENGTH=n` | context per slot |
| `OLLAMA_GPU_OVERHEAD=bytes` | reserve VRAM per card, e.g. for the desktop |
| `CUDA_VISIBLE_DEVICES=0,1` | restrict or reorder which cards are used |

`daemon-reload` is required after editing a unit — restarting alone keeps the
old environment. Confirm what actually took effect:

```bash
systemctl show ollama -p Environment          # or --user
```

---

## 3. Verify it pooled

```bash
ollama run <a-model-bigger-than-one-card>
curl -s localhost:11434/api/ps | python3 -m json.tool    # resident size
nvidia-smi --query-gpu=index,name,memory.used --format=csv
```

Memory should be in use on **both** cards. Measured here loading a 49B at Q4:

```
0, NVIDIA GeForce GTX 1080 Ti, 10045 MiB
1, NVIDIA GeForce RTX 3090,    22693 MiB
```

If it all landed on one card, either the model fits there alone (expected
without `OLLAMA_SCHED_SPREAD`) or Ollama cannot see the second card.

---

## Device ordering: the two tools disagree

`nvidia-smi` numbers by PCI bus order. CUDA — and therefore PyTorch — defaults
to fastest-first. On this machine they are **opposite**:

```
nvidia-smi:  GPU 0 = GTX 1080 Ti   GPU 1 = RTX 3090
torch:       cuda:0 = RTX 3090     cuda:1 = GTX 1080 Ti
```

So `nvidia-smi -i 0` and `torch.device("cuda:0")` are different cards. Set
`CUDA_DEVICE_ORDER=PCI_BUS_ID` to make them agree.

This matters beyond Ollama: a script pinned to `cuda:0` may be landing on the
card you did not intend.

---

## What pooling buys, measured

Layers are split across cards — a pipeline, not tensor parallelism. Each layer
lives wholly on one GPU and activations hop over PCIe. That traffic is small,
so **no NVLink is needed** and PCIe width is not the bottleneck.

But decoding is memory-bandwidth bound, so the pool runs at roughly the
weighted average of its cards. Measured (3090 936 GB/s + 1080 Ti 484 GB/s):

| Model | 3090 alone | Both cards |
| --- | --- | --- |
| 14B dense | 56.7 tok/s | 45.5 tok/s |

**Pool when a model does not fit on the biggest card. Do not when it does** —
turn `OLLAMA_SCHED_SPREAD` off to get the speed back.

### Architecture matters more than size

Same pool, three models:

| Model | Type | Measured |
| --- | --- | --- |
| 14B | dense | 45.5 tok/s |
| 27B | dense | 24.9 tok/s |
| 30B | **MoE**, ~3B active | **81.5 tok/s** |
| 49B | dense | 11.2 tok/s |
| 70B | dense | 6.8 tok/s |

Dense speed scales almost exactly inversely with parameter count, as
bandwidth-bound decoding predicts. A Mixture-of-Experts model of the *same*
size ran 3.3× faster than the dense one, because only a fraction of its
parameters activate per token — at the cost of behaving like a smaller model on
hard reasoning.

---

## Sizing: what actually loads

```
usable = sum(VRAM) - desktop - compute buffers - (KV cache × parallel slots)
```

Measured on a 35 GB pool: **~2.0 GB** desktop (compositor, browser, Discord,
streaming host — and it grows as you open things) and **~1.0 GB** of compute
buffers, leaving ~32 GB for weights and KV.

`OLLAMA_CONTEXT_LENGTH` is allocated **per slot**, so `NUM_PARALLEL` multiplies
it. This is the usual reason a model that "should fit" refuses to load:

| Slots × context | 14B resident | Free |
| --- | --- | --- |
| 1 × 32k | 11.5 GB | ~10 GB |
| 4 × 32k | 19.9 GB | 1.3 GB — too tight |
| 4 × 16k | 14.2 GB | ~7 GB |

Leave 1.5–2 GB spare. A model loaded with 0.5 GB free works until you open a
few browser tabs, then dies mid-request.

### Quantisation has a cliff

Bigger-model-at-lower-quant wins down to about Q4, then reverses. Below Q4,
strict format adherence goes first — a 49B at Q4 that reports `tools` support
emitted tool calls as **plain text** rather than structured calls, making it
useless to an agent harness. Prefer a smaller model at Q6/Q8 over a larger one
at Q3/Q2 whenever tool use matters.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Card in `lspci`, absent from `nvidia-smi` | no driver bound — see step 1 |
| `modinfo` cannot find `nvidia` though `.ko` files exist | `depmod` was not re-run |
| `mkinitcpio`: `module not found: nvidia` | same — stale module database |
| Both cards visible, only one used | `OLLAMA_SCHED_SPREAD` unset, or unit edited without `daemon-reload` |
| Model that should fit will not load | KV cache × `NUM_PARALLEL`; drop slots or context |
| Slower than a single card | expected if the model fits on the faster card alone |
| OOM partway through a session | margin too thin for desktop growth |
| Black screen after a driver swap | a kernel had no module; boot the fallback kernel or SSH in and roll back |
