import { breachMonitoringEnv, isDeployedEnvironment, HIBP_RPM_DEFAULT, HIBP_USER_AGENT_DEFAULT, type EnvSource } from "@/lib/env";
import { sanitizeBreachDataClass, sanitizeBreachName } from "./sanitize";

const HIBP_API = "https://haveibeenpwned.com/api/v3";
const MAX_RETRY_AFTER_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_BREACH_RECORDS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Only the fields Neo reads are validated; unknown provider fields are ignored so additions never break lookups. */
type HIBPRecord = {
  Name: string;
  Domain?: string;
  BreachDate: string;
  AddedDate: string;
  DataClasses: string[];
  IsRetired: boolean;
};

export type HIBPBreach = {
  name: string;
  domain?: string;
  breachDate?: string;
  addedDate?: string;
  dataClasses: string[];
  retired: boolean;
};

export type HIBPResult =
  | { status: "clean"; breaches: [] }
  | { status: "breached"; breaches: HIBPBreach[] }
  | { status: "retryable_failure"; retryAfterSeconds?: number }
  | { status: "configuration_failure" }
  | { status: "invalid_request" };

export interface HIBPDeps {
  source?: EnvSource;
  fetchImpl?: typeof fetch;
}

function envTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+$/u.test(trimmed)
    ? Number(trimmed)
    : Math.ceil((Date.parse(trimmed) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function readBoundedBody(response: Response): Promise<Uint8Array | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* best-effort stop of oversized provider stream */ }
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  return isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function parseBreach(value: unknown): HIBPBreach | undefined {
  if (!isRecord(value)) return undefined;
  const row = value as unknown as HIBPRecord;
  if (typeof row.Name !== "string" || !row.Name.trim() || row.Name.length > 512) return undefined;
  if (row.Domain !== undefined && (typeof row.Domain !== "string" || row.Domain.length > 253)) return undefined;
  if (!isCalendarDate(row.BreachDate) || !isDateTime(row.AddedDate)) return undefined;
  if (!Array.isArray(row.DataClasses) || row.DataClasses.length > 100 || !row.DataClasses.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200)) return undefined;
  if (typeof row.IsRetired !== "boolean") return undefined;
  return {
    name: sanitizeBreachName(row.Name),
    ...(row.Domain ? { domain: row.Domain } : {}),
    breachDate: row.BreachDate,
    addedDate: row.AddedDate,
    dataClasses: row.DataClasses.map(sanitizeBreachDataClass),
    retired: row.IsRetired,
  };
}

function fixtureResult(address: string): HIBPResult {
  if (!address.toLowerCase().endsWith("@example.com")) return { status: "clean", breaches: [] };
  return {
    status: "breached",
    breaches: [{
      name: "Neo Mock Example Breach",
      domain: "example.com",
      breachDate: "2024-01-01",
      addedDate: "2024-02-01T00:00:00Z",
      dataClasses: ["Passwords", "Email addresses"],
      retired: false,
    }],
  };
}

/** Query only HIBP's breached-account endpoint. Provider bodies are normalized and never logged. */
export async function lookupBreachedAccount(email: string, deps: HIBPDeps = {}): Promise<HIBPResult> {
  const address = email.trim();
  if (!EMAIL_RE.test(address)) return { status: "invalid_request" };
  const source = deps.source ?? process.env;
  const config = breachMonitoringEnv(source);
  const apiKey = config.HIBP_API_KEY;
  // Mock when asked, or when there is no key outside a deployment; a deployment without a key fails closed.
  if (envTrue(source.MOCK_MODE) || (!apiKey && !isDeployedEnvironment(source))) return fixtureResult(address);
  if (!apiKey) return { status: "configuration_failure" };

  const encoded = encodeURIComponent(address);
  const url = `${HIBP_API}/breachedaccount/${encoded}?truncateResponse=false&IncludeUnverified=false`;
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        "hibp-api-key": apiKey,
        "User-Agent": config.HIBP_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return { status: "clean", breaches: [] };
    if (response.status === 400) return { status: "invalid_request" };
    if (response.status === 401 || response.status === 403) return { status: "configuration_failure" };
    if (response.status === 429) {
      const retry = retryAfterSeconds(response.headers.get("retry-after"));
      return { status: "retryable_failure", ...(retry ? { retryAfterSeconds: retry } : {}) };
    }
    if (response.status >= 500) return { status: "retryable_failure" };
    if (!response.ok) return { status: "invalid_request" };

    const bytes = await readBoundedBody(response);
    if (!bytes) return { status: "retryable_failure" };
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { status: "retryable_failure" };
    }
    if (!Array.isArray(body) || body.length > MAX_BREACH_RECORDS) return { status: "retryable_failure" };
    const breaches: HIBPBreach[] = [];
    for (const item of body) {
      const parsed = parseBreach(item);
      if (!parsed) return { status: "retryable_failure" };
      breaches.push(parsed);
    }
    return breaches.length ? { status: "breached", breaches } : { status: "clean", breaches: [] };
  } catch {
    return { status: "retryable_failure" };
  }
}

export { HIBP_RPM_DEFAULT, HIBP_USER_AGENT_DEFAULT };
export const HIBP_MAX_RETRY_AFTER_SECONDS = MAX_RETRY_AFTER_SECONDS;
