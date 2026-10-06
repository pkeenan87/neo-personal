import { inboundEnv } from "@/lib/env";

/**
 * True when the request's `Origin` header is this app's own origin (the request URL's, or APP_URL's). A missing or
 * foreign `Origin` fails: browsers always send it on cross-site writes, so only a non-browser caller omits it.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  try {
    allowed.add(new URL(inboundEnv().APP_URL).origin);
  } catch {
    /* APP_URL is always parseable; keep the request origin only */
  }
  return allowed.has(origin);
}
