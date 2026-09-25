import { createHash, randomBytes } from "node:crypto";
import { ArtifactDecryptError } from "@neo/core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ArtifactStoreUnavailableError,
  artifactBlobPath,
  artifactRetentionDays,
  createArtifactStore,
} from "../src/artifact-store.js";
import { createMemoryBlobClient } from "../src/blob.js";
import { artifacts, verdicts } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { saveVerdict } from "../src/verdicts.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const DAY = 86_400_000;
const EML = new TextEncoder().encode("From: \"PayPal\" <service@paypa1.example>\r\nSubject: Account locked\r\n\r\nVerify now: https://paypa1.example/login\r\n");

describe("createArtifactStore", () => {
  let t: TestDb;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  const masterKey = new Uint8Array(randomBytes(32));

  beforeAll(async () => {
    t = await createTestDb();
    userA = await createUser(t.db, "A");
    userB = await createUser(t.db, "B");
    ({ tenantId: tenantA } = await createTenantForUser(t.db, { userId: userA, name: "A" }));
    ({ tenantId: tenantB } = await createTenantForUser(t.db, { userId: userB, name: "B" }));
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.NEO_ARTIFACT_RETENTION_DAYS;
  });

  it("encrypts, stores metadata, and reads back the plaintext", async () => {
    const blob = createMemoryBlobClient();
    const now = new Date("2026-09-01T12:00:00Z");
    const store = createArtifactStore(t.db, { blob, masterKey, now: () => now });

    const meta = await store.put({
      tenantId: tenantA,
      userId: userA,
      kind: "eml",
      filename: "locked.eml",
      mimeType: "message/rfc822",
      bytes: EML,
      source: "upload",
    });
    expect(meta).toMatchObject({
      tenantId: tenantA,
      userId: userA,
      kind: "eml",
      filename: "locked.eml",
      mimeType: "message/rfc822",
      sizeBytes: EML.byteLength,
      sha256: createHash("sha256").update(EML).digest("hex"),
      encrypted: true,
      source: "upload",
    });
    expect(meta.expiresAt?.toISOString()).toBe(new Date(now.getTime() + 30 * DAY).toISOString());

    const [row] = await tenantScoped(t.db, tenantA).select(artifacts, eq(artifacts.id, meta.id));
    expect(row!.blobUrl).toBe(`memory://blob/${artifactBlobPath(tenantA, meta.id)}`);
    const stored = blob.raw(row!.blobUrl)!;
    expect(Buffer.from(stored.subarray(0, 4)).toString()).toBe("NEO1");
    expect(Buffer.from(stored).includes(Buffer.from("Account locked"))).toBe(false);

    expect(await store.get(meta.id, tenantA)).toEqual(meta);
    expect(Buffer.from((await store.read(meta.id, tenantA))!)).toEqual(Buffer.from(EML));
  });

  it("isolates tenants: foreign ids are invisible and cannot be deleted", async () => {
    const blob = createMemoryBlobClient();
    const store = createArtifactStore(t.db, { blob, masterKey });
    const meta = await store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });

    expect(await store.get(meta.id, tenantB)).toBeUndefined();
    expect(await store.read(meta.id, tenantB)).toBeUndefined();
    await store.delete(meta.id, tenantB);
    expect(blob.size).toBe(1);
    expect(await store.get(meta.id, tenantA)).toBeDefined();

    expect(await store.get("not-a-uuid", tenantA)).toBeUndefined();
    await store.delete(meta.id, tenantA);
    expect(await store.get(meta.id, tenantA)).toBeUndefined();
    expect(blob.size).toBe(0);
  });

  it("binds ciphertext to its artifact id and tenant (swapped blobs fail to decrypt)", async () => {
    const blob = createMemoryBlobClient();
    const store = createArtifactStore(t.db, { blob, masterKey });
    const a1 = await store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
    const a2 = await store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
    const b1 = await store.put({ tenantId: tenantB, userId: userB, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });

    const url = async (id: string, tenant: string) =>
      (await tenantScoped(t.db, tenant).first(artifacts, eq(artifacts.id, id)))!.blobUrl;
    // Point a2 (same tenant) and b1 (other tenant) at a1's ciphertext.
    await tenantScoped(t.db, tenantA).update(artifacts, { blobUrl: await url(a1.id, tenantA) }, eq(artifacts.id, a2.id));
    await tenantScoped(t.db, tenantB).update(artifacts, { blobUrl: await url(a1.id, tenantA) }, eq(artifacts.id, b1.id));

    await expect(store.read(a2.id, tenantA)).rejects.toBeInstanceOf(ArtifactDecryptError);
    await expect(store.read(b1.id, tenantB)).rejects.toBeInstanceOf(ArtifactDecryptError);
    expect(await store.read(a1.id, tenantA)).toBeDefined();
  });

  it("returns undefined when the blob is missing", async () => {
    const blob = createMemoryBlobClient();
    const store = createArtifactStore(t.db, { blob, masterKey });
    const meta = await store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
    const r = await tenantScoped(t.db, tenantA).first(artifacts, eq(artifacts.id, meta.id));
    await blob.del(r!.blobUrl);
    expect(await store.read(meta.id, tenantA)).toBeUndefined();
  });

  it("honours retentionDays and NEO_ARTIFACT_RETENTION_DAYS", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const seven = createArtifactStore(t.db, { blob: createMemoryBlobClient(), masterKey, retentionDays: 7, now: () => now });
    const m7 = await seven.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
    expect(m7.expiresAt!.getTime() - now.getTime()).toBe(7 * DAY);

    process.env.NEO_ARTIFACT_RETENTION_DAYS = "3";
    expect(artifactRetentionDays()).toBe(3);
    const env = createArtifactStore(t.db, { blob: createMemoryBlobClient(), masterKey, now: () => now });
    const m3 = await env.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
    expect(m3.expiresAt!.getTime() - now.getTime()).toBe(3 * DAY);

    expect(artifactRetentionDays({ NEO_ARTIFACT_RETENTION_DAYS: "0" })).toBe(30);
    expect(artifactRetentionDays({ NEO_ARTIFACT_RETENTION_DAYS: "abc" })).toBe(30);
  });

  it("hides expired artifacts, lists them for retention, and purges blob + row", async () => {
    const blob = createMemoryBlobClient();
    let clock = new Date("2020-01-01T00:00:00Z");
    const store = createArtifactStore(t.db, { blob, masterKey, retentionDays: 1, now: () => clock });
    const old = await store.put({ tenantId: tenantB, userId: userB, kind: "inbound_eml", mimeType: "message/rfc822", bytes: EML, source: "inbound" });
    const { id: verdictId } = await saveVerdict(t.db, {
      tenantId: tenantB,
      userId: userB,
      artifactId: old.id,
      source: "inbound",
      verdict: {
        subject_type: "email",
        verdict: "suspicious",
        confidence: 0.5,
        headline: "h",
        indicators: [],
        recommended_actions: [],
        iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
      },
    });

    const linked = await tenantScoped(t.db, tenantB).first(verdicts, eq(verdicts.id, verdictId));
    expect(linked?.artifactId).toBe(old.id);
    expect((linked?.body as { raw_ref?: string }).raw_ref).toBe(old.id);

    clock = new Date(); // real time: `old` expired long ago
    const fresh = await store.put({ tenantId: tenantB, userId: userB, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });

    expect(await store.get(old.id, tenantB)).toBeUndefined();
    expect(await store.read(old.id, tenantB)).toBeUndefined();

    const expired = await store.listExpired(200);
    expect(expired.map((m) => m.id)).toContain(old.id);
    expect(expired.map((m) => m.id)).not.toContain(fresh.id);
    expect(expired.find((m) => m.id === old.id)?.tenantId).toBe(tenantB);
    expect(await store.listExpired(0)).toEqual([]);

    await store.purge(old.id); // owner role: tenant looked up directly
    expect(blob.size).toBe(1);
    expect(await tenantScoped(t.db, tenantB).first(artifacts, eq(artifacts.id, old.id))).toBeUndefined();
    // The verdict survives with artifact_id nulled.
    const v = await tenantScoped(t.db, tenantB).first(verdicts, eq(verdicts.id, verdictId));
    expect(v?.artifactId).toBeNull();
    expect(await store.get(fresh.id, tenantB)).toBeDefined();
  });

  describe("plaintext fallback", () => {
    it("refuses to store without a master key unless allowPlaintext", async () => {
      const store = createArtifactStore(t.db, { blob: createMemoryBlobClient() });
      await expect(
        store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" }),
      ).rejects.toBeInstanceOf(ArtifactStoreUnavailableError);
    });

    it("stores plaintext with encrypted=false when explicitly allowed", async () => {
      const blob = createMemoryBlobClient();
      const store = createArtifactStore(t.db, { blob, allowPlaintext: true });
      const meta = await store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" });
      expect(meta.encrypted).toBe(false);
      const r = await tenantScoped(t.db, tenantA).first(artifacts, eq(artifacts.id, meta.id));
      expect(Buffer.from(blob.raw(r!.blobUrl)!)).toEqual(Buffer.from(EML));
      expect(Buffer.from((await store.read(meta.id, tenantA))!)).toEqual(Buffer.from(EML));
    });

    it("ignores allowPlaintext in Vercel production", async () => {
      process.env.VERCEL_ENV = "production";
      const store = createArtifactStore(t.db, { blob: createMemoryBlobClient(), allowPlaintext: true });
      await expect(
        store.put({ tenantId: tenantA, userId: userA, kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" }),
      ).rejects.toBeInstanceOf(ArtifactStoreUnavailableError);
    });

    it("cannot read an encrypted artifact without the master key", async () => {
      const blob = createMemoryBlobClient();
      const meta = await createArtifactStore(t.db, { blob, masterKey }).put({
        tenantId: tenantA,
        userId: userA,
        kind: "text",
        mimeType: "text/plain",
        bytes: EML,
        source: "upload",
      });
      await expect(createArtifactStore(t.db, { blob, allowPlaintext: true }).read(meta.id, tenantA)).rejects.toBeInstanceOf(
        ArtifactStoreUnavailableError,
      );
    });
  });

  it("removes the blob when the row insert fails", async () => {
    const blob = createMemoryBlobClient();
    const store = createArtifactStore(t.db, { blob, masterKey });
    await expect(
      store.put({ tenantId: tenantA, userId: "no-such-user", kind: "text", mimeType: "text/plain", bytes: EML, source: "upload" }),
    ).rejects.toThrow();
    expect(blob.size).toBe(0);
  });

  describe("as the app role (RLS)", () => {
    beforeAll(async () => {
      await becomeAppUser(t.client);
    });
    afterAll(async () => {
      await t.client.exec("reset role");
    });

    it("stores, reads, and runs retention through tenant ids and the definer function", async () => {
      const blob = createMemoryBlobClient();
      let clock = new Date("2020-06-01T00:00:00Z");
      const store = createArtifactStore(t.db, { blob, masterKey, retentionDays: 1, now: () => clock });
      const old = await store.put({ tenantId: tenantA, userId: userA, kind: "image", mimeType: "image/png", bytes: EML, source: "upload" });
      clock = new Date();
      const fresh = await store.put({ tenantId: tenantA, userId: userA, kind: "image", mimeType: "image/png", bytes: EML, source: "upload" });
      expect(Buffer.from((await store.read(fresh.id, tenantA))!)).toEqual(Buffer.from(EML));
      expect(await store.get(fresh.id, tenantB)).toBeUndefined();

      const expired = await store.listExpired(1000);
      const mine = expired.find((m) => m.id === old.id);
      expect(mine?.tenantId).toBe(tenantA);

      // Without a tenant the app role cannot see the row: purge is a no-op.
      await store.purge(old.id);
      expect(blob.size).toBe(2);
      await store.purge(old.id, mine!.tenantId);
      expect(blob.size).toBe(1);

      const { rows } = await t.client.query<{ role: string }>("select current_user as role");
      expect(rows[0]?.role).toBe("app_user");
    });
  });
});
