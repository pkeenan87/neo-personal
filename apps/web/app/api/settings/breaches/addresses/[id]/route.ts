import { getBreachAddressService } from "@/lib/server/breach-monitoring/services";
import { requireBrowserApiSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Vary: "Cookie" };
function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireBrowserApiSession();
  if (!auth.session) return privateResponse(auth.response);
  const { id } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const service = getBreachAddressService();
    const result = await service.removeAddress({ tenantId: auth.session.tenantId, userId: auth.session.userId, addressId: id });
    return new Response(null, { status: result.removed ? 204 : 404, headers: privateHeaders });
  } catch {
    return Response.json({ error: "Breach monitoring is unavailable." }, { status: 503, headers: privateHeaders });
  }
}
