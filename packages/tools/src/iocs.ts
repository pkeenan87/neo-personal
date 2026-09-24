import type { Verdict } from "@neo/verdict";
import { isSkipped, type UrlAnalysis } from "./types.js";

/** Collect IOCs from a UrlAnalysis in the Verdict `iocs` shape (deduplicated, input order). */
export function extractUrlIocs(a: UrlAnalysis): Verdict["iocs"] {
  const urls = new Set<string>([a.normalized_url, ...a.redirect_chain]);
  if (a.final_url) urls.add(a.final_url);
  const domains = new Set<string>();
  const ips = new Set<string>();
  for (const d of [a.domain, a.final_domain]) {
    if (!d || !d.registrable) continue;
    (d.is_ip ? ips : domains).add(d.registrable);
  }
  const us = a.reputation.urlscan;
  if (us && !isSkipped(us)) {
    if (us.page?.domain) domains.add(us.page.domain);
    if (us.page?.ip) ips.add(us.page.ip);
  }
  return { urls: [...urls], domains: [...domains], ips: [...ips], hashes: [], phone_numbers: [] };
}
