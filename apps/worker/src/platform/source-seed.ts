import { decodeCommit } from "../../../../packages/git-transport/objects.js";
import { listRefs, type GitRemote } from "../../../../packages/git-transport/http.js";
import { fetchPack } from "../../../../packages/git-transport/upload.js";
import { parsePack } from "../../../../packages/git-transport/pack.js";
import type { PlatformArtifactsBinding } from "./repository-source";

const OID = /^[0-9a-f]{40}$/;
const TOKEN = /^(?:art_v1_|art_v2_x_)[0-9a-f]{40}\?expires=[0-9]+$/;
const MAX_PACK = 36_000;
const safeFailure = () => new Error("SOURCE_UNAVAILABLE");

type SeedConfig = { projectId: string; repository: string; remote: string; allowWrites: true };
function checkedRemote(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw safeFailure(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !/^[a-z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) || !/^\/git\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.git$/.test(url.pathname)) throw safeFailure();
  return url.toString().replace(/\/$/, "");
}
function validToken(token: { id?: string; plaintext: string; expiresAt?: string }): void {
  if (!TOKEN.test(token.plaintext)) throw safeFailure();
  const expiry = Number(token.plaintext.slice(token.plaintext.lastIndexOf("=") + 1));
  const apiExpiry = Date.parse(token.expiresAt ?? "");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 300 || !Number.isFinite(apiExpiry) || Math.abs(apiExpiry / 1000 - expiry) > 2) throw safeFailure();
}

/** Fetches only a catalog-pinned commit from its server-owned Artifacts repository. */
export async function fetchSeedPack(binding: PlatformArtifactsBinding | undefined, config: SeedConfig, projectId: string, commitOid: string, treeOid: string): Promise<string> {
  if (!binding || config.projectId !== projectId || config.allowWrites !== true || !/^[A-Za-z0-9_-]{1,100}$/.test(config.repository) || !OID.test(commitOid) || !OID.test(treeOid)) throw safeFailure();
  const expectedRemote = checkedRemote(config.remote);
  const repo = await binding.get(config.repository);
  let token: Awaited<ReturnType<typeof repo.createToken>> | undefined;
  let tokenText = "";
  let result: string | undefined;
  let failure: unknown;
  try {
    const info = await repo.info();
    if (checkedRemote(info.remote) !== expectedRemote) throw safeFailure();
    token = await repo.createToken("read", 300);
    tokenText = token.plaintext;
    validToken(token);
    const remote: GitRemote = { url: expectedRemote, auth: { bearer: tokenText }, timeoutMs: 5000, maxResponseBytes: MAX_PACK };
    const refs = await listRefs(remote, { protocol: 1, prefixes: ["refs/heads/main", "refs/heads/master"] });
    if (!["refs/heads/main", "refs/heads/master"].some(ref => refs.get(ref) === commitOid)) throw safeFailure();
    const pack = await fetchPack(remote, { wants: [commitOid], ofsDelta: true });
    if (pack.byteLength > MAX_PACK) throw safeFailure();
    const objects = await parsePack(pack, MAX_PACK);
    const commit = objects.find(object => object.type === "commit" && object.sha === commitOid);
    if (!commit || decodeCommit(commit.data).tree !== treeOid || !objects.some(object => object.type === "tree" && object.sha === treeOid)) throw safeFailure();
    let binary = "";
    for (let offset = 0; offset < pack.length; offset += 0x8000) binary += String.fromCharCode(...pack.subarray(offset, Math.min(offset + 0x8000, pack.length)));
    result = btoa(binary);
  } catch { failure = safeFailure(); }
  let revoked = false;
  try { if (token) revoked = await repo.revokeToken(token.id || tokenText); } catch { /* fail closed */ }
  try { repo[Symbol.dispose](); } catch { failure = safeFailure(); }
  if (token && !revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
  if (failure) throw failure;
  if (result === undefined) throw safeFailure();
  return result;
}

export function validSeedConfig(value: unknown, projectId: string): value is SeedConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "allowWrites,projectId,remote,repository") return false;
  try { checkedRemote(typeof config.remote === "string" ? config.remote : ""); } catch { return false; }
  return config.projectId === projectId && config.allowWrites === true && typeof config.repository === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(config.repository);
}
