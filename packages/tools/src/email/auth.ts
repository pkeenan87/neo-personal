import { registrableOf } from "../checks/normalize.js";
import type { DkimResult, DmarcResult, EmailAuthentication, SpfResult } from "./types.js";

/**
 * Tolerant parsing of Authentication-Results (RFC 8601), ARC-Authentication-
 * Results, Received-SPF and DKIM-Signature headers. Results are read from ONE
 * provider's header (never summed across authserv-ids): a header lower in the
 * message may have been written by the sender to look authenticated.
 */

type Header = { name: string; value: string };
export type AuthResult = { method: string; result: string; props: Record<string, string> };
export type ParsedAuthResults = { authservId?: string; results: AuthResult[] };

const METHODS = new Set(["spf", "dkim", "dmarc", "arc", "compauth", "iprev", "auth", "bimi", "dkim-atps", "smime", "vbr", "rrvs", "sender-id", "domainkeys"]);

function stripComments(v: string): string {
  let s = v;
  for (let k = 0; k < 6 && /\([^()]*\)/.test(s); k++) s = s.replace(/\([^()]*\)/g, " ");
  return s;
}

/** Split on whitespace, keeping quoted strings together. */
function tokenize(s: string): string[] {
  return s.match(/[^\s"=]+="[^"]*"|"[^"]*"|\S+/g) ?? [];
}

export function parseAuthResultsValue(value: string): ParsedAuthResults {
  const segments = stripComments(value.replace(/\r?\n/g, " ")).split(";");
  const out: ParsedAuthResults = { results: [] };
  const first = (segments[0] ?? "").trim();
  const firstKey = /^([a-z0-9_-]+)\s*=/i.exec(first)?.[1]?.toLowerCase();
  let startIdx = 0;
  if (!firstKey || !METHODS.has(firstKey)) {
    const id = first.split(/\s+/)[0];
    if (id && id.toLowerCase() !== "none") out.authservId = id.toLowerCase().slice(0, 253);
    startIdx = 1;
  }
  for (const seg of segments.slice(startIdx)) {
    let current: AuthResult | undefined;
    for (const tok of tokenize(seg.replace(/\s*=\s*/g, "="))) {
      const eq = tok.indexOf("=");
      if (eq <= 0) continue;
      const key = tok.slice(0, eq).toLowerCase();
      const val = tok.slice(eq + 1).replace(/^"|"$/g, "");
      if (METHODS.has(key)) {
        current = { method: key, result: val.toLowerCase(), props: {} };
        out.results.push(current);
      } else if (current && !(key in current.props)) {
        current.props[key] = val;
      }
    }
  }
  return out;
}

function domainOf(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = (v.includes("@") ? v.slice(v.lastIndexOf("@") + 1) : v).replace(/[<>\s]/g, "").replace(/\.$/, "").toLowerCase();
  return d || undefined;
}

export function registrableDomain(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const r = registrableOf(d.toLowerCase()).registrable;
  return r || undefined;
}

function mapSpf(r: string | undefined): SpfResult {
  switch (r) {
    case undefined:
      return "absent";
    case "pass":
    case "fail":
    case "softfail":
    case "neutral":
    case "none":
    case "temperror":
    case "permerror":
      return r;
    case "hardfail":
      return "fail";
    case "policy":
      return "neutral";
    default:
      return "none";
  }
}

function mapDkim(results: string[]): DkimResult {
  if (!results.length) return "absent";
  if (results.includes("pass")) return "pass";
  if (results.some((r) => ["fail", "permerror", "neutral", "policy", "hardfail"].includes(r))) return "fail";
  return "none";
}

function mapDmarc(r: string | undefined): DmarcResult {
  if (r === undefined) return "absent";
  if (r === "pass") return "pass";
  if (r === "fail") return "fail";
  return "none";
}

/** Registrable domain of the topmost Received header's `by` host (the receiving provider). */
function receivingRegistrable(headers: Header[]): string | undefined {
  const top = headers.find((h) => h.name.toLowerCase() === "received");
  const by = top ? /\bby\s+\[?([a-z0-9.-]+\.[a-z]{2,})\]?/i.exec(top.value)?.[1] : undefined;
  return registrableDomain(by);
}

function summarize(results: AuthResult[], fromRegistrable: string | undefined): Omit<EmailAuthentication, "source" | "evaluated_by"> {
  const spfRes = results.find((r) => r.method === "spf");
  const dkimRes = results.filter((r) => r.method === "dkim");
  const dmarcRes = results.find((r) => r.method === "dmarc");
  const compauth = results.find((r) => r.method === "compauth");
  const dkimDomainOf = (r: AuthResult) => domainOf(r.props["header.d"] ?? r.props["header.i"]);
  const dkim_domains = [...new Set(dkimRes.map(dkimDomainOf).filter((d): d is string => !!d))].slice(0, 10);
  const spf = mapSpf(spfRes?.result);
  const dkim = mapDkim(dkimRes.map((r) => r.result));
  const dmarc = mapDmarc(dmarcRes?.result);
  let aligned: boolean | null = null;
  if (fromRegistrable && (spf !== "absent" || dkim !== "absent" || dmarc !== "absent")) {
    const dkimAligned = dkimRes.some((r) => r.result === "pass" && registrableDomain(dkimDomainOf(r)) === fromRegistrable);
    const spfDomain = domainOf(spfRes?.props["smtp.mailfrom"] ?? spfRes?.props["smtp.helo"]);
    const spfAligned = spf === "pass" && registrableDomain(spfDomain) === fromRegistrable;
    aligned = dkimAligned || spfAligned || dmarc === "pass";
  }
  const out: Omit<EmailAuthentication, "source" | "evaluated_by"> = { spf, dkim, dkim_domains, dmarc, aligned };
  if (compauth) out.compauth = compauth.result;
  return out;
}

/**
 * Evaluate sender authentication from message headers.
 * Order: the topmost Authentication-Results written by the receiving
 * provider (else the topmost one), then the newest ARC-Authentication-Results,
 * then Received-SPF plus the presence of DKIM-Signature (a signature alone is
 * never a pass). Nothing found means every result is "absent", not "fail".
 */
export function evaluateAuthentication(headers: Header[], fromRegistrable: string | undefined): EmailAuthentication {
  const byName = (n: string) => headers.filter((h) => h.name.toLowerCase() === n);

  const ar = byName("authentication-results").map((h) => parseAuthResultsValue(h.value));
  if (ar.length) {
    const receiving = receivingRegistrable(headers);
    const chosen = (receiving && ar.find((a) => a.authservId && registrableDomain(a.authservId) === receiving)) || ar[0]!;
    // One provider may split its results across headers (iCloud: spf.icloud.com, dkim-verifier.icloud.com, ...).
    // Merge only headers from the chosen provider, and take each method from the topmost header that has it.
    const provider = registrableDomain(chosen.authservId);
    const same = chosen.authservId && provider ? ar.filter((a) => a.authservId && registrableDomain(a.authservId) === provider) : [chosen];
    const seen = new Set<string>();
    const merged: AuthResult[] = [];
    for (const a of same) {
      const methods = new Set(a.results.map((r) => r.method));
      for (const r of a.results) if (!seen.has(r.method)) merged.push(r);
      for (const m of methods) seen.add(m);
    }
    const result: EmailAuthentication = { ...summarize(merged, fromRegistrable), source: "authentication_results" };
    if (chosen.authservId) result.evaluated_by = chosen.authservId;
    return result;
  }

  const arc = byName("arc-authentication-results")
    .map((h) => {
      const m = /^\s*i\s*=\s*(\d+)\s*;/.exec(h.value);
      return { instance: m ? Number(m[1]) : 0, parsed: parseAuthResultsValue(m ? h.value.slice(m[0].length) : h.value) };
    })
    .sort((a, b) => b.instance - a.instance);
  if (arc.length) {
    const top = arc[0]!.parsed;
    const result: EmailAuthentication = { ...summarize(top.results, fromRegistrable), source: "arc" };
    if (top.authservId) result.evaluated_by = top.authservId;
    return result;
  }

  const receivedSpf = byName("received-spf")[0];
  const dkimSigs = byName("dkim-signature");
  if (receivedSpf || dkimSigs.length) {
    const spfValue = receivedSpf ? stripComments(receivedSpf.value) : "";
    const spfToken = receivedSpf ? /^\s*([a-z]+)/i.exec(receivedSpf.value)?.[1]?.toLowerCase() : undefined;
    const envelope = /envelope-from\s*=\s*"?<?([^\s;">]+)/i.exec(spfValue)?.[1] ?? /domain of\s+(\S+@\S+?)[\s)]/i.exec(receivedSpf?.value ?? "")?.[1];
    const spf = mapSpf(spfToken);
    const dkim_domains = [...new Set(dkimSigs.map((h) => domainOf(/(?:^|;)\s*d\s*=\s*([^;\s]+)/i.exec(h.value)?.[1])).filter((d): d is string => !!d))].slice(0, 10);
    const aligned = fromRegistrable ? spf === "pass" && registrableDomain(domainOf(envelope)) === fromRegistrable : null;
    return {
      spf,
      dkim: dkimSigs.length ? "none" : "absent",
      dkim_domains,
      dmarc: "absent",
      aligned,
      source: "received_spf_and_dkim_signature",
    };
  }

  return { spf: "absent", dkim: "absent", dkim_domains: [], dmarc: "absent", aligned: null, source: "none" };
}

/** Auth heuristic codes for an evaluation. */
export function authHeuristics(a: EmailAuthentication, fromRegistrable: string | undefined, headersPresent: boolean): string[] {
  const out: string[] = [];
  if (a.spf === "fail") out.push("spf_fail");
  if (a.spf === "softfail") out.push("spf_softfail");
  if (a.dkim === "fail") out.push("dkim_fail");
  if (a.dmarc === "fail") out.push("dmarc_fail");
  if (a.source === "none" && headersPresent) out.push("auth_absent");
  if (a.dkim === "pass" && fromRegistrable && a.dkim_domains.length && !a.dkim_domains.some((d) => registrableDomain(d) === fromRegistrable)) {
    out.push("unaligned_dkim");
  }
  return out;
}
