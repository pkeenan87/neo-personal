/**
 * Device authorization for desktop clients (see schema/desktop-auth.ts).
 *
 *   create  → { deviceCode, userCode }        unauthenticated client
 *   decide  → approve / deny by user code     signed-in browser
 *   redeem  → desktop token, once             client polling with the device code
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { createDesktopToken, type DesktopTokenPublic } from "./desktop-tokens.js";
import { desktopAuthRequests, type DesktopAuthStatus } from "./schema/desktop-auth.js";
import type { MembershipRole } from "./schema/tenants.js";

export const DESKTOP_AUTH_TTL_MS = 10 * 60 * 1000;
/** Seconds a client should wait between redemption attempts. */
export const DESKTOP_AUTH_POLL_INTERVAL_S = 5;
export const DEVICE_CODE_PREFIX = "neo_dc_";
export const MAX_DESKTOP_CLIENT_NAME = 64;

/** No vowels or look-alikes (0/O, 1/I/L, 5/S, U/V) so codes can be read out and typed. */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTWXYZ2346789";
const USER_CODE_LENGTH = 8;

export interface DesktopAuthRequestPublic {
  id: string;
  clientName: string;
  status: DesktopAuthStatus;
  expiresAt: Date;
}

export interface DesktopAuthApprover {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  email: string;
  name: string;
}

export type DesktopAuthDecision = "approved" | "denied" | "not_found" | "already_decided";

export type DesktopAuthRedemption =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "not_found" }
  | { status: "token_limit" }
  | { status: "approved"; token: string; record: DesktopTokenPublic; email: string; name: string; clientName: string };

export function generateUserCode(): string {
  let raw = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Uppercase, drop separators and whitespace, re-insert the dash; null when it cannot be a user code. */
export function normalizeUserCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== USER_CODE_LENGTH) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function mintDeviceCode(): string {
  return `${DEVICE_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isDeviceCodeFormat(code: string): boolean {
  return /^neo_dc_[A-Za-z0-9_-]{40,50}$/.test(code);
}

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Trim, collapse whitespace, strip control characters, cap the length; null when empty. */
export function normalizeClientName(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_DESKTOP_CLIENT_NAME);
}

function toPublic(r: { id: string; clientName: string; status: DesktopAuthStatus; expiresAt: Date }): DesktopAuthRequestPublic {
  return { id: r.id, clientName: r.clientName, status: r.status, expiresAt: r.expiresAt };
}

async function purgeExpired(db: Db, now: Date): Promise<void> {
  await db.delete(desktopAuthRequests).where(lt(desktopAuthRequests.expiresAt, now));
}

export async function createDesktopAuthRequest(
  db: Db,
  input: { clientName: string; now?: Date },
): Promise<{ id: string; userCode: string; deviceCode: string; expiresAt: Date } | { error: "bad_name" }> {
  const clientName = normalizeClientName(input.clientName);
  if (!clientName) return { error: "bad_name" };
  const now = input.now ?? new Date();
  await purgeExpired(db, now);
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_TTL_MS);
  // User codes are short; retry on the rare collision with a live request.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    const deviceCode = mintDeviceCode();
    const rows = await db
      .insert(desktopAuthRequests)
      .values({ userCode, deviceCodeHash: hashDeviceCode(deviceCode), clientName, expiresAt })
      .onConflictDoNothing({ target: desktopAuthRequests.userCode })
      .returning({ id: desktopAuthRequests.id });
    const row = rows[0];
    if (row) return { id: row.id, userCode, deviceCode, expiresAt };
  }
  throw new Error("could not allocate a unique desktop auth user code");
}

/** The request behind a user code, for the approval page; null when unknown or expired. */
export async function getDesktopAuthRequest(db: Db, userCode: string, now = new Date()): Promise<DesktopAuthRequestPublic | null> {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const [row] = await db.select().from(desktopAuthRequests).where(eq(desktopAuthRequests.userCode, code)).limit(1);
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  return toPublic(row);
}

/** Approve or deny a pending request as the signed-in user. Only a pending, unexpired row can be decided. */
export async function decideDesktopAuthRequest(
  db: Db,
  input: { userCode: string; approve: boolean; approver: DesktopAuthApprover; now?: Date },
): Promise<{ decision: DesktopAuthDecision; clientName?: string }> {
  const now = input.now ?? new Date();
  const code = normalizeUserCode(input.userCode);
  if (!code) return { decision: "not_found" };
  const [row] = await db.select().from(desktopAuthRequests).where(eq(desktopAuthRequests.userCode, code)).limit(1);
  if (!row || row.expiresAt.getTime() <= now.getTime()) return { decision: "not_found" };
  if (row.status !== "pending") return { decision: "already_decided", clientName: row.clientName };
  const status: DesktopAuthStatus = input.approve ? "approved" : "denied";
  const updated = await db
    .update(desktopAuthRequests)
    .set({
      status,
      decidedAt: now,
      ...(input.approve
        ? {
            userId: input.approver.userId,
            tenantId: input.approver.tenantId,
            role: input.approver.role,
            userEmail: input.approver.email,
            userName: input.approver.name,
          }
        : {}),
    })
    .where(and(eq(desktopAuthRequests.id, row.id), eq(desktopAuthRequests.status, "pending")))
    .returning({ id: desktopAuthRequests.id });
  if (updated.length === 0) return { decision: "already_decided", clientName: row.clientName };
  return { decision: status, clientName: row.clientName };
}

/**
 * Redeem a device code. An approved request mints the desktop token (named after
 * the client) and the row is deleted, so the token is delivered exactly once.
 * Denied and expired rows are also deleted on first report.
 */
export async function redeemDesktopAuthRequest(db: Db, deviceCode: string, now = new Date()): Promise<DesktopAuthRedemption> {
  if (!isDeviceCodeFormat(deviceCode)) return { status: "not_found" };
  const hash = hashDeviceCode(deviceCode);
  const [row] = await db.select().from(desktopAuthRequests).where(eq(desktopAuthRequests.deviceCodeHash, hash)).limit(1);
  if (!row) return { status: "not_found" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(desktopAuthRequests).where(eq(desktopAuthRequests.id, row.id));
    return { status: "expired" };
  }
  if (row.status === "pending") return { status: "pending" };
  if (row.status === "denied" || !row.userId || !row.tenantId || !row.role) {
    await db.delete(desktopAuthRequests).where(eq(desktopAuthRequests.id, row.id));
    return { status: "denied" };
  }
  // Claim the row first so two concurrent polls cannot both mint a token.
  const claimed = await db.delete(desktopAuthRequests).where(eq(desktopAuthRequests.id, row.id)).returning({ id: desktopAuthRequests.id });
  if (claimed.length === 0) return { status: "not_found" };
  const minted = await createDesktopToken(db, { userId: row.userId, tenantId: row.tenantId, role: row.role, name: row.clientName });
  if ("error" in minted) return { status: "token_limit" };
  return {
    status: "approved",
    token: minted.token,
    record: minted.record,
    email: row.userEmail ?? "",
    name: row.userName ?? "",
    clientName: row.clientName,
  };
}
