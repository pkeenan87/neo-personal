/**
 * Member-linked messaging channels (_specs/v2-m3-cutover.md section 5). A member links a phone number from
 * the console: an unverified `member_channels` row is stored with a keyed hash of a six-digit code
 * (10 minutes, 5 attempts, the counter persisted), the code goes out over the channel, and the number is
 * trusted only once the code is confirmed. A sender is resolved to a member before any tenant is known
 * through the `lookup_member_channel()` definer function, which sees verified rows only.
 *
 * Tenant-scoped helpers take a `TenantDb`; the code is never stored or returned except from
 * `startChannelVerification`, once, for the sender to deliver.
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { deriveKey, masterKeyFromEnv } from "@neo/core";
import type { Db } from "./client.js";
import { memberChannels, members, type MemberChannelKind } from "./schema/index.js";
import type { TenantDb } from "./tenant.js";

export const CHANNEL_CODE_TTL_MS = 10 * 60 * 1000;
export const CHANNEL_CODE_MAX_ATTEMPTS = 5;
/** Numbers (verified or pending) one member can have at once. */
export const MAX_CHANNELS_PER_MEMBER = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_LABEL = "neo-member-channel-code-v1";
const DEV_KEY = "neo-dev-member-channel-code-not-for-production";

export type MemberChannelRow = typeof memberChannels.$inferSelect;
/** A channel as the console shows it: never the code hash. */
export interface MemberChannelPublic {
  id: string;
  memberId: string;
  channel: MemberChannelKind;
  platformId: string;
  verified: boolean;
  /** Pending only: when the code stops working. */
  verificationExpiresAt: Date | null;
  createdAt: Date;
}

/** A canonical E.164 number (`+` and 8 to 15 digits, no leading zero), or null. Spaces, dots, dashes and brackets are dropped. */
export function normalizeE164(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length > 32) return null;
  const compact = trimmed.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

function codeKey(tenantId: string, source: NodeJS.ProcessEnv): Uint8Array {
  const master = masterKeyFromEnv(source);
  if (master) return deriveKey(master, CODE_LABEL, tenantId);
  if (source.NODE_ENV === "production" || source.VERCEL_ENV) throw new Error("@neo/db: NEO_MASTER_KEY is required to link a channel");
  return deriveKey(new Uint8Array(createHash("sha256").update(DEV_KEY, "utf8").digest()), CODE_LABEL, tenantId);
}

/** HMAC-SHA-256 hex of the code, keyed per household and bound to the member and number, so a database dump cannot be brute-forced offline without the master key. */
export function hashChannelCode(tenantId: string, memberId: string, platformId: string, code: string, source: NodeJS.ProcessEnv = process.env): string {
  return createHmac("sha256", codeKey(tenantId, source)).update(`${memberId}:${platformId}:${code}`, "utf8").digest("hex");
}

export function generateChannelCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function toPublicChannel(r: MemberChannelRow): MemberChannelPublic {
  return {
    id: r.id,
    memberId: r.memberId,
    channel: r.channel,
    platformId: r.platformId,
    verified: r.verifiedAt !== null,
    verificationExpiresAt: r.verifiedAt ? null : r.verificationExpiresAt,
    createdAt: r.createdAt,
  };
}

export interface ResolvedChannelMember {
  tenantId: string;
  memberId: string;
  /** The member's account, null for a member without one. */
  userId: string | null;
  /** The household role from `memberships`; `member` when the member has no account. */
  role: "owner" | "member";
}

/**
 * Who verifiably owns this platform id, across households (security-definer `lookup_member_channel`;
 * verified rows only). Undefined for an unknown or merely claimed number.
 */
export async function lookupMemberChannel(db: Db, channel: MemberChannelKind, platformId: string): Promise<ResolvedChannelMember | undefined> {
  const res = await db.execute(sql`select tenant_id, member_id, user_id, role from lookup_member_channel(${channel}, ${platformId})`);
  const [r] = (res as unknown as { rows: Array<{ tenant_id: string; member_id: string; user_id: string | null; role: string }> }).rows;
  if (!r) return undefined;
  return { tenantId: r.tenant_id, memberId: r.member_id, userId: r.user_id, role: r.role === "owner" ? "owner" : "member" };
}

export async function listMemberChannels(tdb: TenantDb, memberId: string): Promise<MemberChannelPublic[]> {
  if (!UUID_RE.test(memberId)) return [];
  const rows = await tdb.select(memberChannels, eq(memberChannels.memberId, memberId), { orderBy: [asc(memberChannels.createdAt)] });
  return rows.map(toPublicChannel);
}

export type StartVerificationResult =
  | { ok: true; channel: MemberChannelPublic; code: string }
  | { ok: false; reason: "no_member" | "limit" | "taken" };

/**
 * Store (or restart) an unverified claim on `platformId` and return the one-time code for the caller to
 * send. A number someone already verified is `taken`. Restarting resets the attempts and the expiry.
 */
export async function startChannelVerification(
  tdb: TenantDb,
  input: { memberId: string; channel: MemberChannelKind; platformId: string },
  opts: { now?: Date; source?: NodeJS.ProcessEnv } = {},
): Promise<StartVerificationResult> {
  const now = opts.now ?? new Date();
  if (!UUID_RE.test(input.memberId)) return { ok: false, reason: "no_member" };
  const code = generateChannelCode();
  const hash = hashChannelCode(tdb.tenantId, input.memberId, input.platformId, code, opts.source);
  return tdb.transaction(async (t) => {
    await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`neo:member-channels:${tdb.tenantId}`}, 0))`);
    if (!(await t.first(members, eq(members.id, input.memberId)))) return { ok: false, reason: "no_member" } as const;
    const taken = await lookupVerifiedOwner(t.tx, input.channel, input.platformId);
    if (taken) return { ok: false, reason: "taken" } as const;
    const mine = await t.select(memberChannels, eq(memberChannels.memberId, input.memberId));
    const existing = mine.find((r) => r.channel === input.channel && r.platformId === input.platformId);
    if (!existing && mine.length >= MAX_CHANNELS_PER_MEMBER) return { ok: false, reason: "limit" } as const;
    const fields = { verificationCodeHash: hash, verificationExpiresAt: new Date(now.getTime() + CHANNEL_CODE_TTL_MS), verificationAttempts: 0 };
    const [row] = existing
      ? await t.update(memberChannels, fields, eq(memberChannels.id, existing.id))
      : await t.insert(memberChannels, { memberId: input.memberId, channel: input.channel, platformId: input.platformId, ...fields });
    if (!row) throw new Error("@neo/db: member channel write returned no row");
    return { ok: true, channel: toPublicChannel(row), code } as const;
  });
}

/** Whether any household has already verified this number (the definer function sees across tenants). */
async function lookupVerifiedOwner(tx: Parameters<Parameters<TenantDb["transaction"]>[0]>[0]["tx"], channel: string, platformId: string): Promise<boolean> {
  const res = await tx.execute(sql`select 1 as x from lookup_member_channel(${channel}, ${platformId})`);
  return ((res as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

export type ConfirmVerificationResult =
  | { ok: true; channel: MemberChannelPublic }
  | { ok: false; reason: "not_found" | "invalid" | "expired" | "too_many_attempts" | "taken" };

/**
 * Check a typed code against the pending claim. Each wrong guess spends one of 5 persisted attempts (the
 * row is locked so concurrent guesses cannot exceed it); the code is cleared on success, expiry-lockout
 * or exhaustion, so a spent code can never be tried again.
 */
export async function confirmChannelVerification(
  tdb: TenantDb,
  input: { memberId: string; channel: MemberChannelKind; platformId: string; code: string },
  opts: { now?: Date; source?: NodeJS.ProcessEnv } = {},
): Promise<ConfirmVerificationResult> {
  const now = opts.now ?? new Date();
  if (!UUID_RE.test(input.memberId)) return { ok: false, reason: "not_found" };
  return tdb.transaction(async (t) => {
    await t.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`neo:member-channels:${tdb.tenantId}`}, 0))`);
    const row = await t.first(
      memberChannels,
      and(eq(memberChannels.memberId, input.memberId), eq(memberChannels.channel, input.channel), eq(memberChannels.platformId, input.platformId), isNull(memberChannels.verifiedAt), isNotNull(memberChannels.verificationCodeHash)),
    );
    if (!row || !row.verificationCodeHash) return { ok: false, reason: "not_found" } as const;
    if (!row.verificationExpiresAt || row.verificationExpiresAt <= now) {
      await t.update(memberChannels, { verificationCodeHash: null, verificationExpiresAt: null }, eq(memberChannels.id, row.id));
      return { ok: false, reason: "expired" } as const;
    }
    if (row.verificationAttempts >= CHANNEL_CODE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" } as const;
    const attempts = row.verificationAttempts + 1;
    const typed = hashChannelCode(tdb.tenantId, input.memberId, input.platformId, input.code.trim(), opts.source);
    if (!equalHex(typed, row.verificationCodeHash)) {
      // The last wrong guess burns the code: the owner has to ask for a new one.
      await t.update(
        memberChannels,
        attempts >= CHANNEL_CODE_MAX_ATTEMPTS ? { verificationAttempts: attempts, verificationCodeHash: null, verificationExpiresAt: null } : { verificationAttempts: attempts },
        eq(memberChannels.id, row.id),
      );
      return { ok: false, reason: attempts >= CHANNEL_CODE_MAX_ATTEMPTS ? "too_many_attempts" : "invalid" } as const;
    }
    if (await lookupVerifiedOwner(t.tx, input.channel, input.platformId)) return { ok: false, reason: "taken" } as const;
    const [done] = await t.update(
      memberChannels,
      { verifiedAt: now, verificationCodeHash: null, verificationExpiresAt: null, verificationAttempts: attempts },
      eq(memberChannels.id, row.id),
    );
    if (!done) throw new Error("@neo/db: member channel update returned no row");
    return { ok: true, channel: toPublicChannel(done) } as const;
  });
}

/** Remove one channel (verified or pending) of a member. False when it is not this member's. */
export async function removeMemberChannel(tdb: TenantDb, memberId: string, channelId: string): Promise<boolean> {
  if (!UUID_RE.test(memberId) || !UUID_RE.test(channelId)) return false;
  const rows = await tdb.delete(memberChannels, and(eq(memberChannels.id, channelId), eq(memberChannels.memberId, memberId)));
  return rows.length > 0;
}
