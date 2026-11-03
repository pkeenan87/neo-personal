/**
 * What approving or denying a child request does, in one place (_specs/v2-m2-child.md section 8):
 * the numbers an approval uses and the sentence that describes them. The decision service, the
 * console, the email link page and the eve approval prompt all read this, so the person who clicks
 * Approve is shown exactly what will be stored. Pure; imports nothing from Next or the database.
 */
import {
  ALLOW_ONCE_MS,
  MAX_GRANT_MINUTES,
  appLabel,
  requestSummary,
  type ChildRequestKindName,
  type UnblockScope,
} from "../child-request-types";

export interface EffectRequest {
  kind: ChildRequestKindName;
  detail: Record<string, unknown>;
}

export interface EffectOptions {
  minutes?: number | undefined;
  scope?: UnblockScope | undefined;
}

/** Whole minutes for an approval: the owner's figure (capped at 120) or what the child asked for. Undefined when neither is usable. */
export function grantMinutes(detail: Record<string, unknown>, minutes?: number): number | undefined {
  const asked = typeof detail.minutes === "number" ? detail.minutes : undefined;
  const chosen = minutes ?? asked;
  if (chosen === undefined || !Number.isFinite(chosen)) return undefined;
  const whole = Math.floor(chosen);
  return whole < 1 ? undefined : Math.min(whole, MAX_GRANT_MINUTES);
}

export type Effect =
  | { kind: "more_time"; minutes: number; until: Date }
  | { kind: "unblock_site"; domain: string; scope: "once"; until: Date }
  | { kind: "unblock_site"; domain: string; scope: "always" }
  | { kind: "install_app"; app: Record<string, unknown> };

/** The grant an approval would store, or undefined when the request row is unusable. `endOfDay` is the end of the child's day. */
export function approvalEffect(req: EffectRequest, opts: EffectOptions, now: Date, endOfDay: Date): Effect | undefined {
  if (req.kind === "more_time") {
    const minutes = grantMinutes(req.detail, opts.minutes);
    return minutes === undefined ? undefined : { kind: "more_time", minutes, until: endOfDay };
  }
  if (req.kind === "unblock_site") {
    const domain = req.detail.domain;
    if (typeof domain !== "string" || !domain) return undefined;
    return (opts.scope ?? "once") === "always"
      ? { kind: "unblock_site", domain, scope: "always" }
      : { kind: "unblock_site", domain, scope: "once", until: new Date(now.getTime() + ALLOW_ONCE_MS) };
  }
  const app = req.detail.app;
  return app && typeof app === "object" ? { kind: "install_app", app: app as Record<string, unknown> } : undefined;
}

/** The grant column for an effect. */
export function effectGrant(effect: Effect): Record<string, unknown> {
  switch (effect.kind) {
    case "more_time":
      return { minutes: effect.minutes, until: effect.until.toISOString() };
    case "unblock_site":
      return effect.scope === "once" ? { domain: effect.domain, scope: "once", until: effect.until.toISOString() } : { domain: effect.domain, scope: "always" };
    case "install_app":
      return { app: effect.app };
  }
}

/** The question an owner is asked, from the request and the numbers an approval would use ("Give Sam 30 more minutes today on Family PC?"). */
export function approvalQuestion(req: EffectRequest, opts: EffectOptions, who: { memberName: string; deviceName: string | null }): string {
  const on = who.deviceName ? ` on ${who.deviceName}` : "";
  if (req.kind === "more_time") {
    const minutes = grantMinutes(req.detail, opts.minutes);
    return minutes === undefined ? `Give ${who.memberName} more time today${on}?` : `Give ${who.memberName} ${minutes} more minutes today${on}?`;
  }
  if (req.kind === "unblock_site") {
    const domain = typeof req.detail.domain === "string" ? req.detail.domain : "this site";
    return (opts.scope ?? "once") === "always" ? `Always allow ${domain} for ${who.memberName}?` : `Allow ${domain} for ${who.memberName} for 1 hour?`;
  }
  return `Allow ${appLabel(req.detail.app)} for ${who.memberName}${on}?`;
}

/** The sentence reported after an approval was stored. */
export function approvalDone(effect: Effect, who: { memberName: string; deviceName: string | null }): string {
  const on = who.deviceName ? ` on ${who.deviceName}` : "";
  switch (effect.kind) {
    case "more_time":
      return `${who.memberName} now has ${effect.minutes} more minutes today${on}.`;
    case "unblock_site":
      return effect.scope === "once" ? `${effect.domain} is allowed for ${who.memberName} for 1 hour.` : `${effect.domain} is now always allowed for ${who.memberName}.`;
    case "install_app":
      return `${appLabel(effect.app)} is now allowed for ${who.memberName}.`;
  }
}

export function denyQuestion(req: EffectRequest, who: { memberName: string }): string {
  return `Say no to ${who.memberName}'s request for ${requestSummary(req.kind, req.detail)}?`;
}

export function denyDone(req: EffectRequest, who: { memberName: string }): string {
  return `You said no to ${who.memberName}'s request for ${requestSummary(req.kind, req.detail)}. Nothing was changed.`;
}
