/**
 * Owner alerts (_specs/owner-alerts.md). Every query is tenant-scoped; the
 * retention purge runs across tenants through `purge_old_alerts()`.
 */
import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "./client.js";
import {
  alerts,
  memberships,
  users,
  type AlertEmailStatus,
  type AlertEmailThreshold,
  type AlertKind,
  type AlertSeverity,
  ALERT_EMAIL_THRESHOLDS,
} from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";
import { decodeVerdictCursor, encodeVerdictCursor } from "./verdicts.js";

export const ALERT_TITLE_MAX = 140;
export const ALERT_BODY_MAX = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AlertRow = typeof alerts.$inferSelect;

export interface AlertListItem extends AlertRow {
  subjectName: string | null;
  acknowledgedByName: string | null;
}

export interface CreateAlertInput {
  tenantId: string;
  subjectUserId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  dedupeKey: string;
  verdictId?: string | null;
  deviceId?: string | null;
  now?: Date;
}

export interface AlertOwner {
  userId: string;
  email: string | null;
  name: string | null;
  threshold: AlertEmailThreshold;
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

/** Insert an alert; null when an alert with the same dedupe key already exists in the household. */
export async function createAlert(db: Db, input: CreateAlertInput): Promise<AlertRow | null> {
  assertTenantId(input.tenantId);
  const rows = await tenantScoped(db, input.tenantId).transaction((t) =>
    t.tx
      .insert(alerts)
      .values({
        tenantId: input.tenantId,
        subjectUserId: input.subjectUserId,
        kind: input.kind,
        severity: input.severity,
        title: clip(input.title, ALERT_TITLE_MAX),
        body: clip(input.body, ALERT_BODY_MAX),
        dedupeKey: input.dedupeKey,
        verdictId: input.verdictId ?? null,
        deviceId: input.deviceId ?? null,
        ...(input.now ? { createdAt: input.now } : {}),
      })
      .onConflictDoNothing({ target: [alerts.tenantId, alerts.dedupeKey] })
      .returning(),
  );
  return rows[0] ?? null;
}

export async function getAlert(db: Db, tenantId: string, id: string): Promise<AlertRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tenantScoped(db, tenantId).first(alerts, eq(alerts.id, id));
}

// Microsecond-precision keyset cursor, as for verdicts.
const cursorTs = sql<string>`to_char(${alerts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Newest first. `subjectUserId` restricts to alerts about one member (members' view);
 * `status: "open"` to unacknowledged alerts. Throws InvalidCursorError on a bad cursor.
 */
export async function listAlerts(
  db: Db,
  tenantId: string,
  opts: { subjectUserId?: string; status?: "open" | "all"; cursor?: string; limit?: number } = {},
): Promise<{ items: AlertListItem[]; nextCursor?: string }> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20) || 20, 50));
  const conds: SQL[] = [eq(alerts.tenantId, tenantId)];
  if (opts.subjectUserId !== undefined) conds.push(eq(alerts.subjectUserId, opts.subjectUserId));
  if (opts.status === "open") conds.push(isNull(alerts.acknowledgedAt));
  if (opts.cursor) {
    const c = decodeVerdictCursor(opts.cursor);
    conds.push(sql`(${alerts.createdAt}, ${alerts.id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`);
  }
  const subject = alias(users, "subject");
  const acker = alias(users, "acker");
  const rows = await tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({ row: alerts, cursorTs, subjectName: subject.name, acknowledgedByName: acker.name })
      .from(alerts)
      .leftJoin(subject, eq(subject.id, alerts.subjectUserId))
      .leftJoin(acker, eq(acker.id, alerts.acknowledgedBy))
      .where(and(...conds))
      .orderBy(desc(alerts.createdAt), desc(alerts.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r.row, subjectName: r.subjectName, acknowledgedByName: r.acknowledgedByName })),
    ...(rows.length > limit && last ? { nextCursor: encodeVerdictCursor(last.cursorTs, last.row.id) } : {}),
  };
}

/** Unacknowledged alerts, optionally about one member and/or only the given severities. */
export async function countOpenAlerts(
  db: Db,
  tenantId: string,
  opts: { subjectUserId?: string; severities?: readonly AlertSeverity[] } = {},
): Promise<number> {
  const conds: SQL[] = [isNull(alerts.acknowledgedAt)];
  if (opts.subjectUserId !== undefined) conds.push(eq(alerts.subjectUserId, opts.subjectUserId));
  if (opts.severities?.length) conds.push(inArray(alerts.severity, [...opts.severities]));
  return tenantScoped(db, tenantId).count(alerts, and(...conds));
}

/** Acknowledge one alert. Idempotent: an already acknowledged alert is returned unchanged. */
export async function acknowledgeAlert(db: Db, tenantId: string, id: string, userId: string, now = new Date()): Promise<AlertRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const scoped = tenantScoped(db, tenantId);
  const [updated] = await scoped.update(alerts, { acknowledgedAt: now, acknowledgedBy: userId }, and(eq(alerts.id, id), isNull(alerts.acknowledgedAt)));
  return updated ?? scoped.first(alerts, eq(alerts.id, id));
}

export async function acknowledgeAllAlerts(db: Db, tenantId: string, userId: string, now = new Date()): Promise<number> {
  const rows = await tenantScoped(db, tenantId).update(alerts, { acknowledgedAt: now, acknowledgedBy: userId }, isNull(alerts.acknowledgedAt));
  return rows.length;
}

export async function markAlertEmail(db: Db, tenantId: string, id: string, status: AlertEmailStatus, at = new Date()): Promise<void> {
  await tenantScoped(db, tenantId).update(alerts, { emailStatus: status, emailedAt: status === "sent" ? at : null }, eq(alerts.id, id));
}

/** Alert emails sent by the household since `since` (the daily cap). */
export async function countAlertEmailsSince(db: Db, tenantId: string, since: Date): Promise<number> {
  return tenantScoped(db, tenantId).count(alerts, and(eq(alerts.emailStatus, "sent"), gte(alerts.emailedAt, since)));
}

/** The household's owners with their email and threshold. */
export async function listAlertOwners(db: Db, tenantId: string): Promise<AlertOwner[]> {
  return tenantScoped(db, tenantId).transaction((t) =>
    t.tx
      .select({ userId: memberships.userId, email: users.email, name: users.name, threshold: memberships.alertEmailThreshold })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner"))),
  );
}

export async function getAlertEmailThreshold(db: Db, tenantId: string, userId: string): Promise<AlertEmailThreshold | undefined> {
  const row = await tenantScoped(db, tenantId).first(memberships, eq(memberships.userId, userId));
  return row?.alertEmailThreshold;
}

/** Returns the stored value, or undefined when the user is not in the household. Throws on an unknown value. */
export async function setAlertEmailThreshold(
  db: Db,
  tenantId: string,
  userId: string,
  threshold: AlertEmailThreshold,
): Promise<AlertEmailThreshold | undefined> {
  if (!(ALERT_EMAIL_THRESHOLDS as readonly string[]).includes(threshold)) throw new Error("@neo/db: unknown alert email threshold");
  const [row] = await tenantScoped(db, tenantId).update(memberships, { alertEmailThreshold: threshold }, eq(memberships.userId, userId));
  return row?.alertEmailThreshold;
}

/** Retention: delete old alerts across tenants via `purge_old_alerts()`. */
export async function purgeOldAlerts(db: Db): Promise<number> {
  const res = await db.execute(sql`select purge_old_alerts() as n`);
  const [r] = (res as unknown as { rows: Array<{ n: number | string }> }).rows;
  return Number(r?.n ?? 0);
}

