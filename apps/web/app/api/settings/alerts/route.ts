/**
 * GET /api/settings/alerts → { threshold } (owner).
 * POST { threshold: "medium" | "high" | "critical" | "off" } → { threshold } (owner, browser session).
 */
import { ALERT_THRESHOLD_VALUES, type AlertSettingsResponse, type AlertThreshold } from "@/lib/alert-types";
import { getThreshold, setThreshold } from "@/lib/server/alerts";
import { NO_STORE, storageError } from "@/lib/server/dashboard-http";
import { jsonError, readJsonObject } from "@/lib/server/http";
import { requireApiSession, requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNER_ONLY = () => jsonError(403, "Only the household owner has alert email settings.", "forbidden");

export async function GET(): Promise<Response> {
  const { session, response } = await requireApiSession();
  if (!session) return response;
  if (session.role !== "owner") return OWNER_ONLY();
  try {
    const body: AlertSettingsResponse = { threshold: await getThreshold(session) };
    return Response.json(body, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.settings.alerts", session.tenantId);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { session, response } = await requireBrowserApiSession();
  if (!session) return response;
  if (session.role !== "owner") return OWNER_ONLY();
  const body = await readJsonObject(req);
  const threshold = body?.threshold;
  if (typeof threshold !== "string" || !(ALERT_THRESHOLD_VALUES as readonly string[]).includes(threshold)) {
    return jsonError(400, 'Expected { "threshold": "medium" | "high" | "critical" | "off" }.', "bad_request");
  }
  try {
    const out: AlertSettingsResponse = { threshold: await setThreshold(session, threshold as AlertThreshold) };
    return Response.json(out, { headers: NO_STORE });
  } catch (err) {
    return storageError(err, "api.settings.alerts", session.tenantId);
  }
}
