import type { ApiError } from "@/lib/api-types";

export function jsonError(status: number, error: string, code?: string): Response {
  const body: ApiError = code ? { error, code } : { error };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
} as const;

/** Parse a JSON request body, returning null on invalid JSON or non-object bodies. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
