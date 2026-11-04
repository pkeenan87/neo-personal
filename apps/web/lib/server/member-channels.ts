/**
 * Members connecting their own SMS number (_specs/v2-architecture.md section 4, _specs/v2-m3-cutover.md
 * section 5). Console side: the owner enters an E.164 number for a member, a six-digit code goes to it
 * through the `SmsSender` (the mock tonight), and a confirm call with the code verifies it (10 minutes,
 * 5 attempts, persisted). Channel side: `resolveSmsCaller` maps a sender to a member only through a verified
 * `member_channels` row, before any tenant is known.
 *
 * Postgres via @neo/db when DATABASE_URL is set, else the memory twin below. Imports nothing from Next, so
 * the eve server can bundle `resolveSmsCaller`. No log or audit line carries a number: only `hashPii(number)`.
 */
import { hashPii, logger } from "@neo/core";
import {
  CHANNEL_CODE_MAX_ATTEMPTS,
  CHANNEL_CODE_TTL_MS,
  MAX_CHANNELS_PER_MEMBER,
  confirmChannelVerification,
  generateChannelCode,
  hashChannelCode,
  listMemberChannels,
  lookupMemberChannel,
  normalizeE164,
  removeMemberChannel,
  startChannelVerification,
  tenantScoped,
  type ConfirmVerificationResult,
  type MemberChannelPublic,
  type ResolvedChannelMember,
  type StartVerificationResult,
} from "@neo/db";
import { twilioEnabled } from "@/lib/env";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";
import { memoryListMembers } from "./memory-state";
import { memoryMemberRecords } from "./memory-members";
import { takeRateSlot } from "./rate-limit";
import { getSmsSender } from "./sms-sender";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sending a code: per household, and per number so a number cannot be texted repeatedly. */
export const CHANNEL_START_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 } as const;
export const CHANNEL_START_NUMBER_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 } as const;
/** Confirm attempts per member (the 5 persisted attempts per code are the security control; this blunts floods). */
export const CHANNEL_CONFIRM_LIMIT = { limit: 15, windowMs: 10 * 60 * 1000 } as const;

export interface ChannelView {
  id: string;
  channel: "sms";
  /** Last four digits only, e.g. `+• ••• 0001`. */
  display: string;
  verified: boolean;
  verificationExpiresAt: string | null;
}

export interface ChannelList {
  channels: ChannelView[];
}

function fail(status: number, code: string, message: string): Outcome<never> {
  return { ok: false, status, code, message };
}

const NOT_FOUND = fail(404, "not_found", "That person is not in your household.");
const DISABLED = fail(404, "not_found", "Not found.");
const BAD_NUMBER = fail(400, "invalid_number", "Enter a phone number with its country code, like +15551234567.");

/** `+• ••• 0001`: enough for the owner to recognise it, nothing more. */
export function displayNumber(e164: string): string {
  return `+• ••• ${e164.slice(-4)}`;
}

function view(c: MemberChannelPublic): ChannelView {
  return {
    id: c.id,
    channel: c.channel,
    display: displayNumber(c.platformId),
    verified: c.verified,
    verificationExpiresAt: c.verificationExpiresAt ? c.verificationExpiresAt.toISOString() : null,
  };
}

// ─── Memory twin ───────────────────────────────────────────────────

interface MemoryChannel extends MemberChannelPublic {
  tenantId: string;
  codeHash: string | null;
  attempts: number;
}

const g = globalThis as typeof globalThis & { __neoMemoryChannels?: MemoryChannel[] };
const memoryChannels = (): MemoryChannel[] => (g.__neoMemoryChannels ??= []);
export function resetMemoryChannels(): void {
  g.__neoMemoryChannels = [];
}

const publicOf = (c: MemoryChannel): MemberChannelPublic => ({
  id: c.id,
  memberId: c.memberId,
  channel: c.channel,
  platformId: c.platformId,
  verified: c.verified,
  verificationExpiresAt: c.verified ? null : c.verificationExpiresAt,
  createdAt: c.createdAt,
});

function memoryStart(tenantId: string, memberId: string, platformId: string, now: Date): StartVerificationResult {
  if (!memoryMemberRecords(tenantId).some((m) => m.id === memberId)) return { ok: false, reason: "no_member" };
  const all = memoryChannels();
  if (all.some((c) => c.verified && c.platformId === platformId)) return { ok: false, reason: "taken" };
  const mine = all.filter((c) => c.tenantId === tenantId && c.memberId === memberId);
  const existing = mine.find((c) => c.platformId === platformId);
  if (!existing && mine.length >= MAX_CHANNELS_PER_MEMBER) return { ok: false, reason: "limit" };
  const code = generateChannelCode();
  const fields = { codeHash: hashChannelCode(tenantId, memberId, platformId, code), attempts: 0, verificationExpiresAt: new Date(now.getTime() + CHANNEL_CODE_TTL_MS) };
  if (existing) Object.assign(existing, fields);
  const row: MemoryChannel = existing ?? { id: crypto.randomUUID(), tenantId, memberId, channel: "sms", platformId, verified: false, createdAt: now, ...fields };
  if (!existing) all.push(row);
  return { ok: true, channel: publicOf(row), code };
}

function memoryConfirm(tenantId: string, memberId: string, platformId: string, code: string, now: Date): ConfirmVerificationResult {
  const row = memoryChannels().find((c) => c.tenantId === tenantId && c.memberId === memberId && c.platformId === platformId && !c.verified && c.codeHash);
  if (!row?.codeHash) return { ok: false, reason: "not_found" };
  if (!row.verificationExpiresAt || row.verificationExpiresAt <= now) {
    row.codeHash = null;
    return { ok: false, reason: "expired" };
  }
  if (row.attempts >= CHANNEL_CODE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  row.attempts += 1;
  if (hashChannelCode(tenantId, memberId, platformId, code.trim()) !== row.codeHash) {
    if (row.attempts >= CHANNEL_CODE_MAX_ATTEMPTS) row.codeHash = null;
    return { ok: false, reason: row.attempts >= CHANNEL_CODE_MAX_ATTEMPTS ? "too_many_attempts" : "invalid" };
  }
  if (memoryChannels().some((c) => c.verified && c.platformId === platformId)) return { ok: false, reason: "taken" };
  row.verified = true;
  row.codeHash = null;
  return { ok: true, channel: publicOf(row) };
}

// ─── Store ─────────────────────────────────────────────────────────

interface Store {
  list(memberId: string): Promise<MemberChannelPublic[]>;
  start(memberId: string, platformId: string): Promise<StartVerificationResult>;
  confirm(memberId: string, platformId: string, code: string): Promise<ConfirmVerificationResult>;
  remove(memberId: string, channelId: string): Promise<boolean>;
}

function storeFor(tenantId: string): Store {
  const db = getDb();
  if (db) {
    const tdb = tenantScoped(db, tenantId);
    return {
      list: (memberId) => listMemberChannels(tdb, memberId),
      start: (memberId, platformId) => startChannelVerification(tdb, { memberId, channel: "sms", platformId }),
      confirm: (memberId, platformId, code) => confirmChannelVerification(tdb, { memberId, channel: "sms", platformId, code }),
      remove: (memberId, channelId) => removeMemberChannel(tdb, memberId, channelId),
    };
  }
  return {
    list: async (memberId) => memoryChannels().filter((c) => c.tenantId === tenantId && c.memberId === memberId).map(publicOf),
    start: async (memberId, platformId) => memoryStart(tenantId, memberId, platformId, new Date()),
    confirm: async (memberId, platformId, code) => memoryConfirm(tenantId, memberId, platformId, code, new Date()),
    remove: async (memberId, channelId) => {
      const all = memoryChannels();
      const i = all.findIndex((c) => c.tenantId === tenantId && c.memberId === memberId && c.id === channelId);
      if (i < 0) return false;
      all.splice(i, 1);
      return true;
    },
  };
}

// ─── Console operations ────────────────────────────────────────────

async function gated<T>(actor: HouseholdActor, memberId: string, fn: (store: Store, id: string) => Promise<Outcome<T>>): Promise<Outcome<T>> {
  if (!twilioEnabled()) return DISABLED;
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  if (!UUID_RE.test(memberId)) return NOT_FOUND;
  return fn(storeFor(actor.tenantId), memberId.toLowerCase());
}

function rateLimited(retryAfterSeconds: number): Outcome<never> {
  return { ok: false, status: 429, code: "rate_limited", message: "Too many attempts. Please try again later.", retryAfterSeconds };
}

export async function listMemberSmsChannels(actor: HouseholdActor, memberId: string): Promise<Outcome<ChannelList>> {
  return gated(actor, memberId, async (store, id) => ({ ok: true, value: { channels: (await store.list(id)).map(view) } }));
}

/** Store an unverified claim and "send" the code (the mock sender logs it; nothing leaves the process). */
export async function startMemberSms(actor: HouseholdActor, memberId: string, input: { phone: string }): Promise<Outcome<ChannelList>> {
  return gated(actor, memberId, async (store, id) => {
    const phone = normalizeE164(input.phone);
    if (!phone) return BAD_NUMBER;
    const byHousehold = takeRateSlot("member-sms-start", actor.tenantId, CHANNEL_START_LIMIT.limit, CHANNEL_START_LIMIT.windowMs);
    if (!byHousehold.ok) return rateLimited(byHousehold.retryAfterSeconds);
    const byNumber = takeRateSlot("member-sms-start-number", hashPii(phone), CHANNEL_START_NUMBER_LIMIT.limit, CHANNEL_START_NUMBER_LIMIT.windowMs);
    if (!byNumber.ok) return rateLimited(byNumber.retryAfterSeconds);
    const started = await store.start(id, phone);
    if (!started.ok) {
      if (started.reason === "no_member") return NOT_FOUND;
      if (started.reason === "limit") return fail(409, "channel_limit", `A person can connect up to ${MAX_CHANNELS_PER_MEMBER} phones.`);
      return fail(409, "number_unavailable", "That number can't be connected.");
    }
    try {
      await getSmsSender().send({ to: phone, body: `Your Neo code is ${started.code}. It expires in 10 minutes.`, purpose: "verification_code" });
    } catch (err) {
      logger.error("Sending the SMS verification code failed", "member-channels", { tenantId: actor.tenantId, errorMessage: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      return fail(502, "send_failed", "We couldn't send the code. Try again in a moment.");
    }
    await recordAudit(actor.tenantId, actor.userId, "member.channel_code_sent", { memberId: id, channel: "sms", phoneHash: hashPii(phone) });
    return { ok: true, value: { channels: (await store.list(id)).map(view) } };
  });
}

const CONFIRM_FAILURES: Record<string, Outcome<never>> = {
  not_found: fail(404, "not_found", "No code is waiting for that number. Send a new one."),
  invalid: fail(400, "invalid_code", "That code isn't right."),
  expired: fail(410, "code_expired", "That code has expired. Send a new one."),
  too_many_attempts: fail(429, "too_many_attempts", "Too many wrong codes. Send a new code."),
  taken: fail(409, "number_unavailable", "That number can't be connected."),
};

export async function confirmMemberSms(actor: HouseholdActor, memberId: string, input: { phone: string; code: string }): Promise<Outcome<ChannelList>> {
  return gated(actor, memberId, async (store, id) => {
    const phone = normalizeE164(input.phone);
    if (!phone) return BAD_NUMBER;
    if (!/^\d{6}$/.test(input.code.trim())) return fail(400, "invalid_code", "Enter the six-digit code.");
    const slot = takeRateSlot("member-sms-confirm", `${actor.tenantId}:${id}`, CHANNEL_CONFIRM_LIMIT.limit, CHANNEL_CONFIRM_LIMIT.windowMs);
    if (!slot.ok) return rateLimited(slot.retryAfterSeconds);
    const result = await store.confirm(id, phone, input.code);
    if (!result.ok) {
      await recordAudit(actor.tenantId, actor.userId, "member.channel_verify_failed", { memberId: id, channel: "sms", phoneHash: hashPii(phone), reason: result.reason });
      return CONFIRM_FAILURES[result.reason] ?? fail(400, "invalid_code", "That code isn't right.");
    }
    await recordAudit(actor.tenantId, actor.userId, "member.channel_verified", { memberId: id, channel: "sms", phoneHash: hashPii(phone) });
    return { ok: true, value: { channels: (await store.list(id)).map(view) } };
  });
}

export async function removeMemberSms(actor: HouseholdActor, memberId: string, channelId: string): Promise<Outcome<ChannelList>> {
  return gated(actor, memberId, async (store, id) => {
    const before = (await store.list(id)).find((c) => c.id === channelId);
    if (!before || !(await store.remove(id, channelId))) return fail(404, "not_found", "That phone isn't connected.");
    await recordAudit(actor.tenantId, actor.userId, "member.channel_removed", { memberId: id, channel: "sms", phoneHash: hashPii(before.platformId), wasVerified: before.verified });
    return { ok: true, value: { channels: (await store.list(id)).map(view) } };
  });
}

// ─── Channel side ──────────────────────────────────────────────────

/**
 * Who verifiably owns this number, or null. The only path from a phone number to a household: verified
 * rows only (security-definer `lookup_member_channel` with a database, the memory twin otherwise). A
 * storage error is "unknown" (the sender gets the canned reply and the model is never reached).
 */
export async function resolveSmsCaller(from: string): Promise<ResolvedChannelMember | null> {
  const phone = normalizeE164(from);
  if (!phone) return null;
  try {
    const db = getDb();
    if (db) return (await lookupMemberChannel(db, "sms", phone)) ?? null;
    const row = memoryChannels().find((c) => c.verified && c.platformId === phone);
    if (!row) return null;
    const userId = memoryMemberRecords(row.tenantId).find((m) => m.id === row.memberId)?.userId ?? null;
    const role = userId ? memoryListMembers(row.tenantId).find((m) => m.userId === userId)?.role : undefined;
    return { tenantId: row.tenantId, memberId: row.memberId, userId, role: role === "owner" ? "owner" : "member" };
  } catch (err) {
    logger.error("SMS caller lookup failed", "member-channels", { userIdHash: hashPii(phone), errorMessage: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return null;
  }
}

/** Test seam: mark a memory channel verified without the code flow. */
export function seedMemoryVerifiedChannel(tenantId: string, memberId: string, platformId: string): void {
  memoryChannels().push({ id: crypto.randomUUID(), tenantId, memberId, channel: "sms", platformId, verified: true, verificationExpiresAt: null, createdAt: new Date(), codeHash: null, attempts: 0 });
}
