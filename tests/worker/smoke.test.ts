import { it, expect } from 'vitest';
import { env } from 'cloudflare:test';
it('runs Worker SQLite DO locally and reads persisted state', async () => {const stub=env.PROJECTS.get(env.PROJECTS.idFromName('smoke')); const a=await stub.fetch('https://internal/health'); expect(a.status).toBe(200);expect(await a.json()).toEqual({ok:true,schemaVersion:1});const b=await stub.fetch('https://internal/health'); expect(await b.json()).toEqual({ok:true,schemaVersion:1});});
