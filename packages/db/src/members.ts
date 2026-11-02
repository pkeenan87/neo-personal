/**
 * Protected members and layered policies (_specs/v2-m1-elder.md §2, §3). `members` is one
 * row per household member (kept in step with `memberships` by the callers that insert or
 * delete a membership). The `*Tx` helpers run inside a caller's tenant transaction; the
 * rest take a tenant-scoped handle. Every query filters on tenant_id.
 *
 * The helper contact address is encrypted with a per-tenant key derived from NEO_MASTER_KEY
 * (the same envelope as breach-monitoring addresses: AES-256-GCM via @neo/core, bound to the
 * tenant and the row through the AAD) and stored as base64.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { ArtifactDecryptError, decryptArtifact, deriveKey, encryptArtifact, masterKeyFromEnv } from "@neo/core";
import type { Tx } from "./client.js";
import {
  MEMBER_DISPLAY_NAME_MAX,
  MEMBER_ROLES,
  PROTECTION_MODES,
  desktopTokens,
  deviceEnrollmentCodes,
  devices,
  members,
  memberships,
  policies,
  users,
  type MemberRole,
  type PolicyScope,
  type ProtectionMode,
} from "./schema/index.js";
import type { TenantDb } from "./tenant.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTACT_LABEL = "neo-member-contact-v1";
const DEV_MASTER_KEY = "neo-dev-member-contact-not-for-production";
export const MAX_HELPERS_PER_MEMBER = 10;
const MAX_CONTACT = 254;

export type MemberRow = typeof members.$inferSelect;

/** A member without the ciphertext. */
export interface Member extends Omit<MemberRow, "contactCiphertext"> {
  hasContact: boolean;
}

export interface MemberPatch {
  displayName?: string;
  role?: MemberRole;
  mode?: ProtectionMode;
  birthYear?: number | null;
  helperMemberIds?: string[];
  /** Helper contact email; null clears it. */
  contact?: string | null;
}

export interface ProtectionLayers {
  memberId: string | null;
  mode: ProtectionMode;
  household?: unknown;
  member?: unknown;
  device?: unknown;
}

// ─── Contact encryption ────────────────────────────────────────────

function contactKey(tenantId: string, source: NodeJS.ProcessEnv): Uint8Array {
  const master = masterKeyFromEnv(source);
  if (master) return deriveKey(master, CONTACT_LABEL, tenantId);
  // Deterministic dev key only outside a deployment; a deployment with no key fails closed.
  if (source.NODE_ENV === "production" || source.VERCEL_ENV) throw new Error("@neo/db: NEO_MASTER_KEY is required to store contact addresses");
  return deriveKey(new Uint8Array(createHash("sha256").update(DEV_MASTER_KEY, "utf8").digest()), CONTACT_LABEL, tenantId);
}

function contactAad(tenantId: string, subject: string): string {
  return `neo:member-contact:v1:${tenantId}:${subject}`;
}

/** Normalize and validate an email address; null when it is not one. */
export function normalizeContact(input: string): string | null {
  const v = input.trim().toLowerCase();
  return v.length <= MAX_CONTACT && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(v) ? v : null;
}

/** Encrypt an address for `subject` (a member id, or an outbox key) into base64. */
export function encryptContact(tenantId: string, subject: string, address: string, source: NodeJS.ProcessEnv = process.env): string {
  const normalized = normalizeContact(address);
  if (!normalized) throw new Error("@neo/db: a valid email address is required");
  const blob = encryptArtifact(contactKey(tenantId, source), new TextEncoder().encode(normalized), contactAad(tenantId, subject));
  return Buffer.from(blob).toString("base64");
}

/** Inverse of `encryptContact`. Throws ArtifactDecryptError on any failure. */
export function decryptContact(tenantId: string, subject: string, ciphertext: string, source: NodeJS.ProcessEnv = process.env): string {
  const plain = decryptArtifact(contactKey(tenantId, source), new Uint8Array(Buffer.from(ciphertext, "base64")), contactAad(tenantId, subject));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new ArtifactDecryptError("contact address is not valid UTF-8");
  }
}

// ─── Pure helpers ──────────────────────────────────────────────────

/** users.name, else the email local part, else "Member"; clipped to the column limit. */
export function defaultDisplayName(user: { name?: string | null; email?: string | null } | undefined): string {
  const name = user?.name?.trim();
  const local = user?.email?.split("@")[0]?.trim();
  return [...(name || local || "Member")].slice(0, MEMBER_DISPLAY_NAME_MAX).join("");
}

/** The members.role a membership role maps to. */
export function memberRoleForMembership(role: "owner" | "member"): MemberRole {
  return role === "owner" ? "owner" : "adult";
}

export function normalizeDisplayName(input: string): string | null {
  const v = [...input.trim().replace(/\s+/g, " ")];
  return v.length >= 1 && v.length <= MEMBER_DISPLAY_NAME_MAX ? v.join("") : null;
}

function toMember(row: MemberRow): Member {
  const { contactCiphertext, ...rest } = row;
  return { ...rest, hasContact: contactCiphertext !== null };
}

// ─── Transaction-level helpers (used by memberships/devices/alerts callers) ─────

/**
 * Ensure the `members` row for a user exists in the tenant (idempotent) and return its id.
 * `tx` must already have app.tenant_id set to `tenantId`.
 */
export async function ensureMemberForUserTx(
  tx: Tx,
  tenantId: string,
  input: { userId: string; role: MemberRole; displayName?: string },
): Promise<string> {
  let displayName = input.displayName ? normalizeDisplayName(input.displayName) : null;
  if (!displayName) {
    const [u] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
    displayName = defaultDisplayName(u);
  }
  const [row] = await tx
    .insert(members)
    .values({ tenantId, userId: input.userId, displayName, role: input.role })
    .onConflictDoNothing({ target: [members.tenantId, members.userId] })
    .returning({ id: members.id });
  if (row) return row.id;
  const existing = await memberIdForUserTx(tx, tenantId, input.userId);
  if (!existing) throw new Error("@neo/db: member insert returned no row");
  return existing;
}

/** SQL for the id of a user's `members` row in a tenant (a scalar subquery; null when there is none). */
export function memberIdOfUserSql(tenantId: string, userId: string): SQL {
  return sql`(select ${members.id} from ${members} where ${members.tenantId} = ${tenantId} and ${members.userId} = ${userId})`;
}

export async function memberIdForUserTx(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Delete a user's member row and drop it from other members' helper lists. A member's devices,
 * pending enrollment codes and monitoring tokens that are still live are revoked first: they keep
 * their rows (member_id becomes null) but an active one must have a member.
 */
export async function deleteMemberForUserTx(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  const [member] = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  if (member) await revokeMemberDevicesTx(tx, tenantId, member.id, new Date());
  const [gone] = await tx
    .delete(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .returning({ id: members.id });
  if (!gone) return false;
  await tx
    .update(members)
    .set({ helperMemberIds: sql`array_remove(${members.helperMemberIds}, ${gone.id}::uuid)` })
    .where(and(eq(members.tenantId, tenantId), sql`${gone.id}::uuid = any(${members.helperMemberIds})`));
  return true;
}

/** Revoke a member's live devices, monitoring tokens and unredeemed enrollment codes (idempotent). */
export async function revokeMemberDevicesTx(tx: Tx, tenantId: string, memberId: string, now: Date): Promise<void> {
  await tx
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.tenantId, tenantId), eq(devices.memberId, memberId), isNull(devices.revokedAt)));
  await tx
    .update(deviceEnrollmentCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(deviceEnrollmentCodes.tenantId, tenantId),
        eq(deviceEnrollmentCodes.memberId, memberId),
        isNull(deviceEnrollmentCodes.revokedAt),
        isNull(deviceEnrollmentCodes.redeemedAt),
      ),
    );
  await tx
    .update(desktopTokens)
    .set({ revokedAt: now })
    .where(and(eq(desktopTokens.tenantId, tenantId), eq(desktopTokens.memberId, memberId), isNull(desktopTokens.revokedAt)));
}

// ─── Tenant-scoped API ─────────────────────────────────────────────

export async function listMembers(tdb: TenantDb): Promise<Member[]> {
  const rows = await tdb.select(members, undefined, { orderBy: [sql`${members.createdAt} asc`, sql`${members.id} asc`] });
  return rows.map(toMember);
}

export async function getMember(tdb: TenantDb, memberId: string): Promise<Member | undefined> {
  if (!UUID_RE.test(memberId)) return undefined;
  const row = await tdb.first(members, eq(members.id, memberId));
  return row && toMember(row);
}

export async function getMemberByUserId(tdb: TenantDb, userId: string): Promise<Member | undefined> {
  const row = await tdb.first(members, eq(members.userId, userId));
  return row && toMember(row);
}

/** The decrypted helper contact address, or null when none is set. */
export async function getMemberContact(tdb: TenantDb, memberId: string): Promise<string | null> {
  if (!UUID_RE.test(memberId)) return null;
  const row = await tdb.first(members, eq(members.id, memberId));
  if (!row?.contactCiphertext) return null;
  return decryptContact(tdb.tenantId, row.id, row.contactCiphertext);
}

/** Create the member row for an account (idempotent per user). */
export async function createMemberForUser(
  tdb: TenantDb,
  input: { userId: string; displayName?: string; role: MemberRole },
): Promise<Member> {
  if (!(MEMBER_ROLES as readonly string[]).includes(input.role)) throw new Error("@neo/db: unknown member role");
  return tdb.transaction(async (t) => {
    const id = await ensureMemberForUserTx(t.tx, tdb.tenantId, input);
    const row = await t.first(members, eq(members.id, id));
    if (!row) throw new Error("@neo/db: member not readable");
    return toMember(row);
  });
}

/**
 * Update a member and return it, or undefined when it does not exist. Throws on invalid input:
 * unknown role/mode, bad name or contact, helpers that are not other members of the household,
 * or a change to or from the `owner` role (ownership follows the membership, not this row).
 */
export async function updateMember(tdb: TenantDb, memberId: string, patch: MemberPatch): Promise<Member | undefined> {
  if (!UUID_RE.test(memberId)) return undefined;
  return tdb.transaction(async (t) => {
    const current = await t.first(members, eq(members.id, memberId));
    if (!current) return undefined;
    const set: Partial<typeof members.$inferInsert> = { updatedAt: new Date() };
    if (patch.displayName !== undefined) {
      const name = normalizeDisplayName(patch.displayName);
      if (!name) throw new Error("@neo/db: invalid display name");
      set.displayName = name;
    }
    if (patch.role !== undefined) {
      if (!(MEMBER_ROLES as readonly string[]).includes(patch.role)) throw new Error("@neo/db: unknown member role");
      if ((patch.role === "owner") !== (current.role === "owner")) throw new Error("@neo/db: the owner role cannot be assigned or removed");
      set.role = patch.role;
    }
    if (patch.mode !== undefined) {
      if (!(PROTECTION_MODES as readonly string[]).includes(patch.mode)) throw new Error("@neo/db: unknown protection mode");
      set.mode = patch.mode;
    }
    if (patch.birthYear !== undefined) {
      const y = patch.birthYear;
      if (y !== null && (!Number.isInteger(y) || y < 1900 || y > new Date().getUTCFullYear())) throw new Error("@neo/db: invalid birth year");
      set.birthYear = y;
    }
    if (patch.helperMemberIds !== undefined) {
      const ids = [...new Set(patch.helperMemberIds)];
      if (ids.length > MAX_HELPERS_PER_MEMBER) throw new Error("@neo/db: too many helpers");
      if (ids.some((id) => !UUID_RE.test(id) || id === memberId)) throw new Error("@neo/db: invalid helper");
      if (ids.length > 0) {
        const found = await t.select(members, sql`${members.id} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
        if (found.length !== ids.length) throw new Error("@neo/db: helper is not a member of this household");
      }
      set.helperMemberIds = ids;
    }
    if (patch.contact !== undefined) {
      set.contactCiphertext = patch.contact === null || patch.contact.trim() === "" ? null : encryptContact(tdb.tenantId, memberId, patch.contact);
    }
    const [row] = await t.update(members, set, eq(members.id, memberId));
    return row && toMember(row);
  });
}

/** Delete the member row for a user (and drop it from helper lists). True when one existed. */
export async function deleteMemberForUser(tdb: TenantDb, userId: string): Promise<boolean> {
  return tdb.transaction((t) => deleteMemberForUserTx(t.tx, tdb.tenantId, userId));
}

// ─── Policies ──────────────────────────────────────────────────────

/** Latest rules for one scope, or undefined. */
async function latestRules(t: { first: TenantDb["first"] }, scope: PolicyScope, scopeId: string | null): Promise<unknown> {
  const where = and(eq(policies.scope, scope), scopeId === null ? sql`${policies.scopeId} is null` : eq(policies.scopeId, scopeId));
  const row = await t.first(policies, where, { orderBy: [sql`${policies.version} desc`] });
  return row?.rules;
}

/** The latest raw rules of one member's `member`-scope policy, or undefined (never validated here). */
export async function latestMemberRules(tdb: TenantDb, memberId: string): Promise<unknown> {
  if (!UUID_RE.test(memberId)) return undefined;
  return tdb.transaction((t) => latestRules(t, "member", memberId));
}

/**
 * The user's role in the household, read from `memberships` (the source of truth for who is an
 * owner; `members.role` is a display label). Undefined when the user is not in the household.
 */
export async function getMembershipRole(tdb: TenantDb, userId: string): Promise<"owner" | "member" | undefined> {
  const row = await tdb.first(memberships, eq(memberships.userId, userId));
  return row?.role;
}

/** How many owners the household has. */
export async function countHouseholdOwners(tdb: TenantDb): Promise<number> {
  return tdb.count(memberships, eq(memberships.role, "owner"));
}

/**
 * The raw policy layers for a user, or directly for a member (the device's member, which may have
 * no account), and optionally one of their devices: the latest rules at
 * household, member and device scope. Validation and merging happen in @neo/core. A user with
 * no member row reads as Standard mode with no member layer.
 */
export async function getProtectionLayers(
  tdb: TenantDb,
  input: ({ userId: string; memberId?: undefined } | { memberId: string; userId?: undefined }) & { deviceId?: string | null },
): Promise<ProtectionLayers> {
  return tdb.transaction(async (t) => {
    const member =
      input.memberId !== undefined
        ? UUID_RE.test(input.memberId)
          ? await t.first(members, eq(members.id, input.memberId))
          : undefined
        : await t.first(members, eq(members.userId, input.userId));
    const household = await latestRules(t, "household", null);
    const memberRules = member ? await latestRules(t, "member", member.id) : undefined;
    let deviceRules: unknown;
    if (input.deviceId && UUID_RE.test(input.deviceId)) {
      // Only a device that exists in this household has a layer.
      const dev = await t.first(devices, eq(devices.id, input.deviceId));
      if (dev) deviceRules = await latestRules(t, "device", dev.id);
    }
    return {
      memberId: member?.id ?? null,
      mode: member?.mode ?? "standard",
      ...(household !== undefined ? { household } : {}),
      ...(memberRules !== undefined ? { member: memberRules } : {}),
      ...(deviceRules !== undefined ? { device: deviceRules } : {}),
    };
  });
}

/**
 * Append the next version (max + 1) of a scope's rules. Serialized per scope with an advisory
 * lock so concurrent writers cannot collide on the unique index. Returns the stored version.
 */
export async function insertPolicyVersion(
  tdb: TenantDb,
  input: { scope: PolicyScope; scopeId: string | null; rules: unknown; createdBy?: string | null },
): Promise<{ id: string; version: number }> {
  if ((input.scope === "household") !== (input.scopeId === null)) throw new Error("@neo/db: scopeId is required except for the household scope");
  if (input.scopeId !== null && !UUID_RE.test(input.scopeId)) throw new Error("@neo/db: invalid scopeId");
  return tdb.transaction(async (t) => {
    await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`neo:policy:${tdb.tenantId}:${input.scope}:${input.scopeId ?? ""}`}, 0))`);
    const scopeCond = and(eq(policies.scope, input.scope), input.scopeId === null ? sql`${policies.scopeId} is null` : eq(policies.scopeId, input.scopeId));
    const [top] = await t.select(policies, scopeCond, { orderBy: [sql`${policies.version} desc`], limit: 1 });
    const [row] = await t.insert(policies, {
      scope: input.scope,
      scopeId: input.scopeId,
      version: (top?.version ?? 0) + 1,
      rules: input.rules,
      createdBy: input.createdBy ?? null,
    });
    if (!row) throw new Error("@neo/db: policy insert returned no row");
    return { id: row.id, version: row.version };
  });
}
