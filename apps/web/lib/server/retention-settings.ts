/**
 * Owner settings for per-household data retention (_specs/v2-m4-hardening.md section 1). The tenant comes from the
 * session; both operations re-check the owner role server-side (`requireHouseholdAdmin`). Postgres via `@neo/db` when
 * DATABASE_URL is set, else an in-memory twin (MOCK_MODE). A household that never saved gets the defaults.
 */
import { DEFAULT_RETENTION, RETENTION_BOUNDS, RETENTION_KINDS, isValidRetentionDays, type RetentionKind, type RetentionSettings } from "@neo/core";
import { effectiveRetention, getRetentionSettings, setRetentionSettings } from "@neo/db";
import { recordAudit } from "./audit";
import { getDb } from "./db";
import { requireHouseholdAdmin, type HouseholdActor } from "./household-admin";
import type { Outcome } from "./household";

export interface RetentionResponse {
  /** Days per kind, defaults filled in. */
  settings: RetentionSettings;
  /** Allowed range and default per kind, for the form. */
  bounds: Record<RetentionKind, { min: number; max: number; default: number }>;
}

const g = globalThis as typeof globalThis & { __neoMemoryRetention?: Map<string, RetentionSettings> };

function memoryRetention(): Map<string, RetentionSettings> {
  g.__neoMemoryRetention ??= new Map();
  return g.__neoMemoryRetention;
}

/** A household's effective settings (defaults when it never saved). */
export async function effectiveRetentionFor(tenantId: string): Promise<RetentionSettings> {
  const db = getDb();
  if (!db) return memoryRetention().get(tenantId) ?? { ...DEFAULT_RETENTION };
  const stored = await getRetentionSettings(db, tenantId);
  return effectiveRetention(stored ?? {});
}

async function respond(tenantId: string): Promise<RetentionResponse> {
  return { settings: await effectiveRetentionFor(tenantId), bounds: RETENTION_BOUNDS };
}

/** The effective settings and bounds. Owner only. */
export async function getRetention(actor: HouseholdActor): Promise<Outcome<RetentionResponse>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  return { ok: true, value: await respond(actor.tenantId) };
}

/**
 * Save all four values. Owner only. 400 `invalid` with `fields` for a missing, unknown or out-of-range value (nothing
 * is clamped silently: the form shows the bounds). Audits `household.retention_changed` `{ from, to }` when something changed.
 */
export async function putRetention(actor: HouseholdActor, body: Record<string, unknown> | null): Promise<Outcome<RetentionResponse>> {
  const admin = await requireHouseholdAdmin(actor);
  if (!admin.ok) return admin;
  const input = body ?? {};
  const fields: { path: string; message: string }[] = [];
  for (const key of Object.keys(input)) {
    if (!(RETENTION_KINDS as readonly string[]).includes(key)) fields.push({ path: key, message: "Unknown setting." });
  }
  for (const kind of RETENTION_KINDS) {
    if (!isValidRetentionDays(kind, input[kind])) {
      const b = RETENTION_BOUNDS[kind];
      fields.push({ path: kind, message: `Choose a whole number of days from ${b.min} to ${b.max}.` });
    }
  }
  if (fields.length > 0) return { ok: false, status: 400, code: "invalid", message: "Check the details and try again.", fields };
  const to = Object.fromEntries(RETENTION_KINDS.map((k) => [k, input[k] as number])) as RetentionSettings;
  const from = await effectiveRetentionFor(actor.tenantId);
  if (RETENTION_KINDS.some((k) => from[k] !== to[k])) {
    const db = getDb();
    if (db) await setRetentionSettings(db, actor.tenantId, to);
    else memoryRetention().set(actor.tenantId, to);
    await recordAudit(actor.tenantId, actor.userId, "household.retention_changed", { from, to });
  }
  return { ok: true, value: await respond(actor.tenantId) };
}
