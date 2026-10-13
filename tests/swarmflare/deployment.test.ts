import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

it('retains the bounded existing project deployment and adds both SQLite bindings', async () => {
  const config = JSON.parse(await readFile('wrangler.demo.jsonc', 'utf8'));
  expect(config.name).toBe('git-collaboration-demo-c29');
  expect(config.account_id).toBe('cb50a73b7487ae7039cbc8b613986b8b');
  expect(config.limits.cpu_ms).toBe(100);
  expect(config.preview_urls).toBe(false);
  expect(config.durable_objects.bindings).toEqual([{ name: 'PROJECTS', class_name: 'Project' }, { name: 'PLATFORM', class_name: 'Platform' }]);
  expect(config.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['Project'] }, { tag: 'v2', new_sqlite_classes: ['Platform'] }]);
  expect(config.artifacts).toEqual([{ binding: 'ARTIFACTS', namespace: 'git-collaboration-demo-c29', remote: false }]);
});

it('uses a gated, bounded development-only GitHub Actions deployment', async () => {
  const workflow = await readFile('.github/workflows/deploy-development.yml', 'utf8');
  expect(workflow).toContain('branches: [development]');
  expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('contents: read');
  expect(workflow).toContain('timeout-minutes: 10');
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain('node-version: 24.21.0');
  expect(workflow).toContain('npm ci --no-audit --no-fund');
  expect(workflow).toContain('npm run check:swarmflare');
  expect(workflow).toContain('npm run deploy:swarmflare');
  expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
  expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: cb50a73b7487ae7039cbc8b613986b8b');
  expect(workflow).not.toContain('secrets-file');
});

it('serves the Swarmflare product within the unchanged demo expiry guard', async () => {
  const bundle = await build({ entryPoints: ['apps/worker/src/demo-index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
  const options = { name: 'swarmflare-deployment-test', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', host: '127.0.0.1', port: 0 };
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  const expired = await runtime.dispatchFetch('https://swarmflare.test/');
  expect(expired.status).toBe(410);
  await runtime.setOptions(convertV4MiniflareOptions({ ...options, bindings: { DEMO_EXPIRES_AT: String(Date.now() + 60000) } }));
  const live = await runtime.dispatchFetch('https://swarmflare.test/');
  expect(live.status).toBe(200);
  expect(await live.text()).toContain('Swarmflare');
});
