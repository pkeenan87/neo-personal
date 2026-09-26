/**
 * In-memory device authorization when DATABASE_URL is unset (MOCK_MODE, tests).
 * Mirrors @neo/db desktop-auth.ts; process-local like the other memory stores.
 */
import {
  DESKTOP_AUTH_TTL_MS,
  generateUserCode,
  hashDeviceCode,
  isDeviceCodeFormat,
  mintDeviceCode,
  normalizeClientName,
  normalizeUserCode,
  type DesktopAuthApprover,
  type DesktopAuthDecision,
  type DesktopAuthRedemption,
  type DesktopAuthRequestPublic,
  type DesktopAuthStatus,
} from "@neo/db";
import { memoryCreateDesktopToken } from "./memory-desktop-tokens";

interface MemRequest extends DesktopAuthRequestPublic {
  deviceCodeHash: string;
  approver: DesktopAuthApprover | null;
}

const g = globalThis as typeof globalThis & { __neoDesktopAuthRequests?: Map<string, MemRequest> };

function store(): Map<string, MemRequest> {
  g.__neoDesktopAuthRequests ??= new Map();
  return g.__neoDesktopAuthRequests;
}

export function resetMemoryDesktopAuth(): void {
  g.__neoDesktopAuthRequests = undefined;
}

function purgeExpired(now: Date): void {
  for (const [id, r] of store()) if (r.expiresAt.getTime() <= now.getTime()) store().delete(id);
}

function byUserCode(code: string): MemRequest | undefined {
  const normalized = normalizeUserCode(code);
  return normalized ? store().get(normalized) : undefined;
}

export function memoryCreateDesktopAuthRequest(input: {
  clientName: string;
  now?: Date;
}): { id: string; userCode: string; deviceCode: string; expiresAt: Date } | { error: "bad_name" } {
  const clientName = normalizeClientName(input.clientName);
  if (!clientName) return { error: "bad_name" };
  const now = input.now ?? new Date();
  purgeExpired(now);
  let userCode = generateUserCode();
  while (store().has(userCode)) userCode = generateUserCode();
  const deviceCode = mintDeviceCode();
  const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_TTL_MS);
  // The user code doubles as the map key (rows are keyed by it in memory).
  store().set(userCode, { id: userCode, clientName, status: "pending", expiresAt, deviceCodeHash: hashDeviceCode(deviceCode), approver: null });
  return { id: userCode, userCode, deviceCode, expiresAt };
}

export function memoryGetDesktopAuthRequest(userCode: string, now = new Date()): DesktopAuthRequestPublic | null {
  const r = byUserCode(userCode);
  if (!r || r.expiresAt.getTime() <= now.getTime()) return null;
  return { id: r.id, clientName: r.clientName, status: r.status, expiresAt: r.expiresAt };
}

export function memoryDecideDesktopAuthRequest(input: {
  userCode: string;
  approve: boolean;
  approver: DesktopAuthApprover;
  now?: Date;
}): { decision: DesktopAuthDecision; clientName?: string } {
  const now = input.now ?? new Date();
  const r = byUserCode(input.userCode);
  if (!r || r.expiresAt.getTime() <= now.getTime()) return { decision: "not_found" };
  if (r.status !== "pending") return { decision: "already_decided", clientName: r.clientName };
  const status: DesktopAuthStatus = input.approve ? "approved" : "denied";
  r.status = status;
  r.approver = input.approve ? input.approver : null;
  return { decision: status, clientName: r.clientName };
}

export function memoryRedeemDesktopAuthRequest(deviceCode: string, now = new Date()): DesktopAuthRedemption {
  if (!isDeviceCodeFormat(deviceCode)) return { status: "not_found" };
  const hash = hashDeviceCode(deviceCode);
  let row: MemRequest | undefined;
  for (const r of store().values()) if (r.deviceCodeHash === hash) row = r;
  if (!row) return { status: "not_found" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    store().delete(row.id);
    return { status: "expired" };
  }
  if (row.status === "pending") return { status: "pending" };
  store().delete(row.id);
  if (row.status === "denied" || !row.approver) return { status: "denied" };
  const minted = memoryCreateDesktopToken({
    userId: row.approver.userId,
    tenantId: row.approver.tenantId,
    role: row.approver.role,
    name: row.clientName,
  });
  if ("error" in minted) return { status: "token_limit" };
  return {
    status: "approved",
    token: minted.token,
    record: minted.record,
    email: row.approver.email,
    name: row.approver.name,
    clientName: row.clientName,
  };
}
