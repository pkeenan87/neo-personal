import { getBreachStatusForUser } from "@/lib/server/breach-monitoring/status-service";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Vary: "Cookie" };
function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function GET(_request?: Request): Promise<Response> {
  const auth = await requireBrowserApiSession();
  if (!auth.session) return privateResponse(auth.response);
  try {
    const status = await getBreachStatusForUser({ tenantId: auth.session.tenantId, userId: auth.session.userId });
    return Response.json(status, { headers: privateHeaders });
  } catch {
    return Response.json({ error: "Breach monitoring is unavailable." }, { status: 503, headers: privateHeaders });
  }
}
