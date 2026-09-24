/**
 * Only same-origin relative paths are allowed as post-sign-in destinations
 * (open-redirect guard for `callbackUrl` / `redirectTo`). Used by the
 * browser client and by the Auth.js `redirect` callback.
 */
export function safeCallbackPath(value: unknown, fallback = "/chat"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return fallback;
  // Must start with exactly one slash: rejects "//evil.example", "/\\evil.example",
  // absolute URLs, and scheme tricks like "javascript:".
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

/** Auth.js `redirect` callback body: relative → same origin; same-origin absolute → as is; else baseUrl. */
export function resolveAuthRedirect(url: string, baseUrl: string): string {
  if (url.startsWith("/")) {
    const path = safeCallbackPath(url, "");
    return path ? `${baseUrl}${path}` : baseUrl;
  }
  try {
    if (new URL(url).origin === new URL(baseUrl).origin) return url;
  } catch {
    // invalid URL
  }
  return baseUrl;
}
