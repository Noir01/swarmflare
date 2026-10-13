import { decodeCommit, decodeTree, encodeCommit, encodeTree, hashObject } from "../../../../packages/git-transport/objects.js";
import { buildPack, parsePack } from "../../../../packages/git-transport/pack.js";
import { listRefs, type GitRemote } from "../../../../packages/git-transport/http.js";
import { fetchPack } from "../../../../packages/git-transport/upload.js";
import { assertRefUpdated, receivePack } from "../../../../packages/git-transport/receive.js";

const MAX_README = 64 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_OBJECTS = 100_000;
const REF = "refs/heads/main";
const IMPORT_URL = "https://github.com/octocat/Hello-World";
const OID = /^[0-9a-f]{40}$/;

type GitToken = { id?: string; plaintext: string; expiresAt?: string };
type RepoInfo = { remote: string; status?: string; defaultBranch?: string };
type Repo = {
  info(): Promise<RepoInfo>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<GitToken>;
  revokeToken(tokenOrId: string): Promise<boolean>;

  [Symbol.dispose](): void;
};
export type PlatformArtifactsBinding = {
  create(name: string, opts: { description: string; readOnly: false; setDefaultBranch: "main" }): Promise<{ name: string; remote: string; token: string }>;
  import(params: { source: { url: string; branch: "master"; depth: 1 }; target: { name: string; opts: { description: string; readOnly: false } } }): Promise<{ name: string; remote: string; defaultBranch: string; token: string }>;
  get(name: string): Promise<Repo>;
};
export type ProvisionedSource = {
  status: "ready" | "importing";
  artifactsName: string;
  remote: string;
  ref: string;
  commitOid: string | null;
  treeOid: string | null;
  cleanupToken?: string;
};
type Entry = { name: string; path: string; kind: "file" | "directory" | "unsupported"; oid: string };
type ReadResult = { commitOid: string | null; treeOid: string | null; entries: Entry[]; file?: { path: string; content: string }; readme?: string };

function safeError(): Error { return new Error("SOURCE_UNAVAILABLE"); }
function pendingProviderOperation(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && ["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"].includes(String((error as { code?: unknown }).code)); }
async function bounded<T>(operation: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(safeError()), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function getRepo(binding: PlatformArtifactsBinding, name: string): Promise<Repo> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await bounded(binding.get(name)); }
    catch (error) { if (!pendingProviderOperation(error) || attempt === 2) throw error; }
  }
  throw safeError();
}
async function revokeInitial(binding: PlatformArtifactsBinding, expectedName: string, token: string): Promise<void> {
  try {
    const repo = await getRepo(binding, expectedName);
    try { if (!await bounded(repo.revokeToken(token))) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED"); }
    finally { repo[Symbol.dispose](); }
  } catch { throw new Error("SOURCE_TOKEN_CLEANUP_FAILED"); }
}
function validRepoName(name: string): boolean { return /^[A-Za-z0-9_-]{1,100}$/.test(name); }
function checkedRemote(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw safeError(); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || !/^[a-z0-9-]+\.artifacts\.cloudflare\.net$/.test(u.hostname) || !/^\/git\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.git$/.test(u.pathname)) throw safeError();
  return u.toString().replace(/\/$/, "");
}
function safePath(path: string): string {
  if (typeof path !== "string" || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("%") || path.split("/").length > 32 || path.split("/").some(p => !p || p === "." || p === ".." || p.includes("\0"))) throw new Error("INVALID_SOURCE_PATH");
  return path;
}
function tokenValid(token: GitToken | string): string {
  const plain = typeof token === "string" ? token : token.plaintext;
  if (!/^(?:art_v1_|art_v2_x_)[0-9a-f]{40}\?expires=[0-9]+$/.test(plain)) throw safeError();
  if (typeof token !== "string") {
    const exp = Number(plain.slice(plain.lastIndexOf("=") + 1));
    const apiExp = Date.parse(token.expiresAt ?? "");
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + 300 || !Number.isFinite(apiExp) || Math.abs(apiExp / 1000 - exp) > 2) throw safeError();
  }
  return plain;
}
async function withInitialToken<T>(repo: Repo, secret: string, fn: (token: string, remote: string) => Promise<T>): Promise<T> {
  let result: T | undefined;
  let failure: unknown;
  try { result = await fn(tokenValid(secret), checkedRemote((await bounded(repo.info())).remote)); } catch { failure = safeError(); }
  let revoked = false;
  try { revoked = await bounded(repo.revokeToken(secret)); } catch { /* fail closed */ }
  if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
  if (failure) throw failure;
  return result as T;
}
function remoteFor(remote: string, token: string): GitRemote { return { url: checkedRemote(remote), auth: { bearer: token }, timeoutMs: 10_000, maxResponseBytes: 32 * 1024 * 1024 }; }
type GitHubImportCheck = "allowed" | "unavailable" | "denied";
async function githubImportAllowed(url: string): Promise<GitHubImportCheck> {
  if (url !== IMPORT_URL) return "denied";
  try {
    const r = await fetch("https://api.github.com/repos/octocat/Hello-World", { headers: { accept: "application/vnd.github+json", "user-agent": "Swarmflare" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if ([403, 429].includes(r.status) || r.status >= 500) return "unavailable";
    if (!r.ok || r.status >= 300) return "denied";
    const value = await r.json() as { full_name?: unknown; private?: unknown; size?: unknown };
    return value.full_name === "octocat/Hello-World" && value.private === false && typeof value.size === "number" && value.size >= 0 && value.size <= 1024 ? "allowed" : "denied";
  } catch { return "unavailable"; }
}
async function githubGitFallbackAllowed(): Promise<boolean> {
  try {
    const refs = await listRefs({ url: "https://github.com/octocat/Hello-World.git", timeoutMs: 5000, maxResponseBytes: 64 * 1024 }, { protocol: 2, prefixes: ["refs/heads/master"] });
    return refs.has("refs/heads/master");
  } catch { return false; }
}
async function sourceTuple(repo: Repo, ref: string): Promise<{ commitOid: string | null; treeOid: string | null }> {
  const token = await repo.createToken("read", 300);
  let tuple: { commitOid: string | null; treeOid: string | null } | undefined;
  let failure: unknown;
  try {
    tokenValid(token);
    const remote = checkedRemote((await bounded(repo.info())).remote);
    const refs = await listRefs(remoteFor(remote, token.plaintext), { protocol: 1, prefixes: [ref] });
    const commitOid = refs.get(ref) ?? null;
    if (!commitOid) tuple = { commitOid: null, treeOid: null };
    else {
      if (!OID.test(commitOid)) throw safeError();
      const objects = await parsePack(await fetchPack(remoteFor(remote, token.plaintext), { wants: [commitOid], ofsDelta: true }));
      const packedCommit = objects.find(object => object.type === "commit" && object.sha === commitOid);
      if (!packedCommit) throw safeError();
      const treeOid = decodeCommit(packedCommit.data).tree;
      if (!OID.test(treeOid) || !objects.some(object => object.type === "tree" && object.sha === treeOid)) throw safeError();
      tuple = { commitOid, treeOid };
    }
  } catch { failure = safeError(); }
  let revoked = false;
  try { revoked = await bounded(repo.revokeToken(token.id ?? token.plaintext)); } catch { /* fail closed */ }
  if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
  if (failure) throw failure;
  return tuple!;
}

export async function provisionRepository(binding: PlatformArtifactsBinding | undefined, input: { artifactsName: string; name: string; description: string; initializeReadme: boolean; importUrl?: string }): Promise<ProvisionedSource> {
  if (!binding || !validRepoName(input.artifactsName) || typeof input.name !== "string" || typeof input.description !== "string" || input.description.length > 500) throw safeError();
  if (input.importUrl !== undefined) {
    const check = await githubImportAllowed(input.importUrl);
    if (check === "denied") throw new Error("IMPORT_NOT_ALLOWED");
    if (check === "unavailable" && !await githubGitFallbackAllowed()) throw new Error("IMPORT_SOURCE_UNAVAILABLE");
    let created: { name: string; remote: string; defaultBranch: string; token: string };
      try { created = await bounded(binding.import({ source: { url: IMPORT_URL, branch: "master", depth: 1 }, target: { name: input.artifactsName, opts: { description: input.description, readOnly: false } } })); } catch { throw safeError(); }
    let remote: string;
    try { if (created.name !== input.artifactsName) throw safeError(); remote = checkedRemote(created.remote); if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(created.defaultBranch) || created.defaultBranch.includes("..") || created.defaultBranch.endsWith(".lock")) throw safeError(); }
    catch { await revokeInitial(binding, input.artifactsName, created.token); throw safeError(); }
    const importedRef = "refs/heads/master";
    let repo: Repo;
    try { repo = await getRepo(binding, input.artifactsName); } catch (error) {
      if (pendingProviderOperation(error)) return { status: "importing", artifactsName: input.artifactsName, remote, ref: importedRef, commitOid: null, treeOid: null, cleanupToken: created.token };
      await revokeInitial(binding, input.artifactsName, created.token);
      throw safeError();
    }
    try {
      const checked = checkedRemote((await repo.info()).remote);
      if (checked !== remote) throw safeError();
      const tuple = await sourceTuple(repo, importedRef);
      if (!tuple.commitOid || !tuple.treeOid) {
        let revoked = false;
        try { revoked = await bounded(repo.revokeToken(created.token)); } catch { /* fail closed */ }
        if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
        return { status: "importing", artifactsName: input.artifactsName, remote: checked, ref: importedRef, commitOid: null, treeOid: null };
      }
      let revoked = false;
      try { revoked = await bounded(repo.revokeToken(created.token)); } catch { /* fail closed */ }
      if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
      return { status: "ready", artifactsName: created.name, remote: checked, ref: importedRef, ...tuple };
    } catch (error) {
      if (error instanceof Error && error.message === "SOURCE_TOKEN_CLEANUP_FAILED") throw error;
      try { await bounded(repo.revokeToken(created.token)); } catch { /* do not leak provider errors */ }
      throw safeError();
    } finally { repo[Symbol.dispose](); }
  }
  let created: { name: string; remote: string; token: string };
  try { created = await bounded(binding.create(input.artifactsName, { description: input.description, readOnly: false, setDefaultBranch: "main" })); } catch { throw safeError(); }
  let remote: string;
  try { if (created.name !== input.artifactsName) throw safeError(); remote = checkedRemote(created.remote); }
  catch { await revokeInitial(binding, input.artifactsName, created.token); throw safeError(); }
  let repo: Repo;
  try { repo = await getRepo(binding, input.artifactsName); } catch (error) {
    if (pendingProviderOperation(error)) return { status: "importing", artifactsName: input.artifactsName, remote, ref: REF, commitOid: null, treeOid: null, cleanupToken: created.token };
    await revokeInitial(binding, input.artifactsName, created.token);
    throw safeError();
  }
  try {
    return await withInitialToken(repo, created.token, async (token, checked) => {
      if (!input.initializeReadme) return { status: "ready", artifactsName: created.name, remote: checked, ref: REF, commitOid: null, treeOid: null };
      const blobData = new TextEncoder().encode(`# ${input.name}\n\n${input.description || `A Swarmflare repository named ${input.name}.`}\n`);
      if (blobData.byteLength > MAX_README) throw safeError();
      const blob = { type: "blob" as const, data: blobData };
      const blobOid = await hashObject(blob);
      const treeData = encodeTree([{ mode: "100644", name: "README.md", sha: blobOid }]);
      const tree = { type: "tree" as const, data: treeData };
      const treeOid = await hashObject(tree);
      const signature = { name: "Swarmflare", email: "noreply@swarmflare.invalid", timestamp: Math.floor(Date.now() / 1000), timezone: "+0000" };
      const commitData = encodeCommit({ tree: treeOid, parents: [], author: signature, committer: signature, message: "Initialize repository\n" });
      const commit = { type: "commit" as const, data: commitData };
      const commitOid = await hashObject(commit);
      const pack = await buildPack([blob, tree, commit]);
      const git = remoteFor(checked, token);
      const refs = await listRefs(git, { service: "git-receive-pack", protocol: 1 });
      if (refs.has(REF)) throw safeError();
      assertRefUpdated(await receivePack(git, [{ ref: REF, oldSha: "0".repeat(40), newSha: commitOid }], pack), REF);
      const readback = await listRefs(git, { protocol: 1, prefixes: [REF] });
      if (readback.get(REF) !== commitOid) throw safeError();
      const objects = await parsePack(await fetchPack(git, { wants: [commitOid] }));
      if (!objects.some(o => o.sha === commitOid && o.type === "commit") || !objects.some(o => o.sha === treeOid && o.type === "tree") || !objects.some(o => o.sha === blobOid && o.type === "blob" && o.data.every((v, i) => v === blobData[i]))) throw safeError();
      return { status: "ready", artifactsName: created.name, remote: checked, ref: REF, commitOid, treeOid };
    });
  } finally { repo[Symbol.dispose](); }
}

export async function refreshRepository(binding: PlatformArtifactsBinding | undefined, stored: ProvisionedSource): Promise<ProvisionedSource> {
  if (!binding || !validRepoName(stored.artifactsName)) throw safeError();
  let repo: Repo;
  try { repo = await binding.get(stored.artifactsName); } catch (error) {
    if (pendingProviderOperation(error)) return { ...stored, status: "importing", commitOid: null, treeOid: null };
    throw safeError();
  }
  try {
    const remote = checkedRemote((await bounded(repo.info())).remote);
    if (remote !== checkedRemote(stored.remote)) throw safeError();
    const tuple = await sourceTuple(repo, stored.ref);
    if (!tuple.commitOid || !tuple.treeOid) {
      if (stored.cleanupToken) {
        let revoked = false;
        try { revoked = await bounded(repo.revokeToken(stored.cleanupToken)); } catch { /* fail closed */ }
        if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
      }
      return { status: "importing", artifactsName: stored.artifactsName, remote, ref: stored.ref, commitOid: null, treeOid: null };
    }
    if (stored.commitOid && (tuple.commitOid !== stored.commitOid || tuple.treeOid !== stored.treeOid)) throw safeError();
    if (stored.cleanupToken) {
      let revoked = false;
      try { revoked = await repo.revokeToken(stored.cleanupToken); } catch { /* fail closed */ }
      if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
    }
    return { status: "ready", artifactsName: stored.artifactsName, remote, ref: stored.ref, ...tuple };
  } catch (error) { if (error instanceof Error && error.message === "SOURCE_TOKEN_CLEANUP_FAILED") throw error; throw safeError(); }
  finally { repo[Symbol.dispose](); }
}

export async function readRepositorySource(binding: PlatformArtifactsBinding | undefined, stored: ProvisionedSource, path: string): Promise<ReadResult> {
  if (!binding || stored.status !== "ready" || !validRepoName(stored.artifactsName)) throw safeError();
  const safe = path === "" ? "" : safePath(path);
  let repo: Repo;
  try { repo = await binding.get(stored.artifactsName); } catch { throw safeError(); }
  try {
    const info = await repo.info();
    const remote = checkedRemote(info.remote);
    if (remote !== checkedRemote(stored.remote)) throw safeError();
    if (!stored.commitOid || !stored.treeOid) return { commitOid: null, treeOid: null, entries: [] };
    const token = await repo.createToken("read", 300);
    let tokenText = token.plaintext;
    let objects;
    try {
      tokenText = tokenValid(token);
      objects = await parsePack(await fetchPack(remoteFor(remote, tokenText), { wants: [stored.commitOid], ofsDelta: true }));
    } finally {
      let revoked = false; try { revoked = await bounded(repo.revokeToken(token.id ?? tokenText)); } catch { /* fail closed */ }
      if (!revoked) throw new Error("SOURCE_TOKEN_CLEANUP_FAILED");
    }
    const byOid = new Map(objects.map(object => [object.sha, object]));
    const commit = byOid.get(stored.commitOid);
    if (!commit || commit.type !== "commit" || decodeCommit(commit.data).tree !== stored.treeOid) throw safeError();
    const treeObj = byOid.get(stored.treeOid);
    if (!treeObj || treeObj.type !== "tree") throw safeError();
    const entries: Entry[] = [];
    let file: ReadResult["file"];
    if (safe) {
      const parts = safe.split("/");
      let treeOid = stored.treeOid;
      for (let i = 0; i < parts.length; i++) {
        const treeObj = byOid.get(treeOid);
        if (!treeObj || treeObj.type !== "tree") throw safeError();
        const tree = decodeTree(treeObj.data);
        if (tree.length > 512) throw safeError();
        const entry = tree.find(e => e.name === parts[i]);
        if (!entry || !OID.test(entry.sha)) throw new Error("SOURCE_PATH_NOT_FOUND");
        if (i < parts.length - 1) {
          if (entry.mode !== "40000" && entry.mode !== "040000") throw new Error("SOURCE_PATH_NOT_FOUND");
          treeOid = entry.sha;
        } else if (entry.mode === "40000" || entry.mode === "040000") {
          treeOid = entry.sha;
          const childObj = byOid.get(treeOid); if (!childObj || childObj.type !== "tree") throw safeError();
          const children = decodeTree(childObj.data); if (children.length > 512) throw safeError();
          for (const child of children) entries.push({ name: child.name, path: `${safe}/${child.name}`, kind: child.mode === "40000" || child.mode === "040000" ? "directory" : child.mode.startsWith("100") ? "file" : "unsupported", oid: child.sha });
        } else if (entry.mode.startsWith("100")) {
          const blob = byOid.get(entry.sha); if (!blob || blob.type !== "blob" || blob.data.length > MAX_FILE || await hashObject(blob) !== entry.sha) throw safeError();
          file = { path: safe, content: new TextDecoder("utf-8", { fatal: true }).decode(blob.data) };
        } else entries.push({ name: parts[i]!, path: safe, kind: "unsupported", oid: entry.sha });
      }
    } else {
      const children = decodeTree(treeObj.data); if (children.length > 512) throw safeError();
      for (const child of children) entries.push({ name: child.name, path: child.name, kind: child.mode === "40000" || child.mode === "040000" ? "directory" : child.mode.startsWith("100") ? "file" : "unsupported", oid: child.sha });
    }
    let readme: string | undefined;
    if (!safe) {
      const entry = decodeTree(treeObj.data).find(child => /^readme(?:\.(?:md|markdown|txt|rst))?$/i.test(child.name) && child.mode === "100644");
      const blob = entry && byOid.get(entry.sha);
      if (entry && blob?.type === "blob" && blob.data.length <= MAX_README && await hashObject(blob) === entry.sha) readme = new TextDecoder("utf-8", { fatal: true }).decode(blob.data);
    }
    return { commitOid: stored.commitOid, treeOid: stored.treeOid, entries, ...(file ? { file } : {}), ...(readme !== undefined ? { readme } : {}) };
  } finally { repo[Symbol.dispose](); }
}