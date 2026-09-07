"""
ShareGPU client -- drive a remote GPU over the VPN as if it were local.

Chat goes through the OpenAI-compatible endpoint, so the official SDK works
without this file at all:

    from openai import OpenAI
    client = OpenAI(base_url="http://10.0.0.2:8770/v1", api_key="unused")

This module is for the other half: taking the whole card for a workload that is
not an LLM. A remote process cannot make CUDA calls across a tunnel, so the
work is shipped to the GPU instead -- lease the card, send a script, stream the
output back, collect the artifacts.

    from sharegpu import ShareGPU

    gpu = ShareGPU("http://10.0.0.2:8770", token="...")

    with gpu.lease(vram_mb=16000, label="train run") as lease:
        lease.put("train.py", open("train.py", "rb").read())
        job = lease.run("python train.py --epochs 3", stream=True)
        print(job.status, job.exit_code)
        lease.get("checkpoint.pt", "./checkpoint.pt")

The lease is released on exit even if the body raises, and a background thread
heartbeats while it is held so the server does not reclaim the card mid-run.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator


class ShareGPUError(RuntimeError):
    """Raised when the gateway refuses or fails a request."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class Job:
    id: str
    status: str = "pending"
    exit_code: int | None = None
    error: str | None = None
    duration_ms: int | None = None
    raw: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"


class _Lease:
    """An active hold on the GPU. Created by ShareGPU.lease()."""

    def __init__(self, client: "ShareGPU", data: dict):
        self._client = client
        self.id: str = data["lease_id"]
        self.vram_mb: int = data.get("vram_mb", 0)
        self.expires_at: int = data.get("expires_at", 0)
        self.evicted_models: list[str] = data.get("evicted_models", [])
        self.waited_ms: int = data.get("waited_ms", 0)
        interval = data.get("heartbeat_every_ms", 60_000) / 1000.0
        self._stop = threading.Event()
        # Beat at a third of the deadline: the server reclaims after three
        # missed beats, so this survives a transient network stall.
        self._beat = threading.Thread(
            target=self._heartbeat_loop, args=(max(5.0, interval / 3),), daemon=True
        )
        self._beat.start()

    def _heartbeat_loop(self, every: float) -> None:
        while not self._stop.wait(every):
            try:
                self._client._request("POST", f"/compute/leases/{self.id}/heartbeat")
            except Exception:
                # A lost beat is recoverable; a raised exception on a daemon
                # thread is not. The server reclaims if this keeps failing.
                pass

    # ------------------------------------------------------------------ files

    def put(self, remote_path: str, data: bytes | str) -> dict:
        """Stage a file in the workspace. Valid before the first job runs."""
        if isinstance(data, str):
            data = data.encode()
        return self._client._request(
            "PUT", f"/compute/leases/{self.id}/files/{remote_path}", raw_body=data
        )

    def put_file(self, local_path: str, remote_path: str | None = None) -> dict:
        with open(local_path, "rb") as handle:
            return self.put(remote_path or os.path.basename(local_path), handle.read())

    def get(self, remote_path: str, local_path: str | None = None) -> bytes:
        """Fetch an artifact out of the workspace."""
        blob = self._client._request(
            "GET", f"/compute/leases/{self.id}/files/{remote_path}", raw_response=True
        )
        if local_path:
            with open(local_path, "wb") as handle:
                handle.write(blob)
        return blob

    def files(self) -> list[dict]:
        return self._client._request("GET", f"/compute/leases/{self.id}/files")["files"]

    # ------------------------------------------------------------------- jobs

    def run(
        self,
        script: str,
        *,
        stream: bool = True,
        on_line: Callable[[str, str], None] | None = None,
        timeout_ms: int | None = None,
        env: dict[str, str] | None = None,
    ) -> Job:
        """
        Run a shell script on the GPU host and block until it finishes.

        With stream=True the output is printed (or handed to on_line) as it is
        produced, so a long training run is observable rather than silent.
        """
        payload: dict[str, Any] = {"script": script}
        if timeout_ms:
            payload["timeout_ms"] = timeout_ms
        if env:
            payload["env"] = env
        created = self._client._request(
            "POST", "/compute/jobs", body=payload, headers={"X-ShareGPU-Lease": self.id}
        )
        job = Job(id=created["id"], status=created.get("status", "pending"), raw=created)
        if not stream:
            return self.wait(job)
        for kind, text in self.logs(job.id):
            if kind == "done":
                final = json.loads(text)
                return Job(
                    id=job.id,
                    status=final["status"],
                    exit_code=final.get("exit_code"),
                    error=final.get("error"),
                    duration_ms=final.get("duration_ms"),
                    raw=final,
                )
            if on_line:
                on_line(kind, text)
            else:
                print(text)
        return self.wait(job)

    def logs(self, job_id: str) -> Iterator[tuple[str, str]]:
        """Yield (stream, text) as the job produces output; ends with ('done', json)."""
        url = f"{self._client.base}/compute/jobs/{job_id}/logs"
        request = urllib.request.Request(url, headers=self._client._headers())
        with urllib.request.urlopen(request, timeout=None) as response:
            event = "message"
            for raw in response:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("event: "):
                    event = line[7:].strip()
                elif line.startswith("data: "):
                    payload = line[6:]
                    if event == "done":
                        yield ("done", payload)
                        return
                    try:
                        entry = json.loads(payload)
                        yield (entry.get("stream", "stdout"), entry.get("text", ""))
                    except json.JSONDecodeError:
                        continue

    def wait(self, job: Job, poll_every: float = 1.0) -> Job:
        while True:
            data = self._client._request("GET", f"/compute/jobs/{job.id}")
            if data["status"] not in ("pending", "running"):
                return Job(
                    id=job.id,
                    status=data["status"],
                    exit_code=data.get("exit_code"),
                    error=data.get("error"),
                    duration_ms=data.get("duration_ms"),
                    raw=data,
                )
            time.sleep(poll_every)

    def extend(self, extra_ms: int) -> dict:
        return self._client._request(
            "POST", f"/compute/leases/{self.id}/extend", body={"extra_ms": extra_ms}
        )

    def release(self) -> None:
        self._stop.set()
        try:
            self._client._request("DELETE", f"/compute/leases/{self.id}")
        except ShareGPUError:
            pass  # an expired lease is already released

    def __enter__(self) -> "_Lease":
        return self

    def __exit__(self, *exc) -> None:
        self.release()


class ShareGPU:
    def __init__(self, base: str, token: str | None = None, client_name: str | None = None):
        self.base = base.rstrip("/")
        self.token = token or os.environ.get("SHAREGPU_TOKEN")
        self.client_name = client_name or os.environ.get("SHAREGPU_CLIENT") or os.uname().nodename

    # ---------------------------------------------------------------- plumbing

    def _headers(self) -> dict[str, str]:
        headers = {"X-ShareGPU-Client": self.client_name}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        raw_body: bytes | None = None,
        headers: dict | None = None,
        raw_response: bool = False,
    ):
        url = f"{self.base}{path}"
        data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(url, data=data, method=method)
        for key, value in {**self._headers(), **(headers or {})}.items():
            request.add_header(key, value)
        if body is not None:
            request.add_header("Content-Type", "application/json")

        try:
            # No timeout: a lease request legitimately blocks while the server
            # drains in-flight LLM traffic before it can hand over the card.
            with urllib.request.urlopen(request, timeout=None) as response:
                payload = response.read()
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            try:
                detail = json.loads(detail)["error"]["message"]
            except Exception:
                pass
            raise ShareGPUError(detail, err.code) from None
        except urllib.error.URLError as err:
            raise ShareGPUError(f"cannot reach ShareGPU at {self.base}: {err.reason}") from None

        if raw_response:
            return payload
        return json.loads(payload) if payload else {}

    # ------------------------------------------------------------------ public

    def status(self) -> dict:
        return self._request("GET", "/api/status")

    def models(self) -> list[dict]:
        return self._request("GET", "/api/models")["models"]

    def chat(self, messages: list[dict], model: str | None = None, **options) -> str:
        """One-shot chat, for when pulling in the OpenAI SDK is overkill."""
        payload = {"model": model or "default", "messages": messages, **options}
        data = self._request("POST", "/v1/chat/completions", body=payload)
        return data["choices"][0]["message"]["content"]

    def lease(self, vram_mb: int | None = None, duration_ms: int | None = None, label: str | None = None) -> _Lease:
        """
        Take the card. Blocks until in-flight LLM traffic has drained and the
        requested VRAM is genuinely free.
        """
        payload: dict[str, Any] = {}
        if vram_mb:
            payload["vram_mb"] = vram_mb
        if duration_ms:
            payload["duration_ms"] = duration_ms
        if label:
            payload["label"] = label
        return _Lease(self, self._request("POST", "/compute/leases", body=payload))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="ShareGPU command line")
    parser.add_argument("--base", default=os.environ.get("SHAREGPU_URL", "http://127.0.0.1:8770"))
    parser.add_argument("--token", default=os.environ.get("SHAREGPU_TOKEN"))
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("models")
    ask = sub.add_parser("ask")
    ask.add_argument("prompt")
    ask.add_argument("--model", default=None)
    run = sub.add_parser("run", help="lease the GPU and run a script on it")
    run.add_argument("script", help="shell script text, or - to read stdin")
    run.add_argument("--vram-mb", type=int, default=None)
    run.add_argument("--label", default="cli")

    args = parser.parse_args()
    gpu = ShareGPU(args.base, args.token)

    if args.cmd == "status":
        state = gpu.status()
        dev = (state["gpu"]["devices"] or [{}])[0]
        print(f"mode      : {state['broker']['mode']}")
        print(f"gpu       : {dev.get('name','?')}  {dev.get('memoryFreeMb','?')} MB free")
        print(f"in flight : {len(state['broker']['llm']['active'])}/{state['broker']['llm']['capacity']}")
        print(f"queued    : {len(state['broker']['llm']['queued'])}")
        print(f"resident  : {', '.join(m['name'] for m in state['resident']) or 'none'}")
    elif args.cmd == "models":
        for model in gpu.models():
            print(f"{model['name']:48} {model['sizeMb']:>7} MB")
    elif args.cmd == "ask":
        print(gpu.chat([{"role": "user", "content": args.prompt}], model=args.model))
    elif args.cmd == "run":
        import sys

        script = sys.stdin.read() if args.script == "-" else args.script
        with gpu.lease(vram_mb=args.vram_mb, label=args.label) as lease:
            job = lease.run(script)
            print(f"\n[{job.status}] exit={job.exit_code} in {job.duration_ms}ms")
            raise SystemExit(0 if job.ok else 1)
