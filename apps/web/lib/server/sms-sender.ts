/**
 * Outbound SMS (_specs/v2-m3-cutover.md section 5). `SmsSender` is the only way Neo texts a number, and
 * its only implementation tonight is the mock below: it logs and returns. There is no Twilio client in
 * this codebase yet (no account, no A2P registration), so nothing here can reach the network; a real
 * sender arrives with A2P as a second implementation behind `getSmsSender()`.
 *
 * Imports nothing from Next, so the eve server can bundle it. Logs carry a hash of the number, never the number.
 */
import { hashPii, logger } from "@neo/core";
import { isDeployedEnvironment } from "@/lib/env";

export interface SmsMessage {
  /** E.164 destination. */
  to: string;
  body: string;
  /** What the text is for; logged, never the body. */
  purpose: "verification_code" | "reply" | "notification";
}

export interface SmsSender {
  send(message: SmsMessage): Promise<{ id: string }>;
}

export interface MockSentSms extends SmsMessage {
  id: string;
}

const g = globalThis as typeof globalThis & { __neoMockSms?: MockSentSms[] };

/** Everything the mock "sent" (bounded; tests and MOCK_MODE inspection). */
export function mockSentSms(): MockSentSms[] {
  g.__neoMockSms ??= [];
  return g.__neoMockSms;
}

export function resetMockSentSms(): void {
  g.__neoMockSms = [];
}

/**
 * Logs instead of sending. The verification code is spelled out in the log line only outside a
 * deployed environment (the magic-link precedent), so a developer can finish the flow locally.
 */
export const mockSmsSender: SmsSender = {
  async send(message) {
    const id = `SMmock${crypto.randomUUID().replaceAll("-", "")}`;
    const sent = mockSentSms();
    sent.push({ ...message, id });
    if (sent.length > 200) sent.splice(0, sent.length - 200);
    const detail = message.purpose === "verification_code" && !isDeployedEnvironment() ? ` Body: ${message.body}` : "";
    logger.info(`[mock sms] ${message.purpose} not sent (no Twilio client).${detail}`, "sms", { userIdHash: hashPii(message.to) });
    return { id };
  },
};

/** The sender in use: always the mock until A2P registration. */
export function getSmsSender(): SmsSender {
  return mockSmsSender;
}

/** A `fetch` for eve's Twilio channel that answers like the Twilio Messages API and never touches the network. */
export const mockTwilioFetch: typeof fetch = async (input, init) => {
  // Only message sends are answered; a media download (GET) finds nothing.
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return new Response("not found", { status: 404 });
  const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  const to = body.get("To") ?? "";
  const { id } = await mockSmsSender.send({ to, body: body.get("Body") ?? "", purpose: "reply" });
  void input;
  return new Response(JSON.stringify({ sid: id, status: "queued" }), { status: 201, headers: { "content-type": "application/json" } });
};
