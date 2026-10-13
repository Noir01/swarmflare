import { describe, expect, it } from 'vitest';
import { buildPack, parsePack } from '../../packages/git-transport/pack.js';
import { encodeCommit, encodeTree, hashObject } from '../../packages/git-transport/objects.js';
import { listRefs } from '../../packages/git-transport/http.js';
import { receivePack } from '../../packages/git-transport/receive.js';
import { sourceReceiptSchema } from '../../packages/contracts/source.js';
import { concat, text, utf8, ZERO_SHA } from '../../packages/git-transport/bytes.js';
import { FLUSH, pktLine } from '../../packages/git-transport/pktline.js';

const signature = { name: 'Worker Test', email: 'worker@example.test', timestamp: 1_700_000_000, timezone: '+0000' };
const media = 'application/x-git-upload-pack-advertisement';
const pktText = (line: string) => pktLine(`${line}\n`);

describe('git transport in workerd', () => {
  it('round-trips blob, tree, and commit through WebCrypto, CompressionStream, and custom inflate', async () => {
    const blobData = utf8('hello\n');
    const blobSha = await hashObject({ type: 'blob', data: blobData });
    // Published Git object ID for `printf 'hello\\n' | git hash-object --stdin`.
    expect(blobSha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const treeData = encodeTree([{ mode: '100644', name: 'hello.txt', sha: blobSha }]);
    const treeSha = await hashObject({ type: 'tree', data: treeData });
    const commitData = encodeCommit({
      tree: treeSha, parents: [], author: signature, committer: signature, message: 'worker runtime fixture\n',
    });
    const commitSha = await hashObject({ type: 'commit', data: commitData });
    const objects = [
      { type: 'blob' as const, data: blobData },
      { type: 'tree' as const, data: treeData },
      { type: 'commit' as const, data: commitData },
    ];
    const pack = await buildPack(objects);
    const parsed = await parsePack(pack);
    expect(parsed.map(({ type, sha, data }) => [type, sha, text(data)])).toEqual([
      ['blob', blobSha, 'hello\n'], ['tree', treeSha, text(treeData)], ['commit', commitSha, text(commitData)],
    ]);
  });

  it('enforces malformed-pack and aggregate inflated-allocation bounds', async () => {
    const pack = await buildPack([
      { type: 'blob', data: utf8('12345678') },
      { type: 'blob', data: utf8('abcdefgh') },
    ]);
    await expect(parsePack(pack, 12)).rejects.toThrow(/allocation limit/i);
    const corrupt = pack.slice(); corrupt[corrupt.length - 1] ^= 1;
    await expect(parsePack(corrupt)).rejects.toThrow(/checksum/i);
  });

  it('discovers refs via injected protocol-v2 smart HTTP and validates requests', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? text(init.body as Uint8Array) : '' });
      if (init?.method === 'GET') {
        return new Response(concat([pktText('# service=git-upload-pack'), FLUSH, pktText('version 2'), pktText('ls-refs=unborn'), FLUSH]), { headers: { 'Content-Type': `${media}; charset=utf-8` } });
      }
      return new Response(concat([pktText('0123456789012345678901234567890123456789 refs/heads/main symref-target:refs/heads/main'), FLUSH]), { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
    };
    const refs = await listRefs({ url: 'https://git.example.test/repo.git', fetch: fetcher }, { prefixes: ['refs/heads/'] });
    expect(refs.protocol).toBe(2);
    expect(refs.get('refs/heads/main')).toBe('0123456789012345678901234567890123456789');
    expect(refs.symrefs.get('refs/heads/main')).toBe('refs/heads/main');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://git.example.test/repo.git/info/refs?service=git-upload-pack');
    expect(calls[0]?.headers.get('Git-Protocol')).toBe('version=2');
    expect(calls[0]?.headers.get('Accept')).toBe(media);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.headers.get('Content-Type')).toBe('application/x-git-upload-pack-request');
    expect(calls[1]?.body).toContain('command=ls-refs');
  });

  it('sends receive-pack and parses a syntactically valid report-status response', async () => {
    const calls: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return new Response(concat([pktText('unpack ok'), pktText('ok refs/agent/seeds/test'), FLUSH]), { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
    };
    const report = await receivePack({ url: 'https://git.example.test/repo.git', fetch: fetcher }, [
      { ref: 'refs/agent/seeds/test', oldSha: ZERO_SHA, newSha: '1234567890123456789012345678901234567890' },
    ]);
    expect(report).toEqual({ unpackOk: true, refs: [{ ref: 'refs/agent/seeds/test', ok: true }], progress: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('Accept')).toBe('application/x-git-receive-pack-result');
    expect(calls[0]?.headers.get('Content-Type')).toBe('application/x-git-receive-pack-request');
    expect(calls[0]?.headers.get('Git-Protocol')).toBeNull();
    expect(calls[0]?.url).toBe('https://git.example.test/repo.git/git-receive-pack');
  });

  it('rejects non-Git media types without reading their bodies', async () => {
    let bodyCancelled = false;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { bodyCancelled = true; },
      start(controller) { controller.enqueue(new Uint8Array(8)); },
    }), { headers: { 'Content-Type': 'text/plain' } });
    await expect(listRefs({ url: 'https://git.example.test/repo.git', fetch: fetcher }, { protocol: 1 })).rejects.toThrow(/Content-Type/i);
    expect(bodyCancelled).toBe(true);
  });

  it('keeps source receipts local-git-only', () => {
    const receipt = { backend: 'local-git', ref: 'refs/agent/seeds/seed1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) };
    expect(sourceReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(sourceReceiptSchema.safeParse({ ...receipt, backend: 'artifacts-git' }).success).toBe(false);
  });
});
