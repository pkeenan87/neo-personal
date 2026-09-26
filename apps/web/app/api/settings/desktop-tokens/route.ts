/**
 * GET    /api/settings/desktop-tokens → { tokens }
 * POST   /api/settings/desktop-tokens { name } → { token, record }  (token shown once)
 * DELETE /api/settings/desktop-tokens?id= → { ok: true }
 *
 * Session-cookie auth only for management. Issued tokens authenticate API calls
 * via `Authorization: Bearer neo_dt_…` (see lib/session.ts).
 */
import { logger } from "@neo/core";
import { MAX_DESKTOP_TOKEN_NAME } from "@neo/db";
import type {
  CreateDesktopTokenResponse,
  DesktopTokenListItem,
  DesktopTokenListResponse,
  RevokeDesktopTokenResponse,
} from "@/lib/desktop-token-types";
import { createTokenForSession, listTokensForSession, revokeTokenForSession } from "@/lib/server/desktop-tokens";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireApiSession } from "@/lib/session";
import type { DesktopTokenPublic } from "@neo/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toItem(r: DesktopTokenPublic): DesktopTokenListItem {
  return {
    id: r.id,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  };
}

function fail(tenantId: string, err: unknown): Response {
  logger.error("Desktop token settings failed", "api.settings.desktop-tokens", {
    tenantId,
    errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  });
  return jsonError(503, "Desktop tokens are unavailable right now.", "storage_unavailable");
}

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    const tokens = await listTokensForSession(session);
    const body: DesktopTokenListResponse = { tokens: tokens.map(toItem) };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name.trim() || name.trim().length > MAX_DESKTOP_TOKEN_NAME) {
    return jsonError(400, `Expected { "name": "<1–${MAX_DESKTOP_TOKEN_NAME} chars>" }.`, "bad_request");
  }
  try {
    const result = await createTokenForSession(session, name);
    if ("error" in result) {
      if (result.error === "limit") {
        return jsonError(400, "You already have the maximum number of desktop tokens.", "token_limit");
      }
      return jsonError(400, "Give the token a short name.", "bad_request");
    }
    const out: CreateDesktopTokenResponse = { token: result.token, record: toItem(result.record) };
    return Response.json(out, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return jsonError(400, "Expected ?id=<token uuid>.", "bad_request");
  }
  try {
    const ok = await revokeTokenForSession(session, id);
    if (!ok) return jsonError(404, "Token not found.", "not_found");
    const body: RevokeDesktopTokenResponse = { ok: true };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(session.tenantId, err);
  }
}
