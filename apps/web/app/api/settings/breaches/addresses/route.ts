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

export async function GET(): Promise<Response> {
  const auth = await requireBrowserApiSession();
  if (!auth.session) return privateResponse(auth.response);
  try {
    const service = getBreachAddressService();
    const addresses = await service.listAddresses({ tenantId: auth.session.tenantId, userId: auth.session.userId });
    return json({ addresses, maxExtraAddresses: 5 });
  } catch {
    return json({ error: "Breach monitoring is unavailable." }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireBrowserApiSession();
  if (!auth.session) return privateResponse(auth.response);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  const email = body && typeof body === "object" && "email" in body ? (body as { email?: unknown }).email : undefined;
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return json({ error: "A valid email address is required." }, 400);
  try {
    const service = getBreachAddressService({ requireMail: true });
    const result = await service.requestExtraAddress({ tenantId: auth.session.tenantId, userId: auth.session.userId, email });
    switch (result.status) {
      case "reserved": return json({ status: "pending_confirmation" }, 202);
      case "rate_limited": return json({ error: "verification_rate_limited" }, 429);
      case "address_limit": return json({ error: "address_limit_reached" }, 409);
      case "already_verified": return json({ error: "address_already_verified" }, 409);
      case "invalid_address": return json({ error: "A valid email address is required." }, 400);
      case "email_unconfigured": return json({ error: "Email delivery is not configured." }, 503);
      case "email_failed": return json({ error: "The confirmation email could not be sent." }, 503);
      case "unconfigured": return json({ error: "Breach monitoring is not configured." }, 503);
    }
  } catch {
    return json({ error: "Breach monitoring is unavailable." }, 503);
  }
}
