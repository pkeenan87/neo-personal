import { createHash } from "node:crypto";
import PostalMime, { addressParser, type Address } from "postal-mime";
import { analyzeHtml } from "./html.js";
import type { MagicType, ParsedAddress, ParsedAttachment, ParsedEmail } from "./types.js";
import { stripInvisible } from "../text.js";

export const MAX_EMAIL_BYTES = 4 * 1024 * 1024;
export const MAX_HTML_CHARS = 512 * 1024;
const MAX_TEXT_CHARS = 512 * 1024;
const MAX_HEADERS = 300;
const MAX_HEADER_VALUE = 8192;
const MAX_ATTACHMENTS = 100;
/** Wrappers are unwrapped at depth 0 and 1 only: a forward of a forward is followed once, then we stop. */
const MAX_WRAPPER_DEPTH = 2;

export class EmailParseError extends Error {
  constructor(
    readonly code: "unsupported_format" | "parse_failed",
    message: string,
  ) {
    super(message);
    this.name = "EmailParseError";
  }
}

export function toBytes(raw: string | Uint8Array): Uint8Array {
  return typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, k) => b[offset + k] === v);

/** OLE compound file (Outlook .msg, legacy Office). */
export function isOle(b: Uint8Array): boolean {
  return startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

/** Classify content by its first bytes. Never interprets the content beyond that. */
export function detectMagic(b: Uint8Array): MagicType {
  if (!b.length) return "unknown";
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  if (isOle(b)) return "ole";
  if (startsWith(b, [0x4d, 0x5a])) return "pe";
  if (startsWith(b, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return "lnk";
  for (const off of [0x8001, 0x8801, 0x9001]) if (startsWith(b, [0x43, 0x44, 0x30, 0x30, 0x31], off)) return "iso";
  if (
    startsWith(b, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(b, [0xff, 0xd8, 0xff]) ||
    startsWith(b, [0x47, 0x49, 0x46, 0x38]) ||
    (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8))
  ) {
    return "image";
  }
  if (startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(b, [0x1f, 0x8b])) {
    return "archive";
  }
  const head = Buffer.from(b.subarray(0, 1024)).toString("latin1").replace(/^\uFEFF|^\u00EF\u00BB\u00BF/, "").trimStart().toLowerCase();
  if (head.startsWith("%pdf") || head.slice(0, 1024).includes("%pdf-")) return "pdf";
  if (head.startsWith("#!") || head.startsWith("@echo off") || /^(on error resume next|set \w+ ?= ?createobject|wscript\.|powershell|\$\w+ ?= ?new-object)/.test(head)) {
    return "script";
  }
  if (/^<(!doctype html|html|head|body|script|iframe|meta|form|svg|a\s)/.test(head) || (head.startsWith("<?xml") && /<(svg|html)\b/.test(head))) return "html";
  return "unknown";
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function flattenAddresses(list: Address[] | undefined): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  for (const a of list ?? []) {
    if (a.group) for (const m of a.group) out.push(addr(m.name, m.address));
    else out.push(addr(a.name, a.address));
  }
  return out;
}

function addr(name: string | undefined, address: string | undefined): ParsedAddress {
  const out: ParsedAddress = {};
  if (name) out.name = name;
  if (address) out.address = address;
  return out;
}

function firstAddress(a: Address | undefined): ParsedAddress | undefined {
  if (!a) return undefined;
  if (a.group) return a.group[0] ? addr(a.group[0].name, a.group[0].address) : addr(a.name, undefined);
  return addr(a.name, a.address);
}

const toBytesFromContent = (c: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);

// ─────────────────────────────────────────────────────────────
//  Forwarded-message detection
// ─────────────────────────────────────────────────────────────

/** Fwd:/FW: and common localized forward prefixes (WG, TR, RV, ENC), optionally after a [tag]. */
export const FORWARD_SUBJECT_RE = /^\s*(?:\[[^\]]{0,40}\]\s*)?(?:fwd?|fw|wg|tr|rv|enc)\s*(?:\[\d+\])?\s*:/i;

const FORWARD_MARKER_RE =
  /^[ \t>]*(?:-{3,}\s*(?:forwarded message|original message|weitergeleitete nachricht|message transf[eé]r[eé]|mensaje reenviado|mensagem encaminhada|messaggio inoltrato)\s*-{3,}|begin forwarded message:|_{20,})[ \t]*$/im;

const QUOTED_HEADER_RE =
  /^[ \t]*(?:>[ \t]*)*\*{0,2}(from|sent|date|to|cc|subject|reply-to|von|de|envoy[eé]|gesendet|datum|an|[aà]|objet|betreff|asunto|assunto|para|enviado|oggetto|da|inviato)\*{0,2}[ \t]*:[ \t]*\*{0,2}[ \t]*(.*)$/i;

const KEY_MAP: Record<string, string> = {
  from: "From", von: "From", de: "From", da: "From",
  sent: "Date", date: "Date", gesendet: "Date", datum: "Date", "envoyé": "Date", envoye: "Date", enviado: "Date", inviato: "Date",
  to: "To", an: "To", "à": "To", a: "To", para: "To",
  cc: "Cc",
  subject: "Subject", objet: "Subject", betreff: "Subject", asunto: "Subject", assunto: "Subject", oggetto: "Subject",
  "reply-to": "Reply-To",
};

type QuotedBlock = { headers: { name: string; value: string }[]; bodyStart: number };

/** Read a block of "Key: value" lines starting at line `start` (blank lines before it are skipped). */
function readHeaderBlock(lines: string[], start: number): QuotedBlock | undefined {
  let i = start;
  while (i < lines.length && i < start + 3 && !lines[i]!.trim()) i++;
  const headers: { name: string; value: string }[] = [];
  for (; i < lines.length && headers.length < 12; i++) {
    const m = QUOTED_HEADER_RE.exec(lines[i]!);
    if (!m) break;
    const name = KEY_MAP[m[1]!.toLowerCase()];
    if (name) headers.push({ name, value: m[2]!.replace(/\*+/g, "").trim() });
  }
  if (!headers.some((h) => h.name === "From") || headers.length < 2) return undefined;
  return { headers, bodyStart: i };
}

function parseQuotedFrom(value: string): ParsedAddress | undefined {
  const v = value.replace(/\[mailto:([^\]\s]+)\]/i, "<$1>").replace(/\s+/g, " ").trim();
  const parsed = flattenAddresses(addressParser(v))[0];
  if (parsed?.address) return parsed;
  const m = /[^\s<>"'()[\]]+@[^\s<>"'()[\]]+\.[a-z]{2,}/i.exec(v);
  if (m) return addr(v.replace(m[0], "").replace(/[<>"]/g, "").trim() || undefined, m[0]);
  return v ? addr(v, undefined) : undefined;
}

function unquote(lines: string[]): string {
  const nonEmpty = lines.filter((l) => l.trim());
  const quoted = nonEmpty.length > 0 && nonEmpty.filter((l) => /^\s*>/.test(l)).length / nonEmpty.length > 0.6;
  return (quoted ? lines.map((l) => l.replace(/^\s*> ?/, "")) : lines).join("\n").trim();
}

/**
 * Find a quoted forwarded-message header block in plain text. With a marker
 * line (Gmail/Apple/Outlook separators) the block may appear anywhere; without
 * one it is accepted only when `subjectLooksForwarded`.
 */
export function findQuotedForward(text: string, subjectLooksForwarded: boolean): { headers: { name: string; value: string }[]; body: string } | undefined {
  const lines = text.split(/\r?\n/);
  const marker = FORWARD_MARKER_RE.exec(text);
  let candidates: number[];
  if (marker) {
    const markerLine = text.slice(0, marker.index).split(/\r?\n/).length - 1;
    candidates = [markerLine + 1];
  } else if (subjectLooksForwarded) {
    candidates = [];
    for (let i = 0; i < lines.length && candidates.length < 5; i++) if (/^\s*(?:>\s*)*\*{0,2}(from|von|de)\*{0,2}\s*:/i.test(lines[i]!)) candidates.push(i);
  } else {
    return undefined;
  }
  for (const start of candidates) {
    const block = readHeaderBlock(lines, start);
    if (block) return { headers: block.headers, body: unquote(lines.slice(block.bodyStart)) };
  }
  return undefined;
}

function quotedInner(outer: ParsedEmail, found: { headers: { name: string; value: string }[]; body: string }, depth: number): ParsedEmail {
  const get = (n: string) => found.headers.find((h) => h.name === n)?.value;
  const from = get("From") ? parseQuotedFrom(get("From")!) : undefined;
  const inner: ParsedEmail = {
    headers: found.headers,
    fromCount: found.headers.filter((h) => h.name === "From").length,
    replyTo: [],
    to: flattenAddresses(addressParser(get("To") ?? "")).map((a) => a.address ?? "").filter(Boolean),
    cc: flattenAddresses(addressParser(get("Cc") ?? "")).map((a) => a.address ?? "").filter(Boolean),
    text: found.body,
    attachments: outer.attachments,
    headersSynthetic: true,
  };
  if (from) inner.from = from;
  const replyTo = get("Reply-To");
  if (replyTo) inner.replyTo = flattenAddresses(addressParser(replyTo));
  const subject = get("Subject");
  if (subject) inner.subject = subject;
  const date = get("Date");
  if (date) inner.date = date;
  // The forwarded HTML (links, hidden text) is part of the wrapper's HTML body.
  if (outer.html) inner.html = outer.html;
  if (outer.truncated) inner.truncated = true;
  if (depth + 1 < MAX_WRAPPER_DEPTH) {
    const again = findQuotedForward(found.body, false);
    if (again) inner.forwardedWrapper = { detectedBy: "quoted_headers", inner: quotedInner(inner, again, depth + 1) };
  }
  return inner;
}

// ─────────────────────────────────────────────────────────────
//  Parsing
// ─────────────────────────────────────────────────────────────

async function parseAt(input: Uint8Array, depth: number): Promise<ParsedEmail> {
  if (isOle(input)) throw new EmailParseError("unsupported_format", "OLE compound file (.msg), not an RFC 5322 message");
  let bytes = input;
  let truncated = false;
  if (bytes.length > MAX_EMAIL_BYTES) {
    bytes = bytes.subarray(0, MAX_EMAIL_BYTES);
    truncated = true;
  }
  let email;
  try {
    email = await PostalMime.parse(bytes, {
      forceRfc822Attachments: true,
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 64,
      maxHeadersSize: 1024 * 1024,
    });
  } catch (e) {
    throw new EmailParseError("parse_failed", e instanceof Error ? e.message : String(e));
  }

  const headers = email.headers.slice(0, MAX_HEADERS).map((h) => ({ name: h.originalKey || h.key, value: h.value.slice(0, MAX_HEADER_VALUE) }));
  const fromHeaders = email.headers.filter((h) => h.key === "from");
  const fromAddresses = fromHeaders.flatMap((h) => flattenAddresses(addressParser(h.value))).filter((a) => a.address);
  let html = email.html;
  if (html && html.length > MAX_HTML_CHARS) {
    html = html.slice(0, MAX_HTML_CHARS);
    truncated = true;
  }

  const attachments: ParsedAttachment[] = [];
  let embedded: Uint8Array | undefined;
  for (const a of email.attachments.slice(0, MAX_ATTACHMENTS)) {
    const content = toBytesFromContent(a.content);
    const att: ParsedAttachment = { mimeType: (a.mimeType || "application/octet-stream").toLowerCase(), size: content.byteLength, sha256: sha256Hex(content), magic: detectMagic(content) };
    if (a.filename) att.filename = a.filename;
    if (a.contentId) att.contentId = a.contentId;
    if (a.disposition) att.disposition = a.disposition;
    attachments.push(att);
    const isEml = att.mimeType === "message/rfc822" || /\.eml$/i.test(stripInvisible(a.filename ?? ""));
    if (!embedded && isEml && !isOle(content)) embedded = content;
  }

  const parsed: ParsedEmail = {
    headers,
    fromCount: Math.max(fromHeaders.length, fromAddresses.length),
    replyTo: flattenAddresses(email.replyTo),
    to: flattenAddresses(email.to).map((a) => a.address ?? "").filter(Boolean),
    cc: flattenAddresses(email.cc).map((a) => a.address ?? "").filter(Boolean),
    attachments,
  };
  const from = firstAddress(email.from);
  if (from) parsed.from = from;
  if (email.returnPath) parsed.returnPath = email.returnPath;
  if (email.subject) parsed.subject = email.subject;
  if (email.date) parsed.date = email.date;
  if (email.messageId) parsed.messageId = email.messageId;
  if (email.inReplyTo) parsed.inReplyTo = email.inReplyTo;
  if (email.text) parsed.text = email.text.slice(0, MAX_TEXT_CHARS);
  if (html) parsed.html = html;
  if (truncated) parsed.truncated = true;

  if (depth < MAX_WRAPPER_DEPTH) {
    const subjectFwd = FORWARD_SUBJECT_RE.test(parsed.subject ?? "");
    if (embedded) {
      try {
        parsed.forwardedWrapper = { detectedBy: "attached_eml", inner: await parseAt(embedded, depth + 1) };
      } catch {
        /* unparseable attachment: fall through to quoted/subject detection */
      }
    }
    if (!parsed.forwardedWrapper) {
      const bodyText = parsed.text ?? (parsed.html ? analyzeHtml(parsed.html).text : "");
      const quoted = findQuotedForward(bodyText, subjectFwd);
      if (quoted) parsed.forwardedWrapper = { detectedBy: "quoted_headers", inner: quotedInner(parsed, quoted, depth) };
      else if (subjectFwd) parsed.forwardedWrapper = { detectedBy: "subject_prefix" };
    }
  }
  return parsed;
}

/**
 * Parse a raw RFC 5322 message with postal-mime. Attached messages
 * (message/rfc822, .eml) are kept as attachments and parsed as the inner
 * message of a forward. Throws `EmailParseError` for OLE (.msg) input or
 * unparseable MIME.
 */
export function parseEmail(raw: string | Uint8Array): Promise<ParsedEmail> {
  return parseAt(toBytes(raw), 0);
}

const PASTED_HEADER_RE = /^[ \t]*\*{0,2}(from|sent|date|to|cc|subject|reply-to)\*{0,2}[ \t]*:[ \t]*(.*)$/i;

/**
 * Build a ParsedEmail from pasted text. A leading "From:/Subject:/Date:/To:"
 * block is lifted into synthetic headers; explicit `from`/`subject` win.
 */
export function parsePasted(p: { from?: string; subject?: string; body: string }): ParsedEmail {
  const lines = p.body.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && i < 5 && !lines[i]!.trim()) i++;
  const lifted: { name: string; value: string }[] = [];
  for (; i < lines.length && lifted.length < 10; i++) {
    const m = PASTED_HEADER_RE.exec(lines[i]!);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    lifted.push({ name: key === "sent" ? "Date" : (KEY_MAP[key] ?? m[1]!), value: m[2]!.replace(/\*+/g, "").trim() });
  }
  const hasBlock = lifted.length > 0 && lifted.some((h) => ["From", "Subject"].includes(h.name));
  const body = hasBlock ? lines.slice(i).join("\n").trim() : p.body.trim();
  const headers = hasBlock ? lifted : [];
  if (p.from) headers.unshift({ name: "From", value: p.from });
  if (p.subject) headers.unshift({ name: "Subject", value: p.subject });
  const get = (n: string) => headers.find((h) => h.name === n)?.value;

  const parsed: ParsedEmail = {
    headers,
    fromCount: get("From") ? 1 : 0,
    replyTo: get("Reply-To") ? flattenAddresses(addressParser(get("Reply-To")!)) : [],
    to: flattenAddresses(addressParser(get("To") ?? "")).map((a) => a.address ?? "").filter(Boolean),
    cc: [],
    text: body.slice(0, MAX_TEXT_CHARS),
    attachments: [],
    headersSynthetic: true,
  };
  const from = get("From") ? parseQuotedFrom(get("From")!) : undefined;
  if (from) parsed.from = from;
  if (get("Subject")) parsed.subject = get("Subject")!;
  if (get("Date")) parsed.date = get("Date")!;
  if (/<a\s[^>]*href\s*=|<html[\s>]|<body[\s>]/i.test(body)) parsed.html = body.slice(0, MAX_HTML_CHARS);

  const quoted = findQuotedForward(parsed.text ?? "", FORWARD_SUBJECT_RE.test(parsed.subject ?? ""));
  if (quoted) parsed.forwardedWrapper = { detectedBy: "quoted_headers", inner: quotedInner(parsed, quoted, 0) };
  return parsed;
}
