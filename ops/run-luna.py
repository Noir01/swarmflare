"""Foreground, joined Luna children only; no scheduler or detached work."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path.home() / '.local/bin/hermes'
DEADLINE = json.loads((ROOT / '.execution/NEXT-WINDOW.json').read_text())['deadline_unix']
budget = int(sys.argv[1])
prompts = [Path(p).resolve() for p in sys.argv[2:]]
if not prompts or time.time() + max(300, budget + 90) >= DEADLINE:
    raise SystemExit('Refusing launch: insufficient active window')
env = os.environ.copy()
env.pop('PYTHONPATH', None)
children = []
try:
    for prompt in prompts:
        log = prompt.with_suffix('.log')
        stream = log.open('w')
        cmd = [str(PYTHON), 'chat', '--provider', 'openai-codex', '--model', 'gpt-6-luna', '--ignore-rules', '--max-turns', '55', '--run-budget', str(budget), '--query-file', str(prompt), '--quiet', '--pass-session-id']
        child = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
        children.append((child, stream, prompt, time.time()))
    outcomes = []
    for child, stream, prompt, started in children:
        try:
            code = child.wait(timeout=max(1, min(started + budget + 30, DEADLINE - 60) - time.time()))
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                code = child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                code = child.wait()
        stream.close()
        outcome = {'prompt': str(prompt), 'log': str(prompt.with_suffix('.log')), 'pid': child.pid, 'exitCode': code, 'started': started, 'finished': time.time(), 'provider': 'openai-codex', 'model': 'gpt-6-luna'}
        outcomes.append(outcome)
        print(json.dumps(outcome), flush=True)
    (ROOT / 'reports/workers' / ('launch-' + str(int(time.time())) + '.json')).write_text(json.dumps(outcomes, indent=2))
finally:
    for child, stream, _, _ in children:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        stream.close()
