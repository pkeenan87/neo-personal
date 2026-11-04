// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { encodeBin, prefixesFor } from "../../../scripts/category-lists/normalize.mjs";
import { __clearDecodedForTests, createPrefixLookup, sha256Hex, syncCategoryLists } from "../lib/policy/categories.js";
import { domainPrefix } from "../lib/policy/match.js";
import { MemoryBinStore } from "../lib/policy/store.js";

function file(domains: string[]) {
  const bin = encodeBin(prefixesFor(domains));
  const bytes = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  return { bytes, sha256: createHash("sha256").update(bin).digest("hex"), count: bin.length / 4 };
}

const adult = file(["adult-one.example", "adult-two.example"]);
const info = (over: Partial<{ sha256: string; count: number; file: string }> = {}) => ({
  version: "c1",
  baseUrl: "https://neo.test/category-lists/c1/",
  categories: { adult: { file: "adult.bin", sha256: adult.sha256, count: adult.count, ...over } },
});

beforeEach(() => __clearDecodedForTests());

describe("category list download", () => {
  it("downloads a file, checks it against the manifest sha256 and stores it by hash", async () => {
    const store = new MemoryBinStore();
    const fetchBytes = vi.fn(async () => adult.bytes);
    const r = await syncCategoryLists(info(), ["adult"], { store, fetchBytes });
    expect(fetchBytes).toHaveBeenCalledWith("https://neo.test/category-lists/c1/adult.bin");
    expect(r).toEqual({ complete: true, data: { version: "c1", shas: { adult: adult.sha256 } } });
    expect(await store.keys()).toEqual([adult.sha256]);
    expect(await sha256Hex(adult.bytes)).toBe(adult.sha256);
  });

  it("does not download again when the hash is already stored (version caching)", async () => {
    const store = new MemoryBinStore();
    const fetchBytes = vi.fn(async () => adult.bytes);
    await syncCategoryLists(info(), ["adult"], { store, fetchBytes });
    await syncCategoryLists({ ...info(), version: "c2" }, ["adult"], { store, fetchBytes });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects bytes that do not match the manifest hash, and stores nothing", async () => {
    const store = new MemoryBinStore();
    const tampered = adult.bytes.slice(0);
    new Uint8Array(tampered)[0]! ^= 1;
    const r = await syncCategoryLists(info(), ["adult"], { store, fetchBytes: async () => tampered });
    expect(r.complete).toBe(false);
    expect(r.data).toBeNull();
    expect(await store.keys()).toEqual([]);
  });

  it("rejects a wrong length, a failed download, a category missing from the manifest, and a bad file name", async () => {
    const store = new MemoryBinStore();
    expect((await syncCategoryLists(info({ count: adult.count + 1 }), ["adult"], { store, fetchBytes: async () => adult.bytes })).complete).toBe(false);
    expect((await syncCategoryLists(info(), ["adult"], { store, fetchBytes: async () => null })).complete).toBe(false);
    expect((await syncCategoryLists(info(), ["gambling"], { store, fetchBytes: async () => adult.bytes })).complete).toBe(false);
    expect((await syncCategoryLists(info({ file: "../../etc/passwd" }), ["adult"], { store, fetchBytes: async () => adult.bytes })).complete).toBe(false);
    expect((await syncCategoryLists(undefined, ["adult"], { store })).complete).toBe(false);
    expect((await syncCategoryLists({ ...info(), baseUrl: "javascript:alert(1)" }, ["adult"], { store, fetchBytes: async () => adult.bytes })).complete).toBe(false);
  });

  it("keeps the usable categories when one fails, and removes files nothing refers to", async () => {
    const store = new MemoryBinStore();
    await store.put("stale-hash", new ArrayBuffer(4));
    const two = { ...info(), categories: { ...info().categories, gambling: { file: "gambling.bin", sha256: "f".repeat(64), count: 1 } } };
    const r = await syncCategoryLists(two, ["adult", "gambling"], { store, fetchBytes: async (url) => (url.endsWith("adult.bin") ? adult.bytes : new ArrayBuffer(4)) });
    expect(r.complete).toBe(false);
    expect(r.data?.shas).toEqual({ adult: adult.sha256 });
    expect(await store.keys()).toEqual([adult.sha256]);
  });

  it("frees everything when no category is wanted", async () => {
    const store = new MemoryBinStore();
    await store.put("x", new ArrayBuffer(4));
    expect((await syncCategoryLists(info(), [], { store })).complete).toBe(true);
    expect(await store.keys()).toEqual([]);
  });

  it("the stored file answers prefix lookups", async () => {
    const store = new MemoryBinStore();
    const r = await syncCategoryLists(info(), ["adult"], { store, fetchBytes: async () => adult.bytes });
    const lookup = createPrefixLookup(r.data, store);
    expect(await lookup("adult", await domainPrefix("adult-two.example"))).toBe(true);
    expect(await lookup("adult", await domainPrefix("fine.example"))).toBe(false);
    expect(await lookup("gambling", await domainPrefix("adult-two.example"))).toBe(false);
  });
});
