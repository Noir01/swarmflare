import { jobInputSchema, type SourceJobInput } from "../contracts/source.js";
import { sourceRef } from "../contracts/source.js";
import { decodeCommit } from "../git-transport/objects.js";
import { listRefs } from "../git-transport/http.js";
import { fetchPack } from "../git-transport/upload.js";
import { receivePack, assertRefUpdated } from "../git-transport/receive.js";
import { parsePack } from "../git-transport/pack.js";
import type { GitRemote } from "../git-transport/http.js";

const OID = /^[0-9a-f]{40}$/;
// Keep aligned with git-transport's parser/HTTP body limit.
const MAX_PACK = 32 * 1024 * 1024;
type RepoLike = {
  info(): Promise<{ remote: string }>;
  createToken(scope: "read" | "write", ttl: number): Promise<{ id?: string; plaintext: string; expiresAt?: string }>;
  revokeToken?(tokenOrId: string): Promise<boolean>;
};
type Transport = {
  listRefs: typeof listRefs;
  fetchPack: typeof fetchPack;
  receivePack: typeof receivePack;
  parsePack: typeof parsePack;
};
export type ArtifactsSourceReceipt = { backend: "artifacts-git"; ref: string; commitOid: string; treeOid: string };
export type ArtifactsSourceStoreOptions = { repo: RepoLike; remote: string; fetch?: typeof fetch; allowWrites?: boolean; transport?: Transport };

function checkedRemote(raw: string): URL {
  if (raw.includes("%") || /(?:^|\/)\.\.?(?:\/|$)/.test(raw.split("?")[0] ?? "") || /^https:\/\/[^/]*:\d+/i.test(raw)) throw new Error("INVALID_ARTIFACTS_REMOTE");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("INVALID_ARTIFACTS_REMOTE"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.hostname !== url.hostname.toLowerCase() || !/^[a-z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname)) throw new Error("INVALID_ARTIFACTS_REMOTE");
  if (!/^\/git\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.git$/.test(url.pathname) || url.pathname.includes("..") || /%2f|%5c|%2e/i.test(url.pathname)) throw new Error("INVALID_ARTIFACTS_REMOTE");
  return url;
}
function checkOid(value: string, label: string): void { if (!OID.test(value)) throw new Error(`INVALID_${label.toUpperCase()}`); }
function checkRef(ref: string): void {
  if (!/^refs\/agent\/(?:seeds\/[A-Za-z0-9_-]+|revisions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|views\/[A-Za-z0-9_-]+)$/.test(ref)) throw new Error("INVALID_SOURCE_REF");
}
function assertTuple(input: SourceJobInput, commitOid: string, treeOid: string): void {
  checkOid(commitOid, "commit oid"); checkOid(treeOid, "tree oid");
  if (input.kind === "seed" && (input.source.commitOid !== commitOid || input.source.treeOid !== treeOid)) throw new Error("SOURCE_TUPLE_MISMATCH");
  if (input.kind === "publication" && (input.revision.commitOid !== commitOid || input.revision.treeOid !== treeOid)) throw new Error("SOURCE_TUPLE_MISMATCH");
}
function safeFetch(fetcher: typeof fetch, expected: URL): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    const exactPrefix = url.pathname.startsWith(`${expected.pathname}/`);
    const suffix = exactPrefix ? url.pathname.slice(expected.pathname.length) : "";
    const validRoute = (suffix === "/info/refs" && method === "GET" && ["?service=git-upload-pack", "?service=git-receive-pack"].includes(url.search))
      || ((suffix === "/git-upload-pack" || suffix === "/git-receive-pack") && method === "POST" && url.search === "");
    if (url.origin !== expected.origin || url.username || url.password || url.port || url.hash || !exactPrefix || !validRoute || url.pathname.includes("..") || /%|\\/.test(raw)) throw new Error("ARTIFACTS_ORIGIN_REFUSED");
    const response = await fetcher(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* The redirect is refused regardless. */ }
      throw new Error("ARTIFACTS_REDIRECT_REFUSED");
    }
    return response;
  }) as typeof fetch;
}
function errorCode(_error: unknown): Error { return new Error("ARTIFACTS_TRANSPORT_FAILED"); }
const SAFE_ERRORS = new Set(["SOURCE_TUPLE_MISMATCH", "SOURCE_REF_MISMATCH", "SOURCE_TREE_MISMATCH", "SOURCE_REF_CONFLICT", "SOURCE_READBACK_MISMATCH", "PACK_SOURCE_MISMATCH", "INVALID_SOURCE_JOB_INPUT", "INVALID_PACK", "INVALID_ARTIFACTS_TOKEN", "ARTIFACTS_WRITES_DISABLED"]);

export class ArtifactsSourceStore {
  private readonly repo: RepoLike;
  private readonly remote: URL;
  private readonly fetcher?: typeof fetch;
  private readonly allowWrites: boolean;
  private readonly transport: Transport;
  constructor(options: ArtifactsSourceStoreOptions) {
    this.remote = checkedRemote(options.remote);
    this.repo = options.repo;
    this.fetcher = options.fetch;
    this.allowWrites = options.allowWrites === true;
    this.transport = options.transport ?? { listRefs, fetchPack, receivePack, parsePack };
  }
  private gitRemote(token: string): GitRemote {
    const safe = this.fetcher ? safeFetch(this.fetcher, this.remote) : safeFetch(fetch, this.remote);
    return { url: this.remote.toString().replace(/\/$/, ""), auth: { bearer: token }, fetch: safe };
  }
  private async withToken<T>(scope: "read" | "write", op: (remote: GitRemote) => Promise<T>): Promise<T> {
    let token: { id?: string; plaintext: string; expiresAt?: string } | undefined;
    let result: T | undefined;
    let failure: Error | undefined;
    try {
      const info = await this.repo.info();
      const actual = checkedRemote(info.remote);
      if (actual.toString() !== this.remote.toString()) throw new Error("ARTIFACTS_REPO_SCOPE_MISMATCH");
      token = await this.repo.createToken(scope, 300);
      if (!/^(?:art_v1_|art_v2_x_)[0-9a-f]{40}\?expires=[0-9]+$/.test(token.plaintext)) throw new Error("INVALID_ARTIFACTS_TOKEN");
      const now = Math.floor(Date.now() / 1000);
      const expiry = Number(token.plaintext.slice(token.plaintext.lastIndexOf("=") + 1));
      const apiExpiry = typeof token.expiresAt === "string" ? Date.parse(token.expiresAt) : Number.NaN;
      if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 300 || !Number.isFinite(apiExpiry) || apiExpiry <= Date.now() || Math.abs(apiExpiry / 1000 - expiry) > 2) throw new Error("INVALID_ARTIFACTS_TOKEN");
      result = await op(this.gitRemote(token.plaintext));
    } catch (error) {
      failure = error instanceof Error && (SAFE_ERRORS.has(error.message) || ["INVALID_ARTIFACTS_REMOTE", "INVALID_SOURCE_REF", "INVALID_COMMIT_OID", "INVALID_TREE_OID", "ARTIFACTS_REPO_SCOPE_MISMATCH"].includes(error.message)) ? new Error(error.message) : errorCode(error);
    }
    let cleanupFailed = false;
    if (token) {
      try {
        const revoked = await this.repo.revokeToken?.(token.id ?? token.plaintext);
        cleanupFailed = revoked !== true;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error("ARTIFACTS_TOKEN_CLEANUP_FAILED");
    if (failure) throw failure;
    return result as T;
  }
  async read(args: { ref: string; commitOid: string; treeOid: string }): Promise<ArtifactsSourceReceipt> {
    checkRef(args.ref); checkOid(args.commitOid, "commit oid"); checkOid(args.treeOid, "tree oid");
    return this.withToken("read", async (remote) => {
      const refs = await this.transport.listRefs(remote, { service: "git-upload-pack" });
      if (refs.get(args.ref) !== args.commitOid) throw new Error("SOURCE_REF_MISMATCH");
      let objects;
      try { objects = await this.transport.parsePack(await this.transport.fetchPack(remote, { wants: [args.commitOid], ofsDelta: true })); }
      catch { throw new Error("ARTIFACTS_TRANSPORT_FAILED"); }
      const commit = objects.find((object) => object.sha === args.commitOid && object.type === "commit");
      if (!commit || decodeCommit(commit.data).tree !== args.treeOid || !objects.some((object) => object.sha === args.treeOid && object.type === "tree")) throw new Error("SOURCE_TREE_MISMATCH");
      return { backend: "artifacts-git", ref: args.ref, commitOid: args.commitOid, treeOid: args.treeOid };
    });
  }
  async publish(args: { input: SourceJobInput; commitOid: string; treeOid: string; pack: Uint8Array }): Promise<ArtifactsSourceReceipt> {
    if (!this.allowWrites) throw new Error("ARTIFACTS_WRITES_DISABLED");
    if (!jobInputSchema.safeParse(args.input).success) throw new Error("INVALID_SOURCE_JOB_INPUT");
    assertTuple(args.input, args.commitOid, args.treeOid);
    const ref = sourceRef(args.input); checkRef(ref);
    if (!(args.pack instanceof Uint8Array) || args.pack.byteLength === 0 || args.pack.byteLength > MAX_PACK) throw new Error("INVALID_PACK");
    let decoded;
    try { decoded = await this.transport.parsePack(args.pack); }
    catch { throw new Error("ARTIFACTS_TRANSPORT_FAILED"); }
    const commit = decoded.find((object) => object.sha === args.commitOid && object.type === "commit");
    if (!commit || decodeCommit(commit.data).tree !== args.treeOid || !decoded.some((object) => object.sha === args.treeOid && object.type === "tree")) throw new Error("PACK_SOURCE_MISMATCH");
    return this.withToken("write", async (remote) => {
      const refs = await this.transport.listRefs(remote, { service: "git-receive-pack" });
      const current = refs.get(ref);
      if (current && current !== args.commitOid) throw new Error("SOURCE_REF_CONFLICT");
      if (!current) {
        try {
          assertRefUpdated(await this.transport.receivePack(remote, [{ ref, oldSha: "0000000000000000000000000000000000000000", newSha: args.commitOid }], args.pack), ref);
        } catch {
          // A concurrent identical create is safe; any different target remains a conflict.
          const raced = await this.transport.listRefs(remote, { service: "git-upload-pack" });
          if (raced.get(ref) !== args.commitOid) throw new Error("SOURCE_REF_CONFLICT");
        }
      }
      const readbackRefs = await this.transport.listRefs(remote, { service: "git-upload-pack" });
      if (readbackRefs.get(ref) !== args.commitOid) throw new Error("SOURCE_READBACK_MISMATCH");
      let readback;
      try { readback = await this.transport.parsePack(await this.transport.fetchPack(remote, { wants: [args.commitOid], ofsDelta: true })); }
      catch { throw new Error("ARTIFACTS_TRANSPORT_FAILED"); }
      const checked = readback.find((object) => object.sha === args.commitOid && object.type === "commit");
      if (!checked || decodeCommit(checked.data).tree !== args.treeOid || !readback.some((object) => object.sha === args.treeOid && object.type === "tree")) throw new Error("SOURCE_READBACK_MISMATCH");
      return { backend: "artifacts-git", ref, commitOid: args.commitOid, treeOid: args.treeOid };
    });
  }
}
