/**
 * Who is emailed about an alert (_specs/v2-m1-elder.md §6). Pure: the loaders in outbox.ts
 * gather owners, members, contacts and the subject's policy; this decides.
 *
 *  - Owners whose `alert_email_threshold` admits the severity (unchanged from Phase 3).
 *  - When the subject member is in Elder or Child mode: their helpers, at or above the
 *    subject's effective `notify.helpersNotifyAt`.
 *  - A subject in Elder/Child mode is never emailed about their own alert, even if they own
 *    the household. Standard-mode owners keep getting alerts about their own devices.
 *  - Deduped by lowercased address; owners come first, so a person who is both is an owner.
 */
import type { ProtectionMode } from "@neo/db";
import type { Severity } from "@neo/verdict";
import type { AlertThreshold } from "@/lib/alert-types";

/** Alerts per household per UTC day admitted to email before the "more than usual" notice. */
export const ALERT_EMAIL_DAILY_CAP = 20;

export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const THRESHOLD_RANK: Record<AlertThreshold, number> = { medium: 2, high: 3, critical: 4, off: Infinity };

export function meetsThreshold(severity: Severity, threshold: AlertThreshold): boolean {
  return SEVERITY_RANK[severity] >= THRESHOLD_RANK[threshold];
}

export interface RecipientOwner {
  userId: string;
  email: string | null;
  threshold: AlertThreshold;
}

export interface RecipientMember {
  /** The `members` row id; null only where no row exists (a membership that predates them). */
  id: string | null;
  userId: string | null;
  displayName: string;
  mode: ProtectionMode;
  helperMemberIds: readonly string[];
  /** The account email, when the member has an account. */
  email: string | null;
  /** The decrypted helper contact; only loaded for the subject's helpers. */
  contact: string | null;
}

export interface AlertRecipient {
  /** Where to send. */
  address: string;
  kind: "owner" | "helper";
  userId: string | null;
  memberId: string | null;
}

export function protectedMode(mode: ProtectionMode | undefined): boolean {
  return mode === "elder" || mode === "child";
}

export function resolveAlertRecipients(input: {
  severity: Severity;
  owners: readonly RecipientOwner[];
  members: readonly RecipientMember[];
  /** The member the alert is about; null when it is about no member. */
  subject: RecipientMember | null;
  /** The subject's effective `notify.helpersNotifyAt`; unset means helpers are not notified. */
  helpersNotifyAt: Severity | undefined;
}): AlertRecipient[] {
  const { subject } = input;
  const guarded = subject !== null && protectedMode(subject.mode);
  const isSubject = (userId: string | null, memberId: string | null): boolean =>
    guarded && ((userId !== null && userId === subject.userId) || (memberId !== null && memberId === subject.id));

  const out: AlertRecipient[] = [];
  const seen = new Set<string>();
  const add = (r: AlertRecipient): void => {
    const key = r.address.trim().toLowerCase();
    if (!key || seen.has(key) || isSubject(r.userId, r.memberId)) return;
    seen.add(key);
    out.push({ ...r, address: r.address.trim() });
  };

  for (const o of input.owners) {
    if (!o.email || !meetsThreshold(input.severity, o.threshold)) continue;
    add({ address: o.email, kind: "owner", userId: o.userId, memberId: input.members.find((m) => m.userId === o.userId)?.id ?? null });
  }

  if (guarded && input.helpersNotifyAt && SEVERITY_RANK[input.severity] >= SEVERITY_RANK[input.helpersNotifyAt]) {
    for (const helperId of subject.helperMemberIds) {
      const h = input.members.find((m) => m.id === helperId);
      const address = h?.email || h?.contact;
      if (h && address) add({ address, kind: "helper", userId: h.userId, memberId: h.id });
    }
  }
  return out;
}

/** The outbox idempotency key's recipient part: the member id, else the user id for a membership with no member row. */
export function recipientKeyPart(r: Pick<AlertRecipient, "userId" | "memberId">): string {
  return r.memberId ?? `u:${r.userId ?? "unknown"}`;
}

/**
 * The Resend idempotency key. Account holders keep Phase 3's `alert:<alertId>:<userId>`, so
 * the move to the outbox cannot double-send; contact-only helpers use their member id.
 */
export function resendKeyFor(alertId: string, r: Pick<AlertRecipient, "userId" | "memberId">): string {
  return r.userId ? `alert:${alertId}:${r.userId}` : `alert:${alertId}:m:${r.memberId ?? "unknown"}`;
}
