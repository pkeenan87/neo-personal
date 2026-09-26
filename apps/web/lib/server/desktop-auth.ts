/**
 * Device authorization service used by /api/desktop/device* and the
 * /desktop/authorize page. Database when configured, else the in-memory
 * store (MOCK_MODE, tests). Limits live here so the routes stay thin.
 */
import {
  createDesktopAuthRequest,
  decideDesktopAuthRequest,
  getDesktopAuthRequest,
  redeemDesktopAuthRequest,
  type DesktopAuthApprover,
  type DesktopAuthDecision,
  type DesktopAuthRedemption,
  type DesktopAuthRequestPublic,
} from "@neo/db";
import type { NeoSession } from "@/lib/session";
import { getDb } from "./db";
import {
  memoryCreateDesktopAuthRequest,
  memoryDecideDesktopAuthRequest,
  memoryGetDesktopAuthRequest,
  memoryRedeemDesktopAuthRequest,
} from "./memory-desktop-auth";

export type { DesktopAuthRedemption, DesktopAuthRequestPublic };

/** Per client IP, per instance. Starting a request is cheap but creates a row. */
export const DEVICE_START_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;
/** Redemption polls: the client polls every 5 s, so 60/min leaves room for retries. */
export const DEVICE_REDEEM_LIMIT = { limit: 60, windowMs: 60 * 1000 } as const;
/** Approvals per user: user codes are short, so guessing must stay slow. */
export const DEVICE_DECIDE_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 } as const;

export const DEFAULT_CLIENT_NAME = "Desktop client";

export async function startDeviceAuth(clientName: string): Promise<{ id: string; userCode: string; deviceCode: string; expiresAt: Date } | { error: "bad_name" }> {
  const db = getDb();
  if (!db) return memoryCreateDesktopAuthRequest({ clientName });
  return createDesktopAuthRequest(db, { clientName });
}

export async function lookupDeviceAuth(userCode: string): Promise<DesktopAuthRequestPublic | null> {
  const db = getDb();
  if (!db) return memoryGetDesktopAuthRequest(userCode);
  return getDesktopAuthRequest(db, userCode);
}

export function approverFromSession(session: NeoSession): DesktopAuthApprover {
  return { userId: session.userId, tenantId: session.tenantId, role: session.role, email: session.email, name: session.name };
}

export async function decideDeviceAuth(
  session: NeoSession,
  userCode: string,
  approve: boolean,
): Promise<{ decision: DesktopAuthDecision; clientName?: string }> {
  const approver = approverFromSession(session);
  const db = getDb();
  if (!db) return memoryDecideDesktopAuthRequest({ userCode, approve, approver });
  return decideDesktopAuthRequest(db, { userCode, approve, approver });
}

export async function redeemDeviceAuth(deviceCode: string): Promise<DesktopAuthRedemption> {
  const db = getDb();
  if (!db) return memoryRedeemDesktopAuthRequest(deviceCode);
  return redeemDesktopAuthRequest(db, deviceCode);
}
