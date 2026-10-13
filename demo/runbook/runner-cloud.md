# Runner remote-metadata opt-in

The runner keeps its default metadata endpoint policy: only plain HTTP loopback (`127.0.0.1` or `[::1]`) is accepted. All Git remotes, workspaces, seed repositories and actor repositories remain local filesystem paths; this option changes metadata API transport only.

For an explicitly approved demo Worker, set both environment variables to the same origin, with no trailing path:

```sh
WORKSPACE_BASE_URL=https://your-worker.your-subdomain.workers.dev
WORKSPACE_ALLOWED_ORIGIN=https://your-worker.your-subdomain.workers.dev
```

The allowed value must be an exact HTTPS `*.workers.dev` origin: no custom/non-default port, path, userinfo, query or fragment. The base URL origin must match exactly and cannot carry a path or those components. If `WORKSPACE_ALLOWED_ORIGIN` is absent, remote URLs remain rejected; local loopback behavior is unchanged. Do not place credentials in command-line arguments or share them with candidates. Configure the token only in the operator's protected environment.

The client uses `redirect: 'error'`, so a redirect is refused rather than followed with the bearer token. The runner still enforces its 100-request maximum and 60-second deadline. This is an explicit transport opt-in, not proof of endpoint ownership, account qualification, Cloudflare deployment, or authorization to provision/write cloud resources. Never use human acceptance credentials in the runner.
