import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const cachedDigests = new Map<string, string>();

/**
 * Hash the distributed TypeScript source artifact, not runtime-transformed
 * function text. Local runners must ship these adjacent .ts artifacts; bundled
 * deployments are unsupported and fail closed if the source is absent.
 */
export function trustedSourceArtifactDigest(sourceUrl: URL): string {
  const key = sourceUrl.href;
  const cached = cachedDigests.get(key);
  if (cached) return cached;
  let bytes: Buffer;
  try {
    bytes = readFileSync(sourceUrl);
  } catch (error) {
    throw new Error(`Trusted suite source artifact is unavailable: ${sourceUrl.href}`, { cause: error });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  cachedDigests.set(key, digest);
  return digest;
}