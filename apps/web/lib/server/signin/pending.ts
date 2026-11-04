/**
 * The sign-in alerts a member is still being asked "Was this you?" about, for the eve chat's
 * `pending_signin_alerts` tool. Imports nothing from Next, so the eve server can bundle it.
 *
 * Only the member's own events are read (the store is keyed by tenant and user; there is no selector),
 * so an owner sees their own, never another member's: sign-in details are the member's own
 * (_specs/signin-alerts.md, `privacy.ts`). An event is pending when it names a device that is not
 * remembered as theirs and its stored verdict carries a `signin_check`: the same condition under which
 * the verdict card asks the question.
 */
import { cleanValue } from "./clean";
import { getSigninStore, type SigninStore } from "./store";
import { getVisibleVerdict, verdictBody, type VerdictViewer } from "../verdict-data";

export const PENDING_SIGNIN_WINDOW_DAYS = 14;
export const PENDING_SIGNIN_MAX = 5;

export interface PendingSigninAlert {
  /** The id `confirm_signin` takes. */
  verdictId: string;
  provider: string;
  event: string;
  device: string;
  /** Advisory: it may be IP-derived or forged. */
  location_advisory: string | null;
  event_time: string | null;
  received_at: string;
}

export async function listPendingSigninAlerts(
  viewer: VerdictViewer,
  opts: { now?: Date; store?: SigninStore } = {},
): Promise<PendingSigninAlert[]> {
  const store = opts.store ?? getSigninStore();
  const since = (opts.now ?? new Date()).getTime() - PENDING_SIGNIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const events = await store.list(viewer.tenantId, viewer.userId, { limit: 50 });
  const out: PendingSigninAlert[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (out.length >= PENDING_SIGNIN_MAX) break;
    if (!e.verdictId || !e.deviceLabel || e.deviceKnown || e.createdAt.getTime() < since || seen.has(e.verdictId)) continue;
    seen.add(e.verdictId);
    // The same visibility rules as the dashboard; the check must still be on the stored verdict.
    const row = await getVisibleVerdict(viewer, e.verdictId);
    if (!row || row.userId !== viewer.userId || !verdictBody(row)?.signin_check) continue;
    out.push({
      verdictId: row.id,
      provider: e.provider,
      event: e.event,
      device: cleanValue(e.deviceLabel, 80),
      location_advisory: e.coarseLocation ? cleanValue(e.coarseLocation, 80) : null,
      event_time: e.eventTime ? e.eventTime.toISOString() : null,
      received_at: e.createdAt.toISOString(),
    });
  }
  return out;
}
