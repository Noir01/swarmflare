import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePathExecutable } from '../../packages/browser-test/executable';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'browser-path-test-')); dirs.push(path); return path; }
async function fake(dir: string, name: string, mode = 0o755) { const path = join(dir, name); await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, mode); return path; }

it('skips empty and relative PATH entries and resolves an executable regular file', async () => {
  const dir = await directory();
  const expected = await fake(dir, 'chromium');
  expect(await resolvePathExecutable('chromium', `:${delimiter}relative${delimiter}${dir}`)).toBe(expected);
});

it('rejects non-executable files and continues to later PATH entries', async () => {
  const first = await directory(); const second = await directory();
  await fake(first, 'chromium', 0o644);
  const expected = await fake(second, 'chromium');
  expect(await resolvePathExecutable('chromium', `${first}${delimiter}${second}`)).toBe(expected);
});

it('reports a clear error when no executable regular file exists', async () => {
  const dir = await directory();
  await fake(dir, 'chromium', 0o644);
  await expect(resolvePathExecutable('chromium', `${delimiter}relative${delimiter}${dir}`)).rejects.toThrow(/Cannot locate executable "chromium" on PATH/);
});