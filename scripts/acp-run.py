#!/usr/bin/env python3
"""Drive a DSH agent over ACP, from a terminal.

The web UI is one client of the harness; the ACP profile is another, speaking
JSON-RPC v1 over stdio. This exists so a benchmark run can be launched and
scored without a person driving a browser, which is the only reason earlier
runs had to be serialised.

    python3 scripts/acp-run.py --profile ab-qwen-acp --cwd ~/work/ab-qwen \
        --prompt "Read ... and do the task it describes."

Prints the agent's text as it arrives and exits non-zero on a protocol error.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from typing import Any

PROTOCOL_VERSION = 1


class AcpClient:
    """A newline-delimited JSON-RPC client over the agent's stdio."""

    def __init__(self, argv: list[str], env: dict[str, str], log: Any) -> None:
        self._proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._replies: dict[int, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._log = log
        self._stderr: list[str] = []
        self.last_activity = time.time()
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                # Stdout is reserved for protocol frames; anything else is a
                # bug in a mounted plugin and worth seeing.
                self._log(f"[non-protocol stdout] {line[:160]}")
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with self._lock:
                    self._replies[msg["id"]] = msg
            elif "id" in msg and "method" in msg:
                # The agent calls the client too. An unanswered request is not
                # a slow turn, it is a deadlock: the agent waits forever.
                self._on_request(msg)
            else:
                self._on_notification(msg)

    def _pump_stderr(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            self._stderr.append(line.rstrip())

    def _reply(self, rid: Any, result: dict[str, Any] | None, error: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": rid}
        if error is not None:
            frame["error"] = error
        else:
            frame["result"] = result or {}
        assert self._proc.stdin is not None
        with self._lock:
            self._proc.stdin.write(json.dumps(frame) + "\n")
            self._proc.stdin.flush()

    def _on_request(self, msg: dict[str, Any]) -> None:
        self.last_activity = time.time()
        method, rid = msg.get("method"), msg.get("id")

        if method == "session/request_permission":
            # Sandbox escalations arrive here. A benchmark run mounts a bundle
            # into a profile under ~/.dsh, which is outside the workspace, so
            # refusing by default would make the task impossible rather than
            # hard. Set ACP_PERMISSION=reject to measure the opposite.
            params = msg.get("params") or {}
            options = params.get("options") or []
            want = "reject_once" if os.environ.get("ACP_PERMISSION") == "reject" else "allow_once"
            chosen = next(
                (o for o in options if o.get("kind") == want),
                options[0] if options else None,
            )
            if chosen is None:
                self._reply(rid, {"outcome": {"outcome": "cancelled"}})
                return
            call = (params.get("toolCall") or {}).get("toolCallId", "?")
            self._log(f"\n  [permission] {chosen.get('optionId')} for tool call {call}")
            self._reply(rid, {"outcome": {"outcome": "selected", "optionId": chosen.get("optionId")}})
            return

        # Anything else is a client capability this driver did not declare.
        # Answering with an error fails the call; staying silent hangs the run.
        self._log(f"\n  [unhandled request] {method}")
        self._reply(rid, None, {"code": -32601, "message": f"{method} not supported by this client"})

    def _on_notification(self, msg: dict[str, Any]) -> None:
        self.last_activity = time.time()
        if msg.get("method") != "session/update":
            return
        update = (msg.get("params") or {}).get("update") or {}
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            content = update.get("content") or {}
            if content.get("type") == "text":
                sys.stdout.write(content.get("text", ""))
                sys.stdout.flush()
        elif kind == "tool_call":
            self._log(f"\n  [tool] {update.get('title') or update.get('kind') or '?'}")

    def call(self, method: str, params: dict[str, Any], timeout: float = 900) -> dict[str, Any]:
        with self._lock:
            self._next_id += 1
            rid = self._next_id
        frame = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        assert self._proc.stdin is not None
        # Shared with the pump thread, which now writes replies of its own.
        with self._lock:
            self._proc.stdin.write(json.dumps(frame) + "\n")
            self._proc.stdin.flush()

        deadline = time.time() + timeout
        stall = float(os.environ.get("ACP_STALL_SECONDS", "300"))
        while time.time() < deadline:
            # A run that has stopped producing anything is stuck, not thinking.
            # Waiting out the global timeout hides that for half an hour.
            if method == "session/prompt" and time.time() - self.last_activity > stall:
                raise TimeoutError(
                    f"{method}: no activity for {stall:.0f}s (stalled, not slow)"
                )
            with self._lock:
                reply = self._replies.pop(rid, None)
            if reply is not None:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {json.dumps(reply['error'])[:300]}")
                return reply.get("result") or {}
            if self._proc.poll() is not None:
                raise RuntimeError(
                    f"{method}: agent exited {self._proc.returncode}\n"
                    + "\n".join(self._stderr[-12:])
                )
            time.sleep(0.05)
        raise TimeoutError(f"{method}: no reply in {timeout:.0f}s")

    def close(self) -> None:
        try:
            assert self._proc.stdin is not None
            self._proc.stdin.close()
            self._proc.wait(timeout=30)
        except Exception:
            self._proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True)
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--dsh", default=os.path.expanduser("~/.npm-global/bin/dsh"))
    ap.add_argument("--timeout", type=float, default=1800)
    args = ap.parse_args()

    cwd = os.path.abspath(os.path.expanduser(args.cwd))
    log = lambda s: print(s, file=sys.stderr, flush=True)

    client = AcpClient([args.dsh, "--profile", args.profile], dict(os.environ), log)
    try:
        log(f"initialize (protocol v{PROTOCOL_VERSION})")
        info = client.call(
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "clientCapabilities": {}},
            timeout=120,
        )
        log(f"  agent: {json.dumps(info)[:200]}")

        log(f"session/new cwd={cwd}")
        session = client.call("session/new", {"cwd": cwd, "mcpServers": []}, timeout=180)
        sid = session.get("sessionId")
        log(f"  sessionId: {sid}")

        log("session/prompt")
        result = client.call(
            "session/prompt",
            {"sessionId": sid, "prompt": [{"type": "text", "text": args.prompt}]},
            timeout=args.timeout,
        )
        print()
        log(f"stopReason: {result.get('stopReason')}")

        try:
            client.call("session/close", {"sessionId": sid}, timeout=60)
        except Exception:
            pass
        return 0
    except Exception as exc:  # noqa: BLE001 — a driver reports and exits
        log(f"FAILED: {exc}")
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
