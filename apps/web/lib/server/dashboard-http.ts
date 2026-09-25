/** Small helpers shared by the dashboard route handlers. */
import { logger } from "@neo/core";
import type { AccessError } from "./verdict-data";
import { jsonError } from "./http";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function accessErrorResponse(error: AccessError): Response {
  return error === "forbidden"
    ? jsonError(403, "You can only view your own checks.", "forbidden")
    : jsonError(404, "Not found.", "not_found");
}

export function storageError(err: unknown, route: string, tenantId: string): Response {
  logger.error("Dashboard query failed", route, {
    tenantId,
    errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  });
  return jsonError(503, "Neo can't reach its storage right now. Please try again in a moment.", "storage_unavailable");
}

/** A query param that must be one of `allowed` when present. undefined = absent; null = invalid. */
export function enumParam<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]): T | undefined | null {
  const v = params.get(key);
  if (v === null || v === "") return undefined;
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
