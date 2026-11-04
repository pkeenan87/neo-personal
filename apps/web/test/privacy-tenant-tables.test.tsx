import { render } from "@testing-library/react";
import { tenantTables } from "@neo/db";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/privacy/page";

/**
 * CI guard: the privacy page must say something about every table that holds a household's data.
 *
 * The rule: every key of `tenantTables` (packages/db/src/tenant.ts) is mapped below to the privacy-page
 * section (`id`) that covers it and a phrase that section must contain. A new tenant table fails the
 * first test until someone decides what the page says about it and adds a line here; a reworded page
 * that drops a phrase fails the second. Do not map a table to a section just to make this pass: if the
 * page does not disclose what the table holds, add the words to the page first.
 */
export const PRIVACY_COVERAGE: Record<string, { section: string; phrase: string }> = {
  memberships: { section: "use", phrase: "the household owner sees everyone" },
  conversations: { section: "collect", phrase: "your conversation history" },
  turns: { section: "collect", phrase: "your conversation history" },
  verdicts: { section: "collect", phrase: "Verdicts, the warning signs" },
  digestDeliveries: { section: "use", phrase: "Weekly digests." },
  accountHardeningAnswers: { section: "use", phrase: "Account-hardening checklist." },
  monitoredAddresses: { section: "collect", phrase: "Breach monitoring." },
  breachObservations: { section: "collect", phrase: "selected breach names, dates and data types" },
  artifacts: { section: "retention", phrase: "Raw evidence" },
  auditEvents: { section: "collect", phrase: "audit trail of security-relevant changes" },
  usageEvents: { section: "assistant", phrase: "Spend tracking." },
  inboundAddresses: { section: "collect", phrase: "your household address" },
  inboundMessages: { section: "collect", phrase: "the full original message" },
  householdInvites: { section: "people", phrase: "Invitations." },
  alerts: { section: "retention", phrase: "Alerts" },
  devices: { section: "collect", phrase: "Protected devices." },
  deviceEnrollmentCodes: { section: "collect", phrase: "Protected devices." },
  deviceSignals: { section: "retention", phrase: "Signal records" },
  deviceExpectedTools: { section: "collect", phrase: "mark a tool as expected" },
  signinEvents: { section: "use", phrase: "Sign-in alerts." },
  knownSigninDevices: { section: "use", phrase: "Sign-in alerts." },
  outlookOAuthStates: { section: "use", phrase: "Outlook.com connector." },
  outlookConnectors: { section: "use", phrase: "Outlook.com connector." },
  outlookRuleFindings: { section: "use", phrase: "Outlook.com connector." },
  outlookSeenMessages: { section: "use", phrase: "Outlook.com connector." },
  members: { section: "people", phrase: "people who do not have a Neo account" },
  policies: { section: "protection", phrase: "Settings sent to devices." },
  policyBundles: { section: "protection", phrase: "signed by Neo's key" },
  incidentActions: { section: "protection", phrase: "Actions and notifications." },
  deviceCommands: { section: "protection", phrase: "end a remote-access session" },
  notificationOutbox: { section: "protection", phrase: "wait in a queue" },
  eveSessions: { section: "assistant", phrase: "Neo records who started each chat session" },
  consents: { section: "people", phrase: "Consent records." },
  childRequests: { section: "protection", phrase: "Requests from a child." },
  householdMemory: { section: "assistant", phrase: "Household memory." },
  memberChannels: { section: "assistant", phrase: "Text messages." },
};

const squash = (s: string | null) => (s ?? "").replace(/\s+/g, " ").replace(/’/g, "'");

describe("privacy page covers every tenant table", () => {
  it("maps each table in tenantTables, and nothing else", () => {
    expect(Object.keys(PRIVACY_COVERAGE).sort()).toEqual(Object.keys(tenantTables).sort());
  });

  it("names each table's section and phrase on the rendered page", () => {
    render(<PrivacyPage />);
    for (const [table, { section, phrase }] of Object.entries(PRIVACY_COVERAGE)) {
      const el = document.getElementById(section);
      expect(el, `${table}: no #${section} section`).not.toBeNull();
      expect(squash(el!.textContent), `${table}: #${section} does not say "${phrase}"`).toContain(phrase);
    }
  });
});
