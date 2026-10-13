import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { provisionRepository, readRepositorySource, refreshRepository, type PlatformArtifactsBinding, type ProvisionedSource } from "../../apps/worker/src/platform/repository-source.js";

let scratch: string | undefined;
let server: Server | undefined;
let revokedTokens: string[] = [];
const originalFetch = globalThis.fetch;
const token = `art_v1_${"a".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 240}`;
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: join(scratch!, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } }).trim();
}
async function localGitHttp() {
  const repos = join(scratch!, "repos");
  const bare = join(repos, "git", "default", "repo.git");
  await mkdir(join(repos, "git", "default"), { recursive: true });
  git(scratch!, "init", "--bare", "-q", "--initial-branch=main", bare);
  git(bare, "config", "http.receivepack", "true");
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(scratch!, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: String(req.headers["content-type"] ?? ""), CONTENT_LENGTH: String(body.length), REMOTE_ADDR: "127.0.0.1", SERVER_PROTOCOL: "HTTP/1.1", ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}) };
    const result = execFileSync("git", ["http-backend"], { input: body, env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const split = result.indexOf(Buffer.from("\r\n\r\n"));
    if (split < 0) { res.writeHead(502).end(); return; }
    const headerText = result.subarray(0, split).toString();
    const headers: Record<string, string> = {};
    for (const line of headerText.split("\r\n")) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim(); }
    res.writeHead(200, headers).end(result.subarray(split + 4));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const loopback = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const logical = new URL(request.url);
    if (logical.hostname !== "acct.artifacts.cloudflare.net") return originalFetch(input, init);
    const local = new URL(`${logical.pathname}${logical.search}`, loopback);
    const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
    return originalFetch(local, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual" });
  });
  return { bare, remote: "https://acct.artifacts.cloudflare.net/git/default/repo.git" };
}
function binding(remote: string): PlatformArtifactsBinding {
  const repo = {
    info: async () => ({ remote }),
    createToken: async () => ({ id: "fixture-token", plaintext: token, expiresAt: new Date(Number(token.split("=").at(-1)) * 1000).toISOString() }),
    revokeToken: async (value: string) => { revokedTokens.push(value); return true; },
    [Symbol.dispose]() {},
  };
  return {
    create: async (name) => ({ name, remote, token: token.replace("art_v1_" + "a".repeat(40), "art_v1_" + "a".repeat(40)) }),
    import: async () => { throw new Error("not used"); },
    get: async () => repo,
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (scratch) { await rm(scratch, { recursive: true, force: true }); scratch = undefined; }
  revokedTokens = [];
});

describe("repository source provisioning", () => {
  it("creates an actual README blob/tree/commit pack and verifies it over local Git smart HTTP", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarmflare-source-")); await mkdir(join(scratch, "home"));
    const { remote, bare } = await localGitHttp();
    const result = await provisionRepository(binding(remote), { artifactsName: "sf-fixture", name: "Demo", description: "Local source test", initializeReadme: true });
    expect(result).toMatchObject({ status: "ready", ref: "refs/heads/main" });
    expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/); expect(result.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(result.commitOid);
    expect(git(bare, "show", "refs/heads/main:README.md")).toBe("# Demo\n\nLocal source test");
    expect(revokedTokens).toEqual([token]);
  });

  it("reads the exact README and rejects missing or traversal paths", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarmflare-source-read-")); await mkdir(join(scratch, "home"));
    const { remote } = await localGitHttp();
    const provisioned = await provisionRepository(binding(remote), { artifactsName: "sf-read", name: "Read me", description: "Source readback", initializeReadme: true });
    const repo = { ...provisioned, status: "ready" as const } as ProvisionedSource;
    const source = await readRepositorySource(binding(remote), repo, "");
    expect(source.readme).toBe("# Read me\n\nSource readback\n");
    await expect(readRepositorySource(binding(remote), repo, "absent.txt")).rejects.toThrow("SOURCE_PATH_NOT_FOUND");
    await expect(readRepositorySource(binding(remote), repo, "../README.md")).rejects.toThrow("INVALID_SOURCE_PATH");
    await expect(readRepositorySource(binding(remote), repo, "%2e%2e/README.md")).rejects.toThrow("INVALID_SOURCE_PATH");
  });

  it("leaves an empty repository genuinely empty", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarmflare-source-empty-")); await mkdir(join(scratch, "home"));
    const { remote, bare } = await localGitHttp();
    const result = await provisionRepository(binding(remote), { artifactsName: "sf-empty", name: "Empty", description: "", initializeReadme: false });
    expect(result).toMatchObject({ status: "ready", commitOid: null, treeOid: null });
    expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe("");
  });

  it("refuses imports outside the sole approved canonical URL before network access", async () => {
    const artifacts = { ...binding("https://acct.artifacts.cloudflare.net/git/default/repo.git"), import: vi.fn() };
    await expect(provisionRepository(artifacts, { artifactsName: "sf-import", name: "x", description: "", initializeReadme: false, importUrl: "https://github.com/octocat/other" })).rejects.toThrow("IMPORT_NOT_ALLOWED");
    expect(artifacts.import).not.toHaveBeenCalled();
  });

  it("imports the approved public repository and reaches ready only after actual smart-HTTP object readback", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarmflare-import-")); await mkdir(join(scratch, "home"));
    const { remote, bare } = await localGitHttp();
    const seed = join(scratch, "seed"); await mkdir(seed);
    git(seed, "init", "-q", "--initial-branch=main");
    execFileSync("git", ["-C", seed, "config", "user.name", "Fixture"]); execFileSync("git", ["-C", seed, "config", "user.email", "fixture@example.invalid"]);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(seed, "README.md"), "# Imported fixture\n"));
    git(seed, "add", "README.md"); git(seed, "commit", "-qm", "fixture");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).hostname === "api.github.com") return Response.json({ full_name: "octocat/Hello-World", private: false, size: 1 });
      const logical = new URL(request.url);
      if (logical.hostname !== "acct.artifacts.cloudflare.net") return originalFetch(input, init);
      const local = new URL(`${logical.pathname}${logical.search}`, `http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      const headers = new Headers(request.headers); headers.delete("host"); headers.delete("content-length");
      return originalFetch(local, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual" });
    });
    const initial = `art_v1_${"b".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 240}`;
    const repo = { info: async () => ({ remote }), createToken: async () => ({ id: "read-import", plaintext: token, expiresAt: new Date(Number(token.split("=").at(-1)) * 1000).toISOString() }), revokeToken: async (value: string) => { revokedTokens.push(value); return true; }, [Symbol.dispose]() {} };
    const artifacts: PlatformArtifactsBinding = {
      create: async () => { throw new Error("not used"); },
      import: async () => ({ name: "sf-import", remote, defaultBranch: "main", token: initial }),
      get: async () => repo,
    };
    const pending = await provisionRepository(artifacts, { artifactsName: "sf-import", name: "Hello", description: "", initializeReadme: false, importUrl: "https://github.com/octocat/Hello-World" });
    expect(pending).toMatchObject({ status: "importing", cleanupToken: initial, commitOid: null, treeOid: null });
    git(seed, "remote", "add", "target", bare); git(seed, "push", "target", "main");
    const ready = await refreshRepository(artifacts, pending);
    expect(ready.status).toBe("ready"); expect(ready.commitOid).toBe(git(seed, "rev-parse", "HEAD"));
    expect(ready.treeOid).toBe(git(seed, "rev-parse", "HEAD^{tree}"));
    expect(git(bare, "show", "refs/heads/main:README.md")).toBe("# Imported fixture");
    expect(revokedTokens).toEqual(["read-import", "read-import", initial]);
  });

  it("releases an invalid read token before reporting a token-validation failure", async () => {
    const remote = "https://acct.artifacts.cloudflare.net/git/default/repo.git";
    const repo = { info: async () => ({ remote }), createToken: async () => ({ id: "bad-token", plaintext: "invalid" }), revokeToken: async (value: string) => { revokedTokens.push(value); return true; }, [Symbol.dispose]() {} };
    const artifacts: PlatformArtifactsBinding = { create: async () => { throw new Error(); }, import: async () => { throw new Error(); }, get: async () => repo };
    const stored = { status: "ready" as const, artifactsName: "sf-invalid", remote, ref: "refs/heads/main", commitOid: "1".repeat(40), treeOid: "2".repeat(40) };
    await expect(readRepositorySource(artifacts, stored, "")).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(revokedTokens).toEqual(["bad-token"]);
  });
});
