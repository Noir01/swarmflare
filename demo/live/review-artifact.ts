import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceClient } from '../../packages/client/index.js';
import { buildReviewArtifact } from '../../packages/local-runner/review-artifact.js';
import { validateBaseUrl, validateConfig } from './actor.js';

const exec = promisify(execFile);

export async function createLiveReviewArtifact(root: string, viewId: string, output: string) {
  let token = '';
  try {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(viewId)) throw new Error();
    const sessionRoot = await realpath(resolve(root));
    const outputPath = resolve(output), rel = relative(sessionRoot, outputPath);
    if (!isAbsolute(outputPath) || !rel || rel.startsWith('..') || rel.includes('/..')) throw new Error();
    const parent = await realpath(dirname(outputPath));
    const parentRel = relative(sessionRoot, parent);
    if (parentRel.startsWith('..') || parentRel.includes('/..')) throw new Error();
    try { await lstat(outputPath); throw new Error(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const config = validateConfig(JSON.parse(await readFile(resolve(sessionRoot, 'private/runner.json'), 'utf8')));
    token = config.token;
    const manifest = JSON.parse(await readFile(resolve(sessionRoot, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const repository = resolve(sessionRoot, 'remote.git');
    if (config.actorId !== 'demo-runner' || config.projectId !== manifest.projectId || validateBaseUrl(manifest.baseUrl) !== config.baseUrl || resolve(config.repository) !== repository || resolve(String(manifest.remote)) !== repository) throw new Error();
    const bare = await exec('git', ['-C', repository, 'rev-parse', '--is-bare-repository'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, timeout: 3000, maxBuffer: 1024 });
    if (bare.stdout.trim() !== 'true') throw new Error();
    const client = new WorkspaceClient({ baseUrl: config.baseUrl, projectId: config.projectId, token, maxRequests: 20, deadline: 30_000 });
    const artifact = await buildReviewArtifact(client, { remote: repository, workspaceRoot: sessionRoot, viewId });
    const serialized = JSON.stringify(artifact, null, 2) + '\n';
    if (serialized.includes(token)) throw new Error();
    const handle = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(serialized, 'utf8'); } catch (error) { await handle.close(); const { unlink } = await import('node:fs/promises'); await unlink(outputPath).catch(() => {}); throw error; }
    await handle.close();
    return { viewId, artifactId: artifact.id, output: outputPath, verified: true };
  } catch {
    throw new Error('live review artifact failed; check local runner configuration and source state');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error('usage: review-artifact.ts ROOT VIEW_ID OUTPUT');
  const result = await createLiveReviewArtifact(args[0]!, args[1]!, args[2]!);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch(() => { process.stderr.write('live review artifact failed\n'); process.exitCode = 1; });
