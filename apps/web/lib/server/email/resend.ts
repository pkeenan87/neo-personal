/**
 * Thin Resend REST client (no SDK): sending notifications and reading
 * received (inbound) mail. Verified against https://resend.com/docs (2026-09):
 *
 *  - `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and an
 *    `Idempotency-Key` header (≤ 256 chars, kept 24 h) → `{ id }`.
 *  - `GET https://api.resend.com/emails/receiving/{email_id}` → the received email:
 *    `from`, `to[]`, `subject`, `message_id`, `headers` (lowercase map),
 *    `received_for[]`, `authentication { spf, dkim, dmarc }`, and
 *    `raw { download_url, expires_at }` (a signed URL, ~1 h) for the full MIME source.
 *    The `email.received` webhook itself carries only metadata (no body or headers).
 *
 * In MOCK_MODE both halves are replaced by in-memory fakes: sends are recorded
 * (`memorySentEmails()`) and received mail comes from `registerMockReceivedEmail`.
 */
import { logger } from "@neo/core";
import { env, inboundEnv } from "@/lib/env";

const API = "https://api.resend.com";

// ------------------------------------------------------------------ send ---

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export interface SentEmail extends OutgoingEmail {
  from: string;
  id: string;
  sentAt: Date;
}

const g = globalThis as typeof globalThis & {
  __neoMemorySentEmails?: SentEmail[];
  __neoMockReceived?: Map<string, { meta: ReceivedEmail; raw: Uint8Array }>;
};

/** Emails "sent" by the MOCK_MODE mailer (bounded). */
export function memorySentEmails(): SentEmail[] {
  g.__neoMemorySentEmails ??= [];
  return g.__neoMemorySentEmails;
}

export function createMockMailer(from: string): Mailer {
  return {
    async send(email) {
      const log = memorySentEmails();
      // Same idempotency semantics as Resend: a repeated key does not send twice.
      const existing = log.find((e) => e.idempotencyKey === email.idempotencyKey);
      if (existing) return { id: existing.id };
      const sent: SentEmail = { ...email, from, id: `mock_${crypto.randomUUID()}`, sentAt: new Date() };
      log.push(sent);
      if (log.length > 500) log.splice(0, log.length - 500);
      return { id: sent.id };
    },
  };
}

export function createResendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(email) {
      const res = await fetchImpl(`${API}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, html: email.html, text: email.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend send failed: HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { id: typeof body.id === "string" ? body.id : "" };
    },
  };
}

/** MOCK_MODE → recording fake; otherwise Resend when a key is set; else null (notifications skipped, logged). */
export function getMailer(): Mailer | null {
  const ie = inboundEnv();
  if (env().MOCK_MODE) return createMockMailer(ie.EMAIL_FROM);
  if (!ie.RESEND_API_KEY) {
    logger.warn("No Resend API key: inbound notifications are not sent", "inbound");
    return null;
  }
  return createResendMailer(ie.RESEND_API_KEY, ie.EMAIL_FROM);
}

// --------------------------------------------------------------- receive ---

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  receivedFor: string[];
  subject: string;
  messageId: string | null;
  /** Lowercased header names → value (first value when repeated). */
  headers: Record<string, string>;
  authentication: { spf?: string; dkim?: string; dmarc?: string };
  rawUrl: string | null;
}

export class TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`raw message exceeds ${limit} bytes`);
  }
}

export interface ReceivedMailClient {
  getReceived(emailId: string): Promise<ReceivedEmail>;
  /** Download the MIME source; throws TooLargeError past `maxBytes`. */
  downloadRaw(email: ReceivedEmail, maxBytes: number): Promise<Uint8Array>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Normalize Resend's `GET /emails/receiving/{id}` response. */
export function parseReceivedEmail(body: unknown): ReceivedEmail {
  const b = (body ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (b.headers && typeof b.headers === "object") {
    for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) {
      const value = Array.isArray(v) ? str(v[0]) : str(v);
      if (value) headers[k.toLowerCase()] = value;
    }
  }
  const auth = (b.authentication ?? {}) as Record<string, unknown>;
  const raw = (b.raw ?? {}) as Record<string, unknown>;
  return {
    id: str(b.id),
    from: str(b.from),
    to: strList(b.to),
    receivedFor: strList(b.received_for),
    subject: str(b.subject),
    messageId: str(b.message_id) || null,
    headers,
    authentication: {
      ...(str(auth.spf) ? { spf: str(auth.spf) } : {}),
      ...(str(auth.dkim) ? { dkim: str(auth.dkim) } : {}),
      ...(str(auth.dmarc) ? { dmarc: str(auth.dmarc) } : {}),
    },
    rawUrl: str(raw.download_url) || null,
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLargeError(maxBytes);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function createResendReceivedMailClient(apiKey: string, fetchImpl: typeof fetch = fetch): ReceivedMailClient {
  return {
    async getReceived(emailId) {
      const res = await fetchImpl(`${API}/emails/receiving/${encodeURIComponent(emailId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend receiving lookup failed: HTTP ${res.status}`);
      return parseReceivedEmail(await res.json());
    },
    async downloadRaw(email, maxBytes) {
      if (!email.rawUrl) throw new Error("Resend returned no raw download URL");
      const url = new URL(email.rawUrl);
      if (url.protocol !== "https:") throw new Error("raw download URL is not https");
      // Signed URL: no Authorization header (never leak the API key to the storage host).
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`raw download failed: HTTP ${res.status}`);
      return readCapped(res, maxBytes);
    },
  };
}

/** MOCK_MODE: register a received email the mock client will return. */
export function registerMockReceivedEmail(meta: Omit<ReceivedEmail, "rawUrl"> & { rawUrl?: string | null }, raw: string | Uint8Array): void {
  g.__neoMockReceived ??= new Map();
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  g.__neoMockReceived.set(meta.id, { meta: { ...meta, rawUrl: meta.rawUrl ?? `mock://raw/${meta.id}` }, raw: bytes });
}

export function resetMockReceivedEmails(): void {
  g.__neoMockReceived = new Map();
}

export function createMockReceivedMailClient(): ReceivedMailClient {
  return {
    async getReceived(emailId) {
      const hit = g.__neoMockReceived?.get(emailId);
      if (!hit) throw new Error("mock received email not found");
      return hit.meta;
    },
    async downloadRaw(email, maxBytes) {
      const hit = g.__neoMockReceived?.get(email.id);
      if (!hit) throw new Error("mock raw not found");
      if (hit.raw.byteLength > maxBytes) throw new TooLargeError(maxBytes);
      return hit.raw.slice();
    },
  };
}

/** MOCK_MODE → fake; otherwise Resend (throws at use when no key: the job retries then fails). */
export function getReceivedMailClient(): ReceivedMailClient {
  if (env().MOCK_MODE) return createMockReceivedMailClient();
  const key = inboundEnv().RESEND_API_KEY;
  if (!key) {
    return {
      getReceived: async () => {
        throw new Error("RESEND_API_KEY / AUTH_RESEND_KEY is not set");
      },
      downloadRaw: async () => {
        throw new Error("RESEND_API_KEY / AUTH_RESEND_KEY is not set");
      },
    };
  }
  return createResendReceivedMailClient(key);
}
