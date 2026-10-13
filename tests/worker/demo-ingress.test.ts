import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import demo from '../../apps/worker/src/demo-index';

type DemoEnv = Env & { DEMO_EXPIRES_AT?: string; AUTH_CREDENTIALS?: string };
const request = () => new Request('https://demo.example/api/v1/projects/demo-project/context');

describe('demo ingress lifetime and authentication', () => {
  it('fails closed with 410 when the expiry is absent', async () => {
    const response = await demo.fetch!(request(), { ...env, AUTH_CREDENTIALS: '[]' } as DemoEnv);
    expect(response.status).toBe(410);
  });

  it.each(['not-an-epoch', 'Infinity', '0'])('returns 410 for invalid expiry %s', async expiry => {
    const response = await demo.fetch!(request(), { ...env, DEMO_EXPIRES_AT: expiry, AUTH_CREDENTIALS: '[]' } as DemoEnv);
    expect(response.status).toBe(410);
  });

  it('returns 410 after the configured epoch-millisecond deadline', async () => {
    const response = await demo.fetch!(request(), { ...env, DEMO_EXPIRES_AT: String(Date.now() - 1), AUTH_CREDENTIALS: '[]' } as DemoEnv);
    expect(response.status).toBe(410);
  });

  it('delegates a live demo request to the existing authenticated router', async () => {
    const response = await demo.fetch!(request(), { ...env, DEMO_EXPIRES_AT: String(Date.now() + 60_000), AUTH_CREDENTIALS: '[]' } as DemoEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
