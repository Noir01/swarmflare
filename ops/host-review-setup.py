"""Renew existing cloud demo securely; migrate local paths, never accept code."""
import json, os, subprocess, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
PRIVATE = ROOT / '.local/host-review'
PRIVATE.mkdir(parents=True, exist_ok=True)
os.chmod(PRIVATE, 0o700)
expiry = int((time.time() + 1800) * 1000)
# Secret values stay in this process/private files, never printed.
secrets = json.loads((ROOT/'.local/cloud-cont35/deployment-secrets.json').read_text())
secrets['DEMO_EXPIRES_AT'] = str(expiry)
auth = json.loads(secrets['AUTH_CREDENTIALS'])
for entry in auth:
    entry['expiresAt'] = expiry
secrets['AUTH_CREDENTIALS'] = json.dumps(auth)
bootstrap = json.loads(secrets['DEMO_BOOTSTRAP_CONFIG'])
bootstrap['expiresAt'] = expiry
secrets['DEMO_BOOTSTRAP_CONFIG'] = json.dumps(bootstrap)
p = PRIVATE/'deployment-secrets.json'
p.write_text(json.dumps(secrets)); os.chmod(p, 0o600)
review = json.loads((ROOT/'.local/cloud-cont33/human-review.json').read_text())
review['expiresAt'] = expiry
p = PRIVATE/'human-review.json'
p.write_text(json.dumps(review)); os.chmod(p, 0o600)
config = json.loads((ROOT/'.local/cloud-cont32/repair-config.json').read_text())
for key in ['seedRepository','revisionRepository','remote','workspaceRoot','receiptPath','repairRepository']:
    value = config[key]
    if value.startswith('/home/noir/'):
        config[key] = str(HOME) + value[len('/home/noir'):]
p = PRIVATE/'repair-config.json'
p.write_text(json.dumps(config)); os.chmod(p, 0o600)
# Refresh via cf first; it handles its OAuth credential lifecycle.
cf = HOME/'.local/share/cf-cli/node_modules/.bin/cf'
result = subprocess.run([str(cf),'auth','whoami'], capture_output=True, text=True)
if result.returncode: raise SystemExit('Cloudflare authentication verification failed; no deployment attempted')
if not json.loads(result.stdout).get('tokenValid'): raise SystemExit('Cloudflare token invalid')
credential = json.loads((HOME/'.config/cloudflare/config/default.json').read_text())
env = dict(os.environ, CLOUDFLARE_API_TOKEN=credential['oauth_token'], CLOUDFLARE_ACCOUNT_ID='cb50a73b7487ae7039cbc8b613986b8b')
result = subprocess.run([str(ROOT/'node_modules/.bin/wrangler'),'deploy','--config','wrangler.demo.jsonc','--secrets-file',str(PRIVATE/'deployment-secrets.json')], cwd=ROOT,env=env,capture_output=True,text=True)
# Only whitelist deployment identifiers/URL and exit code, not raw secret-bearing logs.
for line in result.stdout.splitlines():
    if line.startswith(('Uploaded ', 'Deployed ', 'Current Version ID:')) or '.workers.dev' in line:
        print(line)
if result.returncode:
    print('Deployment failed; exit',result.returncode)
    # Redact exact known credential values before saving diagnostic output privately.
    text=result.stdout+'\n'+result.stderr
    for v in [credential['oauth_token'],credential.get('refresh_token',''),review.get('token','')]:
        if v: text=text.replace(v,'[REDACTED]')
    (PRIVATE/'deployment-error.log').write_text(text)
    raise SystemExit(result.returncode)
print('Review credential file ready for user; expiresAt',expiry)
