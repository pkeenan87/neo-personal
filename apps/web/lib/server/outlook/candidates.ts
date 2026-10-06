/**
 * Sender prefilter and message reconstruction for the delta poll (_specs/outlook-connector.md). The `From` header is
 * attacker-controlled: the prefilter only decides which messages are worth fetching; trust comes from the receiver's
 * Authentication-Results, evaluated by step 4 (`assessSigninAlert`).
 */
import { SIGNIN_ALERT_SENDERS } from "@neo/tools";
import type { GraphMessage } from "./types";

const SENDERS = Object.values(SIGNIN_ALERT_SENDERS).flat().map((s) => s.toLowerCase());

/** Exact address match for entries with `@`; domain (or subdomain) match for entries without. */
export function isAlertSenderCandidate(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = a.slice(at + 1);
  return SENDERS.some((s) => (s.includes("@") ? s === a : domain === s || domain.endsWith(`.${s}`)));
}

/** Headers the reconstruction rewrites itself: the Graph body is a single rendered part, not the original MIME tree. */
const REWRITTEN = new Set(["content-type", "content-transfer-encoding", "mime-version", "content-length", "content-disposition", "content-id", "content-description", "content-language"]);
const NAME_RE = /^[\x21-\x39\x3b-\x7e]+$/;

/**
 * An RFC 822 message for `analyzeEmail` from Graph's `internetMessageHeaders` (authentication, Received, From and
 * the rest, in order) plus the rendered body. Header values are flattened to one line.
 */
export function buildRawMessage(msg: GraphMessage): string {
  const lines: string[] = [];
  for (const h of msg.headers) {
    if (!NAME_RE.test(h.name) || REWRITTEN.has(h.name.toLowerCase())) continue;
    lines.push(`${h.name}: ${h.value.replace(/[\r\n]+\s*/g, " ").trim()}`);
  }
  lines.push("MIME-Version: 1.0", `Content-Type: ${msg.bodyType === "text" ? "text/plain" : "text/html"}; charset=utf-8`, "Content-Transfer-Encoding: 8bit");
  return `${lines.join("\r\n")}\r\n\r\n${msg.body}`;
}
