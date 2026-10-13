import { describe, expect, it } from 'vitest';
import { checkedPlatformUrl, parsePhase, requestClient } from '../../demo/cloud/platform-smoke.js';

describe('native platform smoke safety helpers', () => {
  it('parses only supported phases and fixes the sole service origin', () => {
    expect(parsePhase('auth')).toBe('auth');
    expect(() => parsePhase('https://attacker.test')).toThrow();
    expect(checkedPlatformUrl('/auth/session')).toBe('https://git-collaboration-demo-c29.sriva140.workers.dev/api/platform/auth/session');
    expect(() => checkedPlatformUrl('//attacker.test/x')).toThrow();
    expect(() => checkedPlatformUrl('/x\\@attacker.test')).toThrow();
  });
  it('sends generated secret only in request headers/body and reports sanitized status', async () => {
    let seen: RequestInit | undefined; const reports: unknown[] = [];
    const client = requestClient(async (_url, init) => { seen = init; return new Response(JSON.stringify({ code: 'INVALID_REQUEST', message: 'must not be reported' }), { status: 401 }); }, async x => { reports.push(x); });
    await expect(client('/auth/login', { method: 'POST', body: { password: 'test-secret-value' }, expected: 200 })).rejects.toMatchObject({ safe: { status: 401, code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(reports)).not.toContain('test-secret-value'); expect(JSON.stringify(reports)).not.toContain('must not be reported');
    expect(JSON.stringify(seen)).toContain('test-secret-value');
  });
  it('does not emit response text when network fetch fails', async () => {
    const client = requestClient(async () => { throw new Error('Bearer secret'); });
    await expect(client('/auth/session')).rejects.toMatchObject({ safe: { code: 'NETWORK', status: 0 } });
  });
});
