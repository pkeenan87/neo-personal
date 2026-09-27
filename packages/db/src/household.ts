/**
 * Household invites and membership changes (_specs/household-invites.md).
 *
 *   create / list / revoke / rotate   owner, inside the household's tenant context
 *   preview / accept                  any signed-in user holding the secret
 *   removeMember / leave              owner removes a member; a member leaves
 *
 * A user belongs to exactly one household (unique `memberships(user_id)`). Accepting
 * an invite deletes the user's own one-person household (cascading its data) and adds
 * them as a `member`; leaving or being removed deletes their conversations in the
 * household and revokes their desktop tokens, and the next sign-in creates a fresh
 * household (`resolveTenant` in apps/web/auth.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import {
  artifacts,
  auditEvents,
  conversations,
  desktopAuthRequests,
  desktopTokens,
  householdInvites,
  inboundAddresses,
  memberships,
  tenants,
  users,
  verdicts,
  type HouseholdInviteKind,
  type MembershipRole,
} from "./schema/index.js";
import { assertTenantId, setTenantContext, setUserContext, tenantScoped } from "./tenant.js";

export const INVITE_SECRET_PREFIX = "neo_inv_";
export const HOUSEHOLD_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Members plus pending invites. */
export const MAX_HOUSEHOLD_SIZE = 10;
const MAX_EMAIL_LENGTH = 254;

export interface HouseholdInvitePublic {
  id: string;
  kind: HouseholdInviteKind;
  email: string | null;
  tokenPrefix: string;
  sendCount: number;
  createdAt: Date;
  expiresAt: Date;
  invitedBy: string | null;
  invitedByName: string | null;
}

export type CreateInviteError = "invalid_email" | "already_member" | "invite_pending" | "household_full";

export interface InvitePreview {
  inviteId: string;
  tenantId: string;
  householdName: string;
  inviterName: string | null;
  kind: HouseholdInviteKind;
  /** True for link invites; for email invites, whether the user's verified email matches. */
  emailMatches: boolean;
  alreadyMember: boolean;
  /** The household the user belongs to now, or null (none yet). */
  currentHousehold: {
    tenantId: string;
    name: string;
    role: MembershipRole;
    memberCount: number;
    conversationCount: number;
    verdictCount: number;
    hasForwardingAddress: boolean;
  } | null;
}

export type AcceptInviteError =
  | "not_found"
  | "email_mismatch"
  | "already_member"
  | "owns_household_with_members"
  | "already_in_household"
  | "confirm_required";

export type AcceptInviteResult =
  | {
      status: "accepted";
      inviteId: string;
      kind: HouseholdInviteKind;
      tenantId: string;
      householdName: string;
      invitedBy: string | null;
      /** The one-person household that was deleted, if the user had one. */
      previousTenantId: string | null;
      /** Blob URLs of the deleted household's artifacts; delete them after commit. */
      orphanedBlobUrls: string[];
    }
  | { status: AcceptInviteError };

export type DetachResult<S extends string> = { status: S; conversationsDeleted: number } | { status: "not_found" };

// ─── Secrets and input ─────────────────────────────────────────────

export function mintInviteSecret(): string {
  return `${INVITE_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isInviteSecretFormat(secret: string): boolean {
  return /^neo_inv_[A-Za-z0-9_-]{43}$/.test(secret);
}

export function hashInviteSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function inviteSecretPrefix(secret: string): string {
  return secret.slice(INVITE_SECRET_PREFIX.length, INVITE_SECRET_PREFIX.length + 8);
}

/** Trimmed, lowercased address, or null when it is not a plausible single address. */
export function normalizeInviteEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  // One @, a dot in the domain, no whitespace, control characters, or list separators.
  // eslint-disable-next-line no-control-regex
  if (!/^[^\s@,;<>"\u0000-\u001f\u007f]+@[^\s@,;<>"\u0000-\u001f\u007f]+\.[^\s@,;<>"\u0000-\u001f\u007f]+$/.test(email)) return null;
  return email;
}

// ─── Helpers ───────────────────────────────────────────────────────

function pendingWhere(now: Date): SQL {
  return and(isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt), gt(householdInvites.expiresAt, now)) as SQL;
}

function isPending(r: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return !r.acceptedAt && !r.revokedAt && r.expiresAt.getTime() > now.getTime();
}

async function lockHousehold(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"neo:household:" + tenantId}, 0))`);
}

/** Same key as createTenantForUser, so an accept cannot race a first sign-in creating a household. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"neo:create-tenant:" + userId}, 0))`);
}

async function lookupInvite(tx: Tx, secret: string): Promise<{ id: string; tenantId: string } | undefined> {
  const res = await tx.execute(sql`select id, tenant_id from lookup_household_invite(${hashInviteSecret(secret)})`);
  const [r] = (res as unknown as { rows: Array<{ id: string; tenant_id: string }> }).rows;
  return r ? { id: r.id, tenantId: r.tenant_id } : undefined;
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

const inviteColumns = {
  id: householdInvites.id,
  kind: householdInvites.kind,
  email: householdInvites.email,
  tokenPrefix: householdInvites.tokenPrefix,
  sendCount: householdInvites.sendCount,
  createdAt: householdInvites.createdAt,
  expiresAt: householdInvites.expiresAt,
  invitedBy: householdInvites.invitedBy,
  invitedByName: users.name,
};

// ─── Owner: invites ────────────────────────────────────────────────

export async function createHouseholdInvite(
  db: Db,
  input: { tenantId: string; invitedBy: string; kind: HouseholdInviteKind; email?: string; now?: Date },
): Promise<{ invite: HouseholdInvitePublic; secret: string } | { error: CreateInviteError }> {
  const now = input.now ?? new Date();
  let email: string | null = null;
  if (input.kind === "email") {
    email = normalizeInviteEmail(input.email ?? "");
    if (!email) return { error: "invalid_email" };
  }
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    await lockHousehold(t.tx, input.tenantId);
    const members = await t.tx
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, input.tenantId));
    if (email && members.some((m) => m.email?.toLowerCase() === email)) return { error: "already_member" as const };
    const pending = await t.select(householdInvites, pendingWhere(now));
    if (email && pending.some((p) => p.email === email)) return { error: "invite_pending" as const };
    if (members.length + pending.length >= MAX_HOUSEHOLD_SIZE) return { error: "household_full" as const };

    const secret = mintInviteSecret();
    const [row] = await t.insert(householdInvites, {
      kind: input.kind,
      email,
      tokenHash: hashInviteSecret(secret),
      tokenPrefix: inviteSecretPrefix(secret),
      sendCount: input.kind === "email" ? 1 : 0,
      invitedBy: input.invitedBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUSEHOLD_INVITE_TTL_MS),
    });
    if (!row) throw new Error("@neo/db: invite insert returned no row");
    const [inviter] = await t.tx.select({ name: users.name }).from(users).where(eq(users.id, input.invitedBy)).limit(1);
    return {
      secret,
      invite: {
        id: row.id,
        kind: row.kind,
        email: row.email,
        tokenPrefix: row.tokenPrefix,
        sendCount: row.sendCount,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        invitedBy: row.invitedBy,
        invitedByName: inviter?.name ?? null,
      },
    };
  });
}

/** Pending, unexpired invites, newest first. */
export async function listPendingHouseholdInvites(db: Db, tenantId: string, now = new Date()): Promise<HouseholdInvitePublic[]> {
  return tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select(inviteColumns)
      .from(householdInvites)
      .leftJoin(users, eq(users.id, householdInvites.invitedBy))
      .where(and(eq(householdInvites.tenantId, tenantId), pendingWhere(now)))
      .orderBy(desc(householdInvites.createdAt)),
  );
}

export async function revokeHouseholdInvite(db: Db, tenantId: string, inviteId: string, now = new Date()): Promise<boolean> {
  const rows = await tenantScoped(db, tenantId).update(
    householdInvites,
    { revokedAt: now },
    and(eq(householdInvites.id, inviteId), pendingWhere(now)),
  );
  return rows.length > 0;
}

/**
 * Resend support: issue a new secret for a pending email invite, reset its expiry and bump
 * `sendCount`. The old link stops working.
 */
export async function rotateHouseholdInvite(
  db: Db,
  tenantId: string,
  inviteId: string,
  now = new Date(),
): Promise<{ invite: HouseholdInvitePublic; secret: string } | { error: "not_found" }> {
  const secret = mintInviteSecret();
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const [row] = await t.update(
      householdInvites,
      {
        tokenHash: hashInviteSecret(secret),
        tokenPrefix: inviteSecretPrefix(secret),
        expiresAt: new Date(now.getTime() + HOUSEHOLD_INVITE_TTL_MS),
        sendCount: sql`${householdInvites.sendCount} + 1`,
      },
      and(eq(householdInvites.id, inviteId), eq(householdInvites.kind, "email"), pendingWhere(now)),
    );
    if (!row) return { error: "not_found" as const };
    const inviter = row.invitedBy
      ? (await t.tx.select({ name: users.name }).from(users).where(eq(users.id, row.invitedBy)).limit(1))[0]
      : undefined;
    return {
      secret,
      invite: {
        id: row.id,
        kind: row.kind,
        email: row.email,
        tokenPrefix: row.tokenPrefix,
        sendCount: row.sendCount,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        invitedBy: row.invitedBy,
        invitedByName: inviter?.name ?? null,
      },
    };
  });
}

// ─── Invitee: preview and accept ───────────────────────────────────

async function userEmail(tx: Tx, userId: string): Promise<{ email: string | null; verified: boolean }> {
  const [u] = await tx.select({ email: users.email, verified: users.emailVerified }).from(users).where(eq(users.id, userId)).limit(1);
  return { email: u?.email?.trim().toLowerCase() ?? null, verified: Boolean(u?.verified) };
}

async function currentMemberships(tx: Tx, userId: string): Promise<{ tenantId: string; role: MembershipRole }[]> {
  await setUserContext(tx, userId);
  return tx
    .select({ tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
}

async function countWhere(tx: Tx, table: typeof memberships | typeof conversations | typeof verdicts, tenantId: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(table).where(eq(table.tenantId, tenantId));
  return r?.n ?? 0;
}

/** What the invite page shows. Null for an unknown, expired, revoked or used invite. */
export async function previewHouseholdInvite(
  db: Db,
  input: { secret: string; userId: string; now?: Date },
): Promise<InvitePreview | null> {
  if (!isInviteSecretFormat(input.secret)) return null;
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const ids = await lookupInvite(tx, input.secret);
    if (!ids) return null;
    await setTenantContext(tx, ids.tenantId);
    const [inv] = await tx
      .select({ ...inviteColumns, acceptedAt: householdInvites.acceptedAt, revokedAt: householdInvites.revokedAt, householdName: tenants.name })
      .from(householdInvites)
      .innerJoin(tenants, eq(tenants.id, householdInvites.tenantId))
      .leftJoin(users, eq(users.id, householdInvites.invitedBy))
      .where(eq(householdInvites.id, ids.id))
      .limit(1);
    if (!inv || !isPending(inv, now)) return null;

    const me = await userEmail(tx, input.userId);
    const emailMatches = inv.kind === "link" || (me.verified && me.email !== null && me.email === inv.email);
    const mine = await currentMemberships(tx, input.userId);
    const alreadyMember = mine.some((m) => m.tenantId === ids.tenantId);
    const current = mine[0];
    let currentHousehold: InvitePreview["currentHousehold"] = null;
    if (current && !alreadyMember) {
      await setTenantContext(tx, current.tenantId);
      const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, current.tenantId)).limit(1);
      const [fwd] = await tx
        .select({ n: count() })
        .from(inboundAddresses)
        .where(and(eq(inboundAddresses.tenantId, current.tenantId), eq(inboundAddresses.active, true)));
      currentHousehold = {
        tenantId: current.tenantId,
        name: tenant?.name ?? "Your household",
        role: current.role,
        memberCount: await countWhere(tx, memberships, current.tenantId),
        conversationCount: await countWhere(tx, conversations, current.tenantId),
        verdictCount: await countWhere(tx, verdicts, current.tenantId),
        hasForwardingAddress: (fwd?.n ?? 0) > 0,
      };
    }
    return {
      inviteId: inv.id,
      tenantId: ids.tenantId,
      householdName: inv.householdName,
      inviterName: inv.invitedByName,
      kind: inv.kind,
      emailMatches,
      alreadyMember,
      currentHousehold,
    };
  });
}

/**
 * Accept an invite in one transaction: checks in the spec's order, then delete the
 * user's one-person household, add the `member` membership, mark the invite used.
 */
export async function acceptHouseholdInvite(
  db: Db,
  input: { secret: string; userId: string; confirmLeave: boolean; now?: Date },
): Promise<AcceptInviteResult> {
  if (!isInviteSecretFormat(input.secret)) return { status: "not_found" };
  const now = input.now ?? new Date();
  const { userId } = input;
  try {
    return await db.transaction(async (tx): Promise<AcceptInviteResult> => {
      await lockUser(tx, userId);
      const ids = await lookupInvite(tx, input.secret);
      if (!ids) return { status: "not_found" };
      await setTenantContext(tx, ids.tenantId);
      // Lock the invite so two accepts of one link cannot both succeed.
      const [inv] = await tx.select().from(householdInvites).where(eq(householdInvites.id, ids.id)).limit(1).for("update");
      if (!inv || !isPending(inv, now)) return { status: "not_found" };

      if (inv.kind === "email") {
        const me = await userEmail(tx, userId);
        if (!me.verified || !me.email || me.email !== inv.email) return { status: "email_mismatch" };
      }

      const mine = await currentMemberships(tx, userId);
      if (mine.some((m) => m.tenantId === ids.tenantId)) return { status: "already_member" };
      const previous = mine[0];
      if (previous) {
        if (previous.role !== "owner" || mine.length > 1) return { status: "already_in_household" };
        await setTenantContext(tx, previous.tenantId);
        if ((await countWhere(tx, memberships, previous.tenantId)) > 1) return { status: "owns_household_with_members" };
      }
      if (!input.confirmLeave) return { status: "confirm_required" };

      let orphanedBlobUrls: string[] = [];
      if (previous) {
        // app.tenant_id is the previous household here, so RLS allows reading and deleting it.
        orphanedBlobUrls = (
          await tx.select({ url: artifacts.blobUrl }).from(artifacts).where(eq(artifacts.tenantId, previous.tenantId))
        ).map((r) => r.url);
        await tx.delete(tenants).where(eq(tenants.id, previous.tenantId));
      }

      await setTenantContext(tx, ids.tenantId);
      await tx.insert(memberships).values({ tenantId: ids.tenantId, userId, role: "member" });
      await tx
        .update(householdInvites)
        .set({ acceptedBy: userId, acceptedAt: now })
        .where(eq(householdInvites.id, inv.id));
      await tx.insert(auditEvents).values({
        tenantId: ids.tenantId,
        userId,
        eventType: "household.invite_accepted",
        metadata: { inviteId: inv.id, kind: inv.kind, leftPreviousHousehold: Boolean(previous) },
      });
      const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ids.tenantId)).limit(1);
      return {
        status: "accepted",
        inviteId: inv.id,
        kind: inv.kind,
        tenantId: ids.tenantId,
        householdName: tenant?.name ?? "Household",
        invitedBy: inv.invitedBy,
        previousTenantId: previous?.tenantId ?? null,
        orphanedBlobUrls,
      };
    });
  } catch (err) {
    // A concurrent accept of another invite by the same user won the unique membership.
    if (isUniqueViolation(err)) return { status: "already_in_household" };
    throw err;
  }
}

// ─── Leaving ───────────────────────────────────────────────────────

async function detachMember(
  db: Db,
  tenantId: string,
  userId: string,
  refuseRole: MembershipRole,
  eventType: "household.member_removed" | "household.member_left",
  actorUserId: string,
): Promise<"not_found" | "refused" | { conversationsDeleted: number }> {
  assertTenantId(tenantId);
  return tenantScoped(db, tenantId).transaction(async (t) => {
    await lockHousehold(t.tx, tenantId);
    const row = await t.first(memberships, eq(memberships.userId, userId));
    if (!row) return "not_found" as const;
    if (row.role === refuseRole) return "refused" as const;
    // Their private chats go; their verdicts stay as household history.
    const deleted = await t.delete(conversations, eq(conversations.userId, userId));
    await t.delete(memberships, eq(memberships.userId, userId));
    // Desktop tokens snapshot the tenant; revoke rather than leave them pointing here.
    await t.tx
      .update(desktopTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(desktopTokens.userId, userId), eq(desktopTokens.tenantId, tenantId), isNull(desktopTokens.revokedAt)));
    await t.tx.delete(desktopAuthRequests).where(and(eq(desktopAuthRequests.userId, userId), eq(desktopAuthRequests.tenantId, tenantId)));
    await t.insert(auditEvents, {
      userId: actorUserId,
      eventType,
      metadata: { conversationsDeleted: deleted.length },
    });
    return { conversationsDeleted: deleted.length };
  });
}

/** Owner removes a member. The owner cannot be removed. */
export async function removeHouseholdMember(
  db: Db,
  input: { tenantId: string; userId: string; removedBy: string },
): Promise<DetachResult<"removed" | "cannot_remove_owner">> {
  const r = await detachMember(db, input.tenantId, input.userId, "owner", "household.member_removed", input.removedBy);
  if (r === "not_found") return { status: "not_found" };
  if (r === "refused") return { status: "cannot_remove_owner", conversationsDeleted: 0 };
  return { status: "removed", conversationsDeleted: r.conversationsDeleted };
}

/** A member leaves. Owners cannot leave (ownership transfer is out of scope). */
export async function leaveHousehold(
  db: Db,
  input: { tenantId: string; userId: string },
): Promise<DetachResult<"left" | "owner_cannot_leave">> {
  const r = await detachMember(db, input.tenantId, input.userId, "owner", "household.member_left", input.userId);
  if (r === "not_found") return { status: "not_found" };
  if (r === "refused") return { status: "owner_cannot_leave", conversationsDeleted: 0 };
  return { status: "left", conversationsDeleted: r.conversationsDeleted };
}
