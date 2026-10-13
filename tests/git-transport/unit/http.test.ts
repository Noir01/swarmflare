import { describe, expect, it, vi } from "vitest";
import { request } from "../../../packages/git-transport/http.js";
import { GitHttpError } from "../../../packages/git-transport/errors.js";

describe("bounded smart HTTP boundary", () => {
  it("rejects credential-bearing URLs before fetch", async () => {
    const fetcher = vi.fn();
    await expect(request({ url: "https://user:pass@example.test/repo.git", fetch: fetcher }, "git-upload-pack", false)).rejects.toThrow(/url/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not follow redirects or forward authorization", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } });
    });
    await expect(request({ url: "https://example.test/repo.git", auth: { bearer: "secret" }, fetch: fetcher }, "git-upload-pack", false)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires the Git smart response media type", async () => {
    const fetcher = vi.fn(async () => new Response("ignored", { headers: { "Content-Type": "text/plain" } }));
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher }, "git-upload-pack", false)).rejects.toThrow();
  });

  it("rejects oversized response bodies without buffering them", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(64), { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } }));
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher, maxResponseBytes: 16 }, "git-upload-pack", false)).rejects.toThrow(/size|large|limit/i);
  });

  it("bounds a custom fetch that ignores AbortSignal and redacts its error", async () => {
    const fetcher = vi.fn(() => new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("Bearer secret leaked")), 100)));
    const start = Date.now();
    await expect(request({ url: "https://example.test/repo.git", auth: { bearer: "secret" }, fetch: fetcher, timeoutMs: 10 }, "git-upload-pack", false)).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(80);
  });

  it("sanitizes custom fetch network failures", async () => {
    const fetcher = vi.fn(async () => { throw new Error("Authorization: secret"); });
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher }, "git-upload-pack", false)).rejects.not.toThrow(/secret/i);
  });

  it("does not let a never-settling stream cancellation defeat the deadline", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => new Promise<void>(() => {}),
    }), { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } }));
    const start = Date.now();
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher, timeoutMs: 15 }, "git-upload-pack", false)).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(250);
  });

  it("sanitizes externally thrown GitHttpError instances", async () => {
    const external = new GitHttpError(599, "synthetic secret", "secret body");
    const fetcher = vi.fn(async () => { throw external; });
    try {
      await request({ url: "https://example.test/repo.git", fetch: fetcher }, "git-upload-pack", false);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).not.toBe(external);
      expect(error).toBeInstanceOf(GitHttpError);
      expect((error as GitHttpError).status).toBe(502);
      expect(String(error)).not.toMatch(/synthetic secret|secret body/);
      expect(JSON.stringify(error)).not.toMatch(/secret/);
    }
  });

  it("cancels a response body when fetch resolves after the deadline", async () => {
    let canceled = false;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { canceled = true; },
    }), { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } })), 40)));
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher, timeoutMs: 10 }, "git-upload-pack", false)).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(canceled).toBe(true);
  });

  it("rejects an oversized outbound body before calling fetch", async () => {
    const fetcher = vi.fn();
    const body = new Uint8Array(32 * 1024 * 1024 + 1);
    await expect(request({ url: "https://example.test/repo.git", fetch: fetcher }, "git-upload-pack", false, body)).rejects.toThrow(/size|limit/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
