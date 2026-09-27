/**
 * Desktop personal access tokens for shell / native clients.
 *
 * Token format: `neo_dt_` + 43-char base64url (32 random bytes). Only the
 * SHA-256 hex hash is stored. Resolve by hash before a tenant context exists
 * (same pattern as Auth.js sessions — this table has no RLS).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { desktopTokens } from "./schema/desktop-tokens.js";
import type { MembershipRole } from "./schema/tenants.js";

export const DESKTOP_TOKEN_PREFIX = "neo_dt_";
export const MAX_DESKTOP_TOKEN_NAME = 64;
export const MAX_DESKTOP_TOKENS_PER_USER = 10;

export type DesktopTokenRow = typeof desktopTokens.$inferSelect;

export interface DesktopTokenPublic {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface ResolvedDesktopToken {
  id: string;
  userId: string;
  tenantId: string;
  role: MembershipRole;
}

export function hashDesktopToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isDesktopTokenFormat(token: string): boolean {
  return /^neo_dt_[A-Za-z0-9_-]{40,50}$/.test(token);
}

function mintToken(): { token: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${DESKTOP_TOKEN_PREFIX}${secret}`;
  return { token, hash: hashDesktopToken(token), prefix: secret.slice(0, 8) };
}

export function normalizeDesktopTokenName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_DESKTOP_TOKEN_NAME) return null;
  return trimmed;
}

export async function listDesktopTokens(db: Db, userId: string): Promise<DesktopTokenPublic[]> {
  const rows = await db
    .select()
    .from(desktopTokens)
    .where(and(eq(desktopTokens.userId, userId), isNull(desktopTokens.revokedAt)))
    .orderBy(desc(desktopTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

export async function createDesktopToken(
  db: Db,
  input: { userId: string; tenantId: string; role: MembershipRole; name: string },
): Promise<{ token: string; record: DesktopTokenPublic } | { error: "limit" | "bad_name" }> {
  const name = normalizeDesktopTokenName(input.name);
  if (!name) return { error: "bad_name" };

  const active = await listDesktopTokens(db, input.userId);
  if (active.length >= MAX_DESKTOP_TOKENS_PER_USER) return { error: "limit" };

  const { token, hash, prefix } = mintToken();
  const [row] = await db
    .insert(desktopTokens)
    .values({
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role,
      name,
      tokenHash: hash,
      tokenPrefix: prefix,
    })
    .returning();
  if (!row) throw new Error("desktop token insert returned no row");
  return {
    token,
    record: {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    },
  };
}

export async function revokeDesktopToken(db: Db, userId: string, tokenId: string): Promise<boolean> {
  const updated = await db
    .update(desktopTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(desktopTokens.id, tokenId), eq(desktopTokens.userId, userId), isNull(desktopTokens.revokedAt)))
    .returning({ id: desktopTokens.id });
  return updated.length > 0;
}

export async function resolveDesktopToken(db: Db, token: string): Promise<ResolvedDesktopToken | null> {
  if (!isDesktopTokenFormat(token)) return null;
  const hash = hashDesktopToken(token);
  const [row] = await db
    .select({
      id: desktopTokens.id,
      userId: desktopTokens.userId,
      tenantId: desktopTokens.tenantId,
      role: desktopTokens.role,
      revokedAt: desktopTokens.revokedAt,
    })
    .from(desktopTokens)
    .where(eq(desktopTokens.tokenHash, hash))
    .limit(1);
  if (!row || row.revokedAt) return null;
  // Fire-and-forget last-used bump; auth must not wait on the write.
  void db
    .update(desktopTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(desktopTokens.id, row.id))
    .catch(() => undefined);
  return { id: row.id, userId: row.userId, tenantId: row.tenantId, role: row.role };
}
