/**
 * Access-token use and refresh for one connector. Refresh is compare-and-swap on `token_version`: if another run won,
 * the row is re-read and its newer token is used instead of overwriting it. `invalid_grant` flips the connector to
 * `reauth_required` (tokens dropped, polling paused) and is never retried.
 */
import { logger } from "@neo/core";
import { decryptTokens, encryptTokens } from "./crypto";
import type { OutlookDeps } from "./deps";
import { OutlookOAuthError } from "./oauth";
import { GraphAuthError, type OutlookGraphClient, type OutlookRunCtx } from "./types";

const REFRESH_SKEW_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

export type TokenResult = { ok: true; accessToken: string } | { ok: false; reason: "reauth_required" | "unavailable" };

export async function getAccessToken(ctx: OutlookRunCtx, deps: OutlookDeps, opts: { force?: boolean } = {}): Promise<TokenResult> {
  let force = opts.force === true;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const c = await deps.store.getConnectorById(ctx.tenantId, ctx.connectorId);
    if (!c || c.userId !== ctx.userId) return { ok: false, reason: "unavailable" };
    if (c.status === "reauth_required") return { ok: false, reason: "reauth_required" };
    if (c.status !== "connected" || !c.encryptedTokens) return { ok: false, reason: "unavailable" };
    const identity = { tenantId: ctx.tenantId, userId: ctx.userId, connectorId: c.id };
    const tokens = decryptTokens(c.encryptedTokens, identity, deps.source);
    if (!force && Date.parse(tokens.expiresAt) - deps.now().getTime() > REFRESH_SKEW_MS) return { ok: true, accessToken: tokens.accessToken };

    let fresh;
    try {
      fresh = await deps.oauth.refresh(tokens.refreshToken);
    } catch (err) {
      if (err instanceof OutlookOAuthError && err.code === "invalid_grant") {
        if (await deps.store.markReauthRequired(ctx.tenantId, c.id, c.tokenVersion)) {
          logger.warn("Outlook connector needs re-authorization", "outlook", { tenantId: ctx.tenantId, connectorId: c.id });
          return { ok: false, reason: "reauth_required" };
        }
        force = false; // someone else changed the row first: re-read it
        continue;
      }
      throw err;
    }
    const next = encryptTokens(
      { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? tokens.refreshToken, expiresAt: new Date(deps.now().getTime() + fresh.expiresIn * 1000).toISOString() },
      identity,
      deps.source,
    );
    if (await deps.store.compareAndSwapTokens(ctx.tenantId, c.id, c.tokenVersion, next)) return { ok: true, accessToken: fresh.accessToken };
    force = false; // lost the race: re-read and use the winner's token
  }
  return { ok: false, reason: "unavailable" };
}

/** Run `fn` with a Graph client; on a rejected token refresh once and retry. */
export async function withGraph<T>(
  ctx: OutlookRunCtx,
  deps: OutlookDeps,
  fn: (graph: OutlookGraphClient) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "reauth_required" | "unavailable" }> {
  let token = await getAccessToken(ctx, deps);
  if (!token.ok) return token;
  try {
    return { ok: true, value: await fn(deps.graphFor(token.accessToken)) };
  } catch (err) {
    if (!(err instanceof GraphAuthError)) throw err;
  }
  token = await getAccessToken(ctx, deps, { force: true });
  if (!token.ok) return token;
  try {
    return { ok: true, value: await fn(deps.graphFor(token.accessToken)) };
  } catch (err) {
    if (err instanceof GraphAuthError) return { ok: false, reason: "unavailable" };
    throw err;
  }
}
