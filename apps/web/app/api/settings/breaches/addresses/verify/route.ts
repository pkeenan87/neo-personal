import { getBreachAddressService } from "@/lib/server/breach-monitoring/services";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Vary: "Cookie" };
function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: privateHeaders }); }
function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireBrowserApiSession();
  if (!auth.session) return privateResponse(auth.response);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const token = body && typeof body === "object" && "token" in body ? (body as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: "Invalid or expired confirmation link." }, 400);
  try {
    const service = getBreachAddressService();
    const result = await service.confirmAddress({ tenantId: auth.session.tenantId, userId: auth.session.userId, token });
    return result.verified ? json({ status: "verified" }) : json({ error: "Invalid or expired confirmation link." }, 400);
  } catch {
    return json({ error: "Breach monitoring is unavailable." }, 503);
  }
}
