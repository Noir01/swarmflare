import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concat, fromHex, sha1, utf8 } from "../../../packages/git-transport/bytes.js";
import { parsePack } from "../../../packages/git-transport/pack.js";
import { hashObject } from "../../../packages/git-transport/objects.js";

// Adapted from pinned gittifacts packages/gitwire/test/pack.test.ts (MIT,
// Copyright (c) 2026 Jovi De Croock); source: commit
// 5f06eb4a5e425fdc4796774e3bd4284a0056288b. Fixtures are constructed here
// rather than importing upstream helpers; see packages/git-transport/PROVENANCE.md.
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function entryHeader(type: number, size: number): Uint8Array {
  const bytes = [(type << 4) | (size & 15)];
  let rest = Math.floor(size / 16);
  while (rest) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(rest & 0x7f);
    rest = Math.floor(rest / 128);
  }
  return Uint8Array.from(bytes);
}

async function pack(entries: Uint8Array[]): Promise<Uint8Array> {
  const body = concat([utf8("PACK"), u32(2), u32(entries.length), ...entries]);
  return concat([body, await sha1(body)]);
}

function compressed(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(data));
}

function deltaEntry(type: 6 | 7, baseRef: Uint8Array, delta: Uint8Array): Uint8Array {
  return concat([entryHeader(type, delta.length), baseRef, compressed(delta)]);
}

const baseData = utf8("base");
const resultData = utf8("based!");
// Declared base/result lengths; copy base[0..4), then insert "d!".
const delta = Uint8Array.from([4, 6, 0x91, 0, 4, 2, 100, 33]);

describe("Git pack delta resolution", () => {
  it.each(["REF_DELTA", "OFS_DELTA"] as const)("resolves a valid %s to its Git object hash and bytes", async (kind) => {
    const baseSha = await hashObject({ type: "blob", data: baseData });
    const baseEntry = concat([entryHeader(3, baseData.length), compressed(baseData)]);
    const offset = 12 + baseEntry.length;
    const ref = kind === "REF_DELTA"
      ? fromHex(baseSha)
      : Uint8Array.of(offset - 12); // one-byte OFS distance to the base entry
    const actual = await parsePack(await pack([baseEntry, deltaEntry(kind === "REF_DELTA" ? 7 : 6, ref, delta)]));
    const expectedSha = await hashObject({ type: "blob", data: resultData });
    expect(actual.map((o) => o.sha)).toEqual([baseSha, expectedSha]);
    expect(actual[1]?.type).toBe("blob");
    expect(actual[1]?.data).toEqual(resultData);
  });

  it("refuses a corrupt checksum, a truncated entry, and an unresolved REF_DELTA base", async () => {
    const baseEntry = concat([entryHeader(3, baseData.length), compressed(baseData)]);
    const baseSha = await hashObject({ type: "blob", data: baseData });
    const refDelta = deltaEntry(7, fromHex(baseSha), delta);
    const good = await pack([baseEntry, refDelta]);
    const corruptChecksum = good.slice();
    corruptChecksum[corruptChecksum.length - 1] ^= 1;
    await expect(parsePack(corruptChecksum)).rejects.toThrow(/checksum/i);

    // Cut compressed entry data but give the truncated pack a valid outer checksum.
    await expect(parsePack(await pack([baseEntry, refDelta.slice(0, refDelta.length - 3)])))
      .rejects.toThrow(/truncated|inflate/i);

    const absentSha = await hashObject({ type: "blob", data: utf8("absent") });
    const thin = await pack([deltaEntry(7, fromHex(absentSha), delta)]);
    await expect(parsePack(thin)).rejects.toThrow(/unresolved delta bases/i);
  });

  it("enforces cumulative resolved-delta allocation separately from inflated entry bytes", async () => {
    const baseEntry = concat([entryHeader(3, baseData.length), compressed(baseData)]);
    const baseSha = await hashObject({ type: "blob", data: baseData });
    const good = await pack([baseEntry, deltaEntry(7, fromHex(baseSha), delta)]);
    // Inflated payloads total 12 bytes (base 4 + delta program 8); resolved output adds 6.
    await expect(parsePack(good, 17)).rejects.toThrow(/resolved allocation limit/i);
    const resolved = await parsePack(good, 18);
    expect(resolved[1]?.sha).toBe(await hashObject({ type: "blob", data: resultData }));
    expect(resolved[1]?.data).toEqual(resultData);
  });
});
