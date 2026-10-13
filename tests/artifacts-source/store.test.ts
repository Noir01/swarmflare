import { describe, expect, it, vi } from "vitest";
import { ArtifactsSourceStore } from "../../packages/artifacts-source/index.js";
import { encodeCommit } from "../../packages/git-transport/objects.js";
import { sourceReceiptSchema, sourceRef, type SourceJobInput } from "../../packages/contracts/source.js";

const sha = (n: string) => n.repeat(40);
const input: SourceJobInput = { kind: "seed", seedId: "seed_1", source: { commitOid: sha("a"), treeOid: sha("b") } };
const remote = "https://acct.artifacts.cloudflare.net/git/project/repo.git";
const commitData = encodeCommit({ tree: sha("b"), parents: [], author: { name: "test", email: "test@example.invalid", timestamp: 1, timezone: "+0000" }, committer: { name: "test", email: "test@example.invalid", timestamp: 1, timezone: "+0000" }, message: "test" });
const make = (overrides: Record<string, unknown> = {}) => {
  const refs = new Map<string, string>();
  const revokeToken = vi.fn(async () => true);
  const repo = {
    info: async () => ({ remote }),
    createToken: vi.fn(async () => { const expires = Math.floor(Date.now() / 1000) + 240; return { id: "token-id", plaintext: "art_v1_" + "a".repeat(40) + `?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString() }; }),
    revokeToken,
  };
  const transport = {
    listRefs: async () => Object.assign(new Map(refs), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const }),
    fetchPack: async () => new Uint8Array([1]),
    receivePack: async (_remote: unknown, updates: { ref: string; newSha: string }[]) => {
      for (const update of updates) refs.set(update.ref, update.newSha);
      return { unpackOk: true, refs: updates.map((u) => ({ ref: u.ref, ok: true })), progress: "" };
    },
    parsePack: async () => [
      { type: "commit" as const, sha: sha("a"), data: commitData },
      { type: "tree" as const, sha: sha("b"), data: new Uint8Array() },
    ],
    ...overrides,
  };
  return { repo, refs, revokeToken, transport, store: new ArtifactsSourceStore({ repo, remote, transport: transport as never, allowWrites: true }) };
};

describe("ArtifactsSourceStore", () => {
  it("validates the source tuple before minting a token", async () => {
    const f = make();
    await expect(f.store.publish({ input, commitOid: sha("c"), treeOid: sha("b"), pack: new Uint8Array([1]) })).rejects.toThrow();
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
  it("fails closed on unsafe remotes before minting secrets", async () => {
    for (const bad of ["http://acct.artifacts.cloudflare.net/git/project/repo.git", "https://user:pass@acct.artifacts.cloudflare.net/git/project/repo.git", "https://example.com/git/project/repo.git", "https://acct.artifacts.cloudflare.net:443/git/project/repo.git", "https://acct.artifacts.cloudflare.net/git/project/%2e%2e/repo.git"]) {
      const f = make();
      expect(() => new ArtifactsSourceStore({ repo: f.repo, remote: bad, transport: f.transport as never, allowWrites: true })).toThrow();
      expect(f.repo.createToken).not.toHaveBeenCalled();
    }
  });
  it("denies writes by default", async () => {
    const f = make();
    const store = new ArtifactsSourceStore({ repo: f.repo, remote, transport: f.transport as never });
    await expect(store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) })).rejects.toThrow();
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
  it("publishes immutable refs with exact readback and revokes the token", async () => {
    const f = make();
    const expires = Math.floor(Date.now() / 1000) + 240;
    f.repo.createToken.mockResolvedValue({ id: "token-id", plaintext: "art_v2_x_" + "a".repeat(40) + `?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString() });
    const result = await f.store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) });
    expect(result).toEqual({ backend: "artifacts-git", ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") });
    expect(f.repo.createToken).toHaveBeenCalledWith("write", 300);
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("reads successfully with the observed v2_x token shape", async () => {
    const f = make({ listRefs: async () => Object.assign(new Map([[sourceRef(input), sha("a")]]), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const }) });
    const expires = Math.floor(Date.now() / 1000) + 240;
    f.repo.createToken.mockResolvedValue({ id: "token-id", plaintext: "art_v2_x_" + "b".repeat(40) + `?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString() });
    await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).resolves.toEqual({ backend: "artifacts-git", ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") });
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("rejects malformed, expired and over-TTL v2 tokens", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    for (const token of [
      { plaintext: "art_v2_x_" + "A".repeat(40) + "?expires=1791720240", expiry: 1791720240 },
      { plaintext: "art_v2_x_" + "c".repeat(40) + "?expires=1791719999", expiry: 1791719999 },
      { plaintext: "art_v2_x_" + "d".repeat(40) + "?expires=1791720301", expiry: 1791720301 },
    ]) {
      const f = make();
      f.repo.createToken.mockResolvedValue({ id: "token-id", plaintext: token.plaintext, expiresAt: new Date(token.expiry * 1000).toISOString() });
      await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("INVALID_ARTIFACTS_TOKEN");
      expect(f.revokeToken).toHaveBeenCalledWith("token-id");
    }
    vi.useRealTimers();
  });
  it("revokes tokens on transport failure and redacts internal errors", async () => {
    const f = make({ listRefs: async () => { throw new Error("secret remote response"); } });
    await expect(f.store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("does not leak external errors with reserved-looking prefixes", async () => {
    for (const message of ["INVALID_token-secret", "SOURCE_private response", "ARTIFACTS_REPO_SCOPE_MISMATCH token-secret"]) {
      const f = make({ listRefs: async () => { throw new Error(message); } });
      await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
      expect(f.revokeToken).toHaveBeenCalledWith("token-id");
    }
  });
  it("fails safely when token revocation returns false or throws", async () => {
    for (const revokeToken of [async () => false, async () => { throw new Error("secret"); }]) {
      const f = make(); f.repo.revokeToken.mockImplementation(revokeToken);
      await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("ARTIFACTS_TOKEN_CLEANUP_FAILED");
    }
  });
  it("rejects overlong token lifetime and revokes successfully", async () => {
    const f = make();
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    const expires = Math.floor(Date.now() / 1000) + 301;
    f.repo.createToken.mockImplementation(async () => ({ id: "token-id", plaintext: "art_v1_" + "a".repeat(40) + `?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString() }));
    await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("INVALID_ARTIFACTS_TOKEN");
    expect(f.repo.revokeToken).toHaveBeenCalledWith("token-id");
    vi.useRealTimers();
  });
  it("revokes by plaintext when token ID is absent", async () => {
    const f = make({ listRefs: async () => Object.assign(new Map([[sourceRef(input), sha("a")]]), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const }) });
    const plaintext = "art_v1_" + "a".repeat(40) + `?expires=${Math.floor(Date.now() / 1000) + 240}`;
    f.repo.createToken.mockResolvedValue({ id: undefined as never, plaintext, expiresAt: new Date((Number(plaintext.split("=")[1])) * 1000).toISOString() });
    await f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") });
    expect(f.revokeToken).toHaveBeenCalledWith(plaintext);
  });
  it("keeps Artifacts receipts distinct from local source receipts", () => {
    const receipt = { backend: "artifacts-git", ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") };
    expect(sourceReceiptSchema.safeParse(receipt).success).toBe(false);
    expect(sourceReceiptSchema.safeParse({ ...receipt, backend: "local-git" }).success).toBe(true);
  });
  it("refuses a conflicting immutable target", async () => {
    const f = make();
    f.refs.set(sourceRef(input), sha("c"));
    await expect(f.store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) })).rejects.toThrow("SOURCE_REF_CONFLICT");
  });
  it("checks repo identity before creating a token", async () => {
    const f = make();
    f.repo.info = async () => ({ remote: "https://other.artifacts.cloudflare.net/git/project/repo.git" });
    await expect(f.store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("ARTIFACTS_REPO_SCOPE_MISMATCH");
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
  it("requires exact ref/commit/tree readback", async () => {
    const f = make({ listRefs: async () => Object.assign(new Map(), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const }) });
    await expect(f.store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) })).rejects.toThrow("SOURCE_READBACK_MISMATCH");
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("uses manual redirects and refuses 3xx without following or leaking credentials", async () => {
    const f = make({ listRefs: async (gitRemote: { fetch?: typeof fetch; url: string }) => {
      await gitRemote.fetch!(`${gitRemote.url}/info/refs?service=git-upload-pack`, { method: "GET" });
      return Object.assign(new Map(), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const });
    } });
    let redirect: RequestRedirect | undefined;
    let cancelled = false;
    let calls = 0;

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      redirect = init?.redirect;
      if (calls > 1) throw new Error("redirect target fetched");
      return { status: 302, body: { cancel: async () => { cancelled = true; } } } as Response;
    }) as unknown as typeof fetch;
    const store = new ArtifactsSourceStore({ repo: f.repo, remote, fetch: fetcher, allowWrites: true, transport: f.transport as never });
    await expect(store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
    expect(redirect).toBe("manual");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("permits only exact smart HTTP endpoints", async () => {
    const f = make();
    const store = new ArtifactsSourceStore({ repo: f.repo, remote, fetch: vi.fn(async () => new Response()), transport: f.transport as never });
    const guarded = (store as unknown as { gitRemote(token: string): { fetch: typeof fetch } }).gitRemote("token").fetch;
    for (const [path, method] of [["/info/refs?service=git-upload-pack", "GET"], ["/info/refs?service=git-receive-pack", "GET"], ["/git-upload-pack", "POST"], ["/git-receive-pack", "POST"]] as const) await expect(guarded(`${remote}${path}`, { method })).resolves.toBeInstanceOf(Response);
    for (const [path, method] of [["/info/refs", "GET"], ["/info/refs?service=evil", "GET"], ["/info/refs?service=git-upload-pack&x=1", "GET"], ["/info/refs?service=git-upload-pack", "POST"], ["/git-upload-pack?x=1", "POST"], ["/git-upload-pack/extra", "POST"], ["/git-receive-pack", "GET"], ["/other.git/info/refs?service=git-upload-pack", "GET"], ["/git/%2e%2e/repo.git/info/refs?service=git-upload-pack", "GET"]] as const) await expect(guarded(`https://acct.artifacts.cloudflare.net/git/project/repo.git${path}`, { method })).rejects.toThrow("ARTIFACTS_ORIGIN_REFUSED");
    for (const url of ["https://user@acct.artifacts.cloudflare.net/git/project/repo.git/info/refs?service=git-upload-pack", "https://acct.artifacts.cloudflare.net:444/git/project/repo.git/info/refs?service=git-upload-pack"]) await expect(guarded(url, { method: "GET" })).rejects.toThrow("ARTIFACTS_ORIGIN_REFUSED");
  });
  it("rejects same-length sibling repository paths before transport", async () => {
    let guarded!: typeof fetch;
    const f = make({ listRefs: async (gitRemote: { fetch?: typeof fetch; url: string }) => {
      guarded = gitRemote.fetch!;
      await guarded("https://acct.artifacts.cloudflare.net/git/project/other.git/info/refs?service=git-upload-pack", { method: "GET" });
      return Object.assign(new Map(), { symrefs: new Map(), capabilities: new Set(), protocol: 1 as const });
    } });
    const fetcher = vi.fn(async () => new Response());
    const store = new ArtifactsSourceStore({ repo: f.repo, remote, fetch: fetcher as unknown as typeof fetch, transport: f.transport as never });
    await expect(store.read({ ref: sourceRef(input), commitOid: sha("a"), treeOid: sha("b") })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.revokeToken).toHaveBeenCalledWith("token-id");
  });
  it("sanitizes parser errors before token creation", async () => {
    const f = make({ parsePack: async () => { throw new Error("synthetic secret pack bytes"); } });
    const failure = await f.store.publish({ input, commitOid: sha("a"), treeOid: sha("b"), pack: new Uint8Array([1]) }).then(() => undefined, (e: Error) => e);
    expect(failure?.message).toBe("ARTIFACTS_TRANSPORT_FAILED");
    expect(failure?.cause).toBeUndefined();
    expect(f.repo.createToken).not.toHaveBeenCalled();
  });
});