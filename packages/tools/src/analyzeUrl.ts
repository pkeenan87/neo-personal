import { urlAnalysisCacheKey } from "./cache.js";
import { detectLookalike } from "./checks/lookalike.js";
import { normalizeUrl, sortHeuristics, type NormalizedUrl } from "./checks/normalize.js";
import { checkRdap } from "./checks/rdap.js";
import { followRedirects, type RedirectOutcome } from "./checks/redirects.js";
import { checkSafeBrowsing } from "./checks/safeBrowsing.js";
import { SsrfError } from "./checks/ssrf.js";
import { checkTls } from "./checks/tls.js";
import { checkUrlscan } from "./checks/urlscan.js";
import { checkVirusTotal } from "./checks/virustotal.js";
import { resolveDeps } from "./deps.js";
import { mockAnalysis } from "./mock.js";
import { isSkipped, type CheckContext, type DomainInfo, type RdapResult, type Skipped, type TlsResult, type UrlAnalysis, type UrlAnalysisDeps } from "./types.js";
import { errorMessage, runCheck } from "./util.js";

export type AnalyzeUrlOptions = { deps?: Partial<UrlAnalysisDeps>; signal?: AbortSignal };

export function domainInfo(n: Pick<NormalizedUrl, "host" | "host_unicode" | "registrable" | "is_ip">, rdap?: RdapResult): DomainInfo {
  const d: DomainInfo = { host: n.host, host_unicode: n.host_unicode, registrable: n.registrable, is_ip: n.is_ip };
  if (rdap?.found) {
    if (rdap.age_days !== undefined) d.age_days = rdap.age_days;
    if (rdap.registrar) d.registrar = rdap.registrar;
    if (rdap.created) d.created = rdap.created;
    if (rdap.expires) d.expires = rdap.expires;
    if (rdap.status) d.status = rdap.status;
  }
  return d;
}

function looksLikeAnalysis(v: unknown): v is UrlAnalysis {
  return typeof v === "object" && v !== null && typeof (v as UrlAnalysis).normalized_url === "string" && Array.isArray((v as UrlAnalysis).heuristics);
}

function unparseable(input: string, err: unknown, now: Date): UrlAnalysis {
  return {
    input,
    normalized_url: input,
    display_url: input,
    redirect_chain: [],
    domain: { host: "", host_unicode: "", registrable: "", is_ip: false },
    reputation: {},
    lookalike: null,
    heuristics: ["unparseable_url"],
    errors: [`normalize: ${errorMessage(err)}`],
    analyzed_at: now.toISOString(),
  };
}

function ageHeuristics(age: number | undefined, out: Set<string>): void {
  if (age === undefined) return;
  if (age < 30) out.add("young_domain");
  if (age < 7) out.add("very_young_domain");
}

/**
 * Analyze a URL for phishing/malware signals. Never throws: every check is
 * independent, individually time-boxed, and reports failures in `errors`.
 * Everything in the result is derived from attacker-controlled content.
 */
export async function analyzeUrl(url: string, opts: AnalyzeUrlOptions = {}): Promise<UrlAnalysis> {
  const deps = resolveDeps(opts.deps);
  const ctx: CheckContext = { deps, ...(opts.signal ? { signal: opts.signal } : {}) };
  let norm: NormalizedUrl;
  try {
    norm = normalizeUrl(url);
  } catch (e) {
    return unparseable(url, e, deps.now());
  }
  if (deps.mock) return mockAnalysis(norm, deps);

  const errors: string[] = [];
  const cacheKey = urlAnalysisCacheKey(norm.href);
  if (deps.cache) {
    const hit = await runCheck("cache", errors, async () => deps.cache!.get(cacheKey));
    if (looksLikeAnalysis(hit)) return { ...hit, cached: true };
  }

  const heuristics = new Set<string>(norm.heuristics);
  const isHttp = norm.scheme === "http" || norm.scheme === "https";
  const notApplicable: Skipped = { skipped: "not_applicable" };

  // Stage 1: independent checks on the input URL.
  const [redirect, virustotal, rdap] = await Promise.all([
    isHttp ? followRedirects(norm.href, ctx) : Promise.resolve<RedirectOutcome | undefined>(undefined),
    isHttp ? runCheck("virustotal", errors, () => checkVirusTotal(norm.href, ctx)) : notApplicable,
    norm.registrable && !norm.is_ip ? runCheck("rdap", errors, () => checkRdap(norm.registrable, ctx)) : undefined,
  ]);

  if (redirect?.error) errors.push(`redirects: ${redirect.error}`);
  if (redirect?.page.refused) {
    heuristics.add("ssrf_refused");
    errors.push(`redirects: ${redirect.page.refused}`);
  }
  if (redirect?.page.truncated_chain) heuristics.add("too_many_redirects");
  if (redirect?.page.has_password_field) heuristics.add("password_field");
  const chain = redirect?.chain ?? [norm.href];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i - 1]!.startsWith("https:") && chain[i]!.startsWith("http:")) heuristics.add("redirect_to_http");
  }

  // Stage 2: checks that depend on where the chain ended.
  const finalUrl = redirect?.final_url;
  let finalNorm: NormalizedUrl | undefined;
  if (finalUrl && finalUrl !== norm.href) {
    try {
      finalNorm = normalizeUrl(finalUrl);
      for (const h of finalNorm.heuristics) if (h !== "url_shortener") heuristics.add(h);
    } catch {
      /* final URL came from a parsed Location header; ignore */
    }
  }
  const finalDiffers = !!finalNorm && finalNorm.registrable !== norm.registrable;
  if (finalDiffers) heuristics.add("cross_domain_redirect");
  const tlsHost = finalNorm?.host ?? norm.host;
  const refusedOnly = !!redirect?.page.refused && !finalUrl;
  const tlsApplicable = isHttp && (finalNorm ?? norm).scheme === "https";

  const [safeBrowsing, tls, finalRdap, urlscan] = await Promise.all([
    isHttp ? runCheck("safe_browsing", errors, () => checkSafeBrowsing([norm.href, ...chain], ctx)) : notApplicable,
    tlsApplicable && !refusedOnly
      ? runCheck("tls", errors, async (): Promise<TlsResult | Skipped> => {
          try {
            return await checkTls(tlsHost, ctx);
          } catch (e) {
            if (e instanceof SsrfError) return { skipped: "ssrf_refused" };
            throw e;
          }
        })
      : ({ skipped: refusedOnly ? "ssrf_refused" : "not_applicable" } as Skipped),
    finalDiffers && finalNorm?.registrable && !finalNorm.is_ip ? runCheck("rdap_final", errors, () => checkRdap(finalNorm!.registrable, ctx)) : undefined,
    isHttp && !norm.is_private_ip ? runCheck("urlscan", errors, () => checkUrlscan(norm.href, ctx)) : notApplicable,
  ]);

  const domain = domainInfo(norm, rdap);
  ageHeuristics(domain.age_days, heuristics);
  const final_domain = finalDiffers && finalNorm ? domainInfo(finalNorm, finalRdap) : undefined;
  ageHeuristics(final_domain?.age_days, heuristics);

  if (tls && !isSkipped(tls)) {
    if (tls.is_new) heuristics.add("new_certificate");
    if (!tls.valid) heuristics.add("invalid_certificate");
    if (tls.self_signed) heuristics.add("self_signed_certificate");
    if (tls.expired) heuristics.add("expired_certificate");
  }

  const lookalike = detectLookalike(norm.host, deps.brands) ?? (finalNorm ? detectLookalike(finalNorm.host, deps.brands) : null);
  if (lookalike) heuristics.add("brand_lookalike");
  if (safeBrowsing && !isSkipped(safeBrowsing) && safeBrowsing.flagged) heuristics.add("safe_browsing_match");
  if (virustotal && !isSkipped(virustotal) && virustotal.status === "found") {
    if (virustotal.malicious > 0) heuristics.add("virustotal_malicious");
    if (virustotal.suspicious > 0) heuristics.add("virustotal_suspicious");
  }
  if (urlscan && !isSkipped(urlscan) && urlscan.malicious) heuristics.add("urlscan_malicious");

  const reputation: UrlAnalysis["reputation"] = {};
  if (safeBrowsing) reputation.safe_browsing = safeBrowsing;
  if (virustotal) reputation.virustotal = virustotal;
  if (urlscan) reputation.urlscan = urlscan;

  const analysis: UrlAnalysis = {
    input: url,
    normalized_url: norm.href,
    display_url: norm.display_url,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    redirect_chain: chain,
    page: redirect?.page ?? notApplicable,
    domain,
    ...(final_domain ? { final_domain } : {}),
    reputation,
    ...(tls ? { tls } : {}),
    lookalike,
    heuristics: sortHeuristics(heuristics),
    errors,
    analyzed_at: deps.now().toISOString(),
  };

  const pending =
    (virustotal && !isSkipped(virustotal) && virustotal.status === "pending") || (urlscan && !isSkipped(urlscan) && urlscan.status === "pending");
  if (deps.cache && errors.length === 0 && !pending && !opts.signal?.aborted) {
    await runCheck("cache", analysis.errors, async () => deps.cache!.set(cacheKey, analysis, deps.cacheTtlSeconds));
  }
  return analysis;
}
