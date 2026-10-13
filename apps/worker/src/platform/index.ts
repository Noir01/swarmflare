import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { hashPassword, randomToken, sha256, verifyPassword } from './security';
import { provisionRepository, readRepositorySource, refreshRepository, type PlatformArtifactsBinding, type ProvisionedSource } from './repository-source';

interface Env { ARTIFACTS?: PlatformArtifactsBinding; PROJECTS: DurableObjectNamespace }
type RepoRow = { id: string; owner: string; ownerId: string; name: string; description: string; project: string; status: string; created: number; artifacts: string; source: string | null; error: string | null };
type Session = { user: { id: string; username: string }; csrf: string; expires: number; token: string };
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers });
const fail = (code: string, message: string, status: number) => json({ code, message }, status);
const cookieName = 'sf_session';
const cookie = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const signupSchema = z.object({ username: z.string().regex(/^[a-z0-9-]{3,32}$/i).transform(v => v.toLowerCase()), email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(8).max(128) }).strict();
const loginSchema = z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }).strict();
const repoSchema = z.object({ name: z.string().regex(/^[a-z0-9-]{3,64}$/i).transform(v => v.toLowerCase()), description: z.string().max(500).optional(), initializeReadme: z.boolean().optional(), importUrl: z.string().max(512).optional() }).strict();
const grantSchema = z.object({ role: z.enum(['contributor', 'reviewer']), expiresInSeconds: z.number().int().min(60).max(3600) }).strict();
const safeSource = (s: ProvisionedSource) => ({ ref: s.ref, commitOid: s.commitOid, treeOid: s.treeOid });

export class Platform extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE,email TEXT UNIQUE,salt TEXT,ph TEXT,created INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT,csrf TEXT,expires INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS repos(id TEXT PRIMARY KEY,owner TEXT,ownerId TEXT,name TEXT,description TEXT,project TEXT UNIQUE,status TEXT,created INTEGER,artifacts TEXT,source TEXT,error TEXT,UNIQUE(owner,name))');
    try { sql.exec('ALTER TABLE repos ADD COLUMN source TEXT'); } catch { /* already migrated */ }
    try { sql.exec('ALTER TABLE repos ADD COLUMN error TEXT'); } catch { /* already migrated */ }
    sql.exec('CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,repo TEXT,token TEXT UNIQUE,role TEXT,expires INTEGER,revoked INTEGER DEFAULT 0)');
  }
  private one<T>(query: string, ...args: (string | number)[]): T | null { return (this.ctx.storage.sql.exec<Record<string, any>>(query, ...args).toArray()[0] as T | undefined) ?? null; }
  private rows<T>(query: string, ...args: (string | number)[]): T[] { return this.ctx.storage.sql.exec<Record<string, any>>(query, ...args).toArray() as T[]; }
  private async body(request: Request): Promise<unknown> {
    const reader = request.body?.getReader(); if (!reader) return {};
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw new Error('PAYLOAD_TOO_LARGE'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  private parsed<T>(schema: z.ZodType<T>, value: unknown): T | null { const result = schema.safeParse(value); return result.success ? result.data : null; }
  private async session(request: Request): Promise<Session | null> {
    const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token) return null;
    const stored = this.one<{ uid: string; csrf: string; expires: number }>('SELECT uid,csrf,expires FROM sessions WHERE token=?', await sha256(token));
    if (!stored || stored.expires <= Date.now()) return null;
    const user = this.one<{ id: string; username: string }>('SELECT id,username FROM accounts WHERE id=?', stored.uid);
    return user ? { ...stored, user, token } : null;
  }
  private sameOrigin(request: Request): boolean { return request.headers.get('origin') === new URL(request.url).origin; }
  private writeAllowed(request: Request, session: Session | null): boolean { return !!session && this.sameOrigin(request) && request.headers.get('x-csrf-token') === session.csrf; }
  private repo(row: RepoRow) {
    const source = row.source ? JSON.parse(row.source) as ProvisionedSource : null;
    return { id: row.id, owner: row.owner, ownerId: row.ownerId, name: row.name, description: row.description, projectId: row.project, status: row.status, createdAt: row.created, ...(source ? { source: safeSource(source) } : {}), ...(row.error ? { error: row.error } : {}) };
  }
  private async issue(uid: string, status: number): Promise<Response> {
    const token = randomToken(), csrf = randomToken(), expires = Date.now() + 900000;
    this.ctx.storage.sql.exec('INSERT INTO sessions VALUES(?,?,?,?)', await sha256(token), uid, csrf, expires);
    const user = this.one<{ id: string; username: string }>('SELECT id,username FROM accounts WHERE id=?', uid)!;
    return json({ user, csrf, expiresAt: expires }, status, { 'Set-Cookie': cookie(token, 900) });
  }
  private sourceFrom(row: RepoRow): ProvisionedSource | null { return row.source ? JSON.parse(row.source) as ProvisionedSource : null; }
  private async provision(row: RepoRow, input: { initializeReadme: boolean; importUrl?: string }): Promise<RepoRow> {
    try {
      const source = await provisionRepository(this.env.ARTIFACTS, { artifactsName: row.artifacts, name: row.name, description: row.description, initializeReadme: input.initializeReadme, ...(input.importUrl ? { importUrl: input.importUrl } : {}) });
      this.ctx.storage.sql.exec('UPDATE repos SET status=?,source=?,error=NULL WHERE id=?', source.status, JSON.stringify(source), row.id);
    } catch (error) {
      const code = error instanceof Error && ['IMPORT_NOT_ALLOWED', 'SOURCE_TOKEN_CLEANUP_FAILED'].includes(error.message) ? error.message : 'SOURCE_UNAVAILABLE';
      this.ctx.storage.sql.exec("UPDATE repos SET status='failed',error=? WHERE id=?", code, row.id);
    }
    return this.one<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos WHERE id=?', row.id)!;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname.replace(/^\/api\/platform/, '') || '/', method = request.method;
    try {
      if (path === '/auth/session' && method === 'GET') { const s = await this.session(request); return json(s ? { user: s.user, csrf: s.csrf, expiresAt: s.expires } : { user: null }); }
      if (['/auth/signup', '/auth/login', '/auth/logout'].includes(path) && method === 'POST' && !this.sameOrigin(request)) return fail('CSRF', 'Request origin invalid', 403);
      if (path === '/auth/signup' && method === 'POST') {
        const input = this.parsed(signupSchema, await this.body(request)); if (!input) return fail('INVALID_REQUEST', 'Invalid signup details', 400);
        const id = crypto.randomUUID(), password = await hashPassword(input.password);
        try { this.ctx.storage.sql.exec('INSERT INTO accounts VALUES(?,?,?,?,?,?)', id, input.username, input.email, password.salt, password.hash, Date.now()); } catch { return fail('IDENTITY_EXISTS', 'Username or email is already registered', 409); }
        return this.issue(id, 201);
      }
      if (path === '/auth/login' && method === 'POST') {
        const input = this.parsed(loginSchema, await this.body(request)); if (!input) return fail('INVALID_REQUEST', 'Invalid login details', 400);
        const login = input.login.toLowerCase(), account = this.one<{ id: string; salt: string; ph: string }>('SELECT id,salt,ph FROM accounts WHERE username=? OR email=?', login, login);
        if (!account || !await verifyPassword(input.password, account.salt, account.ph)) return fail('UNAUTHORIZED', 'Invalid login', 401);
        return this.issue(account.id, 200);
      }
      if (path === '/auth/logout' && method === 'POST') { const s = await this.session(request); if (s && !this.writeAllowed(request, s)) return fail('CSRF', 'CSRF token invalid', 403); if (s) this.ctx.storage.sql.exec('DELETE FROM sessions WHERE token=?', await sha256(s.token)); return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
      if (path === '/internal/authorize-project' && method === 'POST') return this.authorizeProject(request);
      const session = await this.session(request);
      const detail = path.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(source|agents)(?:\/([^/]+))?)?$/);
      if (path === '/repos' && method === 'GET') return json({ repositories: this.rows<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos ORDER BY created DESC').map(row => this.repo(row)) });
      if (path === '/repos' && method === 'POST') {
        if (!this.writeAllowed(request, session)) return fail('FORBIDDEN', 'Authenticated owner session required', 403);
        const input = this.parsed(repoSchema, await this.body(request)); if (!input) return fail('INVALID_REQUEST', 'Invalid repository details', 400);
        const id = crypto.randomUUID(), row: RepoRow = { id, owner: session!.user.username, ownerId: session!.user.id, name: input.name, description: input.description ?? '', project: id, status: 'provisioning', created: Date.now(), artifacts: `sf-${id}`, source: null, error: null };
        try { this.ctx.storage.sql.exec('INSERT INTO repos(id,owner,ownerId,name,description,project,status,created,artifacts,source,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)', row.id, row.owner, row.ownerId, row.name, row.description, row.project, row.status, row.created, row.artifacts, null, null); } catch { return fail('REPOSITORY_EXISTS', 'Repository already exists', 409); }
        const provisioned = await this.provision(row, { initializeReadme: input.initializeReadme ?? true, ...(input.importUrl ? { importUrl: input.importUrl } : {}) });
        return json({ repository: this.repo(provisioned) }, 201);
      }
      if (detail) {
        const [, owner, name, action, extra] = detail;
        const row = this.one<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos WHERE owner=? AND name=?', owner!, name!);
        if (!row) return fail('NOT_FOUND', 'Repository not found', 404);
        if (!action && method === 'GET') return json({ repository: this.repo(row) });
        if (action === 'source' && method === 'GET') {
          const stored = this.sourceFrom(row); if (row.status !== 'ready' || !stored) return fail('SOURCE_NOT_READY', 'Repository source is not ready', 409);
          try { return json(await readRepositorySource(this.env.ARTIFACTS, stored, url.searchParams.get('path') ?? '')); } catch (error) { return fail(error instanceof Error && error.message === 'SOURCE_PATH_NOT_FOUND' ? 'NOT_FOUND' : 'SOURCE_UNAVAILABLE', 'Repository source unavailable', error instanceof Error && error.message === 'SOURCE_PATH_NOT_FOUND' ? 404 : 503); }
        }
        if (action === 'refresh' && method === 'POST') {
          if (!this.writeAllowed(request, session) || session!.user.id !== row.ownerId) return fail('FORBIDDEN', 'Repository owner required', 403);
          if (row.status !== 'importing') return fail('INVALID_STATE', 'Repository is not importing', 409);
          const stored = this.sourceFrom(row); if (!stored) return fail('INVALID_STATE', 'Repository source is unavailable', 409);
          try { const refreshed = await refreshRepository(this.env.ARTIFACTS, stored); this.ctx.storage.sql.exec('UPDATE repos SET status=?,source=?,error=NULL WHERE id=?', refreshed.status, JSON.stringify(refreshed), row.id); }
          catch { this.ctx.storage.sql.exec("UPDATE repos SET status='failed',error='SOURCE_UNAVAILABLE' WHERE id=?", row.id); }
          const next = this.one<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos WHERE id=?', row.id)!;
          return json({ repository: this.repo(next) });
        }
        if (action === 'agents' && method === 'GET') {
          if (!session || session.user.id !== row.ownerId) return fail('FORBIDDEN', 'Repository owner required', 403);
          return json({ grants: this.rows<{ id: string; role: string; expires: number }>('SELECT id,role,expires FROM grants WHERE repo=? AND revoked=0 AND expires>? ORDER BY expires', row.id, Date.now()).map(g => ({ id: g.id, role: g.role, expiresAt: g.expires })) });
        }
        if (action === 'agents' && method === 'POST') {
          if (!this.writeAllowed(request, session) || session!.user.id !== row.ownerId) return fail('FORBIDDEN', 'Repository owner required', 403);
          const input = this.parsed(grantSchema, await this.body(request)); if (!input) return fail('INVALID_REQUEST', 'Invalid grant scope', 400);
          const raw = randomToken(), id = crypto.randomUUID(), expires = Date.now() + input.expiresInSeconds * 1000;
          this.ctx.storage.sql.exec('INSERT INTO grants VALUES(?,?,?,?,?,0)', id, row.id, await sha256(raw), input.role, expires);
          return json({ grant: { id, role: input.role, expiresAt: expires }, token: raw }, 201);
        }
        if (action === 'agents' && extra && method === 'DELETE') {
          if (!this.writeAllowed(request, session) || session!.user.id !== row.ownerId) return fail('FORBIDDEN', 'Repository owner required', 403);
          const changed = this.ctx.storage.sql.exec('UPDATE grants SET revoked=1 WHERE id=? AND repo=? AND revoked=0', extra, row.id).rowsWritten;
          return changed ? json({ ok: true }) : fail('NOT_FOUND', 'Grant not found', 404);
        }
      }
      if (path === '/agent/session' && method === 'GET') {
        const header = request.headers.get('authorization'); if (!header || !/^Bearer [a-f0-9]{64}$/.test(header)) return fail('UNAUTHORIZED', 'Agent token invalid', 401);
        const grant = this.one<{ id: string; repo: string; role: string; expires: number }>('SELECT id,repo,role,expires FROM grants WHERE token=? AND revoked=0', await sha256(header.slice(7)));
        if (!grant || grant.expires <= Date.now()) return fail('UNAUTHORIZED', 'Agent token invalid', 401);
        const repo = this.one<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos WHERE id=?', grant.repo);
        return repo ? json({ actor: { id: grant.id, projectId: repo.project, role: grant.role }, repository: this.repo(repo) }) : fail('UNAUTHORIZED', 'Agent token invalid', 401);
      }
      return fail('NOT_FOUND', 'Not found', 404);
    } catch (error) { const large = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE'; return fail(large ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', large ? 'Request body too large' : 'Invalid request', large ? 413 : 400); }
  }
  private async authorizeProject(request: Request): Promise<Response> {
    const trusted = request.headers.get('x-swarmflare-internal') === 'platform-worker';
    if (!trusted) return fail('FORBIDDEN', 'Trusted Worker request required', 403);
    const payload = this.parsed(z.object({ projectId: z.string().uuid(), method: z.string().regex(/^[A-Z]{3,10}$/), path: z.string().max(1024) }).strict(), await this.body(request));
    if (!payload) return fail('INVALID_REQUEST', 'Invalid project authorization request', 400);
    const row = this.one<RepoRow>('SELECT id,owner,ownerId,name,description,project,status,created,artifacts,source,error FROM repos WHERE project=?', payload.projectId);
    if (!row) return fail('FORBIDDEN', 'Project is not mapped to a repository', 403);
    if (payload.method === 'GET' && row.status === 'ready') return json({ actor: { id: row.id, projectId: row.project, role: 'contributor', kind: 'public' }, repository: this.repo(row) });
    const s = await this.session(request);
    if (s && this.writeAllowed(request, s) && s.user.id === row.ownerId) return json({ actor: { id: s.user.id, projectId: row.project, role: 'owner', kind: 'human' }, repository: this.repo(row) });
    const auth = request.headers.get('authorization');
    if (auth && /^Bearer [a-f0-9]{64}$/.test(auth)) {
      const grant = this.one<{ id: string; repo: string; role: string; expires: number }>('SELECT id,repo,role,expires FROM grants WHERE token=? AND revoked=0', await sha256(auth.slice(7)));
      if (grant && grant.repo === row.id && grant.expires > Date.now() && (grant.role === 'contributor' || grant.role === 'reviewer')) return json({ actor: { id: grant.id, projectId: row.project, role: grant.role, kind: 'agent' }, repository: this.repo(row) });
    }
    return fail('FORBIDDEN', 'Actor is not authorized for this project', 403);
  }
}
