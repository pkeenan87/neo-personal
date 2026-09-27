/**
 * In-memory desktop tokens when DATABASE_URL is unset (local MOCK_MODE demos).
 * Process-local only — same lifetime as the in-memory conversation store.
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
} from "@neo/db";

type MemRow = DesktopTokenPublic & {
  userId: string;
  tenantId: string;
  role: MembershipRole;
  tokenHash: string;
  revokedAt: Date | null;
};

const g = globalThis as typeof globalThis & { __neoDesktopTokens?: Map<string, MemRow> };

function store(): Map<string, MemRow> {
  if (!g.__neoDesktopTokens) g.__neoDesktopTokens = new Map();
  return g.__neoDesktopTokens;
}

export function memoryListDesktopTokens(userId: string): DesktopTokenPublic[] {
  return [...store().values()]
    .filter((r) => r.userId === userId && !r.revokedAt)
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

  const secret = randomBytes(32).toString("base64url");
  const token = `${DESKTOP_TOKEN_PREFIX}${secret}`;
  const id = crypto.randomUUID();
  const record: DesktopTokenPublic = {
    id,
    name,
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
  });
  return { token, record };
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
    row.lastUsedAt = new Date();
    return { id: row.id, userId: row.userId, tenantId: row.tenantId, role: row.role };
  }
  return null;
}
