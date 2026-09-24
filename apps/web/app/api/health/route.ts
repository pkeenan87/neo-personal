import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health — liveness probe. Unauthenticated; reveals nothing sensitive. */
export function GET(): Response {
  const e = env();
  return Response.json(
    { ok: true, version: e.APP_VERSION, ...(e.GIT_SHA ? { commit: e.GIT_SHA.slice(0, 7) } : {}), mock: e.MOCK_MODE },
    { headers: { "Cache-Control": "no-store" } },
  );
}
