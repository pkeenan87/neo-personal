// @vitest-environment node
import { expect, it } from "vitest";
import { selectDigestContent, type DigestFacts } from "@/lib/server/weekly-digest/content";
const at = new Date("2026-10-04T12:00:00Z");
const periodStart = new Date("2026-09-28T14:00:00Z");
const periodEnd = new Date("2026-10-05T14:00:00Z");
const input = { tenantId: "a", userId: "owner", role: "owner" as const, periodStart, periodEnd };
it("summarizes only personal verdicts and eligible owner aggregates without names, URLs or bodies", () => {
  const facts: DigestFacts = {
    members: [{ userId: "owner", role: "owner" }, { userId: "member", role: "member" }],
    verdicts: [
      { id: "1", userId: "owner", label: "suspicious", headline: "Check https://evil.test and me@example.test <script>", createdAt: at },
      { id: "2", userId: "member", label: "malicious", headline: "PRIVATE MEMBER", createdAt: at },
      { id: "3", userId: "owner", label: "malicious", headline: "Risky check", createdAt: at },
      { id: "4", userId: "owner", label: "likely_safe", headline: "Old", createdAt: periodEnd },
    ],
    alerts: ["member_joined", "device_enrolled", "device_offline", "device_removed", "remote_access"].map((kind, i) => ({ id: String(i), subjectUserId: "member", kind, severity: "high", createdAt: at })),
    devices: [{ userId: "member", lastSeenAt: periodStart, createdAt: periodStart, revokedAt: null }, { userId: "owner", lastSeenAt: periodStart, createdAt: periodStart, revokedAt: null }],
  };
  const owner = selectDigestContent(input, facts);
  expect(owner.personal?.verdictCounts).toEqual([{ label: "malicious", count: 1 }, { label: "suspicious", count: 1 }, { label: "likely_safe", count: 0 }, { label: "insufficient_evidence", count: 0 }]);
  expect(owner.personal?.topVerdicts.map(v => v.id)).toEqual(["3", "1"]);
  expect(owner.household?.alertCounts).toEqual([{ severity: "high", count: 2 }]);
  expect(owner.household?.devices).toEqual({ offline: 1, removedOrUninstalled: 1 });
  expect(JSON.stringify(owner)).not.toMatch(/evil\.test|me@example|PRIVATE MEMBER/);
  const member = selectDigestContent({ ...input, userId: "member", role: "member" }, facts);
  expect(member.household).toBeUndefined();
  expect(member.personal?.topVerdicts.map(v => v.id)).toEqual(["2"]);
  expect(selectDigestContent(input, { ...facts, verdicts: [], alerts: facts.alerts.slice(0, 2), devices: [] })).toEqual({});
  expect(selectDigestContent({ ...input, userId: "gone" }, facts)).toEqual({});
});
