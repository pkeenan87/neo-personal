import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { inboundAddresses, inboundMessages, type InboundStatus } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

export type { InboundStatus };
export type InboundMessageRow = typeof inboundMessages.$inferSelect;
export type InboundAddress = { id: string; localPart: string; address: string | null };

/** Crockford base32 alphabet, lowercase (no i, l, o, u). */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const LOCAL_PART_RE = /^check-[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "check-" + 12 lowercase Crockford base32 chars (60 bits) from `crypto.randomBytes`. */
export function generateLocalPart(): string {
  // 32 divides 256, so `byte & 31` is unbiased.
  const bytes = randomBytes(12);
  let out = "check-";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** Whether `s` has the shape of a Neo inbound local part (after lowercasing). */
export function isInboundLocalPart(s: string): boolean {
  return LOCAL_PART_RE.test(s.trim().toLowerCase());
}

/** `<localPart>@<NEO_INBOUND_DOMAIN>`, or null when the domain is unset. */
export function inboundAddressFor(localPart: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = env.NEO_INBOUND_DOMAIN?.trim().toLowerCase();
  return domain ? `${localPart}@${domain}` : null;
}

const MAX_INSERT_ATTEMPTS = 5;

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function activeAddress(db: Db, tenantId: string) {
  return tenantScoped(db, tenantId).first(inboundAddresses, eq(inboundAddresses.active, true));
}

function toAddress(r: { id: string; localPart: string }): InboundAddress {
  return { id: r.id, localPart: r.localPart, address: inboundAddressFor(r.localPart) };
}

/** The tenant's active address, created on first call. Safe under concurrent calls. */
async function ensureAddress(db: Db, tenantId: string): Promise<InboundAddress> {
  const existing = await activeAddress(db, tenantId);
  if (existing) return toAddress(existing);
  for (let i = 0; i < MAX_INSERT_ATTEMPTS; i++) {
    try {
      const [r] = await tenantScoped(db, tenantId).insert(inboundAddresses, { localPart: generateLocalPart() });
      if (r) return toAddress(r);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Either a concurrent ensureAddress won (one active per tenant) or a local-part collision.
      const winner = await activeAddress(db, tenantId);
      if (winner) return toAddress(winner);
    }
  }
  throw new Error("@neo/db: could not allocate an inbound address");
}

/** Deactivate the current address (it stops resolving immediately) and issue a new one. */
async function rotateAddress(db: Db, tenantId: string): Promise<InboundAddress> {
  for (let i = 0; i < MAX_INSERT_ATTEMPTS; i++) {
    try {
      const r = await tenantScoped(db, tenantId).transaction(async (t) => {
        await t.update(inboundAddresses, { active: false, rotatedAt: sql`now()` }, eq(inboundAddresses.active, true));
        const [created] = await t.insert(inboundAddresses, { localPart: generateLocalPart() });
        return created;
      });
      if (r) return toAddress(r);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("@neo/db: could not rotate the inbound address");
}

/**
 * Resolve an active address by local part before the tenant is known (webhook). Runs the
 * security-definer function `resolve_inbound_address`, so it works under the app role.
 * Input that is not shaped like a Neo local part returns undefined without a query.
 */
async function findActiveByLocalPart(db: Db, localPart: string): Promise<{ id: string; tenantId: string } | undefined> {
  const lp = localPart.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(lp)) return undefined;
  const res = await db.execute(sql`select id, tenant_id from resolve_inbound_address(${lp})`);
  const [r] = (res as unknown as { rows: Array<{ id: string; tenant_id: string }> }).rows;
  return r ? { id: r.id, tenantId: r.tenant_id } : undefined;
}

export type RecordMessageInput = {
  tenantId: string;
  addressId: string;
  providerMessageId: string;
  fromAddressHash: string;
  status: InboundStatus;
  error?: string | null;
};

/**
 * Insert a delivery row and bump the address's `last_used_at`. Idempotent on
 * `providerMessageId`: a duplicate returns the existing row's id with `duplicate: true`.
 */
async function recordMessage(db: Db, input: RecordMessageInput): Promise<{ id: string; duplicate: boolean }> {
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const [created] = await t.tx
      .insert(inboundMessages)
      .values({
        tenantId: input.tenantId,
        addressId: input.addressId,
        providerMessageId: input.providerMessageId,
        fromAddressHash: input.fromAddressHash,
        status: input.status,
        error: input.error ?? null,
      })
      .onConflictDoNothing({ target: inboundMessages.providerMessageId })
      .returning({ id: inboundMessages.id });
    if (created) {
      await t.update(inboundAddresses, { lastUsedAt: sql`now()` }, eq(inboundAddresses.id, input.addressId));
      return { id: created.id, duplicate: false };
    }
    const existing = await t.first(inboundMessages, eq(inboundMessages.providerMessageId, input.providerMessageId));
    if (!existing) throw new Error("@neo/db: provider message id already recorded for another tenant");
    return { id: existing.id, duplicate: true };
  });
}

export type InboundMessagePatch = Partial<{
  status: InboundStatus;
  forwarderUserId: string | null;
  artifactId: string | null;
  verdictId: string | null;
  error: string | null;
  completedAt: Date | null;
}>;

async function updateMessage(db: Db, id: string, tenantId: string, patch: InboundMessagePatch): Promise<void> {
  if (!UUID_RE.test(id)) return;
  const set: InboundMessagePatch = {};
  for (const k of ["status", "forwarderUserId", "artifactId", "verdictId", "error", "completedAt"] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  if (Object.keys(set).length === 0) return;
  await tenantScoped(db, tenantId).update(inboundMessages, set, eq(inboundMessages.id, id));
}

async function getMessage(db: Db, id: string, tenantId: string): Promise<InboundMessageRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).first(inboundMessages, eq(inboundMessages.id, id));
}

/** Deliveries to `addressId` in the last `windowMs` (rate limit). Tenant-scoped. */
async function countRecent(db: Db, tenantId: string, addressId: string, windowMs: number): Promise<number> {
  if (!UUID_RE.test(addressId)) return 0;
  const since = new Date(Date.now() - Math.max(0, windowMs));
  return tenantScoped(db, tenantId).count(
    inboundMessages,
    and(eq(inboundMessages.addressId, addressId), gte(inboundMessages.receivedAt, since)),
  );
}

async function listRecent(db: Db, tenantId: string, limit = 20): Promise<InboundMessageRow[]> {
  const n = Math.max(1, Math.min(Math.floor(limit) || 20, 100));
  return tenantScoped(db, tenantId).select(inboundMessages, undefined, {
    orderBy: [desc(inboundMessages.receivedAt), desc(inboundMessages.id)],
    limit: n,
  });
}

/** The delivery that produced `verdictId` (dashboard "forwarded by"), if any. Tenant-scoped. */
async function findByVerdictId(db: Db, tenantId: string, verdictId: string): Promise<InboundMessageRow | undefined> {
  if (!UUID_RE.test(verdictId)) return undefined;
  return tenantScoped(db, tenantId).first(inboundMessages, eq(inboundMessages.verdictId, verdictId));
}

/**
 * Retention: delete `rejected` / `failed` deliveries older than `olderThanDays` (≥ 1, default
 * 90) across all tenants, returning the count. Runs the security-definer function
 * `purge_old_inbound_messages`, so it works under the app role.
 */
async function purgeOld(db: Db, olderThanDays = 90): Promise<number> {
  const days = Math.max(1, Math.floor(olderThanDays) || 90);
  const res = await db.execute(sql`select purge_old_inbound_messages(${days}) as n`);
  const [r] = (res as unknown as { rows: Array<{ n: number | string }> }).rows;
  return Number(r?.n ?? 0);
}

/** Forward-to-address persistence (see _specs/forward-to-address.md). */
export const inbound = {
  ensureAddress,
  rotateAddress,
  findActiveByLocalPart,
  recordMessage,
  updateMessage,
  getMessage,
  countRecent,
  listRecent,
  findByVerdictId,
  purgeOld,
};
