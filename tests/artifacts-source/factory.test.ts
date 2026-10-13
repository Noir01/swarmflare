import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactsSourceStore } from "../../apps/worker/src/artifacts/source.js";

const projectId = "project-1";
const remote = "https://example.artifacts.cloudflare.net/git/demo/repo.git";
const config = JSON.stringify({ projectId, repository: "demo/repo", remote, allowWrites: true });

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture() {
  const calls: string[] = [];
  const repo = {
    info: vi.fn(async () => { calls.push("info"); return { remote }; }),
    createToken: vi.fn(async (scope: "read" | "write", ttl: number) => {
      calls.push(`create:${scope}:${ttl}`);
      return { id: "token-id", plaintext: "art_v1_" + "a".repeat(40) + "?expires=" + (Math.floor(Date.now() / 1000) + 300), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    }),
    revokeToken: vi.fn(async (id: string) => { calls.push(`revoke:${id}`); return true; }),
    [Symbol.dispose]: vi.fn(() => { calls.push("dispose"); }),
  };
  const get = vi.fn(async (name: string) => { calls.push(`get:${name}`); return repo; });
  return { calls, repo, get, env: { ARTIFACTS: { get }, ARTIFACTS_SOURCE_CONFIG: config } };
}

describe("createArtifactsSourceStore", () => {
  it("uses a stubbed fetch and never reaches the network", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const f = fixture();
    const store = createArtifactsSourceStore(f.env, projectId);
    await expect(store.read({ ref: "refs/agent/seeds/seed-1", commitOid: "a".repeat(40), treeOid: "b".repeat(40) })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${remote}/info/refs?service=git-upload-pack`);
  });

  it("awaits existing-repo handles, validates metadata, scopes short-lived tokens, revokes, and disposes handles", async () => {
    const f = fixture();
    const store = createArtifactsSourceStore(f.env, projectId);
    expect(f.get).not.toHaveBeenCalled();
    await expect(store.read({ ref: "refs/agent/seeds/seed-1", commitOid: "a".repeat(40), treeOid: "b".repeat(40) })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
    expect(f.get).toHaveBeenCalledWith("demo/repo");
    expect(f.calls.filter((call) => call === "info")).toHaveLength(1);
    expect(f.repo.createToken).toHaveBeenCalledWith("read", 300);
    expect(f.repo.revokeToken).toHaveBeenCalledWith("token-id");
    expect(f.calls).toEqual(["get:demo/repo", "info", "dispose", "get:demo/repo", "create:read:300", "dispose", "get:demo/repo", "revoke:token-id", "dispose"]);
    expect(f.calls.filter((call) => call === "dispose")).toHaveLength(3);
    expect(f.get).toHaveBeenCalledTimes(3);
  });

  it("enforces exact project and repository configuration without creating repositories", () => {
    const f = fixture();
    expect(() => createArtifactsSourceStore(f.env, "other-project")).toThrow("ARTIFACTS_SOURCE_UNAVAILABLE");
    expect(f.get).not.toHaveBeenCalled();
    expect(() => createArtifactsSourceStore({ ...f.env, ARTIFACTS_SOURCE_CONFIG: JSON.stringify({ projectId, repository: "demo/repo", remote, allowWrites: false }) }, projectId)).toThrow("ARTIFACTS_SOURCE_UNAVAILABLE");
    expect(f.get).not.toHaveBeenCalled();
    expect("create" in f.env.ARTIFACTS).toBe(false);
  });

  it("redacts binding failures", async () => {
    const f = fixture();
    f.get.mockRejectedValue(new Error("private binding detail"));
    const store = createArtifactsSourceStore(f.env, projectId);
    await expect(store.read({ ref: "refs/agent/seeds/seed-1", commitOid: "a".repeat(40), treeOid: "b".repeat(40) })).rejects.toThrow("ARTIFACTS_TRANSPORT_FAILED");
  });
});