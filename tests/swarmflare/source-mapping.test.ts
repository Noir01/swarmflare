import { describe, expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { resolveArtifactsSourceStore, createArtifactsSourceStore } from '../../apps/worker/src/artifacts/source';

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe('Artifacts source mapping', () => {
  const projectId = 'project-a';
  const remote = 'https://repo.artifacts.cloudflare.net/git/owner/repo.git';
  const makeEnv = (config?: unknown) => {
    // Synthetic native-binding metadata only; no native evidence is asserted.
    const repo = { info: vi.fn(async () => ({ remote })), createToken: vi.fn(), revokeToken: vi.fn(), [Symbol.dispose]: vi.fn() };
    const env = { ARTIFACTS: { get: vi.fn(async () => repo) }, PLATFORM: { idFromName: vi.fn(() => 'platform-id'), get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json(config)) })) }, ARTIFACTS_SOURCE_CONFIG: JSON.stringify({ projectId, repository: 'legacy', remote, allowWrites: true }) };
    return { env, repo };
  };

  it('resolves independent exact project mappings through the fixed Platform namespace', async () => {
    const { env } = makeEnv({ config: { projectId, repository: 'mapped-a', remote, allowWrites: true } });
    const store = await resolveArtifactsSourceStore(env as any, projectId);
    expect((env.PLATFORM.idFromName as any)).toHaveBeenCalledWith('swarmflare-platform-v1');
    expect((env.PLATFORM.get as any).mock.results[0].value.fetch).toHaveBeenCalledWith(expect.stringContaining('/internal/source-config'), expect.objectContaining({ method: 'POST' }));
    expect(store).toBeDefined();
    const envB = makeEnv({ config: { projectId: 'project-b', repository: 'mapped-b', remote, allowWrites: true } }).env;
    const storeB = await resolveArtifactsSourceStore(envB as any, 'project-b');
    await expect(storeB.read({ ref: 'refs/agent/seeds/seed-b', commitOid: '0'.repeat(40), treeOid: '1'.repeat(40) })).rejects.toThrow();
    expect((envB.ARTIFACTS.get as any)).toHaveBeenCalledWith('mapped-b');
  });

  it('uses only explicit unmapped response for legacy fallback; denies mapping errors', async () => {
    const { env } = makeEnv();
    (env.PLATFORM.get as any).mockReturnValue({ fetch: vi.fn(async () => Response.json({ code: 'PROJECT_UNMAPPED' }, { status: 404 })) });
    await expect(resolveArtifactsSourceStore(env as any, projectId)).resolves.toBeInstanceOf(Object);
    (env.PLATFORM.get as any).mockReturnValue({ fetch: vi.fn(async () => Response.json({ code: 'SOURCE_NOT_READY' }, { status: 409 })) });
    await expect(resolveArtifactsSourceStore(env as any, projectId)).rejects.toThrow('ARTIFACTS_SOURCE_UNAVAILABLE');
  });

  it('rejects a mapping for another project and mapped failure never falls back', async () => {
    const { env } = makeEnv({ config: { projectId: 'project-b', repository: 'mapped-b', remote, allowWrites: true } });
    await expect(resolveArtifactsSourceStore(env as any, projectId)).rejects.toThrow('ARTIFACTS_SOURCE_UNAVAILABLE');
    expect(() => createArtifactsSourceStore(env as any, projectId)).not.toThrow();
  });

  it('rejects wrong internal header, malformed mapped responses and source-not-ready mappings', async () => {
    const { env } = makeEnv({ config: { projectId, repository: 'mapped', remote, allowWrites: true, token: 'must-not-leak' } });
    (env.PLATFORM.get as any).mockReturnValue({ fetch: vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('x-swarmflare-internal')).toBe('project-worker');
      return Response.json({ config: { projectId, repository: 'mapped', remote, allowWrites: true, token: 'must-not-leak' } });
    }) });
    await expect(resolveArtifactsSourceStore(env as any, projectId)).rejects.toThrow('ARTIFACTS_SOURCE_UNAVAILABLE');
    (env.PLATFORM.get as any).mockReturnValue({ fetch: vi.fn(async () => Response.json({ code: 'SOURCE_NOT_READY' }, { status: 409 })) });
    await expect(resolveArtifactsSourceStore(env as any, projectId)).rejects.toThrow('ARTIFACTS_SOURCE_UNAVAILABLE');
  });

  it('serves internal mapping only behind trusted header and keeps unknown project distinct', async () => {
    const bundle = await build({ stdin: { contents: "export {Platform} from './apps/worker/src/platform/index';", resolveDir: process.cwd(), sourcefile: 'source-map-platform.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
    runtime = new Miniflare(convertV4MiniflareOptions({ name: 'source-map-platform', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PLATFORM: { className: 'Platform', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
    const origin = new URL((await runtime.ready).toString()).origin, ns: any = await runtime.getDurableObjectNamespace('PLATFORM'), stub = ns.get(ns.idFromName('swarmflare-platform-v1'));
    const call = (header?: string, body: unknown = { projectId }) => stub.fetch(`${origin}/api/platform/internal/source-config`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'x-swarmflare-internal': header } : {}) }, body: JSON.stringify(body) });
    expect((await call()).status).toBe(403);
    expect(await (await call('project-worker')).json()).toMatchObject({ code: 'PROJECT_UNMAPPED' });
    expect((await call('project-worker', { projectId, allowWrites: true, repository: 'attacker' })).status).toBe(400);
    expect((await stub.fetch(`${origin}/api/platform/repos/alice/repo/internal/source-config`, { method: 'POST' })).status).toBe(404);
  });

  it('updates the proposal status atomically with approved contract in SQLite', async () => {
    const bundle = await build({ stdin: { contents: "export {Project} from './apps/worker/src/project/index';", resolveDir: process.cwd(), sourcefile: 'source-map-project.ts', loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] });
    runtime = new Miniflare(convertV4MiniflareOptions({ name: 'source-map-project', modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-01', durableObjects: { PROJECTS: { className: 'Project', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
    const origin = new URL((await runtime.ready).toString()).origin, ns: any = await runtime.getDurableObjectNamespace('PROJECTS'), stub = ns.get(ns.idFromName(projectId));
    const headers = { 'content-type': 'application/json', 'x-project-id': projectId, 'x-actor': JSON.stringify({ id: 'human-1', projectId, role: 'human' }) };
    const contract = { outcome: 'Ship source mapping', constraints: [], obligations: [{ id: 'mapping', description: 'Map source safely', acceptanceExamples: [] }], requiredCheckIds: ['mapping-check'], unresolvedQuestions: [] };
    const proposed = await stub.fetch(`${origin}/contracts/proposals`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'proposal-create', payload: contract }) });
    const proposal = (await proposed.json() as any).resource;
    expect(proposal.data.status).toBe('proposed');
    const approved = await stub.fetch(`${origin}/contracts/${proposal.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'proposal-approve', expectedVersion: 0, payload: {} }) });
    expect(approved.status).toBe(201);
    expect((await approved.json() as any).resource.data.outcome).toBe(contract.outcome);
    const proposals = await stub.fetch(`${origin}/proposals`, { headers });
    expect((await proposals.json() as any).resource[0].data.status).toBe('approved');
  });
});
