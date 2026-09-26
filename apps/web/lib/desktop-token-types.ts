/**
 * Wire types for desktop personal access tokens (Omarchy plugin / native clients).
 * Dates are ISO-8601.
 */
export interface DesktopTokenListItem {
  id: string;
  name: string;
  /** First 8 chars after `neo_dt_` — enough to recognise a token, not enough to use it. */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface DesktopTokenListResponse {
  tokens: DesktopTokenListItem[];
}

/** POST /api/settings/desktop-tokens body. */
export interface CreateDesktopTokenBody {
  name: string;
}

/**
 * POST create response. `token` is shown once; only the hash is stored.
 * Clients authenticate with `Authorization: Bearer <token>`.
 */
export interface CreateDesktopTokenResponse {
  token: string;
  record: DesktopTokenListItem;
}

/** DELETE /api/settings/desktop-tokens?id= */
export interface RevokeDesktopTokenResponse {
  ok: true;
}
