/**
 * Smart HTTP transport and ref discovery.
 * See git Documentation/gitprotocol-http.txt "Smart Clients" / "Smart Service git-upload-pack",
 * gitprotocol-pack.txt "Reference Discovery" (v0/v1) and gitprotocol-v2.txt "ls-refs".
 */
import { type Bytes, base64, isSha, own, ZERO_SHA } from "./bytes.js";
import { GitHttpError, GitProtocolError } from "./errors.js";
import { DELIM, encodeLines, FLUSH, payloadsUntilFlush, pktText, readPktLines } from "./pktline.js";

export type GitAuth = { bearer: string } | { basic: { username: string; password: string } };

export interface GitRemote {
  /** Repository URL ending in `.git`, e.g. `https://<acct>.artifacts.cloudflare.net/git/ns/repo.git`. */
  url: string;
  auth?: GitAuth;
  /** Custom fetch (service bindings, tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Maximum downloaded response size. Defaults to 32 MiB. */
  maxResponseBytes?: number;
  /** Per-exchange timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export type GitService = "git-upload-pack" | "git-receive-pack";

/** Sent as `agent=` (gitprotocol-capabilities.txt "agent"); also the User-Agent prefix. */
export const AGENT = "gittifacts/0";

/**
 * One smart-HTTP exchange. Without a body: GET `info/refs?service=…` (the v1 ref advertisement or
 * the v2 capability advertisement). With a body: POST a stateless RPC request to `/<service>`.
 */
export async function request(
  remote: GitRemote,
  service: GitService,
  v2: boolean,
  body?: Uint8Array,
): Promise<Bytes> {
  let url: URL;
  try { url = new URL(remote.url); }
  catch { throw new TypeError("Git remote URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("Git remote URL must be credential-free HTTPS without query or fragment");
  }
  if (remote.auth && ("bearer" in remote.auth
    ? !remote.auth.bearer || /[\r\n]/.test(remote.auth.bearer)
    : !remote.auth.basic.username || /[\r\n]/.test(remote.auth.basic.username + remote.auth.basic.password))) {
    throw new TypeError("invalid Git authentication value");
  }
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_TIMEOUT_MS = 120_000;
  const maxBytes = remote.maxResponseBytes ?? MAX_BYTES;
  const timeoutMs = remote.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("invalid Git transport bounds");
  }
  if (body && body.byteLength > MAX_BYTES) throw new TypeError("Git request body exceeds size limit");
  const type = `application/x-${service}-${body ? "result" : "advertisement"}`;
  // Some hosts only speak the smart protocol to user agents starting with "git/".
  const headers = new Headers({ "User-Agent": `git/${AGENT}`, Accept: type });
  if (body) headers.set("Content-Type", `application/x-${service}-request`);
  if (v2) headers.set("Git-Protocol", "version=2");
  const auth = remote.auth;
  if (auth && "bearer" in auth) headers.set("Authorization", `Bearer ${auth.bearer}`);
  else if (auth)
    headers.set(
      "Authorization",
      `Basic ${base64(`${auth.basic.username}:${auth.basic.password}`)}`,
    );
  const path = body ? service : `info/refs?service=${service}`;
  const init: RequestInit = { method: body ? "POST" : "GET", headers };
  if (body) init.body = own(body);
  init.redirect = "manual";
  const controller = new AbortController();
  init.signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new GitHttpError(408, `${init.method} ${path}: request timed out`);
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(timeoutError); }, timeoutMs);
  });
  const cancelBody = (response: Response): void => {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
  };
  const fetchPromise = Promise.resolve().then(() => (remote.fetch ?? fetch)(`${url.href.replace(/\/+$/, "")}/${path}`, init));
  void fetchPromise.then((response) => { if (timedOut) cancelBody(response); }, () => undefined);
  try {
    let res: Response;
    try { res = await Promise.race([fetchPromise, timeout]); }
    catch (error) {
      if (error === timeoutError) throw timeoutError;
      throw new GitHttpError(502, `${init.method} ${path}: network request failed`);
    }
  if (!res.ok) {
    cancelBody(res);
    throw new GitHttpError(res.status, `${init.method} ${path}: HTTP ${res.status}`);
  }
  // gitprotocol-http.txt: clients MUST check the Content-Type of smart responses.
  const ct = res.headers.get("Content-Type");
  if (res.status >= 300 && res.status < 400) {
    cancelBody(res);
    throw new GitHttpError(res.status, `${init.method} ${path}: redirect refused`);
  }
  if (!ct || ct.split(";", 1)[0]!.trim().toLowerCase() !== type) {
    cancelBody(res);
    throw new GitHttpError(res.status, `${path}: unexpected Git response Content-Type`);
  }
  const length = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) {
    cancelBody(res);
    throw new GitHttpError(res.status, `${path}: response exceeds size limit`);
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await Promise.race([reader.read(), timeout]); }
    catch (error) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      try { reader.releaseLock(); } catch { /* pending reads can prevent release */ }
      if (error === timeoutError) throw timeoutError;
      throw new GitHttpError(502, `${init.method} ${path}: response read failed`);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw new GitHttpError(res.status, `${path}: response exceeds size limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Refs → SHA. Peeled tags appear as `refs/tags/x^{}` (like `git ls-remote`). */
export type RefMap = Map<string, string> & {
  /** Symbolic refs, e.g. HEAD → refs/heads/main. */
  symrefs: Map<string, string>;
  /** Server capabilities (v1 list from the first ref line, or v2 advertisement keys/values). */
  capabilities: Set<string>;
  protocol: 1 | 2;
};

export interface ListRefsOptions {
  /** 2 (default) uses `ls-refs` when the server speaks v2 and falls back to v1 otherwise. */
  protocol?: 1 | 2;
  /** Only return refs starting with one of these (HEAD is matched by "HEAD"). */
  prefixes?: string[];
  /** `git-receive-pack` returns the push advertisement (always v1), incl. its capabilities. */
  service?: GitService;
}

function refMap(protocol: 1 | 2): RefMap {
  return Object.assign(new Map<string, string>(), {
    symrefs: new Map<string, string>(),
    capabilities: new Set<string>(),
    protocol,
  });
}

/** Advertisement payloads, minus the "# service=<name>" line + flush smart HTTP prepends. */
function advertisedLines(buf: Uint8Array): Bytes[] {
  const lines = [...readPktLines(buf)];
  const first = lines[0];
  if (first?.type === "data" && pktText(first.data).startsWith("# service=")) {
    lines.splice(0, lines[1]?.type === "flush" ? 2 : 1); // gitprotocol-http.txt "Smart Clients"
  }
  return payloadsUntilFlush(lines);
}

/** gitprotocol-pack.txt "Reference Discovery": `<sha> <ref>[\0<caps>]` lines. */
function parseV1(lines: Bytes[], out: RefMap): void {
  for (const [i, raw] of lines.entries()) {
    let line = pktText(raw);
    if (i === 0) {
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(" ")) {
          if (!cap) continue;
          out.capabilities.add(cap);
          const m = /^symref=([^:]+):(.+)$/.exec(cap);
          if (m) out.symrefs.set(m[1]!, m[2]!);
        }
        line = line.slice(0, nul);
      }
    }
    if (line.startsWith("shallow ")) continue;
    const [sha, ref] = line.split(" ");
    if (!sha || !ref || !isSha(sha)) throw new GitProtocolError(`bad ref line: ${line}`);
    // An empty repo advertises `<zero-id> capabilities^{}` just to carry the capability list.
    if (ref === "capabilities^{}" && sha === ZERO_SHA) continue;
    out.set(ref, sha);
  }
}

/** Lists remote refs. v2 sends `ls-refs` with `peel` + `symrefs`; v1 parses the advertisement. */
export async function listRefs(remote: GitRemote, opts: ListRefsOptions = {}): Promise<RefMap> {
  const service = opts.service ?? "git-upload-pack";
  // receive-pack is v1 only on Artifacts (and in git itself), so never ask it for v2.
  const wantV2 = opts.protocol !== 1 && service === "git-upload-pack";
  const adv = advertisedLines(await request(remote, service, wantV2));
  let refs: RefMap;
  if (wantV2 && adv[0] && pktText(adv[0]) === "version 2") {
    refs = refMap(2);
    for (const cap of adv.slice(1)) refs.capabilities.add(pktText(cap));
    const args = ["peel\n", "symrefs\n", ...(opts.prefixes ?? []).map((p) => `ref-prefix ${p}\n`)];
    const body = encodeLines(["command=ls-refs\n", `agent=${AGENT}\n`, DELIM, ...args, FLUSH]);
    // gitprotocol-v2.txt "ls-refs": `<oid> <ref>[ symref-target:<t>][ peeled:<oid>]`.
    const res = await request(remote, "git-upload-pack", true, body);
    for (const raw of payloadsUntilFlush(readPktLines(res))) {
      const [sha, ref, ...attrs] = pktText(raw).split(" ");
      if (!sha || !ref || !isSha(sha))
        throw new GitProtocolError(`bad ls-refs line: ${pktText(raw)}`);
      refs.set(ref, sha);
      for (const a of attrs) {
        if (a.startsWith("symref-target:")) refs.symrefs.set(ref, a.slice(14));
        else if (a.startsWith("peeled:")) refs.set(`${ref}^{}`, a.slice(7));
      }
    }
  } else {
    refs = refMap(1);
    parseV1(adv, refs);
  }
  const prefixes = opts.prefixes;
  if (prefixes) {
    for (const ref of [...refs.keys()]) {
      if (!prefixes.some((p) => ref.startsWith(p))) refs.delete(ref);
    }
  }
  return refs;
}
