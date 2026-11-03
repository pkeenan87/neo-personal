/**
 * Microsoft identity platform v2.0, `/consumers` authority only (personal accounts), authorization code + PKCE S256.
 * Delegated read-only scopes. The real client takes an injected `fetch` (tests never touch the network); the fake
 * (MOCK_MODE) implements the same interface with a local authorize step. Never logs or returns tokens, codes or
 * PKCE material, and never surfaces Microsoft's `error_description`.
 */
import { createHash, randomBytes } from "node:crypto";

export const OUTLOOK_AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.Read", "MailboxSettings.Read"] as const;

export type TokenSet = { accessToken: string; refreshToken?: string | undefined; /** seconds */ expiresIn: number };
export type OAuthErrorCode = "invalid_grant" | "access_denied" | "failed";

export class OutlookOAuthError extends Error {
  constructor(readonly code: OAuthErrorCode) {
    super(`outlook oauth: ${code}`);
    this.name = "OutlookOAuthError";
  }
}

export interface OutlookOAuthClient {
  authorizeUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; signal?: AbortSignal }): Promise<TokenSet>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<TokenSet>;
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");
export const newState = (): string => randomBytes(32).toString("base64url");

type Fetch = typeof fetch;

export function createMicrosoftOAuthClient(cfg: { clientId: string; clientSecret: string; redirectUri: string; fetch?: Fetch }): OutlookOAuthClient {
  const doFetch = cfg.fetch ?? fetch;
  async function token(form: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
    let res: Response;
    try {
      res = await doFetch(`${OUTLOOK_AUTHORITY}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }),
        ...(signal ? { signal } : {}),
        redirect: "error",
      });
    } catch {
      throw new OutlookOAuthError("failed");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new OutlookOAuthError(body.error === "invalid_grant" ? "invalid_grant" : "failed");
    const access = body.access_token;
    const expires = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
    if (typeof access !== "string" || !access || !Number.isFinite(expires)) throw new OutlookOAuthError("failed");
    return { accessToken: access, ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}), expiresIn: expires };
  }
  return {
    authorizeUrl({ state, codeChallenge }) {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        redirect_uri: cfg.redirectUri,
        response_mode: "query",
        scope: OUTLOOK_SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      return `${OUTLOOK_AUTHORITY}/authorize?${q.toString()}`;
    },
    exchangeCode: ({ code, codeVerifier, signal }) =>
      token({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: codeVerifier, scope: OUTLOOK_SCOPES.join(" ") }, signal),
    refresh: (refreshToken, signal) => token({ grant_type: "refresh_token", refresh_token: refreshToken, scope: OUTLOOK_SCOPES.join(" ") }, signal),
  };
}

/** MOCK_MODE: the "authorize" step is a local redirect straight to the callback; no network. */
export function createMockOAuthClient(redirectUri: string): OutlookOAuthClient {
  let counter = 0;
  return {
    authorizeUrl({ state, codeChallenge }) {
      return `${redirectUri}?${new URLSearchParams({ code: `mock-${codeChallenge}`, state }).toString()}`;
    },
    async exchangeCode({ code, codeVerifier }) {
      if (!code.startsWith("mock-") || pkceChallenge(codeVerifier) !== code.slice(5)) throw new OutlookOAuthError("failed");
      return { accessToken: `mock-access-${++counter}`, refreshToken: "mock-refresh", expiresIn: 3600 };
    },
    async refresh(refreshToken) {
      if (refreshToken !== "mock-refresh") throw new OutlookOAuthError("invalid_grant");
      return { accessToken: `mock-access-r${++counter}`, refreshToken: "mock-refresh", expiresIn: 3600 };
    },
  };
}
