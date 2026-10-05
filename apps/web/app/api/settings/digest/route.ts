import { jsonError, readJsonObject } from "@/lib/server/http";
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { requireApiSession, requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const forbidden = () => jsonError(403, "A current household membership is required.", "forbidden");
const unavailable = () => jsonError(503, "Weekly digest settings are unavailable right now.", "storage_unavailable");

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  try {
    const enabled = await getDigestServices().store.getPreference(session.tenantId, session.userId);
    return enabled === undefined ? forbidden() : Response.json({ enabled }, { headers });
  } catch { return unavailable(); }
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  const body = await readJsonObject(req);
  if (!body || typeof body.enabled !== "boolean" || Object.keys(body).length !== 1) {
    return jsonError(400, 'Expected { "enabled": boolean }.', "bad_request");
  }
  try {
    const changed = await getDigestServices().store.setPreference(session.tenantId, session.userId, body.enabled);
    return changed ? Response.json({ enabled: body.enabled }, { headers }) : forbidden();
  } catch { return unavailable(); }
}
