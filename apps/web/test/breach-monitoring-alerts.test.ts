import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertBreachDetected } from "@/lib/server/alerts";
import { breachDetectedAlertText } from "@/lib/server/alerts/templates";
import { memoryAlertRows, resetMemoryAlerts } from "@/lib/server/memory-alerts";
import { memorySentEmails } from "@/lib/server/email/resend";
import { setMemoryMembers } from "@/lib/server/memory-state";
import { resetMemoryState, stubBaseEnv } from "./helpers/routes";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const ADDRESS_ID = "33333333-3333-4333-8333-333333333333";
const EMAIL = "private.member@example.com";
const NOW = new Date("2026-10-05T12:00:00.000Z");

beforeEach(() => {
  stubBaseEnv(vi);
  vi.stubEnv("AUTH_URL", "https://neo.example.test");
  resetMemoryState();
  resetMemoryAlerts();
  memorySentEmails().length = 0;
  setMemoryMembers(TENANT, [
    { userId: "owner", role: "owner", name: "Owner", email: "owner@example.test" },
    { userId: MEMBER, role: "member", name: "Member", email: EMAIL },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

describe("breach alerts", () => {
  it("uses high severity for passwords and static safe guidance", () => {
    const text = breachDetectedAlertText("Example Breach", ["Usernames", "Passwords"]);
    expect(text.severity).toBe("high");
    expect(text.title).toContain("Example Breach");
    expect(text.body).toContain("Change your password");
    expect(text.body).not.toContain(EMAIL);
  });

  it("creates one member-feed alert, dedupes it, and emails only the owner", async () => {
    const input = { tenantId: TENANT, userId: MEMBER, addressId: ADDRESS_ID, breachName: "Example Breach", dataClasses: ["Passwords"], now: NOW };
    await alertBreachDetected(input);
    await alertBreachDetected(input);
    expect(memoryAlertRows()).toHaveLength(1);
    const alert = memoryAlertRows()[0]!;
    expect(alert).toMatchObject({ kind: "breach_detected", severity: "high", subjectUserId: MEMBER, emailStatus: "sent" });
    expect(alert.title).toContain("Example Breach");
    expect(alert.title + alert.body).not.toContain(EMAIL);
    expect(alert.title + alert.body).not.toContain(ADDRESS_ID);
    expect(memorySentEmails()).toHaveLength(1);
    expect(memorySentEmails()[0]).toMatchObject({ to: "owner@example.test" });
    expect(memorySentEmails()[0]!.text).not.toContain(EMAIL);
    expect(memorySentEmails()[0]!.text).not.toContain(ADDRESS_ID);
    expect(memorySentEmails()[0]!.text).toContain("https://neo.example.test/settings/breaches");
  });

  it("cleans untrusted provider breach names before putting them in alert text", () => {
    const text = breachDetectedAlertText("<img src=x onerror=alert(1)>", []);
    expect(text.title).not.toContain("<img");
    expect(text.title).not.toContain("onerror");
    expect(text.severity).toBe("medium");
    const emailText = breachDetectedAlertText("alice@example", []);
    expect(emailText.title).toContain("[redacted address]");
    expect(emailText.title + emailText.body).not.toContain("alice@example");
  });
});
