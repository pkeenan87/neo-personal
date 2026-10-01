/**
 * Fetch wrapper for every server call the extension makes (`docs/contracts.md` "HTTP contract:
 * devices" / "HTTP contract: signals", and the browser-extension additions). Every call goes to
 * `<serverUrl>/api/...`; monitoring calls carry `Authorization: Bearer <neo_dt_ token>`.
 *
 * Callers get back a discriminated result instead of a thrown error, so the background code can
 * branch on `401` (disconnect), `403 insufficient_scope` (log, never retry) and `429` (backoff
 * honouring `Retry-After`) without a try/catch at every call site.
 */
import type { SignalEvent } from "@neo/verdict";
import type { DetectionListsPayload } from "@neo/tools/browser";
import type { DeviceInfo, HouseholdInfo } from "./types.js";

export interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
  /** Present on a 200 that also carried an `ETag` (the lists endpoint). */
  etag?: string;
}

export interface ApiFailure {
  ok: false;
  status: number;
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
  /** `fetch` itself threw (offline, DNS, CORS) rather than the server responding. */
  networkError?: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function apiFetch<T>(
  serverUrl: string,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, networkError: true };
  }

  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  if (res.status === 304) return { ok: true, status: 304, data: undefined as T, etag: res.headers.get("etag") ?? undefined };

  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const body: unknown = isJson ? await res.json().catch(() => undefined) : undefined;

  if (res.ok) {
    return { ok: true, status: res.status, data: body as T, etag: res.headers.get("etag") ?? undefined };
  }
  const errBody = (body ?? {}) as { error?: string; code?: string };
  return {
    ok: false,
    status: res.status,
    error: errBody.error,
    code: errBody.code,
    retryAfterSeconds: retryAfterSeconds(res.headers),
  };
}

// ---- Enrollment (no auth) -----------------------------------------------

export interface EnrollmentPreviewResponse {
  householdName: string;
  memberName: string | null;
  ownerName: string | null;
  expiresAt: string;
}

export function previewEnrollment(serverUrl: string, code: string): Promise<ApiResult<EnrollmentPreviewResponse>> {
  return apiFetch(serverUrl, "/api/devices/enroll/preview", { method: "POST", body: { code } });
}

export interface DeviceItem {
  id: string;
  userId: string;
  memberName: string | null;
  status: "active" | "offline" | "never_seen";
}

export interface EnrollDeviceResponse {
  token: string;
  tokenId: string;
  device: DeviceItem;
  householdName: string;
  memberName: string | null;
}

export function enrollWithCode(serverUrl: string, code: string, device: DeviceInfo): Promise<ApiResult<EnrollDeviceResponse>> {
  return apiFetch(serverUrl, "/api/devices/enroll", { method: "POST", body: { code, ...device } });
}

// ---- Self sign-in (device-authorization flow, no auth until approved) ---

export interface DeviceAuthStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export function startDeviceSignIn(serverUrl: string, device: DeviceInfo): Promise<ApiResult<DeviceAuthStartResponse>> {
  return apiFetch(serverUrl, "/api/desktop/device", { method: "POST", body: { device } });
}

export type DeviceAuthPollResponse =
  | { status: "pending"; interval: number }
  | {
      status: "approved";
      token: string;
      tokenId: string;
      clientName: string;
      email: string | null;
      name: string | null;
      scopes: string[];
      device: DeviceItem | null;
    };

export function pollDeviceSignIn(serverUrl: string, deviceCode: string): Promise<ApiResult<DeviceAuthPollResponse>> {
  return apiFetch(serverUrl, "/api/desktop/device/token", { method: "POST", body: { deviceCode } });
}

// ---- Device self-service (scope `device`) -------------------------------

export interface HeartbeatResponse {
  device: DeviceItem;
  householdName: string;
  memberName: string | null;
  heartbeatSeconds: number;
  listsVersion: string;
  /** `_specs/browser-extension.md` "Uninstall signal"; passed to `runtime.setUninstallURL`. */
  uninstallUrl?: string;
}

export function heartbeat(serverUrl: string, token: string, clientVersion: string): Promise<ApiResult<HeartbeatResponse>> {
  return apiFetch(serverUrl, "/api/devices/heartbeat", { method: "POST", token, body: { clientVersion } });
}

export function unenrollSelf(serverUrl: string, token: string): Promise<ApiResult<undefined>> {
  return apiFetch(serverUrl, "/api/devices/self", { method: "DELETE", token });
}

// ---- Lists ---------------------------------------------------------------

export function fetchLists(serverUrl: string, token: string, etag: string | null): Promise<ApiResult<DetectionListsPayload>> {
  return apiFetch(serverUrl, "/api/signals/lists", {
    method: "GET",
    token,
    headers: etag ? { "if-none-match": etag } : {},
  });
}

// ---- Signals --------------------------------------------------------------

export interface SignalResult {
  id: string | null;
  status: "accepted" | "duplicate" | "rejected";
  reason?: "invalid" | "stale" | "unknown_tool" | "rate_limited" | "relates_to_unknown";
  severity?: "low" | "medium" | "high" | "critical";
  verdictId?: string;
  pending?: boolean;
}

export function postSignals(serverUrl: string, token: string, events: SignalEvent[]): Promise<ApiResult<{ results: SignalResult[] }>> {
  return apiFetch(serverUrl, "/api/signals", { method: "POST", token, body: { events } });
}

export interface SignalStatusResult {
  id: string;
  outcome: "pending" | "alerted" | "recorded" | "dismissed";
  severity?: "low" | "medium" | "high" | "critical";
  verdictId?: string;
  alerted: boolean;
}

export function getSignalsStatus(serverUrl: string, token: string, ids: string[]): Promise<ApiResult<{ results: SignalStatusResult[] }>> {
  const query = encodeURIComponent(ids.join(","));
  return apiFetch(serverUrl, `/api/signals/status?ids=${query}`, { method: "GET", token });
}

// ---- On-demand check -------------------------------------------------------

export interface CheckUrlResponse {
  rating: "dangerous" | "suspicious" | "no_known_problems" | "unknown";
  domain: string;
  reasons: string[];
  checkedAt: string;
}

export function checkUrl(serverUrl: string, token: string, url: string): Promise<ApiResult<CheckUrlResponse>> {
  return apiFetch(serverUrl, "/api/devices/check-url", { method: "POST", token, body: { url } });
}

export type { DeviceInfo, HouseholdInfo };
