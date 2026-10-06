import type { UrlAnalysis } from "../types.js";
import type { SignInAlert } from "../signin/types.js";

export type MagicType = "pdf" | "zip" | "ole" | "pe" | "html" | "lnk" | "iso" | "script" | "image" | "archive" | "unknown";

export type ParsedAddress = { name?: string; address?: string };

export type ParsedAttachment = {
  filename?: string;
  mimeType: string;
  size: number;
  contentId?: string;
  disposition?: string;
  sha256: string;
  magic?: MagicType;
};

/** Thin, JSON-serializable wrapper over postal-mime output. Every value is attacker-controlled. */
export type ParsedEmail = {
  /** Header fields in original order (top = most recently added). */
  headers: { name: string; value: string }[];
  from?: ParsedAddress;
  /** Number of From addresses/headers (more than one is abnormal). */
  fromCount: number;
  replyTo: ParsedAddress[];
  returnPath?: string;
  to: string[];
  cc: string[];
  subject?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  text?: string;
  /** Raw HTML string (never rendered). Capped at 512 KB. */
  html?: string;
  attachments: ParsedAttachment[];
  /** Present when this message is a user's forward of another message. */
  forwardedWrapper?: { detectedBy: "subject_prefix" | "attached_eml" | "quoted_headers"; inner?: ParsedEmail };
  /** Headers were reconstructed from a quoted block or a paste (no transport/auth headers). */
  headersSynthetic?: boolean;
  /** Input or HTML exceeded a size cap and was cut. */
  truncated?: boolean;
};

export type EmailInput = { raw: string | Uint8Array } | { pasted: { from?: string; subject?: string; body: string } };

export type SpfResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "absent";
export type DkimResult = "pass" | "fail" | "none" | "absent";
export type DmarcResult = "pass" | "fail" | "none" | "absent";

export type EmailAuthentication = {
  spf: SpfResult;
  dkim: DkimResult;
  /** d= values of DKIM results (or DKIM-Signature headers in the fallback). */
  dkim_domains: string[];
  /** d= values of the signatures that passed (empty in the DKIM-Signature fallback: a signature alone is never a pass). */
  dkim_pass_domains: string[];
  dmarc: DmarcResult;
  /** DKIM d= (passing) or SPF domain (passing) aligns with the From registrable domain; null when unknown. */
  aligned: boolean | null;
  source: "authentication_results" | "arc" | "received_spf_and_dkim_signature" | "none";
  /** authserv-id of the provider that wrote the header that was used. */
  evaluated_by?: string;
  /** Microsoft composite authentication (compauth=), when present. */
  compauth?: string;
  /**
   * Strict view for the sign-in "likely safe" gates: read from the single selected Authentication-Results header
   * with no merging across headers. `untrusted` when that header cannot be tied to the receiving provider (no
   * Received `by` host matched its authserv-id, or a header above it exists). Absent on analyses stored by older builds.
   */
  strict?: StrictAuthentication;
};

export type StrictAuthentication = {
  spf: SpfResult;
  dkim: DkimResult;
  dkim_pass_domains: string[];
  dmarc: DmarcResult;
  aligned: boolean | null;
  untrusted: boolean;
};

export type FileVirusTotalResult =
  | {
      status: "found";
      malicious: number;
      suspicious: number;
      harmless: number;
      undetected: number;
      top_engines: string[];
      type_description?: string;
      last_analysis_date?: string;
      permalink: string;
    }
  | { status: "not_found" };

export type AttachmentSkip = { skipped: "no_api_key" | "mock" | "limit" | "not_applicable" | "error" };

export type EmailAttachmentAnalysis = {
  /** Filename with invisible/bidi characters shown as [U+XXXX]. */
  filename?: string;
  mime_type: string;
  size: number;
  magic?: MagicType;
  extension?: string;
  extension_mismatch: boolean;
  dangerous_type: boolean;
  double_extension: boolean;
  /** Per-attachment codes: ole_document, archive_not_inspected, macro_enabled, rtlo_in_name, inline. */
  flags: string[];
  virustotal?: FileVirusTotalResult | AttachmentSkip;
  sha256: string;
};

export type EmailUrlEntry = {
  url: string;
  display_text?: string;
  text_mismatch: boolean;
  analysis?: UrlAnalysis;
  skipped?: "limit" | "duplicate" | "unsupported_scheme";
};

export type EmailLinkSummary = {
  /** Unique hosts of every http(s) link candidate (capped at 500). */
  hosts: string[];
  /** More unique hosts than `hosts` holds. */
  hosts_truncated: boolean;
  /** Candidates (web or not) beyond the listed `urls`. */
  unlisted: number;
  /** Web candidates with userinfo or an explicit port. */
  nonstandard: number;
  /** Candidates with a non-web scheme (javascript:, data:, ...). */
  non_web: number;
};

export type EmailAnalysis = {
  input_kind: "raw" | "pasted";
  /** The analysis is of an inner (forwarded) message, not the wrapper. */
  forwarded: boolean;
  /** False for pasted bodies and quoted forwards (authentication is then all "absent"). */
  headers_present: boolean;
  sender: {
    from: { address?: string; display_name?: string; domain?: string; registrable?: string };
    reply_to: { address: string; domain?: string }[];
    return_path?: { address?: string; domain?: string };
    display_name_looks_like_address: boolean;
    display_name_brand?: string;
    from_domain_lookalike?: { brand: string; technique: string } | null;
    reply_to_divergent: boolean;
    return_path_divergent: boolean;
    free_mail_provider: boolean;
  };
  authentication: EmailAuthentication;
  received_hops: number;
  urls: EmailUrlEntry[];
  /** Every link candidate, not just the listed `urls` (which are capped). Absent on analyses stored by older builds. */
  link_summary?: EmailLinkSummary;
  attachments: EmailAttachmentAnalysis[];
  /** Phone numbers found in the body (E.164 where parseable): callback-scam IOCs. */
  phone_numbers: string[];
  content: {
    subject?: string;
    text_excerpt: string;
    language?: string;
    signals: string[];
    html: {
      present: boolean;
      hidden_text: boolean;
      forms: number;
      external_images: number;
      tracking_pixels: number;
      mismatched_link_text: number;
      scripts: number;
    };
  };
  heuristics: string[];
  errors: string[];
  analyzed_at: string;
  mock?: true;
  /** A recognized provider sign-in alert (_specs/signin-alerts.md). Absent for every other message. */
  signin_alert?: SignInAlert;
};

