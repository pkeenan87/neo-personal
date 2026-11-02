/**
 * Read-only incident data for the eve agent's tools and the incident chat page
 * (_specs/v2-m1-elder.md section 7). Imports nothing from Next, so the eve server can bundle it.
 *
 * - Postgres only. The eve server is a separate process from Next, so the in-memory twins that
 *   serve MOCK_MODE inside Next are empty there; without DATABASE_URL every lookup is a miss.
 * - The tenant and the caller come from the verified session (the eve caller), never from a
 *   tool's input. Every query goes through `tenantScoped()`.
 * - Visibility: owners see the household; a member sees only what is about them. A miss and a
 *   foreign row look the same (`null`), so an id never confirms that another household has it.
 * - Output is minimized (no payloads, contact data or emails) and still attacker-influenced
 *   (titles quote verdict headlines, subjects are domains): tools pass it through wrapToolResult.
 */
import {
  alerts,
  deviceSignals,
  devices,
  listAlerts,
  listMemberRecords,
  members,
  setAlertEveSession,
  tenantScoped,
  type AlertRow,
  type Member,
} from "@neo/db";
import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { callerOwnsSession } from "./eve-session-owner";
import type { MembershipRole } from "./session-core";

export interface IncidentCaller {
  tenantId: string;
  userId: string;
  role: MembershipRole;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNALS_PER_INCIDENT = 20;
const TIMELINE_MAX_ROWS = 100;

export const INCIDENT_LIST_MAX = 20;
export const TIMELINE_MAX_HOURS = 24;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface SignalSummary {
  detector: string;
  subject: string;
  severity: string | null;
  observedAt: string;
}

export interface IncidentView {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  member: string | null;
  device: string | null;
  signals: SignalSummary[];
}

export interface LoadedIncident {
  incident: IncidentView;
  /** The eve session already linked to this alert, if any (not shown to the model). */
  eveSessionId: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function canSee(caller: IncidentCaller, alert: Pick<AlertRow, "subjectUserId">): boolean {
  return caller.role === "owner" || alert.subjectUserId === caller.userId;
}

/** One alert as the caller may see it, or null (unknown id, malformed id, another household, not about the caller). */
export async function loadIncident(caller: IncidentCaller, id: string): Promise<LoadedIncident | null> {
  const db = getDb();
  if (!db || !isUuid(id)) return null;
  const t = tenantScoped(db, caller.tenantId);
  const alert = await t.first(alerts, eq(alerts.id, id));
  if (!alert || !canSee(caller, alert)) return null;

  const [member, device, signals] = await Promise.all([
    alert.memberId
      ? t.first(members, eq(members.id, alert.memberId))
      : alert.subjectUserId
        ? t.first(members, eq(members.userId, alert.subjectUserId))
        : undefined,
    alert.deviceId ? t.first(devices, eq(devices.id, alert.deviceId)) : undefined,
    alert.signalIds.length > 0
      ? t.select(deviceSignals, inArray(deviceSignals.id, alert.signalIds), { orderBy: [asc(deviceSignals.observedAt)], limit: SIGNALS_PER_INCIDENT })
      : [],
  ]);
  return {
    eveSessionId: alert.eveSessionId,
    incident: {
      id: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      body: alert.body,
      createdAt: alert.createdAt.toISOString(),
      acknowledgedAt: iso(alert.acknowledgedAt),
      resolvedAt: iso(alert.resolvedAt),
      member: member?.displayName ?? null,
      device: device?.name ?? null,
      signals: signals.map((s) => ({ detector: s.detector, subject: s.subject, severity: s.severity ?? null, observedAt: s.observedAt.toISOString() })),
    },
  };
}

export interface IncidentListItem {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  createdAt: string;
  member: string | null;
}

/** Newest first. `open` is the unacknowledged ones. A member gets only alerts about themselves. */
export async function listIncidents(caller: IncidentCaller, opts: { status?: "open" | "all"; limit?: number } = {}): Promise<IncidentListItem[]> {
  const db = getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 10) || 10, INCIDENT_LIST_MAX));
  const { items } = await listAlerts(db, caller.tenantId, {
    status: opts.status ?? "open",
    limit,
    ...(caller.role === "owner" ? {} : { subjectUserId: caller.userId }),
  });
  return items.map((a) => ({
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    status: a.status,
    title: a.title,
    createdAt: a.createdAt.toISOString(),
    member: a.subjectName,
  }));
}

export interface TimelineItem {
  detector: string;
  subject: string;
  severity: string | null;
  outcome: string;
  observedAt: string;
  device: string | null;
}

export type TimelineResult = { items: TimelineItem[]; hours: number } | { error: "not_found" };

/**
 * A member's (or one device's) signals over the last `hours` (at most 24), oldest first. A member
 * sees only their own devices; an owner can ask about anyone in the household. With neither id the
 * caller's own signals are returned.
 */
export async function deviceTimeline(
  caller: IncidentCaller,
  opts: { memberId?: string; deviceId?: string; hours?: number; now?: Date },
): Promise<TimelineResult> {
  const db = getDb();
  if (!db) return { error: "not_found" };
  const hours = Math.max(1, Math.min(Math.floor(opts.hours ?? TIMELINE_MAX_HOURS) || TIMELINE_MAX_HOURS, TIMELINE_MAX_HOURS));
  const t = tenantScoped(db, caller.tenantId);
  const owner = caller.role === "owner";

  let userId = caller.userId;
  let deviceId: string | undefined;
  if (opts.memberId !== undefined) {
    if (!isUuid(opts.memberId)) return { error: "not_found" };
    const m = await t.first(members, eq(members.id, opts.memberId));
    if (!m || (!owner && m.userId !== caller.userId)) return { error: "not_found" };
    if (!m.userId) return { items: [], hours };
    userId = m.userId;
  }
  if (opts.deviceId !== undefined) {
    if (!isUuid(opts.deviceId)) return { error: "not_found" };
    const d = await t.first(devices, eq(devices.id, opts.deviceId));
    if (!d) return { error: "not_found" };
    // A member may ask only about their own device; with a memberId too, the device must be that member's.
    if (opts.memberId !== undefined ? d.userId !== userId : !owner && d.userId !== caller.userId) return { error: "not_found" };
    userId = d.userId;
    deviceId = d.id;
  }

  const since = new Date((opts.now ?? new Date()).getTime() - hours * 60 * 60 * 1000);
  const rows = await t.select(
    deviceSignals,
    and(eq(deviceSignals.userId, userId), gte(deviceSignals.observedAt, since), deviceId ? eq(deviceSignals.deviceId, deviceId) : undefined),
    { orderBy: [desc(deviceSignals.observedAt)], limit: TIMELINE_MAX_ROWS },
  );
  const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
  const names = new Map((deviceIds.length > 0 ? await t.select(devices, inArray(devices.id, deviceIds)) : []).map((d) => [d.id, d.name]));
  return {
    hours,
    items: rows.reverse().map((r) => ({
      detector: r.detector,
      subject: r.subject,
      severity: r.severity ?? null,
      outcome: r.outcome,
      observedAt: r.observedAt.toISOString(),
      device: names.get(r.deviceId) ?? null,
    })),
  };
}

export interface MemberSummary {
  id: string;
  displayName: string;
  role: Member["role"];
  mode: Member["mode"];
  deviceCount: number;
}

/** Household members with their active device count; a member sees only themselves. No contact data. */
export async function listMemberSummaries(caller: IncidentCaller): Promise<MemberSummary[]> {
  const db = getDb();
  if (!db) return [];
  const t = tenantScoped(db, caller.tenantId);
  const [all, active] = await Promise.all([listMemberRecords(t), t.select(devices, isNull(devices.revokedAt))]);
  return all
    .filter((m) => caller.role === "owner" || m.userId === caller.userId)
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      role: m.role,
      mode: m.mode,
      deviceCount: active.filter((d) => d.memberId === m.id || (m.userId !== null && d.userId === m.userId)).length,
    }));
}

/** Link an eve session the caller created to an incident the caller can see. False otherwise. */
export async function linkIncidentSession(
  caller: IncidentCaller,
  incidentId: string,
  eveSessionId: string,
  opts: { ownerWaitMs?: number } = {},
): Promise<boolean> {
  const db = getDb();
  if (!db || !(await loadIncident(caller, incidentId))) return false;
  // Only a session the caller created: otherwise the link would hand someone else's chat to the next reader.
  if (!(await callerOwnsSession(caller, eveSessionId, opts.ownerWaitMs === undefined ? {} : { waitMs: opts.ownerWaitMs }))) return false;
  return setAlertEveSession(db, caller.tenantId, incidentId, eveSessionId);
}
