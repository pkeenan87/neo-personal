// @vitest-environment node
import { expect, it } from "vitest";
import { renderWeeklyDigest } from "@/lib/server/email/weekly-digest-email";
import type { DigestContent } from "@/lib/server/weekly-digest/content";
import { WEEKLY_DIGEST_TEST_UNSUBSCRIBE_URL } from "./fixtures/weekly-digest";
it("renders escaped owner/member summaries with only dashboard links and optional slots omitted", () => {
  const personal: DigestContent = { personal: { verdictCounts: [{ label: "malicious", count: 1 }], topVerdicts: [{ id: "abc", label: "malicious", headline: '<img src=x> https://evil.test me@example.test', createdAt: "2026-10-04T12:00:00Z", href: "/verdicts/abc" }] } };
  const unsubscribe = WEEKLY_DIGEST_TEST_UNSUBSCRIBE_URL;
  const member = renderWeeklyDigest(personal, unsubscribe);
  expect(member.subject).toBe("Your weekly Neo security digest");
  expect(member.html).toContain("&lt;img src=x&gt;");
  expect(member.html).not.toMatch(/<img|evil\.test|me@example|Breach|Hardening/);
  expect(member).toMatchSnapshot("member");
  const owner = renderWeeklyDigest({ ...personal, household: { alertCounts: [{ severity: "high", count: 1 }], topAlerts: [{ label: "Remote access alert", severity: "high", createdAt: "2026-10-04T12:00:00Z", href: "/settings/household" }], devices: { offline: 2, removedOrUninstalled: 1 } } }, unsubscribe);
  expect(owner).toMatchSnapshot("owner");
  expect(() => renderWeeklyDigest(personal, "http://neo.example.test/unsubscribe")).toThrow();
  expect(renderWeeklyDigest({ personal: { ...personal.personal!, topVerdicts: [{ ...personal.personal!.topVerdicts[0]!, href: "https://evil.test" }] } }, unsubscribe).html).not.toContain('href="https://evil.test');
});
