/**
 * Tenant-scoped audit events (`audit_events`). Metadata must never contain raw
 * PII or tokens: hash identifiers with `hashPii` first.
 *
 * With no database the event goes to the in-memory log below (MOCK_MODE and
 * tests), which tests can inspect.
 */
import { auditEvents, tenantScoped } from "@neo/db";
import { logger } from "@neo/core";
import { getDb } from "./db";

export type AuditEventType = "auth.sign_in" | "auth.sign_out" | "usage.cap_hit" | "verdict.created";

export interface MemoryAuditEvent {
  tenantId: string;
  userId: string | null;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const g = globalThis as typeof globalThis & { __neoMemoryAudit?: MemoryAuditEvent[] };

/** No-database fallback audit log (bounded). */
export function memoryAuditLog(): MemoryAuditEvent[] {
  g.__neoMemoryAudit ??= [];
  return g.__neoMemoryAudit;
}

/** Write an audit event. Never throws: audit failure must not break the user's request. */
export async function recordAudit(
  tenantId: string,
  userId: string | null,
  eventType: AuditEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = getDb();
    if (!db) {
      const log = memoryAuditLog();
      log.push({ tenantId, userId, eventType, metadata, createdAt: new Date() });
      if (log.length > 1000) log.splice(0, log.length - 1000);
      return;
    }
    await tenantScoped(db, tenantId).insert(auditEvents, { userId, eventType, metadata });
  } catch (err) {
    logger.error("Audit event write failed", "audit", {
      eventType,
      errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }
}
