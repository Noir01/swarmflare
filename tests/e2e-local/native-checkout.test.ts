import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPack, encodeCommit, encodeTree, hashObject } from "../../packages/git-transport/index.js";
import { checkoutExactNativeSource, PROJECT_ID, ACCOUNT_ID, NAMESPACE, REPOSITORY, type ApiResponse } from "../../demo/cloud/native-checkout.js";

let scratch: string | undefined;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = undefined; });
const ref = "refs/agent/views/01234567-89ab-cdef-0123-456789abcdef";
const octet = (n: number) => n.toString(16).padStart(4, "0");
const pkt = (text: Uint8Array | string) => { const b = typeof text === "string" ? Buffer.from(text) : Buffer.from(text); return Buffer.concat([Buffer.from(octet(b.length + 4)), b]); };
const flush = Buffer.from("0000");

async function fixture() {
  scratch = await mkdtemp(join(tmpdir(),"native-checkout-"));
  const barePath = join(scratch, "cache.git");
  execFileSync("git", ["init", "--bare", "-q", barePath]);
  const blob = { type: "blob" as const, data: Buffer.from("safe source\n") };
  const blobOid = await hashObject(blob);
  const tree = { type: "tree" as const, data: encodeTree([{ mode: "100644", name: "README.md", sha: blobOid }]) };
  const treeOid = await hashObject(tree);
  const ident = { name: "fixture", email: "fixture@example.invalid", timestamp: 1, timezone: "+0000" };
  const commit = { type: "commit" as const, data: encodeCommit({ tree: treeOid, parents: [], author: ident, committer: ident, message: "fixture\n" }) };
  const commitOid = await hashObject(commit);
  const pack = await buildPack([blob, tree, commit]);
  const token = `art_v1_${"a".repeat(40)}?expires=1900000060`;
  const tokenResult = { id: "abcdefghijklmnop", plaintext: token, expires_at: "2030-03-17T17:47:40.000Z" };
  const events: Array<{ method: string; path: string; body?: unknown }> = [];
  const deps = {
    cacheRoot: join(scratch, "unused"), testScratchPath: scratch,
    authCheck: async () => JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: ACCOUNT_ID }] }),
    readOAuthToken: async () => "synthetic-oauth",
    request: async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ApiResponse> => {
      events.push({ method, path, body });
      if (method === "GET") return { status: 200, body: { success: true, result: { remote: `https://acct.artifacts.cloudflare.net/git/${NAMESPACE}/${REPOSITORY}.git` } } };
      if (method === "POST") return { status: 201, body: { success: true, result: tokenResult } };
      return { status: 200, body: { success: true, result: {} } };
    },
    gitFetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(_url);
      if (u.includes("info/refs")) return new Response(Buffer.concat([pkt("# service=git-upload-pack\n"), flush, pkt(`${commitOid} ${ref}\0multi_ack_detailed side-band-64k ofs-delta\n`), flush]), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
      const frames: Buffer[] = [];
      const header = pkt("packfile\n");
      frames.push(Buffer.from("0001"), header);
      for (let i = 0; i < pack.length; i += 60_000) frames.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.from(pack.subarray(i, i + 60_000))])));
      frames.push(flush);
      expect(init?.redirect).toBe("manual");
      return new Response(Buffer.concat(frames), { headers: { "content-type": "application/x-git-upload-pack-result" } });
    },
    now: () => 1_900_000_000_000,
  };
  return { input: { ref, commitOid, treeOid, barePath }, deps, events, commitOid, treeOid };
}

it("imports and verifies the exact synthetic pack, then revokes the short-lived token", async () => {
  const f = await fixture();
  expect(PROJECT_ID).toBe("fc34f086-87da-4067-a648-484af2297bd7");
  expect(await checkoutExactNativeSource(f.input, f.deps)).toEqual({ ref, commitOid: f.commitOid, treeOid: f.treeOid, tokenRevoked: true });
  expect(execFileSync("git", ["--git-dir", f.input.barePath, "cat-file", "-t", f.commitOid], { encoding: "utf8" }).trim()).toBe("commit");
  expect(execFileSync("git", ["--git-dir", f.input.barePath, "rev-parse", `${ref}^{tree}`], { encoding: "utf8" }).trim()).toBe(f.treeOid);
  expect(f.events.map(e => e.method)).toEqual(["GET", "POST", "DELETE"]);
  expect(f.events[1]?.body).toEqual({ repo: REPOSITORY, scope: "read", ttl: 60 });
  expect(f.events[2]?.path).toBe(`/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NAMESPACE}/tokens/abcdefghijklmnop`);
  expect(JSON.stringify(f.events)).not.toContain("art_v1_");
});

it("rejects malformed identifiers, unsupported refs, and escaped cache paths before any calls", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, commitOid: "A".repeat(40) },
    { ...f.input, ref: "refs/agent/branches/main" },
    { ...f.input, barePath: join(scratch!, "..", "outside.git") },
  ]) await expect(checkoutExactNativeSource(input, f.deps)).rejects.toThrow("NATIVE_SOURCE_UNAVAILABLE");
  expect(f.events).toHaveLength(0);
});

it("rejects ref mismatches, non-artifacts hosts and malformed tokens and still revokes issued tokens", async () => {
  const f = await fixture();
  const originalFetch = f.deps.gitFetch;
  f.deps.gitFetch = async (url, init) => {
    const u = String(url);
    if (u.includes("info/refs")) return new Response(Buffer.concat([pkt("# service=git-upload-pack\n"), flush, pkt(`${f.commitOid} refs/heads/main\0cap\n`), flush]), { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    return originalFetch(url, init);
  };
  await expect(checkoutExactNativeSource(f.input, f.deps)).rejects.toThrow("NATIVE_SOURCE_UNAVAILABLE");
  expect(f.events.at(-1)?.method).toBe("DELETE");

  const host = await fixture();
  const get = host.deps.request;
  host.deps.request = async (method, path, body) => {
    if (method === "GET") { host.events.push({ method, path, body }); return { status: 200, body: { success: true, result: { remote: `https://attacker.example/git/${NAMESPACE}/${REPOSITORY}.git` } } }; }
    return get(method, path, body);
  };
  await expect(checkoutExactNativeSource(host.input, host.deps)).rejects.toThrow("NATIVE_SOURCE_UNAVAILABLE");
  expect(host.events.map(e => e.method)).toEqual(["GET"]);

  const badToken = await fixture();
  const issue = badToken.deps.request;
  badToken.deps.request = async (method, path, body) => method === "POST" ? { status: 201, body: { success: true, result: { id: "abcdefghijklmnop", plaintext: "not-a-token", expires_at: "2030-03-17T17:47:40.000Z" } } } : issue(method, path, body);
  await expect(checkoutExactNativeSource(badToken.input, badToken.deps)).rejects.toThrow("NATIVE_SOURCE_UNAVAILABLE");
  expect(badToken.events.at(-1)?.method).toBe("DELETE");
});

it("fails closed when token cleanup fails", async () => {
  const f = await fixture();
  const request = f.deps.request;
  f.deps.request = async (method, path, body) => method === "DELETE" ? { status: 500, body: { success: false } } : request(method, path, body);
  await expect(checkoutExactNativeSource(f.input, f.deps)).rejects.toThrow("NATIVE_TOKEN_CLEANUP_FAILED");
});
