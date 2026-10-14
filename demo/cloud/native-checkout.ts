import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { decodeCommit } from "../../packages/git-transport/objects.js";
import { listRefs, type GitRemote } from "../../packages/git-transport/http.js";
import { fetchPack } from "../../packages/git-transport/upload.js";
import { parsePack } from "../../packages/git-transport/pack.js";

export const PROJECT_ID = "fc34f086-87da-4067-a648-484af2297bd7";
export const ACCOUNT_ID = "cb50a73b7487ae7039cbc8b613986b8b";
export const NAMESPACE = "git-collaboration-demo-c29";
export const REPOSITORY = `sf-${PROJECT_ID}`;
const API = "https://api.cloudflare.com/client/v4";
const MAX_PACK = 32 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;
const REF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXEC = promisify(execFile);

export type NativeCheckoutInput = { ref: string; commitOid: string; treeOid: string; barePath: string };
export type NativeCheckoutResult = { ref: string; commitOid: string; treeOid: string; tokenRevoked: true };
export type ApiResponse = { status: number; body: unknown };
export type NativeCheckoutDependencies = Partial<{
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ApiResponse>;
  authCheck(): Promise<string>;
  readOAuthToken(): Promise<string>;
  cacheRoot?: string;
  testScratchPath?: string;
  now?: () => number;
  git?: (args: string[], input?: Uint8Array) => Promise<string>;
  gitFetch?: typeof fetch;
}>;
const failure = () => new Error("NATIVE_SOURCE_UNAVAILABLE");


function validate(input: NativeCheckoutInput, deps: NativeCheckoutDependencies): { ref: string; path: string } {
  if (!input || !OID.test(input.commitOid) || !OID.test(input.treeOid) || typeof input.ref !== "string" || typeof input.barePath !== "string") throw failure();
  const match = /^refs\/agent\/(seeds|views)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(input.ref);
  const revision = /^refs\/agent\/revisions\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(input.ref);
  const allowedRef = match ? REF_ID.test(match[2]!) : revision ? REF_ID.test(revision[1]!)&&REF_ID.test(revision[2]!) : input.ref === "refs/heads/main";
  if (!allowedRef) throw failure();
  const path = resolve(input.barePath);
  const root = resolve(deps.cacheRoot ?? resolve(".local/cloud-cont47"));
  const test = deps.testScratchPath && resolve(deps.testScratchPath);
  const within = (parent: string) => { const rel = relative(parent, path); return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel)); };
  if (!((within(resolve(root, "cache.git")) && path === resolve(root, "cache.git")) || (test && within(test)))) throw failure();
  return { ref: input.ref, path };
}
function checkedRemote(value: unknown): string {
  if (typeof value !== "string") throw failure();
  let url: URL;
  try { url = new URL(value); } catch { throw failure(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.href.includes("%") || url.href.includes("\\") || !/^[a-z0-9-]+\.artifacts\.cloudflare\.net$/.test(url.hostname) || url.pathname !== `/git/${NAMESPACE}/${REPOSITORY}.git`) throw failure();
  return url.href.replace(/\/$/, "");
}
function tokenFields(value: unknown, now: number): { id: string; plaintext: string } {
  if (!value || typeof value !== "object") throw failure();
  const v = value as Record<string, unknown>;
  const id = v.id;
  const plaintext = v.plaintext;
  const expiresAt = v.expires_at;
  if (typeof id !== "string" || !/^[0-9a-z]{16}$/.test(id) || typeof plaintext !== "string" || !/^art_v[12]_(?:x_)?[0-9a-f]{40}\?expires=[0-9]+$/.test(plaintext) || typeof expiresAt !== "string") throw failure();
  const expiry = Number(plaintext.slice(plaintext.lastIndexOf("=") + 1));
  const apiExpiry = Date.parse(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(now / 1000) || expiry > Math.floor(now / 1000) + 60 || !Number.isFinite(apiExpiry) || Math.abs(apiExpiry / 1000 - expiry) > 2) throw failure();
  return { id, plaintext };
}
async function checkBarePath(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw failure();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure();
  }
}
function success(response: ApiResponse): Record<string, unknown> {
  if (![200,201].includes(response.status) || !response.body || typeof response.body !== "object") throw failure();
  const envelope = response.body as Record<string, unknown>;
  if (envelope.success !== true || !envelope.result || typeof envelope.result !== "object") throw failure();
  return envelope.result as Record<string, unknown>;
}
async function defaultAuthCheck(): Promise<string> {
  const exe = resolve(homedir(), ".local/share/cf-cli/node_modules/.bin/cf");
  const { stdout } = await EXEC(exe, ["auth", "whoami"], { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true });
  return stdout;
}
async function defaultOAuthToken(): Promise<string> {
  const path = resolve(homedir(), ".config/cloudflare/config/default.json");
  const config = JSON.parse(await readFile(path, "utf8")) as { oauth_token?: unknown };
  if (typeof config.oauth_token !== "string" || !config.oauth_token) throw failure();
  return config.oauth_token;
}
function apiRequest(token: string) {
  return async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<ApiResponse> => {
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
  };
}
async function gitDefault(bare: string, args: string[], input?: Uint8Array): Promise<string> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.replaceRefs", GIT_CONFIG_VALUE_1: "false", GIT_NO_REPLACE_OBJECTS: "1", GIT_COMMITTER_NAME: "native-checkout", GIT_COMMITTER_EMAIL: "native-checkout@invalid" };
  return await new Promise<string>((resolveOutput, reject) => {
    const child = spawn("git", ["--git-dir", bare, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = ""; let byteCount = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { byteCount += chunk.length; if (byteCount <= 64 * 1024) stdout += chunk.toString("utf8"); else child.kill("SIGKILL"); });
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(failure()); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0 && byteCount <= 64 * 1024) resolveOutput(stdout.trim()); else reject(failure()); });
    child.stdin.end(input);
  });
}

export async function checkoutExactNativeSource(input: NativeCheckoutInput, dependencies: NativeCheckoutDependencies = {}): Promise<NativeCheckoutResult> {
  const checked = validate(input, dependencies);
  await checkBarePath(checked.path);
  const now = dependencies.now ?? Date.now;
  const git = dependencies.git ?? ((args, bytes) => gitDefault(checked.path, args, bytes));
  // The injected fixture path is exclusively for synthetic tests; callers cannot broaden the cache root.
  let authText: string;
  try { authText = await (dependencies.authCheck ?? defaultAuthCheck)(); } catch { throw failure(); }
  let auth: Record<string, unknown>;
  try { auth = JSON.parse(authText) as Record<string, unknown>; } catch { throw failure(); }
  const accounts = Array.isArray(auth.accounts) ? auth.accounts : [];
  if (auth.authenticated !== true || auth.tokenValid !== true || !accounts.some((a) => !!a && typeof a === "object" && (a as Record<string, unknown>).id === ACCOUNT_ID)) throw failure();
  let oauth: string;
  try { oauth = await (dependencies.readOAuthToken ?? defaultOAuthToken)(); } catch { throw failure(); }
  if (!oauth) throw failure();
  const call = dependencies.request ?? apiRequest(oauth);
  const prefix = `/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NAMESPACE}`;
  let token: { id: string; plaintext: string } | undefined;
  let primaryError: Error | undefined;
  let result: NativeCheckoutResult | undefined;
  try {
    const repository = success(await call("GET", `${prefix}/repos/${REPOSITORY}`));
    const remote = checkedRemote(repository.remote);
    const issued = success(await call("POST", `${prefix}/tokens`, { repo: REPOSITORY, scope: "read", ttl: 60 }));
    if (typeof issued.id === "string" && /^[0-9a-z]{16}$/.test(issued.id)) token = { id: issued.id, plaintext: "" };
    const checkedToken = tokenFields(issued, now());
    token = checkedToken;
    const gitRemote: GitRemote = { url: remote, auth: { bearer: token.plaintext }, timeoutMs: 10_000, maxResponseBytes: MAX_PACK, ...(dependencies.gitFetch ? { fetch: dependencies.gitFetch } : {}) };
    const refs = await listRefs(gitRemote, { protocol: 1, prefixes: [checked.ref] });
    if (refs.get(checked.ref) !== input.commitOid) throw failure();
    const pack = await fetchPack(gitRemote, { wants: [input.commitOid], ofsDelta: true });
    if (pack.byteLength > MAX_PACK) throw failure();
    const objects = await parsePack(pack, MAX_PACK);
    const commit = objects.find((object) => object.type === "commit" && object.sha === input.commitOid);
    if (!commit || decodeCommit(commit.data).tree !== input.treeOid || !objects.some((object) => object.type === "tree" && object.sha === input.treeOid)) throw failure();
    await mkdir(dirname(checked.path), { recursive: true, mode: 0o700 });
    try { await lstat(checked.path); } catch { await (dependencies.git ? Promise.resolve() : EXEC("git", ["init", "--bare", "--quiet", checked.path], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true })); }
    await git(["index-pack", "--stdin"], pack);
    const existing = await git(["show-ref", "--verify", "--hash", checked.ref]).catch(() => "");
    if (existing !== "" && existing !== input.commitOid) throw failure();
    if (existing === "") await git(["update-ref", checked.ref, input.commitOid, "0".repeat(40)]);
    const actualCommit = await git(["rev-parse", `${checked.ref}^{commit}`]);
    const actualTree = await git(["show", "-s", "--format=%T", actualCommit]);
    if (actualCommit !== input.commitOid || actualTree !== input.treeOid || await git(["cat-file", "-t", input.treeOid]) !== "tree") throw failure();
    result = { ref: checked.ref, commitOid: actualCommit, treeOid: actualTree, tokenRevoked: true };
  } catch (error) { primaryError = error instanceof Error && error.message === "NATIVE_SOURCE_UNAVAILABLE" ? error : failure(); }
  let revoked = false;
  if (token) {
    try {
      const response = await call("DELETE", `${prefix}/tokens/${token.id}`);
      revoked = response.status === 200 && !!response.body && typeof response.body === "object" && (response.body as Record<string, unknown>).success === true;
    } catch { revoked = false; }
  }
  // Do not report provider errors, argv, OAuth values, token IDs, or token material.

  if (token && !revoked) throw new Error("NATIVE_TOKEN_CLEANUP_FAILED");
  if (primaryError) throw primaryError;
  if (!result) throw failure();
  return result;
}
