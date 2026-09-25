/**
 * Who forwarded this message, and is it Gmail's forwarding-confirmation mail?
 * Everything here reads attacker-controllable headers, so it only ever
 * *selects among the household's verified member emails* (the notification
 * goes to the member's stored address, never to a header value).
 */
import type { ReceivedEmail } from "@/lib/server/email/resend";

// Domain labels exclude "." so the pattern cannot backtrack polynomially on attacker input.
const ADDRESS_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:.]+(?:\.[^\s@<>()",;:.]+)+$/;
const MAX_ADDRESS_CHARS = 320;

/** "Name <a@b.c>" | "<a@b.c>" | "a@b.c" → "a@b.c" (lowercased), else undefined. */
export function extractAddress(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const angle = /<([^<>]+)>/.exec(value);
  const candidate = (angle?.[1] ?? value).trim().toLowerCase();
  return candidate.length <= MAX_ADDRESS_CHARS && ADDRESS_RE.test(candidate) ? candidate : undefined;
}

/** Split a recipient list header ("a@x, B <b@y>") into addresses. */
export function extractAddresses(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const part of v.split(",")) {
      const a = extractAddress(part);
      if (a) out.push(a);
    }
  }
  return out;
}

/**
 * Gmail filter forwards keep the original `From` and set
 * `Return-Path: <user+caf_=<forward-to, @ as =>@gmail.com>`; recover `user@gmail.com`.
 * Only this Gmail-specific `+caf_=` suffix is removed (no general plus-address stripping).
 */
export function gmailReturnPathOwner(returnPath: string | undefined): string | undefined {
  const a = extractAddress(returnPath);
  if (!a) return undefined;
  const m = /^([^+@]+)\+caf_=[^@]*@(gmail\.com|googlemail\.com)$/.exec(a);
  return m ? `${m[1]}@${m[2]}` : a;
}

/**
 * Candidate forwarder addresses, most specific first:
 *  1. `Resent-From` (explicit redirect/bounce);
 *  2. the sender (`from`): a manual "Forward" or "forward as attachment" — skipped
 *     when Resend reports DMARC fail for it (spoofed member address);
 *  3. Gmail's `X-Forwarded-For: <user> <neo address>` (filter auto-forward);
 *  4. `Return-Path` (envelope sender; Gmail `+caf_=` form unwrapped).
 */
export function forwarderCandidates(meta: Pick<ReceivedEmail, "from" | "headers" | "authentication">): string[] {
  const out: string[] = [];
  const push = (a: string | undefined) => {
    if (a && !out.includes(a)) out.push(a);
  };
  push(extractAddress(meta.headers["resent-from"]));
  if (meta.authentication.dmarc?.toLowerCase() !== "fail") push(extractAddress(meta.from || meta.headers.from));
  push(extractAddress(meta.headers["x-forwarded-for"]?.trim().split(/\s+/)[0]));
  push(gmailReturnPathOwner(meta.headers["return-path"]));
  return out;
}

/** The member whose verified email matches a candidate (case-insensitive, exact). */
export function matchForwarder<M extends { userId: string; email: string | null }>(
  candidates: readonly string[],
  members: readonly M[],
): M | undefined {
  for (const c of candidates) {
    const m = members.find((x) => x.email && x.email.trim().toLowerCase() === c);
    if (m) return m;
  }
  return undefined;
}

/** Top-level MIME headers of a raw message → lowercase name → first value (unfolded). */
export function parseRawHeaders(raw: string): Record<string, string> {
  const end = raw.search(/\r?\n\r?\n/);
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!(name in out)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

// ------------------------------------------------ Gmail forwarding confirmation

export const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";
/** Stored in `inbound_messages.error` as `gmail_confirmation:<digits>`. */
export const GMAIL_CONFIRMATION_PREFIX = "gmail_confirmation:";

export interface GmailConfirmation {
  code: string;
  /** Extracted for completeness; never visited and never shown (real phish imitate this mail). */
  link?: string;
  requester?: string;
}

function decodeQuotedPrintableLoose(s: string): string {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** True when the mail claims to be Gmail's confirmation AND Resend did not see it fail authentication. */
export function isGmailForwardingConfirmation(meta: Pick<ReceivedEmail, "from" | "authentication">): boolean {
  if (extractAddress(meta.from) !== GMAIL_FORWARDING_SENDER) return false;
  const { dkim, dmarc } = meta.authentication;
  // Resend reports authentication for received mail; when present it must pass.
  if (dmarc !== undefined && dmarc.toLowerCase() !== "pass") return false;
  if (dmarc === undefined && dkim !== undefined && dkim.toLowerCase() !== "pass") return false;
  return true;
}

/**
 * Pull the confirmation code (and link) out of Gmail's mail. Subject looks like
 * "(#123456789) Gmail Forwarding Confirmation - Receive Mail from user@gmail.com";
 * the body repeats "Confirmation code: 123456789" and a mail-settings.google.com link.
 */
export function parseGmailConfirmation(subject: string, raw: string): GmailConfirmation | undefined {
  const text = decodeQuotedPrintableLoose(raw);
  const code = /\(#(\d{6,12})\)/.exec(subject)?.[1] ?? /confirmation code:\s*(\d{6,12})/i.exec(text)?.[1];
  if (!code) return undefined;
  const link = /https:\/\/mail(?:-settings)?\.google\.com\/[^\s"'<>]+/i.exec(text)?.[0];
  const requester = extractAddress(/receive mail from\s+(\S+@\S+)/i.exec(subject)?.[1]?.replace(/[.,;]+$/, ""));
  return { code, ...(link ? { link } : {}), ...(requester ? { requester } : {}) };
}

/** Read back a stored confirmation code (digits only, so safe to display). */
export function storedGmailCode(error: string | null | undefined): string | undefined {
  if (!error?.startsWith(GMAIL_CONFIRMATION_PREFIX)) return undefined;
  const code = error.slice(GMAIL_CONFIRMATION_PREFIX.length);
  return /^\d{6,12}$/.test(code) ? code : undefined;
}
