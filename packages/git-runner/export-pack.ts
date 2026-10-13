import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: 'file' };
const MAX_PACK_BYTES = 36_000;

/** Export the self-contained reachable objects for an exact commit using only local Git. */
export async function exportGitPack(repository: string, commitOid: string, maxBytes = MAX_PACK_BYTES): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(commitOid)) throw new TypeError('commitOid must be a full lowercase Git object ID');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PACK_BYTES) throw new RangeError('pack size limit is invalid');
  const repo = resolve(repository);
  try {
    const output = execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=always', '-c', 'core.fsmonitor=false', 'pack-objects', '--stdout', '--revs'], {
      input: `${commitOid}\n`, env, timeout: 15_000, maxBuffer: maxBytes + 1,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.byteLength > maxBytes) throw Object.assign(new Error('Git pack exceeds supported size limit'), { code: 'PACK_TOO_LARGE' });
    if (output.byteLength < 12 || output.subarray(0, 4).toString('ascii') !== 'PACK') throw Object.assign(new Error('Git did not produce a valid pack'), { code: 'INVALID_PACK' });
    return output.toString('base64');
  } catch (error) {
    if ((error as { code?: string }).code === 'PACK_TOO_LARGE' || (error as { code?: string }).code === 'INVALID_PACK') throw error;
    const message = (error as Error)?.message ?? '';
    if (/maxBuffer/i.test(message) || (error as { code?: string }).code === 'ENOBUFS') throw Object.assign(new Error('Git pack exceeds supported size limit'), { code: 'PACK_TOO_LARGE' });
    throw Object.assign(new Error('Could not export local Git pack'), { code: 'PACK_EXPORT_FAILED' });
  }
}
