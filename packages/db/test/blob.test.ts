import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ fn: string; args: unknown[] }> = [];
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "put", args });
    return { url: `https://store.private.blob.vercel-storage.com/${args[0] as string}` };
  }),
  get: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "get", args });
    if ((args[0] as string).endsWith("missing.bin")) return null;
    return {
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3]));
          c.close();
        },
      }),
    };
  }),
  del: vi.fn(async (...args: unknown[]) => {
    calls.push({ fn: "del", args });
  }),
}));

const { createMemoryBlobClient, createVercelBlobClient } = await import("../src/blob.js");

describe("createVercelBlobClient", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("puts private, non-overwriting blobs with the given token", async () => {
    const c = createVercelBlobClient("test-token");
    const { url } = await c.put("tenants/t/artifacts/a.bin", new Uint8Array([9, 9]), "application/octet-stream");
    expect(url).toContain("tenants/t/artifacts/a.bin");
    const [path, body, opts] = calls[0]!.args as [string, Buffer, Record<string, unknown>];
    expect(path).toBe("tenants/t/artifacts/a.bin");
    expect([...body]).toEqual([9, 9]);
    expect(opts).toMatchObject({
      access: "private",
      contentType: "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: false,
      token: "test-token",
    });
  });

  it("reads the whole private stream with the token, bypassing the cache", async () => {
    const c = createVercelBlobClient("tok");
    expect([...(await c.get("https://x/a.bin"))!]).toEqual([1, 2, 3]);
    expect(calls[0]!.args[1]).toMatchObject({ access: "private", useCache: false, token: "tok" });
    expect(await c.get("https://x/missing.bin")).toBeUndefined();
  });

  it("deletes by url", async () => {
    await createVercelBlobClient("tok").del("https://x/a.bin");
    expect(calls[0]).toEqual({ fn: "del", args: ["https://x/a.bin", { token: "tok" }] });
  });
});

describe("createMemoryBlobClient", () => {
  it("stores copies, refuses overwrite, and deletes idempotently", async () => {
    const c = createMemoryBlobClient();
    const bytes = new Uint8Array([1, 2, 3]);
    const { url } = await c.put("p/a.bin", bytes, "application/octet-stream");
    bytes[0] = 42;
    expect([...(await c.get(url))!]).toEqual([1, 2, 3]);
    await expect(c.put("p/a.bin", bytes, "application/octet-stream")).rejects.toThrow();
    await c.del(url);
    await c.del(url);
    expect(await c.get(url)).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
