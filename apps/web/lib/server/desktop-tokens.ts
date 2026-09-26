/**
 * Desktop token settings helpers used by /api/settings/desktop-tokens and
 * Bearer auth in lib/session.ts.
 */
import {
  createDesktopToken,
  listDesktopTokens,
  resolveDesktopToken,
  revokeDesktopToken,
  type DesktopTokenPublic,
  type ResolvedDesktopToken,
} from "@neo/db";
import type { NeoSession } from "@/lib/session";
import { getDb } from "./db";
import {
  memoryCreateDesktopToken,
  memoryListDesktopTokens,
  memoryResolveDesktopToken,
  memoryRevokeDesktopToken,
} from "./memory-desktop-tokens";

export type { DesktopTokenPublic };

export async function listTokensForSession(session: NeoSession): Promise<DesktopTokenPublic[]> {
  const db = getDb();
  if (!db) return memoryListDesktopTokens(session.userId);
  return listDesktopTokens(db, session.userId);
}

export async function createTokenForSession(
  session: NeoSession,
  name: string,
): Promise<{ token: string; record: DesktopTokenPublic } | { error: "limit" | "bad_name" }> {
  const db = getDb();
  if (!db) {
    return memoryCreateDesktopToken({
      userId: session.userId,
      tenantId: session.tenantId,
      role: session.role,
      name,
    });
  }
  return createDesktopToken(db, {
    userId: session.userId,
    tenantId: session.tenantId,
    role: session.role,
    name,
  });
}

export async function revokeTokenForSession(session: NeoSession, tokenId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return memoryRevokeDesktopToken(session.userId, tokenId);
  return revokeDesktopToken(db, session.userId, tokenId);
}

export async function resolveBearerDesktopToken(token: string): Promise<ResolvedDesktopToken | null> {
  const db = getDb();
  if (!db) return memoryResolveDesktopToken(token);
  return resolveDesktopToken(db, token);
}
