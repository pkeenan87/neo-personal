/**
 * Household invites on PGlite with the committed migrations, running as the
 * non-owner app role so RLS and the security-definer lookup are exercised.
 */
import type { Verdict } from "@neo/verdict";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDesktopToken, resolveDesktopToken } from "../src/desktop-tokens.js";
import {
  HOUSEHOLD_INVITE_TTL_MS,
  MAX_HOUSEHOLD_SIZE,
  acceptHouseholdInvite,
  createHouseholdInvite,
  hashInviteSecret,
  isInviteSecretFormat,
  leaveHousehold,
  listPendingHouseholdInvites,
  mintInviteSecret,
  normalizeInviteEmail,
  previewHouseholdInvite,
  removeHouseholdMember,
  revokeHouseholdInvite,
  rotateHouseholdInvite,
} from "../src/household.js";
import { artifacts, conversations, desktopTokens, householdInvites, memberships, tenants, users, verdicts } from "../src/schema/index.js";
import { tenantScoped } from "../src/tenant.js";
import { createTenantForUser, findTenantForUser } from "../src/tenants.js";
import { becomeAppUser, createTestDb, type TestDb } from "./helpers.js";

let seq = 0;

async function person(t: TestDb, opts: { email?: string; verified?: boolean; name?: string } = {}) {
  seq += 1;
  const email = opts.email ?? `person${seq}-${Date.now()}@example.test`;
  const [row] = await t.db
    .insert(users)
    .values({ name: opts.name ?? `Person ${seq}`, email, emailVerified: opts.verified === false ? null : new Date() })
    .returning({ id: users.id });
  const userId = row!.id;
  const { tenantId } = await createTenantForUser(t.db, { userId, name: `Household ${seq}` });
  return { userId, tenantId, email };
}

function verdict(): Verdict {
  return {
    subject_type: "url",
    verdict: "suspicious",
    confidence: 0.7,
    headline: "Lookalike login page.",
    indicators: [],
    recommended_actions: [],
    iocs: { urls: [], domains: [], ips: [], hashes: [], phone_numbers: [] },
  };
}

async function seedHistory(t: TestDb, tenantId: string, userId: string) {
  const scoped = tenantScoped(t.db, tenantId);
  const [convo] = await scoped.insert(conversations, { userId, title: "hi" });
  const v = verdict();
  await scoped.insert(verdicts, {
    userId,
    conversationId: convo!.id,
    source: "chat",
    subjectType: v.subject_type,
    verdict: v.verdict,
    confidence: v.confidence,
    headline: v.headline,
    body: v as unknown as Record<string, unknown>,
  });
  await scoped.insert(artifacts, {
    userId,
    kind: "text",
    mimeType: "text/plain",
    blobUrl: `https://blob.test/${tenantId}/a`,
    sha256: "0".repeat(64),
    sizeBytes: 1,
    encrypted: false,
  });
  return convo!.id;
}

describe("household invites", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    await becomeAppUser(t.client);
  });
  afterAll(async () => {
    await t.close();
  });

  describe("secrets and input", () => {
    it("mints neo_inv_ secrets and stores only a hash", () => {
      const s = mintInviteSecret();
      expect(isInviteSecretFormat(s)).toBe(true);
      expect(isInviteSecretFormat(`${s}x`)).toBe(false);
      expect(isInviteSecretFormat("neo_dt_" + s.slice(8))).toBe(false);
      expect(hashInviteSecret(s)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("normalizes emails and rejects lists and junk", () => {
      expect(normalizeInviteEmail("  Mom@Example.COM ")).toBe("mom@example.com");
      expect(normalizeInviteEmail("a@b")).toBeNull();
      expect(normalizeInviteEmail("a@b.com, c@d.com")).toBeNull();
      expect(normalizeInviteEmail("a b@c.com")).toBeNull();
      expect(normalizeInviteEmail("")).toBeNull();
    });
  });

  describe("owner", () => {
    it("creates, lists, rejects duplicates, rotates and revokes invites", async () => {
      const owner = await person(t, { name: "Pat" });
      const created = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: "Mom@Example.com" });
      if ("error" in created) throw new Error(created.error);
      expect(created.invite).toMatchObject({ kind: "email", email: "mom@example.com", sendCount: 1, invitedByName: "Pat" });

      const dup = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: "mom@example.com" });
      expect(dup).toEqual({ error: "invite_pending" });
      const self = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: owner.email });
      expect(self).toEqual({ error: "already_member" });
      expect(await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: "nope" })).toEqual({
        error: "invalid_email",
      });

      const rotated = await rotateHouseholdInvite(t.db, owner.tenantId, created.invite.id);
      if ("error" in rotated) throw new Error(rotated.error);
      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.invite.sendCount).toBe(2);
      const someone = await person(t);
      expect(await previewHouseholdInvite(t.db, { secret: created.secret, userId: someone.userId })).toBeNull();
      expect(await previewHouseholdInvite(t.db, { secret: rotated.secret, userId: someone.userId })).not.toBeNull();

      const link = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
      if ("error" in link) throw new Error(link.error);
      expect(await rotateHouseholdInvite(t.db, owner.tenantId, link.invite.id)).toEqual({ error: "not_found" });

      expect((await listPendingHouseholdInvites(t.db, owner.tenantId)).map((i) => i.id).sort()).toEqual(
        [created.invite.id, link.invite.id].sort(),
      );
      expect(await revokeHouseholdInvite(t.db, owner.tenantId, link.invite.id)).toBe(true);
      expect(await revokeHouseholdInvite(t.db, owner.tenantId, link.invite.id)).toBe(false);
      expect(await previewHouseholdInvite(t.db, { secret: link.secret, userId: someone.userId })).toBeNull();

      // Another household cannot see or revoke it.
      const other = await person(t);
      expect(await listPendingHouseholdInvites(t.db, other.tenantId)).toEqual([]);
      expect(await revokeHouseholdInvite(t.db, other.tenantId, created.invite.id)).toBe(false);
    });

    it("caps members plus pending invites", async () => {
      const owner = await person(t);
      for (let i = 1; i < MAX_HOUSEHOLD_SIZE; i++) {
        const r = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
        expect("error" in r).toBe(false);
      }
      expect(await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" })).toEqual({
        error: "household_full",
      });
    });

    it("expires invites after seven days", async () => {
      const owner = await person(t);
      const now = new Date("2020-01-01T00:00:00Z");
      const r = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link", now });
      if ("error" in r) throw new Error(r.error);
      expect(r.invite.expiresAt.getTime() - now.getTime()).toBe(HOUSEHOLD_INVITE_TTL_MS);
      const joiner = await person(t);
      // The lookup function compares with the database clock, so a 2020 invite is long expired.
      expect(await acceptHouseholdInvite(t.db, { secret: r.secret, userId: joiner.userId, confirmLeave: true })).toEqual({ status: "not_found" });
    });
  });

  describe("accept", () => {
    it("previews, then moves a one-person household's owner into the inviting household", async () => {
      const owner = await person(t, { name: "Pat" });
      const joiner = await person(t, { email: "grandma@example.test" });
      await seedHistory(t, joiner.tenantId, joiner.userId);
      const token = await createDesktopToken(t.db, { userId: joiner.userId, tenantId: joiner.tenantId, role: "owner", name: "bar" });
      if ("error" in token) throw new Error(token.error);

      const inv = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: "Grandma@example.test" });
      if ("error" in inv) throw new Error(inv.error);

      const preview = await previewHouseholdInvite(t.db, { secret: inv.secret, userId: joiner.userId });
      expect(preview).toMatchObject({
        tenantId: owner.tenantId,
        inviterName: "Pat",
        kind: "email",
        emailMatches: true,
        alreadyMember: false,
        currentHousehold: { tenantId: joiner.tenantId, role: "owner", memberCount: 1, conversationCount: 1, verdictCount: 1, hasForwardingAddress: false },
      });

      expect(await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: joiner.userId, confirmLeave: false })).toEqual({
        status: "confirm_required",
      });
      const accepted = await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: joiner.userId, confirmLeave: true });
      expect(accepted).toMatchObject({
        status: "accepted",
        tenantId: owner.tenantId,
        previousTenantId: joiner.tenantId,
        orphanedBlobUrls: [`https://blob.test/${joiner.tenantId}/a`],
      });

      expect(await findTenantForUser(t.db, joiner.userId)).toEqual({ tenantId: owner.tenantId, role: "member" });
      // The old household and everything in it is gone, including its desktop token.
      const old = tenantScoped(t.db, joiner.tenantId);
      expect(await old.count(conversations)).toBe(0);
      expect(await old.count(verdicts)).toBe(0);
      expect(await old.transaction((x) => x.tx.select().from(tenants).where(eq(tenants.id, joiner.tenantId)))).toEqual([]);
      expect(await resolveDesktopToken(t.db, token.token)).toBeNull();

      // Used: a second accept or preview finds nothing.
      expect(await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: joiner.userId, confirmLeave: true })).toEqual({ status: "not_found" });
      expect(await listPendingHouseholdInvites(t.db, owner.tenantId)).toEqual([]);
    });

    it("refuses the wrong account, unverified email, existing members and owners with members", async () => {
      const owner = await person(t);
      const inv = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "email", email: "kid@example.test" });
      if ("error" in inv) throw new Error(inv.error);

      const stranger = await person(t);
      expect((await previewHouseholdInvite(t.db, { secret: inv.secret, userId: stranger.userId }))?.emailMatches).toBe(false);
      expect(await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: stranger.userId, confirmLeave: true })).toEqual({ status: "email_mismatch" });

      const unverified = await person(t, { email: "kid@example.test", verified: false });
      expect(await acceptHouseholdInvite(t.db, { secret: inv.secret, userId: unverified.userId, confirmLeave: true })).toEqual({
        status: "email_mismatch",
      });

      const link = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
      if ("error" in link) throw new Error(link.error);
      expect((await previewHouseholdInvite(t.db, { secret: link.secret, userId: owner.userId }))?.alreadyMember).toBe(true);
      expect(await acceptHouseholdInvite(t.db, { secret: link.secret, userId: owner.userId, confirmLeave: true })).toEqual({ status: "already_member" });

      // An owner whose household has a member cannot leave it by accepting.
      const other = await person(t);
      const otherLink = await createHouseholdInvite(t.db, { tenantId: other.tenantId, invitedBy: other.userId, kind: "link" });
      if ("error" in otherLink) throw new Error(otherLink.error);
      const member = await person(t);
      expect((await acceptHouseholdInvite(t.db, { secret: otherLink.secret, userId: member.userId, confirmLeave: true })).status).toBe("accepted");
      expect(await acceptHouseholdInvite(t.db, { secret: link.secret, userId: other.userId, confirmLeave: true })).toEqual({
        status: "owns_household_with_members",
      });
      // A member of another household must leave first.
      expect(await acceptHouseholdInvite(t.db, { secret: link.secret, userId: member.userId, confirmLeave: true })).toEqual({
        status: "already_in_household",
      });
      // The link is still usable after all those refusals.
      expect(await listPendingHouseholdInvites(t.db, owner.tenantId)).toHaveLength(2);
    });

    it("lets only one of two concurrent accepts of a link win", async () => {
      const owner = await person(t);
      const link = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
      if ("error" in link) throw new Error(link.error);
      const a = await person(t);
      const b = await person(t);
      const results = await Promise.all([
        acceptHouseholdInvite(t.db, { secret: link.secret, userId: a.userId, confirmLeave: true }),
        acceptHouseholdInvite(t.db, { secret: link.secret, userId: b.userId, confirmLeave: true }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["accepted", "not_found"]);
    });

    it("enforces one household per user in the schema", async () => {
      const a = await person(t);
      const b = await person(t);
      await expect(
        tenantScoped(t.db, b.tenantId).insert(memberships, { userId: a.userId, role: "member" }),
      ).rejects.toThrow();
    });
  });

  describe("leave and remove", () => {
    it("deletes the leaver's conversations, keeps verdicts, revokes their tokens", async () => {
      const owner = await person(t);
      const link = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
      if ("error" in link) throw new Error(link.error);
      const member = await person(t);
      await acceptHouseholdInvite(t.db, { secret: link.secret, userId: member.userId, confirmLeave: true });
      await seedHistory(t, owner.tenantId, member.userId);
      const token = await createDesktopToken(t.db, { userId: member.userId, tenantId: owner.tenantId, role: "member", name: "bar" });
      if ("error" in token) throw new Error(token.error);

      expect(await leaveHousehold(t.db, { tenantId: owner.tenantId, userId: owner.userId })).toEqual({ status: "owner_cannot_leave", conversationsDeleted: 0 });
      expect(await leaveHousehold(t.db, { tenantId: owner.tenantId, userId: member.userId })).toEqual({ status: "left", conversationsDeleted: 1 });
      expect(await leaveHousehold(t.db, { tenantId: owner.tenantId, userId: member.userId })).toEqual({ status: "not_found" });

      const scoped = tenantScoped(t.db, owner.tenantId);
      expect(await scoped.count(conversations, eq(conversations.userId, member.userId))).toBe(0);
      expect(await scoped.count(verdicts, eq(verdicts.userId, member.userId))).toBe(1);
      expect(await findTenantForUser(t.db, member.userId)).toBeUndefined();
      expect(await resolveDesktopToken(t.db, token.token)).toBeNull();
      const live = await t.db.select().from(desktopTokens).where(and(eq(desktopTokens.userId, member.userId), isNull(desktopTokens.revokedAt)));
      expect(live).toEqual([]);
    });

    it("lets the owner remove a member but not themselves", async () => {
      const owner = await person(t);
      const link = await createHouseholdInvite(t.db, { tenantId: owner.tenantId, invitedBy: owner.userId, kind: "link" });
      if ("error" in link) throw new Error(link.error);
      const member = await person(t);
      await acceptHouseholdInvite(t.db, { secret: link.secret, userId: member.userId, confirmLeave: true });

      expect(await removeHouseholdMember(t.db, { tenantId: owner.tenantId, userId: owner.userId, removedBy: owner.userId })).toEqual({
        status: "cannot_remove_owner",
        conversationsDeleted: 0,
      });
      expect(await removeHouseholdMember(t.db, { tenantId: owner.tenantId, userId: member.userId, removedBy: owner.userId })).toEqual({
        status: "removed",
        conversationsDeleted: 0,
      });
      expect(await findTenantForUser(t.db, member.userId)).toBeUndefined();
      // The removed user gets a fresh household on next sign-in, as before.
      const fresh = await createTenantForUser(t.db, { userId: member.userId, name: "New" });
      expect(fresh.tenantId).not.toBe(owner.tenantId);
    });

    it("never touches another household's invites", async () => {
      const a = await person(t);
      const b = await person(t);
      const inv = await createHouseholdInvite(t.db, { tenantId: a.tenantId, invitedBy: a.userId, kind: "link" });
      if ("error" in inv) throw new Error(inv.error);
      const rows = await tenantScoped(t.db, b.tenantId).select(householdInvites);
      expect(rows).toEqual([]);
    });
  });
});
