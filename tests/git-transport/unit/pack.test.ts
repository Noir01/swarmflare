import { describe, expect, it } from "vitest";
import { applyDelta, buildPack, parsePack } from "../../../packages/git-transport/pack.js";
import { utf8 } from "../../../packages/git-transport/bytes.js";

// Selected behavioral cases adapted from pinned gittifacts packages/gitwire pack tests
// (MIT, Copyright (c) 2026 Jovi De Croock; see packages/git-transport/PROVENANCE.md).
describe("bounded pack decoding", () => {
  it("round-trips ordinary objects", async () => {
    const pack = await buildPack([{ type: "blob", data: utf8("meaningful object") }]);
    expect((await parsePack(pack))[0]?.data).toEqual(utf8("meaningful object"));
  });

  it("rejects aggregate inflation before allocating the over-budget entry", async () => {
    const pack = await buildPack([{ type: "blob", data: utf8("12345678") }, { type: "blob", data: utf8("abcdefgh") }]);
    await expect(parsePack(pack, 12)).rejects.toThrow(/allocation limit/i);
  });

  it("bounds public delta output and rejects overflowing varints", () => {
    // base-size 0, declared result 128, no instructions
    expect(() => applyDelta(new Uint8Array(), Uint8Array.from([0, 128, 1]), 32)).toThrow(/allocation limit/i);
    expect(() => applyDelta(new Uint8Array(), Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0]))).toThrow(/varint/i);
  });
});
