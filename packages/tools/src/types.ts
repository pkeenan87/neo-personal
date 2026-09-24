export type SkipReason = "no_api_key" | "disabled" | "not_applicable" | "ssrf_refused";
export type Skipped = { skipped: SkipReason };

export function isSkipped(v: unknown): v is Skipped {
  return typeof v === "object" && v !== null && "skipped" in v;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type LookupAddress = { address: string; family: number };
/** Resolve every address for a hostname (the shape of `dns.promises.lookup(host, { all: true })`). */
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

/** Raw facts from a TLS handshake; produced by `TlsConnectFn`. */
export type TlsPeer = {
  authorized: boolean;
  authorizationError?: string;
  subject?: Record<string, unknown>;
  issuer?: Record<string, unknown>;
  valid_from?: string;
  valid_to?: string;
  subjectaltname?: string;
  fingerprint256?: string;
};
export type TlsConnectFn = (opts: { host: string; address: string; port: number; timeoutMs: number; signal?: AbortSignal }) => Promise<TlsPeer>;

export interface ReputationCache {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void> | void;
}

export type RedirectHop = { url: string; status: number; method: "HEAD" | "GET" };

export type PageResult = {
  hops: RedirectHop[];
  final_status?: number;
  content_type?: string;
  title?: string;
  has_password_field: boolean;
  favicon_url?: string;
  /** Set when the fetch stopped because a hop pointed at a private/non-http destination. */
  refused?: string;
  truncated_chain?: boolean;
};

export type RdapResult = {
  found: boolean;
  domain: string;
  created?: string;
  expires?: string;
  last_changed?: string;
  registrar?: string;
  status?: string[];
  age_days?: number;
};

export type TlsResult = {
  host: string;
  issuer?: string;
  subject?: string;
  valid_from?: string;
  valid_to?: string;
  san_count: number;
  cert_age_days?: number;
  is_new: boolean;
  expired: boolean;
  self_signed: boolean;
  valid: boolean;
  error?: string;
};

export type SafeBrowsingResult = {
  flagged: boolean;
  matches: { threat_type: string; platform: string; url: string }[];
};

export type VirusTotalResult =
  | {
      status: "found";
      malicious: number;
      suspicious: number;
      harmless: number;
      undetected: number;
      top_engines: string[];
      reputation?: number;
      last_analysis_date?: string;
      permalink: string;
    }
  | { status: "pending"; analysis_id?: string; permalink: string };

export type UrlscanResult = {
  status: "done" | "pending";
  uuid: string;
  report_url: string;
  screenshot_url?: string;
  score?: number;
  malicious?: boolean;
  page?: { domain?: string; ip?: string; country?: string };
};

export type Lookalike = { brand: string; technique: LookalikeTechnique; brand_domain: string };
export type LookalikeTechnique = "homoglyph" | "typosquat" | "brand_in_subdomain" | "brand_with_affix" | "tld_swap";

export type DomainInfo = {
  host: string;
  host_unicode: string;
  registrable: string;
  is_ip: boolean;
  age_days?: number;
  registrar?: string;
  created?: string;
  expires?: string;
  status?: string[];
};

export type UrlAnalysis = {
  input: string;
  normalized_url: string;
  /** Same URL with the host decoded from punycode, for display only. */
  display_url: string;
  final_url?: string;
  /** Every URL visited, starting with normalized_url and ending with final_url. */
  redirect_chain: string[];
  page?: PageResult | Skipped;
  domain: DomainInfo;
  /** Present when the redirect chain ends on a different registrable domain. */
  final_domain?: DomainInfo;
  reputation: {
    safe_browsing?: SafeBrowsingResult | Skipped;
    virustotal?: VirusTotalResult | Skipped;
    urlscan?: UrlscanResult | Skipped;
  };
  tls?: TlsResult | Skipped;
  lookalike?: Lookalike | null;
  /** Stable codes; see HEURISTIC_CODES. */
  heuristics: string[];
  /** Non-fatal errors from individual checks, `"<check>: <message>"`. */
  errors: string[];
  analyzed_at: string;
  cached?: boolean;
  mock?: boolean;
};

export type Brand = { name: string; domains: string[]; keywords: string[]; ccTLDs?: boolean };

export type CheckContext = { deps: UrlAnalysisDeps; signal?: AbortSignal };

export interface UrlAnalysisDeps {
  fetch: FetchLike;
  lookup: LookupFn;
  tlsConnect: TlsConnectFn;
  env: Record<string, string | undefined>;
  cache?: ReputationCache;
  /** Deterministic fixtures, no network. Defaults to env MOCK_MODE === "true". */
  mock: boolean;
  /** Run urlscan.io (slow). Defaults to env URLSCAN_ENABLED === "true". */
  urlscan: boolean;
  /** Submit unknown URLs to VirusTotal for scanning (makes them visible to VT users). Defaults to env VIRUSTOTAL_SUBMIT !== "false". */
  virustotalSubmit: boolean;
  /** Per-check / per-hop timeout (ms). Default 5000. */
  timeoutMs: number;
  /** Total wall-clock budget for the whole redirect chain (ms). Default 15000. */
  redirectBudgetMs: number;
  /** urlscan.io total polling budget (ms). Default 20000. */
  urlscanPollMs: number;
  urlscanPollIntervalMs: number;
  maxRedirects: number;
  maxBodyBytes: number;
  cacheTtlSeconds: number;
  brands: Brand[];
  now: () => Date;
}
