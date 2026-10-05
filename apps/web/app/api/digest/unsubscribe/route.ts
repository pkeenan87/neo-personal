import { escapeHtml } from "@/lib/server/email/verdict-email";
import { clientIp, takeRateSlot } from "@/lib/server/rate-limit";
import { readJsonObject } from "@/lib/server/http";
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { verifyDigestUnsubscribe } from "@/lib/server/weekly-digest/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
};
const invalid = () => new Response("Invalid unsubscribe link.", { status: 400, headers });

function invalidRequest(req: Request): Response {
  const slot = takeRateSlot("digest-unsubscribe-invalid", clientIp(req), 10, 3600000);
  if (!slot.ok) return new Response("Too many attempts. Please try again later.", {
    status: 429, headers: { ...headers, "Retry-After": String(slot.retryAfterSeconds) },
  });
  return invalid();
}

export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!verifyDigestUnsubscribe(token)) return invalidRequest(req);
  // No recipient lookup or preference mutation on GET: mail scanners may visit this URL.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Weekly digest unsubscribe</title></head><body><main><h1>Unsubscribe from weekly digests</h1><p>Confirm to stop your weekly Neo security digest. Other notifications are unchanged.</p><form method="post" action="/api/digest/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form></main></body></html>`, {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: Request): Promise<Response> {
  let token: unknown = new URL(req.url).searchParams.get("token");
  if (!token) {
    if (req.headers.get("content-type")?.includes("application/json")) token = (await readJsonObject(req))?.token;
    else {
      try { token = (await req.formData()).get("token"); }
      catch { return invalidRequest(req); }
    }
  }
  const owner = typeof token === "string" ? verifyDigestUnsubscribe(token) : undefined;
  if (!owner) return invalidRequest(req);
  try {
    // A removed/moved membership is a successful no-op, never a cross-tenant lookup.
    await getDigestServices().store.setPreference(owner.tenantId, owner.userId, false);
    return new Response(null, { status: 204, headers });
  } catch {
    // Do not log token, URL, recipient, or arbitrary storage errors.
    return new Response("Unable to unsubscribe right now. Please try again.", { status: 503, headers });
  }
}
