import { beforeEach, describe, expect, it, vi } from "vitest";

const seed = vi.hoisted(() => ({ pack: vi.fn(async () => "UEFDSw==") }));
vi.mock("../../apps/worker/src/platform/source-seed.js", () => ({ fetchSeedPack: seed.pack, validSeedConfig: (value: any, projectId: string) => !!value && value.projectId === projectId && value.repository === "sf-repo-1" && value.allowWrites === true && value.remote === "https://acct.artifacts.cloudflare.net/git/ns/repo.git" }));
import { repositoryBaseline } from "../../apps/worker/src/http/repository-baseline.js";

const commit = "a".repeat(40), tree = "b".repeat(40), projectId = "project-1", jobId = "seed-job-1", actorId = "service-seed-repo-1";
const source = { ref: "refs/heads/main", commitOid: commit, treeOid: tree };
const seedJob = (status: "queued" | "leased" | "completed" = "queued", id = jobId) => ({ id, version: 1, owner: "owner-1", data: { input: { kind: "seed", seedId: "seed-id-1", source: { commitOid: commit, treeOid: tree } }, status, attemptId: status === "queued" ? null : "attempt-1", runnerId: status === "queued" ? null : actorId, leaseExpiresAt: status === "queued" ? null : Date.now() + 25_000, receipt: status === "completed" ? { backend: "artifacts-git", ref: "refs/agent/seeds/seed-id-1", commitOid: commit, treeOid: tree } : null, error: null } });
function setup(options: { auth?: any; catalog?: any; config?: any; wrongClaim?: boolean; wrongReadback?: boolean; noContract?: boolean } = {}) {
  const calls: string[] = [], projectSteps = { initialized: false, published: false };
  const platform = { idFromName: () => "platform", get: () => ({ fetch: async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input); const path = new URL(request.url).pathname; calls.push(`${request.method} ${path}`);
    if (path.endsWith("/internal/authorize-project")) return Response.json(options.auth ?? { actor: { id: "owner-1", projectId, role: "human", kind: "human" }, repository: { owner: "ada", name: "notes" } });
    if (path.endsWith("/internal/source-config")) return Response.json({ config: options.config === undefined ? { projectId, repository: "sf-repo-1", remote: "https://acct.artifacts.cloudflare.net/git/ns/repo.git", allowWrites: true } : options.config });
    return options.catalog instanceof Response ? options.catalog : Response.json(options.catalog ?? { repository: { id: "repo-1", owner: "ada", ownerId: "owner-1", name: "notes", projectId, status: "ready", source } });
  } }) };
  const project = { idFromName: () => projectId, get: () => ({ fetch: async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input); const path = new URL(request.url).pathname; calls.push(`${request.method} ${path}`);
    if (path === "/baseline" && request.method === "GET") return Response.json({ resource: projectSteps.published ? (options.wrongReadback ? { version: 1, commitOid: "c".repeat(40), treeOid: tree, receipt: seedJob("completed").data.receipt } : { version: 1, commitOid: commit, treeOid: tree, receipt: seedJob("completed").data.receipt }) : null });
    if (path === "/baseline/initialize") { projectSteps.initialized = true; return options.noContract ? Response.json({ code: "CONTRACT_REQUIRED" }, { status: 409 }) : Response.json({ resource: seedJob() }, { status: 201 }); }
    if (path === "/runner/claim") return Response.json({ resource: seedJob("leased", options.wrongClaim ? "other-job" : jobId) }, { status: 201 });
    if (path.endsWith("/publish-artifacts")) { projectSteps.published = true; return Response.json({ resource: seedJob("completed") }, { status: 201 }); }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  } }) };
  const env: any = { PLATFORM: platform, PROJECTS: project, ARTIFACTS: {} };
  const request = (body: unknown = { requestId: crypto.randomUUID(), expectedVersion: 0, payload: { commitOid: commit, treeOid: tree } }, path = "/api/swarmflare/repos/ada/notes/baseline/initialize", method = "POST", headers: Record<string, string> = {}) => new Request(`https://swarmflare.test${path}`, { method, headers: { origin: "https://swarmflare.test", "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(body) : undefined });
  return { env, request, calls };
}

describe("repository baseline endpoint", () => {
  beforeEach(() => seed.pack.mockResolvedValue("UEFDSw=="));
  it("does not handle other routes and rejects wrong methods", async () => {
    const f = setup();
    expect(await repositoryBaseline(f.request({}, "/api/elsewhere"), f.env)).toBeNull();
    expect((await repositoryBaseline(f.request(undefined, undefined, "GET"), f.env))?.status).toBe(405);
  });
  it("rejects malformed and oversized envelopes before project mutation", async () => {
    const f = setup();
    expect((await repositoryBaseline(f.request({ requestId: "bad", expectedVersion: 0, payload: { commitOid: commit, treeOid: tree } }), f.env))?.status).toBe(400);
    const huge = new Request("https://swarmflare.test/api/swarmflare/repos/ada/notes/baseline/initialize", { method: "POST", headers: { origin: "https://swarmflare.test" }, body: "x".repeat(8193) });
    expect((await repositoryBaseline(huge, f.env))?.status).toBe(413);
    expect(f.calls).not.toContain("POST /baseline/initialize");
  });
  it("requires a same-origin authorized human owner", async () => {
    const outsider = setup({ auth: { actor: { id: "outsider", projectId, role: "human", kind: "human" }, repository: { owner: "ada", name: "notes" } } });
    expect((await repositoryBaseline(outsider.request(), outsider.env))?.status).toBe(403);
    const agent = setup({ auth: { actor: { id: "agent", projectId, role: "contributor", kind: "agent" }, repository: { owner: "ada", name: "notes" } } });
    expect((await repositoryBaseline(agent.request(), agent.env))?.status).toBe(403);
    const spoof = setup();
    expect((await repositoryBaseline(spoof.request(undefined, undefined, "POST", { "x-actor": '{"role":"human"}', origin: "https://attacker.test" }), spoof.env))?.status).toBe(403);
  });
  it("requires the verified ready catalog tuple and private source config", async () => {
    const pending = setup({ catalog: { repository: { id: "repo-1", owner: "ada", ownerId: "owner-1", name: "notes", projectId, status: "importing", source: null } } });
    expect((await repositoryBaseline(pending.request(), pending.env))?.status).toBe(409);
    const mismatch = setup();
    expect((await repositoryBaseline(mismatch.request({ requestId: crypto.randomUUID(), expectedVersion: 0, payload: { commitOid: "c".repeat(40), treeOid: tree } }), mismatch.env))?.status).toBe(409);
    const missingConfig = setup({ config: null });
    expect((await repositoryBaseline(missingConfig.request(), missingConfig.env))?.status).toBe(503);
  });
  it("refuses a claim for a different job and never publishes it", async () => {
    const f = setup({ wrongClaim: true });
    expect((await repositoryBaseline(f.request(), f.env))?.status).toBe(409);
    expect(f.calls.some(call => call.endsWith("/publish-artifacts"))).toBe(false);
  });
  it("honors the Project contract gate and fails closed on source-pack errors", async () => {
    const noContract = setup({ noContract: true });
    expect((await repositoryBaseline(noContract.request(), noContract.env))?.status).toBe(409);
    const failedPack = setup();
    seed.pack.mockRejectedValueOnce(new Error("synthetic pack transport failure"));
    const response = await repositoryBaseline(failedPack.request(), failedPack.env);
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("synthetic pack transport failure");
    expect(failedPack.calls.some(call => call.endsWith("/publish-artifacts"))).toBe(false);
  });
  it("returns initialized only after completed artifacts receipt and exact baseline readback", async () => {
    const ok = setup();
    const response = await repositoryBaseline(ok.request(), ok.env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: "initialized", baseline: { commitOid: commit, treeOid: tree, receipt: { backend: "artifacts-git" } }, job: { data: { status: "completed" } } });
    expect(ok.calls).toContain("POST /baseline/initialize");
    const wrong = setup({ wrongReadback: true });
    expect((await repositoryBaseline(wrong.request(), wrong.env))?.status).toBe(503);
  });
});
