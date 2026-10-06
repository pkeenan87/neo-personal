import { registrableDomain } from "../email/auth.js";
import type { EmailAnalysis } from "../email/types.js";
import { SIGNIN_ALERT_DOMAINS, SIGNIN_ALERT_LINK_HOSTS, SIGNIN_ALERT_SENDERS } from "./providers.js";
import { REPLY_WITH_CODE } from "./reply.js";
import { SIGNIN_TEMPLATES } from "./templates.js";
import type { SignInAlertProvider, SigninFakeRule } from "./types.js";

/** Deterministic assessment of a recognized sign-in alert (consumed by the verdict override). */
export type SigninAlertAssessment = {
  provider: SignInAlertProvider;
  /** Fake-alert rules that fired (any one means the alert is fake). */
  fake_rules: SigninFakeRule[];
  /** No authentication evidence for this message (pasted text, forwarded wrapper, stripped headers). */
  auth_absent: boolean;
  /** From the receiver's own Authentication-Results: a passing DKIM signature from an allowlisted provider domain aligned with From, and DMARC did not fail. */
  authenticated: boolean;
  /** Every gate required for `likely_safe`. */
  gates: {
    template_verified: boolean;
    /** From address exactly matches a listed sender for the provider. */
    sender_exact: boolean;
    dkim_pass: boolean;
    /** A PASSING signature's d= is on the provider allowlist (a failing signature never counts). */
    dkim_domain_allowlisted: boolean;
    /** A passing d= has the From address's registrable domain (or DMARC passed with alignment). */
    dkim_aligned: boolean;
    links_on_provider: boolean;
    /** Every link host is on the provider's exact host list; no userinfo, odd port or mailto: link. */
    link_hosts_exact: boolean;
    no_injection: boolean;
  };
  all_gates_pass: boolean;
};

function inProviderDomains(provider: SignInAlertProvider, host: string | undefined): boolean {
  const reg = registrableDomain(host);
  return !!reg && SIGNIN_ALERT_DOMAINS[provider].includes(reg);
}

function linkHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** The link's host when it is plain web (https/http, no userinfo, default port); undefined otherwise. */
function strictLinkHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username || u.password || u.port) return undefined;
    return u.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Apply the four fake-alert rules and the safe gates to an EmailAnalysis that carries `signin_alert`.
 * `templates` is the verified-flag registry (default: the shipped one; tests pass their own). Null when the analysis has no recognized sign-in alert. Rules use positive evidence only: absent
 * authentication never fires the sender rule (forwarded copies lose their headers).
 */
export function assessSigninAlert(a: EmailAnalysis, templates: readonly { id: string; verified: boolean }[] = SIGNIN_TEMPLATES): SigninAlertAssessment | null {
  const alert = a.signin_alert;
  if (!alert) return null;
  const provider = alert.provider;
  const auth = a.authentication;
  // Only the receiver's own Authentication-Results counts: ARC and Received-SPF/DKIM-Signature headers are
  // attacker-writable, so a message that has only those is treated as having no authentication.
  const authPresent = a.headers_present && auth.source === "authentication_results" && !a.heuristics.includes("forwarded_wrapper_only");

  const dkimPass = authPresent && auth.dkim === "pass";
  const passDomains = authPresent ? (auth.dkim_pass_domains ?? []) : []; // `?? []`: an analysis stored by an older build may lack the field
  const fromReg = a.sender.from.registrable;
  const fromAligned = (domains: string[]) => !!fromReg && domains.some((d) => registrableDomain(d) === fromReg);
  // The safe gates read only the strict view: the one selected Authentication-Results header, never merged with
  // lower headers (a sender can plant those), and only when it is tied to the receiving provider. Without it
  // (older stored analyses) or when untrusted, nothing is authenticated for the gates. The fake rules below keep
  // the merged view: it only ever adds warnings.
  const strict = authPresent && auth.strict && !auth.strict.untrusted ? auth.strict : undefined;
  const strictDkimPass = strict?.dkim === "pass";
  const strictDomains = strict?.dkim_pass_domains ?? [];
  const strictAllowed = strictDkimPass && strictDomains.some((d) => inProviderDomains(provider, d));
  const strictAligned = strictDkimPass && (fromAligned(strictDomains) || (strict?.aligned === true && strict.dmarc === "pass"));
  const dkimDomainAllowed = dkimPass && passDomains.some((d) => inProviderDomains(provider, d));
  const fromAddress = a.sender.from.address?.trim().toLowerCase();
  const senderExact = !!fromAddress && SIGNIN_ALERT_SENDERS[provider].some((s) => s.includes("@") && s === fromAddress);

  const fake: SigninFakeRule[] = [];
  // 1. Visible provider vs sender: an off-provider From, a failed DKIM/DMARC, or a pass signed only by someone else.
  const senderOffProvider = !!fromReg && !SIGNIN_ALERT_DOMAINS[provider].includes(fromReg);
  const authMismatch = authPresent && (auth.dmarc === "fail" || auth.dkim === "fail" || (dkimPass && !dkimDomainAllowed));
  if (senderOffProvider || authMismatch) fake.push("sender_provider_mismatch");
  // 2. Any link outside the provider's domains (non-web schemes count as off-provider).
  // Runs over every candidate host, not just the capped listed urls; an incomplete host list counts as off-provider.
  const summary = a.link_summary;
  const offLink =
    a.urls.some((u) => u.skipped === "unsupported_scheme" || !inProviderDomains(provider, linkHost(u.url))) ||
    (summary?.hosts.some((h) => !inProviderDomains(provider, h)) ?? false) ||
    (summary?.hosts_truncated ?? false) ||
    (summary?.non_web ?? 0) > 0;
  if (offLink) fake.push("off_provider_link");
  // 3. A callback number.
  if (a.phone_numbers.length > 0) fake.push("callback_number");
  // 4. A request to reply with codes or to hand over credentials (existing credential_request signal).
  // analyzeEmail sets `reply_with_code` from the full text and from mailto: links; the excerpt is a fallback only.
  if (alert.reply_with_code || a.content.signals.includes("credential_request") || REPLY_WITH_CODE.test(a.content.text_excerpt)) fake.push("reply_with_code");

  const hostList = SIGNIN_ALERT_LINK_HOSTS[provider];
  // Every candidate counts, not only the listed urls: unlisted ones, odd ports/userinfo and a missing summary fail the gate.
  const linkHostsExact =
    (alert.mailto_links ?? 0) === 0 &&
    !!summary &&
    !summary.hosts_truncated &&
    summary.unlisted === 0 &&
    summary.nonstandard === 0 &&
    summary.non_web === 0 &&
    summary.hosts.every((h) => hostList.includes(h)) &&
    a.urls.every((u) => {
      const host = u.skipped === "unsupported_scheme" ? undefined : strictLinkHost(u.url);
      return !!host && hostList.includes(host);
    });

  const template = templates.find((t) => t.id === alert.template_id);
  const gates = {
    template_verified: template?.verified === true,
    sender_exact: senderExact,
    dkim_pass: strictDkimPass,
    dkim_domain_allowlisted: strictAllowed,
    dkim_aligned: strictAligned,
    links_on_provider: !offLink,
    link_hosts_exact: linkHostsExact,
    no_injection: !a.heuristics.includes("injection_attempt_in_content"),
  };
  return {
    provider,
    fake_rules: fake,
    auth_absent: !authPresent,
    authenticated: strictAllowed && strictAligned && strict?.dmarc !== "fail",
    gates,
    all_gates_pass: Object.values(gates).every(Boolean) && fake.length === 0,
  };
}
