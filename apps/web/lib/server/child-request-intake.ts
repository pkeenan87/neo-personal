/**
 * How a child request starts (_specs/v2-m2-child.md section 8): the device API's create call, and the
 * `install_app` request the policy engine opens for a new app. Kept apart from child-requests.ts
 * because it raises alerts (outbox, Inngest), which the eve agent's bundle of the decision service
 * must not pull in.
 */
import { randomUUID } from "node:crypto";
import { endOfLocalDay, logger } from "@neo/core";
import { createChildRequest, getProtectionLayers, setChildRequestAlert, tenantScoped } from "@neo/db";
import { AppRefSchema, PolicyDomainSchema, type AppRef } from "@neo/verdict";
import { z } from "zod";
import { MAX_GRANT_MINUTES, MIN_REQUEST_MINUTES, appLabel, type ChildRequestKindName, type DeviceRequestView } from "../child-request-types";
import { alertChildRequest } from "./alerts";
import { childRequestAlertText, displayName } from "./alerts/templates";
import { DECISION_TOKEN_TTL_MS, fail, newDecisionToken, toDeviceView, type Outcome } from "./child-requests";
import { getDb } from "./db";
import { getDevice } from "./devices";
import type { DeviceSession } from "./session-core";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const NO_STORAGE = fail(503, "storage_unavailable", "Neo can't reach its storage right now. Please try again in a moment.");

// ─── Input ─────────────────────────────────────────────────────────

/** Text from a child: control characters become spaces, runs of whitespace collapse, and it is trimmed. */
export function cleanReason(input: string): string {
  // Control characters, line and paragraph separators, and the invisible bidi controls that can make a
  // line read backwards in an email, become spaces.
  return input.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
}

export const REASON_MAX = 140;

const MoreTimeDetail = z.object({ minutes: z.number().int().min(MIN_REQUEST_MINUTES).max(MAX_GRANT_MINUTES) }).strict();
const UnblockDetail = z
  .object({
    domain: z
      .string()
      .transform((d) => d.trim().toLowerCase().replace(/\.$/, ""))
      .pipe(PolicyDomainSchema),
  })
  .strict();
const InstallDetail = z.object({ app: AppRefSchema }).strict();

const DETAIL_SCHEMAS = { more_time: MoreTimeDetail, unblock_site: UnblockDetail, install_app: InstallDetail } as const;
const KINDS = ["more_time", "unblock_site", "install_app"] as const;

interface ParsedCreate {
  kind: ChildRequestKindName;
  detail: Record<string, unknown>;
  reason: string | null;
}

function parseCreate(body: Record<string, unknown> | null): Outcome<ParsedCreate> {
  const bad = (message: string, path = "body") => fail(400, "invalid", message, [{ path, message }]);
  if (!body) return bad('Expected { "kind", "detail", "reason"? }.');
  const extra = Object.keys(body).filter((k) => k !== "kind" && k !== "detail" && k !== "reason");
  if (extra.length > 0) return bad(`Unknown field: ${extra[0]!.slice(0, 40)}.`, extra[0]!.slice(0, 40));
  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return bad("kind must be more_time, unblock_site or install_app.", "kind");
  const k = kind as ChildRequestKindName;
  const parsed = DETAIL_SCHEMAS[k].safeParse(body.detail);
  if (!parsed.success) {
    return fail(
      400,
      "invalid",
      "detail is not valid for this kind.",
      parsed.error.issues.slice(0, 5).map((i) => ({ path: ["detail", ...i.path.map(String)].join("."), message: i.message.slice(0, 120) })),
    );
  }
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") return bad("reason must be text.", "reason");
    const cleaned = cleanReason(body.reason);
    if ([...cleaned].length > REASON_MAX) return bad(`reason can be at most ${REASON_MAX} characters.`, "reason");
    reason = cleaned || null;
  }
  return { ok: true, value: { kind: k, detail: parsed.data as Record<string, unknown>, reason } };
}

export interface CreatedDeviceRequest {
  id: string;
  status: DeviceRequestView["status"];
  expiresAt: string | null;
  /** False when an identical pending request already existed (the existing one is returned). */
  created: boolean;
}

/**
 * `POST /api/devices/requests`. The member is the device's. Only a Child-mode member can ask (409
 * `not_child_mode`). An identical pending request of the device is returned instead of a second one.
 */
export async function createDeviceRequest(session: DeviceSession, body: Record<string, unknown> | null, now = new Date()): Promise<Outcome<CreatedDeviceRequest>> {
  const parsed = parseCreate(body);
  if (!parsed.ok) return parsed;
  const db = getDb();
  if (!db) return NO_STORAGE;
  const device = await getDevice(session.tenantId, session.deviceId);
  if (!device || device.revokedAt || !device.memberId) return fail(404, "not_found", "This device is no longer connected to a household.");
  const tdb = tenantScoped(db, session.tenantId);
  const layers = await getProtectionLayers(tdb, { memberId: device.memberId });
  if (layers.mode !== "child") return fail(409, "not_child_mode", "Requests are only for devices in Child mode.");

  const { kind, detail, reason } = parsed.value;
  const { token, hash } = newDecisionToken();
  const id = randomUUID();
  const r = await createChildRequest(tdb, {
    id,
    memberId: device.memberId,
    deviceId: device.id,
    kind,
    detail,
    reason,
    expiresAt: endOfLocalDay(now, layers.timeZone ?? null),
    tokenHash: hash,
    tokenExpiresAt: new Date(now.getTime() + DECISION_TOKEN_TTL_MS),
    source: "device",
    now,
  });
  if (r.outcome === "too_many_pending") return fail(429, "too_many_pending", "There are already too many requests waiting for an answer.");
  if (r.outcome === "daily_limit") return fail(429, "daily_limit", "That is the most requests for one day.");
  if (r.outcome === "existing") return { ok: true, value: { id: r.row.id, status: toDeviceView(r.row, now).status, expiresAt: r.row.expiresAt?.toISOString() ?? null, created: false } };

  // Tell the parents. Raising an alert never throws; if it fails the request still stands and shows in the console.
  const memberName = displayName(device.memberName, null);
  const what = kind === "more_time" ? String(detail.minutes) : kind === "unblock_site" ? String(detail.domain) : appLabel(detail.app);
  const alert = await alertChildRequest({
    tenantId: session.tenantId,
    userId: device.userId,
    memberId: device.memberId,
    deviceId: device.id,
    kind: "child_request",
    requestId: r.row.id,
    token,
    text: childRequestAlertText(memberName, kind, what),
  });
  if (alert) await setChildRequestAlert(tdb, r.row.id, alert.id).catch((err: unknown) => logger.error("Linking a child request to its alert failed", "child-requests", { tenantId: session.tenantId, errorMessage: errText(err) }));
  return { ok: true, value: { id: r.row.id, status: "pending", expiresAt: r.row.expiresAt?.toISOString() ?? null, created: true } };
}

// ─── Install-app requests opened by the policy engine ───────────────

/** An `AppRef` from the fields of an `app_installed` signal; undefined when it has none of bundle id, signer or image. */
export function appRefFromSignal(event: { bundleId?: string | undefined; signer?: string | undefined; image?: string | undefined }): AppRef | undefined {
  const candidate = event.bundleId ? { bundleId: event.bundleId } : { ...(event.signer ? { signer: event.signer } : {}), ...(event.image ? { image: event.image } : {}) };
  const parsed = AppRefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export type OpenedInstallRequest =
  | { status: "created"; requestId: string; token: string }
  | { status: "existing"; requestId: string; alertId: string | null };

/**
 * Open an `install_app` request for a new app on a device (the `app_approval` incident). A pending request
 * for the same device and app is returned instead of a second one. The rate limits do not apply: a new app
 * is not the child asking too often, and it must still reach a parent. Throws on a storage error.
 */
export async function openInstallAppRequest(input: {
  tenantId: string;
  memberId: string;
  deviceId: string;
  app: AppRef;
  now?: Date;
}): Promise<OpenedInstallRequest | undefined> {
  const db = getDb();
  if (!db) return undefined;
  const now = input.now ?? new Date();
  const tdb = tenantScoped(db, input.tenantId);
  const layers = await getProtectionLayers(tdb, { memberId: input.memberId });
  const { token, hash } = newDecisionToken();
  const r = await createChildRequest(tdb, {
    id: randomUUID(),
    memberId: input.memberId,
    deviceId: input.deviceId,
    kind: "install_app",
    detail: { app: input.app },
    reason: null,
    expiresAt: endOfLocalDay(now, layers.timeZone ?? null),
    tokenHash: hash,
    tokenExpiresAt: new Date(now.getTime() + DECISION_TOKEN_TTL_MS),
    source: "system",
    now,
  });
  if (r.outcome === "created") return { status: "created", requestId: r.row.id, token };
  if (r.outcome === "existing") return { status: "existing", requestId: r.row.id, alertId: r.row.alertId };
  return undefined;
}

/** Link a request opened by `openInstallAppRequest` to the alert that tells the parents about it. */
export async function linkRequestAlert(tenantId: string, requestId: string, alertId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await setChildRequestAlert(tenantScoped(db, tenantId), requestId, alertId);
}

