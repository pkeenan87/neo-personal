import { env } from "@/lib/env";
import { artifactsStatus } from "@/lib/server/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness probe. Unauthenticated; reveals nothing sensitive.
 * `artifacts`: "ok" (Blob + key configured), "memory" (in-memory blob client:
 * MOCK_MODE / local), or "unconfigured" (uploads return 503 storage_unavailable).
 */
export function GET(): Response {
  const e = env();
  return Response.json(
    {
      ok: true,
      version: e.APP_VERSION,
      ...(e.GIT_SHA ? { commit: e.GIT_SHA.slice(0, 7) } : {}),
      mock: e.MOCK_MODE,
      artifacts: artifactsStatus(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
