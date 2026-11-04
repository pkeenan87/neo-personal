/**
 * Notification outbox (_specs/v2-m1-elder.md §6). Alert emails are written in the same
 * transaction as the alert, then drained: claimed under a lease, sent, marked sent. Every
 * query runs in a tenant transaction. Destinations are encrypted with the member-contact
 * envelope, bound to the outbox idempotency key.
 */
import { and, asc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { insertAlertTx, type AlertRow, type CreateAlertInput } from "./alerts.js";
import { decryptContact, encryptContact } from "./members.js";
import { alerts, notificationOutbox } from "./schema/index.js";
import { assertTenantId, tenantScoped } from "./tenant.js";

export type OutboxRow = typeof notificationOutbox.$inferSelect;

/** A row is given up on after this many send attempts. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** A claimed row is invisible to other drains for this long. */
export const OUTBOX_LEASE_MS = 2 * 60_000;

export interface OutboxRowInput {
  idempotencyKey: string;
  address: string;
  template: "alert" | "alert_cap";
  recipientMemberId: string | null;
  recipientUserId: string | null;
  payload: Record<string, unknown>;
}

/** What to enqueue for one alert; built by the caller from the household's recipients. */
export interface AlertEnqueuePlan {
  /** Alert emails; empty (no mailer, no recipients) marks the alert `skipped`. */
  rows(alert: AlertRow): OutboxRowInput[];
  /** The "more alerts than usual" notice rows, used instead of `rows` when the cap is hit. */
  capRows(alert: AlertRow, dayStart: Date): OutboxRowInput[];
  /** Alerts per household per UTC day admitted to email before the cap. */
  cap: number;
}

export interface EnqueueDecision {
  status: "pending" | "skipped";
  rows: OutboxRowInput[];
  capped: boolean;
}

/**
 * A child's request must reach a parent, so these alerts are exempt from the daily cap and are not
 * counted by it (a child asking repeatedly cannot crowd out a real security alert).
 */
export const REQUEST_ALERT_KINDS = ["child_request", "app_approval"] as const;
export function isRequestAlertKind(kind: string | undefined): boolean {
  return kind !== undefined && (REQUEST_ALERT_KINDS as readonly string[]).includes(kind);
}

/**
 * Alerts that bypass the daily email cap and are not counted by it: a child's requests, and the household's
 * spend cap alerts (owners are emailed at 80% whatever their threshold; _specs/v2-m3-cutover.md section 6).
 */
export function isCapExemptAlertKind(kind: string | undefined): boolean {
  return isRequestAlertKind(kind) || kind === "spend_cap";
}

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Whether an alert is emailed, and which rows go out. `admittedToday` counts the other
 * alerts of the household's UTC day that were admitted to email (`email_status` `pending` or
 * `sent`): the cap counts alerts, not individual emails, and counting at enqueue (rather than
 * at send) keeps a burst from slipping past it before the first drain. Critical alerts are
 * exempt from the cap, and so are request alerts (see `REQUEST_ALERT_KINDS`).
 */
export function decideEnqueue(alert: Pick<AlertRow, "severity"> & { kind?: string }, plan: Pick<AlertEnqueuePlan, "cap">, rows: OutboxRowInput[], capRows: () => OutboxRowInput[], admittedToday: number): EnqueueDecision {
  if (rows.length === 0) return { status: "skipped", rows: [], capped: false };
  if (alert.severity !== "critical" && !isCapExemptAlertKind(alert.kind) && admittedToday >= plan.cap) return { status: "skipped", rows: capRows(), capped: true };
  return { status: "pending", rows, capped: false };
}

async function insertRowsTx(tx: Tx, tenantId: string, alertId: string, rows: OutboxRowInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(notificationOutbox)
    .values(
      rows.map((r) => ({
        tenantId,
        idempotencyKey: r.idempotencyKey,
        channel: "email" as const,
        destinationCiphertext: encryptContact(tenantId, r.idempotencyKey, r.address),
        template: r.template,
        payload: r.payload,
        alertId,
        recipientMemberId: r.recipientMemberId,
        recipientUserId: r.recipientUserId,
      })),
    )
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning({ id: notificationOutbox.id });
  return inserted.length;
}

/** Decide, update the alert's email status and insert the rows. `tx` has app.tenant_id set. */
async function enqueueTx(tx: Tx, tenantId: string, alert: AlertRow, plan: AlertEnqueuePlan): Promise<{ alert: AlertRow; enqueued: number; capped: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`neo:alert-cap:${tenantId}`}, 0))`);
  const dayStart = utcDayStart(alert.createdAt);
  const [counted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(and(eq(alerts.tenantId, tenantId), ne(alerts.id, alert.id), notInArray(alerts.kind, [...REQUEST_ALERT_KINDS]), sql`${alerts.createdAt} >= ${dayStart}`, inArray(alerts.emailStatus, ["pending", "sent"])));
  const decision = decideEnqueue(alert, plan, plan.rows(alert), () => plan.capRows(alert, dayStart), counted?.n ?? 0);
  let out = alert;
  if (decision.status === "skipped") {
    const [updated] = await tx.update(alerts).set({ emailStatus: "skipped", emailedAt: null }).where(and(eq(alerts.tenantId, tenantId), eq(alerts.id, alert.id))).returning();
    out = updated ?? { ...alert, emailStatus: "skipped" };
  }
  return { alert: out, enqueued: await insertRowsTx(tx, tenantId, alert.id, decision.rows), capped: decision.capped };
}

/**
 * Insert an alert and its outbox rows in one transaction. Null on a dedupe hit (no rows).
 * `enqueued` counts rows actually inserted (a repeated cap notice is a no-op).
 */
export async function createAlertWithOutbox(
  db: Db,
  input: CreateAlertInput,
  plan: AlertEnqueuePlan,
): Promise<{ alert: AlertRow; enqueued: number; capped: boolean } | null> {
  assertTenantId(input.tenantId);
  return tenantScoped(db, input.tenantId).transaction(async (t) => {
    const alert = await insertAlertTx(t.tx, input);
    return alert ? enqueueTx(t.tx, input.tenantId, alert, plan) : null;
  });
}

/**
 * Enqueue rows for an existing alert that has none (raised before the outbox existed, or
 * whose enqueue failed). A no-op unless the alert is `pending` with no outbox rows.
 */
export async function enqueueOutboxForAlert(db: Db, tenantId: string, alertId: string, plan: AlertEnqueuePlan): Promise<{ enqueued: number; capped: boolean }> {
  assertTenantId(tenantId);
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const [alert] = await t.tx.select().from(alerts).where(and(eq(alerts.tenantId, tenantId), eq(alerts.id, alertId))).for("update").limit(1);
    if (!alert || alert.emailStatus !== "pending") return { enqueued: 0, capped: false };
    const [existing] = await t.tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.alertId, alertId)))
      .limit(1);
    if (existing) return { enqueued: 0, capped: false };
    const r = await enqueueTx(t.tx, tenantId, alert, plan);
    return { enqueued: r.enqueued, capped: r.capped };
  });
}

export async function countOutboxForAlert(db: Db, tenantId: string, alertId: string): Promise<number> {
  return tenantScoped(db, tenantId).count(notificationOutbox, eq(notificationOutbox.alertId, alertId));
}

/**
 * Claim up to `limit` unsent rows whose lease has expired: set the lease and count the
 * attempt. `FOR UPDATE SKIP LOCKED` keeps two drains from claiming the same row.
 */
export async function claimOutboxRows(db: Db, tenantId: string, opts: { now?: Date; limit?: number } = {}): Promise<OutboxRow[]> {
  assertTenantId(tenantId);
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const due = t.tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, tenantId),
          isNull(notificationOutbox.sentAt),
          lt(notificationOutbox.attempts, OUTBOX_MAX_ATTEMPTS),
          or(isNull(notificationOutbox.leaseUntil), lt(notificationOutbox.leaseUntil, now)),
        ),
      )
      .orderBy(asc(notificationOutbox.createdAt), asc(notificationOutbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    return t.tx
      .update(notificationOutbox)
      .set({ leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS), attempts: sql`${notificationOutbox.attempts} + 1` })
      .where(and(eq(notificationOutbox.tenantId, tenantId), inArray(notificationOutbox.id, due)))
      .returning();
  });
}

/** The row's destination address. Throws on a corrupt or foreign ciphertext. */
export function outboxDestination(row: Pick<OutboxRow, "tenantId" | "idempotencyKey" | "destinationCiphertext">): string {
  return decryptContact(row.tenantId, row.idempotencyKey, row.destinationCiphertext);
}

export async function markOutboxSent(db: Db, tenantId: string, id: string, providerId: string, now = new Date()): Promise<void> {
  await tenantScoped(db, tenantId).update(notificationOutbox, { sentAt: now, providerId: providerId || null, leaseUntil: null, lastError: null }, eq(notificationOutbox.id, id));
}

/** Record a failed send and release the lease. `permanent` stops retries (attempts = max). */
export async function markOutboxFailed(db: Db, tenantId: string, id: string, error: string, permanent: boolean): Promise<void> {
  await tenantScoped(db, tenantId).update(
    notificationOutbox,
    { lastError: error.slice(0, 300), leaseUntil: null, ...(permanent ? { attempts: OUTBOX_MAX_ATTEMPTS } : {}) },
    eq(notificationOutbox.id, id),
  );
}

/**
 * Settle a pending alert's `email_status` from its alert rows: any row given up on unsent
 * → `failed`; all rows sent → `sent`; otherwise unchanged. Returns the resulting status.
 */
export async function settleAlertEmail(db: Db, tenantId: string, alertId: string, now = new Date()): Promise<AlertRow["emailStatus"] | undefined> {
  assertTenantId(tenantId);
  return tenantScoped(db, tenantId).transaction(async (t) => {
    const rows = await t.tx
      .select({ sentAt: notificationOutbox.sentAt, attempts: notificationOutbox.attempts })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.tenantId, tenantId), eq(notificationOutbox.alertId, alertId), eq(notificationOutbox.template, "alert")));
    if (rows.length === 0) return undefined;
    const status = rows.some((r) => !r.sentAt && r.attempts >= OUTBOX_MAX_ATTEMPTS) ? "failed" : rows.every((r) => r.sentAt) ? "sent" : undefined;
    if (!status) return undefined;
    await t.tx
      .update(alerts)
      .set({ emailStatus: status, emailedAt: status === "sent" ? now : null })
      .where(and(eq(alerts.tenantId, tenantId), eq(alerts.id, alertId), eq(alerts.emailStatus, "pending")));
    return status;
  });
}

/**
 * Tenants with sendable rows (unsent, attempts left, no live lease), for the sweep. Goes
 * through the `list_outbox_tenants` security definer function (0018), because
 * `notification_outbox` has RLS and the sweep runs outside any tenant context.
 */
export async function listPendingOutboxTenants(db: Db, limit = 200): Promise<string[]> {
  const res = await db.execute(sql`select tenant_id from list_outbox_tenants(${OUTBOX_MAX_ATTEMPTS}, ${limit})`);
  return (res as unknown as { rows: Array<{ tenant_id: string }> }).rows.map((r) => r.tenant_id);
}
