/**
 * Inbox rule audit classification (_specs/outlook-connector.md). Pure. For Outlook.com accounts any destination that is
 * not the user's own address (`mail` or `userPrincipalName`, `+tag` aliases on Microsoft consumer domains) is external. A
 * destination that is not a plain `local@domain` address (display-name wrappers, `mailto:`, lists) is indeterminate and is
 * treated as external: it is never unwrapped to look like an own address. Only the destination domain is kept: never the
 * address, the rule name or the rule JSON.
 */
import { createHash } from "node:crypto";
import type { OutlookFindingAction } from "@neo/db";
import type { GraphRecipient, GraphRule } from "./types";

export type RuleClass = "disabled" | "none" | "internal" | "external" | "indeterminate";
export type RuleFindingCandidate = { ruleKey: string; action: OutlookFindingAction; /** Absent when the destination could not be read. */ destinationDomain?: string };

/** Consumer Microsoft domains that ignore `+tag` sub-addressing. */
const PLUS_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercased plain `local@domain` (`+tag` on Microsoft consumer domains removed), or undefined when it is not a plain address. */
export function normalizeAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at <= 0 || at !== v.indexOf("@")) return undefined;
  let local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (!DOMAIN_RE.test(domain) || /[\s,;<>"()]/.test(local)) return undefined;
  if (PLUS_DOMAINS.has(domain)) local = local.split("+")[0]!;
  if (!local) return undefined;
  return `${local}@${domain}`;
}

export function ownAddressSet(addresses: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const a of addresses) {
    const n = normalizeAddress(a);
    if (n) set.add(n);
  }
  return set;
}

export function ruleKeyOf(ruleId: string, action: OutlookFindingAction, domain: string | undefined): string {
  return createHash("sha256").update(`${ruleId}\u0000${action}\u0000${domain ?? ""}`, "utf8").digest("hex");
}

const ACTIONS: ReadonlyArray<[keyof Pick<GraphRule, "forwardTo" | "redirectTo" | "forwardAsAttachmentTo">, OutlookFindingAction]> = [
  ["forwardTo", "forward_to"],
  ["redirectTo", "redirect_to"],
  ["forwardAsAttachmentTo", "forward_as_attachment_to"],
];

export function classifyRule(rule: GraphRule, own: ReadonlySet<string>): { class: RuleClass; findings: RuleFindingCandidate[] } {
  if (!rule.enabled) return { class: "disabled", findings: [] };
  const findings = new Map<string, RuleFindingCandidate>();
  let sawDestination = false;
  let external = false;
  for (const [field, action] of ACTIONS) {
    for (const r of rule[field] as GraphRecipient[]) {
      sawDestination = true;
      const address = normalizeAddress(r.address);
      if (address && own.has(address)) continue;
      const domain = address?.slice(address.lastIndexOf("@") + 1);
      if (address) external = true;
      const ruleKey = ruleKeyOf(rule.id, action, domain);
      findings.set(ruleKey, { ruleKey, action, ...(domain ? { destinationDomain: domain } : {}) });
    }
  }
  if (!sawDestination) return { class: "none", findings: [] };
  if (findings.size === 0) return { class: "internal", findings: [] };
  return { class: external ? "external" : "indeterminate", findings: [...findings.values()] };
}
