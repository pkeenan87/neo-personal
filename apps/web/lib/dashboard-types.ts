/**
 * Wire types for the dashboard APIs (_specs/dashboard.md): GET /api/verdicts,
 * /api/verdicts/summary, /api/verdicts/[id], /api/household. Dates are ISO-8601.
 * Shared by the route handlers and the browser widgets.
 */
import type { SubjectType, Verdict, VerdictLabel } from "@neo/verdict";

export type VerdictSourceName = "chat" | "inbound" | "api";
export type SinceDays = 7 | 30 | 90;
export const SINCE_DAYS: readonly SinceDays[] = [7, 30, 90];
export const VERDICT_SOURCES: readonly VerdictSourceName[] = ["chat", "inbound", "api"];

/** GET /api/verdicts item. */
export interface VerdictListItem {
  id: string;
  subjectType: SubjectType;
  verdict: VerdictLabel;
  confidence: number;
  headline: string;
  source: VerdictSourceName;
  createdAt: string;
  userId: string;
  conversationId: string | null;
  artifactId: string | null;
}

export interface VerdictListResponse {
  items: VerdictListItem[];
  /** Opaque keyset cursor for the next page; null on the last page. */
  nextCursor: string | null;
}

/** GET /api/verdicts/summary */
export interface VerdictSummaryResponse {
  sinceDays: SinceDays;
  total: number;
  byLabel: Record<VerdictLabel, number>;
  bySubjectType: Record<SubjectType, number>;
  topIndicators: { category: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  perDay: { day: string; malicious: number; suspicious: number; likely_safe: number; insufficient_evidence: number }[];
}

/** GET /api/verdicts/[id] */
export interface VerdictDetailResponse extends VerdictListItem {
  body: Verdict;
  conversation: { id: string; title: string | null } | null;
  artifact: {
    id: string;
    kind: string;
    filename: string | null;
    mimeType: string;
    sizeBytes: number;
    expiresAt: string | null;
    expired: boolean;
  } | null;
  inbound: { status: string; receivedAt: string; forwardedBy: string | null } | null;
  /** Display name of the member the verdict belongs to (null when unknown). */
  memberName: string | null;
}

/** GET /api/household */
export interface HouseholdResponse {
  tenantId: string;
  name: string;
  role: "owner" | "member";
  /** Owners see emails; members get `email: null`. */
  members: { userId: string; name: string | null; email: string | null; role: "owner" | "member" }[];
}

/** GET /api/usage (Phase 0). */
export interface UsageResponse {
  monthlyChecks: { used: number; limit: number; resetAt: string };
  dailyTokens: { used: number; limit: number; resetAt: string };
}
