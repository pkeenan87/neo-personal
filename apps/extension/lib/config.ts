/**
 * Server URL resolution (`_specs/browser-extension.md` "Server URL"). Build-time default from
 * `WXT_NEO_BASE_URL` (a bare env var read at build time by Vite/WXT; unset in dev and CI, so the
 * code must work without it — see CLAUDE.md). A self-hoster can override it once, before
 * enrollment, from the options page's "Advanced: server" field; the override is then locked in
 * with the stored device state.
 */

/** WXT exposes `WXT_`-prefixed env vars as `import.meta.env.WXT_*` (see `wxt.config.ts`). */
export const BUILD_BASE_URL = (import.meta.env.WXT_NEO_BASE_URL || "").trim();

export const DEFAULT_BASE_URL = "https://www.neoshield.dev";

/** Strips a trailing slash so `${baseUrl}/api/...` never double-slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The base URL to use before any stored override is known (build-time default or fallback). */
export function defaultBaseUrl(): string {
  return normalizeBaseUrl(BUILD_BASE_URL || DEFAULT_BASE_URL);
}

/** True for an `http(s)://` URL with a host, the only shape the advanced server field accepts. */
export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
