#!/usr/bin/env python3
"""Run one bounded local live-demo phase around the approved Luna launcher."""

import argparse
import json
import os
from pathlib import Path
import selectors

import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parents[2]
SESSION = PROJECT / "demo/live/session.ts"
TRACE = PROJECT / "demo/live/trace.ts"
LAUNCHER = PROJECT / "ops/run-luna.py"
MAX_INVOCATION_SECONDS = 540
RESERVE_SECONDS = 300


def sanitize(value):
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if any(word in key.lower() for word in
                                      ("token", "password", "credential", "authorization", "secret"))
            else sanitize(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value


def save_output(root, prefix, name, text):
    path = root / f"{prefix}-{name}.json"
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        data = {"output": text[-12000:]}
    path.write_text(json.dumps(sanitize(data), indent=2) + "\n", encoding="utf-8")
    return path


def run_control(command, timeout, root, prefix, name):
    result = subprocess.run(command, cwd=PROJECT, text=True, capture_output=True,
                            timeout=max(0.1, timeout), check=False)
    output = save_output(root, prefix, name, result.stdout)
    if result.stderr.strip():
        # Keep diagnostics bounded and avoid ever dumping environment/config values.
        err = root / f"{prefix}-{name}-stderr.txt"
        err.write_text(result.stderr[-4000:], encoding="utf-8")
    print(f"{name}: exit={result.returncode} output={output}", flush=True)
    return result.returncode, result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("phase")
    parser.add_argument("budget", type=int)
    parser.add_argument("prompts", nargs="+", type=Path)
    parser.add_argument("--no-compose", action="store_true",
                        help="capture trace only; skip compose and checks")
    args = parser.parse_args()

    root = args.root.expanduser().resolve()
    if Path.cwd().resolve() != PROJECT:
        parser.error(f"run from project root: {PROJECT}")
    if not root.is_absolute() or not root.is_dir():
        parser.error("ROOT must be an existing absolute directory")
    if not args.phase or not all(c.isalnum() or c in "-_" for c in args.phase):
        parser.error("PHASE may contain only letters, digits, hyphens, and underscores")
    if not 1 <= args.budget <= 300:
        parser.error("BUDGET must be between 1 and 300 seconds")
    if len(args.prompts) > 4:
        parser.error("provide between 1 and 4 prompt files")
    prompts = []
    allowed = (PROJECT / "reports/workers").resolve()
    for prompt in args.prompts:
        path = prompt.resolve()
        if not path.is_file() or not path.is_relative_to(allowed):
            parser.error("prompt files must exist under project reports/workers")
        prompts.append(path)

    try:
        window = json.loads((PROJECT / ".execution/NEXT-WINDOW.json").read_text(encoding="utf-8"))
        cutoff = float(window["deadline_unix"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(f"cannot read valid execution cutoff: {exc}")
    now = time.time()
    if cutoff - now < max(RESERVE_SECONDS, args.budget + 180):
        parser.error("refusing: less than budget+180 seconds or five minutes remain")

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    prefix = args.phase
    absolute_end = min(now + MAX_INVOCATION_SECONDS, cutoff - RESERVE_SECONDS)
    failures = []
    service = None
    service_out = None
    try:
        service = subprocess.Popen(
            ["node", "--import", "tsx", str(SESSION), "start", str(root), str(args.budget + 140)],
            cwd=PROJECT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=False, close_fds=True,
        )
        ready = False
        with selectors.DefaultSelector() as selector:
            selector.register(service.stdout, selectors.EVENT_READ)
            start_end = min(absolute_end, now + 40)
            buffered = b""
            while time.time() < start_end and service.poll() is None:
                events = selector.select(min(0.5, start_end - time.time()))
                for key, _ in events:
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        continue
                    buffered += chunk
                    while b"\n" in buffered:
                        line, buffered = buffered.split(b"\n", 1)
                        try:
                            value = json.loads(line)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
                        if isinstance(value, dict) and value.get("url"):
                            service_out = save_output(root, prefix, "session-start", line.decode("utf-8", "replace"))
                            ready = True
                            break
                    if ready:
                        break
                if ready:
                    break
        if not ready:
            failures.append("session service failed readiness within 40 seconds")
        else:
            print(f"session-start: ready output={service_out}", flush=True)
            remaining = min(absolute_end, cutoff - RESERVE_SECONDS) - time.time()
            launcher_timeout = min(args.budget + 45, max(0.1, remaining))
            code, _ = run_control([sys.executable, str(LAUNCHER), str(args.budget), *map(str, prompts)],
                                  launcher_timeout, root, prefix, "launcher")
            if code != 0:
                failures.append(f"launcher exited {code}")

            for index in range(1, 9):
                remaining = absolute_end - time.time()
                if remaining <= 0:
                    failures.append("overall invocation time limit reached during drain")
                    break
                try:
                    code, stdout = run_control(
                        ["node", "--import", "tsx", str(SESSION), "drain", str(root)],
                        min(20.0, remaining), root, prefix, f"drain-{index:02d}")
                except subprocess.TimeoutExpired:
                    failures.append(f"drain {index} timed out")
                    break
                if code != 0:
                    failures.append(f"drain {index} exited {code}")
                    break
                try:
                    outcome = json.loads(stdout)
                except json.JSONDecodeError:
                    failures.append(f"drain {index} returned invalid JSON")
                    break
                if outcome is None:
                    break
                status = (outcome.get("data") or {}).get("status") if isinstance(outcome, dict) else None
                if status == "failed":
                    failures.append(f"drain {index} completed with a failed source job")
                    break

            view_id = None
            if not args.no_compose and time.time() < absolute_end:
                try:
                    code, stdout = run_control(
                        ["node", "--import", "tsx", str(SESSION), "compose", str(root)],
                        min(40.0, absolute_end - time.time()), root, prefix, "compose")
                    if code:
                        failures.append(f"compose exited {code}")
                    else:
                        payload = json.loads(stdout)
                        view_id = (payload.get("view") or {}).get("id")
                        if not view_id:
                            failures.append("compose output did not include a View id")
                except (subprocess.TimeoutExpired, json.JSONDecodeError):
                    failures.append("compose timed out or returned invalid JSON")
                if view_id and time.time() < absolute_end:
                    try:
                        code, _ = run_control(
                            ["node", "--import", "tsx", str(SESSION), "checks", str(root), view_id],
                            min(40.0, absolute_end - time.time()), root, prefix, "checks")
                        if code:
                            failures.append(f"checks exited {code}")
                    except subprocess.TimeoutExpired:
                        failures.append("checks timed out")
            elif not args.no_compose:
                failures.append("time limit reached before compose")
    except (OSError, subprocess.TimeoutExpired) as exc:
        failures.append(f"control invocation failed: {type(exc).__name__}")
    finally:
        trace = root / f"trace-{args.phase}.json"
        try:
            remaining = min(20.0, max(0.1, min(absolute_end, cutoff - RESERVE_SECONDS) - time.time()))
            code, _ = run_control(["node", "--import", "tsx", str(TRACE), str(root), str(trace)],
                                  remaining, root, prefix, "trace")
            if code:
                failures.append(f"trace exited {code}")
        except (OSError, subprocess.TimeoutExpired) as exc:
            failures.append(f"trace failed: {type(exc).__name__}")
        if service is not None:
            if service.poll() is None:
                service.terminate()
                try:
                    service.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    service.kill()
                    service.wait()
            print(f"session-service: exit={service.returncode}", flush=True)
            if service.stdout:
                service.stdout.close()
            if service.stderr:
                service.stderr.close()
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
