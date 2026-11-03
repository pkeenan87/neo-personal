/**
 * Incident actions (_specs/v2-m1-elder.md section 8): the record of what an acting eve tool did to
 * an incident (an alert), who asked and who approved. Append-only; tenant-scoped.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { alerts, incidentActions, type IncidentActionKind, type IncidentActionRequester, type IncidentActionStatus } from "./schema/index.js";
import { tenantScoped } from "./tenant.js";

export type IncidentActionRow = typeof incidentActions.$inferSelect;

export interface RecordIncidentActionInput {
  alertId: string;
  kind: IncidentActionKind;
  requestedBy: IncidentActionRequester;
  /** The user id of the person who approved the action. */
  approvedBy: string | null;
  status: IncidentActionStatus;
  result?: unknown;
}

/**
 * Insert one action row for an alert of the household. Throws when the alert is not in this household
 * (the table's foreign key alone would accept another household's alert id).
 */
export async function recordIncidentAction(db: Db, tenantId: string, input: RecordIncidentActionInput): Promise<IncidentActionRow> {
  return tenantScoped(db, tenantId).transaction(async (t) => {
    if (!(await t.first(alerts, eq(alerts.id, input.alertId)))) throw new Error("@neo/db: alert not found in this household");
    const [row] = await t.insert(incidentActions, {
      alertId: input.alertId,
      kind: input.kind,
      requestedBy: input.requestedBy,
      approvedBy: input.approvedBy,
      status: input.status,
      result: input.result ?? null,
    });
    if (!row) throw new Error("@neo/db: incident action insert returned no row");
    return row;
  });
}

/** An incident's actions, newest first. */
export async function listIncidentActions(db: Db, tenantId: string, alertId: string): Promise<IncidentActionRow[]> {
  return tenantScoped(db, tenantId).select(incidentActions, and(eq(incidentActions.alertId, alertId)), { orderBy: [desc(incidentActions.createdAt)] });
}
