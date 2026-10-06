/**
 * Sign-in alert service (_specs/signin-alerts.md): the deterministic verdict override plus the stateful
 * parts around it (first-seen device check, event storage, the "Was this you?" answer). The override
 * itself is pure (override.ts); everything here that reads or writes is tenant-scoped through the store.
 * Never logs device labels, locations, IPs, addresses or message text.
 */
import { hashPii, logger } from "@neo/core";
import { assessSigninAlert, type EmailAnalysis } from "@neo/tools";
import type { SigninCheck, Verdict } from "@neo/verdict";
import { VerdictSchema } from "@neo/verdict";
import type { SigninEventSource } from "@neo/db";
import type { NeoSession } from "@/lib/session";
import { getVisibleVerdict, verdictBody } from "../verdict-data";
import { mockGeoLocator, type GeoLocator } from "./geo";
import { applyAmbiguousSigninCap, applySigninAlertOverride } from "./override";
import { getSigninStore, type SigninStore } from "./store";

/** A parsed event ready to store once its verdict has an id. Plain JSON: it crosses Inngest step boundaries. */
export type SigninEventPayload = {
  provider: SigninCheck["provider"];
  event: SigninCheck["event"];
  deviceLabel: string | null;
  coarseLocation: string | null;
  /** ISO-8601 UTC or null. */
  eventTime: string | null;
  source: SigninEventSource;
  authenticated: boolean;
};

export type FinalizedSigninVerdict = { verdict: Verdict; event: SigninEventPayload | null };

export interface SigninDeps {
  store?: SigninStore;
  geo?: GeoLocator;
}

/**
 * The verdict without any model-written `signin_check` (only this service sets it). A model-claimed
 * `signin_alert` subject with no recognized alert behind it gets the ambiguous cap: never `likely_safe`, static headline.
 */
function withoutCheck(verdict: Verdict): Verdict {
  const { signin_check: _drop, ...rest } = verdict;
  return rest.subject_type === "signin_alert" ? applyAmbiguousSigninCap(rest) : rest;
}

/**
 * Apply the deterministic override to a triaged verdict and, for a recognized alert, work out the
 * "Was this you?" check and the event to store. A message that is not a recognized sign-in alert comes
 * back unchanged (minus any model-written `signin_check`).
 */
export async function finalizeSigninVerdict(
  input: { tenantId: string; userId: string; analysis: EmailAnalysis; verdict: Verdict; source: SigninEventSource },
  deps: SigninDeps = {},
): Promise<FinalizedSigninVerdict> {
  const { analysis, tenantId, userId } = input;
  const alert = analysis.signin_alert;
  const assessment = alert ? assessSigninAlert(analysis) : null;
  if (!alert || !assessment) return { verdict: withoutCheck(input.verdict), event: null };

  const overridden = applySigninAlertOverride({ analysis, verdict: input.verdict });
  const geo = deps.geo ?? mockGeoLocator;
  let location = alert.location;
  const ip = alert.ip_addresses[0];
  if (!location && ip) {
    try {
      location = (await geo.locate(ip)).coarseLocation;
    } catch {
      /* advisory only */
    }
  }
  const device = alert.device;
  const event: SigninEventPayload = {
    provider: alert.provider,
    event: alert.event,
    deviceLabel: device ?? null,
    coarseLocation: location ?? null,
    eventTime: alert.event_time ?? null,
    source: input.source,
    authenticated: assessment.authenticated,
  };

  // Ask only about a real-looking alert with a named device: a fake alert's device label is attacker text.
  if (!device || overridden.verdict === "malicious") return { verdict: overridden, event };
  const store = deps.store ?? getSigninStore();
  let firstSeen = true;
  try {
    firstSeen = !(await store.isKnownDevice(tenantId, userId, alert.provider, device));
  } catch (err) {
    logger.error("Known-device lookup failed", "signin", { tenantId, userIdHash: hashPii(userId), errorMessage: errText(err) });
  }
  const check: SigninCheck = {
    provider: alert.provider,
    event: alert.event,
    device_label: device,
    first_seen: firstSeen,
    ...(location ? { coarse_location: location } : {}),
  };
  const withCheck = { ...overridden, signin_check: check };
  // A value the schema rejects must not break the verdict save: drop the check instead.
  return { verdict: VerdictSchema.safeParse(withCheck).success ? withCheck : overridden, event };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Store the event for a saved verdict. Never throws: the user already has their answer. */
export async function persistSigninEvent(
  input: { tenantId: string; userId: string; verdictId?: string | undefined; event: SigninEventPayload | null },
  deps: SigninDeps = {},
): Promise<void> {
  if (!input.event) return;
  const e = input.event;
  try {
    await (deps.store ?? getSigninStore()).record(input.tenantId, {
      userId: input.userId,
      provider: e.provider,
      event: e.event,
      deviceLabel: e.deviceLabel,
      coarseLocation: e.coarseLocation,
      eventTime: e.eventTime ? new Date(e.eventTime) : null,
      source: e.source,
      authenticated: e.authenticated,
      verdictId: input.verdictId ?? null,
    });
  } catch (err) {
    logger.error("Sign-in event write failed", "signin", { tenantId: input.tenantId, userIdHash: hashPii(input.userId), errorMessage: errText(err) });
  }
}

export type SigninAnswer = { status: "ok"; playbook?: "account_takeover" } | { status: "not_found" } | { status: "no_check" };

/**
 * "Was this you?" answer. Only the verdict's own user (not an owner) may answer. Idempotent, last answer wins:
 * yes remembers the provider/device pair, no forgets it and points at the account_takeover playbook.
 */
export async function answerSigninCheck(
  session: NeoSession,
  verdictId: string,
  response: "yes" | "no",
  deps: SigninDeps = {},
): Promise<SigninAnswer> {
  const row = await getVisibleVerdict(session, verdictId);
  if (!row || row.userId !== session.userId) return { status: "not_found" };
  const check = verdictBody(row)?.signin_check;
  if (!check) return { status: "no_check" };
  const store = deps.store ?? getSigninStore();
  if (response === "yes") {
    await store.rememberDevice(session.tenantId, session.userId, check.provider, check.device_label);
    return { status: "ok" };
  }
  await store.forgetDevice(session.tenantId, session.userId, check.provider, check.device_label);
  return { status: "ok", playbook: "account_takeover" };
}
