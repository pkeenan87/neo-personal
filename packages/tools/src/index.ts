export { analyzeUrl, type AnalyzeUrlOptions } from "./analyzeUrl.js";
export { checkUrlTool, checkUrlDefinition, createCheckUrlTool, CheckUrlInputSchema, URL_ANALYSIS_GUIDANCE, type CheckUrlInput } from "./checkUrlTool.js";
export { InMemoryReputationCache, createInMemoryCache, urlAnalysisCacheKey } from "./cache.js";
export { resolveDeps, guardedFetch, defaultLookup } from "./deps.js";
export { BRANDS, GENERIC_KEYWORDS } from "./brands.js";
export { MOCK_URLS } from "./mock.js";
export { extractUrlIocs } from "./iocs.js";

export { normalizeUrl, sortHeuristics, HEURISTIC_CODES, SUSPICIOUS_TLDS, URL_SHORTENERS, type HeuristicCode, type NormalizedUrl } from "./checks/normalize.js";
export { detectLookalike, skeleton, damerauLevenshtein } from "./checks/lookalike.js";
export { assertPublicHost, assertFetchable, blockedAddressReason, blockedHostnameReason, SsrfError } from "./checks/ssrf.js";
export { followRedirects, extractPageFacts } from "./checks/redirects.js";
export { checkRdap, parseRdap } from "./checks/rdap.js";
export { checkTls, summarizeTlsPeer, defaultTlsConnect } from "./checks/tls.js";
export { checkSafeBrowsing, parseSafeBrowsing } from "./checks/safeBrowsing.js";
export { checkVirusTotal, parseVirusTotalReport, virusTotalUrlId } from "./checks/virustotal.js";
export { checkUrlscan, parseUrlscanResult } from "./checks/urlscan.js";

// Phase 1: email and SMS analysis
export { parseEmail, parsePasted, detectMagic, EmailParseError, FORWARD_SUBJECT_RE } from "./email/parse.js";
export { analyzeEmail, emailErrorResult, isFreeMailDomain, DEFAULT_EMAIL_MAX_URLS, type AnalyzeEmailOptions } from "./email/analyzeEmail.js";
export {
  analyzeEmailTool,
  analyzeEmailDefinition,
  createAnalyzeEmailTool,
  AnalyzeEmailInputSchema,
  EMAIL_ANALYSIS_GUIDANCE,
  extractEmailIocs,
  type AnalyzeEmailInput,
  type CreateAnalyzeEmailToolOptions,
} from "./email/tool.js";
export { evaluateAuthentication, parseAuthResultsValue } from "./email/auth.js";
export { analyzeHtml, type HtmlFacts, type HtmlAnchor } from "./email/html.js";
export { triageAttachment, checkVirusTotalFile, parseVirusTotalFile } from "./email/attachments.js";
export { EMAIL_HEURISTIC_CODES, type EmailHeuristicCode } from "./email/codes.js";
export { analyzeSms, classifySmsSender, stripChrome, SMS_HEURISTIC_CODES, DEFAULT_SMS_MAX_URLS, type AnalyzeSmsOptions } from "./sms/analyzeSms.js";
export { analyzeSmsTool, analyzeSmsDefinition, createAnalyzeSmsTool, AnalyzeSmsInputSchema, SMS_ANALYSIS_GUIDANCE, extractSmsIocs, type AnalyzeSmsInput } from "./sms/tool.js";
export { parsePhone, extractPhoneNumbers } from "./phone.js";
export { extractTextUrls, refang } from "./textUrls.js";
export type * from "./email/types.js";
export type * from "./sms/types.js";

export type { ToolDefinition, ToolContext, ToolExecutor } from "@neo/core";
export type * from "./types.js";
export { isSkipped } from "./types.js";
