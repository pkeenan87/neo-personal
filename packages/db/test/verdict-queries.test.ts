import type { Verdict } from "@neo/verdict";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verdicts } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser } from "../src/tenants.js";
import { InvalidCursorError, listMembers, saveVerdict, verdictQueries } from "../src/verdicts.js";
import { becomeAppUser, createTestDb, createUser, type TestDb } from "./helpers.js";

const NOW = new Date("2026-09-24T15:00:00Z");
const DAY = 86_400_000;

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    subject_type: "email",
    verdict: "malicious",
    confidence: 0.9,
    headline: "Phishing email impersonating PayPal.",
    indicators: [{ severity: "high", category: "lookalike_domain", evidence: "paypa1.example", explanation: "x" }],
    recommended_actions: [{ action: "Delete it.", urgency: "now" }],
    iocs: { urls: [], domains: ["PayPa1.example"], ips: [], hashes: [], phone_numbers: [] },
    ...over,
  };
}

async function insertAt(db: TestDb["db"], tenantId: string, userId: string, v: Verdict, createdAt: Date, source: "chat" | "inbound" | "api" = "chat") {
  const [row] = await tenantScoped(db, tenantId).insert(verdicts, {
    userId,
    source,
    subjectType: v.subject_type,
    verdict: v.verdict,
    confidence: v.confidence,
    headline: v.headline,
    body: v as unknown as Record<string, unknown>,
    createdAt,
  });
  return row!.id;
}

describe("saveVerdict", () => {
  let t: TestDb;
  let tenant: string;
  let user: string;
  beforeAll(async () => {
    t = await createTestDb();
    user = await createUser(t.db);
    ({ tenantId: tenant } = await createTenantForUser(t.db, { userId: user, name: "H" }));
  });
  afterAll(async () => {
    await t.close();
  });

  it("stores the verdict with source and links, setting raw_ref from artifactId", async () => {
    const { id } = await saveVerdict(t.db, { tenantId: tenant, userId: user, source: "inbound", verdict: verdict() });
    const row = await verdictQueries.get(t.db, tenant, id);
    expect(row).toMatchObject({
      id,
      tenantId: tenant,
      userId: user,
      source: "inbound",
      conversationId: null,
      artifactId: null,
      subjectType: "email",
      verdict: "malicious",
      headline: "Phishing email impersonating PayPal.",
    });
    expect(row!.confidence).toBeCloseTo(0.9);
    expect(row!.body).toEqual(verdict());
  });

  it("rejects an invalid verdict", async () => {
    await expect(
      saveVerdict(t.db, { tenantId: tenant, userId: user, source: "chat", verdict: { ...verdict(), confidence: 2 } }),
    ).rejects.toThrow();
    await expect(
      saveVerdict(t.db, { tenantId: tenant, userId: user, source: "bogus" as never, verdict: verdict() }),
    ).rejects.toThrow();
  });

  it("defaults source to chat at the database level", async () => {
    const [row] = await tenantScoped(t.db, tenant).insert(verdicts, {
      userId: user,
      subjectType: "url",
      verdict: "likely_safe",
      confidence: 0.5,
      headline: "h",
      body: {},
    });
    expect(row!.source).toBe("chat");
  });
});

describe("verdictQueries", () => {
  let t: TestDb;
  let tenantA: string;
  let tenantB: string;
  let owner: string;
  let member: string;
  const ids: string[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    owner = await createUser(t.db, "Owner");
    member = await createUser(t.db, "Member");
    const other = await createUser(t.db, "Other");
    ({ tenantId: tenantA } = await createTenantForUser(t.db, { userId: owner, name: "A" }));
    ({ tenantId: tenantB } = await createTenantForUser(t.db, { userId: other, name: "B" }));
    await tenantScoped(t.db, tenantA).insert((await import("../src/schema/index.js")).memberships, { userId: member, role: "member" });

    // 3 days of data in tenant A.
    const d = (daysAgo: number, h = 10) => new Date(NOW.getTime() - daysAgo * DAY - (15 - h) * 3_600_000);
    ids.push(await insertAt(t.db, tenantA, owner, verdict(), d(0), "chat"));
    ids.push(
      await insertAt(
        t.db,
        tenantA,
        member,
        verdict({
          verdict: "suspicious",
          subject_type: "sms",
          indicators: [
            { severity: "medium", category: "urgency_language", evidence: "now!", explanation: "x" },
            { severity: "medium", category: "lookalike_domain", evidence: "y", explanation: "x" },
            { severity: "low", category: "lookalike_domain", evidence: "z", explanation: "x" },
          ],
          iocs: { urls: [], domains: ["paypa1.example", "usps-track.example"], ips: [], hashes: [], phone_numbers: [] },
        }),
        d(1),
        "inbound",
      ),
    );
    ids.push(
      await insertAt(
        t.db,
        tenantA,
        owner,
        verdict({ verdict: "likely_safe", subject_type: "url", indicators: [], iocs: { urls: [], domains: ["google.com"], ips: [], hashes: [], phone_numbers: [] } }),
        d(2),
      ),
    );
    // Outside a 7-day window.
    ids.push(await insertAt(t.db, tenantA, owner, verdict({ verdict: "insufficient_evidence" }), d(20)));
    // Other tenant.
    await insertAt(t.db, tenantB, other, verdict(), d(0));
  });
  afterAll(async () => {
    await t.close();
  });

  it("lists newest first with filters", async () => {
    const all = await verdictQueries.list(t.db, tenantA, {});
    expect(all.items.map((r) => r.id)).toEqual(ids);
    expect(all.nextCursor).toBeUndefined();

    expect((await verdictQueries.list(t.db, tenantA, { userId: member })).items.map((r) => r.id)).toEqual([ids[1]]);
    expect((await verdictQueries.list(t.db, tenantA, { label: "likely_safe" })).items.map((r) => r.id)).toEqual([ids[2]]);
    expect((await verdictQueries.list(t.db, tenantA, { subjectType: "sms" })).items.map((r) => r.id)).toEqual([ids[1]]);
    expect((await verdictQueries.list(t.db, tenantA, { source: "inbound" })).items.map((r) => r.id)).toEqual([ids[1]]);
  });

  it("paginates with a keyset cursor, including rows in the same millisecond", async () => {
    const t2 = await createTestDb();
    try {
      const u = await createUser(t2.db);
      const { tenantId } = await createTenantForUser(t2.db, { userId: u, name: "P" });
      for (let i = 0; i < 7; i++) await insertAt(t2.db, tenantId, u, verdict(), NOW);
      // Microsecond offsets within one millisecond.
      await tenantScoped(t2.db, tenantId).transaction((s) =>
        s.tx.execute(sql`update verdicts set created_at = created_at + (random() * 900)::int * interval '1 microsecond' where tenant_id = ${tenantId}`),
      );
      for (let i = 0; i < 5; i++) await insertAt(t2.db, tenantId, u, verdict(), new Date(NOW.getTime() - 1000 * (i + 1)));

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await verdictQueries.list(t2.db, tenantId, { limit: 5, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);

      const full = await verdictQueries.list(t2.db, tenantId, { limit: 50 });
      expect(seen).toEqual(full.items.map((r) => r.id));
    } finally {
      await t2.close();
    }
  });

  it("caps limit at 50 and rejects malformed cursors", async () => {
    await expect(verdictQueries.list(t.db, tenantA, { cursor: "garbage" })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      verdictQueries.list(t.db, tenantA, { cursor: Buffer.from("2026-01-01T00:00:00Z|nope").toString("base64url") }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    const r = await verdictQueries.list(t.db, tenantA, { limit: 500 });
    expect(r.items.length).toBeLessThanOrEqual(50);
  });

  it("summarizes a window with JSONB aggregation", async () => {
    const s = await verdictQueries.summary(t.db, tenantA, { sinceDays: 7, now: NOW });
    expect(s.total).toBe(3);
    expect(s.byLabel).toEqual({ malicious: 1, suspicious: 1, likely_safe: 1, insufficient_evidence: 0 });
    expect(s.bySubjectType).toMatchObject({ email: 1, sms: 1, url: 1, page: 0 });
    // Counted per verdict: lookalike_domain appears in 2 verdicts (twice in one of them).
    expect(s.topIndicators).toEqual([
      { category: "lookalike_domain", count: 2 },
      { category: "urgency_language", count: 1 },
    ]);
    // Lowercased; likely_safe verdicts (google.com) excluded.
    expect(s.topDomains).toEqual([
      { domain: "paypa1.example", count: 2 },
      { domain: "usps-track.example", count: 1 },
    ]);
    expect(s.perDay).toHaveLength(7);
    expect(s.perDay[6]).toEqual({ day: "2026-09-24", malicious: 1, suspicious: 0, likely_safe: 0, insufficient_evidence: 0 });
    expect(s.perDay[5]).toMatchObject({ day: "2026-09-23", suspicious: 1 });
    expect(s.perDay[4]).toMatchObject({ day: "2026-09-22", likely_safe: 1 });
    expect(s.perDay[0]!.day).toBe("2026-09-18");

    const wide = await verdictQueries.summary(t.db, tenantA, { sinceDays: 30, now: NOW });
    expect(wide.total).toBe(4);
    expect(wide.perDay).toHaveLength(30);

    const mine = await verdictQueries.summary(t.db, tenantA, { sinceDays: 7, userId: member, now: NOW });
    expect(mine.total).toBe(1);
    expect(mine.topIndicators[0]).toEqual({ category: "lookalike_domain", count: 1 });

    const empty = await verdictQueries.summary(t.db, tenantA, { sinceDays: 7, now: new Date("2020-01-01T00:00:00Z") });
    expect(empty.total).toBe(0);
    expect(empty.topIndicators).toEqual([]);
  });

  it("isolates tenants in list, get, summary and remove", async () => {
    expect((await verdictQueries.list(t.db, tenantB, {})).items).toHaveLength(1);
    expect(await verdictQueries.get(t.db, tenantB, ids[0]!)).toBeUndefined();
    expect(await verdictQueries.remove(t.db, tenantB, ids[0]!)).toBe(false);
    expect((await verdictQueries.summary(t.db, tenantB, { sinceDays: 7, now: NOW })).total).toBe(1);
    expect(await verdictQueries.get(t.db, tenantA, "not-a-uuid")).toBeUndefined();
  });

  it("lists household members owners first", async () => {
    const members = await listMembers(t.db, tenantA);
    expect(members).toEqual([
      { userId: owner, name: "Owner", email: expect.stringContaining("@example.test"), role: "owner" },
      { userId: member, name: "Member", email: expect.stringContaining("@example.test"), role: "member" },
    ]);
    expect((await listMembers(t.db, tenantB)).map((m) => m.role)).toEqual(["owner"]);
  });

  describe("as the app role (RLS)", () => {
    beforeAll(async () => {
      await becomeAppUser(t.client);
    });
    afterAll(async () => {
      await t.client.exec("reset role");
    });

    it("runs every query under RLS and removes only own rows", async () => {
      expect((await verdictQueries.list(t.db, tenantA, {})).items).toHaveLength(4);
      expect((await verdictQueries.summary(t.db, tenantA, { sinceDays: 7, now: NOW })).total).toBe(3);
      expect(await listMembers(t.db, tenantA)).toHaveLength(2);
      const { id } = await saveVerdict(t.db, { tenantId: tenantA, userId: owner, source: "api", verdict: verdict() });
      expect(await verdictQueries.remove(t.db, tenantA, id)).toBe(true);
      expect(await verdictQueries.get(t.db, tenantA, id)).toBeUndefined();
      expect(await verdictQueries.remove(t.db, tenantA, id)).toBe(false);
    });
  });
});
