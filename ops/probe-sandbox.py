from pathlib import Path
import subprocess
exe = str(Path('/run/current-system/sw/bin/sh').resolve())
command = ['bwrap', '--unshare-all', '--die-with-parent', '--ro-bind', '/nix/store', '/nix/store', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--clearenv', exe, '-c', 'test ! -e /home/noir/.hermes/auth.json && test ! -e /home/noir/.config && test ! -e /home/noir/git-collaboration && printf SANDBOX_HOMES_HIDDEN']
p = subprocess.run(command, capture_output=True, text=True, timeout=10)
print('exit:', p.returncode, p.stdout, p.stderr)
raise SystemExit(p.returncode)
