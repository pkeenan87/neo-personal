/** Synthetic inbound mail for the forward-to-address tests (no real addresses or secrets). */
import type { ReceivedEmail } from "@/lib/server/email/resend";

export const TENANT = "00000000-0000-4000-8000-0000000000cc";
export const OWNER = { userId: "user-owner", name: "Alex", email: "alex@example.test", role: "owner" as const };
export const MEMBER = { userId: "user-member", name: "Sam", email: "sam@example.test", role: "member" as const };

export function rawEmail(opts: { from: string; to: string; subject: string; body: string; headers?: Record<string, string> }): string {
  const extra = Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "Message-ID: <synthetic-1@example.test>",
    "Date: Thu, 24 Sep 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    ...extra,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
    "",
  ].join("\r\n");
}

/** A forwarded phish: the member forwards a lookalike-domain "account locked" mail. */
export function forwardedPhish(to: string, from = OWNER.email): string {
  return rawEmail({
    from: `Alex <${from}>`,
    to,
    subject: "Fwd: Your account is locked",
    body: [
      "---------- Forwarded message ---------",
      "From: PayPal <service@paypa1-security.example>",
      "Subject: Your account is locked",
      "",
      "Verify now: https://paypa1-security.example/login",
    ].join("\r\n"),
    headers: { "Authentication-Results": "mx.example.test; dmarc=pass" },
  });
}

export function meta(id: string, overrides: Partial<ReceivedEmail> = {}): ReceivedEmail {
  return {
    id,
    from: OWNER.email,
    to: [],
    receivedFor: [],
    subject: "Fwd: Your account is locked",
    messageId: "<synthetic-1@example.test>",
    headers: {},
    authentication: {},
    rawUrl: `mock://raw/${id}`,
    ...overrides,
  };
}

export const GMAIL_CONFIRMATION_SUBJECT = "(#482915736) Gmail Forwarding Confirmation - Receive Mail from alex@example.test";
export const GMAIL_CONFIRMATION_BODY = [
  "alex@example.test has requested to automatically forward mail to your email address.",
  "Confirmation code: 482915736",
  "",
  "To allow alex@example.test to automatically forward mail to your address, please click the link below to confirm the request:",
  "",
  "https://mail-settings.google.com/mail/vf-%5BANGjdJ-synthetic%5D-synthetic",
].join("\r\n");
