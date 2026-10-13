import { describe, expect, it } from 'vitest';
import { workspaceEndpoint } from '../../packages/client/endpoint.js';

describe('runner workspace endpoint opt-in', () => {
  it('keeps loopback as the default and rejects remote metadata without opt-in', () => {
    expect(workspaceEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/');
    expect(workspaceEndpoint('http://[::1]:8787')).toBe('http://[::1]:8787/');
    expect(() => workspaceEndpoint('https://demo.workers.dev')).toThrow(/loopback/);
  });

  it('accepts only an exact, explicitly approved HTTPS workers.dev origin', () => {
    expect(workspaceEndpoint('https://demo.workers.dev', 'https://demo.workers.dev')).toBe('https://demo.workers.dev/');
    expect(workspaceEndpoint('https://git-collaboration-demo-c29.sriva140.workers.dev', 'https://git-collaboration-demo-c29.sriva140.workers.dev')).toBe('https://git-collaboration-demo-c29.sriva140.workers.dev/');
    expect(() => workspaceEndpoint('https://other.workers.dev', 'https://demo.workers.dev')).toThrow(/match/);
  });

  it.each([
    'http://demo.workers.dev', 'https://workers.dev', 'https://demo.workers.dev:8443',
    'https://demo.workers.dev/path', 'https://user@demo.workers.dev',
    'https://demo.workers.dev?x=1', 'https://demo.workers.dev#fragment',
    'https://notworkers.dev', 'https://a.b.c.workers.dev',
  ])('rejects unsafe allowed origin %s', origin => {
    expect(() => workspaceEndpoint(origin, origin)).toThrow();
  });
});
