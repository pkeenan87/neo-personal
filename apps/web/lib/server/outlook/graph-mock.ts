/**
 * MOCK_MODE Graph client: a fixture mailbox, no network. The default fixture has one own alias, three inbox rules
 * (internal, external, disabled) and a delta feed that starts with one old newsletter (the 30-day baseline) and then
 * delivers a genuine Google sign-in alert, a spoofed one (same From, failing authentication) and a newsletter.
 */
import type { GraphDeltaPage, GraphMe, GraphMessage, GraphRule, OutlookGraphClient } from "./types";

export const MOCK_ME: GraphMe = { id: "mock-ms-account-1", displayAddress: "mock.user@outlook.com", addresses: ["mock.user@outlook.com"] };

export const MOCK_RULES: GraphRule[] = [
  { id: "mock-rule-internal", enabled: true, forwardTo: [{ address: "Mock.User+news@outlook.com" }], redirectTo: [], forwardAsAttachmentTo: [] },
  { id: "mock-rule-external", enabled: true, forwardTo: [], redirectTo: [{ address: "collector@mail-drop.example" }], forwardAsAttachmentTo: [] },
  { id: "mock-rule-disabled", enabled: false, forwardTo: [{ address: "someone@elsewhere.example" }], redirectTo: [], forwardAsAttachmentTo: [] },
];

const GOOGLE_LINES = [
  "A new sign-in on Windows",
  "Your Google Account mock.user@outlook.com was just signed in to from a new Windows device. You're getting this email to make sure it was you.",
  "Location: Seattle, WA, USA",
  "IP address: 203.0.113.24",
  "Time: January 15, 2026 at 12:00 PM UTC",
  "Check activity",
  "If this wasn't you, secure your account now from the official app or website.",
];

function googleAlert(id: string, auth: "pass" | "fail"): GraphMessage {
  const html = `<html><body>${GOOGLE_LINES.map((l) => `<p>${l}</p>`).join("\n")}\n<p><a href="https://myaccount.google.com/notifications">Check activity</a></p></body></html>`;
  return {
    id,
    headers: [
      { name: "Received", value: "from mail.sender.example.net by mx.example.test with ESMTPS; Thu, 15 Jan 2026 12:00:20 +0000" },
      { name: "Authentication-Results", value: `mx.example.test; dkim=${auth} header.d=accounts.google.com header.s=s1; spf=pass smtp.mailfrom=bounce.example.test; dmarc=${auth} header.from=google.com` },
      { name: "From", value: "Google <no-reply@accounts.google.com>" },
      { name: "To", value: "mock.user@outlook.com" },
      { name: "Subject", value: "Security alert" },
      { name: "Date", value: "Thu, 15 Jan 2026 12:00:30 +0000" },
    ],
    bodyType: "html",
    body: html,
  };
}

export const MOCK_MESSAGES: Record<string, GraphMessage> = {
  "mock-google-genuine": googleAlert("mock-google-genuine", "pass"),
  "mock-google-spoofed": googleAlert("mock-google-spoofed", "fail"),
};

const NEWSLETTER = "news@store.example";
const GOOGLE = "no-reply@accounts.google.com";

/** Initial window -> `mock-delta:1` (new mail) -> `mock-delta:2` (nothing new). */
export function mockDeltaPage(link: string | undefined): GraphDeltaPage {
  if (!link) return { messages: [{ id: "mock-old-newsletter", fromAddress: NEWSLETTER }], deltaLink: "mock-delta:1" };
  if (link === "mock-delta:1") {
    return {
      messages: [
        { id: "mock-google-genuine", fromAddress: GOOGLE },
        { id: "mock-google-spoofed", fromAddress: GOOGLE },
        { id: "mock-new-newsletter", fromAddress: NEWSLETTER },
      ],
      deltaLink: "mock-delta:2",
    };
  }
  return { messages: [], deltaLink: "mock-delta:2" };
}

export function createMockGraphClient(): OutlookGraphClient {
  return {
    async getMe() {
      return { ...MOCK_ME, addresses: [...MOCK_ME.addresses] };
    },
    async listInboxRules() {
      return { rules: MOCK_RULES.map((r) => ({ ...r })) };
    },
    async getInboxDelta({ nextLink, deltaLink }) {
      return mockDeltaPage(nextLink ?? deltaLink);
    },
    async getCandidateMessage(id) {
      const m = MOCK_MESSAGES[id];
      if (!m) throw new Error("mock message not found");
      return { ...m, headers: m.headers.map((h) => ({ ...h })) };
    },
  };
}
