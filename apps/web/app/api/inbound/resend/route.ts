/**
 * POST /api/inbound/resend — Resend `email.received` webhook
 * (_specs/forward-to-address.md). Unauthenticated; trust comes from the Svix
 * signature (`svix-id`, `svix-timestamp`, `svix-signature`, secret
 * RESEND_WEBHOOK_SECRET).
 *
 *  401 bad/missing signature · 503 secret unset (except the local MOCK_MODE
 *  bypass: header `x-neo-mock-inbound: 1` on localhost, never on a deployment) ·
 *  413 oversized body · 400 unparseable body after a valid signature.
 *  200 `{ ignored: true }` for other event types and unknown/inactive recipients
 *  (never 4xx, so Resend does not retry and senders learn nothing),
 *  200 `{ duplicate: true }` for a repeated `email_id`,
 *  200 `{ accepted: true }` otherwise (rate-limited messages are recorded as `rejected`).
 *
 * Accepted messages get an `inbound_messages` row and `neo/email.received`
 * (`{ inboundMessageId, tenantId, emailId }`); MOCK_MODE without
 * INNGEST_EVENT_KEY runs the job inline (awaited).
 */
import { hashPii, logger } from "@neo/core";
import { Webhook } from "svix";
import { inngest } from "@/inngest/client";
import { env, inboundEnv, isDeployedEnvironment } from "@/lib/env";
import { registerMockReceivedEmail } from "@/lib/server/email/resend";
import { jsonError } from "@/lib/server/http";
import { createEmailJobDeps } from "@/lib/server/inbound/deps";
import { EMAIL_RECEIVED_EVENT, runEmailReceivedInline, type EmailReceivedData } from "@/lib/server/inbound/email-received-job";
import { isInboundLocalPart } from "@/lib/server/inbound/local-part";
import { inboundRepo, isUniqueViolation } from "@/lib/server/inbound/repo";
import { extractAddress, extractAddresses, parseRawHeaders } from "@/lib/server/inbound/senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const HOUR_MS = 60 * 60 * 1000;
export const MOCK_INBOUND_HEADER = "x-neo-mock-inbound";

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isLocalRequest(req: Request): boolean {
  const host = new URL(req.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

interface ReceivedEvent {
  type: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    cc: string[];
    received_for: string[];
    subject: string;
    message_id: string | null;
    /** MOCK_MODE only: the raw message for the mock Resend client. */
    raw?: string;
  };
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseEvent(text: string): ReceivedEvent | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const d = (typeof o.data === "object" && o.data !== null ? o.data : {}) as Record<string, unknown>;
  return {
    type: typeof o.type === "string" ? o.type : "",
    data: {
      email_id: typeof d.email_id === "string" ? d.email_id : "",
      from: typeof d.from === "string" ? d.from : "",
      to: strings(d.to),
      cc: strings(d.cc),
      received_for: strings(d.received_for),
      subject: typeof d.subject === "string" ? d.subject : "",
      message_id: typeof d.message_id === "string" ? d.message_id : null,
      ...(typeof d.raw === "string" ? { raw: d.raw } : {}),
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  const e = env();
  const ie = inboundEnv();

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return jsonError(413, "Payload too large.", "too_large");
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return jsonError(413, "Payload too large.", "too_large");

  // --- authenticity -------------------------------------------------------
  if (ie.RESEND_WEBHOOK_SECRET) {
    try {
      new Webhook(ie.RESEND_WEBHOOK_SECRET).verify(body, {
        "svix-id": req.headers.get("svix-id") ?? "",
        "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
        "svix-signature": req.headers.get("svix-signature") ?? "",
      });
    } catch {
      return jsonError(401, "Invalid signature.", "invalid_signature");
    }
  } else {
    const mockBypass =
      e.MOCK_MODE && !isDeployedEnvironment() && req.headers.get(MOCK_INBOUND_HEADER) === "1" && isLocalRequest(req);
    if (!mockBypass) return jsonError(503, "Inbound email is not configured.", "inbound_unconfigured");
  }

  const event = parseEvent(body);
  if (!event) return jsonError(400, "Invalid payload.", "bad_request");
  if (event.type !== "email.received") return json({ ignored: true });
  const { data } = event;
  if (!data.email_id || data.email_id.length > 200) return json({ ignored: true });

  // --- recipient → household ------------------------------------------------
  const repo = inboundRepo();
  let address: { id: string; tenantId: string } | undefined;
  try {
    // received_for is the envelope recipient (auto-forwards keep the original To:).
    for (const rcpt of extractAddresses([...data.received_for, ...data.to, ...data.cc])) {
      const at = rcpt.lastIndexOf("@");
      const localPart = rcpt.slice(0, at);
      const domain = rcpt.slice(at + 1);
      if (ie.NEO_INBOUND_DOMAIN && domain !== ie.NEO_INBOUND_DOMAIN) continue;
      if (!isInboundLocalPart(localPart)) continue;
      address = await repo.findActiveByLocalPart(localPart);
      if (address) break;
    }
  } catch (err) {
    logger.error("Inbound recipient lookup failed", "api.inbound", { errorMessage: errText(err) });
    return jsonError(503, "Temporarily unavailable.", "storage_unavailable"); // Resend retries
  }
  if (!address) return json({ ignored: true });
  const { tenantId } = address;

  // --- rate limit + idempotency -----------------------------------------------
  const fromAddressHash = hashPii(extractAddress(data.from) ?? data.from.toLowerCase());
  let messageId: string;
  try {
    const recent = await repo.countRecent(address.id, HOUR_MS);
    const limited = recent >= ie.NEO_INBOUND_RATE_LIMIT_PER_HOUR;
    const row = await repo.recordMessage({
      tenantId,
      addressId: address.id,
      providerMessageId: data.email_id,
      fromAddressHash,
      status: limited ? "rejected" : "received",
    });
    messageId = row.id;
    if (limited) {
      await repo.updateMessage(row.id, tenantId, { error: "rate_limited", completedAt: new Date() });
      logger.warn("Inbound address rate limited", "api.inbound", { tenantId });
      return json({ accepted: true });
    }
  } catch (err) {
    if (isUniqueViolation(err)) return json({ duplicate: true });
    logger.error("Inbound message insert failed", "api.inbound", { tenantId, errorMessage: errText(err) });
    return jsonError(503, "Temporarily unavailable.", "storage_unavailable");
  }

  // --- hand off to the job -----------------------------------------------------
  const jobData: EmailReceivedData = { inboundMessageId: messageId, tenantId, emailId: data.email_id };
  if (e.MOCK_MODE && data.raw !== undefined) {
    registerMockReceivedEmail(
      {
        id: data.email_id,
        from: data.from,
        to: data.to,
        receivedFor: data.received_for,
        subject: data.subject,
        messageId: data.message_id,
        headers: parseRawHeaders(data.raw),
        authentication: {},
      },
      data.raw,
    );
  }
  if (e.MOCK_MODE && !ie.INNGEST_EVENT_KEY) {
    await runEmailReceivedInline(jobData, createEmailJobDeps());
    return json({ accepted: true });
  }
  try {
    await inngest.send({ name: EMAIL_RECEIVED_EVENT, data: jobData });
  } catch (err) {
    logger.error("Inngest send failed", "api.inbound", { tenantId, errorMessage: errText(err) });
    await repo.updateMessage(messageId, tenantId, { status: "failed", error: "queue_unavailable", completedAt: new Date() }).catch(() => {});
  }
  return json({ accepted: true });
}
