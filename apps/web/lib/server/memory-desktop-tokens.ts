/**
 * In-memory desktop tokens when DATABASE_URL is unset (local MOCK_MODE demos).
 * Process-local only — same lifetime as the in-memory conversation store.
 *
 * Mirrors @neo/db desktop-tokens.ts: `full` tokens are listed and capped;
 * monitoring tokens (memory-devices.ts) belong to a device and hold
 * MONITORING_SCOPES, and stop resolving once their device is revoked.
 */
import { randomBytes } from "node:crypto";
import {
  DESKTOP_TOKEN_PREFIX,
  MAX_DESKTOP_TOKENS_PER_USER,
  hashDesktopToken,
  isDesktopTokenFormat,
  normalizeDesktopTokenName,
  type DesktopTokenPublic,
  type MembershipRole,
  type ResolvedDesktopToken,
  type TokenScope,
} from "@neo/db";
// Circular with memory-devices.ts (which mints tokens here); only used at call time.
import { memoryDeviceIsActive } from "./memory-devices";

type MemRow = DesktopTokenPublic & {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  tokenHash: string;
  revokedAt: Date | null;
  scopes: TokenScope[];
  deviceId: string | null;
};

const g = globalThis as typeof globalThis & { __neoDesktopTokens?: Map<string, MemRow> };

function store(): Map<string, MemRow> {
  if (!g.__neoDesktopTokens) g.__neoDesktopTokens = new Map();
  return g.__neoDesktopTokens;
}

export function memoryListDesktopTokens(userId: string): DesktopTokenPublic[] {
  return [...store().values()]
    .filter((r) => r.userId === userId && !r.revokedAt && r.scopes.includes("full"))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(({ id, name, tokenPrefix, createdAt, lastUsedAt }) => ({ id, name, tokenPrefix, createdAt, lastUsedAt }));
}

export function memoryCreateDesktopToken(input: {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  name: string;
}): { token: string; record: DesktopTokenPublic } | { error: "limit" | "bad_name" } {
  const name = normalizeDesktopTokenName(input.name);
  if (!name) return { error: "bad_name" };
  if (memoryListDesktopTokens(input.userId).length >= MAX_DESKTOP_TOKENS_PER_USER) return { error: "limit" };

  return mint({ ...input, name, scopes: ["full"], deviceId: null });
}

function mint(input: {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  name: string;
  scopes: TokenScope[];
  deviceId: string | null;
}): { token: string; record: DesktopTokenPublic } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${DESKTOP_TOKEN_PREFIX}${secret}`;
  const id = crypto.randomUUID();
  const record: DesktopTokenPublic = {
    id,
    name: input.name,
    tokenPrefix: secret.slice(0, 8),
    createdAt: new Date(),
    lastUsedAt: null,
  };
  store().set(id, {
    ...record,
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    tokenHash: hashDesktopToken(token),
    revokedAt: null,
    scopes: input.scopes,
    deviceId: input.deviceId,
  });
  return { token, record };
}

/** A monitoring token for a device (like @neo/db insertDeviceToken): not listed, not capped. */
export function memoryInsertDeviceToken(input: {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  name: string;
  deviceId: string;
  scopes: readonly TokenScope[];
}): { token: string; record: DesktopTokenPublic } {
  if (input.scopes.includes("full")) throw new Error("a device token cannot hold the full scope");
  return mint({ ...input, name: normalizeDesktopTokenName(input.name) ?? "Device", scopes: [...input.scopes] });
}

/** Revoke every token of a device (memory-devices.ts revokeDevice). */
export function memoryRevokeDeviceTokens(tenantId: string, deviceId: string, now = new Date()): void {
  for (const row of store().values()) {
    if (row.tenantId === tenantId && row.deviceId === deviceId && !row.revokedAt) row.revokedAt = now;
  }
}

export function memoryRevokeDesktopToken(userId: string, tokenId: string): boolean {
  const row = store().get(tokenId);
  if (!row || row.userId !== userId || row.revokedAt) return false;
  row.revokedAt = new Date();
  return true;
}

export function memoryResolveDesktopToken(token: string): ResolvedDesktopToken | null {
  if (!isDesktopTokenFormat(token)) return null;
  const hash = hashDesktopToken(token);
  for (const row of store().values()) {
    if (row.tokenHash !== hash || row.revokedAt) continue;
    if (row.deviceId && !memoryDeviceIsActive(row.tenantId, row.deviceId)) return null;
    row.lastUsedAt = new Date();
    return { id: row.id, userId: row.userId, tenantId: row.tenantId, role: row.role, scopes: [...row.scopes], deviceId: row.deviceId };
  }
  return null;
}
